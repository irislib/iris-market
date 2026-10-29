#!/usr/bin/env python3
# Copyright (c) 2026 lauri000. Adapted under the MIT license (../LICENSE).
"""Install reviewed Rust and native build tools from checksum-pinned archives.

Adapted from irislib/iris-chat-rs commit 7a8f6d53b273af98ce4451ab3b3b429f5fdfe6d6
(MIT, Martti Malmi); originally from the NDR verified-component installer. Native OS/compiler and other
build-tool assumptions are listed in release-build-inputs.json. --check is pure;
--install requires hosted CI or explicit --local-macos, and a new absolute work
directory. Local mode writes environment.json instead of changing the shell.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PINS = Path(__file__).with_suffix('.json')
HOSTS = {'x86_64-unknown-linux-gnu', 'aarch64-apple-darwin',
         'x86_64-apple-darwin', 'x86_64-pc-windows-msvc'}
CROSS = {'aarch64-apple-ios', 'aarch64-apple-ios-sim', 'aarch64-linux-android'}
OPTIONAL = {'rustfmt': 'rustfmt-preview', 'clippy': 'clippy-preview'}
TOOL_PROFILES = {'macos', 'macos-cli', 'ios', 'windows'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def checkout_commit():
    value = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'],
                                    text=True, timeout=30).strip()
    require(re.fullmatch('[0-9a-f]{40}', value) is not None, 'checkout commit is unavailable')
    return value


def official_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.netloc == 'static.rust-lang.org'
            and not parsed.query and not parsed.fragment,
            'Rust input must use the official HTTPS distribution host')


def check_pins(pins):
    require(pins['schema'] == 1, 'unsupported input schema')
    rust = pins['rust']
    require(rust['version'] == '1.99.0' and rust['date'] == '2026-10-01',
            'unreviewed Rust release')
    require(rust['manifest'] == {
        'url': 'https://static.rust-lang.org/dist/channel-rust-1.99.0.toml',
        'sha256': 'ce6dddc886364f8d786514771212cebe9b731ba82d6b859951c6b0ccc516b6a2',
    }, 'unreviewed official manifest')
    require(set(rust['hosts']) == HOSTS and set(rust['std']) == HOSTS | CROSS,
            'missing or unexpected host/target')
    archives = []
    for host, entries in rust['hosts'].items():
        require(set(entries) == {'rustc', 'cargo', 'rustfmt-preview', 'clippy-preview'},
                'missing host compiler component')
        archives.extend((name.removesuffix('-preview'), host, pin)
                        for name, pin in entries.items())
    archives.extend(('rust-std', target, pin) for target, pin in rust['std'].items())
    for name, target, pin in archives:
        root = name+'-'+rust['version']+'-'+target
        require(pin['root'] == root, 'incorrect archive root')
        official_url(pin['url'])
        require(pin['url'] == 'https://static.rust-lang.org/dist/'+rust['date']+'/'+root+'.tar.xz',
                'archive URL is not the exact reviewed release')
        require(re.fullmatch('[0-9a-f]{64}', pin['sha256']) is not None,
                'archive requires a fixed SHA-256')
    check_native_pins(pins)


def native_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname in {
        'github.com', 'release-assets.githubusercontent.com',
        'builds.dotnet.microsoft.com', 'www.nasm.us', 'downloads.sourceforge.net',
        'dl.google.com', 'static.crates.io',
    } | ({parsed.hostname} if parsed.hostname and
         parsed.hostname.endswith('.dl.sourceforge.net') else set())
        and not parsed.username and not parsed.password and parsed.port in (None, 443),
        'native input must use its reviewed HTTPS distribution host')


def check_native_pins(pins):
    tools = pins['tools']
    require(set(tools) == {'xcodegen', 'cmake-macos', 'cmake-ios',
                           'cmake-windows', 'dotnet', 'nasm', 'nsis'},
            'missing or unexpected native tools')
    expected = {'xcodegen':'2.46.0', 'cmake-macos':'4.4.3', 'cmake-ios':'4.4.4',
                'cmake-windows':'4.4.4', 'dotnet':'10.0.402', 'nasm':'3.02', 'nsis':'3.13'}
    for name, pin in tools.items():
        require(pin['version'] == expected[name], 'unreviewed native tool version')
        native_url(pin['url'])
        require(not urllib.parse.urlsplit(pin['url']).query and
                pin['version'] in pin['url'] and '/latest/' not in pin['url'],
                'native input URL must name the reviewed version')
        algorithm = 'sha512' if name == 'dotnet' else 'sha256'
        require(re.fullmatch('[0-9a-f]{'+str(128 if algorithm == 'sha512' else 64)+'}',
                             pin[algorithm]) is not None, 'native input requires a fixed digest')
        require(pin['format'] in ('zip', 'tar.gz') and
                0 < pin['size'] <= 1024**3, 'unsupported native archive')
        for field in ('binary', 'root'):
            value = pin[field]
            require('\\' not in value and ':' not in value and
                    not value.startswith('/') and '..' not in value.split('/'),
                    'unsafe native archive binding')


def native_selection(pins, profile, host):
    require(profile in TOOL_PROFILES, 'unknown native tool profile')
    require(host.endswith('windows-msvc') if profile == 'windows' else
            host.endswith('apple-darwin'), 'native tool profile does not match runner')
    names = (['cmake-windows', 'dotnet', 'nasm', 'nsis'] if profile == 'windows' else
             ['cmake-ios', 'xcodegen'] if profile == 'ios' else
             ['cmake-macos'] if profile == 'macos-cli' else ['cmake-macos', 'xcodegen'])
    return [(name, pins['tools'][name]) for name in names]


class NativeRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        native_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def verify_native(path, pin):
    algorithm = 'sha512' if 'sha512' in pin else 'sha256'
    value = hashlib.new(algorithm)
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    require(Path(path).stat().st_size == pin['size'] and value.hexdigest() == pin[algorithm],
            'native archive size/checksum mismatch: '+Path(path).name)


def download_native(pin, path):
    native_url(pin['url'])
    if path.exists():
        verify_native(path, pin)
        return path
    temporary = path.with_suffix(path.suffix+'.partial')
    opener = urllib.request.build_opener(NativeRedirects())
    with opener.open(pin['url'], timeout=60) as response, temporary.open('xb') as output:
        native_url(response.url)
        total = 0
        while block := response.read(1024 * 1024):
            total += len(block)
            require(total <= pin['size'], 'native archive exceeds reviewed size')
            output.write(block)
    verify_native(temporary, pin)
    temporary.replace(path)
    return path


def unpack_native(path, pin, destination):
    verify_native(path, pin)  # Never parse or execute an unverified archive.
    destination.mkdir(exist_ok=False)
    if pin['format'] == 'tar.gz':
        with tarfile.open(path, 'r:gz') as archive:
            require(all(member.name.split('/', 1)[0] == pin['root']
                        for member in archive.getmembers()), 'unexpected native archive root')
            archive.extractall(destination, filter='data')
    else:
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                name = member.filename
                require(not name.startswith('/') and '\\' not in name and ':' not in name
                        and '..' not in name.split('/')
                        and (not pin['root'] or name.split('/', 1)[0] == pin['root'])
                        and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR),
                        'unsafe native ZIP member')
            for member in archive.infolist():
                target = Path(archive.extract(member, destination))
                mode = (member.external_attr >> 16) & 0o777
                if mode and not member.is_dir():
                    target.chmod(mode)
    binary = destination/pin['binary']
    require(binary.is_file(), 'native archive has no bound executable')
    return binary


def native_prerequisites(profile):
    if profile == 'windows':
        # MSVC/Windows SDK selection and link.exe validation stay in the existing
        # Windows build controller, which imports vcvars64.bat before compilation.
        program_files = os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')
        require((Path(program_files)/'Microsoft Visual Studio/Installer/vswhere.exe').is_file(),
                'the hosted Visual Studio installation and vswhere.exe are required')
        return {'visualStudio':'selected and checked by windows-build-local.ps1'}
    for tool in ('xcrun', 'xcodebuild', 'clang', 'codesign'):
        require(shutil.which(tool) is not None, 'preinstalled Xcode tool missing: '+tool)
    return {'xcode':subprocess.check_output(['xcodebuild', '-version'], text=True, timeout=30).strip(),
            'clang':subprocess.check_output(['xcrun', '--find', 'clang'], text=True, timeout=30).strip()}


def verify_native_install(archive_path, pin, destination):
    """Revalidate the complete installed archive payload before executing it."""
    verify_native(archive_path, pin)
    def compare(name, mode, stream=None, link=None, directory=False):
        require(not name.startswith('/') and '\\' not in name and '..' not in name.split('/'), 'Unsafe installed archive member')
        path = destination/name
        require(path.resolve().is_relative_to(destination.resolve()), 'Installed tool escapes its directory')
        if link is not None:
            require(path.is_symlink() and os.readlink(path) == link, 'Installed tool symlink changed')
        elif directory:
            require(path.is_dir(), 'Installed tool directory missing')
        else:
            require(path.is_file() and not path.is_symlink(), 'Installed tool file missing')
            value = hashlib.sha256()
            for block in iter(lambda: stream.read(1024*1024), b''): value.update(block)
            require(value.hexdigest() == digest(path) and path.stat().st_mode & 0o111 == mode & 0o111, 'Installed tool payload changed')
    if pin['format'] == 'zip':
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                with archive.open(member) as stream:
                    compare(member.filename, member.external_attr >> 16, stream, directory=member.is_dir())
    else:
        with tarfile.open(archive_path, 'r:gz') as archive:
            for member in archive:
                require(member.isfile() or member.isdir() or member.issym(), 'Unsupported installed native member')
                if member.isfile():
                    with archive.extractfile(member) as stream: compare(member.name, member.mode, stream)
                else: compare(member.name, member.mode, link=member.linkname if member.issym() else None, directory=member.isdir())


def install_native(pins, profile, host, work, env, receipt, reuse=False):
    exports, paths = {}, []
    for name, pin in native_selection(pins, profile, host):
        archive = download_native(pin, work/'archives'/(name+'.'+pin['format']))
        destination = work/('native-'+name)
        if reuse:
            verify_native_install(archive, pin, destination)
            binary = destination/pin['binary']
        else:
            binary = unpack_native(archive, pin, destination)
        tool_env = {**env, **exports, 'PATH':os.pathsep.join([*paths, env['PATH']])}
        if name == 'dotnet':
            tool_env.update(DOTNET_ROOT=str(binary.parent), DOTNET_MULTILEVEL_LOOKUP='0',
                            DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1')
        version = subprocess.check_output([str(binary), *pin['version_args']],
                                          env=tool_env, text=True, timeout=30).strip()
        require(re.search(pin['version_pattern'], version) is not None,
                'installed native tool version mismatch: '+name)
        paths.append(str(binary.parent))
        if name.startswith('cmake-'):
            exports['CMAKE'] = str(binary)
        if name == 'dotnet':
            exports.update({key:tool_env[key] for key in
                            ('DOTNET_ROOT', 'DOTNET_MULTILEVEL_LOOKUP', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE')})
        receipt['nativeTools'].append({'name':name, 'input':pin, 'binary':str(binary), 'binarySHA256':digest(binary), 'version':version})
    return exports, paths


def host_target():
    machine = platform.machine().lower()
    arch = {'arm64': 'aarch64', 'aarch64': 'aarch64',
            'amd64': 'x86_64', 'x86_64': 'x86_64'}.get(machine)
    suffix = {'Linux': 'unknown-linux-gnu', 'Darwin': 'apple-darwin',
              'Windows': 'pc-windows-msvc'}.get(platform.system())
    host = str(arch)+'-'+str(suffix)
    require(host in HOSTS, 'unsupported native runner')
    return host


def selected_components(pins, host, targets, components):
    check_pins(pins)
    require(host in HOSTS, 'unsupported compiler host')
    require(set(components) <= OPTIONAL.keys(), 'unknown optional component')
    targets = sorted(set([host, *targets]))
    allowed = ({'x86_64-unknown-linux-gnu', 'aarch64-linux-android'}
               if host.endswith('linux-gnu') else
               {host} if host.endswith('windows-msvc') else
               {'aarch64-apple-darwin', 'x86_64-apple-darwin',
                'aarch64-apple-ios', 'aarch64-apple-ios-sim'})
    require(set(targets) <= allowed, 'target does not match the selected native host')
    entries = pins['rust']['hosts'][host]
    selected = [entries['rustc'], entries['cargo']]
    selected += [pins['rust']['std'][target] for target in targets]
    selected += [entries[OPTIONAL[name]] for name in sorted(set(components))]
    return targets, selected


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        official_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def verify(path, pin):
    require(digest(path) == pin['sha256'], 'Rust archive checksum mismatch: '+Path(path).name)


def download(pin, destination):
    official_url(pin['url'])
    require(re.fullmatch('[0-9a-f]{64}', pin['sha256']) is not None, 'missing archive digest')
    if destination.exists():
        verify(destination, pin)
        return destination
    temporary = destination.with_suffix(destination.suffix+'.partial')
    opener = urllib.request.build_opener(OfficialRedirects())
    with opener.open(pin['url'], timeout=60) as response, temporary.open('xb') as output:
        official_url(response.url)
        total = 0
        while block := response.read(1024 * 1024):
            total += len(block)
            require(total <= 1024**3, 'Rust archive exceeds download bound')
            output.write(block)
    verify(temporary, pin)
    temporary.replace(destination)
    return destination


def unpack_verified(path, pin, destination):
    verify(path, pin)  # Verification precedes even archive parsing.
    require(hasattr(tarfile, 'data_filter'), 'Python with tarfile.data_filter is required')
    with tarfile.open(path, 'r:xz') as archive:
        require(all(member.name.split('/', 1)[0] == pin['root']
                    for member in archive.getmembers()), 'unexpected Rust archive root')
        archive.extractall(destination, filter='data')
    root = destination/pin['root']
    require((root/'install.sh').is_file(), 'verified Rust installer is absent')
    return root


def installer_command(installer, prefix, bash, windows):
    if windows:
        require(bash and Path(bash).is_absolute() and Path(bash).is_file(),
                'Windows requires the explicit installed Git Bash executable (--bash)')
        # Convert native paths with that exact Git Bash, never the Windows WSL stub.
        values = subprocess.check_output(
            [bash, '-c', 'cygpath -u -- "$@"', 'iris-rust-paths', str(installer), str(prefix)],
            text=True, timeout=30).splitlines()
        require(len(values) == 2 and all(value.startswith('/') for value in values),
                'Git Bash could not map installer paths')
        return [bash, values[0], '--prefix='+values[1], '--disable-ldconfig']
    return ['/bin/sh', str(installer), '--prefix='+str(prefix), '--disable-ldconfig']


def cargo_home_bin(previous):
    home = Path(previous.get('CARGO_HOME') or Path.home()/'.cargo')
    require(home.is_absolute(), 'CARGO_HOME must be absolute to preserve it across build directories')
    return str(home/'bin')


def installed_environment(prefix, windows, previous):
    suffix = '.exe' if windows else ''
    # Cargo prepends its home/bin for external commands only when it is absent
    # from PATH. Include it explicitly behind the verified fmt/clippy binaries.
    paths = [str(prefix/'bin'), cargo_home_bin(previous), previous.get('PATH', '')]
    return {**previous, 'PATH':os.pathsep.join(paths),
            **{key:str(prefix/'bin'/(name+suffix)) for key, name in
               [('CARGO', 'cargo'), ('RUSTC', 'rustc'), ('RUSTDOC', 'rustdoc')]}}


def prepare_rust_helpers(prefix, host, env):
    if not host.endswith('-apple-darwin'):
        return None
    # The verified rustc component puts LLVM in prefix/lib; rust-objcopy uses
    # @loader_path/../lib. Bind that lookup to this same compiler's library.
    library = prefix/'lib/libLLVM.dylib'
    destination = prefix/'lib/rustlib'/host/'lib/libLLVM.dylib'
    require(library.is_file(), 'Pinned compiler is missing its bundled LLVM library')
    if destination.exists() or destination.is_symlink():
        require(destination.is_file() and destination.samefile(library),
                'Compiler helper library path already contains another input')
    else:
        destination.symlink_to('../../../libLLVM.dylib')
    environment = {key:value for key, value in env.items()
                   if key not in ('DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH')}
    return subprocess.check_output(
        [str(prefix/'lib/rustlib'/host/'bin/rust-objcopy'), '--version'],
        env=environment, text=True, timeout=30).strip()


def validate_install(prefix, host, targets, components, env):
    versions = {}
    for key, args in [('RUSTC', ['-Vv']), ('CARGO', ['-V'])]:
        versions[key] = subprocess.check_output([env[key], *args], env=env, text=True, timeout=30).strip()
    require(re.search(r'^release: 1\.99\.0$', versions['RUSTC'], re.M) is not None
            and re.search(r'^host: '+re.escape(host)+r'$', versions['RUSTC'], re.M) is not None,
            'installed rustc release/host mismatch')
    require(versions['CARGO'].startswith('cargo 1.99.0 '), 'installed Cargo version mismatch')
    for target in targets:
        require(any((prefix/'lib/rustlib'/target/'lib').glob('libstd-*.rlib')),
                'installed standard library missing: '+target)
    helper = prepare_rust_helpers(prefix, host, env)
    if helper is not None:
        versions['rust-objcopy'] = helper
    suffix = '.exe' if host.endswith('windows-msvc') else ''
    for name in components:
        binary = 'rustfmt' if name == 'rustfmt' else 'cargo-clippy'
        versions[name] = subprocess.check_output(
            [str(prefix/'bin'/(binary+suffix)), '--version'], env=env, text=True, timeout=30).strip()
    return versions


def installation_context(local_macos=False):
    if local_macos:
        require(platform.system() == 'Darwin' and os.environ.get('GITHUB_ACTIONS') != 'true',
                '--local-macos requires a local macOS host')
        return 'local-macos'
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and
            all(os.environ.get(key) for key in ('GITHUB_ENV', 'GITHUB_PATH')),
            'Use hosted CI or explicit --local-macos')
    return 'github-actions'


def install(pins, work, targets, components, bash=None, tools=None, local_macos=False, reuse=False):
    context = installation_context(local_macos)
    host = host_target()
    targets, selected = selected_components(pins, host, targets, components)
    if tools:
        native_selection(pins, tools, host)
    windows = host.endswith('windows-msvc')
    if windows:
        require(bash and Path(bash).is_absolute() and Path(bash).is_file(),
                'Windows requires the explicit installed Git Bash executable (--bash)')
    require(hasattr(tarfile, 'data_filter'), 'Python with tarfile.data_filter is required')
    require(work.is_absolute() and not any(c in str(work) for c in '\r\n'), 'absolute safe work path required')
    if reuse:
        require(local_macos and work.is_dir() and not work.is_symlink(), '--reuse requires an existing local Apple input directory')
        prior = json.loads((work/'receipt.json').read_text())
        require(prior.get('passed') is True and prior.get('pinsSHA256') == digest(PINS) and prior.get('host') == host and
                prior.get('targets') == targets and prior.get('components') == selected and
                [(tool['name'],tool['input']) for tool in prior.get('nativeTools',[])] == (native_selection(pins,tools,host) if tools else []),
                'Existing installation does not match requested pinned inputs')
        require(re.fullmatch('[0-9a-f]{40}', prior.get('sourceCommit','')) is not None, 'Previous source identity is invalid')
        previous = work/('receipt-'+prior['sourceCommit']+'-'+digest(work/'receipt.json')[:16]+'.json')
        if previous.exists(): require(previous.read_bytes() == (work/'receipt.json').read_bytes(), 'Previous receipt already differs')
        else: shutil.copyfile(work/'receipt.json',previous)
    else:
        work.mkdir(mode=0o700, parents=True, exist_ok=False)
    archive_dir, extracted, prefix = work/'archives', work/'extracted', work/'toolchain'
    archive_dir.mkdir(exist_ok=reuse)
    extracted.mkdir(exist_ok=reuse)
    require(not any(extracted.iterdir()), 'Input extraction from another operation is active or incomplete')
    receipt = {'passed':False, 'pinsSHA256':digest(PINS), 'host':host, 'targets':targets,
               'sourceCommit':None, 'workflowCommit':os.environ.get('GITHUB_SHA'),
               'installerSHA256':digest(Path(__file__)), 'python':sys.version,
               'runnerImage':{key:os.environ.get(key) for key in ('ImageOS', 'ImageVersion')},
               'executionContext':context, 'hostSystem':platform.platform(),
               'components':[], 'nativeTools':[], 'externalAssumptions':pins['external_assumptions']}
    try:
        receipt['sourceCommit'] = checkout_commit()
        if tools:
            receipt['nativePrerequisites'] = native_prerequisites(tools)
        for pin in selected:
            archive = download(pin, archive_dir/(pin['root']+'.tar.xz'))
            root = unpack_verified(archive, pin, extracted)
            subprocess.run(installer_command(root/'install.sh', prefix, bash, windows),
                           check=True, timeout=300)
            receipt['components'].append(pin)
            shutil.rmtree(root)  # Only this invocation's verified temporary extraction.
        env = installed_environment(prefix, windows, os.environ)
        receipt['versions'] = validate_install(prefix, host, targets, components, env)
        exports, native_paths = install_native(pins, tools, host, work, env, receipt, reuse) if tools else ({}, [])
        receipt['lockfiles'] = {str(path.relative_to(ROOT)):digest(path) for path in
                               (ROOT/'Cargo.lock',)
                               if path.is_file()}
        # Publish paths only after the complete requested installation validates.
        values = {key:env[key] for key in ('CARGO', 'RUSTC', 'RUSTDOC')} | exports
        if local_macos:
            destination = work/'environment.json'
            with destination.open('w' if reuse else 'x') as stream:
                json.dump({'variables':values, 'path':[str(prefix/'bin'), *native_paths]}, stream, indent=2)
            destination.chmod(0o600)
        else:
            with open(os.environ['GITHUB_PATH'], 'a', encoding='utf-8') as stream:
                # GitHub prepends these entries in reverse order in the next step.
                stream.write('\n'.join([cargo_home_bin(env), *native_paths, str(prefix/'bin')])+'\n')
            with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as stream:
                for key, value in values.items(): stream.write(key+'='+value+'\n')
        receipt['passed'] = True
    finally:
        (work/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print('Installed checksum-verified build inputs; receipt: '+str(work/'receipt.json'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--install', action='store_true')
    parser.add_argument('--target', action='append', default=[])
    parser.add_argument('--component', action='append', choices=OPTIONAL, default=[])
    parser.add_argument('--work', type=Path)
    parser.add_argument('--bash', help='Exact Git Bash executable from the Windows workflow $BASH')
    parser.add_argument('--tools', choices=sorted(TOOL_PROFILES))
    parser.add_argument('--local-macos', action='store_true', help='Explicit local Apple installation; never mutates global toolchains or CI state')
    parser.add_argument('--reuse', action='store_true', help='Reinstall identical pinned Rust components and verify every native tool byte in the existing local Apple directory; preserve its previous source receipt')
    args = parser.parse_args()
    pins = json.loads(PINS.read_text())
    check_pins(pins)
    if args.install:
        require(args.work is not None, '--work is required for installation')
        install(pins, args.work, args.target, args.component, args.bash, args.tools, args.local_macos, args.reuse)
    else:
        print('Reviewed Rust 1.99.0 pins (four hosts, seven targets) and seven native tool archives.')


if __name__ == '__main__':
    main()

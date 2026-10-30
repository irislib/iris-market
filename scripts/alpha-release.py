#!/usr/bin/env python3
"""Plan, package and verify the complete Iris Market alpha artifact set.

No uploads, signing credentials, app registration or release creation occur here.
The release owner supplies exact-source/runtime acceptance before sealing assets.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PINS = ROOT / 'scripts/release-build-inputs.json'
INSTALLER = ROOT / 'scripts/release-build-inputs.py'
LEGACY_PLATFORMS = {
    'ios-arm64': ('ios.ipa', 'aarch64-apple-ios', 'iOS 16+', 'internal TestFlight'),
    'android-arm64': ('android-arm64.apk', 'aarch64-linux-android', 'Android 10 / API 29+', 'APK'),
    'macos-arm64': ('macos-arm64.zip', 'aarch64-apple-darwin', 'macOS 14+', 'Developer ID / notarized app'),
    'cli-macos-arm64': ('cli-aarch64-apple-darwin.tar.gz', 'aarch64-apple-darwin', 'macOS 14+', 'CLI archive'),
    'cli-macos-x64': ('cli-x86_64-apple-darwin.tar.gz', 'x86_64-apple-darwin', 'macOS 14+', 'CLI archive'),
    'cli-linux-x64': ('cli-x86_64-unknown-linux-gnu.tar.gz', 'x86_64-unknown-linux-gnu', 'build host glibc baseline recorded in receipt', 'CLI archive'),
    'cli-windows-x64': ('cli-x86_64-pc-windows-msvc.zip', 'x86_64-pc-windows-msvc', 'Windows 10 x64+', 'CLI archive'),
}
LINUX_DESKTOP_PLATFORMS = {
    'linux-desktop-x64-deb': ('linux-x64.deb', 'x86_64-unknown-linux-gnu', 'Linux x64; system Python 3.10+, GTK 3, WebKitGTK 4.1', 'Debian package'),
    'linux-desktop-x64-portable': ('linux-x64.tar.gz', 'x86_64-unknown-linux-gnu', 'Linux x64; system Python 3.10+, GTK 3, WebKitGTK 4.1', 'Portable desktop archive'),
}
PLATFORMS = {**LEGACY_PLATFORMS, **LINUX_DESKTOP_PLATFORMS}


def platforms_for_schema(schema):
    require(schema in (1, 2), 'Unsupported release manifest schema')
    return LEGACY_PLATFORMS if schema == 1 else PLATFORMS


REQUIRED_ENV = {
    'ios-arm64': ('MARKET_APPLE_TEAM_ID', 'MARKET_IOS_SIGNING_IDENTITY', 'MARKET_IOS_PROFILE_UUID', 'MARKET_IOS_NSE_PROFILE_UUID'),
    'macos-arm64': ('MARKET_APPLE_TEAM_ID', 'MARKET_MACOS_SIGNING_IDENTITY'),
    'android-arm64': ('MARKET_ANDROID_KEYSTORE', 'MARKET_ANDROID_KEY_ALIAS', 'MARKET_ANDROID_STORE_PASSWORD', 'MARKET_ANDROID_KEY_PASSWORD'),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_json(path):
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= 1024 * 1024, 'JSON evidence must be a file under 1 MiB')
    return json.loads(path.read_text())


def identity(tag, commit):
    require(re.fullmatch(r'v\d+\.\d+\.\d+-alpha\.[1-9]\d*', tag or '') is not None, 'Use an explicit vMAJOR.MINOR.PATCH-alpha.N tag')
    require(re.fullmatch(r'[0-9a-f]{40}', commit or '') is not None, 'A full lowercase source commit is required')


def asset_name(tag, platform):
    require(platform in PLATFORMS, 'Unsupported alpha platform')
    return f'iris-market-{tag}-{PLATFORMS[platform][0]}'


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()


def exact_source(tag, commit):
    identity(tag, commit)
    require(git('rev-parse', 'HEAD') == commit, 'Checkout is not the accepted full source commit')
    require(not git('status', '--porcelain=v1', '--untracked-files=all'), 'Release source contains uncommitted or unreviewed files')
    require(git('rev-parse', '--is-shallow-repository') == 'false', 'Release checkout must contain complete source history')


def check_inputs(receipt, commit, platform):
    require(receipt.get('passed') is True and receipt.get('sourceCommit') == commit, 'Build input receipt is not successful for this source')
    require(receipt.get('pinsSHA256') == sha256(PINS) and receipt.get('installerSHA256') == sha256(INSTALLER), 'Build input receipt does not match reviewed installer/pins')
    target = PLATFORMS[platform][1]
    require(target == receipt.get('host') or target in receipt.get('targets', []), 'Build input receipt does not include the requested Rust target')
    require(str(receipt.get('versions', {}).get('RUSTC', '')).startswith('rustc 1.99.0 '), 'Expected verified Rust 1.99.0')


def verified_environment(inputs, receipt, previous=None):
    """Bind build tools to the verified install, not a similarly named PATH tool."""
    environment = dict(os.environ if previous is None else previous)
    prefix = Path(inputs).resolve().parent / 'toolchain'
    suffix = '.exe' if receipt['host'].endswith('windows-msvc') else ''
    for key, name in (('CARGO', 'cargo'), ('RUSTC', 'rustc'), ('RUSTDOC', 'rustdoc')):
        executable = prefix / 'bin' / (name + suffix)
        require(executable.is_file(), 'Verified toolchain executable is missing: ' + key)
        require(not environment.get(key) or Path(environment[key]).resolve() == executable.resolve(), 'Build environment differs from verified input: ' + key)
        environment[key] = str(executable)
    paths = [str(prefix / 'bin')]
    for tool in receipt.get('nativeTools', []):
        binary = Path(tool['binary']).resolve()
        require(binary.is_relative_to(Path(inputs).resolve().parent) and binary.is_file() and
                tool.get('binarySHA256') == sha256(binary), 'Verified native tool has changed')
        paths.append(str(binary.parent))
        if tool['name'].startswith('cmake-'): environment['CMAKE'] = str(binary)
    environment['PATH'] = os.pathsep.join(paths) + os.pathsep + environment.get('PATH', '')
    return environment


def preflight(tag, commit, platform, inputs, build_number=None, unsigned_android=False):
    require(platform not in LINUX_DESKTOP_PLATFORMS, 'Linux desktop uses linux-package.py and final package acceptance, not Rust native build inputs')
    exact_source(tag, commit)
    receipt = read_json(inputs)
    check_inputs(receipt, commit, platform)
    if not platform.startswith('cli-'):
        require(isinstance(build_number, int) and 0 < build_number <= 2_100_000_000, 'Native builds require a positive monotonically increasing build number')
    require(not unsigned_android or platform == 'android-arm64', 'Unsigned output is only supported for Android signing handoff')
    missing = [name for name in (() if unsigned_android else REQUIRED_ENV.get(platform, ())) if not os.environ.get(name)]
    require(not missing, 'Missing signing configuration names: ' + ', '.join(missing))
    require((ROOT/'Cargo.lock').is_file(), 'Cargo.lock is required')
    if platform == 'android-arm64':
        for relative in ('android/app/gradle.lockfile', 'android/gradle/verification-metadata.xml'):
            require((ROOT/relative).is_file(), 'Missing reviewed Android lock/checksum input')
        if not unsigned_android:
            require(Path(os.environ['MARKET_ANDROID_KEYSTORE']).is_file(), 'Configured Android keystore is unavailable')
    return receipt


def package_cli(binary, output, tag, platform, epoch):
    require(platform.startswith('cli-'), 'CLI packaging requires a CLI platform')
    binary, output = Path(binary), Path(output)
    require(binary.is_file() and not binary.is_symlink(), 'Missing regular CLI executable')
    require(not output.exists(), 'Never overwrite an existing release artifact')
    executable = 'iris-market.exe' if platform == 'cli-windows-x64' else 'iris-market'
    files = [(binary, 'iris-market/'+executable), (ROOT/'LICENSE', 'iris-market/LICENSE')]
    if output.suffix == '.zip':
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for source, name in files:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.external_attr = (0o100755 if source == binary else 0o100644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, source.read_bytes())
    else:
        with output.open('xb') as stream, gzip.GzipFile(filename='', fileobj=stream, mode='wb', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as archive:
            for source, name in files:
                info = tarfile.TarInfo(name); info.size = source.stat().st_size; info.mode = 0o755 if source == binary else 0o644; info.mtime = epoch
                with source.open('rb') as content:
                    archive.addfile(info, content)


def build_cli(args):
    receipt = preflight(args.tag, args.commit, args.platform, args.inputs)
    require(args.platform.startswith('cli-'), 'Use the native release wrapper for app builds')
    target = PLATFORMS[args.platform][1]
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    artifact = output / asset_name(args.tag, args.platform)
    require(not artifact.exists(), 'Never overwrite an existing release artifact')
    environment = verified_environment(args.inputs, receipt)
    if 'apple-darwin' in target:
        environment['MACOSX_DEPLOYMENT_TARGET'] = '14.0'
    cargo = environment.get('CARGO', 'cargo')
    subprocess.run([cargo, 'build', '--locked', '--release', '-p', 'iris-market', '--target', target], cwd=ROOT, env=environment, check=True)
    cache = Path(environment.get('CARGO_TARGET_DIR', ROOT/'target'))
    if not cache.is_absolute(): cache = ROOT/cache
    binary = cache/target/'release'/('iris-market.exe' if target.endswith('windows-msvc') else 'iris-market')
    if target == receipt['host']:
        subprocess.run([str(binary), '--help'], cwd=ROOT, env=environment, check=True, stdout=subprocess.DEVNULL)
    package_cli(binary, artifact, args.tag, args.platform, int(git('show', '-s', '--format=%ct', args.commit)))
    exact_source(args.tag, args.commit)
    build = {'platform': args.platform, 'asset': artifact.name, 'sha256': sha256(artifact), 'sourceCommit': args.commit,
             'tag':args.tag, 'inputsSHA256':sha256(args.inputs), 'nativeHelpSmokePassed':target == receipt['host'], 'readyForPublication':False}
    (output/(artifact.name+'.build.json')).write_text(json.dumps(build,indent=2)+'\n')
    print(json.dumps(build))


def asset_entries(directory, tag, schema=2):
    directory = Path(directory)
    entries = []
    for platform in platforms_for_schema(schema):
        name = asset_name(tag, platform); path = directory/name
        require(path.is_file() and not path.is_symlink() and path.stat().st_size > 0, 'Missing regular release artifact: '+name)
        entries.append({'platform': platform, 'name': name, 'bytes': path.stat().st_size, 'sha256': sha256(path), 'target': PLATFORMS[platform][1]})
    return entries


def check_acceptance(gate, tag, commit, entries):
    require(gate.get('schema') in (1, 2) and gate.get('tag') == tag and gate.get('sourceCommit') == commit and gate.get('accepted') is True, 'Acceptance must approve this exact source and alpha tag')
    platforms = platforms_for_schema(gate['schema'])
    require(len(entries) == len(platforms) and {entry.get('platform') for entry in entries} == set(platforms), 'Acceptance has an incomplete or duplicate platform inventory')
    source = gate.get('source', {})
    for channel in ('github', 'hashtree'):
        evidence = source.get(channel, {})
        require(evidence.get('commit') == commit and evidence.get('coldFetch') is True and evidence.get('completeHistory') is True and re.fullmatch('[0-9a-f]{64}', evidence.get('evidenceSHA256', '')), 'Missing cold public source/history proof for '+channel)
    checks = gate.get('checks', {})
    for name in ('core', 'source-audit', *platforms):
        record = checks.get(name, {})
        require(record.get('passed') is True and record.get('sourceCommit') == commit and re.fullmatch('[0-9a-f]{64}', record.get('evidenceSHA256', '')), 'Missing exact-source acceptance: '+name)
    for entry in entries:
        record = checks[entry['platform']]
        require(record.get('artifactSHA256') == entry['sha256'], 'Runtime acceptance refers to different artifact bytes: '+entry['platform'])
    require(checks['ios-arm64'].get('signed') is True, 'iOS acceptance must verify distribution signing')
    require(checks['macos-arm64'].get('signed') is True and checks['macos-arm64'].get('notarized') is True, 'macOS acceptance must verify signing and stapled notarization')
    require(checks['android-arm64'].get('signed') is True, 'Android acceptance must verify release signing')
    for platform in platforms.keys() & LINUX_DESKTOP_PLATFORMS.keys():
        record = checks[platform]
        require(record.get('installedOrExtractedBytesVerified') is True, 'Linux desktop acceptance must verify the final installed or extracted package bytes')
        require(record.get('bundledAssetsVerified') is True, 'Linux desktop acceptance must verify the bundled web asset manifest')
        require(record.get('sourceClean') is True, 'Linux desktop packages require a clean exact-source build')
        require(record.get('runtimeVersionsRecorded') is True, 'Linux desktop acceptance must record system runtime versions')


def seal(args):
    exact_source(args.tag, args.commit)
    gate = read_json(args.acceptance)
    entries = asset_entries(args.assets, args.tag, gate.get('schema'))
    check_acceptance(gate, args.tag, args.commit, entries)
    manifest = {'schema': gate['schema'], 'product': 'iris-market', 'channel': 'alpha', 'tag': args.tag, 'sourceCommit': args.commit,
                'source': {'github': 'https://github.com/irislib/iris-market', 'tree': git('rev-parse', 'HEAD^{tree}')},
                'cargoLockSHA256': sha256(ROOT/'Cargo.lock'), 'buildPinsSHA256': sha256(PINS),
                'acceptanceSHA256': sha256(args.acceptance), 'artifacts': entries}
    require(not args.manifest.exists() and not (args.assets/'SHA256SUMS').exists(), 'Never overwrite release metadata')
    with args.manifest.open('x') as stream: json.dump(manifest, stream, indent=2); stream.write('\n')
    with (args.assets/'SHA256SUMS').open('x') as stream:
        for entry in entries: stream.write(entry['sha256']+'  '+entry['name']+'\n')
    print(f'Sealed {len(entries)} accepted alpha artifacts. No release was published.')


def verify(manifest, directory, tag, commit, platform=None):
    identity(tag, commit)
    require(platform is None or platform in PLATFORMS, 'Unsupported alpha platform')
    require(manifest.get('schema') in (1, 2) and manifest.get('product') == 'iris-market' and manifest.get('channel') == 'alpha' and manifest.get('tag') == tag and manifest.get('sourceCommit') == commit, 'Release manifest identity mismatch')
    platforms = platforms_for_schema(manifest['schema'])
    require(platform is None or platform in platforms, 'Selected platform is absent from this manifest schema')
    artifacts = manifest.get('artifacts', [])
    require(len(artifacts) == len(platforms) and {entry.get('platform') for entry in artifacts} == set(platforms), 'Release manifest has an incomplete or duplicate platform inventory')
    for entry in artifacts:
        target = entry['platform']; require(entry.get('name') == asset_name(tag, target) and entry.get('target') == PLATFORMS[target][1], 'Noncanonical release artifact')
        require(re.fullmatch('[0-9a-f]{64}', entry.get('sha256', '')) and isinstance(entry.get('bytes'), int) and entry['bytes'] > 0, 'Invalid release checksum/size')
        if platform and target != platform: continue
        path = Path(directory)/entry['name']
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == entry['bytes'] and sha256(path) == entry['sha256'], 'Release artifact differs from accepted bytes: '+entry['name'])


def publication_files(args):
    """Recheck acceptance before either established publication destination mutates."""
    exact_source(args.tag, args.commit)
    manifest_path = args.assets/'release-manifest.json'
    checksums_path = args.assets/'SHA256SUMS'
    require(not manifest_path.is_symlink() and not checksums_path.is_symlink(), 'Publication metadata must be regular files')
    manifest = read_json(manifest_path)
    verify(manifest, args.assets, args.tag, args.commit)
    gate = read_json(args.acceptance)
    require(manifest.get('acceptanceSHA256') == sha256(args.acceptance), 'Acceptance differs from sealed manifest')
    require(gate.get('schema') == manifest['schema'], 'Acceptance schema differs from sealed manifest')
    check_acceptance(gate, args.tag, args.commit, manifest['artifacts'])
    expected = ''.join(entry['sha256']+'  '+entry['name']+'\n' for entry in manifest['artifacts'])
    require(checksums_path.read_text() == expected, 'Checksum inventory differs from sealed manifest')
    files = [{'name':entry['name'], 'bytes':entry['bytes'], 'sha256':entry['sha256']} for entry in manifest['artifacts']]
    files += [{'name':path.name, 'bytes':path.stat().st_size, 'sha256':sha256(path)} for path in (manifest_path, checksums_path)]
    return {'tag':args.tag, 'sourceCommit':args.commit, 'schema':manifest['schema'], 'files':files}


def main():
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan'); plan.add_argument('--tag', required=True)
    for command in ('preflight', 'build-cli'):
        child = commands.add_parser(command); child.add_argument('--tag', required=True); child.add_argument('--commit', required=True); child.add_argument('--platform', choices=PLATFORMS, required=True); child.add_argument('--inputs', type=Path, required=True); child.add_argument('--build-number', type=int)
        if command == 'build-cli': child.add_argument('--output', type=Path, required=True)
    child = commands.add_parser('seal'); child.add_argument('--tag', required=True); child.add_argument('--commit', required=True); child.add_argument('--assets', type=Path, required=True); child.add_argument('--acceptance', type=Path, required=True); child.add_argument('--manifest', type=Path, required=True)
    child = commands.add_parser('publication-check'); child.add_argument('--tag', required=True); child.add_argument('--commit', required=True); child.add_argument('--assets', type=Path, required=True); child.add_argument('--acceptance', type=Path, required=True)
    child = commands.add_parser('verify'); child.add_argument('--tag', required=True); child.add_argument('--commit', required=True); child.add_argument('--assets', type=Path, required=True); child.add_argument('--manifest', type=Path, required=True); child.add_argument('--platform', choices=PLATFORMS)
    args = parser.parse_args()
    if args.command == 'plan':
        identity(args.tag, '0'*40)
        print(json.dumps({'schema': 2, 'tag': args.tag, 'platforms': [{'platform': key, 'asset': asset_name(args.tag, key), 'target': value[1], 'minimumSystem': value[2], 'channel': value[3], 'signingEnvironmentNames': list(REQUIRED_ENV.get(key, ()))} for key, value in PLATFORMS.items()]}, indent=2))
    elif args.command == 'preflight': preflight(args.tag, args.commit, args.platform, args.inputs, args.build_number); print('Exact-source build preflight passed. No build or upload performed.')
    elif args.command == 'build-cli': build_cli(args)
    elif args.command == 'seal': seal(args)
    elif args.command == 'publication-check': print(json.dumps(publication_files(args)))
    else: verify(read_json(args.manifest), args.assets, args.tag, args.commit, args.platform); print('Accepted artifact checksums match.')


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr); sys.exit(1)

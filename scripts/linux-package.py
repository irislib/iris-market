#!/usr/bin/env python3
"""Package an already-built web client; downloads nothing. Requires dpkg-deb."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def package_permissions(root, executables):
    """Make installed files readable and directories traversable for every user."""
    root.chmod(0o755)
    for path in root.rglob('*'):
        relative = path.relative_to(root).as_posix()
        path.chmod(0o755 if path.is_dir() or relative in executables else 0o644)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--tag', help='Release tag used in canonical artifact filenames, e.g. v0.1.3-alpha.1')
    parser.add_argument('--arch', choices=['amd64', 'arm64'], default='amd64')
    parser.add_argument('--source-commit', help='Full source commit for an exported source tree (recorded as unverified/dirty)')
    parser.add_argument('--source-epoch', type=int, help='Source commit timestamp, required for an exported source tree')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9][0-9A-Za-z.+~]*', args.version):
        parser.error('Invalid Debian package version')
    if args.tag and not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?', args.tag):
        parser.error('Invalid release tag')
    architecture = {'amd64': 'x64', 'arm64': 'arm64'}[args.arch]
    stem = f'iris-market-{args.tag}-linux-{architecture}' if args.tag else f'iris-market-{args.version}-linux-{architecture}'
    outputs = [args.output / (stem + suffix) for suffix in ('.deb', '.tar.gz', '.json')]
    if any(path.exists() for path in outputs):
        parser.error('Output already exists; use an empty task-owned output directory')
    if args.source_commit and (not re.fullmatch(r'[0-9a-f]{40}', args.source_commit) or args.source_epoch is None):
        parser.error('Exported sources need a full commit and source epoch')
    commit = args.source_commit or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = True if args.source_commit else bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT))
    epoch = str(args.source_epoch) if args.source_commit else subprocess.check_output(['git', 'show', '-s', '--format=%ct', 'HEAD'], cwd=ROOT, text=True).strip()
    assets = ROOT / 'web/dist'
    for name in ('index.html', '_headers', 'app.js', 'THIRD_PARTY_NOTICES.txt'):
        if not (assets / name).is_file():
            parser.error('Build web/dist before packaging')
    for path in assets.rglob('*'):
        if path.is_symlink():
            parser.error('Bundled assets must not contain symbolic links')
        if path.name.startswith('._') or path.name == '.DS_Store':
            parser.error('Bundled assets contain filesystem metadata; use a clean build')
    asset_hashes = {str(path.relative_to(assets)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(assets.rglob('*')) if path.is_file()}
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='iris-market-package-') as temporary:
        stage = Path(temporary) / 'iris-market'
        app = stage / 'usr/lib/iris-market'
        app.mkdir(parents=True)
        shutil.copy2(ROOT / 'linux/iris_market.py', app / 'iris_market.py')
        shutil.copytree(assets, app / 'web')
        shutil.copy2(ROOT / 'LICENSE', app / 'LICENSE')
        (app / 'build-manifest.json').write_text(json.dumps({'source_commit': commit, 'source_dirty': dirty, 'assets': asset_hashes}, sort_keys=True, indent=2) + '\n')
        binaries = stage / 'usr/bin'
        binaries.mkdir(parents=True)
        (binaries / 'iris-market-desktop').write_text('#!/bin/sh\nexec /usr/bin/python3 /usr/lib/iris-market/iris_market.py "$@"\n')
        (binaries / 'iris-market-desktop').chmod(0o755)
        for source, dest in ((ROOT / 'linux/iris-market.desktop', stage / 'usr/share/applications/iris-market.desktop'),
                             (assets / 'icon.svg', stage / 'usr/share/icons/hicolor/scalable/apps/iris-market.svg')):
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
        control = stage / 'DEBIAN/control'
        control.parent.mkdir()
        control.write_text(f'Package: iris-market\nVersion: {args.version}\nSection: net\nPriority: optional\nArchitecture: {args.arch}\nMaintainer: Iris Market contributors\nDepends: python3 (>= 3.10), python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1 (>= 2.42)\nDescription: Iris Market WebKit desktop client\n Browse offers and requests using the bundled Iris Market web client.\n')
        package_permissions(stage, {'usr/bin/iris-market-desktop'})
        for path in stage.rglob('*'):
            os.utime(path, (int(epoch), int(epoch)))
        os.utime(stage, (int(epoch), int(epoch)))
        deb = args.output / f'{stem}.deb'
        subprocess.run(['dpkg-deb', '--root-owner-group', '--build', str(stage), str(deb)], check=True,
                       env={**os.environ, 'SOURCE_DATE_EPOCH': epoch})
        portable = Path(temporary) / stem
        shutil.copytree(app, portable)
        launcher = portable / 'iris-market'
        launcher.write_text('#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec /usr/bin/python3 "$HERE/iris_market.py" "$@"\n')
        package_permissions(portable, {'iris-market'})
        archive = args.output / f'{stem}.tar.gz'
        with archive.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=int(epoch)) as compressed, tarfile.open(fileobj=compressed, mode='w') as tar:
            for path in [portable, *sorted(portable.rglob('*'))]:
                info = tar.gettarinfo(str(path), str(path.relative_to(portable.parent)))
                info.uid = info.gid = 0
                info.uname = info.gname = 'root'
                info.mtime = int(epoch)
                if path.is_file():
                    with path.open('rb') as handle:
                        tar.addfile(info, handle)
                else:
                    tar.addfile(info)
        evidence = {'version': args.version, 'architecture': args.arch, 'source_commit': commit, 'source_dirty': dirty,
                    'runtime': 'System Python 3, GTK 3, WebKitGTK 4.1; not bundled',
                    'files': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (deb, archive)}}
        (args.output / f'{stem}.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()

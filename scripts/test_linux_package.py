#!/usr/bin/env python3
"""Exercise installable package permissions independently of the builder's umask."""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('linux_package', Path(__file__).with_name('linux-package.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class LinuxPackagePermissions(unittest.TestCase):
    def test_updater_must_match_architecture_and_accepted_checksum(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / 'updater'
            binary.write_bytes(b'\x7fELF\x02\x01' + b'\0' * 12 + (62).to_bytes(2, 'little'))
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            self.assertEqual(package.updater_digest(binary, 'amd64', digest), digest)
            with self.assertRaises(ValueError): package.updater_digest(binary, 'arm64', digest)
            with self.assertRaises(ValueError): package.updater_digest(binary, 'amd64', '0' * 64)

    @unittest.skipUnless(shutil.which('dpkg-deb'), 'requires the documented dpkg-deb packaging prerequisite')
    def test_payload_permissions_ignore_source_modes_and_umask(self):
        payloads = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('LICENSE', 'linux/iris_market.py', 'linux/updates.js', 'linux/iris-market.desktop',
                         'web/dist/index.html', 'web/dist/_headers', 'web/dist/app.js',
                         'web/dist/THIRD_PARTY_NOTICES.txt', 'web/dist/icon.svg', 'web/dist/chunks/example.js'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name + '\n')
                path.chmod(0o600)
            updater = root / 'updater'
            updater.write_bytes(b'\x7fELF\x02\x01' + b'\0' * 12 + (62).to_bytes(2, 'little'))
            digest = hashlib.sha256(updater.read_bytes()).hexdigest()
            for mask in (0o077, 0o002):
                output = root / f'output-{mask:o}'
                arguments = ['linux-package.py', '--output', str(output), '--version', '0.1.4~alpha.2',
                             '--tag', 'v0.1.4-alpha.2', '--source-commit', 'a' * 40, '--source-epoch', '1700000000', '--updater', str(updater), '--updater-sha256', digest]
                previous = os.umask(mask)
                try:
                    with patch.object(package, 'ROOT', root), patch.object(sys, 'argv', arguments), contextlib.redirect_stdout(io.StringIO()):
                        package.main()
                finally:
                    os.umask(previous)
                stem = output / 'iris-market-v0.1.4-alpha.2-linux-x64'
                records = {}
                for kind, command in [('deb', '--fsys-tarfile'), ('control', '--ctrl-tarfile')]:
                    data = subprocess.check_output(['dpkg-deb', command, str(stem) + '.deb'])
                    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                        records[kind] = self.check_archive(archive, {'usr/bin/iris-market-desktop', 'usr/lib/iris-market/iris-market-updater'} if kind == 'deb' else set())
                with tarfile.open(str(stem) + '.tar.gz') as archive:
                    records['portable'] = self.check_archive(archive, {'iris-market', 'iris-market-updater'}, remove_root=True)
                payloads.append(records)
        self.assertEqual(payloads[0], payloads[1])

    def check_archive(self, archive, executables, remove_root=False):
        records = {}
        for entry in archive:
            self.assertTrue(entry.isfile() or entry.isdir())
            name = '/'.join(entry.name.split('/')[1:]) if remove_root else entry.name.removeprefix('./')
            expected = 0o755 if entry.isdir() or name in executables else 0o644
            self.assertEqual(stat.S_IMODE(entry.mode), expected, (name, oct(entry.mode)))
            self.assertEqual((entry.uid, entry.gid), (0, 0))
            records[name] = (entry.mode, archive.extractfile(entry).read() if entry.isfile() else None)
        return records


if __name__ == '__main__':
    unittest.main()

"""Exercise GIO's real package and folder handoffs in a private XDG environment."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


def exercise(root):
    from gi.repository import Gio

    spec = importlib.util.spec_from_file_location('market', Path(__file__).resolve().parents[1] / 'iris_market.py')
    market = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(market)
    (root / 'build-manifest.json').write_text('{"version":"0.1.4-alpha.5"}')
    client = market.UpdateClient(root, root / 'state', root / 'downloads')
    client.downloads.mkdir()
    package = client.downloads / 'Iris Market.deb'
    package.write_bytes(b'local handoff fixture')
    client.result = {'path': str(package)}

    applications = Path(os.environ['XDG_DATA_HOME']) / 'applications'
    applications.mkdir(parents=True)
    record = root / 'handler-argument'
    helper = root / 'capture'
    helper.write_text('#!/bin/sh\nprintf "%s" "$1" > "$MARKET_HANDOFF_RECORD"\n')
    helper.chmod(0o700)
    os.environ['MARKET_HANDOFF_RECORD'] = str(record)
    for name, mime in [('package', 'application/vnd.debian.binary-package'), ('folder', 'inode/directory')]:
        (applications / f'{name}.desktop').write_text(
            f'[Desktop Entry]\nType=Application\nName=Test {name}\nExec="{helper}" %f\nMimeType={mime};\n')
    config = Path(os.environ['XDG_CONFIG_HOME'])
    config.mkdir()
    (config / 'mimeapps.list').write_text('[Default Applications]\napplication/vnd.debian.binary-package=package.desktop\ninode/directory=folder.desktop\n')
    handler = Gio.AppInfo.get_default_for_type('application/vnd.debian.binary-package', False)
    assert handler is not None and handler.get_id() == 'package.desktop'
    for opener, expected in [(handler, package), (None, client.downloads)]:
        client.open_download(opener, Gio.AppLaunchContext())
        deadline = time.monotonic() + 5
        while not record.exists() or record.read_text() != str(expected):
            if time.monotonic() > deadline:
                raise AssertionError(f'Desktop did not receive {expected.name}')
            time.sleep(0.02)
        record.unlink()


@unittest.skipUnless(sys.platform.startswith('linux') and importlib.util.find_spec('gi'), 'requires Linux with PyGObject')
class UpdateHandoffTest(unittest.TestCase):
    def test_desktop_opens_verified_package_or_download_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, 'HOME': directory, 'XDG_DATA_HOME': str(root / 'data'),
                   'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache'),
                   'GIO_USE_VFS': 'local', 'GIO_USE_PORTALS': '0'}
            subprocess.run([sys.executable, __file__, '--exercise', directory], env=env, check=True, timeout=15)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--exercise':
        exercise(Path(sys.argv[2]))
    else:
        unittest.main()

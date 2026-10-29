#!/usr/bin/env python3
"""Author checked-in PWA icons using the reviewed native icon renderer.

Python 3, Pillow 11.3.0 and rsvg-convert 2.63.3 are authoring inputs only.
Web builds consume the committed PNGs and perform no downloads or rendering.
"""
import importlib.util
import io
from pathlib import Path
import subprocess
from PIL import Image, __version__

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('native_icons', root / 'scripts/generate-app-icons.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
assert __version__ == '11.3.0'
assert subprocess.check_output(['rsvg-convert', '--version'], text=True).splitlines()[0] == 'rsvg-convert version 2.63.3'
for size in (192, 512):
    png = subprocess.check_output(['rsvg-convert', '--width', str(size), '--height', str(size)], input=native.source_svg('ios'))
    with Image.open(io.BytesIO(png)) as image:
        image.convert('RGB').save(root / f'web/pwa-icon-{size}.png', format='PNG', optimize=False, compress_level=9)

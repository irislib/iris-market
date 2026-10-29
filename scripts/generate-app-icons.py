#!/usr/bin/env python3
"""Render the existing Market SVG into checked-in Apple app icon catalogs.

Local authoring inputs: Python 3, Pillow 11.3.0 and librsvg/rsvg-convert 2.63.3.
No downloads or build-time generation. Apple builds consume committed PNG bytes.
Use --check to validate every catalog slot without regenerating its images.
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

from PIL import Image, __version__ as PILLOW_VERSION

ROOT = Path(__file__).resolve().parent.parent
BACKGROUND = '#f7f7f9'
INFO = {'version': 1, 'author': 'xcode'}
IOS_SLOTS = [('iphone', size, scale) for size in (20, 29, 40, 60) for scale in (2, 3)] + [
    ('ipad', size, scale) for size in (20, 29, 40, 76) for scale in (1, 2)
] + [('ipad', 83.5, 2), ('ios-marketing', 1024, 1)]
MAC_SLOTS = [('mac', size, scale) for size in (16, 32, 128, 256, 512) for scale in (1, 2)]


def catalog(platform: str, slots: list[tuple]) -> dict:
    return {'images': [{'size': f'{size}x{size}', 'idiom': idiom, 'filename': f'Icon-{round(size * scale)}.png', 'scale': f'{scale}x'} for idiom, size, scale in slots], 'info': INFO}


def source_svg(platform: str) -> bytes:
    source = ET.parse(ROOT / 'web/icon.svg').getroot()
    if source.get('viewBox') != '0 0 64 64':
        raise ValueError('Review the icon layout after changing the source viewBox.')
    # Reuse the source geometry and gradient, without an independent logo copy.
    logo = ''.join(ET.tostring(child, encoding='unicode') for child in source)
    if platform == 'ios':
        canvas = f'<rect width="1024" height="1024" fill="{BACKGROUND}"/>'
        transform = 'translate(96 96) scale(13)'
    else:
        canvas = f'<rect x="100" y="100" width="824" height="824" rx="184" fill="{BACKGROUND}"/>'
        transform = 'translate(144 144) scale(11.5)'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">{canvas}<g transform="{transform}">{logo}</g></svg>'.encode()


def generate() -> None:
    if PILLOW_VERSION != '11.3.0':
        raise RuntimeError('Use reviewed Pillow 11.3.0 for regeneration; release builds do not need Pillow.')
    version = subprocess.check_output(['rsvg-convert', '--version'], text=True).splitlines()[0]
    if version != 'rsvg-convert version 2.63.3':
        raise RuntimeError('Use reviewed rsvg-convert 2.63.3 for regeneration.')
    for platform, slots in [('ios', IOS_SLOTS), ('macos', MAC_SLOTS)]:
        assets = ROOT / platform / 'Assets.xcassets'
        icons = assets / 'AppIcon.appiconset'
        icons.mkdir(parents=True, exist_ok=True)
        value = catalog(platform, slots)
        (assets / 'Contents.json').write_text(json.dumps({'info': INFO}, indent=2) + '\n')
        (icons / 'Contents.json').write_text(json.dumps(value, indent=2) + '\n')
        svg = source_svg(platform)
        for pixels in sorted({round(size * scale) for _, size, scale in slots}):
            png = subprocess.check_output(['rsvg-convert', '--width', str(pixels), '--height', str(pixels)], input=svg)
            with Image.open(io.BytesIO(png)) as image:
                image.convert('RGB' if platform == 'ios' else 'RGBA').save(icons / f'Icon-{pixels}.png', format='PNG', optimize=False, compress_level=9)


def check() -> None:
    files, retained = set(), 0
    for platform, slots in [('ios', IOS_SLOTS), ('macos', MAC_SLOTS)]:
        icons = ROOT / platform / 'Assets.xcassets/AppIcon.appiconset'
        value = json.loads((icons / 'Contents.json').read_text())
        if value != catalog(platform, slots):
            raise ValueError(f'{platform} icon catalog slots do not match the reviewed set.')
        for item in value['images']:
            path = icons / item['filename']
            pixels = round(float(item['size'].split('x')[0]) * int(item['scale'][0]))
            with Image.open(path) as image:
                if image.format != 'PNG' or image.size != (pixels, pixels):
                    raise ValueError(f'Wrong image size or format: {path.name}')
                if platform == 'ios' and image.mode != 'RGB':
                    raise ValueError('iOS icons must be opaque RGB images without an alpha channel.')
                if platform == 'macos' and (image.mode != 'RGBA' or image.getpixel((0, 0))[3] != 0):
                    raise ValueError('macOS icons must preserve the transparent tile margin.')
            if path not in files:
                files.add(path); retained += path.stat().st_size
    print(f'Validated {len(IOS_SLOTS) + len(MAC_SLOTS)} icon slots, {len(files)} PNG files, {retained:,} bytes.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not args.check:
        generate()
    check()

#!/usr/bin/env python3
"""Builds Jimmy's app and tray icons from assets/icon-source.jpg.

Crops a square around the face, rounds the corners, and writes the PNG/ICO set
Tauri needs into src-tauri/icons/.

    pip install pillow
    python3 scripts/icon-from-image.py [source.jpg]
"""

import io
import os
import struct
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "assets", "icon-source.jpg")
OUT = os.path.join(ROOT, "src-tauri", "icons")

# Square crop (left, top, right, bottom) tight on the face so it still reads at 16-32 px.
CROP = (150, 95, 600, 545)
RADIUS = 0.22  # corner radius as a fraction of the icon size


def render(master: Image.Image, size: int) -> Image.Image:
    img = master.resize((size, size), Image.LANCZOS).convert("RGBA")
    ss = 4  # supersample the mask so the corners are smooth
    mask = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * ss - 1, size * ss - 1), radius=int(size * ss * RADIUS), fill=255
    )
    img.putalpha(mask.resize((size, size), Image.LANCZOS))
    return img


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def ico_bytes(entries):
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)
    directory = b""
    body = b""
    for size, data in entries:
        dim = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        body += data
    return header + directory + body


def main():
    master = Image.open(SRC).convert("RGB").crop(CROP)
    os.makedirs(OUT, exist_ok=True)

    files = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}
    for name, size in files.items():
        data = png_bytes(render(master, size))
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        print(f"{name} — {len(data)} bytes")

    entries = [(s, png_bytes(render(master, s))) for s in (16, 24, 32, 48, 64, 128, 256)]
    ico = ico_bytes(entries)
    with open(os.path.join(OUT, "icon.ico"), "wb") as f:
        f.write(ico)
    print(f"icon.ico — {len(ico)} bytes")


if __name__ == "__main__":
    main()

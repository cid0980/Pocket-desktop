#!/usr/bin/env python3
"""Generate the Pocket Desktop app icons (minimal: dark tile + monitor + cursor).

Run:  python3 tools/make_icons.py
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
os.makedirs(OUT, exist_ok=True)

BG_TOP = (26, 32, 41)
BG_BOT = (11, 13, 16)
INK = (240, 244, 249)
ACCENT = (77, 171, 247)

S = 1024


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build(padding_ratio=0.0, radius_ratio=0.218, tile=True):
    """Draw the icon at 1024px. padding_ratio shrinks art for maskable icons."""
    size = S
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    if tile:
        tile_img = Image.new("RGB", (size, size))
        d = ImageDraw.Draw(tile_img)
        for y in range(size):
            d.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOT, y / size))
        img.paste(tile_img, (0, 0), rounded_mask(size, int(size * radius_ratio)))

    # art is drawn inside a padded box
    pad = size * padding_ratio
    box = size - 2 * pad
    d = ImageDraw.Draw(img)

    def X(v):
        return pad + box * v

    stroke = max(6, int(box * 0.052))
    # monitor body
    m = (X(0.20), X(0.235), X(0.80), X(0.63))
    d.rounded_rectangle(m, radius=int(box * 0.055), outline=INK, width=stroke)
    # stand
    cx = X(0.5)
    d.line([(cx, X(0.63)), (cx, X(0.70))], fill=INK, width=int(stroke * 0.85))
    d.line([(X(0.352), X(0.715)), (X(0.648), X(0.715))], fill=INK, width=int(stroke * 0.85))

    # cursor arrow inside the screen (accent)
    s = box
    pts = [(0.375, 0.325), (0.375, 0.545), (0.428, 0.494), (0.462, 0.567),
           (0.492, 0.552), (0.459, 0.480), (0.520, 0.474)]
    poly = [(X(x), X(y)) for x, y in pts]
    d.polygon(poly, fill=ACCENT)
    d.line(poly + [poly[0]], fill=ACCENT, width=int(s * 0.012), joint="curve")
    return img


def save(img, name, px):
    img.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, name))
    print("wrote", name, px)


base = build()
save(base, "icon-512.png", 512)
save(base, "icon-192.png", 192)
save(base, "apple-touch-icon-180.png", 180)
save(base, "favicon-32.png", 32)
save(base, "favicon-16.png", 16)
# maskable: art shrunk into the safe zone, square tile
save(build(padding_ratio=0.15, radius_ratio=0.5), "icon-maskable-512.png", 512)
# rounded-square light variant for favicon contrast on light tabs
save(build(padding_ratio=0.06, radius_ratio=0.24), "icon-1024.png", 1024)

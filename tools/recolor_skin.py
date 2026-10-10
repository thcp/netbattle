"""Lighten the skin tones of fighter frames (PNG files), in place or to another folder.

Used on Thales, whose frames come from red's skin tone. Skin pixels are found
by colour (warm hue, enough saturation and brightness); everything else
(hair, shorts, wraps, outline) is left alone. The outline stays black.

usage: python tools/recolor_skin.py <folder or png> [more...] [--out <dir>]
Edit SKIN_V, SKIN_S and SKIN_ADD to change the tone: brightness is multiplied
by SKIN_V and raised by SKIN_ADD, saturation is multiplied by SKIN_S.
"""
import colorsys
import os
import sys

from PIL import Image

SKIN_V, SKIN_S, SKIN_ADD = 1.08, 0.88, 0.03  # option A, "a bit lighter" (owner, 2026-10-10)


def is_skin(r, g, b):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return 0.01 <= h <= 0.1 and s >= 0.35 and v >= 0.3


def recolor(img):
    out = img.convert('RGBA')
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a and is_skin(r, g, b):
                h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                rr, gg, bb = colorsys.hsv_to_rgb(h, s * SKIN_S, min(1.0, v * SKIN_V + SKIN_ADD))
                px[x, y] = (round(rr * 255), round(gg * 255), round(bb * 255), a)
    return out


def main(args):
    out_dir = None
    if '--out' in args:
        i = args.index('--out')
        out_dir = args[i + 1]
        args = args[:i] + args[i + 2:]
    files = []
    for a in args:
        if os.path.isdir(a):
            for root, _, names in os.walk(a):
                files += [os.path.join(root, n) for n in names if n.lower().endswith('.png')]
        else:
            files.append(a)
    for f in files:
        dest = f if out_dir is None else os.path.join(out_dir, os.path.basename(f))
        recolor(Image.open(f)).save(dest)
    print(len(files), 'frames recoloured')


if __name__ == '__main__':
    main(sys.argv[1:])

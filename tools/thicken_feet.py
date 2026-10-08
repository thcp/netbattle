"""Thicken the feet of a fighter's standing clips.

Red's sprites were generated with very thin feet. This widens the lowest rows
of each frame (ankles and feet) by one pixel per side and redraws the outline.
Clips where the lowest pixels are not feet (lying, flipping) are skipped.

usage: python tools/thicken_feet.py <fighter key>   e.g.  python tools/thicken_feet.py down
"""
import os
import sys

from PIL import Image

ROWS = 8  # how many rows from the bottom count as feet
SKIP = {'down', 'getUp', 'backflip', 'cartwheelKick'}


def is_outline(px):
    r, g, b, a = px
    return a > 0 and (r * 299 + g * 587 + b * 114) / 1000 < 45


def thicken(im):
    im = im.convert('RGBA')
    w, h = im.size
    src = im.load()
    rows = [y for y in range(h) if any(src[x, y][3] > 0 for x in range(w))]
    if not rows:
        return im
    foot = rows[-1]
    top = max(0, foot - ROWS + 1)
    darks = {}
    for y in range(h):
        for x in range(w):
            if is_outline(src[x, y]):
                darks[src[x, y]] = darks.get(src[x, y], 0) + 1
    outline = max(darks, key=lambda c: darks[c]) if darks else (20, 16, 22, 255)

    def body(p):
        return p[3] > 0 and not is_outline(p)

    out = im.copy()
    dst = out.load()
    # Widen: body colour spreads one pixel left and right.
    for y in range(top, foot + 1):
        for x in range(w):
            if not body(src[x, y]):
                continue
            for nx in (x - 1, x + 1):
                if 0 <= nx < w and not body(src[nx, y]):
                    dst[nx, y] = src[x, y]
    # Re-outline: empty pixels touching the widened feet become outline.
    snap = out.copy().load()
    for y in range(max(0, top - 1), min(h, foot + 2)):
        for x in range(w):
            if snap[x, y][3] > 0:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and top <= ny <= foot and body(snap[nx, ny]):
                    dst[x, y] = outline
                    break
    return out


def main(key):
    root = os.path.join(os.path.dirname(__file__), '..', 'src', 'sprites', key)
    done = 0
    for clip in sorted(os.listdir(root)):
        if clip in SKIP or not os.path.isdir(os.path.join(root, clip)):
            continue
        for name in os.listdir(os.path.join(root, clip)):
            if name.endswith('.png'):
                p = os.path.join(root, clip, name)
                thicken(Image.open(p)).save(p)
                done += 1
    print(f'{key}: thickened feet in {done} frames')


if __name__ == '__main__':
    main(sys.argv[1])

"""Count frames where the two fighters' torsos overlap in a recording.

Torsos are found by colour in a band 55-85 px above the floor: red shorts
(red fighter) and blue gi (blue fighter). Red stands left of blue, so red's
right edge going past blue's left edge means the bodies overlap. Strikes reach
past the torso band, so a small overlap budget is allowed.

usage: python tools/overlap_check.py <recording dir> [budget px]
"""
import os
import sys

from PIL import Image


def main(rec, budget=6):
    times = [int(t) for t in open(os.path.join(rec, 'times.txt')).read().split()]
    t0 = times[0]
    bad = []
    for i, t in enumerate(times):
        im = Image.open(os.path.join(rec, f'{i:04d}.png')).convert('RGB')
        w, h = im.size
        px = im.load()
        reds, blues = [], []
        for y in range(h - 85, h - 55, 2):
            for x in range(w):
                r, g, b = px[x, y]
                if r > 150 and g < 90 and b < 90:
                    reds.append(x)
                elif b > r + 30 and b > 90:
                    blues.append(x)
        if len(reds) > 20 and len(blues) > 20:
            reds.sort()
            blues.sort()
            overlap = reds[int(len(reds) * 0.9)] - blues[int(len(blues) * 0.1)]
            if overlap > budget:
                bad.append((t - t0, overlap))
    print(f'frames: {len(times)}  torso overlap > {budget}px: {len(bad)}')
    for t, o in bad[:30]:
        print(f'  {t}ms overlap {o}px')


if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 6)

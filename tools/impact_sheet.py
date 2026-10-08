"""Contact sheet of strikes at impact, from a fight or contact test run.

Reads the IMPACT lines ("IMPACT <key> <move> past=<px> ...") from the dev
output log and crops the recording at each impact. past is how far the strike
landed past the target's front edge (guard, or lead foot for low kicks).

usage: python tools/impact_sheet.py <recording dir> <dev output log> <out.png> [min past] [max past]
Only impacts with past outside [min, max] are shown (default: all).
"""
import os
import re
import sys

from PIL import Image, ImageDraw

from zoom_sheet import centre


def main(rec, log, out, lo=None, hi=None):
    times = [int(t) for t in open(os.path.join(rec, 'times.txt')).read().split()]
    text = open(log, encoding='utf-8', errors='replace').read()
    marks = [(int(m.group(1)), m.group(2), int(m.group(3)))
             for m in re.finditer(r'SHOWMARK (\d+) IMPACT (\w+ \w+) past=(-?\d+)', text)]
    pick = [(t, l, p) for t, l, p in marks
            if times[0] <= t <= times[-1] and (lo is None or p < lo or p > hi)]
    crops = []
    for t, label, p in pick:
        i = min(range(len(times)), key=lambda k: abs(times[k] - (t + 30)))
        im = Image.open(os.path.join(rec, f'{i:04d}.png')).convert('RGB')
        c = centre(im)
        crop = im.crop((c - 110, im.size[1] - 150, c + 110, im.size[1]))
        crops.append((f'{label} past={p}', crop.resize((330, 225), Image.NEAREST)))
    cols = 6
    sheet = Image.new('RGB', (cols * 330, max(1, (len(crops) + cols - 1) // cols) * 225))
    d = ImageDraw.Draw(sheet)
    for j, (label, c) in enumerate(crops):
        sheet.paste(c, ((j % cols) * 330, (j // cols) * 225))
        d.text(((j % cols) * 330 + 6, (j // cols) * 225 + 4), label, fill=(255, 255, 0))
    sheet.save(out)
    print(len(crops), 'impacts')


if __name__ == '__main__':
    a = sys.argv
    main(a[1], a[2], a[3], int(a[4]) if len(a) > 4 else None, int(a[5]) if len(a) > 5 else None)

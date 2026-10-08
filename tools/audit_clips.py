"""Audit every sprite clip: airborne frames, near-duplicate frames, frame count.

A frame is airborne when its lowest pixel sits more than AIR px above the
clip's floor line (the lowest pixel over all its frames). Two consecutive
frames are duplicates when fewer than DUP percent of their pixels differ.

usage: python tools/audit_clips.py
"""
import json
import os

from PIL import Image, ImageChops

ROOT = os.path.join(os.path.dirname(__file__), '..', 'src', 'sprites')
AIR = 3
DUP = 1.5


def lowest_row(im):
    a = im.getchannel('A')
    box = a.getbbox()
    return box[3] - 1 if box else -1


def changed(a, b):
    d = ImageChops.difference(a, b).convert('L').point(lambda v: 255 if v > 40 else 0)
    return sum(1 for v in d.get_flattened_data() if v) / (a.width * a.height) * 100


def main():
    manifest = json.load(open(os.path.join(ROOT, 'manifest.json')))
    for key, clips in manifest.items():
        print(f'== {key}')
        for clip, n in clips.items():
            frames = [Image.open(os.path.join(ROOT, key, clip, f'{i}.png')).convert('RGBA') for i in range(n)]
            lows = [lowest_row(f) for f in frames]
            floor = max(lows)
            air = [i for i, y in enumerate(lows) if floor - y > AIR]
            dups = [f'{i}={i + 1}' for i in range(n - 1) if changed(frames[i], frames[i + 1]) < DUP]
            notes = []
            if air:
                notes.append(f'AIRBORNE frames {air} (up to {floor - min(lows)} px)')
            if dups:
                notes.append(f'duplicates {", ".join(dups)}')
            print(f'  {clip:14} {n:2} frames  ' + ('; '.join(notes) if notes else 'ok'))


if __name__ == '__main__':
    main()

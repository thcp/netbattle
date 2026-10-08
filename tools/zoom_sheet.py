"""Contact sheet of a recording window, each frame cropped around the fighters.

The recording has a solid #1e1e1e backdrop; the crop follows the bounding box
of everything else in the body band, so the fighters stay large and readable.

usage: python tools/zoom_sheet.py <recording dir> <start ms offset> <end ms offset> <out.png> [every Nth frame]
Offsets are from the first frame of the recording.
"""
import os
import sys

from PIL import Image, ImageDraw

BG = (30, 30, 30)
HALF = 150  # px either side of the fighters' centre


def centre(im):
    w, h = im.size
    px = im.load()
    xs = [x for x in range(0, w, 2) for y in range(h - 118, h, 3)
          if sum(abs(c - b) for c, b in zip(px[x, y][:3], BG)) > 45]
    return (min(xs) + max(xs)) // 2 if xs else w // 2


def main(rec, a, b, out, every=2):
    times = [int(t) for t in open(os.path.join(rec, 'times.txt')).read().split()]
    t0 = times[0]
    idx = [i for i, t in enumerate(times) if a <= t - t0 <= b][::every]
    crops = []
    for i in idx:
        im = Image.open(os.path.join(rec, f'{i:04d}.png')).convert('RGB')
        c = centre(im)
        crops.append((times[i] - t0, im.crop((c - HALF, im.size[1] - 160, c + HALF, im.size[1]))))
    cols = 6
    w, h = 2 * HALF, 160
    sheet = Image.new('RGB', (cols * w, ((len(crops) + cols - 1) // cols) * h), (0, 0, 0))
    d = ImageDraw.Draw(sheet)
    for j, (t, c) in enumerate(crops):
        sheet.paste(c, ((j % cols) * w, (j // cols) * h))
        d.text(((j % cols) * w + 4, (j // cols) * h + 2), f'{t}ms', fill=(255, 255, 0))
    sheet.save(out)
    print(len(crops), 'frames', sheet.size)


if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5]) if len(sys.argv) > 5 else 2)

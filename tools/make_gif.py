"""Cut a window of a screen recording into a looping GIF for the README.

The crop is fixed over the whole window (the mean of the per-frame fighter
centres, nudged so no frame loses a fighter), then scaled up with
nearest-neighbour so the pixel art stays hard. Frame delays follow the real
capture times. Over the first and last frame the window is held a moment.

usage: python tools/make_gif.py <recording dir> <start epoch ms> <length ms> <out.gif> [scale 2]
The start is a wall-clock epoch ms, as in the SHOWMARK lines of a fight log.
"""
import os
import sys

from PIL import Image

from zoom_sheet import centre

HALF = 152  # px either side of the crop centre
HEIGHT = 154  # px above the bottom edge of the recording


def main(rec, start, length, out, scale=2):
    times = [int(t) for t in open(os.path.join(rec, 'times.txt')).read().split()]
    idx = [i for i, t in enumerate(times) if start <= t <= start + length]
    if len(idx) < 2:
        raise SystemExit('no frames in that window')
    ims = [Image.open(os.path.join(rec, f'{i:04d}.png')).convert('RGB') for i in idx]
    cs = [centre(im) for im in ims]
    mid = sum(cs) // len(cs)
    lo, hi = min(cs), max(cs)
    print(f'{len(idx)} frames, centre {mid}, spread {lo}..{hi} (crop width {2 * HALF})')
    frames, delays = [], []
    for k, im in enumerate(ims):
        h = im.size[1]
        crop = im.crop((mid - HALF, h - HEIGHT, mid + HALF, h))
        frames.append(crop.resize((crop.width * scale, crop.height * scale), Image.NEAREST))
        nxt = times[idx[k] + 1] if idx[k] + 1 < len(times) else times[idx[k]] + 40
        delays.append(max(20, round((nxt - times[idx[k]]) / 10) * 10))
    delays[-1] += 400
    pal = frames[0].quantize(colors=64, method=Image.Quantize.MEDIANCUT)
    q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    q[0].save(out, save_all=True, append_images=q[1:], duration=delays, loop=0, optimize=True, disposal=1)
    print(out, os.path.getsize(out) // 1024, 'KB', sum(delays) / 1000, 's')


if __name__ == '__main__':
    a = sys.argv
    main(a[1], int(a[2]), int(a[3]), a[4], int(a[5]) if len(a) > 5 else 2)

"""Track each fighter's body x per frame in a recording and report clunky motion.

Body x = median x of the fighter's colour in the hip band (red shorts, blue gi),
40-70 px above the floor. Reports per fighter:
  jumps    - frames where the body moves more than JUMP px in one frame
  jitter   - direction reversals of more than 2 px within 3 frames
  stop/go  - how much of the time the body is still vs moving
and prints the x series so the movement can be read as a timeline.

usage: python tools/motion_check.py <recording dir> [start ms] [end ms]
"""
import os
import sys

from PIL import Image

JUMP = 8


def body_x(px, w, h, is_me):
    xs = []
    for y in range(h - 70, h - 40, 2):
        for x in range(w):
            if is_me(px[x, y]):
                xs.append(x)
    if len(xs) < 15:
        return None
    xs.sort()
    return xs[len(xs) // 2]


def red(c):
    r, g, b = c[:3]
    return r > 150 and g < 90 and b < 90


def blue(c):
    r, g, b = c[:3]
    return b > r + 30 and b > 90


def main(rec, a=0, b=10 ** 9):
    times = [int(t) for t in open(os.path.join(rec, 'times.txt')).read().split()]
    t0 = times[0]
    series = {'red': [], 'blue': []}
    for i, t in enumerate(times):
        if not a <= t - t0 <= b:
            continue
        im = Image.open(os.path.join(rec, f'{i:04d}.png')).convert('RGB')
        w, h = im.size
        px = im.load()
        series['red'].append((t - t0, body_x(px, w, h, red)))
        series['blue'].append((t - t0, body_x(px, w, h, blue)))
    for name, s in series.items():
        pts = [(t, x) for t, x in s if x is not None]
        dx = [(pts[k][0], pts[k][1] - pts[k - 1][1]) for k in range(1, len(pts))]
        jumps = [(t, d) for t, d in dx if abs(d) > JUMP]
        jitter = 0
        for k in range(2, len(dx)):
            if abs(dx[k][1]) > 2 and abs(dx[k - 1][1]) > 2 and (dx[k][1] > 0) != (dx[k - 1][1] > 0):
                jitter += 1
        still = sum(1 for _, d in dx if abs(d) <= 1)
        print(f'{name}: frames {len(pts)}  jumps>{JUMP}px {len(jumps)}  jitter {jitter}  still {100 * still // max(1, len(dx))}%')
        print('  jumps:', ' '.join(f'{t}ms:{d:+d}' for t, d in jumps[:25]))
        print('  x:', ' '.join(str(x) for _, x in pts[:200]))


if __name__ == '__main__':
    main(sys.argv[1], *(int(v) for v in sys.argv[2:4]))

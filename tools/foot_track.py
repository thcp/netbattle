"""Check a clip as locomotion: does the planted foot stay still on screen?

Simulates the game's stepping rule on the clip's frames: the rear heel is
pinned by the drawing rule, and whenever the front foot is the one that moved
least, the fighter moves by the rear foot's travel. Prints, per frame, both
feet's on-screen x and which one is planted, then the total travel and the
worst drift of a planted foot (should be ~0 for a clean step).

usage: python tools/foot_track.py <fighter key> <clip> [reverse]
"""
import os
import sys

from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'src', 'sprites')


def feet(path):
    im = Image.open(path).convert('RGBA')
    a = im.getchannel('A').load()
    w, h = im.size
    rows = [y for y in range(h) if any(a[x, y] >= 128 for x in range(w))]
    f = rows[-1]
    on = [any(a[x, y] >= 128 for y in (f, f - 1)) for x in range(w)]
    out, x = [], 0
    while x < w:
        if on[x]:
            e = x
            while e + 1 < w and (on[e + 1] or (e + 2 < w and on[e + 2])):
                e += 1
            out.append([x, e])
            x = e
        x += 1
    return out


def track(fr, start, edge):
    cur, prev, res = start, 0, []
    for f in fr:
        if f:
            split = prev == 1 and len(f) > 1
            best = (f[0] if edge == 0 else f[-1]) if split else min(f, key=lambda p: abs(p[edge] - cur))
            cur = best[edge]
            prev = len(f)
        res.append(cur)
    return res


def main(key, clip, reverse=False):
    d = os.path.join(ROOT, key, clip)
    n = len([x for x in os.listdir(d) if x.endswith('.png')])
    order = list(range(n))[::-1] if reverse else list(range(n))
    fr = [feet(os.path.join(d, f'{i}.png')) for i in order]
    rear = track(fr, fr[0][0][0], 0)
    front = track(fr, fr[0][-1][1], 1)
    body = 0.0          # fighter position (art px), moved only when the front foot is planted
    worst = 0.0
    print(' frame  rear(screen) front(screen) planted')
    prev_screen = None
    for j in range(n):
        if j:
            dr, df = rear[j] - rear[j - 1], front[j] - front[j - 1]
            planted = 'front' if abs(df) < abs(dr) else 'rear'
            if planted == 'front':
                body += dr - df
        else:
            planted = '-'
        # Drawing rule: rear heel at body + 0 on screen; front relative to it.
        rs = body
        fs = body + (front[j] - rear[j])
        if prev_screen and planted != '-':
            moved = (rs - prev_screen[0]) if planted == 'rear' else (fs - prev_screen[1])
            worst = max(worst, abs(moved))
        prev_screen = (rs, fs)
        print(f'{j:6}  {rs:12.1f} {fs:13.1f} {planted}')
    print(f'travel per cycle: {body:+.1f} art px ({body * 2:+.0f} screen px); worst planted-foot drift {worst:.1f} art px')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], len(sys.argv) > 3)

"""Check a showcase recording for floating and popping attackers.

Inputs: a folder of frames from the screen recorder (NNNN.png plus times.txt
with wall-clock ms per frame) and the dev log with the app's
"SHOWMARK <ms> <label>" lines. The showcase paints a solid #1e1e1e backdrop,
red stands left and blue right, and the label says who attacks.

For the attacker in each move:
  float - its lowest pixel is more than FLOAT px above the floor line
  pop   - both its leftmost and rightmost floor contacts jump more than POP px
          between consecutive frames (a planted foot keeps one of them still,
          so this only fires when the whole body jumps)
A contact sheet per move is written with flagged frames outlined in red.

usage: python tools/analyze_showcase.py <recording dir> <dev log> <out dir>
"""
import os
import re
import sys

from PIL import Image, ImageDraw

BG = (30, 30, 30)
FLOAT = 3
POP = 6
BODY_BAND = 118  # px above the bottom edge that can hold a body (labels sit higher)


def body_mask(im):
    w, h = im.size
    px = im.load()
    top = h - BODY_BAND
    return {(x, y) for y in range(top, h) for x in range(w)
            if sum(abs(c - b) for c, b in zip(px[x, y][:3], BG)) > 45}


def side(mask, who, im):
    """Pixels of one fighter. Red stands left, blue right; the split is the
    column that best separates blue-gi pixels (right) from red-shorts pixels
    (left), so overlapping legs do not confuse it."""
    if not mask:
        return set()
    px = im.load()
    w = im.size[0]
    blue = [0] * w
    red = [0] * w
    for x, y in mask:
        r, g, b = px[x, y][:3]
        if b > r + 30 and b > 90:
            blue[x] += 1
        elif r > 150 and g < 90 and b < 90:
            red[x] += 1
    best, split = -1, w // 2
    red_left, blue_right = 0, sum(blue)
    for x in range(w):
        score = red_left + blue_right
        if score > best:
            best, split = score, x
        red_left += red[x]
        blue_right -= blue[x]
    mine = blue if who == 'BLUE' else red
    cols = [x for x in range(w) if mine[x]]
    lo, hi = (min(cols) - 30, max(cols) + 30) if cols else (0, w)
    # This fighter's side of the split, and near its own clothing colour (bare
    # feet carry no team colour, so the opponent's feet must not leak in).
    return {p for p in mask if (p[0] < split) == (who == 'RED') and lo <= p[0] <= hi}


def measure(px):
    if not px:
        return None
    low = max(y for _, y in px)
    contact = [x for x, y in px if y >= low - 2]
    return {'low': low, 'l': min(contact), 'r': max(contact)}


def main(rec, log, out):
    os.makedirs(out, exist_ok=True)
    times = [int(t) for t in open(os.path.join(rec, 'times.txt')).read().split()]
    marks = []
    for line in open(log, encoding='utf-8', errors='ignore'):
        m = re.search(r'SHOWMARK (\d+) (.+)$', line.strip())
        if m:
            marks.append((int(m.group(1)), m.group(2)))
    frames = [(t, Image.open(os.path.join(rec, f'{i:04d}.png')).convert('RGB')) for i, t in enumerate(times)]
    floor = frames[0][1].size[1] - 1
    ok_all = True
    for mi, (t0, label) in enumerate(marks):
        t1 = marks[mi + 1][0] if mi + 1 < len(marks) else t0 + 4000
        seg = [f for f in frames if t0 <= f[0] < t1]
        if len(seg) < 4:
            continue
        who = label.split()[0]
        sides = ['RED', 'BLUE'] if who == 'BOTH' else [who]
        flags, issues = {}, []
        for side_name in sides:
            series = []
            for k, (t, im) in enumerate(seg):
                if t - t0 < 100 and who != 'BOTH':
                    continue  # the showcase resets positions at the start of each move
                m = measure(side(body_mask(im), side_name, im))
                if m:
                    series.append((k, t, m))
            for j, (k, t, m) in enumerate(series):
                if floor - m['low'] > FLOAT:
                    flags[k] = True
                    issues.append(f'{side_name.lower()} floats {floor - m["low"]}px at +{t - t0}ms')
                if j == 0:
                    continue
                prev = series[j - 1][2]
                dl, dr = m['l'] - prev['l'], m['r'] - prev['r']
                if not (abs(dl) > POP and abs(dr) > POP and (dl > 0) == (dr > 0)):
                    continue
                # A pop is isolated: the body is still just before and just after.
                # Knockback slides and running move over many frames and pass.
                calm = True
                for a, b in ((j - 2, j - 1), (j, j + 1)):
                    if 0 <= a and b < len(series):
                        pa, pb = series[a][2], series[b][2]
                        if abs(pb['l'] - pa['l']) > POP / 2 or abs(pb['r'] - pa['r']) > POP / 2:
                            calm = False
                if calm or who != 'BOTH':
                    flags[k] = True
                    issues.append(f'{side_name.lower()} body jumps {dl:+d}/{dr:+d}px at +{t - t0}ms')
        status = 'OK' if not issues else f'{len(issues)} issue(s): ' + '; '.join(issues[:5])
        ok_all &= not issues
        print(f'{label:22} {len(seg):3} frames  {status}')
        step = max(1, len(seg) / 21)
        pick = sorted(set([int(i * step) for i in range(min(21, len(seg)))] + list(flags)))[:28]
        w, h = seg[0][1].size
        rows = (len(pick) + 6) // 7
        sheet = Image.new('RGB', (7 * w, rows * h + 20), (0, 0, 0))
        d = ImageDraw.Draw(sheet)
        d.text((4, 4), f'{label}  {status[:160]}', fill=(255, 255, 0))
        for j, k in enumerate(pick):
            x, y = (j % 7) * w, (j // 7) * h + 20
            sheet.paste(seg[k][1], (x, y))
            d.text((x + 4, y + 4), f'+{seg[k][0] - t0}ms', fill=(150, 150, 150))
            if k in flags:
                d.rectangle([x, y, x + w - 1, y + h - 1], outline=(255, 0, 0), width=3)
        sheet.save(os.path.join(out, f'{mi:02d}_{re.sub(r"[^A-Za-z0-9]+", "_", label)}.png'))
    print('ALL OK' if ok_all else 'ISSUES FOUND')


if __name__ == '__main__':
    main(*sys.argv[1:4])

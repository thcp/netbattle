"""Check the in-game foot trace from a NETBATTLE_SHOWCASE=fight run.

The fight test logs, every frame and per fighter, the world x of both foot
edges as drawn ("TRACE k,state,ms,rear,front;..."). Between two consecutive
frames at least one foot should stay put: if both move, the fighter slid or
popped. Reports those frames per state, and how much of the time each fighter
stands completely still. Also summarises the STRIKE lines (distance minus the
contact distance, in px).

usage: python tools/trace_check.py <dev output log> [slip px]
"""
import re
import sys
from collections import defaultdict

SKIP = {'run', 'hit', 'down', 'rise', 'drag', 'land', 'flip'}


def main(log, slip=2):
    rows = defaultdict(list)
    offs = []
    for line in open(log, encoding='utf-8', errors='replace'):
        if ' TRACE ' in line:
            for item in line.split(' TRACE ', 1)[1].strip().split(';'):
                p = item.split(',')
                if len(p) >= 5:
                    rows[p[0]].append((p[1], int(p[2]), int(p[3]), int(p[4]), p[5] if len(p) > 5 else '?'))
        m = re.search(r'STRIKE (\w+) (\w+) d=\d+ ideal=\d+ off=(-?\d+)', line)
        if m:
            offs.append(int(m.group(3)))
    leaving = []
    for k, r in rows.items():
        bad = defaultdict(list)
        still = moving = 0
        for a, b in zip(r, r[1:]):
            if a[0] != b[0] or b[0] in SKIP or b[1] - a[1] > 40:
                continue  # state change handled by its own pin; gaps are trace breaks
            dr, df = abs(b[2] - a[2]), abs(b[3] - a[3])
            if dr == 0 and df == 0:
                still += 1
            else:
                moving += 1
            if min(dr, df) > slip:
                bad[b[0]].append((b[1], b[2] - a[2], b[3] - a[3], f'{a[4]}>{b[4]}'))
        name = {'d': 'red', 'u': 'blue'}.get(k, k)
        st = walk_stats(r, slip)
        if k.startswith('L'):
            # a body walking off after a roster swap ('L' + id + slot): summed below
            leaving.append(st)
            continue
        if st[0]:
            print_walk(name, st)
        # Slow glides move both feet about 1 px a frame, under the slip
        # threshold: count guard runs where both feet moved the same way
        # 6 px or more with the clip frame unchanged.
        glides, run = 0, 0
        for a, b in zip(r, r[1:]):
            same = a[0] == b[0] == 'guard' and a[4] == b[4] and b[1] - a[1] <= 40
            moved = b[2] - a[2]
            if same and moved and moved == b[3] - a[3]:
                run += moved
                if abs(run) >= 6:
                    glides += 1
                    run = 0
            elif not same or moved:
                run = 0  # a still frame inside a glide keeps the run going
        print(f'{name}: guard glides of 6+ px with a still frame: {glides}')
        total = sum(len(v) for v in bad.values())
        print(f'{name}: {len(r)} frames, both feet moved > {slip}px in {total}; feet still {100 * still // max(1, still + moving)}% of same-state frames')
        for st, v in sorted(bad.items(), key=lambda kv: -len(kv[1])):
            print(f'  {st}: {len(v)}  e.g. ' + ' '.join(f'{t}ms f{fr}({x:+d},{y:+d})' for t, x, y, fr in v[:6]))
    if leaving:
        tot = [sum(s[0] for s in leaving), sum(s[1] for s in leaving), [x for s in leaving for x in s[2]],
               sum(s[3] for s in leaving), sum(s[4] for s in leaving), sum(s[5] for s in leaving)]
        print_walk(f'leaving bodies ({len(leaving)})', tot)
    if offs:
        print(f'strikes: {len(offs)}  distance minus contact: min {min(offs)} max {max(offs)}')


def walk_stats(r, slip):
    """Roster swap walks: the body may only move on a frame change, and then
    one foot edge must stay put (the planted foot). Returns frames, frame
    changes, slides (both edges moved > slip), moves without a frame change,
    and ms and px of net travel (mid point of the feet over each unbroken walk,
    so the swing foot's back and forth does not count)."""
    wk = [(a, b) for a, b in zip(r, r[1:]) if a[0] == b[0] == 'walk' and b[1] - a[1] <= 40]
    changes = sum(1 for a, b in wk if a[4] != b[4])
    slides = [(b[1], b[2] - a[2], b[3] - a[3]) for a, b in wk if min(abs(b[2] - a[2]), abs(b[3] - a[3])) > slip]
    glide = sum(1 for a, b in wk if a[4] == b[4] and (b[2] != a[2] or b[3] != a[3]))
    ms = dist = run_ms = run_d = 0
    for (a, b), nxt in zip(wk, wk[1:] + [None]):
        run_ms += b[1] - a[1]
        run_d += ((b[2] + b[3]) - (a[2] + a[3])) / 2
        if nxt is None or nxt[0] is not b:
            ms += run_ms
            dist += abs(run_d)
            run_ms = run_d = 0
    return len(wk), changes, slides, glide, ms, dist


def print_walk(name, st):
    n, changes, slides, glide, ms, dist = st
    print(f'{name}: walk {n} frames, {changes} frame changes, slides {len(slides)}, '
          f'moves without a frame change {glide}, speed {1000 * dist / max(1, ms):.0f} px/s'
          + ('  e.g. ' + ' '.join(f'{t}ms({x:+d},{y:+d})' for t, x, y in slides[:6]) if slides else ''))


if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 2)

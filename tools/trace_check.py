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
    if offs:
        print(f'strikes: {len(offs)}  distance minus contact: min {min(offs)} max {max(offs)}')


if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 2)

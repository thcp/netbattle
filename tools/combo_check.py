"""Combo, variety and landing summary of a NETBATTLE_SHOWCASE=fight run.

Reads the STRIKE and IMPACT lines from the dev output log. A combo is a run
of one fighter's strikes less than CHAIN ms apart. Reports per fighter: combo
lengths, share of attacks with 2+ strikes, strike counts, the most used
strike's share; then pauses with no strike (target: none over 4 s), and IMPACT past=
values outside the landing window (deep = through the body, short = air).

usage: python tools/combo_check.py <dev output log> [more logs...]
"""
import re
import sys
from collections import Counter

CHAIN = 1300
DEEP, SHORT = 16, -8


def main(logs):
    text = ''.join(open(p, encoding='utf-8', errors='replace').read() for p in logs)
    rows = [(int(t), k, mv) for t, k, mv in re.findall(r'SHOWMARK (\d+) STRIKE (\w+) (\w+)', text)]
    rows.sort()
    for k, name in (('down', 'red'), ('up', 'blue')):
        r = [x for x in rows if x[1] == k]
        if not r:
            continue
        lens, cur = [], 1
        for a, b in zip(r, r[1:]):
            if b[0] - a[0] < CHAIN:
                cur += 1
            else:
                lens.append(cur)
                cur = 1
        lens.append(cur)
        moves = Counter(x[2] for x in r)
        top, n = moves.most_common(1)[0]
        multi = sum(1 for x in lens if x > 1)
        print(f'{name}: {len(r)} strikes, {len(lens)} attacks, 2+ strikes {100 * multi // len(lens)}%, lengths {dict(sorted(Counter(lens).items()))}')
        print(f'  {len(moves)} different, top {top} {100 * n // len(r)}%: ' + ' '.join(f'{m}:{c}' for m, c in moves.most_common()))
    t = [x[0] for x in rows]
    gaps = [b - a for a, b in zip(t, t[1:])]
    if gaps:
        print(f'pauses over 4 s (target 0): {sum(1 for g in gaps if g > 4000)}, over 2 s: {sum(1 for g in gaps if g > 2000)}, longest {max(gaps) / 1000:.1f} s, run {(t[-1] - t[0]) / 1000:.0f} s')
    imps = []
    for line in re.findall(r'IMPACT [^\n]*', text):
        m = re.match(r'IMPACT (\w+) (\w+) past=(-?\d+)', line)
        if m:
            field = lambda k: (re.search(k + r'=(\S+)', line) or [None, None])[1]
            imps.append((*m.groups(), field('opp'), field('def'), field('weak')))
    if imps:
        # A dodge is meant to make the strike miss: those shorts are not errors.
        dodged = lambda st: st in ('sway', 'duck', 'bend', 'hop')
        deep = [i for i in imps if int(i[2]) > DEEP]
        short = [i for i in imps if int(i[2]) < SHORT and not dodged(i[3])]
        dodges = sum(1 for i in imps if int(i[2]) < SHORT and dodged(i[3]))
        print(f'impacts {len(imps)}: deep (> {DEEP}) {len(deep)}, short (< {SHORT}) {len(short)}, bad {100 * (len(deep) + len(short)) / len(imps):.1f}%  (+{dodges} intended dodges)')
        for i in deep + short:
            print(f'  {i[0]} {i[1]} past={i[2]} opp={i[3] or "?"} def={i[4] or "?"} weak={i[5] or "?"}')


if __name__ == '__main__':
    main(sys.argv[1:])

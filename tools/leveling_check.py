"""Leveling summary of a NETBATTLE_SHOWCASE=fight run (docs/leveling-spec.md).

Reads the SHOWMARK lines from the dev output log and reports per fighter:
strikes per minute, the share of its strikes the opponent evaded (in even
exchanges, weak=false; in those during the close-traffic phase of the fake
traffic; and in all), knockdowns and knockouts suffered, and the
stamina it lost to the opponent's strikes per minute (blocked and landed).

Knockdowns come from LOWHIT marks (down=1) when the log has them, else from
the foot TRACE (state changes into 'down'), so a log from before the stamina
change can be compared too. Stamina numbers come from the STAMINA marks
(every 3 s, cumulative counters).

usage: python tools/leveling_check.py <dev output log>
"""
import re
import sys

EVADES = {'sway', 'duck', 'bend', 'hop'}
NAMES = {'down': 'red', 'up': 'blue'}


def main(path):
    text = open(path, encoding='utf-8', errors='replace').read()
    marks = [(int(t), body) for t, body in re.findall(r'SHOWMARK (\d+) ([^\n]*)', text)]
    if not marks:
        print('no SHOWMARK lines')
        return
    run_s = (marks[-1][0] - marks[0][0]) / 1000
    minutes = max(run_s / 60, 1e-6)
    errors = sum(1 for _, b in marks if b.startswith('ERROR'))
    builds = {}
    last_st = {}
    lows = []
    kos = []
    strikes = {'down': 0, 'up': 0}
    imp = {k: {'all': 0, 'ev': 0, 'even': 0, 'even_ev': 0, 'close': 0, 'close_ev': 0} for k in strikes}
    phase = None
    for _, b in marks:
        m = re.match(r'BOTH (\S+)', b)
        if m:
            phase = m.group(1)
        m = re.match(r'STRIKE (\w+) ', b)
        if m and m.group(1) in strikes:
            strikes[m.group(1)] += 1
        m = re.match(r'IMPACT (\w+) (\w+) ', b)
        if m and m.group(1) in imp:
            opp = (re.search(r'opp=(\w+)', b) or [None, ''])[1]
            weak = (re.search(r'weak=(\w+)', b) or [None, ''])[1]
            r = imp[m.group(1)]
            ev = opp in EVADES
            r['all'] += 1
            r['ev'] += ev
            if weak == 'false':
                r['even'] += 1
                r['even_ev'] += ev
                if phase == 'close':
                    r['close'] += 1
                    r['close_ev'] += ev
        if b.startswith('STAMINA '):
            for k, body in re.findall(r'(down|up)\[([^\]]*)\]', b):
                f = dict(re.findall(r'(\w+)=(\S+)', body))
                last_st[k] = f
                builds[k] = f.get('b', '?')
        if b.startswith('LOWHIT '):
            lows.append(dict(re.findall(r'(\w+)=(\S+)', b)))
        if b.startswith('KO '):
            kos.append(dict(re.findall(r'(\w+)=(\S+)', b)))
    downs = {'down': 0, 'up': 0}
    if lows:
        for l in lows:
            if l.get('down') == '1' and l.get('victim') in downs:
                downs[l['victim']] += 1
        source = 'LOWHIT marks'
    else:
        prev = {}
        for line in re.findall(r' TRACE ([^\n]*)', text):
            for item in line.strip().split(';'):
                p = item.split(',')
                if len(p) < 2:
                    continue
                k = {'d': 'down', 'u': 'up'}.get(p[0])
                if k and p[1] == 'down' and prev.get(k) != 'down':
                    downs[k] += 1
                if k:
                    prev[k] = p[1]
        source = 'foot TRACE'
    print(f'run {run_s:.0f} s, errors {errors}, knockdowns from {source}')
    for k in ('down', 'up'):
        r = imp[k]
        o = 'up' if k == 'down' else 'down'
        st = last_st.get(k, {})
        taken = float(st.get('taken', 'nan'))
        spent = float(st.get('spent', 'nan'))
        ko = sum(1 for x in kos if x.get('victim') == k)
        even = f"{100 * r['even_ev'] / r['even']:.1f}% of {r['even']}" if r['even'] else 'n/a'
        allv = f"{100 * r['ev'] / r['all']:.1f}% of {r['all']}" if r['all'] else 'n/a'
        close = f"{100 * r['close_ev'] / r['close']:.1f}% of {r['close']}" if r['close'] else 'n/a'
        print(f"{NAMES[k]} build {builds.get(k, '?')}: {strikes[k] / minutes:.1f} strikes/min ({strikes[k]}), "
              f"evaded by {NAMES[o]}: even {even}, close-traffic phase {close}, all {allv}")
        print(f"  knockdowns suffered {downs[k]}, knockouts suffered {ko}, "
              f"stamina lost to strikes {taken / minutes:.1f}/min, spent on own moves {spent / minutes:.1f}/min, "
              f"last {st.get('st', '?')} gassed {st.get('g', '?')}")
    tk = {k: float(last_st.get(k, {}).get('taken', 'nan')) for k in ('down', 'up')}
    if all(v == v and v > 0 for v in tk.values()):
        print(f"drain ratio red/blue {tk['down'] / tk['up']:.2f}")


if __name__ == '__main__':
    main(sys.argv[1])

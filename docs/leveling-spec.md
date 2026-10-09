# Leveling, stamina and knockouts: spec

Single source for every number. Agents read this before touching code.
Starting values are to be tuned with test fights, but the structure is fixed.
Decided by the owner on 2026-10-09: no easy mode, max level 20, every fighter
starts with 0 points spent.

## Decisions (all accepted)

1. XP comes from each fighter's own traffic: red from download, blue from upload.
2. Cost to finish level n, in GiB (1024^3 bytes):
   - n = 1..10: `5 * n` (5, 10, 15 ... 50).
   - n = 11..19: `5 * n * (1 + 0.25 * (n - 10))` (69, 90, 114 ... 309).
   - Totals: level 11 after 275 GiB, level 20 after 1869 GiB (rounded).
3. Each level-up gives 1 point: 19 points at level 20. Stat cap 10 each (30 slots), so builds are choices.
4. Stats are Speed, Stamina, Strength (the panel's "Agility" is renamed Speed).
5. Spending is permanent. There is no respec.
6. Knockout (see below) costs the fallen fighter 1 allocated point. The point vanishes.
   The stat is random among stats with 1 or more points. After a loss the fighter is
   protected for 15 minutes of running time. With 0 allocated points nothing is lost.
7. Fresh fighters (level 1, 0 points) must fight exactly as the game does today.

## State (per fighter, persisted)

```json
{ "bytes": 0, "build": {"speed": 0, "stamina": 0, "strength": 0}, "lost": 0, "protectLeft": 0 }
```

- `level`: from `bytes` and the cost table. Level 20 is the cap; XP bar shows MAX.
- `earned = level - 1`. `unspent = earned - lost - sum(build)`. A knockout does
  `build[stat]--` and `lost++`, so `unspent` does not change (the point vanishes).
- `protectLeft`: seconds. Counts down only while the app runs. Saved with the rest.
- File: `progress.json` in the Tauri app data directory. Written every 30 s, on
  every point spent or lost, and on exit. Bytes counted only while the app runs.
- Test modes (`NETBATTLE_SHOWCASE` set) never read or write the file.
  `NETBATTLE_BUILD="red=speed,stamina,strength;blue=speed,stamina,strength"`
  sets builds, for example `red=10,0,0;blue=0,10,5`. Level is `1 + points`.

## Interface (window global `Progress`, file `src/progression.js`)

| Call | Returns or does |
|---|---|
| `await Progress.init()` | Loads the file (or the test build). Call once before the fight starts |
| `Progress.build(f)` | `{speed, stamina, strength}` for fighter `f` (0 to 10 each) |
| `Progress.level(f)` | Level 1 to 20 |
| `Progress.onKnockout(victim, attacker)` | Applies the point loss rules, effects and saving |
| `Progress.panel` | Info panel (rendered by `src/progression.js`) |

The combat code reads builds only through `Progress.build(f)`.

## Stamina and stats (combat, `src/main.js`)

Let `s`, `st`, `str` be a fighter's Speed, Stamina and Strength points.

- **Speed**
  - `tempo = 1 + 0.025 * s` (up to 1.25). Strike duration, cooldowns and step time divide by `tempo`.
  - Traffic still never changes speed. Only this stat does.
  - Defence: `defChance += 0.01 * s`. In even exchanges a defence that would become a
    block becomes an evasion with probability `clamp(0.03 * (defenderSpeed - attackerSpeed), 0, 0.30)`
    (existing evasion rules apply: sway, duck only under head kicks with room).
  - `comboSlack` and every hit-time estimate must use the scaled strike time.
- **Stamina**
  - Max stamina `100 + 10 * st`. Starts full.
  - Regeneration per second while in guard: `6 + 0.6 * st`. Half while stepping. None while attacking.
  - Costs: step 1.5. Strike: jab, cross, palm, uppercut, spinFist 4. Elbow, knee 6. Low kick, sweep, front kick, teep 7. High kick, spin kick 9.
  - Taking a blocked strike: `5 * strMult`. Taking a hit: `(10 + 0.2 * knock) * strMult`.
  - `strMult = 1 + 0.12 * attackerStrength` (up to 2.2). This is what Strength does.
  - `ratio = stamina / max`. Under 0.30: `tempo * 0.8`, `defChance - 0.25`.
  - At 0 the fighter is gassed: it cannot start an attack until `ratio >= 0.20`.
- **Knockdowns**
  - A low strike or sweep knocks down with probability `1 - 0.05 * st * ratio`
    (so 100% for a fresh fighter, as today).
  - **Knockout:** a heavy hit (`knock * traffic strength >= 30`, the same rule that draws blood, or a low strike) that lands
    while the target's stamina is 0 always knocks down, adds 0.6 s to the rise time,
    and calls `Progress.onKnockout(victim, attacker)`. Nothing else is a knockout.
- **Display:** a thin stamina bar under each fighter's speed label (green, amber under
  0.5, red under 0.3, flashing at 0), plus "Lv n" in the label. The info panel shows
  the same bar.

## Panel and effects (`src/progression.js`)

- Real level, XP bar in GiB (`used / needed`, MAX at 20), unspent points, three stat rows
  with pips (10 slots) and `+` buttons enabled when `unspent > 0` and the stat is below 10.
- Level-up: a floating "LEVEL n" for 2 s above the fighter. Knockout: a floating "-1 Speed"
  (or Stamina or Strength) in red. Floating text is a DOM overlay, not canvas.
- The panel shows "Protected 12:30" while the 15 minutes run, and the last knockout.

## Tuned values (2026-10-09, after test fights)

| Constant | Spec | Now | Why |
|---|---|---|---|
| `STR_PT` (strMult per Strength point) | 0.12 | 0.06 | At 0.12 the weak side lost stamina 4 times faster and was knocked out 10 times in 3 minutes |
| `SPEED_EVADE_PT` | 0.03 | 0.05 | A defender blocks only about 34% of strikes in even exchanges, so 0.03 gave 8% evasion |
| `SPEED_EVADE_MAX` | 0.30 | 0.50 | Goes with the line above |
| `KO_BELOW` | stamina 0 | under 5% of max | Exactly 0 lasts about 0.1 s (0 knockouts in 12 minutes); the whole gassed period gave 6 to 8 per 3 minutes |

Measured with 3 minute `fight` runs and `tools/leveling_check.py`. Single runs are noisy
(about plus or minus 2.5 knockdowns).

## Targets (for `fight-validator`)

1. Regression: both fighters at 0 points. `docs/animation-rules.md` targets all pass, and
   knockdown count per 3-minute fight is within 20% of the pre-change count (measure first).
2. Speed 10 against Speed 0, other stats 0: the fast side throws at least 15% more
   strikes per minute, and the slow side evades at least 10% of strikes (even exchange).
3. Stamina 10 against Stamina 0: the Stamina 0 side is knocked out at least 2 times more.
4. Strength 10 against Strength 0: the Strength 0 side loses stamina at least 50% faster than the reverse.
5. Knockouts: at most 4 point losses per hour of running time for the weaker side (protection
   makes the maximum 4 per hour by construction; check that it is not hit constantly).
6. Zero errors. CPU 34% of one core or less on the release build.

## Not in scope

Sound, new animation clips (a "tired" clip can follow), rounds or a match end, online features.

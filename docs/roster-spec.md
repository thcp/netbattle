# Roster rotation: every knockout changes the fighter

Requested by the owner on 2026-10-10. Decisions (all accepted as recommended):

1. **Progress belongs to the character.** Each character keeps its own level, points,
   protection timer and bytes. XP goes to whoever is on screen. A knocked-out
   character loses a point (existing knockout rule) and leaves; it comes back later
   with its own level.
2. **The slot keeps its traffic role.** There are two slots, `down` (download) and
   `up` (upload). The character standing in a slot fights on that slot's traffic.
3. **Who enters next:** a first-in first-out bench. A knocked-out character goes to the
   end of the bench. The next one in line enters. Never the one who just left.
4. **Style belongs to the character,** so Thales is aggressive in either slot.
5. **Order of work:** clips and code run in parallel. The code is built and tested with
   red and blue swapping first. Thales joins when his clips are imported.

## Vocabulary (code)

- `slot`: `'down'` or `'up'`. Indexes `speed[...]`, labels' arrow, which side's traffic.
- `char`: `'red'`, `'blue'`, `'thales'`. Indexes `SHEETS`, `LOOKS`, `CLIP_ALIAS`,
  `CLIP_FRAMES`, `STYLE`, and `Progress` state. (Old sprite folders `down` and `up`
  keep their names for red and blue: map `red -> 'down'`, `blue -> 'up'` for folders.)
- A fighter object is a slot occupant: `f.slot`, `f.char`. Swapping a character
  changes `f.char` and everything derived from it.
- Roster: `ROSTER = ['red', 'blue', 'thales']`. On screen: 2. Bench: the rest.
  With only red and blue loaded, the bench is empty and no swap happens.
  (Reasonable first test: a debug roster in which red and blue are both on screen and
  swap with a third copy, see Test modes.)

## Sequence of a swap

Triggered by `Progress.onKnockout(victim, attacker)` (stamina rule, already in the code).

1. The victim falls (existing `down` clip), lies for its normal time, gets up (`getUp`).
   The winner holds guard. No new attack starts on a falling or leaving fighter.
2. State `exit`: the victim runs away from the winner toward the nearer screen edge on
   its own side, using the `run` clip (mirrored by facing). It leaves the screen.
3. When the victim is past 60% of the way to the edge, state `enter` starts for the
   newcomer: the next character on the bench appears just outside the same edge and
   runs in to its fighting distance (the winner's `want` distance). The run uses `run`.
   The two may cross on the floor for a moment; that is accepted.
4. On arrival the newcomer goes to guard, `stamina` full, cooldown short, and the
   normal fight resumes. Total swap time at most about 8 s with a 3440 px screen
   (run speed tuned if longer).
5. The victim joins the end of the bench. Its saved state (level, points, protection)
   stays with its character.
6. A knockout during `exit` or `enter` is ignored (nobody fights then).

The swap reuses the knockout the user already approved; it does not add a new trigger.

## Respect and walking (replaces the sprint, owner 2026-10-10)

The sequence of a swap becomes:

1. The victim falls, lies and gets up (as before). The winner holds guard.
2. **Respect 1:** winner and loser stand facing each other at a respectful distance
   (about 65 px between hips) and show respect together: Muay Thai and kickboxing fighters (red,
   Thales) touch gloves, the karate fighter (blue) bows. Any pairing that includes
   blue: both bow. The gesture uses clips `touchGloves` (lead glove forward to meet
   the other's glove, hold about 0.4 s, back to guard) and `bow` (feet together,
   torso bends forward about 30 degrees, hold about 0.6 s, back up).
3. **Walk:** the loser walks out (clip `walk`, plain walking pace, no sprint), away
   from the newcomer's entry edge. The newcomer walks in at the same time (also `walk`)
   from the edge nearest to the winner, so the entry is short; the loser may still be
   on screen walking away while the fight resumes. The two never cross.
4. **Respect 2:** when the newcomer reaches the winner's `want` distance, both turn to
   each other and show respect (same rule), then guard and the fight starts.
5. The loser joins the end of the bench when he has left the screen.

Walk speed about 130 px/s (tune by eye; casual but not slow). A knockout during any of
this is ignored. The newcomer cannot be attacked before respect 2 ends. Nobody slides:
walks use the plain clip speed rules like runs do.

Clips needed per character: `bow` (all), `touchGloves` (red, Thales), `walk` (all;
red and blue already have `shuffleA` or `shuffleB` walk cycles that may be reused).

## Per-character state

- `progress.json` version 2: `{ "version": 2, "chars": { "red": {...}, "blue": {...}, "thales": {...} }, "bench": ["thales"], "slots": {"down": "red", "up": "blue"} }`.
  Each char entry is the existing `{bytes, build, lost, protectLeft}`.
  Migration from version 1: `down` becomes `red`, `up` becomes `blue`, bench `["thales"]` only when
  Thales is available, slots as above.
- XP: `onNet` gives totals per slot; bytes are credited to the character in that slot at
  the time. Keep a per-slot cumulative baseline so a swap does not double count.
- Info panel: shows the character's name and level (Red, Blue, Thales) and, on top, the
  slot role ("download" or "upload").
- Stamina is per fighter-on-screen. A newcomer starts at full.

## Per-character personality (`PERSONALITY[char]`)

| char | cooldown scale | combo bias |
|---|---|---|
| red | 1.0 | existing weights |
| blue | 1.0 | existing weights |
| thales | 0.6 | favour `cross, hook, uppercut`, `cross, hook, uppercut, frontKickHead`, `frontKickHead`, `lowKickRetreat, cross`, `lowKick` (see `docs/thales-spec.md`) |

## Test modes

- `NETBATTLE_ROSTER="red,blue,thales"` sets the roster (default `red,blue`).
- `NETBATTLE_FORCE_KO=<seconds>` forces a knockout on the leading slot every N seconds, so
  swaps can be tested without waiting for stamina to run out. Logs `SWAP exit <char>`,
  `SWAP enter <char>`, `SWAP done <ms>`.
- With roster `red,blue` only (no bench), a debug option `NETBATTLE_ROSTER="red,blue,red2"`
  where `red2` is a copy of red (same sheets, label "Red 2") lets the swap code be
  tested before Thales exists.

## Targets

1. A forced knockout produces exit, enter, done in order, every time, in 20 swaps.
2. The swap takes at most 8 s at 3440 px width.
3. No fighter slides (guard glides 0), no overlap beyond the crossing, 0 errors.
4. Speed of attacks, combos, landings: the targets in `docs/animation-rules.md` still pass
   at 0 points.
5. Save file version 1 loads into version 2 without losing bytes or points.
6. CPU 34% of one core or less with 3 characters loaded (sheets load once).

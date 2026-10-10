# Thales: a third fighter

Requested by the owner on 2026-10-10. Same body as red (Muay Thai), different look
and a more aggressive style.

## Look

- Same PixelLab character as red (`73edb117-4a98-409e-a061-cb7b534aee00`), state "Thales":
  character `e73ce0d7-c147-4cc2-9e57-841b44d7c5ed`, 64x64, side view, east is the clip direction.
- **Skin is lighter than red's** (owner: "brunette but my skin is not that dark", 2026-10-10). Every Thales frame goes through `tools/recolor_skin.py` at import (constants `SKIN_V`, `SKIN_S`, `SKIN_ADD`; current tone is option A, a bit lighter than red). Do not regenerate clips for this.
- Black Muay Thai shorts instead of red, long black hair hanging loose, no headband.
  Same bare chest, white hand wraps, white ankle wraps.
- Sprite key `thales`, folder `src/sprites/thales/`, import with `tools/import_pixellab.ps1`.
  Color of the label and effects: dark grey `#555b66` with a white outline (to be checked on screen).

## Style

More aggressive than red:

- Shorter pauses between attacks (about 0.6 times red's cooldown) and longer combos.
- Favourite sequences, in this order of weight:
  1. straight, hook, uppercut (hands, 3 strikes)
  2. straight, hook, uppercut, front kick to the face (4 strikes)
  3. front kick to the face (single, from range)
  4. low kick, then a straight with the opposite hand. On the low kick he steps back
     as the leg lands, then fires the straight from the new distance.
  5. low kick alone
- He still uses red's defence set (block, shin check, sway, duck) and the same stamina rules.

## Clips needed (key: name, count, note)

Reused from red's pipeline, generated again on Thales (v3, 64 px, 1 to 2 generations each):

| Clip | Frames | Notes |
|---|---|---|
| stance (loop) | 8 | Idle fighting stance, long hair moves slightly |
| run | 6 | |
| stepF, stepB, stepClose | 9 each | Push-step rules in `docs/animation-rules.md` |
| block, check, sway, duck | 9 each | Defences |
| hit, down, getUp | 9 each | |
| straightPro | 9 | Rear straight (cross) |
| hookPro2 | 9 | Lead hook |
| lowKickV2 | 9 | Low kick |

New clips:

| Clip | Frames | Notes |
|---|---|---|
| uppercut | 9 | Rear uppercut: dip the knees, drive up into the chin |
| frontKickHead | 9 | Front kick to the face: lead or rear knee up, leg snaps straight to head height, retract |
| lowKickRetreat | 9 | Low kick that lands behind: the kicking leg swings through and plants backward, the body ends further from the target, hands up |

All clips start and end on the reference stance, keep one foot planted, and have no
near-duplicate frames (see `docs/animation-rules.md`).

## Integration (not decided)

NetBattle has two fighters (red download, blue upload). How Thales joins is open:
a third fighter, a skin choice for red, or a separate mode. Decide with the owner
before touching `src/main.js`.

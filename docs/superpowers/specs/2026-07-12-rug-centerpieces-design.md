# Rug Centerpieces (Build 3) — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending spec review
**Backlog:** #6 Build 3 (final staged decor piece)

Build 3 of the staged decor effort. Adds an **occasional 3×3 rug centerpiece**
centered on the monster zone — a decorative, walkable platform the monster (and
heroes) can stand on, themed by dungeon with a heraldic crest.

## Goal

Sometimes (~15% of dungeons) lay a bordered rug under the monster: 8 border tiles
framing a center **crest**, themed red (warm dungeons) or blue (cool). Purely
data + placement — the rug is walkable static decor that flows through the Build 1
pipeline, so `tv.js`/`tvlayout` need no change.

## Background

- Rug art (world sheet, `docs/oryx_decor_reference.md`): red rug cols 5–7 × rows
  24–26, blue rug cols 8–10 × rows 24–26. The 8 outer tiles are the border
  (corners + edges); the **center tile is replaced by a crest** (row 27 tiles,
  which already include the rug-colored background + emblem: red 5/6/7,27 =
  phoenix/shield/knot; blue 8/9/10,27 = cross/crown/skull).
- Build 1 gave decor cells a `walkable` flag; `tvlayout` excludes only
  **non-walkable** decor from hero slots, and `tv.js` bakes all static (non-`animB`)
  decor. So a walkable, static rug needs **no `tvlayout`/`tv.js` change**.
- `dungeon2` places decor after cell resolution using the seeded `rng`, with a
  `used` set that later placements skip.

## Design decisions (confirmed in brainstorming)

1. **Occasional centerpiece** — a rug appears with a small probability
   (`RUG_CHANCE` ~0.15) per dungeon, not every encounter / not boss-only.
2. **Themed crest, centered** — color by dungeon (`RUG_WARM` set → red, else blue),
   crest chosen at random; placed centered so the monster stands on it and the
   border frames it (crest mostly under the sprite — accepted).
3. **Walkable** — heroes/monster may stand on the rug (it's `walkable: true`).

Deterministic (seeded `rng`, no `Date.now`/`Math.random`).

## Architecture

| File | Change |
|------|--------|
| `src/domain/rugs.ts` (new) | `Rug` type, `RED_RUG`/`BLUE_RUG` (8 border tiles + 3 crests), `RUG_WARM`, `RUG_CHANCE`, `rugFor(name, rng)`. |
| `tests/rugs.test.ts` (new) | Rug tiles valid + correct 3×3 arrangement; `rugFor` themes by dungeon + picks a crest; deterministic. |
| `src/domain/dungeon2.ts` | Occasionally place a rug centered on the monster zone (first, walkable, added to `used`). |
| `tests/dungeon2.test.ts` | Rug placement test; relax the monster-zone test to **non-walkable** decor. |

## Component 1 — `src/domain/rugs.ts`

```ts
import type { TileCoord } from './tilesheet';

export interface RugBorderTile { dx: number; dy: number; col: number; row: number; } // dx/dy 0..2, skips center (1,1)
export interface Rug { border: RugBorderTile[]; crests: TileCoord[]; }

// 8 border tiles (corners + edges) for a rug whose top-left sheet tile is (c0,r0).
function border(c0: number, r0: number): RugBorderTile[] {
  const out: RugBorderTile[] = [];
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++)
      if (!(dx === 1 && dy === 1)) out.push({ dx, dy, col: c0 + dx, row: r0 + dy }); // center is the crest
  return out;
}

export const RED_RUG: Rug = {
  border: border(5, 24),
  crests: [{ col: 5, row: 27 }, { col: 6, row: 27 }, { col: 7, row: 27 }], // phoenix / shield / knot
};
export const BLUE_RUG: Rug = {
  border: border(8, 24),
  crests: [{ col: 8, row: 27 }, { col: 9, row: 27 }, { col: 10, row: 27 }], // cross / crown / skull
};

// Warm-palette dungeons get the red rug; everything else the blue.
export const RUG_WARM = new Set([
  'Crimson Court', 'Emberforge', 'Cinderdeep', 'Bloodstone Cairn',
  'Auric Deep', 'Dunewatch', 'Oakenvault',
]);

export const RUG_CHANCE = 0.15; // ~1 in 7 dungeons gets a rug centerpiece

/** The rug (8 border tiles + one chosen crest) for a dungeon; consumes one rng draw for the crest. */
export function rugFor(dungeonName: string, rng: () => number): { border: RugBorderTile[]; crest: TileCoord } {
  const rug = RUG_WARM.has(dungeonName) ? RED_RUG : BLUE_RUG;
  const crest = rug.crests[Math.floor(rng() * rug.crests.length)];
  return { border: rug.border, crest };
}
```

## Component 2 — `src/domain/dungeon2.ts`

Compute the monster-zone top-left once at the start of the decor block and place
the rug **first** (so corners/torches/floor scatter skip its cells via `used`):

```ts
import { rugFor, RUG_CHANCE } from './rugs';
// ... at the top of the decor block, before corners:
const mx = Math.floor(width / 2) - 1, my = Math.floor(height / 2) - 1; // monster zone (2x2) top-left
// rug centerpiece (occasional): a 3x3 centered on the monster zone
if (rng() < RUG_CHANCE) {
  const rx = mx - 1, ry = my - 1;
  const cells: [number, number][] = [];
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) cells.push([rx + dx, ry + dy]);
  const fits = cells.every(([x, y]) => x >= 1 && y >= 1 && x <= width - 2 && y <= height - 2 && kinds[y][x] === 'floor');
  if (fits) {
    const rug = rugFor(dungeonName, rng);
    for (const b of rug.border) place(rx + b.dx, ry + b.dy, { col: b.col, row: b.row, walkable: true });
    place(rx + 1, ry + 1, { col: rug.crest.col, row: rug.crest.row, walkable: true }); // center crest
  }
}
```

The existing floor-scatter `mx/my`/`inMonster` computation is removed in favor of
the shared `mx/my` above (keep `inMonster` defined once). The rug rng draws happen
inside the decor block (after cell resolution), so wall/floor/door output is
unchanged; existing decor is repositioned only because the rng stream shifts —
still deterministic per seed.

Because rug tiles are `walkable: true`, they are the **only** walkable decor in
the current data, and they legitimately sit inside the monster zone (the monster
stands on the rug). Floor scatter still excludes the monster zone AND `used` cells,
so no non-walkable prop lands on the rug or under the monster.

## Testing

**`tests/rugs.test.ts`**
- `RED_RUG.border` / `BLUE_RUG.border` each have exactly 8 tiles at `dx,dy ∈ {0,1,2}`
  excluding `(1,1)`, with `col,row` = the rug's top-left + `dx,dy`, all in-sheet.
- Each rug has 3 crest tiles, all in-sheet.
- `rugFor('Emberforge', rng)` uses `RED_RUG` (warm); `rugFor('Glacierhold', rng)`
  uses `BLUE_RUG`; the returned crest is one of that rug's crests; deterministic
  for a fixed rng.

**`tests/dungeon2.test.ts`**
- **Relax** the existing "no decor in the monster zone" test to **no *non-walkable*
  decor** in the monster zone (walkable rug tiles are allowed there).
- New: across seeds 1..30, at least one dungeon places a rug — detected as **9
  walkable decor cells** forming the 3×3 centered on the monster zone with the
  center cell being a crest tile (a `crests` coord); when a rug is present, no
  non-walkable decor cell overlaps its 9 cells; deterministic per `(name, seed)`.
  (Warm theme e.g. `Emberforge` for red; the walkable count is 0 or 9.)

Full suite + `tsc --noEmit` stay green (baseline 239). Final check is a **controller
visual pass**: force/seed a rug (e.g. temporarily `RUG_CHANCE=1` in a scratch run, or
find a seed) and confirm it renders as a bordered platform framing the monster, with
the crest peeking, and that a hero standing on the rug edge reads correctly.

## Risks / notes

- **Half-cell offset**: a 3×3 rug can't perfectly center on a 2×2 zone; the rug sits
  slightly up-left of the monster. Framing still reads well (accepted in brainstorm).
- **Crest mostly hidden** under the monster sprite — intended ("mostly framed").
- **Determinism shift**: adding rug rng draws repositions other decor for existing
  seeds; property-based tests are unaffected and per-seed determinism holds.
- **Small rooms**: the `fits` bounds check skips the rug if the 3×3 doesn't fit
  interior (never happens for the standard 20×15, but safe for tiny test rooms).

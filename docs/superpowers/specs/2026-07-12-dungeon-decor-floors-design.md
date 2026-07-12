# Dungeon Decorations & Livelier Floors — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending spec review
**Backlog:** #6 (decorations), #7 (livelier floors), folds in #14 (floor palette tuning)

## Goal

Make the live `/tv` dungeon read like the oryx mockup: theme-appropriate props
scattered on the floor, **cobwebs tucked into corners**, **torches mounted on
walls**, and floors that are visibly richer (more accent variation, fewer flat
grey rooms). All curation + data + placement rules — no renderer changes.

## Background

- `dungeon2.generateAutotiledDungeon` already emits `AutoDungeon.decor:
  {x,y,col,row}[]`, and `tv.js buildBackground` already draws that list over the
  floor/walls. But `Dungeon.decor` (floorgroups.ts:54) is hardcoded `[]`, so
  nothing renders. **No `tv.js` / `tvview` / `tvlayout` change is needed** — they
  already pass and draw arbitrary decor cells (including cells on walls).
- Floors come from `floorgroups`: `chooseGroup` picks one FloorGroup per dungeon;
  `pickCell` blends mains (~93%) + normal accents (`ACCENT_RATE` 6%) + glow
  accents (`GLOW_RATE` 1%).
- The world sheet (`/sheet/world.png`) prop regions were mapped by direct crop:
  dungeon props at cols 28–43 rows 0–8, nature props at cols 43–55 rows 0–11.
  All decor coords below are verified against those crops.

## Design decisions (confirmed in brainstorming)

1. **Category-tagged decor library** — curate ~40 tiles once, tag each with the
   themes it fits; each dungeon draws the tiles whose tags intersect its own.
2. **Three placement types** — `floor` (scatter on interior floor), `corner`
   (cobwebs in the interior corners), `wall` (torches on wall cells).
3. **Floor richness** — bump `ACCENT_RATE`, add accents to flat groups, apply the
   #14 taste items.
4. **Rooms are OUT** — deferred to a dedicated later build.

Everything stays deterministic (seeded `rng`, no `Date.now`/`Math.random`).

## Architecture

| File | Change |
|------|--------|
| `src/domain/decor.ts` (new) | `DecorTag`, `DecorPlacement`, `DecorTile`, `DECOR_TILES` (curated), `DUNGEON_DECOR` (dungeon→tags), `decorFor(name)` → `{floor, corner, wall}` tile pools. |
| `tests/decor.test.ts` (new) | Coverage: every dungeon yields ≥1 floor decor tile; every tile is a valid sheet coord; every tag used by a dungeon is produced by some tile. |
| `src/domain/dungeon2.ts` | Replace the decor block: place corner cobwebs, wall torches, and floor scatter (avoiding the fixed center monster zone). |
| `src/domain/floorgroups.ts` | Drop the vestigial `Dungeon.decor` field; bump `ACCENT_RATE`; apply #14 constant/data tweaks. |
| `src/domain/floordata/floor_groups.json` | Add accents to flat single-main groups; demote `cinder_rock`'s 2nd main → accent (#14). |
| `src/domain/floordata/floor_compatibility.json` | Tighten over-generous `good`-tier lists; restrict/drop `crimson_mosaic` (#14). |
| `tests/dungeon2.test.ts` (extend) | Decor placed; corners use corner tiles; monster zone kept clear; deterministic. |

## Component 1 — `src/domain/decor.ts`

```ts
import type { TileCoord } from './tilesheet';

export type DecorTag =
  | 'generic' | 'crypt' | 'bones' | 'nature' | 'fire' | 'ice'
  | 'water' | 'stone' | 'sand' | 'blood' | 'poison' | 'treasure';
export type DecorPlacement = 'floor' | 'corner' | 'wall';

export interface DecorTile { col: number; row: number; name: string; placement: DecorPlacement; tags: DecorTag[]; }

// Verified sheet coords (world.png). Placement is intrinsic to the tile.
export const DECOR_TILES: DecorTile[] = [
  // --- corner (cobwebs) ---
  { col: 29, row: 2, name: 'cobweb small', placement: 'corner', tags: ['generic', 'crypt', 'stone', 'water'] },
  { col: 31, row: 2, name: 'cobweb',       placement: 'corner', tags: ['generic', 'crypt', 'stone', 'ice'] },
  { col: 33, row: 2, name: 'cobweb large', placement: 'corner', tags: ['generic', 'crypt', 'stone'] },
  // --- wall (torches) ---
  { col: 41, row: 2, name: 'wall torch',   placement: 'wall', tags: ['fire', 'crypt', 'stone', 'treasure', 'blood'] },
  { col: 42, row: 2, name: 'wall torch b', placement: 'wall', tags: ['fire', 'crypt', 'stone', 'treasure'] },
  // --- floor: crypt / bones ---
  { col: 29, row: 1, name: 'gravestone',      placement: 'floor', tags: ['crypt', 'bones'] },
  { col: 30, row: 1, name: 'broken tombstone',placement: 'floor', tags: ['crypt', 'bones', 'stone'] },
  { col: 32, row: 1, name: 'crossed bones',   placement: 'floor', tags: ['crypt', 'bones'] },
  { col: 34, row: 1, name: 'scattered bones', placement: 'floor', tags: ['crypt', 'bones'] },
  { col: 36, row: 1, name: 'skull pile',      placement: 'floor', tags: ['crypt', 'bones'] },
  { col: 38, row: 1, name: 'skeleton',        placement: 'floor', tags: ['crypt', 'bones'] },
  // --- floor: fire / forge ---
  { col: 39, row: 1, name: 'small flame', placement: 'floor', tags: ['fire'] },
  { col: 40, row: 1, name: 'flame',       placement: 'floor', tags: ['fire'] },
  { col: 41, row: 1, name: 'brazier',     placement: 'floor', tags: ['fire', 'treasure'] },
  { col: 31, row: 6, name: 'cauldron',    placement: 'floor', tags: ['fire', 'poison'] },
  // --- floor: treasure ---
  { col: 32, row: 4, name: 'treasure chest', placement: 'floor', tags: ['treasure'] },
  { col: 33, row: 4, name: 'open gold chest', placement: 'floor', tags: ['treasure'] },
  { col: 36, row: 4, name: 'gold idol',      placement: 'floor', tags: ['treasure', 'stone'] },
  { col: 36, row: 5, name: 'throne',         placement: 'floor', tags: ['treasure'] },
  // --- floor: generic props (barrels / crates / urns) ---
  { col: 39, row: 4, name: 'barrel',      placement: 'floor', tags: ['generic', 'stone', 'sand', 'fire'] },
  { col: 40, row: 4, name: 'barrel open', placement: 'floor', tags: ['generic', 'stone', 'water'] },
  { col: 29, row: 5, name: 'crate',       placement: 'floor', tags: ['generic', 'stone'] },
  { col: 41, row: 5, name: 'wood crate',  placement: 'floor', tags: ['generic', 'sand'] },
  { col: 37, row: 6, name: 'stone urn',   placement: 'floor', tags: ['generic', 'stone', 'crypt'] },
  { col: 39, row: 6, name: 'stone pot',   placement: 'floor', tags: ['generic', 'stone'] },
  { col: 42, row: 6, name: 'broken pot',  placement: 'floor', tags: ['generic', 'stone', 'crypt'] },
  // --- floor: colored urns (theme accents) ---
  { col: 37, row: 7, name: 'blue urn',  placement: 'floor', tags: ['water', 'ice'] },
  { col: 40, row: 7, name: 'green urn', placement: 'floor', tags: ['poison', 'nature'] },
  { col: 37, row: 8, name: 'red urn',   placement: 'floor', tags: ['blood', 'fire'] },
  { col: 40, row: 8, name: 'clay pot',  placement: 'floor', tags: ['sand', 'generic'] },
  // --- floor: rubble / rocks ---
  { col: 31, row: 1, name: 'rubble',       placement: 'floor', tags: ['stone', 'sand', 'generic'] },
  { col: 34, row: 6, name: 'rocks',        placement: 'floor', tags: ['stone', 'sand', 'ice', 'generic'] },
  { col: 33, row: 7, name: 'cracked rock', placement: 'floor', tags: ['stone', 'sand'] },
  // --- floor: blood ---
  { col: 35, row: 2, name: 'blood splat',  placement: 'floor', tags: ['blood'] },
  { col: 36, row: 2, name: 'blood specks', placement: 'floor', tags: ['blood'] },
  // --- floor: poison / slime ---
  { col: 38, row: 2, name: 'slime splat', placement: 'floor', tags: ['poison', 'nature'] },
  { col: 39, row: 2, name: 'green slime', placement: 'floor', tags: ['poison', 'water'] },
  // --- floor: water ---
  { col: 29, row: 8, name: 'fountain', placement: 'floor', tags: ['water'] },
  { col: 30, row: 8, name: 'well',     placement: 'floor', tags: ['water', 'stone'] },
  // --- floor: nature ---
  { col: 44, row: 1, name: 'bush',        placement: 'floor', tags: ['nature'] },
  { col: 45, row: 1, name: 'bush b',      placement: 'floor', tags: ['nature'] },
  { col: 52, row: 3, name: 'round bush',  placement: 'floor', tags: ['nature'] },
  { col: 44, row: 2, name: 'flowers',     placement: 'floor', tags: ['nature'] },
  { col: 46, row: 2, name: 'flowers b',   placement: 'floor', tags: ['nature'] },
  { col: 50, row: 3, name: 'cactus',      placement: 'floor', tags: ['nature', 'sand'] },
  { col: 54, row: 2, name: 'red mushroom',placement: 'floor', tags: ['nature', 'poison'] },
  { col: 52, row: 2, name: 'blue mushroom',placement: 'floor', tags: ['nature', 'water'] },
  { col: 45, row: 3, name: 'brown rock',  placement: 'floor', tags: ['nature', 'stone', 'sand'] },
  { col: 46, row: 3, name: 'grey rock',   placement: 'floor', tags: ['nature', 'stone', 'ice'] },
  { col: 49, row: 4, name: 'small pine',  placement: 'floor', tags: ['nature'] },
  { col: 45, row: 8, name: 'small tree',  placement: 'floor', tags: ['nature'] },
  { col: 50, row: 4, name: 'snowy pine',  placement: 'floor', tags: ['ice'] },
];

// Each of the 21 dungeons -> the decor tags it draws from.
export const DUNGEON_DECOR: Record<string, DecorTag[]> = {
  'Greystone Keep':    ['stone', 'generic', 'crypt'],
  'Crimson Court':     ['blood', 'treasure', 'stone', 'fire'],
  'Mossmarch Hold':    ['nature', 'water', 'stone'],
  'Emberforge':        ['fire', 'stone', 'treasure'],
  'Oakenvault':        ['generic', 'treasure', 'stone', 'nature'],
  'Verdant Crypt':     ['crypt', 'bones', 'nature', 'poison'],
  'Tideglass Halls':   ['water', 'ice', 'generic'],
  'Frostiron Bastion': ['ice', 'stone', 'generic'],
  'Auric Deep':        ['treasure', 'fire', 'stone'],
  'Rustpipe Sewers':   ['water', 'poison', 'generic'],
  'Drowned Foundry':   ['water', 'fire', 'stone', 'generic'],
  'Duskstone Warren':  ['stone', 'crypt', 'generic'],
  'Thornwind Ruins':   ['nature', 'stone', 'crypt'],
  'Cinderdeep':        ['fire', 'stone', 'blood'],
  'Wildroot Barrow':   ['nature', 'crypt', 'bones'],
  'Ossuary Pale':      ['crypt', 'bones', 'stone'],
  'Glacierhold':       ['ice', 'stone', 'water'],
  'Bogstone Mire':     ['poison', 'water', 'nature', 'crypt'],
  'Dunewatch':         ['sand', 'stone', 'crypt', 'treasure'],
  'Cobblemoor':        ['stone', 'nature', 'generic'],
  'Bloodstone Cairn':  ['blood', 'crypt', 'bones', 'fire'],
};

const FALLBACK_DECOR: DecorTag[] = ['generic', 'stone'];

/** Decor tile pools for a dungeon, split by placement. */
export function decorFor(dungeonName: string): { floor: TileCoord[]; corner: TileCoord[]; wall: TileCoord[] } {
  const tags = new Set(DUNGEON_DECOR[dungeonName] ?? FALLBACK_DECOR);
  const pick = (p: DecorPlacement) => DECOR_TILES
    .filter((t) => t.placement === p && t.tags.some((tag) => tags.has(tag)))
    .map((t) => ({ col: t.col, row: t.row }));
  return { floor: pick('floor'), corner: pick('corner'), wall: pick('wall') };
}
```

Every dungeon's tag set intersects several floor tiles, at least one corner tile,
and (for the built/lit themes) wall torches; the coverage test asserts the floor
pool is always non-empty. Water/ice/nature themes may legitimately have no wall
torches (they use fountains/rocks instead) — that's allowed.

## Component 2 — `src/domain/dungeon2.ts` (placement)

Replace the current decor block (the `dungeon.decor`-based scatter) with
placement-aware logic driven by `decorFor(dungeonName)`. All draws use the same
seeded `rng`:

1. **Corners** — for each of the four interior corner floor cells `(1,1)`,
   `(w-2,1)`, `(1,h-2)`, `(w-2,h-2)`: with ~60% chance (rng), if the corner pool
   is non-empty, place a random corner tile there.
2. **Wall torches** — collect eligible wall cells (border walls that are not
   corners and not doors), shuffle, and place a torch on every few cells
   (roughly one per ~5 wall cells, capped ~6) when the wall pool is non-empty.
3. **Floor scatter** — from the interior floor cells, excluding the fixed 2×2
   **monster zone** (`mx=floor(w/2)-1, my=floor(h/2)-1`, cells `mx..mx+1 ×
   my..my+1`) and any corner cell already used, shuffle and place `4 + rng()*5`
   floor tiles (when the floor pool is non-empty).

`AutoDungeon.decor` remains `{x,y,col,row}[]`; corner/wall/floor entries are all
just cells in that one list, so `tv.js` needs no change. `getDungeon(...).decor`
is no longer read — remove the field (Component 4).

## Component 3 — Floor richness (#7 + #14)

- **`ACCENT_RATE`** (floorgroups.ts): 0.06 → **0.11** (more visible variation
  without turning floors noisy). `GLOW_RATE` unchanged.
- **Flat single-main groups** (`floor_groups.json`): identify groups whose
  `accents` array is empty and add 1–2 same-family accent tiles so every floor
  has some variation. (Implementer inspects the JSON + verifies visually.)
- **#14 taste items:**
  - `cinder_rock`: demote its high-contrast 2nd main to a sparse **accent** so
    the floor isn't a busy 50/50 blend.
  - `crimson_mosaic`: it's loud as a whole-room fill and its compat bridges it to
    grey dungeons — drop it as a main **or** restrict its compat
    (`floor_compatibility.json`) to crimson-family dungeons only.
  - Tighten the most over-generous `good`-tier compat lists so warm floors don't
    land under cool/green walls.

Exact JSON values are finalized in the plan against the live floordata and
confirmed by the visual pass (floor tuning is inherently iterative).

## Component 4 — `src/domain/floorgroups.ts` cleanup

Remove the vestigial `decor: TileCoord[]` from the `Dungeon` interface and the
`decor: []` initializer (dungeon2 now sources decor from `decor.ts`). Confirm no
other consumer reads `Dungeon.decor` (only dungeon2 did).

## Testing

**`tests/decor.test.ts`**
- Every `DECOR_TILES` entry has integer `col`/`row` within the sheet
  (`0..SHEET.cols-1`, `0..SHEET.rows-1`) and ≥1 tag.
- For every dungeon in `DUNGEONS`, `decorFor(d.name).floor` is non-empty; the
  union of floor+corner+wall is non-empty.
- `decorFor` only returns tiles whose tags intersect the dungeon's tags;
  unknown dungeon name falls back without throwing.

**`tests/dungeon2.test.ts`** (extend)
- A generated dungeon has non-empty `decor`.
- No decor cell lands in the 2×2 monster zone.
- Corner-placed decor cells (if any) are at interior corner coords and their
  `{col,row}` is a `corner`-placement tile from `DECOR_TILES`.
- Deterministic: same `(name, seed)` → identical decor list.

**Floors**: keep the existing floorgroups/dungeon2 tests green after the
`ACCENT_RATE` change and floordata edits (update any test that asserts an exact
accent frequency).

Full suite + `tsc --noEmit` stay green (baseline 228). `tv.js` unchanged, so the
final check is a **controller visual pass**: render a spread of themed dungeons
(crypt, forge, nature, ice, sewer, desert, blood) via headless screenshots and
confirm decor reads well (cobwebs in corners, torches on walls, themed floor
props) and floors look richer.

## Risks / notes

- **Occlusion**: heroes/monster draw over the baked decor. Floor scatter avoids
  the monster zone; heroes are sparse and moving, so decor peeking around them
  adds life (intended). Corners/walls are never under the monster.
- **Wall-torch transparency**: the torch tiles (41–42,2) are transparent-bg props
  verified against the sheet crop, so they composite cleanly onto the wall tile
  (decor draws after walls in `buildBackground`).
- **Density**: ~2–4 corners + ~≤6 torches + ~4–8 floor props per 20×15 room —
  tuned to read rich but not cluttered; adjust after the visual pass.
- **Floor tuning is iterative** — the `ACCENT_RATE` value and #14 JSON edits are
  starting points to confirm on the real render.

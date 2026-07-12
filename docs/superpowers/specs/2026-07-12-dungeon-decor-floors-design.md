# Dungeon Decorations & Livelier Floors — Build 1 Design

**Date:** 2026-07-12
**Status:** Approved (design), pending spec review
**Backlog:** #6 (decorations), #7 (livelier floors), folds in #14 (floor palette tuning)

Part of a staged effort (curation reference: `docs/oryx_decor_reference.md`):
- **Build 1 (this spec):** static themed decor (floor / corner / wall) + a
  `walkable` flag driving hero-slot avoidance + more cobweb variety + floor tuning.
- **Build 2 (later):** animate the flagged A/B items (torches, cauldron, tomes,
  skull) — introduces a per-frame decor pipeline in `tv.js`.
- **Build 3 (later):** rugs (3×3 + swappable crests, walkable) + boss platform.

Build 1 **captures all curation data now** (each tile's `walkable` flag and, for
animated tiles, its `animB` frame coords) so Builds 2/3 are pure wiring. Build 1
renders animated items as their **static frame A** (baked); it does not animate.

## Goal

Make the live `/tv` dungeon read like the oryx mockup: theme-appropriate props on
the floor, cobwebs in corners, torches on walls, and richer floors — all curation
+ data + placement. No new mechanics beyond hero-slot avoidance.

## Background

- `dungeon2.generateAutotiledDungeon` emits `AutoDungeon.decor`, and `tv.js
  buildBackground` bakes that list over the floor/walls. `Dungeon.decor`
  (floorgroups.ts:54) is hardcoded `[]`, so nothing renders today.
- **`tv.js` needs no change** in Build 1: it already draws any decor cell
  (including cells on walls) into the baked panel; it simply ignores the extra
  `walkable` field on each entry.
- Floors: `chooseGroup` picks one FloorGroup per dungeon; `pickCell` blends mains
  (~93%) + normal accents (`ACCENT_RATE` 6%) + glow accents (`GLOW_RATE` 1%).
- All decor coords are verified against sheet crops (see `docs/oryx_decor_reference.md`).

## Design decisions (confirmed in brainstorming)

1. **Category-tagged decor library** — tag each tile with the themes it fits;
   each dungeon draws the tiles whose tags intersect its own.
2. **Three placement types** — `floor` (scatter), `corner` (cobwebs), `wall` (torches).
3. **`walkable` flag per tile** — solid props are non-walkable (a hero must not
   stand on a cauldron); rugs (Build 3) will be walkable. In Build 1 all decor is
   non-walkable, so **hero slots avoid decor cells**.
4. **More cobweb variety + per-dungeon density** — cobweb-heavy dungeons fill more corners.
5. **Floor richness** — bump `ACCENT_RATE`, add accents to flat groups, apply #14.
6. **Rooms + animation + rugs are OUT of Build 1.**

Deterministic throughout (seeded `rng`, no `Date.now`/`Math.random`).

## Architecture

| File | Change |
|------|--------|
| `src/domain/decor.ts` (new) | `DecorTag`, `DecorPlacement`, `DecorTile`, `DECOR_TILES`, `DUNGEON_DECOR`, `COBWEB_HEAVY`, `decorFor(name)`. |
| `tests/decor.test.ts` (new) | Coverage: every dungeon → ≥1 floor tile; every tile valid; walkable present; tags produced. |
| `src/domain/dungeon2.ts` | Placement-aware decor (corners, wall torches, floor scatter clear of the monster zone); `DecorCell` carries `walkable`. |
| `src/domain/tvlayout.ts` | Hero slots exclude non-walkable decor cells. |
| `src/domain/floorgroups.ts` | Drop vestigial `Dungeon.decor`; bump `ACCENT_RATE`; #14 tweaks. |
| `src/domain/floordata/floor_groups.json` | Accents for flat groups; demote `cinder_rock` 2nd main → accent (#14). |
| `src/domain/floordata/floor_compatibility.json` | Tighten `good`-tier; restrict/drop `crimson_mosaic` (#14). |
| `tests/dungeon2.test.ts`, `tests/tvlayout.test.ts` (extend) | Decor placed, monster zone clear, hero slots avoid decor, deterministic. |

## Component 1 — `src/domain/decor.ts`

```ts
import type { TileCoord } from './tilesheet';

export type DecorTag =
  | 'generic' | 'crypt' | 'bones' | 'nature' | 'fire' | 'ice'
  | 'water' | 'stone' | 'sand' | 'blood' | 'poison' | 'treasure' | 'arcane';
export type DecorPlacement = 'floor' | 'corner' | 'wall';

export interface DecorTile {
  col: number; row: number; name: string;
  placement: DecorPlacement;
  tags: DecorTag[];
  walkable: boolean;               // hero/monster may stand on it (rugs true; props false)
  animB?: { col: number; row: number };  // 2nd frame — captured for Build 2, not rendered now
}

export const DECOR_TILES: DecorTile[] = [
  // corner — cobwebs
  { col: 29, row: 2, name: 'cobweb small', placement: 'corner', walkable: false, tags: ['generic','crypt','stone','water'] },
  { col: 30, row: 2, name: 'cobweb',       placement: 'corner', walkable: false, tags: ['generic','crypt','stone','ice'] },
  { col: 32, row: 2, name: 'cobweb 3',     placement: 'corner', walkable: false, tags: ['generic','crypt','stone'] },
  { col: 33, row: 2, name: 'cobweb full',  placement: 'corner', walkable: false, tags: ['crypt','stone'] }, // heavy only
  // wall — torches (animated in Build 2)
  { col: 41, row: 2, name: 'wall torch',   placement: 'wall', walkable: false, tags: ['fire','crypt','stone','treasure','blood'], animB: { col: 42, row: 2 } },
  // floor — crypt / bones
  { col: 29, row: 1, name: 'gravestone',       placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 30, row: 1, name: 'broken tombstone', placement: 'floor', walkable: false, tags: ['crypt','bones','stone'] },
  { col: 32, row: 1, name: 'crossed bones',    placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 34, row: 1, name: 'scattered bones',  placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 36, row: 1, name: 'skull pile',       placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 38, row: 1, name: 'skeleton',         placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 41, row: 9, name: 'skull',            placement: 'floor', walkable: false, tags: ['crypt','bones'], animB: { col: 41, row: 10 } },
  // floor — fire / forge (animated)
  { col: 39, row: 1, name: 'flame',    placement: 'floor', walkable: false, tags: ['fire'], animB: { col: 40, row: 1 } },
  { col: 41, row: 1, name: 'brazier',  placement: 'floor', walkable: false, tags: ['fire','treasure'], animB: { col: 42, row: 1 } },
  { col: 31, row: 6, name: 'cauldron', placement: 'floor', walkable: false, tags: ['fire','poison'], animB: { col: 32, row: 6 } },
  // floor — arcane (tomes, animated)
  { col: 38, row: 9, name: 'grey tome',  placement: 'floor', walkable: false, tags: ['arcane','crypt'], animB: { col: 38, row: 10 } },
  { col: 39, row: 9, name: 'blue tome',  placement: 'floor', walkable: false, tags: ['arcane','water'], animB: { col: 39, row: 10 } },
  { col: 40, row: 9, name: 'green tome', placement: 'floor', walkable: false, tags: ['arcane','nature','poison'], animB: { col: 40, row: 10 } },
  // floor — treasure
  { col: 32, row: 4, name: 'chest',       placement: 'floor', walkable: false, tags: ['treasure'] },
  { col: 33, row: 4, name: 'gold chest',  placement: 'floor', walkable: false, tags: ['treasure'] },
  { col: 36, row: 4, name: 'gold idol',   placement: 'floor', walkable: false, tags: ['treasure','stone'] },
  { col: 36, row: 5, name: 'throne',      placement: 'floor', walkable: false, tags: ['treasure'] },
  // floor — generic props
  { col: 39, row: 4, name: 'barrel',      placement: 'floor', walkable: false, tags: ['generic','stone','sand','fire'] },
  { col: 40, row: 4, name: 'barrel open', placement: 'floor', walkable: false, tags: ['generic','stone','water'] },
  { col: 29, row: 5, name: 'crate',       placement: 'floor', walkable: false, tags: ['generic','stone'] },
  { col: 41, row: 5, name: 'wood crate',  placement: 'floor', walkable: false, tags: ['generic','sand'] },
  { col: 37, row: 6, name: 'stone urn',   placement: 'floor', walkable: false, tags: ['generic','stone','crypt'] },
  { col: 39, row: 6, name: 'stone pot',   placement: 'floor', walkable: false, tags: ['generic','stone'] },
  { col: 42, row: 6, name: 'broken pot',  placement: 'floor', walkable: false, tags: ['generic','stone','crypt'] },
  // floor — colored urns
  { col: 37, row: 7, name: 'blue urn',  placement: 'floor', walkable: false, tags: ['water','ice'] },
  { col: 40, row: 7, name: 'green urn', placement: 'floor', walkable: false, tags: ['poison','nature'] },
  { col: 37, row: 8, name: 'red urn',   placement: 'floor', walkable: false, tags: ['blood','fire'] },
  { col: 40, row: 8, name: 'clay pot',  placement: 'floor', walkable: false, tags: ['sand','generic'] },
  // floor — rubble / rock
  { col: 31, row: 1, name: 'rubble',       placement: 'floor', walkable: false, tags: ['stone','sand','generic'] },
  { col: 34, row: 6, name: 'rocks',        placement: 'floor', walkable: false, tags: ['stone','sand','ice','generic'] },
  { col: 33, row: 7, name: 'cracked rock', placement: 'floor', walkable: false, tags: ['stone','sand'] },
  // floor — blood / poison
  { col: 35, row: 2, name: 'blood splat',  placement: 'floor', walkable: false, tags: ['blood'] },
  { col: 36, row: 2, name: 'blood specks', placement: 'floor', walkable: false, tags: ['blood'] },
  { col: 38, row: 2, name: 'slime splat',  placement: 'floor', walkable: false, tags: ['poison','nature'] },
  { col: 39, row: 2, name: 'green slime',  placement: 'floor', walkable: false, tags: ['poison','water'] },
  // floor — water
  { col: 29, row: 8, name: 'fountain', placement: 'floor', walkable: false, tags: ['water'] },
  { col: 30, row: 8, name: 'well',     placement: 'floor', walkable: false, tags: ['water','stone'] },
  // floor — nature
  { col: 44, row: 1, name: 'bush',         placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 45, row: 1, name: 'bush b',       placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 52, row: 3, name: 'round bush',   placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 44, row: 2, name: 'flowers',      placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 46, row: 2, name: 'flowers b',    placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 50, row: 3, name: 'cactus',       placement: 'floor', walkable: false, tags: ['nature','sand'] },
  { col: 54, row: 2, name: 'red mushroom', placement: 'floor', walkable: false, tags: ['nature','poison'] },
  { col: 52, row: 2, name: 'blue mushroom',placement: 'floor', walkable: false, tags: ['nature','water'] },
  { col: 45, row: 3, name: 'brown rock',   placement: 'floor', walkable: false, tags: ['nature','stone','sand'] },
  { col: 46, row: 3, name: 'grey rock',    placement: 'floor', walkable: false, tags: ['nature','stone','ice'] },
  { col: 49, row: 4, name: 'small pine',   placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 45, row: 8, name: 'small tree',   placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 50, row: 4, name: 'snowy pine',   placement: 'floor', walkable: false, tags: ['ice'] },
];

export const DUNGEON_DECOR: Record<string, DecorTag[]> = {
  'Greystone Keep':    ['stone','generic','crypt'],
  'Crimson Court':     ['blood','treasure','stone','fire'],
  'Mossmarch Hold':    ['nature','water','stone'],
  'Emberforge':        ['fire','stone','treasure'],
  'Oakenvault':        ['generic','treasure','stone','nature','arcane'],
  'Verdant Crypt':     ['crypt','bones','nature','poison'],
  'Tideglass Halls':   ['water','ice','generic'],
  'Frostiron Bastion': ['ice','stone','generic'],
  'Auric Deep':        ['treasure','fire','stone'],
  'Rustpipe Sewers':   ['water','poison','generic'],
  'Drowned Foundry':   ['water','fire','stone','generic'],
  'Duskstone Warren':  ['stone','crypt','generic','arcane'],
  'Thornwind Ruins':   ['nature','stone','crypt'],
  'Cinderdeep':        ['fire','stone','blood'],
  'Wildroot Barrow':   ['nature','crypt','bones'],
  'Ossuary Pale':      ['crypt','bones','stone','arcane'],
  'Glacierhold':       ['ice','stone','water'],
  'Bogstone Mire':     ['poison','water','nature','crypt'],
  'Dunewatch':         ['sand','stone','crypt','treasure'],
  'Cobblemoor':        ['stone','nature','generic'],
  'Bloodstone Cairn':  ['blood','crypt','bones','fire'],
};

// Dungeons that get more cobwebs (old / abandoned / crypt).
export const COBWEB_HEAVY = new Set(['Ossuary Pale','Duskstone Warren','Verdant Crypt','Bogstone Mire','Greystone Keep']);

const FALLBACK_DECOR: DecorTag[] = ['generic','stone'];

export interface DecorPool { floor: DecorTile[]; corner: DecorTile[]; wall: DecorTile[]; }

/** Decor tiles for a dungeon, split by placement. `corner` excludes 'heavy-only' full webs
 *  unless the dungeon is cobweb-heavy. */
export function decorFor(dungeonName: string): DecorPool {
  const tags = new Set(DUNGEON_DECOR[dungeonName] ?? FALLBACK_DECOR);
  const heavy = COBWEB_HEAVY.has(dungeonName);
  const match = (t: DecorTile) => t.tags.some((tag) => tags.has(tag));
  return {
    floor: DECOR_TILES.filter((t) => t.placement === 'floor' && match(t)),
    corner: DECOR_TILES.filter((t) => t.placement === 'corner' && match(t) && (heavy || t.name !== 'cobweb full')),
    wall: DECOR_TILES.filter((t) => t.placement === 'wall' && match(t)),
  };
}
```

Full-web tiles (`cobweb full`, 33,2) are only offered to cobweb-heavy dungeons.

## Component 2 — `src/domain/dungeon2.ts`

`AutoDungeon.decor` entries become `{ x, y, col, row, walkable: boolean }`. Replace
the current decor block with placement-aware logic driven by `decorFor(dungeonName)`,
all using the seeded `rng`:

1. **Corners** — for the four interior corner cells `(1,1)`, `(w-2,1)`, `(1,h-2)`,
   `(w-2,h-2)`: place a random corner tile with probability `COBWEB_HEAVY.has(name)
   ? 0.85 : 0.5` (when the corner pool is non-empty).
2. **Wall torches** — eligible wall cells = border walls that are not corners and
   not doors; shuffle, place a torch on ~1 in 5 (cap 6) when the wall pool is non-empty.
3. **Floor scatter** — interior floor cells minus the fixed 2×2 monster zone
   (`mx=floor(w/2)-1, my=floor(h/2)-1`, cells `mx..mx+1 × my..my+1`) minus the
   corner cells already used; shuffle, place `4 + floor(rng()*5)` floor tiles.

Every emitted cell carries `walkable` from its `DecorTile`. `Dungeon.decor` is no
longer read.

## Component 3 — `src/domain/tvlayout.ts`

Hero slots must not land on non-walkable decor. When building the hero-slot
candidate list (interior floor minus monster zone), also exclude any cell that has
a non-walkable decor entry (`auto.decor.filter((d) => !d.walkable)`). Corner/wall
decor cells are excluded too (corners are interior floor; walls aren't candidates).

## Component 4 — Floor richness (#7 + #14)

- `ACCENT_RATE` 0.06 → **0.11** (floorgroups.ts); `GLOW_RATE` unchanged.
- Add 1–2 same-family accents to flat single-main groups (`floor_groups.json`).
- **#14:** demote `cinder_rock`'s high-contrast 2nd main → sparse accent; drop or
  crimson-restrict `crimson_mosaic` (`floor_compatibility.json`); tighten the most
  over-generous `good`-tier lists. Exact JSON values finalized in the plan against
  live floordata + the visual pass.

## Component 5 — `src/domain/floorgroups.ts` cleanup

Remove the vestigial `decor: TileCoord[]` from `Dungeon` and its `decor: []`
initializer (dungeon2 now sources decor from `decor.ts`). Confirm nothing else
reads `Dungeon.decor`.

## Testing

**`tests/decor.test.ts`** — every `DECOR_TILES` entry has integer col/row in-sheet,
≥1 tag, a boolean `walkable`, and (if animated) an in-sheet `animB`. For every
dungeon in `DUNGEONS`, `decorFor(d.name).floor` is non-empty; `decorFor` only
returns tag-matching tiles; unknown name falls back without throwing; cobweb-heavy
dungeons may get the `cobweb full` tile, others never do.

**`tests/dungeon2.test.ts`** (extend) — generated `decor` is non-empty; no decor
cell in the 2×2 monster zone; corner decor cells sit at interior corners and use
`corner` tiles; every decor cell carries a boolean `walkable`; deterministic per
`(name, seed)`.

**`tests/tvlayout.test.ts`** (extend) — no hero slot coincides with a non-walkable
decor cell.

**Floors** — keep floorgroups/dungeon2 tests green after the `ACCENT_RATE` change;
update any exact-frequency assertion.

Full suite + `tsc --noEmit` stay green (baseline 228). Final check is a **controller
visual pass**: render a spread of themed dungeons (crypt, forge, nature, ice, sewer,
desert, blood) via headless screenshots — confirm cobwebs in corners, torches on
walls, themed floor props, no hero standing on a prop, richer floors.

## Risks / notes

- **Animated items render static (frame A) in Build 1** — they still read well
  (a lit torch, a cauldron, a skull); Build 2 adds the flicker.
- **Occlusion**: monster/heroes draw over baked decor; floor scatter avoids the
  monster zone and hero slots avoid decor, so props aren't hidden or stood-on.
- **Torch/cobweb transparency** verified against the sheet crops — they composite
  cleanly onto wall/floor (decor drawn after walls in `buildBackground`).
- **Density** (~2–4 corners + ≤6 torches + ~4–8 floor props) and `ACCENT_RATE` are
  starting points to confirm on the visual pass.

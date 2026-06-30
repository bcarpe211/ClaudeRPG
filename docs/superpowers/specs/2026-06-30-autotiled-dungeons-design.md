# ClaudeRPG — Sheet-Driven Autotiled Dungeons Design Spec

**Date:** 2026-06-30
**Status:** Approved for planning
**Author:** Bryan Carpenter (with Claude)

## 1. Overview

This is **sub-project 1 of 3** in the larger "theme-driven endless dungeons"
vision (1: dungeon theme catalog → 2: bestiary categorization → 3: themed
encounter + difficulty-arc engine). Its scope is **B**: prove we can generate
**cohesive, themed dungeon layouts** by decoding the oryx world tile sheet's
structure and autotiling from it.

**Decoded findings (verified during brainstorming):** `oryx_16bit_fantasy_world_trans.png`
is **1366×1007**, a clean **24px tile grid from origin (0,0)** (gridline overlays
land exactly on tile boundaries). It is laid out in uniform, per-skin blocks:

- **Wall skins** = horizontal bands (grey stone, brown, red, teal, blue,
  yellow-lit, vine-green, …). Within a band, columns hold consistent roles:
  solid-block variants on the left, pseudo-3D **wall-front pieces**
  (left-cap / middle / right-cap / inner-corner) on the right.
- **Floor skins** = a **2-row blob/autotile block** each (green, yellow, olive,
  orange, brown, white, tan, …), with a consistent mask→offset layout (full /
  edges / outer + inner corners / peninsulas / isolated). The open grass/dirt
  floors at the bottom are "open-world" floors.
- **Shared sets**: decor/nature props (top-right) and doors / summoning circles /
  pipes / fences / water (bottom-left).

So a skin is expressible as **one base offset + a shared template**, for both
walls and floors — exactly the scaling property we want. The **Sliced**
`world_24x24` numbering has ~408 gaps (blank cells skipped), so we address tiles
from the **full sheet by pixel**, not by Sliced index.

### Goals

- Decode the sheet's tile grammar once (wall template, floor blob template, skin
  base offsets, shared decor/doors) into a small data model.
- A pure **autotiler** that turns a logical dungeon grid into cohesive tiles
  (correct floor edges/corners, assembled wall fronts) by neighbor masks.
- Render world tiles from the full sheet via 24×24 **sub-rects**, nearest-neighbor.
- Prove it end-to-end: a dev-only preview that renders cohesive dungeons for
  **2–3 mockup skins** (e.g. crypt + cave) across seeds.

### Non-goals (this sub-project)

- **No changes to the live `/tv` game renderer** yet. We build the new pipeline
  alongside the existing one (which keeps working) and prove it in a dev preview;
  swapping the live renderer is a follow-on.
- **No monster/theme logic.** Which creatures appear in which dungeon (bestiary
  categorization) and the difficulty arc are sub-projects 2 and 3.
- **Not all ~13 skins, not open-world floors** — those are cheap data once the
  grammar + autotiler are proven.
- The existing `/catalog` is unchanged (it remains a Sliced-tile reference).

## 2. Decoded sheet structure (authoritative facts)

- Sheet file: `<spritesDir>/../oryx_16bit_fantasy_world_trans.png`, 1366×1007.
- Tile pitch **24px**, origin **(0,0)**; a tile is addressed by `(col,row)` →
  pixel rect `(col*24, row*24, 24, 24)`.
- Wall bands occupy the upper-left; floor blob blocks occupy the lower-right;
  decor top-right; doors/specials lower-left. (Exact base offsets per skin and
  the precise column/mask layouts are produced by the decode task and recorded
  in `tilesheet.ts`; the brainstorming crops confirmed the *shape*, the decode
  task pins the *coordinates*.)

## 3. Architecture & components

Built as a **new, parallel pipeline** that does not disturb the live game.

### 3.1 `src/domain/tilesheet.ts` — the decoded grammar (data)

- `SHEET = { url: '/sheet/world.png', tile: 24 }`.
- `FLOOR_BLOB: Record<number, {dc:number, dr:number}>` — neighbor-mask →
  offset within a floor skin's 2-row block (covers full, 4 edges, 4 outer
  corners, inner corners, peninsulas, isolated).
- `WALL_TEMPLATE` — the column roles within a wall band: `solid` variants and
  the front pieces (`leftCap`, `mid`, `rightCap`, `innerCorner`, …) as offsets.
- `SKINS: Skin[]` where `Skin = { name, wallBase:{col,row}, floorBase:{col,row},
  door:{col,row}, decor:{col,row}[] }`. Adding a skin = adding a base offset.
- Pure helper `tileRect(coord)` → `{sx,sy,sw,sh}` for the renderer.

The blob/wall templates are decoded **once**; skins are data.

### 3.2 `src/domain/autotile.ts` — pure autotiler

- `floorMask(grid, x, y)` → bitmask of which neighbors are also floor
  (8-neighbour for corners).
- `resolveFloor(mask)` → `FLOOR_BLOB` offset. `resolveWall(grid, x, y)` →
  the wall-front piece offset for that wall cell's context.
- Pure functions over a logical grid; no rendering, no I/O — fully unit-testable.

### 3.3 `src/domain/dungeon2.ts` — sheet-driven generator

A new generator (leaving `dungeon.ts` intact) that is deterministic
(`generateAutotiledDungeon(skin, seed)` using the existing mulberry32 RNG):
produces a logical cell grid (wall / floor / door / decor + room shape), then
runs the autotiler to emit render cells, each carrying its final sheet
`(col,row)`. Reuses the existing room/decor logic where sensible.

### 3.4 `src/web/routes/dungeon-preview.ts` — the proof surface (dev-only)

- Gated behind a new `config.enableDungeonPreview` (env `ENABLE_DUNGEON_PREVIEW`),
  mirroring the catalog flag; off by default, never on the kiosk.
- `GET /dungeon-preview` renders a page that draws several generated dungeons
  (chosen skins × seeds) to canvases, pulling tiles from `/sheet/world.png` via
  sub-rects with `imageSmoothingEnabled=false`, at an integer upscale.
- `app.ts` serves the sheet at **`/sheet/world.png`** (static, from
  `<spritesDir>/../oryx_16bit_fantasy_world_trans.png`).

### 3.5 Rendering model

Canvas draws each cell with
`drawImage(sheet, col*24, row*24, 24, 24, dx, dy, 24*s, 24*s)`,
`imageSmoothingEnabled=false`, integer scale `s` — pixel-perfect, no atlas
bleed (verified: identical pixels to the Sliced tiles, nearest-neighbor).

## 4. Data flow

`generateAutotiledDungeon(skin, seed)` → logical grid → `autotile` resolves each
cell → render cells `{x, y, col, row}` → preview canvas draws sub-rects from
`/sheet/world.png`. All deterministic given `(skin, seed)`.

## 5. Validation-first (de-risking)

The grid + uniform bands are confirmed, but exact offsets/masks are not yet
pinned. The **first implementation task is the decode**: extract the wall
template + one floor skin's blob layout + 2–3 skin base offsets, and render a
single room with correct floor edges/corners and a skinned wall border. Only
after that visually checks out do we generalize the autotiler and add skins.

## 6. Testing

- `autotile.ts`: pure unit tests — `floorMask` for representative neighbourhoods
  (open field, edges, the four outer corners, an inner corner, a 1-wide corridor,
  isolated cell) → expected `FLOOR_BLOB` offsets; wall-front selection for a
  horizontal run (left-cap/mid/right-cap) and corners.
- `tilesheet.ts`: assert `tileRect` math and that every `FLOOR_BLOB` mask maps to
  an in-bounds offset; every skin's bases are within the sheet grid.
- `dungeon2.ts`: determinism (same `(skin,seed)` → identical grid), border
  integrity (room enclosed by walls), and that every emitted cell has a resolved
  `(col,row)`.
- Preview route gating test (404 when the flag is off; 200 when on).
- Visual acceptance: open `/dungeon-preview`, confirm cohesive corners/edges and
  correct skinning across seeds for the proof skins.

## 7. Out of scope / follow-on

- **Live `/tv` integration** — swap the in-game dungeon background to the new
  sheet-driven pipeline (replaces `tilemanifest.ts` + `dungeon.ts` rendering).
- **All ~13 skins + open-world floors** — data, once proven.
- **Sub-project 2** (bestiary: creature → {themes, difficulty}) and
  **sub-project 3** (themed encounter + difficulty-arc engine, replacing
  `MONSTER_TIERS`/`BOSSES`).

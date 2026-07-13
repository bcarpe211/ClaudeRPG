# Animated Decor (Build 2) — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending spec review
**Backlog:** #6 Build 2 (also unblocks the decor half of #13)

Build 2 of the staged decor effort. Build 1 shipped static themed decor and
**captured each animated tile's `animB` frame** in `decor.ts`. This build makes
the flagged items flicker: torches, floor flame, cauldron, tomes, and the skull.

## Goal

Animate the world-sheet decor tiles that have a second frame — draw them live
(flipping frame A ↔ `animB` on the shared staggered clock) instead of baking a
static frame, so torches flicker, cauldrons bubble, tomes/skull pulse.

## Background

- `decor.ts` `DECOR_TILES` already carry `animB?: {col,row}` for the animated
  tiles (wall torch 41,2↔42,2; standing torch 41,1↔42,1; flame 39,1↔40,1;
  cauldron 31,6↔32,6; tomes 38/39/40,9↔row10; skull 41,9↔41,10). See
  `docs/oryx_decor_reference.md`.
- `dungeon2.ts` emits `AutoDungeon.decor: {x,y,col,row,walkable}[]` — it currently
  **drops `animB`** at the `place`/`push`.
- `tvlayout.ts` maps decor to `{x,y,col,row}` for the render payload.
- `tv.js` `buildBackground` **bakes every decor cell** into the static panel
  canvas (`layout.decor` loop). The `#13` sprite animation already provides the
  shared clock: `ANIM_MS = 600` and the `Math.floor((t+phase)/ANIM_MS)%2` flip,
  with a per-item `phase` so things don't flip in unison.

## Design decisions (confirmed in brainstorming)

1. **Thread `animB`** from `DecorTile` → `AutoDungeon.decor` → the TV layout payload.
2. **Split rendering**: `buildBackground` bakes only decor **without** `animB`;
   a new `drawAnimDecor(t)` draws the animated decor live each frame.
3. **Layer**: animated decor draws above the floor/static-decor and **below** the
   monster/heroes (between the baked panel and `drawMonster`), with the panel
   drop-shadow reset off.
4. **Timing**: reuse the shared `ANIM_MS` (~600ms) staggered clock; `phase` keyed
   per decor cell so torches flicker independently. One period for all animated
   decor (tunable later).

No new mechanics; deterministic data path (no `Date.now`/`Math.random` in domain).

## Architecture

| File | Change |
|------|--------|
| `src/domain/dungeon2.ts` | `AutoDungeon.decor` entries carry `animB?: {col,row}`; `place`/`push` thread it from the `DecorTile`. |
| `src/web/tvlayout.ts` | `TvLayoutCell` decor gains `animB?`; the passthrough map includes it. |
| `src/web/public/tv/tv.js` | `buildBackground` bakes only non-`animB` decor; new `drawAnimDecor(t)` renders animated decor live. |
| `tests/dungeon2.test.ts`, `tests/tvlayout.test.ts` | Extend: `animB` is threaded and in-sheet. |

## Component 1 — `src/domain/dungeon2.ts`

`AutoDungeon.decor` type → `{ x; y; col; row; walkable: boolean; animB?: { col: number; row: number } }[]`.
The `place` helper's tile param widens to include `animB?`, and the push includes it:
```ts
const place = (x: number, y: number, t: { col: number; row: number; walkable: boolean; animB?: { col: number; row: number } }) => {
  decor.push({ x, y, col: t.col, row: t.row, walkable: t.walkable, animB: t.animB }); used.add(`${x},${y}`);
};
```
`at2(pools.floor|corner|wall)` returns a `DecorTile` (which already has `animB?`), so no other change — the frame data flows through.

## Component 2 — `src/web/tvlayout.ts`

`TvLayout.decor` element type gains `animB?: { col: number; row: number }`. The map
(currently `{ x, y, col, row }`) becomes:
```ts
const decor = auto.decor.map((p) => ({ x: p.x, y: p.y, col: p.col, row: p.row, animB: p.animB }));
```
`walkable` stays stripped (hero exclusion already used it). `animB` is `undefined`
for static tiles — JSON drops it from the wire, so static decor payload is unchanged.

## Component 3 — `src/web/public/tv/tv.js`

- **`buildBackground`** — bake only static decor. Change the decor loop:
  ```js
  for (const d of layout.decor) if (!d.animB) put(d.col, d.row, d.x, d.y);
  ```
- **`drawAnimDecor(t)`** (new) — draw animated decor live, flipping A↔B:
  ```js
  function drawAnimDecor(t) {
    if (!layout) return;
    const sheet = img('/sheet/world.png');
    for (let i = 0; i < layout.decor.length; i++) {
      const d = layout.decor[i];
      if (!d.animB) continue;
      const phase = (i * 137 + 53) % ANIM_MS;         // stagger so torches flicker independently
      const showB = Math.floor((t + phase) / ANIM_MS) % 2 === 1;
      const col = showB ? d.animB.col : d.col;
      const row = showB ? d.animB.row : d.row;
      ctx.drawImage(sheet, col * TILE, row * TILE, TILE, TILE,
        panelX + d.x * tilePx, panelY + d.y * tilePx, tilePx, tilePx);
    }
  }
  ```
- **`render(t)`** — call `drawAnimDecor(t)` right after the baked bg-panel draw
  (after the `if (bg) { ... }` block, before `if (state) {...}`), so it layers above
  the floor/static-decor and below the actors. The panel's `ctx.shadow*` is already
  restored by then, so animated decor draws with no drop shadow.

## Testing

**`tests/dungeon2.test.ts`** (extend) — for a dungeon whose decor includes animated
tiles (e.g. `Ossuary Pale` / `Bloodstone Cairn` — wall torches + skull), a generated
dungeon has at least one decor cell with `animB`, and every `animB` is an in-sheet
coord. Static-only cells have `animB` undefined. Deterministic per `(name, seed)`.

**`tests/tvlayout.test.ts`** (extend) — the layout's decor cells preserve `animB`
from the generated dungeon (an animated cell in `auto.decor` appears with `animB` in
`L.decor`).

**No unit test for `tv.js`** (canvas). Controller verifies via headless-Chrome
screenshots at two clock phases (~budget 2000ms vs 2600ms, per the #13 method) that
a torch/cauldron renders on **different frames** between the two — proving the flip.

Full suite + `tsc --noEmit` stay green (baseline 237).

## Risks / notes

- **No double-draw**: animated tiles are excluded from the bake and drawn only live,
  so each animated cell renders once per frame.
- **Wall torches**: previously baked over the wall; now drawn live over the same
  wall cell (the panel bg shows the plain wall). Same look, now flickering.
- **Perf**: a handful of animated cells per room (≤6 torches + a few floor items),
  drawn with one `drawImage` each per frame — negligible.
- **Period** (`ANIM_MS` 600ms) is shared with the sprite animation; if fire wants a
  snappier flicker, a decor-specific constant can be added later (tunable).

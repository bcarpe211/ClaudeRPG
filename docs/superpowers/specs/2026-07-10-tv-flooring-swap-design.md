# Live `/tv` → dungeon2 Flooring Swap — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorming), pending spec review
**Depends on:** the modular flooring system (merged 2026-07-10; `src/domain/dungeon2.ts` + `floorgroups.ts`)
**Prior specs:** `docs/superpowers/specs/2026-07-10-modular-flooring-design.md`

---

## 1. Problem & goal

The modular flooring system (38 floor groups, 22 dungeon themes, sheet-driven autotiled
walls) is built but **preview-only** — it renders at the gated `/dungeon-preview` route. The
live TV (`/tv`) still runs the old `dungeon.ts` + `tilemanifest.ts` pipeline: 3 hard-coded
themes (`stone_crypt`/`cave`/`wood_fort`), per-cell individual sprite PNGs, curated tile
manifest.

**Goal:** make the modular flooring player-facing — swap the live `/tv` dungeon background
to `dungeon2`, rotating all 22 themes with a curated per-theme spawn weight, without
regressing heroes / monsters / HP bars / leaderboard / defeat popup (all of which are
separate render layers keyed off `buildTvState`).

## 2. What we verified (grounding)

- **`theme` is purely cosmetic.** Nothing in gameplay reads `dungeons.theme` — it only drives
  rendering. So expanding the engine's theme set is safe (no monster/difficulty impact; that's
  the separate, unbuilt theme-driven-dungeons epic).
- **`/sheet/world.png` is served unconditionally** (`src/web/app.ts:51`, outside the
  `enableDungeonPreview` guard) — live `/tv` can already load the sheet.
- **tv.js tolerates a null layout** (`buildBackground` early-returns on `!layout`) — so the
  only live-swap crash risk is the *server-side* adapter throwing; the client degrades to "no
  background" gracefully.
- **Seeds are large random ints** (`Math.floor(rng()*2e9)` in `encounters.ts:newDungeon`) —
  `dungeon2`'s `scrambleSeed` handles them; no seed-space change needed.
- **The gap:** `dungeon2` emits `cells[]` (flat, sheet coords) + `decor[]`, but **not** the
  2×2 monster zone or the ≤24 hero slots that `buildTvLayout` (`tvview.ts:19`) and
  `buildTvState` (`tvview.ts:117`) both consume via `currentLayout`.

## 3. Scope decisions (locked)

- **Rotation: all 22 themes, flat quality weighting.** The engine does a weighted pick over
  the 22 dungeon names; a curated `THEME_WEIGHTS` table makes clean themes common and
  loud/novelty ones rare. Weighting is on the **wall theme** (the floor is chosen downstream by
  the compat map). No level/depth tie.
- **Weights are code data, not admin settings** (22 values would bloat the settings UI). Seed
  with sensible defaults from the roster render; tune on the real 4K TV.
- **Palette (floor) tuning is a follow-on, not in this plan** — do the swap first, judge floors
  live, then tune the vendored JSON (backlog #14).
- **Decor is dropped for now** — `dungeon2` doesn't emit decor yet (every `Dungeon.decor` is
  `[]`), so the live TV loses the old per-theme decor sprites. Accepted tradeoff; adding decor
  to `dungeon2` is a follow-on (backlog #6). The layout payload keeps a `decor` field (empty)
  so the renderer path stays ready.
- **`dungeon.ts` and `tilemanifest.ts` are NOT retired.** `dungeon2` imports `makeRng` from
  `dungeon.ts`; the catalog imports `tilemanifest`. `generateDungeon`/`currentLayout` merely go
  unused on the `/tv` read path. Deleting them is a separate YAGNI cleanup.

## 4. Architecture

### 4a. Engine theme selection (`src/domain/encounters.ts`)
Replace `const THEMES = ['stone_crypt','cave','wood_fort']` and the uniform
`THEMES[Math.floor(rng()*THEMES.length)]` pick in `newDungeon` with a weighted draw over the
22 dungeon names:

```ts
// name -> spawn weight; unlisted names default to BASE. Curated from the roster render;
// down-weight the visually loud / novelty wall themes. Tune on the real TV.
const THEME_WEIGHTS: Record<string, number> = {
  'Auric Deep': 3,      // bright gold walls — a rare treat
  'Crimson Court': 5,   // stark heraldic checker
  // all other 20 dungeon names default to BASE (10)
};
```

Build a weighted pool from `DUNGEONS` (imported from `floorgroups`) so the names are always
valid and every dungeon is eligible, then `pickWeighted(pool, rng).name` (reuse the existing
`pickWeighted` from `tilesheet`). Store the chosen name in `dungeons.theme` (string; no schema
change). `newDungeon` stays deterministic (injected `rng`).

### 4b. TV layout adapter (`src/web/tvlayout.ts`, new)
Owns the new payload types and the single source both TV builders consume:

```ts
export interface TvLayoutCell { type: 'wall'|'floor'|'door'; col: number; row: number; under?: { col: number; row: number }; }
export interface TvLayout {
  dungeonId: number; theme: string; width: number; height: number;
  cells: TvLayoutCell[][];            // [y][x]
  doors: { x: number; y: number }[];
  monster: { x: number; y: number; footprint: number };
  heroSlots: { x: number; y: number }[];
  decor: { x: number; y: number; col: number; row: number }[];
}
export function currentTvLayout(db: Database.Database): TvLayout | null;
```

`currentTvLayout(db)`:
1. Read `game_state.current_dungeon_id`; if none → `null`.
2. Read the dungeon's `theme` + `seed`. **If `getDungeon(theme)` is undefined** (legacy/in-flight
   row like `stone_crypt`) → fall back to a default name (`Greystone Keep`) so `/tv` never
   500s. (No data migration needed — a fresh dungeon with a real name spawns within a few
   kills.)
3. `const auto = generateAutotiledDungeon(name, seed)` → cells + decor.
4. Convert `auto.cells` (flat) → `cells[y][x]` of `{type: kind, col, row, under}` and collect
   `doors` (cells with `kind==='door'`).
5. Compute the **2×2 monster zone** (fixed center: `{x: floor(w/2)-1, y: floor(h/2)-1,
   footprint: 2}`) and the **hero slots**: shuffle interior floor cells (exclude border, doors,
   monster zone) with an independent `makeRng(seed)` and take ≤24 — logic ported from
   `dungeon.ts:90-115`. (`dungeon2` doesn't expose its internal rng, so the adapter uses its
   own deterministic stream.)
6. `decor`: pass through `auto.decor` (empty today).

`tvview.ts` changes: `buildTvLayout` returns `currentTvLayout(db)` directly (drop the
`currentLayout`/`worldSpriteUrl` mapping); `buildTvState` swaps its `currentLayout(db)` call
(`tvview.ts:117`) for `currentTvLayout(db)` to read `heroSlots`. No other `buildTvState` logic
changes.

### 4c. Payload shape
The SSE `layout` event now carries `TvLayoutCell` with `{type,col,row,under?}` instead of
`{type,url}`, and decor as `{x,y,col,row}`. Everything else in the payload is unchanged.

### 4d. Renderer (`src/web/public/tv/tv.js`)
- Load the sheet once: `const sheet = img('/sheet/world.png')`.
- `buildBackground()` draws each cell from the sheet: for a cell, if `under` is set draw
  `under` first (door transparency), then draw the cell:
  `b.drawImage(sheet, c.col*24, c.row*24, 24, 24, x*tilePx, y*tilePx, tilePx, tilePx)`; then
  decor the same way. Replaces the per-cell `img(url)` loop (`tv.js:54-58`) and the pre-load
  loop (`tv.js:62-63`).
- **Sheet load timing:** `buildBackground` must run/rerun after the sheet image loads
  (`sheet.onload = buildBackground`), since drawing from an unloaded image yields blanks. The
  layout/resize handlers also call `buildBackground`; guard so it no-ops until both `layout`
  and a loaded `sheet` exist.
- Heroes (`tv.js:87`), background blit (`:99`), monster (`:116`), leaderboard (`:174`), defeat
  (`:202`) layers are unchanged — they use separate sprite URLs, not the sheet.

## 5. Data flow

```
engine newDungeon ──▶ pickWeighted(THEME_WEIGHTS over 22 names) ──▶ dungeons.theme = <name>
/tv builders ──▶ currentTvLayout(db) ──▶ getDungeon(theme)||fallback
                                     ──▶ generateAutotiledDungeon(name, seed) ──▶ cells/decor
                                     ──▶ + monster zone + heroSlots (own makeRng(seed))
SSE 'layout' {cells:{type,col,row,under}} ──▶ tv.js buildBackground draws sheet sub-rects
```

## 6. Testing

- **engine:** `newDungeon` stores one of the 22 valid dungeon names; the weighted draw is
  deterministic for a fixed rng; a down-weighted theme appears less often than a baseline one
  over N draws (statistical); every stored name resolves via `getDungeon`.
- **adapter:** `currentTvLayout` returns null with no active dungeon; for an active dungeon it
  returns `width*height` cells as `[y][x]`, a fixed 2×2 center monster zone, ≤24 hero slots all
  on interior floor and none inside the monster zone or on a door; door cells carry `under`;
  deterministic for a fixed `(theme, seed)`. **Legacy fallback:** an active dungeon whose
  `theme` is an unknown/old value (e.g. `stone_crypt`) still returns a valid layout (falls back
  to the default name) rather than throwing.
- **view models:** `buildTvLayout` returns the new cell shape (`col`/`row`, no `url`);
  `buildTvState` still assigns hero `x/y` from the adapter's `heroSlots`.
- **route/integration:** `GET /tv` 200s and the SSE stream emits a `layout` with the new shape
  (existing `/tv` tests stay green).
- Keep green: `npm run typecheck` + `npx vitest run`.

## 7. Verification (manual, on the TV)

Load `/tv` against a DB with an active dungeon; confirm the sheet-drawn background renders
(walls + floor + doors), heroes land on interior floor, the monster sits in the 2×2 zone, and
the leaderboard/HP/defeat layers are unaffected. Then judge floor palettes for the follow-on
tuning pass.

## 8. Out of scope (follow-ons)

- **Floor palette tuning** (backlog #14) — data-only edits to the vendored JSON, done after,
  judged on the real TV.
- **Dungeon decor** in `dungeon2` (backlog #6) — the swap drops the old decor; re-adding it is
  separate.
- **Retiring `dungeon.ts`/`tilemanifest.ts`** — still imported elsewhere; a later cleanup.
- **Theme-driven monsters/difficulty** — the broader epic; unaffected here (theme stays
  cosmetic).

## 9. Risks

- **Legacy-theme crash** — mitigated by the adapter's `getDungeon` fallback (§4b step 2). The
  one must-not-skip guard for a live swap.
- **Blank background from sheet-load race** — mitigated by `sheet.onload = buildBackground` +
  the both-ready guard (§4d).
- **Decor regression** — accepted, documented; dungeons render clean without decor.
- **Weights feel off on the real TV** — expected; they're a one-line data table, tuned live.

# Live `/tv` → dungeon2 Flooring Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the modular flooring player-facing — swap the live `/tv` dungeon background from the old `dungeon.ts`+`tilemanifest.ts` per-cell-sprite pipeline to sheet-driven `dungeon2`, rotating all 22 themes with a curated per-theme spawn weight, without regressing heroes/monsters/HP/leaderboard/defeat.

**Architecture:** A new `src/web/tvlayout.ts` adapter (`currentTvLayout`) calls `dungeon2` for cells and reproduces the 2×2 monster zone + ≤24 hero slots the TV builders need, falling back to a default dungeon name on any unknown/legacy theme. `tvview.ts`'s two builders consume it; `tv.js`'s `buildBackground` draws sheet sub-rects instead of per-cell URLs; the engine picks themes by weighted draw over the 22 dungeon names.

**Tech Stack:** TypeScript (ESM, run via `tsx`, no build step), vitest, Express + SSE, Canvas 2D (`tv.js`), better-sqlite3.

## Global Constraints

- **ESM, extensionless relative imports; no build step** (run TS via `tsx`).
- **Determinism.** Domain/layout functions take an injected `rng` or a fixed `seed`; no `Date.now()`/`Math.random()` in domain/adapter code. `currentTvLayout(db)` is a pure read (same DB → same layout). The engine's `newDungeon` stays deterministic (injected `rng`); the theme draw must consume **exactly one** `rng()` call (same as the old uniform pick) so downstream `seed`/`regularCount` draws don't shift.
- **Coordinates.** Sheet tiles are 24px; a cell carries `{col,row}` into `/sheet/world.png`. Grid is 20×15.
- **Legacy safety.** A live DB's active dungeon may hold an old theme (`stone_crypt`); `getDungeon` returns undefined for it. The adapter must fall back to `Greystone Keep`, never throw — `/tv` must not 500.
- **Keep green.** After every task, `npm run typecheck` and `npx vitest run` pass. `tv.js` is browser code with no unit test; Task 2 lands the server payload change and the `tv.js` renderer change together so the browser is never left broken between commits.
- **Do NOT touch** `src/domain/dungeon.ts`, `src/domain/tilemanifest.ts` (still used by the catalog and for `makeRng`), or the palette/floor data — those are follow-ons.

## File Structure

- Create `src/web/tvlayout.ts` — `TvLayout`/`TvLayoutCell` types + `currentTvLayout(db)` (dungeon2 cells + monster zone + hero slots + legacy fallback).
- Create `tests/tvlayout.test.ts`.
- Modify `src/web/tvview.ts` — `buildTvLayout`/`buildTvState` consume `currentTvLayout`; drop old `TvLayout` types + `currentLayout`/`worldSpriteUrl` imports.
- Modify `src/web/public/tv/tv.js` — `buildBackground` draws from the sheet.
- Modify `tests/tvview-layout.test.ts` — assert the new cell shape.
- Modify `src/domain/encounters.ts` — weighted theme draw over the 22 names.
- Modify `tests/` — an encounters/theme test.

---

### Task 1: TV layout adapter (`currentTvLayout`)

**Files:**
- Create: `src/web/tvlayout.ts`
- Test: `tests/tvlayout.test.ts`

**Interfaces:**
- Consumes: `generateAutotiledDungeon` from `../domain/dungeon2`; `getDungeon` from `../domain/floorgroups`; `makeRng` from `../domain/dungeon`.
- Produces:
  - `interface TvLayoutCell { type: 'wall'|'floor'|'door'; col: number; row: number; under?: { col: number; row: number } }`
  - `interface TvLayout { dungeonId: number; theme: string; width: number; height: number; cells: TvLayoutCell[][]; doors: {x:number;y:number}[]; monster: {x:number;y:number;footprint:number}; heroSlots: {x:number;y:number}[]; decor: {x:number;y:number;col:number;row:number}[] }`
  - `currentTvLayout(db: Database.Database): TvLayout | null`

- [ ] **Step 1: Write the failing test**

Create `tests/tvlayout.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { getDungeon } from '../src/domain/floorgroups';
import { currentTvLayout } from '../src/web/tvlayout';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}
function activeDungeon() {
  const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
  ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
  new GameEngine(db, { rng: () => 0.5 }).tick(100000);
}
function setTheme(name: string) {
  db.prepare('UPDATE dungeons SET theme=? WHERE id=(SELECT current_dungeon_id FROM game_state WHERE id=1)').run(name);
}

describe('currentTvLayout', () => {
  it('returns null when no dungeon is active', () => {
    expect(currentTvLayout(db)).toBeNull();
  });

  it('maps an active dungeon to sheet cells + monster zone + hero slots', () => {
    activeDungeon();
    setTheme('Greystone Keep');
    const L = currentTvLayout(db)!;
    expect(L).not.toBeNull();
    expect(L.theme).toBe('Greystone Keep');
    expect(L.width).toBe(20);
    expect(L.height).toBe(15);
    expect(L.dungeonId).toBeGreaterThan(0);
    expect(L.cells.length).toBe(15);
    expect(L.cells[0].length).toBe(20);
    for (const row of L.cells) for (const c of row) {
      expect(Number.isInteger(c.col)).toBe(true);
      expect(Number.isInteger(c.row)).toBe(true);
      expect(['wall', 'floor', 'door']).toContain(c.type);
    }
    // fixed 2x2 centre monster zone
    expect(L.monster).toEqual({ x: 9, y: 6, footprint: 2 });
    // hero slots: <=24, all interior floor, none in the monster zone or on a door
    const doorKey = new Set(L.doors.map((d) => `${d.x},${d.y}`));
    expect(L.heroSlots.length).toBeGreaterThan(0);
    expect(L.heroSlots.length).toBeLessThanOrEqual(24);
    for (const s of L.heroSlots) {
      expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(19);
      expect(s.y).toBeGreaterThan(0); expect(s.y).toBeLessThan(14);
      expect(L.cells[s.y][s.x].type).toBe('floor');
      const inMonster = s.x >= 9 && s.x <= 10 && s.y >= 6 && s.y <= 7;
      expect(inMonster).toBe(false);
      expect(doorKey.has(`${s.x},${s.y}`)).toBe(false);
    }
    // door cells carry a floor underlay
    for (const d of L.doors) expect(L.cells[d.y][d.x].under).toBeDefined();
    // deterministic
    expect(currentTvLayout(db)).toEqual(L);
  });

  it('falls back to a default dungeon on an unknown/legacy theme (no throw)', () => {
    activeDungeon();
    setTheme('stone_crypt'); // old theme, not a dungeon2 name
    expect(getDungeon('stone_crypt')).toBeUndefined();
    const L = currentTvLayout(db)!;
    expect(L).not.toBeNull();
    expect(L.theme).toBe('Greystone Keep');
    expect(L.cells.length).toBe(15);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tvlayout.test.ts`
Expected: FAIL — cannot resolve `../src/web/tvlayout`.

- [ ] **Step 3: Write the adapter**

Create `src/web/tvlayout.ts`:

```ts
import type Database from 'better-sqlite3';
import { generateAutotiledDungeon } from '../domain/dungeon2';
import { getDungeon } from '../domain/floorgroups';
import { makeRng } from '../domain/dungeon';

export interface TvLayoutCell {
  type: 'wall' | 'floor' | 'door';
  col: number; row: number;
  under?: { col: number; row: number };
}
export interface TvLayout {
  dungeonId: number; theme: string; width: number; height: number;
  cells: TvLayoutCell[][];
  doors: { x: number; y: number }[];
  monster: { x: number; y: number; footprint: number };
  heroSlots: { x: number; y: number }[];
  decor: { x: number; y: number; col: number; row: number }[];
}

const FALLBACK_DUNGEON = 'Greystone Keep';
const MAX_HERO_SLOTS = 24;

/** Build the active dungeon's TV render payload from dungeon2, or null if none. */
export function currentTvLayout(db: Database.Database): TvLayout | null {
  const gs = db.prepare('SELECT current_dungeon_id FROM game_state WHERE id=1').get() as
    { current_dungeon_id: number | null } | undefined;
  if (!gs || !gs.current_dungeon_id) return null;
  const d = db.prepare('SELECT theme, seed FROM dungeons WHERE id=?')
    .get(gs.current_dungeon_id) as { theme: string; seed: number } | undefined;
  if (!d) return null;

  // Legacy/in-flight rows may hold an old theme (e.g. 'stone_crypt') that isn't a
  // dungeon2 name -> fall back so /tv never 500s; self-corrects on the next spawn.
  const name = getDungeon(d.theme) ? d.theme : FALLBACK_DUNGEON;
  const auto = generateAutotiledDungeon(name, d.seed);
  const { width, height } = auto;

  // Flat cells -> [y][x] render payload; collect door positions.
  const cells: TvLayoutCell[][] = Array.from({ length: height }, () => new Array<TvLayoutCell>(width));
  const doors: { x: number; y: number }[] = [];
  for (const c of auto.cells) {
    cells[c.y][c.x] = { type: c.kind as 'wall' | 'floor' | 'door', col: c.col, row: c.row, under: c.under };
    if (c.kind === 'door') doors.push({ x: c.x, y: c.y });
  }

  // Fixed 2x2 centre monster zone (drawn on top of floor).
  const monster = { x: Math.floor(width / 2) - 1, y: Math.floor(height / 2) - 1, footprint: 2 };
  const inMonster = (x: number, y: number) =>
    x >= monster.x && x <= monster.x + 1 && y >= monster.y && y <= monster.y + 1;

  // Hero slots: shuffled interior floor cells clear of the monster zone. Own
  // deterministic rng (dungeon2 doesn't expose its stream).
  const candidates: { x: number; y: number }[] = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      if (cells[y][x].type === 'floor' && !inMonster(x, y)) candidates.push({ x, y });
  const rng = makeRng(d.seed);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const heroSlots = candidates.slice(0, Math.min(MAX_HERO_SLOTS, candidates.length));

  const decor = auto.decor.map((p) => ({ x: p.x, y: p.y, col: p.col, row: p.row }));

  return { dungeonId: gs.current_dungeon_id, theme: name, width, height, cells, doors, monster, heroSlots, decor };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tvlayout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: clean).

```bash
git add src/web/tvlayout.ts tests/tvlayout.test.ts
git commit -m "feat(tv): dungeon2 TV layout adapter (cells + monster zone + hero slots + legacy fallback)"
```

---

### Task 2: Swap the live TV render to the sheet

Wire the two TV builders to the adapter and rewrite the `tv.js` background to draw sheet sub-rects. Server payload + client renderer land together so the browser is never broken between commits. (The engine still stores old themes here, so the adapter's fallback renders every dungeon as `Greystone Keep` until Task 3 — green and correct, just monotone.)

**Files:**
- Modify: `src/web/tvview.ts`
- Modify: `src/web/public/tv/tv.js`
- Test: `tests/tvview-layout.test.ts`

**Interfaces:**
- Consumes: `currentTvLayout`, `type TvLayout` from `./tvlayout` (Task 1).
- Produces: `buildTvLayout(db): TvLayout | null` (now the new shape); `buildTvState` unchanged except it reads hero slots from `currentTvLayout`.

- [ ] **Step 1: Update the layout test to the new cell shape**

In `tests/tvview-layout.test.ts`, replace the body of the `it('maps the active dungeon to sprite URLs', ...)` test (rename it too) with:

```ts
  it('maps the active dungeon to sheet cells', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const layout = buildTvLayout(db)!;
    expect(layout).not.toBeNull();
    expect(layout.width).toBe(20);
    expect(layout.height).toBe(15);
    expect(layout.dungeonId).toBeGreaterThan(0);
    for (const row of layout.cells) for (const c of row) {
      expect(Number.isInteger(c.col)).toBe(true);
      expect(Number.isInteger(c.row)).toBe(true);
      expect(['wall', 'floor', 'door']).toContain(c.type);
    }
    expect(layout.monster.x).toBeGreaterThan(0);
    for (const d of layout.decor) {
      expect(Number.isInteger(d.col)).toBe(true);
      expect(Number.isInteger(d.row)).toBe(true);
    }
  });
```

(The `assignHeroSlots` test and the `returns null when no dungeon is active` test are unchanged.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tvview-layout.test.ts`
Expected: FAIL — `buildTvLayout` still emits `{type,url}` cells (no `col`/`row`).

- [ ] **Step 3: Rewire `tvview.ts`**

In `src/web/tvview.ts`:

1. Replace the top imports (lines 1-3) —

```ts
import type Database from 'better-sqlite3';
import { currentTvLayout, type TvLayout } from './tvlayout';
```

2. Delete the old `TvLayoutCell` and `TvLayout` interface blocks (old lines 5-15).

3. Replace the old `buildTvLayout` function (old lines 17-34) with a thin delegator:

```ts
/** Active dungeon layout as the TV render payload, or null. */
export function buildTvLayout(db: Database.Database): TvLayout | null {
  return currentTvLayout(db);
}
```

4. In `buildTvState`, replace the `const layout = currentLayout(db);` line (old line 117) with:

```ts
  const layout = currentTvLayout(db);
```

`assignHeroSlots` and the rest of `buildTvState` are unchanged (they read `layout.heroSlots`). Leave the second import group (`getGameState`, `loadEngineConfig`, `sumEffectiveSince`, `tokenModifier`, `classSpriteUrl`, `buildDefeatSummary`, etc.) as-is. Confirm no remaining reference to `currentLayout` or `worldSpriteUrl` in the file.

- [ ] **Step 4: Rewrite `buildBackground` in `tv.js`**

In `src/web/public/tv/tv.js`, replace the whole `buildBackground` function (lines 45-66) with:

```js
function buildBackground() {
  if (!layout) return;
  const sheet = img('/sheet/world.png');
  bg = document.createElement('canvas');
  bg.width = 20 * tilePx; bg.height = 15 * tilePx;
  const b = bg.getContext('2d');
  b.imageSmoothingEnabled = false;
  const put = (col, row, x, y) =>
    b.drawImage(sheet, col * TILE, row * TILE, TILE, TILE, x * tilePx, y * tilePx, tilePx, tilePx);
  const draw = () => {
    b.clearRect(0, 0, bg.width, bg.height);
    for (let y = 0; y < layout.height; y++)
      for (let x = 0; x < layout.width; x++) {
        const c = layout.cells[y][x];
        if (c.under) put(c.under.col, c.under.row, x, y); // floor behind a transparent door
        put(c.col, c.row, x, y);
      }
    for (const d of layout.decor) put(d.col, d.row, d.x, d.y);
  };
  // draw now, and again once the sheet finishes loading (one shared image)
  draw();
  if (!sheet.complete) sheet.onload = draw;
}
```

Nothing else in `tv.js` changes (heroes/monster/HP/leaderboard/defeat use their own sprite URLs).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run`
Expected: PASS — `tvview-layout` green with the new shape; `tvview-state`, `tvhub`, `web-tv` unaffected (they don't assert cell shape).

Run: `npm run typecheck`
Expected: clean.

Confirm no stale references:
```bash
grep -rn "currentLayout\|worldSpriteUrl\|\.url" src/web/tvview.ts
```
Expected: no output (the `.url` background path is gone from the view model; `tvview.ts` no longer imports `currentLayout`/`worldSpriteUrl`).

- [ ] **Step 6: Commit**

```bash
git add src/web/tvview.ts src/web/public/tv/tv.js tests/tvview-layout.test.ts
git commit -m "feat(tv): render the live dungeon from dungeon2 via the sheet"
```

---

### Task 3: Weighted 22-theme rotation in the engine

Turn on the variety: the engine picks a dungeon theme by weighted draw over the 22 dungeon names.

**Files:**
- Modify: `src/domain/encounters.ts`
- Test: `tests/encounters-theme.test.ts`

**Interfaces:**
- Consumes: `DUNGEONS` from `./floorgroups`; `pickWeighted` from `./tilesheet`.
- Produces: `pickDungeonTheme(rng: () => number): string` (exported for test); `newDungeon` stores its result in `dungeons.theme`.

- [ ] **Step 1: Write the failing test**

Create `tests/encounters-theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickDungeonTheme } from '../src/domain/encounters';
import { getDungeon } from '../src/domain/floorgroups';
import { makeRng } from '../src/domain/dungeon';

describe('pickDungeonTheme', () => {
  it('always returns a valid dungeon2 name', () => {
    for (let s = 1; s <= 50; s++) {
      const name = pickDungeonTheme(makeRng(s));
      expect(getDungeon(name)).toBeDefined();
    }
  });

  it('is deterministic for a fixed rng seed', () => {
    expect(pickDungeonTheme(makeRng(42))).toBe(pickDungeonTheme(makeRng(42)));
  });

  it('never returns an old hard-coded theme', () => {
    const olds = new Set(['stone_crypt', 'cave', 'wood_fort']);
    for (let s = 1; s <= 50; s++) expect(olds.has(pickDungeonTheme(makeRng(s)))).toBe(false);
  });

  it('a down-weighted theme appears less often than a baseline one', () => {
    const rng = makeRng(7);
    const counts = new Map<string, number>();
    for (let i = 0; i < 20000; i++) {
      const n = pickDungeonTheme(rng);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    // Auric Deep is weighted 3 vs baseline 10 -> should be materially rarer than a baseline theme.
    expect((counts.get('Auric Deep') ?? 0)).toBeLessThan((counts.get('Greystone Keep') ?? 0));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/encounters-theme.test.ts`
Expected: FAIL — `pickDungeonTheme` is not exported.

- [ ] **Step 3: Implement the weighted draw**

In `src/domain/encounters.ts`:

1. Add imports near the top (after the existing imports):

```ts
import { DUNGEONS } from './floorgroups';
import { pickWeighted } from './tilesheet';
```

2. Replace the `const THEMES = ['stone_crypt', 'cave', 'wood_fort'];` line with:

```ts
// Per-theme spawn weight over the 22 dungeon names; unlisted default to BASE.
// Down-weight the visually loud / novelty wall themes. Curated from the roster
// render — tune on the real TV. (Weights the WALL theme; floors come from compat.)
const THEME_BASE = 10;
const THEME_WEIGHTS: Record<string, number> = {
  'Auric Deep': 3,    // bright gold walls — a rare treat
  'Crimson Court': 5, // stark heraldic checker
};
const THEME_POOL = DUNGEONS.map((d) => ({ name: d.name, weight: THEME_WEIGHTS[d.name] ?? THEME_BASE }));

/** Weighted pick of a dungeon theme (one rng() draw). Deterministic given rng. */
export function pickDungeonTheme(rng: () => number): string {
  return pickWeighted(THEME_POOL, rng).name;
}
```

3. In `newDungeon`, replace the theme line:

```ts
  const theme = pickDungeonTheme(rng);
```

(This consumes exactly one `rng()` call, same as the old `THEMES[...]` pick, so `seed`/`regularCount` draws are unshifted.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/encounters-theme.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run`
Expected: PASS (all files — no test pins the old themes; `tvlayout`/`tvview-layout` now see real 22-names instead of the fallback).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/domain/encounters.ts tests/encounters-theme.test.ts
git commit -m "feat(engine): weighted rotation over all 22 dungeon themes"
```

---

### Task 4: Verify the live TV render

Confirm the swapped renderer works end-to-end in a browser against a real DB.

**Files:** none (manual verification).

- [ ] **Step 1: Launch the server on a throwaway DB**

Run (background):
```bash
PORT=8091 DB_PATH="$TMPDIR/tv-verify.db" SESSION_SECRET=verify npm run start
```
Wait for `listening on http://localhost:8091`.

- [ ] **Step 2: Create a player and stream tokens so a dungeon spawns**

Register a player (POST the registration form or use the UI at `http://localhost:8091/`), then confirm the engine has an active dungeon:
```bash
curl -s http://localhost:8091/health   # sanity: server up
```
(If no player flow is convenient, the engine spawns a dungeon once any player has token credit — reuse the registration UI.)

- [ ] **Step 3: Open `/tv` in a browser and look at it**

Open `http://localhost:8091/tv`. Confirm:
- the dungeon background renders from the sheet — cohesive skinned walls + floor + door tiles (no black holes, no broken/missing tiles),
- heroes stand on interior floor, the monster sits in the centre 2×2 zone,
- HP bar, leaderboard, and (on a kill) the defeat popup are unaffected.

If the background is blank, check the browser console and confirm `/sheet/world.png` loads (Network tab) and the `layout` SSE event carries `{col,row}` cells.

- [ ] **Step 4: Stop the server**

Stop the background `npm run start`.

- [ ] **Step 5: (No commit unless a fix was needed.)** If verification surfaced a bug, fix it under a new task with its own test rather than patching here.

---

## Notes for the implementer

- **`makeRng` lives in `src/domain/dungeon.ts`** and returns a fresh independent mulberry32 stream per call — `makeRng(42)` twice gives identical sequences (used by the theme and adapter tests).
- **The adapter's hero-slot shuffle uses its own `makeRng(seed)`** — independent of dungeon2's internal stream, deterministic given the dungeon's stored `seed`.
- **Determinism budget (engine):** `pickDungeonTheme` = exactly one `rng()` call, matching the old uniform pick, so no downstream draw shifts. Do not add stray `rng()` calls in `newDungeon`.
- **Do not touch** `dungeon.ts`/`tilemanifest.ts` (catalog + `makeRng` still use them), the vendored floor JSON (palette tuning is a follow-on), or the hero/monster/leaderboard render layers.

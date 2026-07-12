# Dungeon Decorations & Livelier Floors (Build 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the dungeon with theme-appropriate decor (floor props, corner cobwebs, wall torches) and make floors richer — all data + placement, rendered by the existing baked-decor path.

**Architecture:** A new pure `decor.ts` holds the curated tile library + `decorFor(name)`. `dungeon2` places decor by type (corner/wall/floor, clear of the monster zone) and marks each cell `walkable`. `tvlayout` keeps hero slots off non-walkable decor. Floors get an accent-rate bump + #14 tuning. `tv.js` is unchanged (it already bakes any decor cell).

**Tech Stack:** TypeScript ESM via `tsx` (no build), vitest, better-sqlite3.

Spec: `docs/superpowers/specs/2026-07-12-dungeon-decor-floors-design.md`. Curation reference: `docs/oryx_decor_reference.md`.

## Global Constraints

- **No build step.** Typecheck `npm run typecheck`; tests `npx vitest run <file>`.
- **Determinism:** decor placement uses dungeon2's existing seeded `rng`; no `Date.now`/`Math.random`. New decor draws happen AFTER the wall/floor/door draws, so existing wall/floor/door output is unchanged (only decor is added) — per-seed determinism holds.
- **`tv.js` is NOT changed** — it already draws any `decor` cell into the baked panel and ignores the extra `walkable` field.
- **Animated tiles render as static frame A** in Build 1 (`animB` is captured data, unused here).
- Suite stays green (baseline 228) at every task.

## File Structure

- Create: `src/domain/decor.ts`, `tests/decor.test.ts`
- Modify: `src/domain/dungeon2.ts` (placement + `AutoDungeon.decor` walkable), `tests/dungeon2.test.ts`
- Modify: `src/domain/floorgroups.ts` (drop `Dungeon.decor`; bump `ACCENT_RATE`; #14)
- Modify: `src/web/tvlayout.ts` (hero-slot avoidance), `tests/tvlayout.test.ts`
- Modify: `src/domain/floordata/floor_groups.json`, `src/domain/floordata/floor_compatibility.json` (#14)

---

## Task 1: Decor library

**Files:** Create `src/domain/decor.ts`, Test `tests/decor.test.ts`
**Interfaces:** Consumes `TileCoord` (tilesheet). Produces `DecorTag`, `DecorPlacement`, `DecorTile`, `DecorPool`, `DECOR_TILES`, `DUNGEON_DECOR`, `COBWEB_HEAVY`, `decorFor(name)`.

- [ ] **Step 1: Write the failing test** — `tests/decor.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { SHEET } from '../src/domain/tilesheet';
import { DUNGEONS } from '../src/domain/floorgroups';
import { DECOR_TILES, DUNGEON_DECOR, COBWEB_HEAVY, decorFor } from '../src/domain/decor';

const inSheet = (c: { col: number; row: number }) =>
  Number.isInteger(c.col) && c.col >= 0 && c.col < SHEET.cols &&
  Number.isInteger(c.row) && c.row >= 0 && c.row < SHEET.rows;

describe('decor library', () => {
  it('every tile is a valid sheet coord with tags, walkable, and (if animated) a valid animB', () => {
    for (const t of DECOR_TILES) {
      expect(inSheet(t), t.name).toBe(true);
      expect(t.tags.length, t.name).toBeGreaterThan(0);
      expect(typeof t.walkable, t.name).toBe('boolean');
      if (t.animB) expect(inSheet(t.animB), t.name).toBe(true);
    }
  });
  it('every dungeon draws at least one floor decor tile', () => {
    for (const d of DUNGEONS) expect(decorFor(d.name).floor.length, d.name).toBeGreaterThan(0);
  });
  it('decorFor only returns tiles whose tags match the dungeon', () => {
    for (const d of DUNGEONS) {
      const tags = new Set(DUNGEON_DECOR[d.name]);
      for (const t of [...decorFor(d.name).floor, ...decorFor(d.name).corner, ...decorFor(d.name).wall])
        expect(t.tags.some((tag) => tags.has(tag)), `${d.name}:${t.name}`).toBe(true);
    }
  });
  it('full cobweb is offered only to cobweb-heavy dungeons', () => {
    for (const d of DUNGEONS) {
      const hasFull = decorFor(d.name).corner.some((t) => t.name === 'cobweb full');
      if (hasFull) expect(COBWEB_HEAVY.has(d.name), d.name).toBe(true);
    }
  });
  it('falls back without throwing for an unknown dungeon', () => {
    expect(() => decorFor('nonesuch')).not.toThrow();
    expect(decorFor('nonesuch').floor.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/decor.test.ts` FAIL (module not found).

- [ ] **Step 3: Write `src/domain/decor.ts`** — transcribe Component 1 from the spec verbatim (the `DecorTag`/`DecorPlacement`/`DecorTile`/`DecorPool` types, the full `DECOR_TILES` array, `DUNGEON_DECOR`, `COBWEB_HEAVY`, `FALLBACK_DECOR`, and `decorFor`). It is complete in the spec (`docs/superpowers/specs/2026-07-12-dungeon-decor-floors-design.md` §Component 1) — copy it exactly, including every tile's `walkable` and `animB`.

- [ ] **Step 4: Run tests to verify pass** — `npx vitest run tests/decor.test.ts` PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/domain/decor.ts tests/decor.test.ts && git commit -m "feat(decor): themed decor tile library + decorFor"`

---

## Task 2: Placement in dungeon2 + floorgroups cleanup

**Files:** Modify `src/domain/dungeon2.ts`, `src/domain/floorgroups.ts`, Test `tests/dungeon2.test.ts`
**Interfaces:** Consumes `decorFor`, `COBWEB_HEAVY` (decor). Produces `AutoDungeon.decor: {x,y,col,row,walkable}[]`.

- [ ] **Step 1: Write the failing tests** — add to `tests/dungeon2.test.ts` (the file already has `const dungeon = 'Greystone Keep'`, which is cobweb-heavy):

```ts
import { decorFor } from '../src/domain/decor';
// ... inside describe('generateAutotiledDungeon', ...)
it('places decor: non-empty, carries walkable, clears the 2x2 monster zone', () => {
  const d = generateAutotiledDungeon(dungeon, 7, { width: 20, height: 15 });
  expect(d.decor.length).toBeGreaterThan(0);
  const mx = Math.floor(20 / 2) - 1, my = Math.floor(15 / 2) - 1;
  for (const p of d.decor) {
    expect(typeof p.walkable).toBe('boolean');
    const inMonster = p.x >= mx && p.x <= mx + 1 && p.y >= my && p.y <= my + 1;
    expect(inMonster).toBe(false);
  }
});
it('corner decor sits at an interior corner and uses a corner tile', () => {
  const cornerKeys = new Set(decorFor(dungeon).corner.map((t) => `${t.col},${t.row}`));
  const corners = new Set(['1,1', `18,1`, `1,13`, `18,13`]); // 20x15 interior corners
  let sawCorner = false;
  for (let seed = 1; seed <= 10; seed++) {
    const d = generateAutotiledDungeon(dungeon, seed, { width: 20, height: 15 });
    for (const p of d.decor) {
      if (corners.has(`${p.x},${p.y}`)) { sawCorner = true; expect(cornerKeys.has(`${p.col},${p.row}`)).toBe(true); }
    }
  }
  expect(sawCorner).toBe(true); // Greystone Keep is cobweb-heavy -> corners fill often
});
it('decor is deterministic per (dungeon, seed)', () => {
  expect(generateAutotiledDungeon(dungeon, 42).decor).toEqual(generateAutotiledDungeon(dungeon, 42).decor);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/dungeon2.test.ts` FAIL (`decor` empty / no `walkable`).

- [ ] **Step 3: Update `AutoDungeon` + imports in `dungeon2.ts`.**
Add import: `import { decorFor, COBWEB_HEAVY } from './decor';`
Change the `AutoDungeon.decor` field type:
```ts
  decor: { x: number; y: number; col: number; row: number; walkable: boolean }[];
```

- [ ] **Step 4: Replace the decor block** (the current step-3 block, lines ~124–137) with placement-aware logic:
```ts
  // 3) Decor: corner cobwebs, wall torches, and floor scatter (clear of the monster zone).
  const pools = decorFor(dungeonName);
  const decor: { x: number; y: number; col: number; row: number; walkable: boolean }[] = [];
  const used = new Set<string>();
  const at2 = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const shuffle = <T>(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  };
  const place = (x: number, y: number, t: { col: number; row: number; walkable: boolean }) => {
    decor.push({ x, y, col: t.col, row: t.row, walkable: t.walkable }); used.add(`${x},${y}`);
  };
  // corners
  if (pools.corner.length) {
    const p = COBWEB_HEAVY.has(dungeonName) ? 0.85 : 0.5;
    for (const [cx, cy] of [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]] as const) {
      if (kinds[cy][cx] === 'floor' && rng() < p) place(cx, cy, at2(pools.corner));
    }
  }
  // wall torches (non-corner border walls, not doors)
  if (pools.wall.length) {
    const wallCells: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (kinds[y][x] === 'wall' && !isCorner(x, y)) wallCells.push({ x, y });
    shuffle(wallCells);
    const n = Math.min(6, Math.max(1, Math.floor(wallCells.length / 5)));
    for (let i = 0; i < n && i < wallCells.length; i++) place(wallCells[i].x, wallCells[i].y, at2(pools.wall));
  }
  // floor scatter, avoiding the fixed 2x2 monster zone + already-used cells
  const mx = Math.floor(width / 2) - 1, my = Math.floor(height / 2) - 1;
  const inMonster = (x: number, y: number) => x >= mx && x <= mx + 1 && y >= my && y <= my + 1;
  const floorCells: { x: number; y: number }[] = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      if (kinds[y][x] === 'floor' && !inMonster(x, y) && !used.has(`${x},${y}`)) floorCells.push({ x, y });
  shuffle(floorCells);
  if (pools.floor.length) {
    const n = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < n && i < floorCells.length; i++) place(floorCells[i].x, floorCells[i].y, at2(pools.floor));
  }
```
(The `isCorner` helper already exists in `dungeon2.ts`. The old `interior`/`decorCount`/`dungeon.decor` code is fully replaced.) The `return { ..., decor }` line is unchanged.

- [ ] **Step 5: Drop `Dungeon.decor` in `floorgroups.ts`.**
Remove `decor: TileCoord[]` from the `Dungeon` interface (line ~17) and the `decor: []` line from the `DUNGEONS` map (line ~54). Then verify nothing else reads it:
`grep -rn "\.decor" src/domain/floorgroups.ts` and `grep -rn "dungeon\.decor\|\.decor:" src/ tests/` — the only `.decor` references should be `AutoDungeon.decor` / `auto.decor` / `d.decor` (the render payload), NOT `Dungeon.decor`. If `TileCoord` becomes an unused import in floorgroups.ts, remove it.

- [ ] **Step 6: Run tests** — `npx vitest run tests/dungeon2.test.ts` PASS; `npm run typecheck` clean; then `npx vitest run` (full) — green (tvlayout still compiles: `auto.decor.map((p)=>({x,y,col,row}))` ignores the new `walkable`).
- [ ] **Step 7: Commit** — `git add src/domain/dungeon2.ts src/domain/floorgroups.ts tests/dungeon2.test.ts && git commit -m "feat(dungeon2): themed decor placement (corners/walls/floor) + walkable"`

---

## Task 3: Hero slots avoid non-walkable decor

**Files:** Modify `src/web/tvlayout.ts`, Test `tests/tvlayout.test.ts`
**Interfaces:** Consumes `AutoDungeon.decor[].walkable`.

- [ ] **Step 1: Write the failing test** — add to `tests/tvlayout.test.ts` (reuse its `activeDungeon()` helper + `currentTvLayout`):

```ts
it('never places a hero on a non-walkable decor cell', () => {
  activeDungeon();
  setTheme('Greystone Keep');
  const L = currentTvLayout(db)!;
  const decorKeys = new Set(L.decor.map((d) => `${d.x},${d.y}`)); // Build 1: all decor non-walkable
  for (const s of L.heroSlots) expect(decorKeys.has(`${s.x},${s.y}`)).toBe(false);
});
```
(If `setTheme` isn't already imported/defined in this file, reuse the existing helper the other tests use to set the dungeon theme.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/tvlayout.test.ts` FAIL (a hero can land on a decor cell).

- [ ] **Step 3: Update `tvlayout.ts`** — exclude non-walkable decor cells from hero-slot candidates. Just before building `candidates`, add:
```ts
  const blocked = new Set(auto.decor.filter((d) => !d.walkable).map((d) => `${d.x},${d.y}`));
```
and change the candidate condition:
```ts
      if (cells[y][x].type === 'floor' && !inMonster(x, y) && !blocked.has(`${x},${y}`)) candidates.push({ x, y });
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/tvlayout.test.ts` PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/web/tvlayout.ts tests/tvlayout.test.ts && git commit -m "feat(tv): keep hero slots off non-walkable decor"`

---

## Task 4: Livelier floors (#7 + #14)

**Files:** Modify `src/domain/floorgroups.ts`, `src/domain/floordata/floor_groups.json`, `src/domain/floordata/floor_compatibility.json`

- [ ] **Step 1: Bump the accent rate** — in `floorgroups.ts`, `const ACCENT_RATE = 0.06;` → `const ACCENT_RATE = 0.11;` (leave `GLOW_RATE`).

- [ ] **Step 2: Run the suite** — `npx vitest run` — fix any test that asserts an exact accent frequency by updating it to the new rate; if none, the suite stays green. `npm run typecheck` clean.

- [ ] **Step 3: Apply the #14 floordata edits** (data-only; verify shapes against the live JSON first):
  - In `floor_groups.json`: find the `cinder_rock` group and move its high-contrast **2nd main** from `mains` into `accents` (so it becomes a sparse accent, not a 50/50 blend). For any group whose `accents` array is empty, add 1–2 same-family tiles from that group's own palette so every floor has some variation.
  - In `floor_compatibility.json`: restrict `crimson_mosaic` so it only appears under crimson-family dungeons (remove it from grey/neutral `home`/`great`/`good` lists), OR drop it as a main if it reads too loud. Trim the most over-generous `good`-tier lists where a warm floor lands under a cool/green wall.
  - Keep JSON valid (the loaders `JSON.parse` these); run `npx vitest run` after to confirm floorgroups still loads and all tests pass.

- [ ] **Step 4: Commit** — `git add src/domain/floorgroups.ts src/domain/floordata/*.json && git commit -m "feat(floors): richer accent rate + #14 palette tuning"`

- [ ] **Step 5 (controller): visual pass** — the floor/#14 edits and decor density are inherently visual. The controller seeds a scratch DB, renders a spread of themed dungeons (crypt / forge / nature / ice / sewer / desert / blood) via headless-Chrome screenshots, and confirms: cobwebs in corners, torches on walls, themed floor props, no hero standing on a prop, and richer/cohesive floors. Iterate on `ACCENT_RATE`, cobweb density, and the #14 edits from what the render shows.

---

## Self-Review

- **Spec coverage:** decor library (T1), placement + walkable + floorgroups cleanup (T2), hero-slot avoidance (T3), floor tuning (T4). All spec §Testing items map to task tests; the visual pass covers the un-unit-testable render.
- **Green at every step:** T1 is independent; T2 changes `AutoDungeon.decor`'s shape and removes `Dungeon.decor` together (tvlayout still compiles, ignoring `walkable`); T3 consumes `walkable`; T4 is data-only.
- **Type consistency:** `decorFor` → `DecorPool` used in dungeon2; `AutoDungeon.decor[].walkable` produced in T2, consumed in T3; `tv.js` untouched and tolerant of the extra field.
- **No placeholders:** T1's library is fully specified in the spec; T2/T3 show exact before/after. T4's #14 JSON edits are the one intentionally-iterative part, gated by the controller visual pass (palette tuning can't be unit-tested).

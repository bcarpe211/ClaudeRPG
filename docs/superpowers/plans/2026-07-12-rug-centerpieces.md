# Rug Centerpieces (Build 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Occasionally lay a walkable 3×3 rug centerpiece (themed border + crest) under the monster.

**Architecture:** A pure `rugs.ts` holds the rug tiles + `rugFor`. `dungeon2` occasionally places a rug centered on the monster zone as walkable static decor — flowing through the existing Build 1 pipeline, so `tvlayout`/`tv.js` need no change.

**Tech Stack:** TypeScript ESM via `tsx` (no build), vitest.

Spec: `docs/superpowers/specs/2026-07-12-rug-centerpieces-design.md`. Reference: `docs/oryx_decor_reference.md`.

## Global Constraints

- **No build step.** Typecheck `npm run typecheck`; tests `npx vitest run <file>`.
- **Determinism:** no `Date.now`/`Math.random` in `src/domain/**`; rug placement uses the seeded `rng`, inside the decor block (after cell resolution), so wall/floor/door output is unchanged.
- **No `tvlayout`/`tv.js` change** — rugs are walkable static decor (`walkable:true`, no `animB`), handled by Build 1's pipeline.
- Suite stays green (baseline 239).

## File Structure

- Create: `src/domain/rugs.ts`, `tests/rugs.test.ts`
- Modify: `src/domain/dungeon2.ts` (rug placement), `tests/dungeon2.test.ts`

---

## Task 1: Rug data + `rugFor`

**Files:** Create `src/domain/rugs.ts`, Test `tests/rugs.test.ts`
**Interfaces:** Consumes `TileCoord` (tilesheet). Produces `RugBorderTile`, `Rug`, `RED_RUG`, `BLUE_RUG`, `RUG_WARM`, `RUG_CHANCE`, `rugFor(name, rng)`.

- [ ] **Step 1: Write the failing test** — `tests/rugs.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { SHEET } from '../src/domain/tilesheet';
import { RED_RUG, BLUE_RUG, RUG_WARM, rugFor } from '../src/domain/rugs';

const inSheet = (c: { col: number; row: number }) =>
  Number.isInteger(c.col) && c.col >= 0 && c.col < SHEET.cols &&
  Number.isInteger(c.row) && c.row >= 0 && c.row < SHEET.rows;

describe('rugs', () => {
  it('each rug has 8 border tiles (3x3 minus center) at the right coords', () => {
    for (const [rug, c0, r0] of [[RED_RUG, 5, 24], [BLUE_RUG, 8, 24]] as const) {
      expect(rug.border.length).toBe(8);
      const seen = new Set<string>();
      for (const b of rug.border) {
        expect(b.dx >= 0 && b.dx <= 2 && b.dy >= 0 && b.dy <= 2).toBe(true);
        expect(b.dx === 1 && b.dy === 1).toBe(false);          // center excluded
        expect(b.col).toBe(c0 + b.dx);
        expect(b.row).toBe(r0 + b.dy);
        expect(inSheet(b)).toBe(true);
        seen.add(`${b.dx},${b.dy}`);
      }
      expect(seen.size).toBe(8);                                // no dup positions
      expect(rug.crests.length).toBe(3);
      for (const c of rug.crests) expect(inSheet(c)).toBe(true);
    }
  });
  it('rugFor themes by dungeon and picks one of that rug\'s crests, deterministically', () => {
    const warm = rugFor('Emberforge', () => 0);
    expect(RED_RUG.crests.some((c) => c.col === warm.crest.col && c.row === warm.crest.row)).toBe(true);
    expect(warm.border).toBe(RED_RUG.border);
    const cool = rugFor('Glacierhold', () => 0);
    expect(cool.border).toBe(BLUE_RUG.border);
    expect(BLUE_RUG.crests.some((c) => c.col === cool.crest.col && c.row === cool.crest.row)).toBe(true);
    expect(RUG_WARM.has('Emberforge')).toBe(true);
    expect(rugFor('Emberforge', () => 0.99).crest).toEqual(RED_RUG.crests[2]); // deterministic pick
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/rugs.test.ts` FAIL (module not found).

- [ ] **Step 3: Write `src/domain/rugs.ts`** — transcribe Component 1 from the spec verbatim (`RugBorderTile`, `Rug`, `border()`, `RED_RUG`, `BLUE_RUG`, `RUG_WARM`, `RUG_CHANCE`, `rugFor`).

- [ ] **Step 4: Run tests to verify pass** — `npx vitest run tests/rugs.test.ts` PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/domain/rugs.ts tests/rugs.test.ts && git commit -m "feat(rugs): themed 3x3 rug tiles + crests + rugFor"`

---

## Task 2: Place rugs in dungeon2

**Files:** Modify `src/domain/dungeon2.ts`, Test `tests/dungeon2.test.ts`
**Interfaces:** Consumes `rugFor`, `RUG_CHANCE` (rugs).

- [ ] **Step 1: Write the failing tests + relax the monster-zone test** in `tests/dungeon2.test.ts`.

Relax the existing "places decor ... clears the 2x2 monster zone" test — replace its `for (const p of d.decor) { ... }` body with:
```ts
    for (const p of d.decor) {
      expect(typeof p.walkable).toBe('boolean');
      // non-walkable props avoid the monster zone; walkable rug tiles may sit under it
      if (!p.walkable) {
        const inMonster = p.x >= mx && p.x <= mx + 1 && p.y >= my && p.y <= my + 1;
        expect(inMonster).toBe(false);
      }
    }
```

Add a new test (import `RED_RUG, BLUE_RUG` from `../src/domain/rugs`):
```ts
it('occasionally places a walkable 3x3 rug centered on the monster zone', () => {
  const W = 20, H = 15;
  const mx = Math.floor(W / 2) - 1, my = Math.floor(H / 2) - 1;
  const rx = mx - 1, ry = my - 1;
  const crestKeys = new Set([...RED_RUG.crests, ...BLUE_RUG.crests].map((c) => `${c.col},${c.row}`));
  let sawRug = false;
  for (let seed = 1; seed <= 60 && !sawRug; seed++) {
    const d = generateAutotiledDungeon('Emberforge', seed, { width: W, height: H }); // warm -> red rug
    const walk = d.decor.filter((p) => p.walkable);
    if (walk.length === 0) continue;
    sawRug = true;
    expect(walk.length).toBe(9);                     // 8 border + 1 crest
    const keys = new Set(walk.map((p) => `${p.x},${p.y}`));
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++)
      expect(keys.has(`${rx + dx},${ry + dy}`)).toBe(true);  // full 3x3 covered
    const center = walk.find((p) => p.x === rx + 1 && p.y === ry + 1)!;
    expect(crestKeys.has(`${center.col},${center.row}`)).toBe(true); // center is a crest
    for (const p of d.decor) if (!p.walkable) expect(keys.has(`${p.x},${p.y}`)).toBe(false); // no prop on rug
  }
  expect(sawRug).toBe(true); // at RUG_CHANCE 0.15, a rug appears within 60 seeds
});
```
If no seed in 1..60 places a rug (deterministic — verify by running), widen the range until one does.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/dungeon2.test.ts` FAIL (no walkable decor / rug not placed).

- [ ] **Step 3: Add the import** to `src/domain/dungeon2.ts`:
```ts
import { rugFor, RUG_CHANCE } from './rugs';
```

- [ ] **Step 4: Hoist `mx/my/inMonster` + place the rug first.** In the decor block, right after the `place` helper definition, insert:
```ts
  const mx = Math.floor(width / 2) - 1, my = Math.floor(height / 2) - 1; // monster zone (2x2) top-left
  const inMonster = (x: number, y: number) => x >= mx && x <= mx + 1 && y >= my && y <= my + 1;
  // rug centerpiece (occasional) — placed FIRST so nothing overlaps it
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

- [ ] **Step 5: Remove the now-duplicate `mx/my/inMonster`** from the floor-scatter section (they're defined above now):
```ts
  // DELETE these two lines from the floor-scatter section:
  //   const mx = Math.floor(width / 2) - 1, my = Math.floor(height / 2) - 1;
  //   const inMonster = (x: number, y: number) => x >= mx && x <= mx + 1 && y >= my && y <= my + 1;
```
Leave the rest of floor scatter (the `floorCells` build using `inMonster`/`used`) unchanged.

- [ ] **Step 6: Run tests** — `npx vitest run tests/dungeon2.test.ts` PASS (incl. the relaxed monster-zone test and the new rug test); `npm run typecheck` clean; `npx vitest run` (full) green (existing property-based decor tests unaffected by the rng-stream shift).

- [ ] **Step 7 (controller): visual pass** — force a rug (temporarily set `RUG_CHANCE = 1` in a scratch run, or use a rug-placing seed) and render a themed dungeon; confirm the rug renders as a bordered platform framing the monster, the crest peeks around the sprite, and a hero on the rug edge reads correctly. Revert any scratch change.

- [ ] **Step 8: Commit** — `git add src/domain/dungeon2.ts tests/dungeon2.test.ts && git commit -m "feat(dungeon2): occasional walkable rug centerpiece under the monster"`

---

## Self-Review

- **Spec coverage:** rug data + `rugFor` (T1); placement + monster-zone relaxation (T2). Spec §Testing maps to both tasks' tests; the visual read is the controller's pass.
- **Green at every step:** T1 is independent; T2 adds walkable rug decor (existing decor tests are property-based, and the monster-zone test is relaxed in the same task). The rng-stream shift only repositions other decor — determinism per seed holds.
- **Type consistency:** `place`'s existing param `{col,row,walkable,animB?}` accepts `{col,row,walkable:true}`; `rugFor` returns `{border, crest}` used exactly as placed; `mx/my/inMonster` defined once and reused by both the rug block and floor scatter.
- **No placeholders:** rug data is fully specified in the spec; T2 shows exact insert/delete edits.

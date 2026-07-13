# Animated Decor (Build 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the flagged decor tiles (torches, flame, cauldron, tomes, skull) flicker by threading their `animB` second-frame coords through the render payload and drawing them live on the shared clock.

**Architecture:** `animB` (already on `DecorTile`) flows `dungeon2` → `tvlayout` → the TV payload. `tv.js` bakes only static decor and draws animated decor per-frame, flipping A↔B on the `#13` shared staggered ~600ms clock.

**Tech Stack:** TypeScript ESM via `tsx` (no build), vitest. `tv.js` is dependency-free browser JS.

Spec: `docs/superpowers/specs/2026-07-12-animated-decor-design.md`. Reference: `docs/oryx_decor_reference.md`.

## Global Constraints

- **No build step.** Typecheck `npm run typecheck`; tests `npx vitest run <file>`.
- **Determinism:** no `Date.now`/`Math.random` in `src/domain/**`; `animB` is static data threaded through, no new rng draws.
- **`tv.js` reuses the existing `#13` anim clock** (`ANIM_MS`, `Math.floor((t+phase)/ANIM_MS)%2`) — no new imports (dependency-free).
- Suite stays green (baseline 237).

## File Structure

- Modify: `src/domain/dungeon2.ts` (thread `animB`), `tests/dungeon2.test.ts`
- Modify: `src/web/tvlayout.ts` (pass `animB`), `tests/tvlayout.test.ts`
- Modify: `src/web/public/tv/tv.js` (bake static only + `drawAnimDecor`)

---

## Task 1: Thread `animB` through the data path

**Files:** Modify `src/domain/dungeon2.ts`, `src/web/tvlayout.ts`, Test `tests/dungeon2.test.ts`, `tests/tvlayout.test.ts`
**Interfaces:** `AutoDungeon.decor` and the TV layout's decor cells gain `animB?: {col,row}`.

- [ ] **Step 1: Write the failing tests.**
In `tests/dungeon2.test.ts` add (it already imports `generateAutotiledDungeon`; add `SHEET`):
```ts
import { SHEET } from '../src/domain/tilesheet';
// ... inside describe('generateAutotiledDungeon', ...)
it('threads animB onto animated decor cells (in-sheet); static cells have none', () => {
  const d = generateAutotiledDungeon('Ossuary Pale', 7, { width: 20, height: 15 });
  const animated = d.decor.filter((p) => p.animB);
  expect(animated.length).toBeGreaterThan(0); // Ossuary Pale places wall torches (always) + skull/tomes
  for (const p of animated) {
    expect(Number.isInteger(p.animB!.col) && p.animB!.col >= 0 && p.animB!.col < SHEET.cols).toBe(true);
    expect(Number.isInteger(p.animB!.row) && p.animB!.row >= 0 && p.animB!.row < SHEET.rows).toBe(true);
  }
  // some cells are static (no animB) — e.g. bones/urns
  expect(d.decor.some((p) => !p.animB)).toBe(true);
});
```
In `tests/tvlayout.test.ts` add (reuse `activeDungeon()` + the theme-setting helper the file already uses):
```ts
it('preserves animB on animated decor cells in the layout', () => {
  activeDungeon();
  setTheme('Ossuary Pale');
  const L = currentTvLayout(db)!;
  expect(L.decor.some((d) => d.animB)).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/dungeon2.test.ts tests/tvlayout.test.ts` FAIL (`animB` not on decor cells).

- [ ] **Step 3: Thread `animB` in `dungeon2.ts`.**
Update the `AutoDungeon.decor` field type (line ~64):
```ts
  decor: { x: number; y: number; col: number; row: number; walkable: boolean; animB?: { col: number; row: number } }[];
```
Update the local `const decor:` annotation (line ~127) to the same element type. Update the `place` helper (line ~133) to thread `animB`:
```ts
  const place = (x: number, y: number, t: { col: number; row: number; walkable: boolean; animB?: { col: number; row: number } }) => {
    decor.push({ x, y, col: t.col, row: t.row, walkable: t.walkable, animB: t.animB }); used.add(`${x},${y}`);
  };
```
(`at2(pools.*)` already returns a `DecorTile` carrying `animB`, so the value flows through.)

- [ ] **Step 4: Pass `animB` in `tvlayout.ts`.**
Add `animB?: { col: number; row: number }` to the `TvLayout.decor` element type (the interface field, line ~18). Update the passthrough map (line ~90):
```ts
  const decor = auto.decor.map((p) => ({ x: p.x, y: p.y, col: p.col, row: p.row, animB: p.animB }));
```

- [ ] **Step 5: Run tests** — `npx vitest run tests/dungeon2.test.ts tests/tvlayout.test.ts` PASS; `npm run typecheck` clean; `npx vitest run` (full) green.
- [ ] **Step 6: Commit** — `git add src/domain/dungeon2.ts src/web/tvlayout.ts tests/dungeon2.test.ts tests/tvlayout.test.ts && git commit -m "feat(decor): thread animB frame through the render payload"`

---

## Task 2: Live-render animated decor in `tv.js`

**Files:** Modify `src/web/public/tv/tv.js`
No unit test (Canvas) — controller verifies via headless screenshots.

- [ ] **Step 1: Bake only static decor** — in `buildBackground`, change the decor loop (line ~118):
```js
    for (const d of layout.decor) if (!d.animB) put(d.col, d.row, d.x, d.y);
```

- [ ] **Step 2: Add `drawAnimDecor(t)`** — near the other draw helpers:
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

- [ ] **Step 3: Call it in `render(t)`** — after the `if (bg) { ... }` block and before `if (state) {`:
```js
  drawAnimDecor(t);
```
(The panel's `ctx.shadow*` is restored by then, so animated decor draws with no drop shadow, above the floor/static-decor and below the actors.)

- [ ] **Step 4: Verify** — `node --check src/web/public/tv/tv.js` parses; `npx vitest run` and `npm run typecheck` green (237). Then the controller renders a themed dungeon with torches (e.g. Ossuary Pale / Bloodstone Cairn) and screenshots at two clock phases (virtual-time budgets ~2000ms vs ~2600ms, per the #13 method) to confirm a torch/cauldron shows on **different frames** between the two shots (proving the flicker), while static props (bones/urns) are identical.
- [ ] **Step 5: Commit** — `git add src/web/public/tv/tv.js && git commit -m "feat(tv): animate decor (torches/cauldron/tomes/skull) on the shared clock"`

---

## Self-Review

- **Spec coverage:** `animB` threading dungeon2→tvlayout (T1); bake-split + live render (T2). Spec §Testing maps to T1's unit tests + T2's visual check.
- **Green at every step:** T1 adds an optional field consumed only where added (tvlayout map + tests); T2 is display-only. Both compile independently.
- **Type consistency:** `animB?: {col,row}` identical on `DecorTile`, `AutoDungeon.decor`, and the TV layout decor; `drawAnimDecor` reads `d.animB.col/row`; reuses `ANIM_MS`/`TILE`/`panelX`/`panelY`/`tilePx` globals.
- **No placeholders:** exact before/after for every change; the animated-tile coords come from the already-shipped `decor.ts` (`animB`).

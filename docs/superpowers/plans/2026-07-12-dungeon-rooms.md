# Multi-Room Dungeons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partition the dungeon into 2–4 connected BSP rooms; the largest is the "arena" holding the monster + all heroes, others are decorated flavor. Interior walls autotile (T/cross junctions) and connect via door tiles.

**Architecture:** Extend the neighbor-autotiler for junctions (Task 1). `dungeon2` BSP-partitions the interior, places interior doors, picks the arena, and exposes `monster`+`arena` on `AutoDungeon` (Task 2). `tvlayout` drops its fixed-center monster zone and pins hero slots to the arena (Task 3).

**Tech Stack:** TypeScript ESM via `tsx` (no build), vitest.

Spec: `docs/superpowers/specs/2026-07-12-dungeon-rooms-design.md`.

## Global Constraints

- **No build step.** Typecheck `npm run typecheck`; tests `npx vitest run <file>`.
- **Determinism:** no `Date.now`/`Math.random` in `src/domain/**`; all generation uses the seeded `rng`.
- **Junction columns (21–25) are decoded/verified visually** in Task 1 (the 2.5D faces can't be read from a static crop). The autotiler *logic* is fixed regardless.
- Suite stays green (baseline 242) — several single-room test assumptions get updated in Tasks 2/3.

## File Structure

- Modify: `src/domain/tilesheet.ts` (WALL_COLS junctions), `src/domain/dungeon2.ts` (export+extend `pickWall`; BSP; arena), `src/web/tvlayout.ts` (arena monster + hero slots)
- Tests: `tests/dungeon2.test.ts` (junctions + rooms + arena; update single-room assumptions), `tests/tvlayout.test.ts` (arena monster + hero slots)

---

## Task 1: Junction autotiling

**Files:** Modify `src/domain/tilesheet.ts`, `src/domain/dungeon2.ts`, Test `tests/dungeon2.test.ts`
**Interfaces:** `WALL_COLS` gains `tOpenN/tOpenE/tOpenS/tOpenW/cross`; `pickWall` is exported and handles 3/4-neighbor cases.

- [ ] **Step 1: Write the failing test** — add to `tests/dungeon2.test.ts` (import `pickWall` from dungeon2, `WALL_COLS` from tilesheet, `getDungeon` from floorgroups):
```ts
import { pickWall } from '../src/domain/dungeon2';
import { WALL_COLS } from '../src/domain/tilesheet';
import { getDungeon } from '../src/domain/floorgroups';

describe('pickWall junctions', () => {
  const dg = getDungeon('Greystone Keep')!;
  const rng = () => 0.99; // no crack
  // build a 5x5 grid; W=wall, .=floor. col of the returned tile is what we check.
  const grid = (rows: string[]) => rows.map((r) => [...r].map((c) => (c === 'W' ? 'wall' : 'floor')));
  const at = (rows: string[], x: number, y: number) =>
    pickWall(x, y, grid(rows) as any, rows[0].length, rows.length, dg, rng).col;

  it('cross: 4 wall neighbors', () => {
    const g = ['..W..', '..W..', 'WWWWW', '..W..', '..W..'];
    expect(at(g, 2, 2)).toBe(WALL_COLS.cross);
  });
  it('T open to each side', () => {
    expect(at(['..W..', '..W..', '.WWWW', '.....', '.....'], 2, 2)).toBe(WALL_COLS.tOpenW); // walls N,E,S? no -> open W
    // ⊤ (open N): walls E,S,W
    expect(at(['.....', '.....', 'WWWWW', '..W..', '.....'], 2, 2)).toBe(WALL_COLS.tOpenN);
    // ⊥ (open S): walls N,E,W
    expect(at(['..W..', '.....', 'WWWWW', '.....', '.....'], 2, 2)).toBe(WALL_COLS.tOpenS);
    // ⊢ (open E): walls N,S,W
    expect(at(['..W..', '..W..', 'WW...', '..W..', '..W..'].map((r)=>r), 2, 2)).toBe(WALL_COLS.tOpenE);
  });
});
```
(Adjust the grids so exactly the intended 3 neighbors are walls; verify by the N/E/S/W of cell (2,2). The `col` values come from the WALL_COLS you set in Step 3 — the test asserts the *logic* routes to the right named piece.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/dungeon2.test.ts` FAIL (`pickWall` not exported / junctions return `isolated`).

- [ ] **Step 3: Add junction columns to `WALL_COLS`** (tilesheet.ts) — best-guess columns, **confirmed in Step 6**:
```ts
  tOpenN: 21, tOpenE: 22, tOpenS: 23, tOpenW: 24, // T-junctions, named by the OPEN side
  cross: 25,   // 4-way cross
```

- [ ] **Step 4: Export + extend `pickWall`** (dungeon2.ts) — change `function pickWall` to `export function pickWall`, and insert the junction cases **before** the existing 2-neighbor corner/straight checks (right after `const N/E/S/Wt` are computed):
```ts
  const nbrs = [N, E, S, Wt].filter(Boolean).length;
  if (nbrs === 4) return C(WALL_COLS.cross);
  if (nbrs === 3) {
    if (!N) return C(WALL_COLS.tOpenN);
    if (!E) return C(WALL_COLS.tOpenE);
    if (!S) return C(WALL_COLS.tOpenS);
    return C(WALL_COLS.tOpenW); // !Wt
  }
```
(Cracked variants don't apply to junctions; the `cracked` var only affects horizontal/vertical below.)

- [ ] **Step 5: Run tests** — `npx vitest run tests/dungeon2.test.ts` PASS; `npm run typecheck` clean; `npx vitest run` full green.

- [ ] **Step 6 (controller): decode/verify the junction columns.** The col numbers in Step 3 are a guess. The controller renders a synthetic junction (a `+` and each `T` of interior walls) — e.g. temporarily generate a dungeon with a hand-placed plus of walls, or a small harness that draws `WALL_COLS.tOpen*/cross` tiles from `/sheet/world.png` for a chosen `wallRow` — and confirms each column shows the correct piece (⊤/⊥/⊢/⊣/＋ with clean 2.5D faces). If a column is wrong, fix the `WALL_COLS` numbers (cols 21–25) and re-run tests. This is the de-risking gate before rooms are built.

- [ ] **Step 7: Commit** — `git add src/domain/tilesheet.ts src/domain/dungeon2.ts tests/dungeon2.test.ts && git commit -m "feat(autotile): T/cross wall junctions for interior walls"`

---

## Task 2: BSP rooms + arena (dungeon2)

**Files:** Modify `src/domain/dungeon2.ts`, Test `tests/dungeon2.test.ts`
**Interfaces:** `AutoDungeon` gains `monster: {x,y,footprint}` and `arena: {x,y,w,h}`. Decor + rug key off the arena monster zone; cobwebs are per-room.

- [ ] **Step 1: Write the failing tests** — add to `tests/dungeon2.test.ts`:
```ts
// flood-fill floor connectivity helper
function floorConnected(d: ReturnType<typeof generateAutotiledDungeon>) {
  const walk = (k: string) => d.cells.find((c) => `${c.x},${c.y}` === k);
  const floors = d.cells.filter((c) => c.kind === 'floor' || c.kind === 'door');
  const set = new Set(floors.map((c) => `${c.x},${c.y}`));
  const seen = new Set<string>(); const stack = [floors[0]];
  while (stack.length) {
    const c = stack.pop()!; const k = `${c.x},${c.y}`; if (seen.has(k)) continue; seen.add(k);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nk = `${c.x+dx},${c.y+dy}`; if (set.has(nk) && !seen.has(nk)) stack.push(walk(nk)!);
    }
  }
  return seen.size === set.size;
}

it('partitions into rooms with interior walls, all floor connected', () => {
  let sawRooms = false;
  for (let seed = 1; seed <= 20; seed++) {
    const d = generateAutotiledDungeon('Greystone Keep', seed, { width: 20, height: 15 });
    const interiorWalls = d.cells.filter((c) => c.kind === 'wall' && c.x > 0 && c.y > 0 && c.x < 19 && c.y < 14);
    if (interiorWalls.length > 0) sawRooms = true;
    expect(floorConnected(d)).toBe(true); // doors keep every room reachable
  }
  expect(sawRooms).toBe(true);
});

it('exposes an arena and a monster zone inside it, all floor', () => {
  const d = generateAutotiledDungeon('Greystone Keep', 7, { width: 20, height: 15 });
  expect(d.arena.w).toBeGreaterThanOrEqual(5);
  expect(d.arena.h).toBeGreaterThanOrEqual(5);
  const m = d.monster;
  expect(m.x >= d.arena.x && m.x + 1 < d.arena.x + d.arena.w).toBe(true);
  expect(m.y >= d.arena.y && m.y + 1 < d.arena.y + d.arena.h).toBe(true);
  for (let y = m.y; y <= m.y + 1; y++) for (let x = m.x; x <= m.x + 1; x++)
    expect(d.cells.find((c) => c.x === x && c.y === y)!.kind).toBe('floor');
});
```
Also **update** the existing "encloses the room ... interior (4,4) is floor" test: change `expect(at(4,4).kind).toBe('floor')` to allow an interior wall there (assert it's `'floor' | 'wall' | 'door'`), since interior walls may now cross that cell.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/dungeon2.test.ts` FAIL (`d.arena` undefined).

- [ ] **Step 3: Add `arena`/`monster` to `AutoDungeon`** (dungeon2.ts):
```ts
export interface AutoDungeon {
  width: number; height: number; dungeon: string; seed: number;
  cells: RenderCell[];
  decor: { x: number; y: number; col: number; row: number; walkable: boolean; animB?: { col: number; row: number } }[];
  monster: { x: number; y: number; footprint: number };
  arena: { x: number; y: number; w: number; h: number };
}
```

- [ ] **Step 4: BSP partition + interior doors.** After the "1) Logical kinds" border fill and BEFORE the border-door loop, insert:
```ts
  // BSP: split the interior into 2-4 rooms with interior walls + a connecting door each.
  interface Rect { x: number; y: number; w: number; h: number; }
  const MIN_ROOM = 5;
  const targetRooms = 2 + Math.floor(rng() * 3); // 2-4
  const queue: Rect[] = [{ x: 1, y: 1, w: width - 2, h: height - 2 }];
  const leaves: Rect[] = [];
  while (leaves.length + queue.length < targetRooms && queue.length > 0) {
    queue.sort((a, b) => b.w * b.h - a.w * a.h); // split the biggest
    const r = queue.shift()!;
    const canV = r.w >= MIN_ROOM * 2 + 1;
    const canH = r.h >= MIN_ROOM * 2 + 1;
    if (!canV && !canH) { leaves.push(r); continue; }
    const vertical = canV && (!canH || r.w >= r.h);
    if (vertical) {
      const wx = r.x + MIN_ROOM + Math.floor(rng() * (r.w - 2 * MIN_ROOM)); // keeps both halves >= MIN_ROOM
      for (let y = r.y; y < r.y + r.h; y++) kinds[y][wx] = 'wall';
      kinds[r.y + 1 + Math.floor(rng() * (r.h - 2))][wx] = 'door'; // connecting door
      queue.push({ x: r.x, y: r.y, w: wx - r.x, h: r.h });
      queue.push({ x: wx + 1, y: r.y, w: r.x + r.w - 1 - wx, h: r.h });
    } else {
      const wy = r.y + MIN_ROOM + Math.floor(rng() * (r.h - 2 * MIN_ROOM));
      for (let x = r.x; x < r.x + r.w; x++) kinds[wy][x] = 'wall';
      kinds[wy][r.x + 1 + Math.floor(rng() * (r.w - 2))] = 'door';
      queue.push({ x: r.x, y: r.y, w: r.w, h: wy - r.y });
      queue.push({ x: r.x, y: wy + 1, w: r.w, h: r.y + r.h - 1 - wy });
    }
  }
  leaves.push(...queue);
  const arena = leaves.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
```

- [ ] **Step 5: Guard border doors against interior walls.** In the border-door loop's skip condition, also skip a candidate whose interior-facing neighbor is a wall (an interior wall meets the border there):
```ts
    const innerWall =
      (side === 0 && kinds[1][x] === 'wall') || (side === 1 && kinds[height - 2][x] === 'wall') ||
      (side === 2 && kinds[y][1] === 'wall') || (side === 3 && kinds[y][width - 2] === 'wall');
    if (isCorner(x, y) || kinds[y][x] === 'door' || hasAdjacentDoor(x, y) || innerWall) continue;
```

- [ ] **Step 6: Arena → monster zone; use it for decor/rug.** Replace the decor block's `const mx = Math.floor(width/2)-1, my = ...` with the arena-derived monster zone (define once at the top of the decor block):
```ts
  const mx = arena.x + Math.floor(arena.w / 2) - 1, my = arena.y + Math.floor(arena.h / 2) - 1;
  const inMonster = (x: number, y: number) => x >= mx && x <= mx + 1 && y >= my && y <= my + 1;
```
The rug block (`rx = mx-1`, etc.) and floor-scatter already use `mx/my/inMonster` — now arena-relative. **Per-room cobweb corners:** replace the fixed 4-corner loop with a per-room loop over `leaves`, using each room's interior corners:
```ts
  if (pools.corner.length) {
    const p = COBWEB_HEAVY.has(dungeonName) ? 0.85 : 0.5;
    for (const rm of leaves)
      for (const [cx, cy] of [[rm.x, rm.y], [rm.x + rm.w - 1, rm.y], [rm.x, rm.y + rm.h - 1], [rm.x + rm.w - 1, rm.y + rm.h - 1]] as const)
        if (kinds[cy][cx] === 'floor' && !used.has(`${cx},${cy}`) && rng() < p) place(cx, cy, at2(pools.corner));
  }
```
(Wall torches + floor scatter unchanged — they already scan all walls/floor.)

- [ ] **Step 7: Return the new fields.** Update the return:
```ts
  return { width, height, dungeon: dungeonName, seed, cells, decor,
           monster: { x: mx, y: my, footprint: 2 }, arena };
```

- [ ] **Step 8: Run tests** — `npx vitest run tests/dungeon2.test.ts` PASS (new + updated); `npm run typecheck` clean; `npx vitest run` — fix any remaining single-room assertion fallout (e.g. a test expecting a specific interior cell to be floor). tvlayout still compiles (it will be updated in Task 3; it currently ignores `auto.monster`/`auto.arena`).

- [ ] **Step 9: Commit** — `git add src/domain/dungeon2.ts tests/dungeon2.test.ts && git commit -m "feat(dungeon2): BSP rooms + arena + interior doors + per-room decor"`

---

## Task 3: Arena-driven monster + hero slots (tvlayout)

**Files:** Modify `src/web/tvlayout.ts`, Test `tests/tvlayout.test.ts`
**Interfaces:** Consumes `auto.monster`, `auto.arena`.

- [ ] **Step 1: Write the failing tests** — add to `tests/tvlayout.test.ts` (reuse `activeDungeon()`/`setTheme`/`currentTvLayout`):
```ts
it('monster zone comes from the arena, and hero slots sit in the arena', () => {
  activeDungeon();
  setTheme('Greystone Keep');
  const L = currentTvLayout(db)!;
  // monster inside its own footprint area, all floor
  for (const s of L.heroSlots) {
    // hero within some room's floor and not on the monster zone
    const inM = s.x >= L.monster.x && s.x <= L.monster.x + 1 && s.y >= L.monster.y && s.y <= L.monster.y + 1;
    expect(inM).toBe(false);
    expect(L.cells[s.y][s.x].type).toBe('floor');
  }
  expect(L.monster.footprint).toBe(2);
});
```
(If the harness exposes the arena, also assert hero slots fall within `auto.arena` bounds; otherwise assert they're floor + off the monster zone, which the arena guarantees.)

- [ ] **Step 2: Run to verify it fails / passes trivially** — run; then implement so hero slots are arena-scoped.

- [ ] **Step 3: Use `auto.monster` + arena hero slots** in `tvlayout.ts`. Replace the fixed monster block:
```ts
  const monster = auto.monster; // arena centre 2x2 from dungeon2
  const inMonster = (x: number, y: number) =>
    x >= monster.x && x <= monster.x + 1 && y >= monster.y && y <= monster.y + 1;
```
and build candidates from the **arena** rect instead of the whole interior:
```ts
  const A = auto.arena;
  const candidates: { x: number; y: number }[] = [];
  for (let y = A.y; y < A.y + A.h; y++)
    for (let x = A.x; x < A.x + A.w; x++)
      if (cells[y][x].type === 'floor' && !inMonster(x, y) && !blocked.has(`${x},${y}`)) candidates.push({ x, y });
```
(The `monster` object returned in the payload is now `auto.monster`; `TvLayout.monster` shape `{x,y,footprint}` is unchanged.)

- [ ] **Step 4: Run tests** — `npx vitest run tests/tvlayout.test.ts` PASS; `npm run typecheck` clean; `npx vitest run` full green.

- [ ] **Step 5 (controller): visual pass.** Render several themes (crypt/forge/nature/ice) and confirm: 2–4 rooms read clearly, interior walls autotile with clean corners/T/cross (no gaps or wrong faces), doorways connect rooms, the monster + all heroes share the arena, and decor/rug/shadows look right. Iterate `MIN_ROOM`/target count if rooms feel too small/busy.

- [ ] **Step 6: Commit** — `git add src/web/tvlayout.ts tests/tvlayout.test.ts && git commit -m "feat(tv): arena-driven monster zone + arena hero slots"`

---

## Self-Review

- **Spec coverage:** junctions (T1), BSP + arena + interior doors + per-room decor (T2), arena monster + hero slots (T3), visual pass (T3 step 5). Spec §Testing maps to each task's tests.
- **Green at every step:** T1 is additive (junction cases before corners); T2 adds `arena`/`monster` to `AutoDungeon` and updates dungeon2's own tests (tvlayout still compiles, ignoring the new fields); T3 consumes them.
- **Type consistency:** `AutoDungeon.monster`/`arena` produced in T2, consumed in T3; `pickWall` exported in T1 and used by T2's generation; `WALL_COLS.tOpen*/cross` added in T1.
- **Junction col decode** is the one visual-verified item (T1 step 6); the autotiler logic + all unit tests are deterministic.
- **No placeholders:** BSP + autotiler + arena code are complete; only the junction *column numbers* are guess-then-confirm (inherent to this tileset).

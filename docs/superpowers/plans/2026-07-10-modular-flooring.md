# Modular Flooring System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple dungeon floors from wall themes — replace the 4 floor-bundled `Skin`s with a global 38-group floor registry routed to 22 dungeon types by a compatibility map, driven by the `oryx_flooring_package` authored data.

**Architecture:** Copy the package JSON into the source tree and load it through a typed adapter (`floorgroups.ts`) that exposes `FLOOR_GROUPS`, `DUNGEONS`, `COMPAT`, and pure functions `chooseGroup` (tier-weighted pick) + `pickCell` (main-blend, rare-glow-accent fill). `dungeon2.ts` composes a dungeon from a dungeon name + seed; `tilesheet.ts` is trimmed to wall/door/sheet primitives. Preview-only: `/dungeon-preview` renders it; live `/tv` is untouched.

**Tech Stack:** TypeScript (ESM, run via `tsx`, no build step), vitest, Express/EJS, better-sqlite3 (unaffected).

## Global Constraints

- **ESM, extensionless relative imports.** `"type":"module"`; no build step (run TS via `tsx`).
- **Determinism.** Core domain functions take an injected `rng: () => number` (seeded mulberry32 via `makeRng` in `src/domain/dungeon.ts`). No `Date.now()` / `Math.random()` in domain code. Same `(dungeonName, seed)` → identical dungeon.
- **Coordinates.** A sheet tile is `{col, row}` (`TileCoord`); sheet col = `rect[0]/24`, row = `rect[1]/24`. Sheet is 56×41 tiles, 24px each. Floor tiles occupy cols 4–7, rows 1–23.
- **Keep green.** After every task, `npm run typecheck` and `npx vitest run` must both pass. Tasks are ordered so no intermediate commit breaks the build.
- **Async Express handlers** must be wrapped with `asyncHandler` (existing pattern). Preview stays behind `config.enableDungeonPreview` (`ENABLE_DUNGEON_PREVIEW=1`).
- **Source of truth** for floor data = the JSON copied into `src/domain/floordata/`. Package provenance lives in `docs/superpowers/specs/2026-07-10-modular-flooring-design.md`.

## File Structure

- Create `src/domain/floordata/{dungeons,floor_groups,floor_compatibility}.json` — authored data (copied).
- Create `src/domain/floorgroups.ts` — data adapter + `chooseGroup` + `pickCell`.
- Create `tests/floorgroups-load.test.ts`, `tests/floorgroups-route.test.ts`, `tests/floorgroups-fill.test.ts`.
- Modify `src/domain/autotile.ts` — decouple `resolveFloor`/`resolveDoor` from `Skin`.
- Modify `src/domain/tilesheet.ts` — remove `Skin`/`FloorSet`/`SKINS`/`CASTLE_FLOORS`/`getSkin`.
- Modify `src/domain/dungeon2.ts` — generate from `DUNGEONS` + `chooseGroup` + `pickCell`.
- Modify `src/web/routes/dungeon-preview.ts` and `src/web/views/dungeon-preview.ejs`.
- Modify tests: `tests/autotile.test.ts`, `tests/tilesheet.test.ts`, `tests/dungeon2.test.ts`.
- Modify `.gitignore`.

---

### Task 1: Vendor the package data into the source tree

**Files:**
- Create: `src/domain/floordata/dungeons.json`, `src/domain/floordata/floor_groups.json`, `src/domain/floordata/floor_compatibility.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: three JSON files at `src/domain/floordata/` (runtime source of truth), loadable via `new URL('./floordata/<file>', import.meta.url)`.

- [ ] **Step 1: Copy the three data files**

```bash
mkdir -p src/domain/floordata
cp docs/oryx_flooring_package/data/dungeons.json src/domain/floordata/dungeons.json
cp docs/oryx_flooring_package/data/floor_groups.json src/domain/floordata/floor_groups.json
cp docs/oryx_flooring_package/data/floor_compatibility.json src/domain/floordata/floor_compatibility.json
```

- [ ] **Step 2: Verify the copies parse and have the expected shape**

Run:
```bash
node -e "const g=require('./src/domain/floordata/floor_groups.json').groups; const d=require('./src/domain/floordata/dungeons.json').styles; const c=require('./src/domain/floordata/floor_compatibility.json').groups; console.log(g.length, d.length, c.length)"
```
Expected: `38 23 38`

- [ ] **Step 3: Gitignore the bulky raw import package**

The `docs/oryx_flooring_package/` dir carries a 1.3MB sprite that duplicates the already-ignored `assets/` sheet; the runtime data now lives in `src/domain/floordata/`. Append to `.gitignore`:

```
# raw flooring import (data vendored into src/domain/floordata; provenance in the spec)
docs/oryx_flooring_package/
```

- [ ] **Step 4: Commit**

```bash
git add src/domain/floordata/ .gitignore
git commit -m "feat(floors): vendor oryx flooring package data into src"
```

---

### Task 2: Floor-data adapter — load, type, and expose the registries

**Files:**
- Create: `src/domain/floorgroups.ts`
- Test: `tests/floorgroups-load.test.ts`

**Interfaces:**
- Consumes: `pickWeighted`, `type TileCoord` from `./tilesheet` (existing exports); JSON from `./floordata/`.
- Produces:
  - `interface FloorTile extends TileCoord { hint: string; isGlow: boolean }`
  - `interface FloorGroup { handle: string; name: string; mains: FloorTile[]; accents: FloorTile[] }`
  - `interface Dungeon { name: string; dungeonId: number; wallRow: number; wallVariantChance: number; decor: TileCoord[] }`
  - `interface Compat { home: string; great: string[]; good: string[]; feature: string[] }`
  - `const FLOOR_GROUPS: FloorGroup[]` (38), `const DUNGEONS: Dungeon[]` (22), `const COMPAT: Record<string, Compat>`
  - `getDungeon(name: string): Dungeon | undefined`

- [ ] **Step 1: Write the failing test**

Create `tests/floorgroups-load.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FLOOR_GROUPS, DUNGEONS, COMPAT, getDungeon } from '../src/domain/floorgroups';

describe('floor data loads from the vendored package JSON', () => {
  it('has 38 floor groups, each with >=1 main', () => {
    expect(FLOOR_GROUPS.length).toBe(38);
    for (const g of FLOOR_GROUPS) expect(g.mains.length).toBeGreaterThanOrEqual(1);
  });

  it('has 22 dungeons, excluding #17 Homestead Pickets; wallRow == dungeonId', () => {
    expect(DUNGEONS.length).toBe(22);
    expect(DUNGEONS.find((d) => d.name === 'Homestead Pickets')).toBeUndefined();
    expect(getDungeon('Greystone Keep')).toMatchObject({ dungeonId: 1, wallRow: 1 });
    expect(getDungeon('Bloodstone Cairn')).toMatchObject({ dungeonId: 23, wallRow: 23 });
    expect(DUNGEONS.every((d) => d.wallRow === d.dungeonId)).toBe(true);
  });

  it('every floor tile lands in sheet cols 4-7, rows 1-23', () => {
    for (const g of FLOOR_GROUPS)
      for (const t of [...g.mains, ...g.accents]) {
        expect(t.col).toBeGreaterThanOrEqual(4);
        expect(t.col).toBeLessThanOrEqual(7);
        expect(t.row).toBeGreaterThanOrEqual(1);
        expect(t.row).toBeLessThanOrEqual(23);
      }
  });

  it('flags glow tiles via the GLOW hint (a glow MAIN is allowed; cinder glow is an accent)', () => {
    const auric = FLOOR_GROUPS.find((g) => g.handle === 'auric_glow')!;
    expect(auric.mains[0].isGlow).toBe(true);
    const cinder = FLOOR_GROUPS.find((g) => g.handle === 'cinder_rock')!;
    expect(cinder.accents.some((a) => a.isGlow)).toBe(true);
    expect(cinder.mains.every((m) => !m.isGlow)).toBe(true);
    const grey = FLOOR_GROUPS.find((g) => g.handle === 'greystone_flag')!;
    expect(grey.mains[0]).toMatchObject({ col: 4, row: 1, isGlow: false });
    expect(grey.accents[0]).toMatchObject({ col: 6, row: 1 });
  });

  it('COMPAT is keyed by handle', () => {
    expect(COMPAT['greystone_flag'].home).toBe('Greystone Keep');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/floorgroups-load.test.ts`
Expected: FAIL — cannot resolve `../src/domain/floorgroups`.

- [ ] **Step 3: Write the adapter**

Create `src/domain/floorgroups.ts`:

```ts
import { readFileSync } from 'node:fs';
import { pickWeighted, type TileCoord } from './tilesheet';

// ---- raw JSON shapes (only the fields we use) ----
interface RawTile { rect: [number, number, number, number]; hint: string; is_cross_ref: boolean }
interface RawGroup { handle: string; name: string; mains: RawTile[]; accents: RawTile[] }
interface RawCompat { handle: string; home: string; great: string[]; good: string[]; feature: string[] }
interface RawDungeon { id: number; name: string }

const load = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`./floordata/${file}`, import.meta.url), 'utf8')) as T;

// ---- public types ----
export interface FloorTile extends TileCoord { hint: string; isGlow: boolean }
export interface FloorGroup { handle: string; name: string; mains: FloorTile[]; accents: FloorTile[] }
export interface Dungeon {
  name: string; dungeonId: number; wallRow: number; wallVariantChance: number; decor: TileCoord[];
}
export interface Compat { home: string; great: string[]; good: string[]; feature: string[] }

// A tile is "glow" (emissive, use sparingly) when its hint mentions GLOW.
const toTile = (t: RawTile): FloorTile => ({
  col: t.rect[0] / 24, row: t.rect[1] / 24, hint: t.hint, isGlow: /GLOW/.test(t.hint),
});

export const FLOOR_GROUPS: FloorGroup[] = load<{ groups: RawGroup[] }>('floor_groups.json').groups.map(
  (g) => ({ handle: g.handle, name: g.name, mains: g.mains.map(toTile), accents: g.accents.map(toTile) }),
);

export const COMPAT: Record<string, Compat> = Object.fromEntries(
  load<{ groups: RawCompat[] }>('floor_compatibility.json').groups.map(
    (c) => [c.handle, { home: c.home, great: c.great, good: c.good, feature: c.feature }],
  ),
);

// #17 Homestead Pickets is a fence-prop row, not a tiling dungeon (README excludes it).
const EXCLUDED_DUNGEON_IDS = new Set([17]);
const WALL_VARIANT_CHANCE = 0.1;

// A band's sheet row index IS its dungeon_id, so wallRow = id.
export const DUNGEONS: Dungeon[] = load<{ styles: RawDungeon[] }>('dungeons.json').styles
  .filter((d) => !EXCLUDED_DUNGEON_IDS.has(d.id))
  .map((d) => ({
    name: d.name, dungeonId: d.id, wallRow: d.id, wallVariantChance: WALL_VARIANT_CHANCE, decor: [],
  }));

const DUNGEON_BY_NAME = new Map(DUNGEONS.map((d) => [d.name, d]));
export const getDungeon = (name: string): Dungeon | undefined => DUNGEON_BY_NAME.get(name);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/floorgroups-load.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: clean).

```bash
git add src/domain/floorgroups.ts tests/floorgroups-load.test.ts
git commit -m "feat(floors): typed adapter for floor groups + dungeons + compat"
```

---

### Task 3: Compatibility routing — `chooseGroup`

**Files:**
- Modify: `src/domain/floorgroups.ts`
- Test: `tests/floorgroups-route.test.ts`

**Interfaces:**
- Consumes: `FLOOR_GROUPS`, `COMPAT`, `DUNGEONS` (Task 2); `pickWeighted` from `./tilesheet`.
- Produces: `chooseGroup(dungeonName: string, rng: () => number): FloorGroup` — tier-weighted pick from eligible groups; throws for an unknown/ineligible dungeon.

- [ ] **Step 1: Write the failing test**

Create `tests/floorgroups-route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chooseGroup, DUNGEONS, COMPAT, FLOOR_GROUPS } from '../src/domain/floorgroups';
import { makeRng } from '../src/domain/dungeon';

describe('chooseGroup', () => {
  it('finds an eligible group for every one of the 22 dungeons', () => {
    for (const d of DUNGEONS) {
      const g = chooseGroup(d.name, makeRng(1));
      const c = COMPAT[g.handle];
      expect([c.home, ...c.great, ...c.good, ...c.feature]).toContain(d.name);
    }
  });

  it('covers Wintermarch Keep, which has no home group', () => {
    expect(FLOOR_GROUPS.some((g) => COMPAT[g.handle].home === 'Wintermarch Keep')).toBe(false);
    expect(() => chooseGroup('Wintermarch Keep', makeRng(3))).not.toThrow();
  });

  it('is deterministic for a fixed rng seed', () => {
    expect(chooseGroup('Emberforge', makeRng(42)).handle)
      .toBe(chooseGroup('Emberforge', makeRng(42)).handle);
  });

  it('throws for an unknown dungeon', () => {
    expect(() => chooseGroup('Nowhere', makeRng(1))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/floorgroups-route.test.ts`
Expected: FAIL — `chooseGroup` is not exported.

- [ ] **Step 3: Implement `chooseGroup`**

Append to `src/domain/floorgroups.ts`:

```ts
// Tier weights from the package's tiers_weight_suggestion: home best, feature rarest.
const TIER_WEIGHTS = { home: 6, great: 5, good: 2, feature: 1 } as const;

// Pick ONE floor group for a dungeon: gather every group whose compat lists this
// dungeon in any tier, then weighted-pick by that tier. One group per dungeon keeps
// a room's floor cohesive; variety comes between dungeons.
export function chooseGroup(dungeonName: string, rng: () => number): FloorGroup {
  const eligible: { group: FloorGroup; weight: number }[] = [];
  for (const g of FLOOR_GROUPS) {
    const c = COMPAT[g.handle];
    if (!c) continue;
    const weight =
      c.home === dungeonName ? TIER_WEIGHTS.home :
      c.great.includes(dungeonName) ? TIER_WEIGHTS.great :
      c.good.includes(dungeonName) ? TIER_WEIGHTS.good :
      c.feature.includes(dungeonName) ? TIER_WEIGHTS.feature : 0;
    if (weight > 0) eligible.push({ group: g, weight });
  }
  if (eligible.length === 0) throw new Error(`no eligible floor group for dungeon: ${dungeonName}`);
  return pickWeighted(eligible, rng).group;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/floorgroups-route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: clean).

```bash
git add src/domain/floorgroups.ts tests/floorgroups-route.test.ts
git commit -m "feat(floors): tier-weighted chooseGroup routing"
```

---

### Task 4: Cell fill — `pickCell` + `mainTile`

**Files:**
- Modify: `src/domain/floorgroups.ts`
- Test: `tests/floorgroups-fill.test.ts`

**Interfaces:**
- Consumes: `FLOOR_GROUPS`, `FloorGroup`, `FloorTile` (Task 2).
- Produces:
  - `pickCell(group: FloorGroup, rng: () => number): FloorTile` — per-cell fill: blends mains, sprinkles normal accents (~6%), glow accents rarely (~1%).
  - `mainTile(group: FloorGroup): FloorTile` — a representative base tile (for door underlays).

- [ ] **Step 1: Write the failing test**

Create `tests/floorgroups-fill.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickCell, mainTile, FLOOR_GROUPS } from '../src/domain/floorgroups';
import { makeRng } from '../src/domain/dungeon';

const byHandle = (h: string) => FLOOR_GROUPS.find((g) => g.handle === h)!;

describe('pickCell', () => {
  it('blends multiple mains across cells (wildroot_gravel has 3)', () => {
    const g = byHandle('wildroot_gravel');
    expect(g.mains.length).toBe(3);
    const rng = makeRng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) { const t = pickCell(g, rng); seen.add(`${t.col},${t.row}`); }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('a single-main no-accent group always returns that main', () => {
    const g = byHandle('greystone_tile'); // 1 main, 0 accents
    const rng = makeRng(9);
    for (let i = 0; i < 100; i++) expect(pickCell(g, rng)).toEqual(g.mains[0]);
  });

  it('keeps glow accents rare (cinder_rock < 3% over many cells, but present)', () => {
    const g = byHandle('cinder_rock'); // 2 non-glow mains, 2 glow accents
    const rng = makeRng(11);
    let glow = 0; const N = 5000;
    for (let i = 0; i < N; i++) if (pickCell(g, rng).isGlow) glow++;
    expect(glow / N).toBeLessThan(0.03);
    expect(glow).toBeGreaterThan(0);
  });

  it('mainTile returns a base tile', () => {
    const g = byHandle('greystone_flag');
    expect(mainTile(g)).toEqual(g.mains[0]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/floorgroups-fill.test.ts`
Expected: FAIL — `pickCell` / `mainTile` not exported.

- [ ] **Step 3: Implement the fill**

Append to `src/domain/floorgroups.ts`:

```ts
const ACCENT_RATE = 0.06; // normal detail accents per cell
const GLOW_RATE = 0.01;   // emissive glow accents per cell (rarer)
const at = <T>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];

// One floor cell: usually a random main (mains blend for natural variation);
// occasionally a normal accent; rarely a glow accent. A glow MAIN (e.g. auric_glow)
// still floods normally — its rarity is controlled by chooseGroup's feature tier.
export function pickCell(group: FloorGroup, rng: () => number): FloorTile {
  const glow = group.accents.filter((a) => a.isGlow);
  const normal = group.accents.filter((a) => !a.isGlow);
  const r = rng();
  if (glow.length > 0 && r < GLOW_RATE) return at(glow, rng);
  if (normal.length > 0 && r < ACCENT_RATE) return at(normal, rng);
  return at(group.mains, rng);
}

// A stable base tile for a group — used as the underlay behind transparent door tiles.
export const mainTile = (group: FloorGroup): FloorTile => group.mains[0];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/floorgroups-fill.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: clean).

```bash
git add src/domain/floorgroups.ts tests/floorgroups-fill.test.ts
git commit -m "feat(floors): pickCell main-blend + rare-glow fill"
```

---

### Task 5: Decouple `autotile` resolvers from `Skin`

The reserved (unused) blob-floor resolvers take a whole `Skin`. Retarget them to plain `TileCoord`s so `Skin` can be removed in Task 8 without deleting the reserved rooms/open-world path.

**Files:**
- Modify: `src/domain/autotile.ts`
- Test: `tests/autotile.test.ts:27-39`

**Interfaces:**
- Consumes: `FLOOR_EDGES`, `type TileCoord` from `./tilesheet`.
- Produces (changed signatures): `resolveFloor(floorBase: TileCoord, mask: number): TileCoord`; `resolveDoor(door: TileCoord): TileCoord`.

- [ ] **Step 1: Update the failing test to the new signatures**

In `tests/autotile.test.ts`, replace the `describe('resolve', ...)` block (the `skin` literal + its two `it`s) with:

```ts
describe('resolve', () => {
  const floorBase = { col: 10, row: 20 };
  it('resolveFloor adds the FLOOR_EDGES offset to floorBase', () => {
    const e = FLOOR_EDGES[15];
    expect(resolveFloor(floorBase, 15)).toEqual({ col: 10 + e.col, row: 20 + e.row });
  });
  it('resolveDoor returns the door coord unchanged', () => {
    expect(resolveDoor({ col: 3, row: 4 })).toEqual({ col: 3, row: 4 });
  });
});
```

Also change the top import to drop the now-unused `Skin`:

```ts
import { FLOOR_EDGES } from '../src/domain/tilesheet';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autotile.test.ts`
Expected: FAIL — `resolveFloor` still expects a `Skin` (type error / wrong result).

- [ ] **Step 3: Update `autotile.ts`**

Replace the import line and the two resolver functions in `src/domain/autotile.ts`:

```ts
import { FLOOR_EDGES, type TileCoord } from './tilesheet';
```

```ts
export function resolveFloor(floorBase: TileCoord, mask: number): TileCoord {
  const e = FLOOR_EDGES[mask] ?? FLOOR_EDGES[15];
  return { col: floorBase.col + e.col, row: floorBase.row + e.row };
}

export function resolveDoor(door: TileCoord): TileCoord {
  return door;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autotile.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: clean — `Skin` still exists, only autotile stopped using it).

```bash
git add src/domain/autotile.ts tests/autotile.test.ts
git commit -m "refactor(autotile): resolvers take TileCoord, not Skin"
```

---

### Task 6: Regenerate the dungeon from the floor registry

Rewrite `dungeon2.ts` to build from a dungeon name + `chooseGroup` + `pickCell`, and rename the `AutoDungeon.skin` field to `dungeon`.

**Files:**
- Modify: `src/domain/dungeon2.ts`
- Modify: `src/web/views/dungeon-preview.ejs:14` (field rename)
- Test: `tests/dungeon2.test.ts`

**Interfaces:**
- Consumes: `getDungeon`, `chooseGroup`, `pickCell`, `mainTile`, `type Dungeon`, `type FloorGroup` from `./floorgroups`; `WALL_COLS`, `DOORS`, `pickWeighted`, `type TileCoord` from `./tilesheet`; `makeRng` from `./dungeon`; `type LogicalKind` from `./autotile`.
- Produces: `generateAutotiledDungeon(dungeonName: string, seed: number, opts?: GenOpts): AutoDungeon`; `AutoDungeon.dungeon: string` (renamed from `skin`). `RenderCell` unchanged.

- [ ] **Step 1: Update `tests/dungeon2.test.ts` to drive by dungeon name**

Replace the top import + `const skin` line:

```ts
import { generateAutotiledDungeon } from '../src/domain/dungeon2';
import { DOORS } from '../src/domain/tilesheet';

const dungeon = 'Greystone Keep';
```

Then replace every `skin` reference in the calls with `dungeon`, and update the deterministic test title/field:

```ts
  it('is deterministic for the same (dungeon, seed)', () => {
    const a = generateAutotiledDungeon(dungeon, 123);
    const b = generateAutotiledDungeon(dungeon, 123);
    expect(a).toEqual(b);
  });
```

(The other three `it` blocks stay identical except `generateAutotiledDungeon(skin, ...)` → `generateAutotiledDungeon(dungeon, ...)`.) Add a new `it` block (inside the same `describe`) confirming the renamed field:

```ts
  it('labels the sample with the dungeon name', () => {
    const d = generateAutotiledDungeon(dungeon, 1, { width: 10, height: 8 });
    expect(d.dungeon).toBe('Greystone Keep');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dungeon2.test.ts`
Expected: FAIL — `dungeon2.ts` still expects a skin and has no `dungeon` field.

- [ ] **Step 3: Rewrite `src/domain/dungeon2.ts`**

Replace the imports, `pickWall`, `pickFloor`, `AutoDungeon`, and the generator body:

```ts
import { makeRng } from './dungeon';
import { WALL_COLS, DOORS, pickWeighted, type TileCoord } from './tilesheet';
import { getDungeon, chooseGroup, pickCell, mainTile, type Dungeon, type FloorGroup } from './floorgroups';
import { type LogicalKind } from './autotile';
```

Delete the `const at = <T>(arr: T[], rng) => ...` helper line (it is now unused — only `pickFloor` and the old floor-set pick referenced it) and delete the entire `pickFloor` function. Keep `scrambleSeed` exactly as-is. Change `pickWall`'s signature to take a `Dungeon`:

```ts
function pickWall(
  x: number, y: number, kinds: LogicalKind[][], w: number, h: number,
  dungeon: Dungeon, rng: () => number,
): TileCoord {
  const row = dungeon.wallRow;
  const C = (col: number): TileCoord => ({ col, row });
  const isWall = (xx: number, yy: number) =>
    xx >= 0 && yy >= 0 && xx < w && yy < h && kinds[yy][xx] === 'wall';
  const N = isWall(x, y - 1), E = isWall(x + 1, y), S = isWall(x, y + 1), Wt = isWall(x - 1, y);
  const cracked = rng() < dungeon.wallVariantChance;
  if (E && Wt && !N && !S) return C(cracked ? WALL_COLS.crackedH : WALL_COLS.horizontal);
  if (N && S && !E && !Wt) return C(cracked ? WALL_COLS.crackedV : WALL_COLS.vertical);
  if (E && S && !N && !Wt) return C(WALL_COLS.tl);
  if (Wt && S && !N && !E) return C(WALL_COLS.tr);
  if (E && N && !S && !Wt) return C(WALL_COLS.bl);
  if (Wt && N && !S && !E) return C(WALL_COLS.br);
  if (Wt && !E && !N && !S) return C(WALL_COLS.rend);
  if (E && !Wt && !N && !S) return C(WALL_COLS.lend);
  if (N && !S && !E && !Wt) return C(WALL_COLS.bend);
  if (S && !N && !E && !Wt) return C(WALL_COLS.tend);
  return C(WALL_COLS.horizontal);
}
```

Update `AutoDungeon` (rename `skin` → `dungeon`):

```ts
export interface RenderCell {
  x: number; y: number; kind: LogicalKind; col: number; row: number;
  under?: { col: number; row: number };
}
export interface AutoDungeon {
  width: number; height: number; dungeon: string; seed: number;
  cells: RenderCell[];
  decor: { x: number; y: number; col: number; row: number }[];
}
export interface GenOpts { width?: number; height?: number; }
```

Rewrite the generator:

```ts
export function generateAutotiledDungeon(
  dungeonName: string, seed: number, opts: GenOpts = {},
): AutoDungeon {
  const dungeon = getDungeon(dungeonName);
  if (!dungeon) throw new Error(`unknown dungeon: ${dungeonName}`);
  const width = opts.width ?? 20;
  const height = opts.height ?? 15;
  const rng = makeRng(scrambleSeed(seed));
  // One coherent floor group for the whole dungeon.
  const group: FloorGroup = chooseGroup(dungeonName, rng);
  const underlay = mainTile(group); // floor behind transparent door tiles

  const isEdge = (x: number, y: number) => x === 0 || y === 0 || x === width - 1 || y === height - 1;
  const isCorner = (x: number, y: number) =>
    (x === 0 || x === width - 1) && (y === 0 || y === height - 1);

  // 1) Logical kinds.
  const kinds: LogicalKind[][] = [];
  for (let y = 0; y < height; y++) {
    const row: LogicalKind[] = [];
    for (let x = 0; x < width; x++) row.push(isEdge(x, y) ? 'wall' : 'floor');
    kinds.push(row);
  }
  // doors: 2-3 non-corner border cells
  const doorCount = 2 + Math.floor(rng() * 2);
  let guard = 0; let placed = 0;
  while (placed < doorCount && guard++ < 200) {
    const side = Math.floor(rng() * 4);
    let x = 0, y = 0;
    if (side === 0) { y = 0; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 1) { y = height - 1; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 2) { x = 0; y = 1 + Math.floor(rng() * (height - 2)); }
    else { x = width - 1; y = 1 + Math.floor(rng() * (height - 2)); }
    if (isCorner(x, y) || kinds[y][x] === 'door') continue;
    kinds[y][x] = 'door'; placed++;
  }

  // 2) Resolve every cell to a sheet coord.
  const cells: RenderCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const kind = kinds[y][x];
      let coord: TileCoord;
      let under: { col: number; row: number } | undefined;
      if (kind === 'wall') coord = pickWall(x, y, kinds, width, height, dungeon, rng);
      else if (kind === 'door') {
        coord = pickWeighted(DOORS, rng).coord;
        under = { col: underlay.col, row: underlay.row };
      } else coord = pickCell(group, rng);
      cells.push({ x, y, kind, col: coord.col, row: coord.row, under });
    }
  }

  // 3) Decor on a few interior floor cells (deterministic).
  const interior: { x: number; y: number }[] = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) if (kinds[y][x] === 'floor') interior.push({ x, y });
  for (let i = interior.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [interior[i], interior[j]] = [interior[j], interior[i]];
  }
  const decorCount = dungeon.decor.length === 0 ? 0 : Math.min(interior.length, 6 + Math.floor(rng() * 7));
  const decor = [];
  for (let i = 0; i < decorCount; i++) {
    const d = dungeon.decor[Math.min(dungeon.decor.length - 1, Math.floor(rng() * dungeon.decor.length))];
    decor.push({ x: interior[i].x, y: interior[i].y, col: d.col, row: d.row });
  }

  return { width, height, dungeon: dungeonName, seed, cells, decor };
}
```

Keep the `scrambleSeed` function as-is at the top of the file. Remove the old `at` helper only if it is no longer referenced (the decor loop above uses inline `Math.floor`; confirm no other `at(` calls remain — if the file still references `at`, keep it).

- [ ] **Step 4: Update the EJS field reference**

In `src/web/views/dungeon-preview.ejs`, change the meta line:

```html
      <div class="dp-meta"><%= d.dungeon %> — seed <%= d.seed %></div>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon2.test.ts`
Expected: PASS (5 tests). Note: the preview route still imports `SKINS` — that's removed in Task 7; typecheck may still pass here since `SKINS` still exists. Run `npm run typecheck` (expected: clean).

- [ ] **Step 6: Commit**

```bash
git add src/domain/dungeon2.ts src/web/views/dungeon-preview.ejs tests/dungeon2.test.ts
git commit -m "feat(floors): generate dungeon2 from the floor registry + compat routing"
```

---

### Task 7: Point the preview route at the dungeon registry

**Files:**
- Modify: `src/web/routes/dungeon-preview.ts`
- Test: `tests/web-dungeon-preview.test.ts` (add a dungeon-param case)

**Interfaces:**
- Consumes: `SHEET` from `../../domain/tilesheet`; `DUNGEONS`, `getDungeon` from `../../domain/floorgroups`; `generateAutotiledDungeon` from `../../domain/dungeon2`.
- Produces: `GET /dungeon-preview` renders all 22 dungeons (2 seeds each); `?dungeon=<name>` renders that one across 6 seeds; unknown name → all.

- [ ] **Step 1: Add the failing test case**

Append inside the existing `describe('dungeon-preview route gating', ...)` in `tests/web-dungeon-preview.test.ts`:

```ts
  it('renders a single dungeon when ?dungeon= is given', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({ ENABLE_DUNGEON_PREVIEW: '1' }) });
    const res = await request(app).get('/dungeon-preview?dungeon=Emberforge');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Emberforge');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/web-dungeon-preview.test.ts`
Expected: FAIL — the route still iterates `SKINS`; `Emberforge` is not rendered.

- [ ] **Step 3: Rewrite the route**

Replace `src/web/routes/dungeon-preview.ts`:

```ts
import type { Express } from 'express';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { SHEET } from '../../domain/tilesheet';
import { DUNGEONS, getDungeon } from '../../domain/floorgroups';
import { generateAutotiledDungeon } from '../../domain/dungeon2';

export function registerDungeonPreviewRoutes(app: Express, { config }: AppDeps): void {
  if (!config.enableDungeonPreview) return;
  app.get(
    '/dungeon-preview',
    asyncHandler(async (req, res) => {
      const q = typeof req.query.dungeon === 'string' ? req.query.dungeon : '';
      const one = getDungeon(q);
      const samples = one
        ? [1, 2, 3, 4, 5, 6].map((seed) =>
            generateAutotiledDungeon(one.name, seed, { width: 18, height: 13 }))
        : DUNGEONS.flatMap((d) =>
            [1, 2].map((seed) =>
              generateAutotiledDungeon(d.name, seed, { width: 18, height: 13 })));
      res.send(
        await renderPage('dungeon-preview', {
          title: 'Dungeon Preview',
          sheet: SHEET,
          samples,
        }),
      );
    }),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/web-dungeon-preview.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: clean).

```bash
git add src/web/routes/dungeon-preview.ts tests/web-dungeon-preview.test.ts
git commit -m "feat(floors): preview all 22 dungeons + ?dungeon= filter"
```

---

### Task 8: Remove the retired `Skin` machinery from `tilesheet.ts`

All consumers now use the floor registry. Delete the dead skin types/data.

**Files:**
- Modify: `src/domain/tilesheet.ts` (remove `FloorSet`, `Skin`, `CASTLE_FLOORS`, `SKINS`, `getSkin`)
- Test: `tests/tilesheet.test.ts` (drop the skin assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: `tilesheet.ts` keeps `SHEET`, `tileRect`, `TileCoord`, `FLOOR_EDGES`, `WALL_COLS`, `WeightedTile`, `DOORS`, `pickWeighted`. `FloorSet`/`Skin`/`SKINS`/`getSkin`/`CASTLE_FLOORS` are gone.

> This is a dead-code deletion, not TDD: by now every consumer (autotile, dungeon2, the preview route) is migrated, so there is no failing-test-first step — prune the skin tests, delete the code, and confirm the whole suite stays green.

- [ ] **Step 1: Prune the test**

In `tests/tilesheet.test.ts`: change the import to drop `SKINS, getSkin`:

```ts
import { SHEET, tileRect, FLOOR_EDGES, WALL_COLS, DOORS, pickWeighted } from '../src/domain/tilesheet';
```

Delete the two `it` blocks that reference skins: `it('has at least 2 proof skins, ...')` and `it('defines the four themed skins on their own sheet rows')`. Keep the `tileRect`, `FLOOR_EDGES`, `DOORS`, and `pickWeighted` tests unchanged.

- [ ] **Step 2: Delete the skin machinery from `tilesheet.ts`**

In `src/domain/tilesheet.ts`, delete:
- the `export interface FloorSet { ... }` block (and its doc comment),
- the `export interface Skin { ... }` block (and its doc comment),
- the `const CASTLE_FLOORS: FloorSet[] = [ ... ];` block (and its doc comment),
- the `export const SKINS: Skin[] = [ ... ];` block (and its doc comment),
- the `export function getSkin(...) { ... }` function.

Keep `SHEET`, `tileRect`, `TileCoord`, the `FLOOR_EDGES` block, `WALL_COLS`, `WeightedTile`, `DOORS`, and `pickWeighted`. (The `FLOOR_EDGES` comment mentions `skin.floorBase` — update that phrase to "a floor block's base coord" so no stale `skin` reference remains.)

- [ ] **Step 3: Verify the whole suite and typecheck are green**

Run: `npx vitest run`
Expected: PASS — all files (no remaining `SKINS`/`getSkin`/`Skin` references anywhere).

Run: `npm run typecheck`
Expected: clean.

Run a grep to confirm nothing references the removed symbols:
```bash
grep -rn "\bSkin\b\|\bFloorSet\b\|\bSKINS\b\|getSkin\|CASTLE_FLOORS\|floorSets\|floorBase" src/ tests/
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/domain/tilesheet.ts tests/tilesheet.test.ts
git commit -m "refactor(floors): remove retired Skin machinery from tilesheet"
```

---

### Task 9: Verify the render in the browser

Confirm the new floors actually look cohesive across the roster and spot-check the wall-render assumption on higher bands (the design's one live risk).

**Files:** none (manual verification).

- [ ] **Step 1: Start the server with the preview flag**

Run (background): `ENABLE_DUNGEON_PREVIEW=1 npm run dev`
Then open `http://localhost:<port>/dungeon-preview` (port per `src/config.ts` / server log).

- [ ] **Step 2: Eyeball the full roster**

Confirm: each of the 22 dungeons renders a cohesive skinned wall border + a floor whose color matches the wall theme (compat routing), floors blend mains without obvious tiling seams, and glow tiles are sparse (not radioactive).

- [ ] **Step 3: Spot-check the wall assumption on higher bands**

Open `/dungeon-preview?dungeon=Wildroot%20Barrow` (row 15), `?dungeon=Glacierhold` (row 19), and `?dungeon=Bloodstone%20Cairn` (row 23). Confirm the pseudo-3D walls read correctly (corners/edges/cracks), not garbled. If any band's walls look broken, note it — the fix is data-only: add that `dungeonId` to `EXCLUDED_DUNGEON_IDS` in `floorgroups.ts` (floors are unaffected). Re-run `npx vitest run` if you change the exclusion (the count assertion in `floorgroups-load.test.ts` must be updated to match).

- [ ] **Step 4: Stop the server**

Stop the background `npm run dev`.

- [ ] **Step 5: Final commit (only if the exclusion set changed)**

```bash
git add src/domain/floorgroups.ts tests/floorgroups-load.test.ts
git commit -m "tweak(floors): exclude bands whose walls don't render cleanly"
```

---

## Notes for the implementer

- **Determinism budget:** `pickCell` consumes 1–2 `rng()` calls per cell; `chooseGroup` consumes 1. Do not add stray `rng()` calls — the existing `dungeon2` determinism test (`a.toEqual(b)`) will catch drift.
- **`makeRng` semantics:** `makeRng(seed)` returns a fresh independent mulberry32 stream each call, so `makeRng(42)` twice gives identical sequences (used by the routing determinism tests).
- **Do not touch** `src/domain/dungeon.ts`, `src/domain/tilemanifest.ts`, or the live `/tv` route — this project is preview-only.

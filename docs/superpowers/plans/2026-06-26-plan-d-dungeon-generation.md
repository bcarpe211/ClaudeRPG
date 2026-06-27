# Plan D: Dungeon Generation + Tile Manifest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each dungeon's stored `theme` + `seed` (set by the Plan C engine) into a concrete, deterministic **20×15 tile layout** the TV renderer (Plan E) can draw: a walled room with doors, varied floor, scattered non-colliding decor, a reserved center for the monster, and spread-out hero spawn slots — plus a curated **tile manifest** classifying `world_24x24` sprites as wall/floor/door/decor per theme.

**Architecture:** Pure, dependency-light. `tilemanifest.ts` is committed data (theme → sprite filenames) + small helpers. `dungeon.ts` is a **pure function** `generateDungeon(theme, seed)` driven by a seeded PRNG, so the same `(theme, seed)` always yields the identical layout (matching the engine's seed-based durability model). A tiny `currentLayout(db)` bridge reads the active dungeon and generates its layout for Plan E. **No DB writes, no rendering, no WebSocket** — this plan produces layout *data* only.

**Tech Stack:** Same as A/B/C. No new dependencies. The generator emits sprite **filenames** (e.g. `oryx_16bit_fantasy_world_100.png`); Plan E resolves them via `worldSpriteUrl()` against the existing `/sprites/world_24x24/` static mount.

**Important scoping note on the manifest:** there are 1784 non-contiguously-numbered `world_24x24` tiles and no clean position→filename map, so the manifest is a **best-effort curated selection** that is *visually tuned in Plan E* on the real TV. Correctness here means: (a) every referenced sprite file exists, (b) the structure is complete per theme, (c) the generator only ever emits sprites present in the manifest. Pixel-perfect theming is explicitly a Plan E concern.

---

## File Structure

```
src/domain/
  tilemanifest.ts     (new: theme→tile sprite sets + worldSpriteUrl/themeTiles)
  dungeon.ts          (new: makeRng + generateDungeon + types; currentLayout bridge)
tests/
  tilemanifest.test.ts
  dungeon-generate.test.ts
  dungeon-placement.test.ts
  dungeon-current.test.ts
```

**Conventions:** ESM, extensionless imports, `import type Database from 'better-sqlite3'`. The generator is pure (seeded PRNG, no `Math.random`/`Date.now`). Tests use `openDb(':memory:')` where DB is involved.

---

## Task 1: Tile manifest (`src/domain/tilemanifest.ts`)

**Files:**
- Create: `src/domain/tilemanifest.ts`
- Test: `tests/tilemanifest.test.ts`

This task is partly **curatorial**: you must inspect real tiles and choose sprite filenames. The tests are the acceptance criteria.

**How to choose sprites (do this first):**
- Sliced tiles live in `assets/oryx_16-bit_fantasy_1.1/Sliced/world_24x24/`, named `oryx_16bit_fantasy_world_<N>.png` (24×24 each). Numbers are non-contiguous (range ~59–2250).
- For orientation, view the full sheet `assets/oryx_16-bit_fantasy_1.1/oryx_16bit_fantasy_world.png` with the Read tool. Then Read individual candidate sliced tiles to confirm what each `<N>` actually is. (Optional: `pip install Pillow` and write a tiny script to build a labeled contact sheet if that speeds selection — not required.)
- Pick, for **each** of the three themes `stone_crypt`, `cave`, `wood_fort`: one primary `wall`, 1-3 `wallVariants` (optional), one primary `floor`, 2-4 `floorVariants`, one `door` (a doorway/opening or a distinct floor tile used in openings), and 4-8 `decor` props (barrels, pots, bones, chests, torches, pillars, rugs — whatever reads as that theme). Reuse tiles across themes if appropriate. Approximate is fine — these are tuned in Plan E.

- [ ] **Step 1: Write the failing test** `tests/tilemanifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  TILE_MANIFEST, DEFAULT_THEME, themeTiles, worldSpriteUrl,
} from '../src/domain/tilemanifest';

const SLICED = 'assets/oryx_16-bit_fantasy_1.1/Sliced/world_24x24';

describe('tile manifest', () => {
  it('defines the three themes used by the engine', () => {
    for (const t of ['stone_crypt', 'cave', 'wood_fort']) {
      expect(TILE_MANIFEST[t]).toBeDefined();
    }
    expect(TILE_MANIFEST[DEFAULT_THEME]).toBeDefined();
  });

  it('each theme has wall, floor, door, floorVariants and decor', () => {
    for (const [name, t] of Object.entries(TILE_MANIFEST)) {
      expect(t.wall, `${name}.wall`).toBeTruthy();
      expect(t.floor, `${name}.floor`).toBeTruthy();
      expect(t.door, `${name}.door`).toBeTruthy();
      expect(t.floorVariants.length, `${name}.floorVariants`).toBeGreaterThanOrEqual(1);
      expect(t.decor.length, `${name}.decor`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every referenced sprite file actually exists on disk', () => {
    for (const [name, t] of Object.entries(TILE_MANIFEST)) {
      const all = [t.wall, t.floor, t.door, ...(t.wallVariants ?? []),
        ...t.floorVariants, ...t.decor];
      for (const f of all) {
        expect(existsSync(path.join(SLICED, f)), `${name}: ${f}`).toBe(true);
      }
    }
  });

  it('themeTiles falls back to the default for unknown themes', () => {
    expect(themeTiles('does_not_exist')).toBe(TILE_MANIFEST[DEFAULT_THEME]);
    expect(themeTiles('cave')).toBe(TILE_MANIFEST['cave']);
  });

  it('worldSpriteUrl points at the static sprite mount', () => {
    expect(worldSpriteUrl('oryx_16bit_fantasy_world_100.png'))
      .toBe('/sprites/world_24x24/oryx_16bit_fantasy_world_100.png');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tilemanifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/tilemanifest.ts`**

Use this exact structure. **Replace every `REPLACE_*` filename with a real, verified sliced filename you chose by inspection** (the file-existence test will fail until they are all real files). Filenames are bare (no path), e.g. `oryx_16bit_fantasy_world_137.png`.

```ts
export interface ThemeTiles {
  wall: string;
  wallVariants?: string[];
  floor: string;
  floorVariants: string[];
  door: string;
  decor: string[];
}

// Best-effort curated tiles per theme; tuned visually in Plan E.
// Every value must be a real file in Sliced/world_24x24/.
export const TILE_MANIFEST: Record<string, ThemeTiles> = {
  stone_crypt: {
    wall: 'REPLACE_stone_wall.png',
    wallVariants: ['REPLACE_stone_wall_alt.png'],
    floor: 'REPLACE_stone_floor.png',
    floorVariants: ['REPLACE_stone_floor_v1.png', 'REPLACE_stone_floor_v2.png'],
    door: 'REPLACE_stone_door.png',
    decor: ['REPLACE_barrel.png', 'REPLACE_bones.png', 'REPLACE_pot.png', 'REPLACE_chest.png'],
  },
  cave: {
    wall: 'REPLACE_cave_wall.png',
    floor: 'REPLACE_cave_floor.png',
    floorVariants: ['REPLACE_cave_floor_v1.png', 'REPLACE_cave_floor_v2.png'],
    door: 'REPLACE_cave_opening.png',
    decor: ['REPLACE_rock.png', 'REPLACE_mushroom.png', 'REPLACE_bones2.png'],
  },
  wood_fort: {
    wall: 'REPLACE_wood_wall.png',
    floor: 'REPLACE_wood_floor.png',
    floorVariants: ['REPLACE_wood_floor_v1.png', 'REPLACE_wood_floor_v2.png'],
    door: 'REPLACE_wood_door.png',
    decor: ['REPLACE_crate.png', 'REPLACE_table.png', 'REPLACE_torch.png'],
  },
};

export const DEFAULT_THEME = 'stone_crypt';

export function themeTiles(theme: string): ThemeTiles {
  return TILE_MANIFEST[theme] ?? TILE_MANIFEST[DEFAULT_THEME];
}

export function worldSpriteUrl(file: string): string {
  return `/sprites/world_24x24/${file}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tilemanifest.test.ts`
Expected: PASS (5 tests). If the file-existence test fails, you referenced a filename that doesn't exist — fix the id by re-inspecting.

- [ ] **Step 5: Commit**

```bash
git add src/domain/tilemanifest.ts tests/tilemanifest.test.ts
git commit -m "feat: curated world-tile manifest per theme"
```

---

## Task 2: Seeded PRNG + room generator core (`src/domain/dungeon.ts`)

**Files:**
- Create: `src/domain/dungeon.ts`
- Test: `tests/dungeon-generate.test.ts`

This task builds the deterministic PRNG, the layout types, and the room shell (border walls, doors, varied floor). Placement of monster/heroes/decor is Task 3 (same file, extended).

- [ ] **Step 1: Write the failing test** `tests/dungeon-generate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeRng, generateDungeon } from '../src/domain/dungeon';
import { themeTiles } from '../src/domain/tilemanifest';

describe('makeRng', () => {
  it('is deterministic for a seed and varies across seeds', () => {
    const a = makeRng(42); const b = makeRng(42); const c = makeRng(43);
    const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()]; const seqC = [c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe('generateDungeon room shell', () => {
  it('is fully deterministic for (theme, seed)', () => {
    expect(generateDungeon('cave', 123)).toEqual(generateDungeon('cave', 123));
  });

  it('produces a 20x15 grid by default with a wall/door border and floor interior', () => {
    const d = generateDungeon('stone_crypt', 7);
    expect(d.width).toBe(20);
    expect(d.height).toBe(15);
    expect(d.cells.length).toBe(15);
    expect(d.cells[0].length).toBe(20);
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const edge = x === 0 || y === 0 || x === d.width - 1 || y === d.height - 1;
        const c = d.cells[y][x];
        if (edge) expect(['wall', 'door']).toContain(c.type);
        else expect(c.type).toBe('floor');
      }
    }
  });

  it('has 2-4 doors, all on the border and not at corners', () => {
    const d = generateDungeon('wood_fort', 99);
    expect(d.doors.length).toBeGreaterThanOrEqual(2);
    expect(d.doors.length).toBeLessThanOrEqual(4);
    for (const p of d.doors) {
      const edge = p.x === 0 || p.y === 0 || p.x === d.width - 1 || p.y === d.height - 1;
      const corner = (p.x === 0 || p.x === d.width - 1) && (p.y === 0 || p.y === d.height - 1);
      expect(edge).toBe(true);
      expect(corner).toBe(false);
      expect(d.cells[p.y][p.x].type).toBe('door');
    }
  });

  it('only emits sprites from the theme manifest for walls/doors/floor', () => {
    const t = themeTiles('cave');
    const wallSet = new Set([t.wall, ...(t.wallVariants ?? [])]);
    const floorSet = new Set([t.floor, ...t.floorVariants]);
    const d = generateDungeon('cave', 5);
    for (const row of d.cells) for (const c of row) {
      if (c.type === 'wall') expect(wallSet.has(c.sprite)).toBe(true);
      else if (c.type === 'floor') expect(floorSet.has(c.sprite)).toBe(true);
      else expect(c.sprite).toBe(t.door);
    }
  });

  it('falls back to the default theme for an unknown theme (no throw)', () => {
    expect(() => generateDungeon('mystery', 1)).not.toThrow();
    expect(generateDungeon('mystery', 1).theme).toBe('mystery');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dungeon-generate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/dungeon.ts`**

```ts
import { themeTiles } from './tilemanifest';

export interface Pos { x: number; y: number; }
export interface Cell { type: 'wall' | 'floor' | 'door'; sprite: string; }
export interface Decor { x: number; y: number; sprite: string; }
export interface DungeonLayout {
  width: number;
  height: number;
  theme: string;
  seed: number;
  cells: Cell[][]; // [y][x]
  doors: Pos[];
  monster: { x: number; y: number; footprint: number }; // reserved 2x2 anchor
  heroSlots: Pos[];
  decor: Decor[];
}

export interface GenerateOpts {
  width?: number;
  height?: number;
  heroSlots?: number;
}

/** Deterministic PRNG (mulberry32). Same seed -> same stream. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

export function generateDungeon(
  theme: string,
  seed: number,
  opts: GenerateOpts = {},
): DungeonLayout {
  const width = opts.width ?? 20;
  const height = opts.height ?? 15;
  const t = themeTiles(theme);
  const rng = makeRng(seed);
  const wallSprites = [t.wall, ...(t.wallVariants ?? [])];
  const floorSprites = [t.floor, ...t.floorVariants];

  const isEdge = (x: number, y: number) =>
    x === 0 || y === 0 || x === width - 1 || y === height - 1;
  const isCorner = (x: number, y: number) =>
    (x === 0 || x === width - 1) && (y === 0 || y === height - 1);

  // Base grid: border walls, interior floor (occasional variant).
  const cells: Cell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) {
      if (isEdge(x, y)) {
        row.push({ type: 'wall', sprite: pick(wallSprites, rng) });
      } else {
        const sprite = rng() < 0.15 ? pick(t.floorVariants, rng) : t.floor;
        row.push({ type: 'floor', sprite });
      }
    }
    cells.push(row);
  }

  // Doors: 2-4 non-corner border cells.
  const doorCount = 2 + Math.floor(rng() * 3);
  const doors: Pos[] = [];
  let guard = 0;
  while (doors.length < doorCount && guard++ < 200) {
    const side = Math.floor(rng() * 4);
    let x = 0, y = 0;
    if (side === 0) { y = 0; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 1) { y = height - 1; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 2) { x = 0; y = 1 + Math.floor(rng() * (height - 2)); }
    else { x = width - 1; y = 1 + Math.floor(rng() * (height - 2)); }
    if (isCorner(x, y)) continue;
    if (doors.some((d) => d.x === x && d.y === y)) continue;
    doors.push({ x, y });
    cells[y][x] = { type: 'door', sprite: t.door };
  }

  // Placement (monster zone, hero slots, decor) is filled in Task 3.
  const monster = { x: 0, y: 0, footprint: 2 };
  const heroSlots: Pos[] = [];
  const decor: Decor[] = [];

  return { width, height, theme, seed, cells, doors, monster, heroSlots, decor };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/dungeon-generate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/dungeon.ts tests/dungeon-generate.test.ts
git commit -m "feat: seeded room-shell generator (walls, doors, floor)"
```

---

## Task 3: Monster zone, hero slots & decor placement

**Files:**
- Modify: `src/domain/dungeon.ts`
- Test: `tests/dungeon-placement.test.ts`

- [ ] **Step 1: Write the failing test** `tests/dungeon-placement.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateDungeon } from '../src/domain/dungeon';
import { themeTiles } from '../src/domain/tilemanifest';

function inMonsterZone(d: ReturnType<typeof generateDungeon>, x: number, y: number) {
  return x >= d.monster.x && x <= d.monster.x + 1 && y >= d.monster.y && y <= d.monster.y + 1;
}

describe('dungeon placement', () => {
  it('reserves a 2x2 monster zone of floor tiles within the interior', () => {
    const d = generateDungeon('stone_crypt', 11);
    expect(d.monster.footprint).toBe(2);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = d.monster.x + dx, y = d.monster.y + dy;
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(d.width - 1);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(d.height - 1);
      expect(d.cells[y][x].type).toBe('floor');
    }
  });

  it('produces spread hero slots on interior floor, none in the monster zone, all unique', () => {
    const d = generateDungeon('cave', 22, { heroSlots: 24 });
    expect(d.heroSlots.length).toBeGreaterThan(0);
    expect(d.heroSlots.length).toBeLessThanOrEqual(24);
    const seen = new Set<string>();
    for (const p of d.heroSlots) {
      expect(d.cells[p.y][p.x].type).toBe('floor');
      expect(inMonsterZone(d, p.x, p.y)).toBe(false);
      const k = `${p.x},${p.y}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('places decor on floor tiles not overlapping hero slots or the monster zone', () => {
    const d = generateDungeon('wood_fort', 33);
    const t = themeTiles('wood_fort');
    const decorSet = new Set(t.decor);
    const heroKeys = new Set(d.heroSlots.map((p) => `${p.x},${p.y}`));
    expect(d.decor.length).toBeGreaterThanOrEqual(1);
    for (const item of d.decor) {
      expect(d.cells[item.y][item.x].type).toBe('floor');
      expect(inMonsterZone(d, item.x, item.y)).toBe(false);
      expect(heroKeys.has(`${item.x},${item.y}`)).toBe(false);
      expect(decorSet.has(item.sprite)).toBe(true);
    }
  });

  it('stays fully deterministic including placement', () => {
    expect(generateDungeon('cave', 555)).toEqual(generateDungeon('cave', 555));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dungeon-placement.test.ts`
Expected: FAIL — heroSlots/decor are empty / monster zone not reserved.

- [ ] **Step 3: Replace the placement section in `src/domain/dungeon.ts`**

Replace this block:

```ts
  // Placement (monster zone, hero slots, decor) is filled in Task 3.
  const monster = { x: 0, y: 0, footprint: 2 };
  const heroSlots: Pos[] = [];
  const decor: Decor[] = [];

  return { width, height, theme, seed, cells, doors, monster, heroSlots, decor };
```

with:

```ts
  // Reserve a 2x2 monster zone near the centre (kept clear of decor/heroes).
  const monster = {
    x: Math.floor(width / 2) - 1,
    y: Math.floor(height / 2) - 1,
    footprint: 2,
  };
  const inMonster = (x: number, y: number) =>
    x >= monster.x && x <= monster.x + 1 && y >= monster.y && y <= monster.y + 1;

  // Candidate interior floor tiles (exclude border, doors, monster zone).
  const candidates: Pos[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (cells[y][x].type !== 'floor') continue;
      if (inMonster(x, y)) continue;
      candidates.push({ x, y });
    }
  }
  // Deterministic Fisher-Yates shuffle.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const heroSlotCount = Math.min(opts.heroSlots ?? 24, candidates.length);
  const heroSlots: Pos[] = candidates.slice(0, heroSlotCount);

  // Decor from the remaining candidates (never overlaps heroes/monster).
  const rest = candidates.slice(heroSlotCount);
  const decorCount = Math.min(rest.length, 6 + Math.floor(rng() * 7)); // 6-12
  const decor: Decor[] = [];
  for (let i = 0; i < decorCount; i++) {
    decor.push({ x: rest[i].x, y: rest[i].y, sprite: pick(t.decor, rng) });
  }

  return { width, height, theme, seed, cells, doors, monster, heroSlots, decor };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/dungeon-placement.test.ts && npx vitest run tests/dungeon-generate.test.ts`
Expected: PASS (placement 4 tests + the earlier 6 still green).

- [ ] **Step 5: Commit**

```bash
git add src/domain/dungeon.ts tests/dungeon-placement.test.ts
git commit -m "feat: monster zone, hero slots, and decor placement"
```

---

## Task 4: Current-dungeon layout bridge (`currentLayout`)

**Files:**
- Modify: `src/domain/dungeon.ts` (add the bridge)
- Test: `tests/dungeon-current.test.ts`

Plan E needs the layout for whatever dungeon is currently active. This reads `game_state` → `dungeons` and generates it.

- [ ] **Step 1: Write the failing test** `tests/dungeon-current.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { currentLayout, generateDungeon } from '../src/domain/dungeon';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('currentLayout', () => {
  it('returns null when no dungeon is active', () => {
    expect(currentLayout(db)).toBeNull();
  });

  it('returns the deterministic layout for the active dungeon', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000); // spawns a dungeon
    const d = db.prepare('SELECT theme, seed FROM dungeons ORDER BY id DESC LIMIT 1').get() as any;
    const layout = currentLayout(db)!;
    expect(layout).not.toBeNull();
    expect(layout.theme).toBe(d.theme);
    expect(layout.seed).toBe(d.seed);
    expect(layout).toEqual(generateDungeon(d.theme, d.seed));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dungeon-current.test.ts`
Expected: FAIL — `currentLayout` not exported.

- [ ] **Step 3: Add the bridge to `src/domain/dungeon.ts`**

Add the import at the top (with the existing import):

```ts
import type Database from 'better-sqlite3';
import { getGameState } from './gamestate';
```

Add at the end of the file:

```ts
/** Generate the layout for the currently-active dungeon, or null if none. */
export function currentLayout(db: Database.Database): DungeonLayout | null {
  const gs = getGameState(db);
  if (!gs.current_dungeon_id) return null;
  const d = db.prepare('SELECT theme, seed FROM dungeons WHERE id=?')
    .get(gs.current_dungeon_id) as { theme: string; seed: number } | undefined;
  if (!d) return null;
  return generateDungeon(d.theme, d.seed);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/dungeon-current.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green; zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/domain/dungeon.ts tests/dungeon-current.test.ts
git commit -m "feat: currentLayout bridge for the active dungeon"
```

---

## Self-Review

**Spec coverage (§4 procedural dungeon generation):**
- 20×15 grid, theme-based wall + floor tilesets → Tasks 1, 2. ✅
- 1-tile wall border with 2-4 doors → Task 2. ✅
- Floor pass with variant tiles → Task 2. ✅
- Decor pass placing props on floor not colliding with heroes/monster → Task 3. ✅
- Reserved monster area (2×2 so a boss fits) → Task 3. ✅
- Spread hero spawn positions → Task 3. ✅
- Seed-based, deterministic (matches the engine's `(level, theme, seed)` durability model) → Tasks 2, 3, 4. ✅
- Tile manifest classifying `world_24x24` tiles as floor/wall/decor per theme → Task 1. ✅
- Bridge so the renderer can get the active dungeon's layout → Task 4. ✅

**Out of scope (correctly deferred):** rendering, sprite scaling, leaderboard, WebSocket, popup rendering, assigning specific players to hero slots (Plan E). Pixel-perfect tile theming is tuned in Plan E on the real TV; Task 1 guarantees only that referenced files exist and the structure is complete.

**Placeholder scan:** The only intentional placeholders are the `REPLACE_*` filenames in Task 1, which the implementer must replace with verified real filenames (the file-existence test enforces this). All generator/bridge code is complete.

**Type consistency:** `ThemeTiles`/`TILE_MANIFEST`/`themeTiles`/`worldSpriteUrl`/`DEFAULT_THEME`, `Pos`/`Cell`/`Decor`/`DungeonLayout`/`GenerateOpts`, `makeRng`/`generateDungeon`/`currentLayout` are each defined once and used consistently. `generateDungeon` is pure; `currentLayout` is the only DB-touching function and reuses `getGameState` from Plan C.

**Determinism:** `generateDungeon` derives all randomness from `makeRng(seed)`; no `Math.random`/`Date.now`. `toEqual` round-trip tests pin determinism for both the shell and placement.

# Sheet-Driven Autotiled Dungeons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove we can generate cohesive, skinnable dungeon layouts by decoding the oryx world sheet's per-skin grammar and autotiling from it, rendered in a dev-only `/dungeon-preview`.

**Architecture:** A new, parallel pipeline (does not touch the live `/tv`): a decoded tile-grammar data module (`tilesheet.ts`), a pure autotiler (`autotile.ts`), a deterministic sheet-driven generator (`dungeon2.ts`), and a flag-gated preview route that draws tiles as 24×24 sub-rects from the full sheet served at `/sheet/world.png`.

**Tech Stack:** TypeScript (tsx/ESM), Express 4, EJS, vitest + supertest; browser Canvas 2D (nearest-neighbor).

## Global Constraints

- Run via tsx/ESM, no build step; `tsc --noEmit` stays clean.
- **Do not modify the live pipeline** (`dungeon.ts`, `tilemanifest.ts`, `tvview.ts`, `tv.js`, the engine). This is additive and parallel.
- Tiles are addressed on the full sheet by `(col, row)` at **24px pitch, origin (0,0)**; sheet is 1366×1007 (56 cols × 41 rows usable). Render via `drawImage(sheet, col*24,row*24,24,24, …)` with `imageSmoothingEnabled=false`.
- Sheet served at **`/sheet/world.png`** from `<spritesDir>/../oryx_16bit_fantasy_world_trans.png`.
- Preview is dev-only, OFF by default (env `ENABLE_DUNGEON_PREVIEW`), never on the kiosk; read-only.
- **Proof scope:** floors use **4-bit orthogonal edge autotiling** (16 cases); walls use the skin's solid block. The 47-tile blob and pseudo-3D wall fronts are explicit follow-ons, not this plan.
- Determinism: generation uses the existing `makeRng` (mulberry32) from `dungeon.ts`; same `(skin, seed)` ⇒ identical output.
- `assets/` is gitignored; the sheet is served from the local asset dir at runtime.

---

## File Structure

- `src/domain/tilesheet.ts` (create) — decoded grammar: `SHEET`, `tileRect`, `FLOOR_EDGES` (shared 16-case map), `SKINS` (proof skins w/ decoded bases).
- `src/domain/autotile.ts` (create) — pure `floorEdgeMask` + `resolveFloor`/`resolveWall`/`resolveDoor`/`resolveDecor`.
- `src/domain/dungeon2.ts` (create) — `generateAutotiledDungeon(skin, seed, opts)` → render cells.
- `src/config.ts` (modify) — add `enableDungeonPreview`.
- `src/web/app.ts` (modify) — serve `/sheet/world.png`; register preview route.
- `src/web/routes/dungeon-preview.ts` (create) — gated `GET /dungeon-preview`.
- `src/web/views/dungeon-preview.ejs` (create) — canvas page that draws sample dungeons from the sheet.
- `scripts/dev/crop-sheet.py` (create) — decode helper (crop sheet regions with a 24px grid overlay).
- Tests: `tests/tilesheet.test.ts`, `tests/autotile.test.ts`, `tests/dungeon2.test.ts`, `tests/web-dungeon-preview.test.ts` (create).

---

### Task 1: Tile-grammar data model + decode (`tilesheet.ts`)

This is a **decode/extraction task** (like the earlier `spritenames` extraction): the code *shape*, helpers, and structural tests are fully specified here; the concrete offset **values** are the deliverable, found with the crop helper and visually confirmed later in the preview (Task 5).

**Files:**
- Create: `scripts/dev/crop-sheet.py`, `src/domain/tilesheet.ts`
- Test: `tests/tilesheet.test.ts`

**Interfaces:**
- Produces: `TileCoord {col,row}`; `SHEET`; `tileRect(c: TileCoord)`; `FloorEdgeMask` (0–15); `FLOOR_EDGES: Record<number, TileCoord>` (offsets within a floor block); `Skin { name, floorBase, wall, wallVariants?, door, decor }`; `SKINS: Skin[]`; `getSkin(name)`.

- [ ] **Step 1: Add the decode helper**

Create `scripts/dev/crop-sheet.py` (macOS/dev; needs Pillow):

```python
#!/usr/bin/env python3
# Crop a region of the world sheet with a 24px red grid overlay, upscaled,
# so tile (col,row) offsets can be read off by eye. Usage:
#   python3 scripts/dev/crop-sheet.py <col0> <row0> <cols> <rows> <scale> <out.png>
import sys
from PIL import Image, ImageDraw
SHEET = "assets/oryx_16-bit_fantasy_1.1/oryx_16bit_fantasy_world_trans.png"
TILE = 24
col0, row0, cols, rows, scale = (int(a) for a in sys.argv[1:6])
out = sys.argv[6]
im = Image.open(SHEET).convert("RGBA")
box = (col0*TILE, row0*TILE, (col0+cols)*TILE, (row0+rows)*TILE)
c = im.crop(box).resize((cols*TILE*scale, rows*TILE*scale), Image.NEAREST)
bg = Image.new("RGBA", c.size, (40,40,40,255)); bg.alpha_composite(c)
d = ImageDraw.Draw(bg)
for i in range(cols+1):
    d.line([(i*TILE*scale,0),(i*TILE*scale,bg.height)], fill=(255,0,0,160))
for j in range(rows+1):
    d.line([(0,j*TILE*scale),(bg.width,j*TILE*scale)], fill=(255,0,0,160))
bg.convert("RGB").save(out)
print(f"wrote {out}: {cols}x{rows} tiles from sheet ({col0},{row0})")
```

- [ ] **Step 2: Write the structural test (failing)**

Create `tests/tilesheet.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SHEET, tileRect, FLOOR_EDGES, SKINS, getSkin } from '../src/domain/tilesheet';

const inGrid = (c: { col: number; row: number }) =>
  c.col >= 0 && c.col < SHEET.cols && c.row >= 0 && c.row < SHEET.rows;

describe('tilesheet', () => {
  it('tileRect maps (col,row) to a 24px sub-rect', () => {
    expect(tileRect({ col: 0, row: 0 })).toEqual({ sx: 0, sy: 0, sw: 24, sh: 24 });
    expect(tileRect({ col: 3, row: 2 })).toEqual({ sx: 72, sy: 48, sw: 24, sh: 24 });
  });

  it('FLOOR_EDGES covers all 16 orthogonal masks with non-negative offsets', () => {
    for (let m = 0; m < 16; m++) {
      expect(FLOOR_EDGES[m]).toBeDefined();
      expect(FLOOR_EDGES[m].col).toBeGreaterThanOrEqual(0);
      expect(FLOOR_EDGES[m].row).toBeGreaterThanOrEqual(0);
    }
  });

  it('has at least 2 proof skins, all coords on the sheet grid', () => {
    expect(SKINS.length).toBeGreaterThanOrEqual(2);
    for (const s of SKINS) {
      expect(inGrid(s.floorBase)).toBe(true);
      expect(inGrid(s.wall)).toBe(true);
      expect(inGrid(s.door)).toBe(true);
      expect(s.decor.every(inGrid)).toBe(true);
      // floor block offsets land on-grid when added to the base
      for (let m = 0; m < 16; m++) {
        const e = FLOOR_EDGES[m];
        expect(inGrid({ col: s.floorBase.col + e.col, row: s.floorBase.row + e.row })).toBe(true);
      }
    }
    expect(getSkin(SKINS[0].name)).toBe(SKINS[0]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/tilesheet.test.ts`
Expected: FAIL — module `tilesheet` not found.

- [ ] **Step 4: Decode the offsets and write `tilesheet.ts`**

Use the helper to read offsets, e.g. the floor blob region and a couple of wall bands:
`python3 scripts/dev/crop-sheet.py 28 16 28 10 2 /tmp/floor.png` and
`python3 scripts/dev/crop-sheet.py 0 0 18 14 3 /tmp/wall.png`, viewing the PNGs to read `(col,row)`s. (Adjust the crop window until you can read the block you need.)

Then create `src/domain/tilesheet.ts`:

```ts
export interface TileCoord { col: number; row: number; }

export const SHEET = { url: '/sheet/world.png', tile: 24, cols: 56, rows: 41 } as const;

export function tileRect(c: TileCoord) {
  return { sx: c.col * SHEET.tile, sy: c.row * SHEET.tile, sw: SHEET.tile, sh: SHEET.tile };
}

// 4-bit orthogonal edge mask: bit 1=N floor, 2=E, 4=S, 8=W (set when that
// neighbour is also floor). Values are offsets WITHIN a floor skin's block,
// added to skin.floorBase. mask 15 = interior ("full"); the rest are the
// edges/outer-corners of a rectangular room. DECODED — confirm in /dungeon-preview.
export const FLOOR_EDGES: Record<number, TileCoord> = {
  // FILL with decoded offsets for all 16 masks (0..15). Example shape:
  // 15: { col: 1, row: 1 }, // interior / full
  // ...
};

export interface Skin {
  name: string;
  floorBase: TileCoord;       // origin of this skin's floor block
  wall: TileCoord;            // solid wall block
  wallVariants?: TileCoord[];
  door: TileCoord;
  decor: TileCoord[];
}

// DECODED proof skins (start with 2-3, e.g. a stone crypt + a cave).
export const SKINS: Skin[] = [
  // { name: 'crypt', floorBase: {...}, wall: {...}, door: {...}, decor: [ ... ] },
];

export function getSkin(name: string): Skin | undefined {
  return SKINS.find((s) => s.name === name);
}
```

Fill `FLOOR_EDGES` (all 16) and `SKINS` (≥2) with decoded values. (Offsets need not be visually perfect yet — Task 5 is the visual gate where they get refined.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/tilesheet.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/dev/crop-sheet.py src/domain/tilesheet.ts tests/tilesheet.test.ts
git commit -m "feat(dungeon2): decoded world-sheet tile grammar (tilesheet.ts)"
```

---

### Task 2: Pure autotiler (`autotile.ts`)

**Files:**
- Create: `src/domain/autotile.ts`
- Test: `tests/autotile.test.ts`

**Interfaces:**
- Consumes: `Skin`, `FLOOR_EDGES`, `TileCoord` from `tilesheet.ts`.
- Produces: `type LogicalKind = 'wall' | 'floor' | 'door' | 'decor'`;
  `floorEdgeMask(kindAt, x, y): number`;
  `resolveFloor(skin, mask): TileCoord`;
  `resolveWall(skin): TileCoord`; `resolveDoor(skin): TileCoord`.
  `kindAt` is `(x:number,y:number) => LogicalKind | null` (null = out of bounds).

- [ ] **Step 1: Write the failing test**

Create `tests/autotile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { floorEdgeMask, resolveFloor, resolveWall } from '../src/domain/autotile';
import { FLOOR_EDGES, type Skin } from '../src/domain/tilesheet';

// 3x3 floor patch surrounded by wall:
//   wall wall wall
//   wall floor wall   -> centre has no floor neighbours -> mask 0
const onlyCentreFloor = (x: number, y: number) =>
  x === 1 && y === 1 ? 'floor' : 'wall';

// a 3-wide floor row at y=1 (x 0..2 floor), walls above/below
const floorRow = (x: number, y: number) =>
  y === 1 && x >= 0 && x <= 2 ? 'floor' : 'wall';

describe('floorEdgeMask', () => {
  it('isolated floor cell has mask 0', () => {
    expect(floorEdgeMask(onlyCentreFloor, 1, 1)).toBe(0);
  });
  it('middle of a horizontal floor run has E+W set (mask 2|8=10)', () => {
    expect(floorEdgeMask(floorRow, 1, 1)).toBe(10);
  });
  it('left end of the run has only E set (mask 2)', () => {
    expect(floorEdgeMask(floorRow, 0, 1)).toBe(2);
  });
});

describe('resolve', () => {
  const skin: Skin = {
    name: 't', floorBase: { col: 10, row: 20 }, wall: { col: 1, row: 2 },
    door: { col: 3, row: 4 }, decor: [{ col: 5, row: 6 }],
  };
  it('resolveFloor adds the FLOOR_EDGES offset to floorBase', () => {
    const e = FLOOR_EDGES[15];
    expect(resolveFloor(skin, 15)).toEqual({ col: 10 + e.col, row: 20 + e.row });
  });
  it('resolveWall returns the skin wall coord', () => {
    expect(resolveWall(skin)).toEqual({ col: 1, row: 2 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/autotile.test.ts`
Expected: FAIL — module `autotile` not found.

- [ ] **Step 3: Implement `autotile.ts`**

Create `src/domain/autotile.ts`:

```ts
import { FLOOR_EDGES, type Skin, type TileCoord } from './tilesheet';

export type LogicalKind = 'wall' | 'floor' | 'door' | 'decor';
export type KindAt = (x: number, y: number) => LogicalKind | null;

const isFloorLike = (k: LogicalKind | null): boolean => k === 'floor' || k === 'door';

/** 4-bit orthogonal mask: bit 1=N, 2=E, 4=S, 8=W set when that neighbour is floor-like. */
export function floorEdgeMask(kindAt: KindAt, x: number, y: number): number {
  let m = 0;
  if (isFloorLike(kindAt(x, y - 1))) m |= 1;
  if (isFloorLike(kindAt(x + 1, y))) m |= 2;
  if (isFloorLike(kindAt(x, y + 1))) m |= 4;
  if (isFloorLike(kindAt(x - 1, y))) m |= 8;
  return m;
}

export function resolveFloor(skin: Skin, mask: number): TileCoord {
  const e = FLOOR_EDGES[mask] ?? FLOOR_EDGES[15];
  return { col: skin.floorBase.col + e.col, row: skin.floorBase.row + e.row };
}

export function resolveWall(skin: Skin): TileCoord {
  return skin.wall;
}

export function resolveDoor(skin: Skin): TileCoord {
  return skin.door;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autotile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/autotile.ts tests/autotile.test.ts
git commit -m "feat(dungeon2): pure autotiler (4-bit floor edges + resolvers)"
```

---

### Task 3: Sheet-driven generator (`dungeon2.ts`)

**Files:**
- Create: `src/domain/dungeon2.ts`
- Test: `tests/dungeon2.test.ts`

**Interfaces:**
- Consumes: `makeRng` from `dungeon.ts`; `getSkin`, `Skin`, `TileCoord` from `tilesheet.ts`; `floorEdgeMask`, `resolveFloor`, `resolveWall`, `resolveDoor`, `LogicalKind` from `autotile.ts`.
- Produces: `RenderCell { x, y, kind, col, row }`; `AutoDungeon { width, height, skin, seed, cells: RenderCell[], decor: {x,y,col,row}[] }`; `generateAutotiledDungeon(skinName, seed, opts?)`.

- [ ] **Step 1: Write the failing test**

Create `tests/dungeon2.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateAutotiledDungeon } from '../src/domain/dungeon2';
import { SKINS } from '../src/domain/tilesheet';

const skin = SKINS[0].name;

describe('generateAutotiledDungeon', () => {
  it('is deterministic for the same (skin, seed)', () => {
    const a = generateAutotiledDungeon(skin, 123);
    const b = generateAutotiledDungeon(skin, 123);
    expect(a).toEqual(b);
  });
  it('encloses the room in wall cells and fills the interior with floor', () => {
    const d = generateAutotiledDungeon(skin, 7, { width: 10, height: 8 });
    const at = (x: number, y: number) => d.cells.find((c) => c.x === x && c.y === y)!;
    expect(at(0, 0).kind).toBe('wall');           // corner
    expect(at(5, 0).kind === 'wall' || at(5, 0).kind === 'door').toBe(true); // top border
    expect(at(4, 4).kind).toBe('floor');          // interior
  });
  it('every cell carries a resolved sheet (col,row)', () => {
    const d = generateAutotiledDungeon(skin, 7, { width: 10, height: 8 });
    expect(d.cells.length).toBe(10 * 8);
    expect(d.cells.every((c) => Number.isInteger(c.col) && Number.isInteger(c.row))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/dungeon2.test.ts`
Expected: FAIL — module `dungeon2` not found.

- [ ] **Step 3: Implement `dungeon2.ts`**

Create `src/domain/dungeon2.ts`:

```ts
import { makeRng } from './dungeon';
import { getSkin } from './tilesheet';
import {
  floorEdgeMask, resolveFloor, resolveWall, resolveDoor, type KindAt, type LogicalKind,
} from './autotile';

export interface RenderCell { x: number; y: number; kind: LogicalKind; col: number; row: number; }
export interface AutoDungeon {
  width: number; height: number; skin: string; seed: number;
  cells: RenderCell[];
  decor: { x: number; y: number; col: number; row: number }[];
}
export interface GenOpts { width?: number; height?: number; }

export function generateAutotiledDungeon(
  skinName: string, seed: number, opts: GenOpts = {},
): AutoDungeon {
  const skin = getSkin(skinName);
  if (!skin) throw new Error(`unknown skin: ${skinName}`);
  const width = opts.width ?? 20;
  const height = opts.height ?? 15;
  const rng = makeRng(seed);

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
  // doors: 2-4 non-corner border cells
  const doorCount = 2 + Math.floor(rng() * 3);
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

  const kindAt: KindAt = (x, y) =>
    x < 0 || y < 0 || x >= width || y >= height ? null : kinds[y][x];

  // 2) Resolve every cell to a sheet coord.
  const cells: RenderCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const kind = kinds[y][x];
      let coord;
      if (kind === 'wall') coord = resolveWall(skin);
      else if (kind === 'door') coord = resolveDoor(skin);
      else coord = resolveFloor(skin, floorEdgeMask(kindAt, x, y));
      cells.push({ x, y, kind, col: coord.col, row: coord.row });
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
  const decorCount = skin.decor.length === 0 ? 0 : Math.min(interior.length, 6 + Math.floor(rng() * 7));
  const decor = [];
  for (let i = 0; i < decorCount; i++) {
    const d = skin.decor[Math.min(skin.decor.length - 1, Math.floor(rng() * skin.decor.length))];
    decor.push({ x: interior[i].x, y: interior[i].y, col: d.col, row: d.row });
  }

  return { width, height, skin: skinName, seed, cells, decor };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dungeon2.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/dungeon2.ts tests/dungeon2.test.ts
git commit -m "feat(dungeon2): deterministic sheet-driven autotiled generator"
```

---

### Task 4: Preview route, sheet serving, flag

**Files:**
- Modify: `src/config.ts`, `src/web/app.ts`
- Create: `src/web/routes/dungeon-preview.ts`, `src/web/views/dungeon-preview.ejs`
- Test: `tests/web-dungeon-preview.test.ts`

**Interfaces:**
- Consumes: `generateAutotiledDungeon`, `AutoDungeon` (Task 3); `SKINS`, `SHEET` (Task 1); `config.enableDungeonPreview`; `renderPage`, `asyncHandler`, `AppDeps`.
- Produces: `registerDungeonPreviewRoutes(app, deps)`; `GET /dungeon-preview` (only when enabled); `/sheet/world.png` static.

- [ ] **Step 1: Add the config flag**

In `src/config.ts`, add to the `Config` interface (after `enableCatalog: boolean;`):

```ts
  enableDungeonPreview: boolean;
```

and in `loadConfig`'s returned object (after the `enableCatalog` entry):

```ts
    enableDungeonPreview:
      env.ENABLE_DUNGEON_PREVIEW === '1' || env.ENABLE_DUNGEON_PREVIEW === 'true',
```

- [ ] **Step 2: Write the failing route test**

Create `tests/web-dungeon-preview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

describe('dungeon-preview route gating', () => {
  it('404s when the flag is off', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({}) });
    const res = await request(app).get('/dungeon-preview');
    expect(res.status).toBe(404);
  });
  it('renders when ENABLE_DUNGEON_PREVIEW=1', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({ ENABLE_DUNGEON_PREVIEW: '1' }) });
    const res = await request(app).get('/dungeon-preview');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dungeon Preview');
    expect(res.text).toContain('/sheet/world.png');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/web-dungeon-preview.test.ts`
Expected: FAIL — route not mounted (404 on both).

- [ ] **Step 4: Create the route**

Create `src/web/routes/dungeon-preview.ts`:

```ts
import type { Express } from 'express';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { SHEET, SKINS } from '../../domain/tilesheet';
import { generateAutotiledDungeon } from '../../domain/dungeon2';

export function registerDungeonPreviewRoutes(app: Express, { config }: AppDeps): void {
  if (!config.enableDungeonPreview) return;
  app.get(
    '/dungeon-preview',
    asyncHandler(async (_req, res) => {
      const seeds = [1, 2, 3];
      const samples = SKINS.flatMap((s) =>
        seeds.map((seed) => generateAutotiledDungeon(s.name, seed, { width: 18, height: 13 })),
      );
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

- [ ] **Step 5: Create the view**

Create `src/web/views/dungeon-preview.ejs`:

```ejs
<style>
  body { background:#0e0b14; color:#cfc8e6; font:13px monospace; }
  .dp-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(360px,1fr)); gap:16px; }
  .dp-cell { background:#1b1726; border:1px solid #2c2740; border-radius:6px; padding:8px; }
  .dp-cell canvas { width:100%; image-rendering: pixelated; background:#000; }
  .dp-meta { color:#8a83a6; margin-top:4px; }
</style>
<h1>Dungeon Preview</h1>
<p class="dp-meta">Sheet: <%= sheet.url %> — <%= samples.length %> samples</p>
<div class="dp-grid">
  <% samples.forEach(function(d, i){ %>
    <div class="dp-cell">
      <canvas id="dp<%= i %>" width="<%= d.width*24 %>" height="<%= d.height*24 %>"></canvas>
      <div class="dp-meta"><%= d.skin %> — seed <%= d.seed %></div>
      <script type="application/json" class="dp-data" data-target="dp<%= i %>"><%- JSON.stringify(d) %></script>
    </div>
  <% }) %>
</div>
<script>
  const TILE = 24, SHEET_URL = <%- JSON.stringify(sheet.url) %>;
  const img = new Image();
  img.onload = () => document.querySelectorAll('.dp-data').forEach((s) => {
    const d = JSON.parse(s.textContent);
    const cv = document.getElementById(s.dataset.target);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    d.cells.forEach((c) => ctx.drawImage(img, c.col*TILE, c.row*TILE, TILE, TILE, c.x*TILE, c.y*TILE, TILE, TILE));
    d.decor.forEach((p) => ctx.drawImage(img, p.col*TILE, p.row*TILE, TILE, TILE, p.x*TILE, p.y*TILE, TILE, TILE));
  });
  img.src = SHEET_URL;
</script>
```

- [ ] **Step 6: Wire route + serve the sheet in `app.ts`**

In `src/web/app.ts`, add the import next to the other route imports:

```ts
import { registerDungeonPreviewRoutes } from './routes/dungeon-preview';
```

Serve only the one sheet file (not the whole parent dir, which holds PSDs and
the doc) via an alias route, right after the existing `app.use('/sprites', ...)` line:

```ts
  app.get('/sheet/world.png', (_req, res) =>
    res.sendFile(path.resolve(config.spritesDir, '..', 'oryx_16bit_fantasy_world_trans.png')),
  );
```

And register the preview route right after `registerCatalogRoutes(app, { db, config });`:

```ts
  registerDungeonPreviewRoutes(app, { db, config });
```

- [ ] **Step 7: Run the route test + full suite + typecheck**

Run: `npx vitest run tests/web-dungeon-preview.test.ts && npx vitest run && npx tsc --noEmit`
Expected: gating tests pass; full suite green; tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/web/app.ts src/web/routes/dungeon-preview.ts src/web/views/dungeon-preview.ejs tests/web-dungeon-preview.test.ts
git commit -m "feat(dungeon2): gated /dungeon-preview + serve world sheet"
```

---

### Task 5: Visual validation + iterate the decode

**Files:** Modify `src/domain/tilesheet.ts` only (refine decoded offsets), as needed.

This task has no new tests — it is the visual gate where the decoded offsets from Task 1 get confirmed/corrected, the same build-then-iterate loop used for the creature catalog.

- [ ] **Step 1: Run with the preview enabled**

Run: `ENABLE_DUNGEON_PREVIEW=1 PORT=8096 npm start`
Open `http://localhost:8096/dungeon-preview`.

- [ ] **Step 2: Inspect cohesion**

For each sample confirm: walls form a clean skinned border, floors fill the interior and the floor-to-wall edges read correctly (interior = full tile; cells against the border use edge/corner tiles), doors sit on the border, decor sits on interior floor. Compare skins look distinct.

- [ ] **Step 3: Correct offsets if needed**

If a floor edge/corner is wrong, adjust that mask's entry in `FLOOR_EDGES`; if a skin's wall/floor/door looks wrong, adjust that skin's base in `SKINS`. Re-run the structural tests (`npx vitest run tests/tilesheet.test.ts`) and refresh the page. Repeat until the preview reads cleanly.

- [ ] **Step 4: Commit any corrections**

```bash
git add src/domain/tilesheet.ts
git commit -m "fix(dungeon2): correct decoded tile offsets after preview review"
```

---

## Manual verification (after all tasks)

1. `ENABLE_DUNGEON_PREVIEW=1 PORT=8096 npm start` → open `/dungeon-preview`.
2. Confirm cohesive, skinned, autotiled dungeons across ≥2 skins × 3 seeds, with correct floor edges, walls, doors, decor.
3. Confirm the live game is unaffected: `/tv` still renders via the old pipeline; full suite green; `tsc` clean.
4. This proves scope B. Follow-ons (separate specs): live `/tv` integration, the full 47-tile blob + pseudo-3D wall fronts, the remaining skins + open-world floors, then sub-projects 2 (bestiary) and 3 (themed encounters).

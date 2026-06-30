# Sprite Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dev-only, flag-gated `/catalog` route that shows every creature, world tile, and class-sheet sprite with its file index, parsed name, and current in-game assignment — the basis for fixing `MONSTER_TIERS`/`BOSSES` and the tile manifest (phase 2).

**Architecture:** A committed name array (`CREATURE_SHEET_NAMES`, extracted from `creature_key.doc`) plus a pure `buildCatalog()` view-model builder, surfaced by an Express route that is only mounted when `config.enableCatalog` is true. Sprites render via the existing `/sprites` static mount.

**Tech Stack:** TypeScript (ESM via tsx), Express 4, EJS, better-sqlite3 (already open), vitest + supertest.

## Global Constraints

- Node 26 + better-sqlite3 v12; run everything with `tsx`/ESM (no build step).
- Async Express handlers MUST be wrapped in `asyncHandler` (`src/web/async.ts`).
- No external runtime assets — inline all CSS/JS in the EJS view (kiosk is offline, no bundler).
- Catalog is **read-only and dev-only**: off by default, never mounted unless `ENABLE_CATALOG=1`. Touches no DB or game state.
- `assets/` is gitignored; only the small parsed name list lives in the repo.
- `CREATURE_SHEET_NAMES[i]` aligns 1:1 to `creatures_24x24` file index `i + 1` (`[0..17]` = class avatars, `[18..]` = monsters). The doc names **198** entries (files 1–198, verified visually as distinct 1:1 sprites); files 199–396 are additional creatures the doc does not name, so they get `name = null`.

---

## File Structure

- `src/config.ts` (modify) — add `enableCatalog` flag.
- `scripts/dev/gen-spritenames.mjs` (create) — one-time generator: `creature_key.doc` → `spritenames.ts` (macOS `textutil`).
- `src/web/catalog/spritenames.ts` (create, generated) — `CREATURE_SHEET_NAMES`.
- `src/web/catalog/build.ts` (create) — `spriteIndex()` + pure `buildCatalog()` + types.
- `src/web/routes/catalog.ts` (create) — gated `GET /catalog`.
- `src/web/views/catalog.ejs` (create) — the page (inline CSS/JS).
- `src/web/app.ts` (modify) — wire the route in.
- `README.md` (modify) — short dev note.
- Tests: `tests/config.test.ts`, `tests/spritenames.test.ts`, `tests/catalog-build.test.ts`, `tests/web-catalog.test.ts` (create).

---

### Task 1: Config flag `enableCatalog`

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config.enableCatalog: boolean`; `loadConfig(env)` sets it from `env.ENABLE_CATALOG` (`'1'` or `'true'` → true, else false).

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig enableCatalog', () => {
  it('defaults to false', () => {
    expect(loadConfig({}).enableCatalog).toBe(false);
  });
  it('is true when ENABLE_CATALOG=1', () => {
    expect(loadConfig({ ENABLE_CATALOG: '1' }).enableCatalog).toBe(true);
  });
  it('is true when ENABLE_CATALOG=true', () => {
    expect(loadConfig({ ENABLE_CATALOG: 'true' }).enableCatalog).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `enableCatalog` is `undefined` (property missing from `Config`).

- [ ] **Step 3: Add the field to config**

In `src/config.ts`, add to the `Config` interface (after `spritesDir: string;`):

```ts
  enableCatalog: boolean;
```

And in the object returned by `loadConfig` (after the `spritesDir` entry):

```ts
    enableCatalog:
      env.ENABLE_CATALOG === '1' || env.ENABLE_CATALOG === 'true',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add enableCatalog flag (ENABLE_CATALOG)"
```

---

### Task 2: Creature name data (`spritenames.ts`)

**Files:**
- Create: `scripts/dev/gen-spritenames.mjs`
- Create (generated): `src/web/catalog/spritenames.ts`
- Test: `tests/spritenames.test.ts`

**Interfaces:**
- Consumes: nothing (reads the local, gitignored `creature_key.doc`).
- Produces: `export const CREATURE_SHEET_NAMES: string[]` — every non-blank line of `creature_key.doc` in order.

- [ ] **Step 1: Write the generator**

Create `scripts/dev/gen-spritenames.mjs`:

```js
#!/usr/bin/env node
// Regenerate src/web/catalog/spritenames.ts from creature_key.doc.
// macOS only (uses `textutil`). Re-run when the key changes:
//   node scripts/dev/gen-spritenames.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const DOC = 'assets/oryx_16-bit_fantasy_1.1/creature_key.doc';
const OUT = 'src/web/catalog/spritenames.ts';

const txt = execFileSync('textutil', ['-convert', 'txt', '-stdout', DOC], {
  encoding: 'utf8',
});
const names = txt
  .split('\n')
  .map((l) => l.replace(/\r/g, '').trim())
  .filter((l) => l.length > 0);

const body = names.map((n) => `  ${JSON.stringify(n)},`).join('\n');
const out = `// AUTO-GENERATED by scripts/dev/gen-spritenames.mjs from creature_key.doc.
// Do not edit by hand. Names in doc order; CREATURE_SHEET_NAMES[i] aligns to
// creatures_24x24 file index i+1 (so [0..17] are the class avatars).
export const CREATURE_SHEET_NAMES: string[] = [
${body}
];
`;
mkdirSync('src/web/catalog', { recursive: true });
writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${names.length} names)`);
```

- [ ] **Step 2: Run the generator**

Run: `node scripts/dev/gen-spritenames.mjs`
Expected: prints `wrote src/web/catalog/spritenames.ts (N names)` where N is 198 (the doc names 198 creatures; the 396 sprite files include 198 the doc does not name), and the file exists.

- [ ] **Step 3: Write the sanity test**

Create `tests/spritenames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CREATURE_SHEET_NAMES } from '../src/web/catalog/spritenames';

describe('CREATURE_SHEET_NAMES', () => {
  it('begins with the 18 class avatars, then creatures', () => {
    expect(CREATURE_SHEET_NAMES[0]).toBe('Knight M');
    expect(CREATURE_SHEET_NAMES[17]).toBe('Paladin F');
    expect(CREATURE_SHEET_NAMES[18]).toBe('Bandit');
  });
  it('covers the doc-named creature entries', () => {
    // The doc names 198 entries (files 1-198); files 199-396 are unnamed.
    expect(CREATURE_SHEET_NAMES.length).toBeGreaterThanOrEqual(198);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/spritenames.test.ts`
Expected: PASS. If `[18]` is not `'Bandit'`, the doc has extra blank-handling quirks — inspect `textutil -convert txt -stdout assets/oryx_16-bit_fantasy_1.1/creature_key.doc | sed -n '1,30p'` and adjust the filter, then regenerate.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/gen-spritenames.mjs src/web/catalog/spritenames.ts tests/spritenames.test.ts
git commit -m "feat(catalog): extract creature_key.doc names to spritenames.ts"
```

---

### Task 3: Pure view-model builder (`build.ts`)

**Files:**
- Create: `src/web/catalog/build.ts`
- Test: `tests/catalog-build.test.ts`

**Interfaces:**
- Consumes: `ThemeTiles` from `src/domain/tilemanifest.ts`.
- Produces:
  - `spriteIndex(file: string): number`
  - `buildCatalog(input: CatalogInput): CatalogView`
  - types `SpriteCell`, `CatalogView`, `ClassAvatar`, `CatalogInput` (see code).

- [ ] **Step 1: Write the failing test**

Create `tests/catalog-build.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCatalog, spriteIndex } from '../src/web/catalog/build';
import type { ThemeTiles } from '../src/domain/tilemanifest';

const themes: Record<string, ThemeTiles> = {
  stone_crypt: {
    wall: 'oryx_16bit_fantasy_world_70.png',
    wallVariants: ['oryx_16bit_fantasy_world_71.png'],
    floor: 'oryx_16bit_fantasy_world_59.png',
    floorVariants: ['oryx_16bit_fantasy_world_60.png'],
    door: 'oryx_16bit_fantasy_world_208.png',
    decor: ['oryx_16bit_fantasy_world_94.png'],
  },
};

function run() {
  return buildCatalog({
    creatureFiles: [
      'oryx_16bit_fantasy_creatures_01.png', // class avatar Knight M
      'oryx_16bit_fantasy_creatures_19.png', // Bandit: tier 1 + boss (fake)
      'oryx_16bit_fantasy_creatures_50.png', // unused
    ],
    worldFiles: [
      'oryx_16bit_fantasy_world_70.png',  // stone_crypt.wall
      'oryx_16bit_fantasy_world_999.png', // unused
    ],
    classSheetFiles: ['oryx_16bit_fantasy_classes_trans_03.png'],
    creatureNames: ['Knight M', ...Array(17).fill('x'), 'Bandit'], // [18] -> idx 19
    tiers: [[19]],
    bosses: [19],
    classAvatars: [{ name: 'Knight M', index: 1 }],
    themes,
  });
}

describe('spriteIndex', () => {
  it('parses the trailing number', () => {
    expect(spriteIndex('oryx_16bit_fantasy_creatures_01.png')).toBe(1);
    expect(spriteIndex('oryx_16bit_fantasy_world_1142.png')).toBe(1142);
  });
});

describe('buildCatalog', () => {
  it('annotates class avatars, tiers+boss, unused; aligns names', () => {
    const v = run();
    const c1 = v.creatures.find((c) => c.index === 1)!;
    expect(c1.annotation).toEqual(['class: Knight M']);
    expect(c1.name).toBe('Knight M');

    const c19 = v.creatures.find((c) => c.index === 19)!;
    expect(c19.annotation).toEqual(['tier 1', 'boss']);
    expect(c19.name).toBe('Bandit');

    const c50 = v.creatures.find((c) => c.index === 50)!;
    expect(c50.annotation).toEqual(['unused']);
    expect(c50.name).toBe(null);
  });

  it('annotates world tile roles and unused', () => {
    const v = run();
    expect(v.worldTiles.find((t) => t.index === 70)!.annotation).toEqual(['stone_crypt.wall']);
    expect(v.worldTiles.find((t) => t.index === 999)!.annotation).toEqual(['unused']);
  });

  it('marks the class sheet as candidate art', () => {
    const v = run();
    expect(v.classSheet[0].annotation).toEqual(['unused — candidate class art (#2)']);
    expect(v.counts.classSheet).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/catalog-build.test.ts`
Expected: FAIL — cannot find module `../src/web/catalog/build`.

- [ ] **Step 3: Write the implementation**

Create `src/web/catalog/build.ts`:

```ts
import type { ThemeTiles } from '../../domain/tilemanifest';

export interface SpriteCell {
  index: number;
  file: string;
  name: string | null;
  annotation: string[];
}

export interface CatalogView {
  creatures: SpriteCell[];
  worldTiles: SpriteCell[];
  classSheet: SpriteCell[];
  counts: { creatures: number; worldTiles: number; classSheet: number };
}

export interface ClassAvatar {
  name: string; // e.g. "Knight M"
  index: number; // creatures_24x24 file index
}

export interface CatalogInput {
  creatureFiles: string[];
  worldFiles: string[];
  classSheetFiles: string[];
  creatureNames: string[]; // CREATURE_SHEET_NAMES, aligned [i] -> file index i+1
  tiers: number[][]; // MONSTER_TIERS
  bosses: number[]; // BOSSES
  classAvatars: ClassAvatar[];
  themes: Record<string, ThemeTiles>;
}

/** Parse the trailing integer from an oryx sprite filename. */
export function spriteIndex(file: string): number {
  const m = file.match(/_(\d+)\.png$/i);
  return m ? parseInt(m[1], 10) : NaN;
}

const byIndex = (a: SpriteCell, b: SpriteCell): number => a.index - b.index;

export function buildCatalog(input: CatalogInput): CatalogView {
  const creatures = input.creatureFiles
    .map((file): SpriteCell => {
      const index = spriteIndex(file);
      const avatar = input.classAvatars.find((a) => a.index === index);
      const annotation: string[] = [];
      if (avatar) {
        annotation.push(`class: ${avatar.name}`);
      } else {
        input.tiers.forEach((tier, t) => {
          if (tier.includes(index)) annotation.push(`tier ${t + 1}`);
        });
        if (input.bosses.includes(index)) annotation.push('boss');
        if (annotation.length === 0) annotation.push('unused');
      }
      return { index, file, name: input.creatureNames[index - 1] ?? null, annotation };
    })
    .sort(byIndex);

  const worldTiles = input.worldFiles
    .map((file): SpriteCell => {
      const index = spriteIndex(file);
      const annotation: string[] = [];
      for (const [theme, t] of Object.entries(input.themes)) {
        if (file === t.wall) annotation.push(`${theme}.wall`);
        if (t.wallVariants?.includes(file)) annotation.push(`${theme}.wallVariant`);
        if (file === t.floor) annotation.push(`${theme}.floor`);
        if (t.floorVariants.includes(file)) annotation.push(`${theme}.floorVariant`);
        if (file === t.door) annotation.push(`${theme}.door`);
        if (t.decor.includes(file)) annotation.push(`${theme}.decor`);
      }
      if (annotation.length === 0) annotation.push('unused');
      return { index, file, name: null, annotation };
    })
    .sort(byIndex);

  const classSheet = input.classSheetFiles
    .map((file): SpriteCell => ({
      index: spriteIndex(file),
      file,
      name: null,
      annotation: ['unused — candidate class art (#2)'],
    }))
    .sort(byIndex);

  return {
    creatures,
    worldTiles,
    classSheet,
    counts: {
      creatures: creatures.length,
      worldTiles: worldTiles.length,
      classSheet: classSheet.length,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/catalog-build.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/catalog/build.ts tests/catalog-build.test.ts
git commit -m "feat(catalog): pure buildCatalog view-model + spriteIndex"
```

---

### Task 4: Gated route, view, and wiring

**Files:**
- Create: `src/web/routes/catalog.ts`
- Create: `src/web/views/catalog.ejs`
- Modify: `src/web/app.ts`
- Modify: `README.md`
- Test: `tests/web-catalog.test.ts`

**Interfaces:**
- Consumes: `buildCatalog` (Task 3), `CREATURE_SHEET_NAMES` (Task 2), `config.enableCatalog` (Task 1), `MONSTER_TIERS`/`BOSSES` from `creatures.ts`, `CLASSES`/`spriteIndexFor` from `classes.ts`, `TILE_MANIFEST` from `tilemanifest.ts`, `renderPage`/`asyncHandler`/`AppDeps`.
- Produces: `registerCatalogRoutes(app, deps)`; mounts `GET /catalog` only when `config.enableCatalog`.

- [ ] **Step 1: Write the failing test**

Create `tests/web-catalog.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-rpg-sprites-'));
  for (const sub of ['creatures_24x24', 'world_24x24', 'classes_26x28']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, 'creatures_24x24', 'oryx_16bit_fantasy_creatures_19.png'), '');
  writeFileSync(join(dir, 'world_24x24', 'oryx_16bit_fantasy_world_70.png'), '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('catalog route gating', () => {
  it('404s when ENABLE_CATALOG is unset', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({ SPRITES_DIR: dir }) });
    const res = await request(app).get('/catalog');
    expect(res.status).toBe(404);
  });

  it('renders the catalog when ENABLE_CATALOG=1', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({ SPRITES_DIR: dir, ENABLE_CATALOG: '1' }) });
    const res = await request(app).get('/catalog');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sprite Catalog');
    expect(res.text).toContain('oryx_16bit_fantasy_creatures_19.png');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-catalog.test.ts`
Expected: FAIL — both return 404 (route not wired yet); the second assertion fails.

- [ ] **Step 3: Write the route**

Create `src/web/routes/catalog.ts`:

```ts
import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { buildCatalog } from '../catalog/build';
import { CREATURE_SHEET_NAMES } from '../catalog/spritenames';
import { MONSTER_TIERS, BOSSES } from '../../domain/creatures';
import { CLASSES, spriteIndexFor } from '../../domain/classes';
import { TILE_MANIFEST } from '../../domain/tilemanifest';

function listPngs(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'));
  } catch {
    return [];
  }
}

export function registerCatalogRoutes(app: Express, { config }: AppDeps): void {
  if (!config.enableCatalog) return;
  const base = path.resolve(config.spritesDir);

  app.get(
    '/catalog',
    asyncHandler(async (_req, res) => {
      const classAvatars = CLASSES.flatMap((c) =>
        (['M', 'F'] as const).map((g) => ({
          name: `${c.name} ${g}`,
          index: spriteIndexFor(c.key, g),
        })),
      );
      const view = buildCatalog({
        creatureFiles: listPngs(path.join(base, 'creatures_24x24')),
        worldFiles: listPngs(path.join(base, 'world_24x24')),
        classSheetFiles: listPngs(path.join(base, 'classes_26x28')),
        creatureNames: CREATURE_SHEET_NAMES,
        tiers: MONSTER_TIERS,
        bosses: BOSSES,
        classAvatars,
        themes: TILE_MANIFEST,
      });
      res.send(await renderPage('catalog', { title: 'Sprite Catalog', view }));
    }),
  );
}
```

- [ ] **Step 4: Write the view**

Create `src/web/views/catalog.ejs`:

```ejs
<style>
  .cat-section { margin: 1.5rem 0; }
  .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
  .cat-cell { background:#1b1726; border:1px solid #2c2740; border-radius:6px; padding:6px; text-align:center; font:11px monospace; color:#cfc8e6; }
  .cat-cell img { width:48px; height:48px; image-rendering: pixelated; background:#000; }
  .cat-idx { color:#8a83a6; }
  .cat-name { color:#fff; word-break:break-word; }
  .badge { display:inline-block; margin:1px; padding:0 4px; border-radius:4px; font-size:10px; }
  .b-class{background:#1d4ed8;color:#fff}.b-tier{background:#15803d;color:#fff}
  .b-boss{background:#7e22ce;color:#fff}.b-unused{background:#3a3550;color:#9a93b6}.b-role{background:#0e7490;color:#fff}
  .cat-controls{margin:.4rem 0;font:12px monospace;color:#cfc8e6}
  .cat-filter{padding:4px 8px;width:240px;margin-right:8px}
</style>
<h1>Sprite Catalog</h1>
<%
  function badge(a){
    var cls='b-role';
    if(a.indexOf('class:')===0)cls='b-class';
    else if(a.indexOf('tier')===0)cls='b-tier';
    else if(a==='boss')cls='b-boss';
    else if(a.indexOf('unused')===0)cls='b-unused';
    return '<span class="badge '+cls+'">'+a+'</span>';
  }
  function section(title, cells, cat){
%>
  <div class="cat-section">
    <h2><%= title %> (<%= cells.length %>)</h2>
    <div class="cat-controls">
      <input class="cat-filter" placeholder="filter by name / index / role…" oninput="catFilter(this)">
      <label><input type="checkbox" onchange="catUnused(this)"> only unused</label>
    </div>
    <div class="cat-grid">
      <% cells.forEach(function(c){ %>
        <div class="cat-cell"
             data-search="<%= (c.index + ' ' + (c.name || '') + ' ' + c.annotation.join(' ')).toLowerCase() %>"
             data-unused="<%= c.annotation.some(function(a){ return a.indexOf('unused')===0; }) %>">
          <img src="/sprites/<%= cat %>/<%= c.file %>" loading="lazy" alt="<%= c.file %>">
          <div class="cat-idx">#<%= c.index %></div>
          <% if (c.name) { %><div class="cat-name"><%= c.name %></div><% } %>
          <div><%- c.annotation.map(badge).join('') %></div>
        </div>
      <% }) %>
    </div>
  </div>
<% } %>
<% section('Creatures', view.creatures, 'creatures_24x24') %>
<% section('World tiles', view.worldTiles, 'world_24x24') %>
<% section('Class sheet', view.classSheet, 'classes_26x28') %>
<script>
  function catFilter(inp){
    var q = inp.value.toLowerCase();
    inp.closest('.cat-section').querySelectorAll('.cat-cell').forEach(function(c){
      c.style.display = c.dataset.search.indexOf(q) >= 0 ? '' : 'none';
    });
  }
  function catUnused(cb){
    cb.closest('.cat-section').querySelectorAll('.cat-cell').forEach(function(c){
      c.style.display = (!cb.checked || c.dataset.unused === 'true') ? '' : 'none';
    });
  }
</script>
```

- [ ] **Step 5: Wire the route into the app**

In `src/web/app.ts`, add the import next to the other route imports (after the `registerTvRoutes` import on line 13):

```ts
import { registerCatalogRoutes } from './routes/catalog';
```

And register it right after the `registerTvRoutes(...)` block (after line 58, before the `(app as unknown ...)` line):

```ts
  registerCatalogRoutes(app, { db, config });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/web-catalog.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Add a dev note to the README**

Append this section to the end of `README.md`:

```markdown
## Sprite catalog (dev only)

To browse every sprite with its file index, parsed name, and current in-game
assignment (used for art curation), run with the catalog flag and open
`/catalog`:

```bash
ENABLE_CATALOG=1 npm start   # then open http://localhost:8080/catalog
```

It is off by default and never mounted on the kiosk.
```

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/web/routes/catalog.ts src/web/views/catalog.ejs src/web/app.ts README.md tests/web-catalog.test.ts
git commit -m "feat(catalog): gated /catalog route + view"
```

---

## Manual verification (after all tasks)

1. `ENABLE_CATALOG=1 PORT=8095 npm start`
2. Open `http://localhost:8095/catalog` in Chrome.
3. Confirm three sections render with images; creature `#1` shows `class: Knight M`, the monster tiers show their `tier N`/`boss` badges, and the filter + "only unused" toggle work.
4. This is the worksheet for phase 2 (fixing `MONSTER_TIERS`/`BOSSES` + tile manifest) — note any misaligned names/indices for that pass.

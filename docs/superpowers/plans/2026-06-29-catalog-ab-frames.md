# Catalog A/B-Frame Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/catalog` creatures section A/B-aware — collapse each animation pair into one cell that flips A↔B every second, with corrected names — backed by a portable, dependency-free animation library the dungeon view can reuse later.

**Architecture:** A standalone browser ESM module `anim.js` carries the renderer-agnostic frame math (+18 pairing, frame selection) plus a shared-clock DOM flip. `buildCatalog` is reworked to emit `creaturePairs` (one per frame-A file) with the corrected "Model B" name mapping. The catalog view renders animated stacked-frame cells; world-tiles and class-sheet sections are unchanged.

**Tech Stack:** TypeScript (tsx/ESM), Express 4, EJS, vitest + supertest. No bundler — browser JS is plain ESM served from `/static`.

## Global Constraints

- Run via tsx/ESM, no build step. `tsc --noEmit` must stay clean.
- Catalog stays dev-only, OFF by default (`ENABLE_CATALOG`), read-only. Async handlers use `asyncHandler`.
- No external runtime assets — all CSS/JS inline or same-origin static (offline kiosk).
- Badge HTML stays escaped via the EJS `esc()` helper.
- **Sheet model:** `creatures_24x24` is 22×18=396 animation A/B pairs. Frame A = odd sheet rows: `Math.floor((index-1)/18) % 2 === 0`. Animation partner = `+18` for a frame-A file, `-18` for a frame-B file. (index is 1-based.)
- **"Model B" name mapping** (`nameForCreatureFile`): files 1–18 → `names[index-1]` (the 18 class A-frames); files 37–216 → `names[index-19]` (doc names shifted past the 18 unlisted class B-frames); files 19–36 and 217+ → `null`.
- `anim.js` must not touch the DOM at module scope (only inside functions), so it is safe to import server-side / in vitest. The frame-math is intentionally duplicated between `anim.js` (browser) and `build.ts` (server) — there is no bundler to share one source across the two runtimes.
- Animation flip period: ~1000ms, one shared clock for the whole page.

---

## File Structure

- `src/web/public/anim.js` (create) — portable browser ESM: frame math + shared-clock DOM flip.
- `src/web/public/anim.d.ts` (create) — type declarations so TS consumers/tests can import the `.js`.
- `src/web/catalog/build.ts` (modify) — `nameForCreatureFile` + `creaturePairs` + types.
- `src/web/views/catalog.ejs` (modify) — render `creaturePairs` (Task 2 static, Task 3 animated).
- Tests: `tests/anim.test.ts` (create), `tests/catalog-build.test.ts` (rewrite), `tests/web-catalog.test.ts` (modify).
- `src/web/routes/catalog.ts` — unchanged (it passes inputs to `buildCatalog`; only the output shape changes).

---

### Task 1: Portable animation library `anim.js`

**Files:**
- Create: `src/web/public/anim.js`
- Create: `src/web/public/anim.d.ts`
- Test: `tests/anim.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (ESM exports): `isFrameA(fileIndex: number): boolean`, `framePartner(fileIndex: number): number`, `frameAt(nowMs: number, periodMs: number): 0 | 1`, `start(opts?: { periodMs?: number }): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/anim.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isFrameA, framePartner, frameAt } from '../src/web/public/anim.js';

describe('isFrameA', () => {
  it('odd sheet rows (frame A) vs even rows (frame B)', () => {
    expect(isFrameA(1)).toBe(true);    // row 1
    expect(isFrameA(18)).toBe(true);   // row 1
    expect(isFrameA(19)).toBe(false);  // row 2 (B)
    expect(isFrameA(37)).toBe(true);   // row 3 (A)
    expect(isFrameA(55)).toBe(false);  // row 4 (B)
    expect(isFrameA(217)).toBe(true);  // row 13 (A)
  });
});

describe('framePartner', () => {
  it('pairs frame A with +18 and frame B with -18', () => {
    expect(framePartner(1)).toBe(19);
    expect(framePartner(19)).toBe(1);
    expect(framePartner(37)).toBe(55);
    expect(framePartner(55)).toBe(37);
    expect(framePartner(217)).toBe(235);
  });
});

describe('frameAt', () => {
  it('toggles 0/1 across each period boundary', () => {
    expect(frameAt(0, 1000)).toBe(0);
    expect(frameAt(999, 1000)).toBe(0);
    expect(frameAt(1000, 1000)).toBe(1);
    expect(frameAt(1999, 1000)).toBe(1);
    expect(frameAt(2000, 1000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/anim.test.ts`
Expected: FAIL — cannot resolve `../src/web/public/anim.js`.

- [ ] **Step 3: Create the module**

Create `src/web/public/anim.js`:

```js
// Portable two-frame sprite animation for ClaudeRPG.
// creatures_24x24 is a 22x18 sheet of A/B animation pairs: a frame-A sprite at
// file index N has its animation partner at N+18 (the next row). Frame A = odd
// rows. This module carries that math (renderer-agnostic — used by the catalog
// now and the TV dungeon view later) plus a DOM flip helper for <img> pages.
// No imports and no DOM access at module scope, so it is safe to import in Node
// (server / unit tests); DOM is only touched inside start().
const ROW = 18;

/** True if the 1-based file index is a frame-A sprite (odd sheet row). */
export function isFrameA(fileIndex) {
  return Math.floor((fileIndex - 1) / ROW) % 2 === 0;
}

/** Animation partner file index: +ROW for a frame-A file, -ROW for a frame-B file. */
export function framePartner(fileIndex) {
  return isFrameA(fileIndex) ? fileIndex + ROW : fileIndex - ROW;
}

/** Which frame (0 or 1) to show at time nowMs given a flip period. */
export function frameAt(nowMs, periodMs) {
  return Math.floor(nowMs / periodMs) % 2;
}

/**
 * Start a shared-clock flip. Every element with class `sprite-anim` holds a
 * `.frame-a` and a `.frame-b` child; on each tick the container toggles the
 * `show-b` class so the whole page flips in sync. One timer drives everything.
 */
export function start(opts) {
  const periodMs = (opts && opts.periodMs) || 1000;
  const tick = () => {
    const showB = frameAt(Date.now(), periodMs) === 1;
    document.querySelectorAll('.sprite-anim').forEach((el) => {
      el.classList.toggle('show-b', showB);
    });
  };
  tick();
  setInterval(tick, periodMs);
}
```

- [ ] **Step 4: Create the type declarations**

Create `src/web/public/anim.d.ts`:

```ts
export function isFrameA(fileIndex: number): boolean;
export function framePartner(fileIndex: number): number;
export function frameAt(nowMs: number, periodMs: number): 0 | 1;
export function start(opts?: { periodMs?: number }): void;
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run tests/anim.test.ts && npx tsc --noEmit`
Expected: 3 describe blocks pass; tsc clean (the `.d.ts` satisfies the `.js` import).

- [ ] **Step 6: Commit**

```bash
git add src/web/public/anim.js src/web/public/anim.d.ts tests/anim.test.ts
git commit -m "feat(catalog): portable anim.js sprite-flip library (+18 frame pairing)"
```

---

### Task 2: Corrected data model — `creaturePairs` + Model B names

**Files:**
- Modify: `src/web/catalog/build.ts`
- Modify: `src/web/views/catalog.ejs` (creatures section → static pair cells; keeps the suite green)
- Test: `tests/catalog-build.test.ts` (rewrite), `tests/web-catalog.test.ts` (fixture + assertion)

**Interfaces:**
- Consumes: existing `CatalogInput` (unchanged), `spriteIndex`.
- Produces: `nameForCreatureFile(index: number, names: string[]): string | null`; type `CreaturePair { aIndex; aFile; aName; bIndex; bFile; bName; annotation }`; `CatalogView.creaturePairs: CreaturePair[]` (replaces `creatures`); `counts.creaturePairs`.

- [ ] **Step 1: Rewrite the build unit test (failing)**

Replace the entire contents of `tests/catalog-build.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { buildCatalog, spriteIndex, nameForCreatureFile } from '../src/web/catalog/build';
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

function names37(): string[] {
  const n = Array(37).fill('x');
  n[0] = 'Knight M';
  n[17] = 'Paladin F';
  n[18] = 'Bandit';     // file 37 -> names[37-19]=names[18]
  n[36] = 'Bandit B';   // file 55 -> names[55-19]=names[36]
  return n;
}

function run() {
  return buildCatalog({
    creatureFiles: [
      'oryx_16bit_fantasy_creatures_01.png', // frame A (class Knight M); partner 19
      'oryx_16bit_fantasy_creatures_19.png', // frame B of #1
      'oryx_16bit_fantasy_creatures_37.png', // frame A (Bandit); partner 55
      'oryx_16bit_fantasy_creatures_55.png', // frame B of #37
    ],
    worldFiles: [
      'oryx_16bit_fantasy_world_70.png',  // stone_crypt.wall
      'oryx_16bit_fantasy_world_71.png',  // stone_crypt.wallVariant
      'oryx_16bit_fantasy_world_59.png',  // stone_crypt.floor
      'oryx_16bit_fantasy_world_60.png',  // stone_crypt.floorVariant
      'oryx_16bit_fantasy_world_208.png', // stone_crypt.door
      'oryx_16bit_fantasy_world_94.png',  // stone_crypt.decor
      'oryx_16bit_fantasy_world_999.png', // unused
    ],
    classSheetFiles: ['oryx_16bit_fantasy_classes_trans_03.png'],
    creatureNames: names37(),
    tiers: [[37]],
    bosses: [37],
    classAvatars: [{ name: 'Knight M', index: 1 }],
    themes,
  });
}

describe('spriteIndex', () => {
  it('parses the trailing number', () => {
    expect(spriteIndex('oryx_16bit_fantasy_creatures_01.png')).toBe(1);
    expect(spriteIndex('oryx_16bit_fantasy_world_1142.png')).toBe(1142);
  });
  it('returns NaN for a non-sprite filename', () => {
    expect(Number.isNaN(spriteIndex('not-a-sprite.txt'))).toBe(true);
  });
});

describe('nameForCreatureFile (Model B)', () => {
  const names = (() => {
    const n = Array(200).fill('x');
    n[0] = 'Knight M'; n[17] = 'Paladin F'; n[18] = 'Bandit'; n[36] = 'Bandit B'; n[197] = 'Last';
    return n;
  })();
  it('maps classes and +18-shifted creatures, nulls the gaps', () => {
    expect(nameForCreatureFile(1, names)).toBe('Knight M');
    expect(nameForCreatureFile(18, names)).toBe('Paladin F');
    expect(nameForCreatureFile(19, names)).toBe(null); // class B-frame gap
    expect(nameForCreatureFile(36, names)).toBe(null);
    expect(nameForCreatureFile(37, names)).toBe('Bandit');
    expect(nameForCreatureFile(55, names)).toBe('Bandit B');
    expect(nameForCreatureFile(216, names)).toBe('Last'); // 216-19 = 197
    expect(nameForCreatureFile(217, names)).toBe(null);
  });
});

describe('buildCatalog creaturePairs', () => {
  it('one pair per frame-A file, +18 partner, both names, A-frame annotation', () => {
    const v = run();
    expect(v.creaturePairs.length).toBe(2);
    expect(v.counts.creaturePairs).toBe(2);

    const p1 = v.creaturePairs.find((p) => p.aIndex === 1)!;
    expect(p1.bIndex).toBe(19);
    expect(p1.aFile).toBe('oryx_16bit_fantasy_creatures_01.png');
    expect(p1.bFile).toBe('oryx_16bit_fantasy_creatures_19.png');
    expect(p1.aName).toBe('Knight M');
    expect(p1.bName).toBe(null);
    expect(p1.annotation).toEqual(['class: Knight M']);

    const p37 = v.creaturePairs.find((p) => p.aIndex === 37)!;
    expect(p37.bIndex).toBe(55);
    expect(p37.aName).toBe('Bandit');
    expect(p37.bName).toBe('Bandit B');
    expect(p37.annotation).toEqual(['tier 1', 'boss']);
  });
});

describe('buildCatalog world tiles + class sheet (unchanged)', () => {
  it('annotates every world tile role and unused', () => {
    const v = run();
    const role = (i: number) => v.worldTiles.find((t) => t.index === i)!.annotation;
    expect(role(70)).toEqual(['stone_crypt.wall']);
    expect(role(71)).toEqual(['stone_crypt.wallVariant']);
    expect(role(59)).toEqual(['stone_crypt.floor']);
    expect(role(60)).toEqual(['stone_crypt.floorVariant']);
    expect(role(208)).toEqual(['stone_crypt.door']);
    expect(role(94)).toEqual(['stone_crypt.decor']);
    expect(role(999)).toEqual(['unused']);
  });
  it('marks the class sheet as candidate art', () => {
    const v = run();
    expect(v.classSheet[0].annotation).toEqual(['unused — candidate class art (#2)']);
    expect(v.counts.classSheet).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/catalog-build.test.ts`
Expected: FAIL — `nameForCreatureFile` not exported / `creaturePairs` undefined.

- [ ] **Step 3: Update `build.ts`**

In `src/web/catalog/build.ts`: (a) replace the `CatalogView` interface, (b) add `CreaturePair`, (c) add `ROW`, `isFrameA`, `nameForCreatureFile`, (d) replace the `creatures` construction with `creaturePairs` and update the returned object.

Replace the `CatalogView` interface with:

```ts
export interface CatalogView {
  creaturePairs: CreaturePair[];
  worldTiles: SpriteCell[];
  classSheet: SpriteCell[];
  counts: { creaturePairs: number; worldTiles: number; classSheet: number };
}

export interface CreaturePair {
  aIndex: number;
  aFile: string;
  aName: string | null;
  bIndex: number;
  bFile: string | null;
  bName: string | null;
  annotation: string[];
}
```

Add these helpers after `spriteIndex` (above `buildCatalog`):

```ts
// creatures_24x24 is a 22x18 sheet of animation A/B pairs. Frame A = odd rows;
// animation partner is +18. Duplicated in anim.js for the browser (no bundler).
const ROW = 18;

function isFrameA(index: number): boolean {
  return Math.floor((index - 1) / ROW) % 2 === 0;
}

/** Doc-name for a creature file under the verified "Model B" mapping:
 *  1..18 -> the 18 class names; 37..216 -> doc name shifted past the 18 class
 *  B-frames; files 19..36 (class B-frames) and 217+ are unnamed. */
export function nameForCreatureFile(index: number, names: string[]): string | null {
  if (index >= 1 && index <= 18) return names[index - 1] ?? null;
  if (index >= 37 && index <= 216) return names[index - 19] ?? null;
  return null;
}
```

Replace the entire `const creatures = input.creatureFiles ... .sort(byIndex);` block with:

```ts
  const fileByIndex = new Map<number, string>();
  for (const file of input.creatureFiles) fileByIndex.set(spriteIndex(file), file);

  const creaturePairs: CreaturePair[] = input.creatureFiles
    .filter((file) => isFrameA(spriteIndex(file)))
    .map((file): CreaturePair => {
      const aIndex = spriteIndex(file);
      const bIndex = aIndex + ROW;
      const avatar = input.classAvatars.find((a) => a.index === aIndex);
      const annotation: string[] = [];
      if (avatar) {
        annotation.push(`class: ${avatar.name}`);
      } else {
        input.tiers.forEach((tier, t) => {
          if (tier.includes(aIndex)) annotation.push(`tier ${t + 1}`);
        });
        if (input.bosses.includes(aIndex)) annotation.push('boss');
        if (annotation.length === 0) annotation.push('unused');
      }
      return {
        aIndex,
        aFile: file,
        aName: nameForCreatureFile(aIndex, input.creatureNames),
        bIndex,
        bFile: fileByIndex.get(bIndex) ?? null,
        bName: nameForCreatureFile(bIndex, input.creatureNames),
        annotation,
      };
    })
    .sort((a, b) => a.aIndex - b.aIndex);
```

Update the returned object: replace `creatures,` with `creaturePairs,` and in `counts` replace `creatures: creatures.length,` with `creaturePairs: creaturePairs.length,`. (Leave `byIndex`, `worldTiles`, `classSheet` as-is.)

- [ ] **Step 4: Run the build test to verify it passes**

Run: `npx vitest run tests/catalog-build.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Update the catalog view to render pairs (static)**

In `src/web/views/catalog.ejs`, replace the line:

```ejs
<% section('Creatures', view.creatures, 'creatures_24x24') %>
```

with this block (static single-frame render for now; Task 3 animates it):

```ejs
<div class="cat-section">
  <h2>Creatures (<%= view.creaturePairs.length %>)</h2>
  <div class="cat-controls">
    <input class="cat-filter" placeholder="filter by name / index / role…" oninput="catApply(this)">
    <label><input type="checkbox" class="cat-unused" onchange="catApply(this)"> only unused</label>
  </div>
  <div class="cat-grid">
    <% view.creaturePairs.forEach(function(p){ %>
      <div class="cat-cell"
           data-search="<%= (p.aIndex + ' ' + p.bIndex + ' ' + (p.aName || '') + ' ' + (p.bName || '') + ' ' + p.annotation.join(' ')).toLowerCase() %>"
           data-unused="<%= p.annotation.some(function(a){ return a.indexOf('unused') === 0; }) %>">
        <img src="/sprites/creatures_24x24/<%= p.aFile %>" loading="lazy" alt="<%= p.aFile %>">
        <div class="cat-idx">#<%= p.aIndex %> ↔ #<%= p.bIndex %></div>
        <div class="cat-name"><%= p.aName || '—' %> / <%= p.bName || '—' %></div>
        <div><%- p.annotation.map(badge).join('') %></div>
      </div>
    <% }) %>
  </div>
</div>
```

- [ ] **Step 6: Update the route test fixture**

In `tests/web-catalog.test.ts`, replace the single creature stub line:

```ts
  writeFileSync(join(dir, 'creatures_24x24', 'oryx_16bit_fantasy_creatures_19.png'), '');
```

with a frame-A file and its partner:

```ts
  writeFileSync(join(dir, 'creatures_24x24', 'oryx_16bit_fantasy_creatures_01.png'), '');
  writeFileSync(join(dir, 'creatures_24x24', 'oryx_16bit_fantasy_creatures_19.png'), '');
```

And change the render assertion line:

```ts
    expect(res.text).toContain('oryx_16bit_fantasy_creatures_19.png');
```

to assert the frame-A file (the static render shows `aFile`):

```ts
    expect(res.text).toContain('oryx_16bit_fantasy_creatures_01.png');
```

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; tsc clean. (The catalog renders static pair cells with corrected names.)

- [ ] **Step 8: Commit**

```bash
git add src/web/catalog/build.ts src/web/views/catalog.ejs tests/catalog-build.test.ts tests/web-catalog.test.ts
git commit -m "feat(catalog): creaturePairs + Model B name mapping (static pair cells)"
```

---

### Task 3: Animate the pair cells

**Files:**
- Modify: `src/web/views/catalog.ejs` (stacked frames + CSS + load `anim.js`)
- Test: `tests/web-catalog.test.ts` (assert frame-B image + anim module present)

**Interfaces:**
- Consumes: `anim.js` `start()` (Task 1); `CreaturePair.bFile` (Task 2).
- Produces: animated catalog (no new exports).

- [ ] **Step 1: Extend the route test (failing)**

In `tests/web-catalog.test.ts`, inside the `'renders the catalog when ENABLE_CATALOG=1'` test, after the existing `expect(res.text).toContain('oryx_16bit_fantasy_creatures_01.png');` line, add:

```ts
    expect(res.text).toContain('oryx_16bit_fantasy_creatures_19.png'); // frame-B image
    expect(res.text).toContain('/static/anim.js');                     // animation module
    expect(res.text).toContain('sprite-anim');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/web-catalog.test.ts`
Expected: FAIL — the static render has no frame-B image, no `anim.js`, no `sprite-anim`.

- [ ] **Step 3: Add the stacked-frame CSS**

In `src/web/views/catalog.ejs`, inside the `<style>` block, add after the `.cat-cell img` rule:

```css
  .sprite-anim { position: relative; width: 48px; height: 48px; margin: 0 auto; }
  .sprite-anim img { position: absolute; top: 0; left: 0; }
  .sprite-anim .frame-b { visibility: hidden; }
  .sprite-anim.show-b .frame-a { visibility: hidden; }
  .sprite-anim.show-b .frame-b { visibility: visible; }
```

- [ ] **Step 4: Replace the static creature image with stacked frames**

In the creatures block added in Task 2, replace this line:

```ejs
        <img src="/sprites/creatures_24x24/<%= p.aFile %>" loading="lazy" alt="<%= p.aFile %>">
```

with:

```ejs
        <div class="sprite-anim">
          <img class="frame-a" src="/sprites/creatures_24x24/<%= p.aFile %>" loading="lazy" alt="<%= p.aFile %>">
          <% if (p.bFile) { %><img class="frame-b" src="/sprites/creatures_24x24/<%= p.bFile %>" loading="lazy" alt="<%= p.bFile %>"><% } %>
        </div>
```

- [ ] **Step 5: Load and start the animation library**

In `src/web/views/catalog.ejs`, after the existing `</script>` (the one containing `catApply`), add:

```ejs
<script type="module">
  import { start } from '/static/anim.js';
  start({ periodMs: 1000 });
</script>
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/web/views/catalog.ejs tests/web-catalog.test.ts
git commit -m "feat(catalog): animate creature pairs A<->B via anim.js"
```

---

## Manual verification (after all tasks)

1. `ENABLE_CATALOG=1 PORT=8095 npm start`
2. Open `http://localhost:8095/catalog`.
3. Creatures section: each cell flips A↔B every ~1s in sync; shows `#A ↔ #B` and both names (`—` where unnamed). A mismatched pair will visibly jump.
4. Confirm corrected names: file 1 cell reads "Knight M / —"; the first NPC pair (#37 ↔ #55) reads "Bandit / …". Note any flip/name mismatches for the follow-up `MONSTER_TIERS`/`BOSSES` fix and the name-mapping refinement.
5. World-tiles and class-sheet sections render unchanged.

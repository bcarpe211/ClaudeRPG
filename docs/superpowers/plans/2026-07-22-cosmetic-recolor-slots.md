# Cosmetic Recolor — Slot System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players recolor every material on their character sprite while preserving shading — including the white/grey/black regions the current hue-swap cannot touch — building toward independent per-slot color sliders.

**Architecture:** Recoloring is two orthogonal concerns. (1) *Shadow preservation* is a per-pixel color-space transform that keeps each pixel's brightness and changes only its chroma — `hueSwap` for chromatic materials, `colorize` for achromatic ones, `valueRemap` for greyscale finish. (2) *Isolation* (which slider affects which pixels) is a per-sprite **slot map**: a 24×24 index image labeling each pixel with the material it belongs to. Phase 1 adds the transforms and fixes the achromatic-dominant classes using the existing hex sets and single hue wheel. Phase 2 replaces hex matching with slot maps and exposes per-slot HSLA controls.

**Tech Stack:** TypeScript (ESM via tsx), Express (+ `asyncHandler` wrapper for async routes), better-sqlite3, pngjs, vitest + supertest, Zod for input validation.

**Companion reference:** `docs/cosmetics-recolor-regions.md` — the per-character slot inventory, exact hex sets, chromatic/achromatic classification, collision list, and the UI channel presence matrix. Phase 2 slot taxonomy comes from that doc's §4.

## Global Constraints

- Node 26 + better-sqlite3 v12; run via tsx (ESM). Match existing import style: **no file extensions** in relative imports.
- Every async Express handler MUST be wrapped in `asyncHandler` (`src/web/async`).
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Frequent commits, one per task.
- Never touch `data/` or `node_modules/`. The tint cache lives beside the DB in `tint-cache/`.
- The shared outline color `#262626`/`#1b1b1b` is NEVER recolored by any slot.
- Test commands: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit).

---

# PHASE 1 — Add colorize + value-remap; fix the achromatic-dominant classes

Ships immediately and is safe to iterate on mid-session. After Phase 1 the **existing single hue wheel works on all 9 classes**, including priest (white robe), berserker (grey helmet), and paladin (white plate), which are currently no-ops because their defining garment is achromatic and `hueSwap` leaves S=0 pixels grey.

## File structure (Phase 1)
- Modify `src/domain/spritetint.ts` — extract `hsvToRgb`/`rgbToHsv`, add `colorize` + `valueRemap`, change `recolorSprite` to take a rule list.
- Modify `src/domain/cosmetics.ts` — richer `CLOTHING` shape (`op`, `sat`); switch priest/berserker/paladin dominant sets to their achromatic ramp with `op: 'colorize'`.
- Modify `src/web/routes/shop.ts` — build a rule list from the class's `CLOTHING` entry.
- Create `tests/spritetint.test.ts` — unit tests for the transforms.
- Modify `tests/web-tint.test.ts` — assert a priest robe pixel becomes saturated.

---

### Task 1: Add `colorize` and refactor HSV helpers in `spritetint.ts`

**Files:**
- Modify: `src/domain/spritetint.ts`
- Test: `tests/spritetint.test.ts` (create)

**Interfaces:**
- Produces: `hsvToRgb(hDeg:number, s:number, v:number): [number,number,number]`, `rgbToHsv(r:number,g:number,b:number): [number,number,number]` (h in degrees), `hueSwap(r,g,b,hueDeg): [number,number,number]` (unchanged behavior), `colorize(r:number,g:number,b:number, hueDeg:number, sat:number): [number,number,number]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/spritetint.test.ts
import { describe, it, expect } from 'vitest';
import { colorize, hueSwap } from '../src/domain/spritetint';

describe('colorize (keeps per-pixel brightness, repaints chroma)', () => {
  it('turns a white pixel into a light saturated color', () => {
    // #f3f3f3 (near-white robe highlight) -> hue 0 (red), sat 0.6
    expect(colorize(243, 243, 243, 0, 0.6)).toEqual([243, 97, 97]);
  });
  it('preserves shading: a darker source stays a darker result', () => {
    const hi = colorize(243, 243, 243, 0, 0.6)[0]; // robe highlight -> R
    const lo = colorize(145, 145, 145, 0, 0.6)[0]; // robe shadow    -> R
    expect(hi).toBeGreaterThan(lo);
  });
  it('hueSwap still leaves a grey pixel grey (documents the limitation colorize fixes)', () => {
    expect(hueSwap(200, 200, 200, 120)).toEqual([200, 200, 200]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- spritetint`
Expected: FAIL — `colorize` is not exported.

- [ ] **Step 3: Implement**

Replace the body of `src/domain/spritetint.ts` above `recolorSprite` with:

```ts
import { PNG } from 'pngjs';

/** HSV (h degrees, s,v in 0..1) → RGB 0..255. */
export function hsvToRgb(hDeg: number, s: number, v: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let rr = 0, gg = 0, bb = 0;
  switch (i % 6) {
    case 0: rr = v; gg = t; bb = p; break;
    case 1: rr = q; gg = v; bb = p; break;
    case 2: rr = p; gg = v; bb = t; break;
    case 3: rr = p; gg = q; bb = v; break;
    case 4: rr = t; gg = p; bb = v; break;
    case 5: rr = v; gg = p; bb = q; break;
  }
  return [Math.round(rr * 255), Math.round(gg * 255), Math.round(bb * 255)];
}

/** RGB 0..255 → HSV (h degrees, s,v in 0..1). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const v = max, s = max === 0 ? 0 : (max - min) / max, d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = ((gf - bf) / d) % 6;
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, v];
}

/** Replace hue, keep saturation & value. Chromatic materials only (S=0 stays grey). */
export function hueSwap(r: number, g: number, b: number, hueDeg: number): [number, number, number] {
  const [, s, v] = rgbToHsv(r, g, b);
  return hsvToRgb(hueDeg, s, v);
}

/** Repaint chroma (hue + injected saturation), KEEP the pixel's brightness ramp.
 *  This is what recolors white/grey/steel while preserving shading. */
export function colorize(r: number, g: number, b: number, hueDeg: number, sat: number): [number, number, number] {
  const v = Math.max(r, g, b) / 255;
  return hsvToRgb(hueDeg, sat, v);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- spritetint`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/spritetint.ts tests/spritetint.test.ts
git commit -m "feat(tint): add colorize + HSV helpers (shadow-preserving recolor)"
```

---

### Task 2: Add `valueRemap` (white↔grey↔black finish)

**Files:**
- Modify: `src/domain/spritetint.ts`
- Test: `tests/spritetint.test.ts`

**Interfaces:**
- Produces: `valueRemap(r:number,g:number,b:number, lo:number, hi:number): [number,number,number]` — remaps brightness into [lo,hi], stays greyscale.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/spritetint.test.ts
import { valueRemap } from '../src/domain/spritetint';

describe('valueRemap (greyscale finish, brightness remapped)', () => {
  it('compresses a white pixel toward mid-grey when hi=0.5', () => {
    expect(valueRemap(243, 243, 243, 0, 0.5)).toEqual([121, 121, 121]);
  });
  it('keeps relative order (highlight stays lighter than shadow)', () => {
    const hi = valueRemap(243, 243, 243, 0, 0.5)[0];
    const lo = valueRemap(145, 145, 145, 0, 0.5)[0];
    expect(hi).toBeGreaterThan(lo);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- spritetint`
Expected: FAIL — `valueRemap` is not exported.

- [ ] **Step 3: Implement** — add to `src/domain/spritetint.ts` after `colorize`:

```ts
/** Keep greyscale; remap brightness into [lo,hi]. lo=0,hi=1 is identity. */
export function valueRemap(r: number, g: number, b: number, lo: number, hi: number): [number, number, number] {
  const v = Math.max(r, g, b) / 255;
  const c = Math.round((lo + v * (hi - lo)) * 255);
  return [c, c, c];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- spritetint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/spritetint.ts tests/spritetint.test.ts
git commit -m "feat(tint): add valueRemap for greyscale finish slider"
```

---

### Task 3: Rule-list `recolorSprite` (multi-slot, multi-op ready)

**Files:**
- Modify: `src/domain/spritetint.ts`
- Test: `tests/spritetint.test.ts`

**Interfaces:**
- Produces: `interface RecolorRule { hexes: string[]; op: 'hue' | 'colorize' | 'value'; hue?: number; sat?: number; lo?: number; hi?: number }` and `recolorSprite(pngBuffer: Buffer, rules: RecolorRule[]): Buffer`.
- **Breaking change:** the old `recolorSprite(buf, hexes, hueDeg)` signature is replaced. Only caller is `src/web/routes/shop.ts` (updated in Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/spritetint.test.ts
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { recolorSprite } from '../src/domain/spritetint';

const PRIEST_M_A = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/oryx_16bit_fantasy_creatures_05.png';

describe('recolorSprite (rule list)', () => {
  it('colorizes the priest white robe into a saturated red', () => {
    const out = recolorSprite(readFileSync(PRIEST_M_A), [
      { hexes: ['#c9c9c9', '#f3f3f3', '#919191'], op: 'colorize', hue: 0, sat: 0.6 },
    ]);
    const png = PNG.sync.read(out);
    let found = false;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i] === 243 && png.data[i + 1] === 97 && png.data[i + 2] === 97) { found = true; break; }
    }
    expect(found).toBe(true); // #f3f3f3 robe highlight -> (243,97,97)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- spritetint`
Expected: FAIL — `recolorSprite` still expects the old `(buf, string[], number)` signature (type error / wrong output).

- [ ] **Step 3: Implement** — replace the existing `recolorSprite` at the bottom of `src/domain/spritetint.ts`:

```ts
export interface RecolorRule {
  hexes: string[];
  op: 'hue' | 'colorize' | 'value';
  hue?: number;   // 'hue', 'colorize'
  sat?: number;   // 'colorize'
  lo?: number;    // 'value'
  hi?: number;    // 'value'
}

/** Apply per-slot transforms to matching pixels. Later rules win on hex collision. */
export function recolorSprite(pngBuffer: Buffer, rules: RecolorRule[]): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const map = new Map<string, (r: number, g: number, b: number) => [number, number, number]>();
  for (const rule of rules) {
    const fn = rule.op === 'colorize'
      ? (r: number, g: number, b: number) => colorize(r, g, b, rule.hue ?? 0, rule.sat ?? 0.6)
      : rule.op === 'value'
        ? (r: number, g: number, b: number) => valueRemap(r, g, b, rule.lo ?? 0, rule.hi ?? 1)
        : (r: number, g: number, b: number) => hueSwap(r, g, b, rule.hue ?? 0);
    for (const h of rule.hexes) map.set(h.replace('#', '').toLowerCase(), fn);
  }
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const hex = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0');
    const fn = map.get(hex);
    if (fn) { const [r, g, b] = fn(d[i], d[i + 1], d[i + 2]); d[i] = r; d[i + 1] = g; d[i + 2] = b; }
  }
  return PNG.sync.write(png);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- spritetint`
Expected: PASS. (Route test in `web-tint` will fail to compile until Task 4 — that's expected; run `spritetint` in isolation here.)

- [ ] **Step 5: Commit**

```bash
git add src/domain/spritetint.ts tests/spritetint.test.ts
git commit -m "refactor(tint): recolorSprite takes a rule list (multi-op)"
```

---

### Task 4: Richer `CLOTHING`, wire the route, fix priest/berserker/paladin

**Files:**
- Modify: `src/domain/cosmetics.ts:5-15` (the `CLOTHING` map)
- Modify: `src/web/routes/shop.ts:37`
- Test: `tests/web-tint.test.ts`

**Interfaces:**
- Consumes: `recolorSprite(buf, RecolorRule[])` (Task 3).
- Produces: `interface ClothingRule { dominant: string[]; op?: 'hue' | 'colorize'; sat?: number; secondary?: string[]; weapon?: string[] }`; `CLOTHING: Record<string, ClothingRule>` (unchanged export name — `.dominant` still present, so `/shop` and `cosmetics-map.test.ts` keep working).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/web-tint.test.ts
it('colorizes the priest white robe (was a no-op under hue-swap)', async () => {
  const res = await request(app()).get('/sprite/tint/priest_M/a/0.png'); // hue 0 = red
  expect(res.status).toBe(200);
  const png = PNG.sync.read(res.body);
  let saturatedReds = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (png.data[i + 3] > 0 && r > 120 && r - Math.max(g, b) > 60) saturatedReds++;
  }
  expect(saturatedReds).toBeGreaterThan(20); // the robe is now red, not grey
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-tint`
Expected: FAIL — priest dominant is still `['#cf3232']` (only the small red cross), robe stays grey, few/no saturated reds beyond the existing cross.

- [ ] **Step 3: Implement**

In `src/domain/cosmetics.ts`, replace the `CLOTHING` declaration (lines 4-15) with:

```ts
/** Which palette colors are the recolorable clothing ramp, per class. Hand-authored + verified.
 *  `op` selects the recolor operation for the dominant ramp: 'hue' (chromatic, default) or
 *  'colorize' (achromatic — white/grey garments, keeps shading via injected saturation). */
export interface ClothingRule {
  dominant: string[];
  op?: 'hue' | 'colorize';
  sat?: number;
  secondary?: string[];
  weapon?: string[];
}
export const CLOTHING: Record<string, ClothingRule> = {
  knight: { dominant: ['#3cbcfc', '#9adcfd', '#2985b2'] },
  thief: { dominant: ['#1eba4a', '#24e35a'] },
  ranger: { dominant: ['#476575', '#7c94a4'] },
  wizard: { dominant: ['#cf3232', '#ff3d3d'] },
  priest: { dominant: ['#c9c9c9', '#f3f3f3', '#919191'], op: 'colorize', sat: 0.6 }, // white robe
  shaman: { dominant: ['#887000', '#b89600'] },
  berserker: { dominant: ['#616060', '#919191', '#9c9c9c', '#c9c9c9'], op: 'colorize', sat: 0.55 }, // grey helm
  swordsman: { dominant: ['#0e7cb3'] },
  paladin: { dominant: ['#f3f3f3', '#ffffff', '#c9c9c9', '#bdbdbd', '#919191'], op: 'colorize', sat: 0.5 }, // white plate
};
```

Note: `swordsman` drops `#b86e28` from the old dominant — that hex is the skin-shadow tone and recoloring it tinted skin. Blue shirt only now.

In `src/web/routes/shop.ts`, replace line 37 (`const out = recolorSprite(...)`) with:

```ts
    const c = CLOTHING[classKey];
    const rule = c.op === 'colorize'
      ? { hexes: c.dominant, op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
      : { hexes: c.dominant, op: 'hue' as const, hue };
    const out = recolorSprite(fs.readFileSync(srcFile), [rule]);
```

- [ ] **Step 3b: Update the swordsman assertion in the map test if present**

Run: `npm test -- cosmetics-map`
Expected: PASS unchanged — the test only checks each dominant hex *exists* in the sprite (it does; all values above were read from the M/A sprites). If it fails, reconcile the hex against the sprite, do not weaken the test.

- [ ] **Step 4: Run tests**

Run: `npm test -- web-tint spritetint cosmetics-map && npm run typecheck`
Expected: PASS all; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/cosmetics.ts src/web/routes/shop.ts tests/web-tint.test.ts
git commit -m "feat(shop): colorize achromatic-dominant classes (priest/berserker/paladin) via the hue wheel"
```

---

### Task 5: Manual verification in the running app

- [ ] **Step 1:** Start the app: `npm run dev`
- [ ] **Step 2:** Open `/sprite/tint/priest_M/a/0.png`, `/240.png`, `/120.png` — the robe should read red / blue / green with folds visible (not flat). Repeat for `berserker_M` and `paladin_M`.
- [ ] **Step 3:** Confirm a chromatic class is unchanged: `/sprite/tint/wizard_M/a/120.png` still hue-swaps the red robe to green.
- [ ] **Step 4:** Delete stale cache if colors look old: `rm -rf <dbdir>/tint-cache` and re-request. (Cache key is `class_gender_frame_hue`; unchanged this phase.)
- [ ] **Step 5:** Note in the PR description that female sprites remain no-ops (see Phase 2 §Female).

**Phase 1 acceptance:** the single hue wheel visibly recolors all 9 male classes with shading preserved; chromatic classes unchanged; all tests + typecheck green.

---

# PHASE 2 — Slot maps + per-slot HSLA sliders (spec)

Phase 2 is a larger subsystem with open design decisions (below). Treat this section as the **spec to turn into its own bite-sized plan** once Phase 1 lands and the decisions are made. Do NOT start coding Phase 2 from this section directly — write the detailed plan first (superpowers:writing-plans), resolving the open decisions.

## Why slot maps
Hex matching cannot separate materials that share a palette entry — blonde hair == gold trim == boots (`#887000`); dark hair == outline (`#262626`); white robe == white shield-cross == white boots. See `docs/cosmetics-recolor-regions.md` §2 (collisions) and §3 (per-character slots). A per-pixel **slot map** labels each pixel with the material it belongs to, so each slider targets exactly its pixels regardless of shared color.

## Proposed architecture
- **Slot taxonomy** (`src/domain/slotmap.ts`): a `SLOT` enum from the presence matrix (`docs` §4): `0 outline (never tinted)`, `1 body`, `2 headgear`, `3 hair`, `4 facePaint`, `5 cape`, `6 trim`, `7 weapon`, `8 shield`, `9 boots`, `10 skin`, `11 flair`.
- **Slot map storage:** one 24×24 indexed PNG per sprite (36 files) under `assets/slotmaps/<class>_<M|F>_<a|b>.png`, each pixel colored by slot id from a fixed legend palette. Hand-editable in any pixel editor. Loader reads a slotmap → `Uint8Array(576)` of slot ids, cached in memory. (An index map is preferred over N stacked layer-PNGs because static-sprite regions never overlap — no z-order, no compositing, smaller storage. Literal layers are only needed for *reshaping*, e.g. weapon swap — see below.)
- **Render:** `recolorSpriteSlots(pngBuffer, slotIds: Uint8Array, perSlot: Map<number, RecolorRule>): Buffer` — walk pixels, look up `slotIds[pixelIndex]`, apply that slot's rule; slot 0 and unmapped slots pass through untouched. This subsumes and eventually retires the hex-based `CLOTHING` matching.
- **Data model (migration 008):** child table keyed on `(player_id, slot)`:
  ```sql
  CREATE TABLE player_slot_cosmetics (
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    slot       INTEGER NOT NULL,
    mode       TEXT NOT NULL DEFAULT 'hue',   -- 'hue' | 'colorize' | 'value'
    hue        INTEGER, sat REAL, val_lo REAL, val_hi REAL,
    strength   REAL NOT NULL DEFAULT 1,       -- lerp(original, recolored) for subtle tints
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, slot)
  );
  ```
  Migrate the existing `player_cosmetics.primary_hue` into `(slot=1 body, mode per class)` so no one loses their color.
- **Route + cache:** many params → hash them. `GET /sprite/skin/:sprite/:frame/:hash.png`, where `:hash` is a content hash of the player's full slot config; the view builds the URL from that config, the route rebuilds it, applies, caches by hash. Keep the immutable Cache-Control.
- **UI:** the shop page renders only the channels present for the class (presence matrix), each channel a control (hue wheel + saturation + value + strength, optionally curated preset ramps). Hide absent channels — a wizard shows body/trim/weapon/flair only; a paladin shows the full set.
- **Authoring tool** (`tools/slotmap-editor.html`, dev-only): render a sprite at ~20×, click-to-paint slot ids, export the slotmap PNG. Seed each map automatically from hex + quadrant heuristics (per the collisions doc), then hand-correct. ~1 hour for all 36 sprites.

## Weapon swap (forward-compat — you flagged wanting this)
Keep weapon pixels as their own slot (`7 weapon`) now. Swapping weapons later = render the base sprite with slot-7 pixels **omitted**, then composite a separate weapon sprite (its own tiny PNG + its own slotmap) on top at a defined anchor. The index-map + per-slot-rule design does not block this; the weapon overlay is a **separate future plan** (it introduces true layering + z-order + anchor offsets per frame). Isolating the weapon slot in Phase 2 is the enabling step.

## Female sprites
Female sprites are palette-swapped variants with different dominant hues (blue→red, green→teal, etc.), so male hex sets match nothing → tint no-ops (`docs` §7). Phase 2 needs female slot maps (`*_F_a.png`, `*_F_b.png`) and re-verified palettes. Author them alongside male maps, but gate female tinting behind confirmation that the female render bug is fixed.

## Open decisions (resolve before writing the Phase 2 plan)
1. Slot storage: child table (above, recommended) vs a JSON `slots` column on `player_cosmetics`.
2. Per-channel controls: hue+sat+value+strength, and/or curated preset ramps? How many sliders is too many for the shop UX?
3. Cache-key scheme for many params (content hash — confirm hash fn + URL shape).
4. Authoring: build the `slotmap-editor.html` tool vs pure-script seeding + manual PNG edits.
5. Final slot taxonomy (confirm the 12-slot list against every class in `docs` §3/§4).

---

## Self-Review (Phase 1)
- **Spec coverage:** transforms (Tasks 1-2), rule-list engine (Task 3), data + wiring for the achromatic fix (Task 4), verification (Task 5). Phase 2 captured as spec with explicit decisions. ✓
- **Placeholders:** none — every code step shows complete code; every command shows expected result. ✓
- **Type consistency:** `RecolorRule`/`recolorSprite(buf, rules)` defined in Task 3 and consumed verbatim in Task 4; `ClothingRule` keeps the `.dominant` field so `/shop` (`shop.ts:58`) and `cosmetics-map.test.ts` are unaffected; `hsvToRgb`/`colorize`/`valueRemap` signatures match across tasks. ✓
- **Numbers verified:** `colorize(243,243,243,0,0.6) = [243,97,97]`, `valueRemap(243,243,243,0,0.5) = [121,121,121]`; all Task-4 dominant hexes were read from the M/A sprites so `cosmetics-map` passes. ✓

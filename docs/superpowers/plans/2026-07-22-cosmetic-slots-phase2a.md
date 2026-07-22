# Cosmetic Slot System — Phase 2A: slot-map render engine (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hex-based sprite recolor with a **slot-map** recolor: a per-pixel index image labels each pixel with its material slot (body, weapon, hair, cape, shield…), so coloring a slot touches exactly its pixels. This fixes every collision from Phase 1 (wizard eyes, shaman staff, berserker cape, paladin shield-cross/rim) at the render layer.

**Architecture:** Two orthogonal concerns, already split by Phase 1. (1) *Shadow-preserving transforms* — `hueSwap`/`colorize`/`valueRemap` (shipped). (2) *Isolation* — which pixels a rule affects. Phase 1 did isolation by hex-match (collides on shared colors). Phase 2A replaces that with a **24×24 slot-map PNG per sprite**: `readSlotmap` → `Uint8Array(576)` of slot ids, and `recolorSpriteSlots(sprite, slotIds, perSlotRules)` walks pixels and applies each pixel's slot rule. The tint route builds a **single body-slot rule** from the existing stored hue + the class's op, and renders through the slot-map — so nothing about storage, URLs, caching, or the UI changes yet, only the pixels that recolor.

**Scope boundary (what 2A does NOT do — that's 2B/2C):** per-slot player controls, black/white finishes, the character-page picker, the `player_slot_cosmetics` table, and female slot-maps. 2A authors the **9 male** slot-maps and renders the **body** slot from the existing color; other slots are labeled but inert (pass through), so they simply stop being recolored by mistake.

**Tech Stack:** TypeScript (ESM via tsx), better-sqlite3, express (+ `asyncHandler`), pngjs, vitest + supertest.

**Companion refs:** `docs/cosmetics-recolor-regions.md` (per-class slots + hexes + collisions), `docs/superpowers/plans/2026-07-22-cosmetic-recolor-slots.md` (Phase-2 spec + the 5 decisions).

## Global Constraints

- Node 26 + better-sqlite3, ESM via tsx (**no build step**); relative imports use **no file extensions**.
- Every async Express handler wrapped in `asyncHandler` (`src/web/async`).
- TDD: failing test first → watch fail → minimal implement → watch pass → commit, one commit per task.
- **Outline** (`#262626`/`#1b1b1b`) and slot 0 are NEVER recolored.
- Slot-map PNGs are **hand-authored data → committed to git** under `slotmaps/` at the repo root (NOT under the gitignored `assets/`). 24×24, one per sprite frame: `slotmaps/<class>_<M|F>_<a|b>.png`.
- A slot-map pixel's colour is the **legend colour** for its slot (Task 1). Transparent slot-map pixel or unknown colour ⇒ slot 0 (untinted).
- Test commands: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit).
- **Locked decisions (from the Phase-2 spec):** 12-slot taxonomy; storage = child table `player_slot_cosmetics` (2B); controls = hue+sat + finish presets, defer strength (2B); cache = player+frame+content-hash URL (2B); authoring = **seed-script-generated slot-maps, then hand-correct** (this plan).

## File structure (Phase 2A)
- Create `src/domain/slots.ts` — SLOT ids, LEGEND, `readSlotmap`, `loadSlotmap` (+ cache).
- Modify `src/domain/spritetint.ts` — add `SlotRule` + `recolorSpriteSlots`.
- Create `tools/seed-slotmaps.ts` — generate slot-maps from `SLOT_SEED` rules.
- Create `slotmaps/*.png` — the 18 male slot-map files (9 classes × frames a,b).
- Modify `src/web/routes/shop.ts` — the tint route renders through the slot-map (body slot), hex fallback when no slot-map.
- Tests: `tests/slots.test.ts`, `tests/spritetint.test.ts` (append), `tests/seed-slotmaps.test.ts`, `tests/web-tint.test.ts` (append).

---

### Task 1: Slot taxonomy, legend, and slot-map reader

**Files:**
- Create: `src/domain/slots.ts`
- Test: `tests/slots.test.ts`

**Interfaces:**
- Produces: `SLOTS` (const map name→id, 12 entries), `LEGEND` (`Array<[slotId, [r,g,b]]>`), `readSlotmap(pngBuffer: Buffer): Uint8Array` (length = w×h), `loadSlotmap(sprite: string, frame: 'a'|'b'): Uint8Array | null` (reads `slotmaps/<sprite>_<frame>.png`, cached, null if absent).

- [ ] **Step 1: Write the failing test**

```ts
// tests/slots.test.ts
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { SLOTS, LEGEND, readSlotmap, loadSlotmap } from '../src/domain/slots';

describe('slot taxonomy + legend', () => {
  it('has 12 slots and a bijective legend', () => {
    expect(Object.keys(SLOTS).length).toBe(12);
    const slotIds = LEGEND.map(([s]) => s);
    const colors = LEGEND.map(([, c]) => c.join(','));
    expect(new Set(slotIds).size).toBe(LEGEND.length); // unique slots
    expect(new Set(colors).size).toBe(LEGEND.length);  // unique colours
  });
});

describe('readSlotmap', () => {
  it('maps legend colours to slot ids; transparent -> 0', () => {
    const png = new PNG({ width: 3, height: 1 });
    const [bodyId, bodyRgb] = LEGEND.find(([s]) => s === SLOTS.body)!;
    const [weaponId, weaponRgb] = LEGEND.find(([s]) => s === SLOTS.weapon)!;
    png.data.set([...bodyRgb, 255], 0);    // px0 = body
    png.data.set([...weaponRgb, 255], 4);  // px1 = weapon
    png.data.set([0, 0, 0, 0], 8);         // px2 = transparent
    const ids = readSlotmap(PNG.sync.write(png));
    expect(Array.from(ids)).toEqual([bodyId, weaponId, 0]);
  });
});

describe('loadSlotmap', () => {
  it('returns null when a slot-map file is absent', () => {
    expect(loadSlotmap('doesnotexist_M', 'a')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- slots`
Expected: FAIL — module `../src/domain/slots` not found.

- [ ] **Step 3: Implement `src/domain/slots.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/** The 12 material slots (per the regions doc §4). Slot 0 is never tinted. */
export const SLOTS = {
  outline: 0, body: 1, headgear: 2, hair: 3, facePaint: 4, cape: 5,
  trim: 6, weapon: 7, shield: 8, boots: 9, skin: 10, flair: 11,
} as const;

/** Slot id ⇄ legend colour used inside the slot-map PNGs (human-viewable/editable). */
export const LEGEND: Array<[number, [number, number, number]]> = [
  [SLOTS.body, [255, 0, 0]], [SLOTS.headgear, [255, 127, 0]], [SLOTS.hair, [255, 255, 0]],
  [SLOTS.facePaint, [127, 255, 0]], [SLOTS.cape, [0, 255, 0]], [SLOTS.trim, [0, 255, 127]],
  [SLOTS.weapon, [0, 255, 255]], [SLOTS.shield, [0, 127, 255]], [SLOTS.boots, [0, 0, 255]],
  [SLOTS.skin, [127, 0, 255]], [SLOTS.flair, [255, 0, 255]],
  // slot 0 (outline) has no legend colour: transparent / unknown ⇒ 0.
];
const LOOKUP = new Map<number, number>(); // packed rgb -> slot id
for (const [slot, [r, g, b]] of LEGEND) LOOKUP.set((r << 16) | (g << 8) | b, slot);

/** Decode a slot-map PNG → per-pixel slot ids (row-major, same order as the sprite). */
export function readSlotmap(pngBuffer: Buffer): Uint8Array {
  const png = PNG.sync.read(pngBuffer);
  const out = new Uint8Array(png.width * png.height);
  const d = png.data;
  for (let p = 0; p < out.length; p++) {
    const i = p * 4;
    if (d[i + 3] === 0) { out[p] = 0; continue; }
    out[p] = LOOKUP.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) ?? 0;
  }
  return out;
}

const SLOTMAP_DIR = path.resolve('slotmaps');
const cache = new Map<string, Uint8Array | null>();

/** Load `slotmaps/<sprite>_<frame>.png` → slot ids, cached. null when the file is absent. */
export function loadSlotmap(sprite: string, frame: 'a' | 'b'): Uint8Array | null {
  const key = `${sprite}_${frame}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const file = path.join(SLOTMAP_DIR, `${key}.png`);
  const res = fs.existsSync(file) ? readSlotmap(fs.readFileSync(file)) : null;
  cache.set(key, res);
  return res;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- slots`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/slots.ts tests/slots.test.ts
git commit -m "feat(slots): slot taxonomy, legend, and slot-map reader"
```

---

### Task 2: `recolorSpriteSlots` — slot-aware render

**Files:**
- Modify: `src/domain/spritetint.ts`
- Test: `tests/spritetint.test.ts` (append)

**Interfaces:**
- Consumes: `hueSwap`, `colorize`, `valueRemap` (Phase 1).
- Produces: `interface SlotRule { op: 'hue' | 'colorize' | 'value'; hue?: number; sat?: number; lo?: number; hi?: number }` and `recolorSpriteSlots(pngBuffer: Buffer, slotIds: Uint8Array, perSlot: Map<number, SlotRule>): Buffer`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/spritetint.test.ts
import { recolorSpriteSlots, type SlotRule } from '../src/domain/spritetint';

describe('recolorSpriteSlots (per-slot rules, isolation by slot-map)', () => {
  it('applies a slot rule only to that slot; unmapped slots pass through', () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([0xff, 0x3d, 0x3d, 255], 0); // px0, slot 1 (body)
    png.data.set([0xff, 0x3d, 0x3d, 255], 4); // px1, slot 7 (weapon) — SAME colour, different slot
    const slotIds = Uint8Array.from([1, 7]);
    const perSlot = new Map<number, SlotRule>([[1, { op: 'hue', hue: 120 }]]); // only body
    const out = PNG.sync.read(recolorSpriteSlots(PNG.sync.write(png), slotIds, perSlot));
    expect([out.data[0], out.data[1], out.data[2]]).not.toEqual([0xff, 0x3d, 0x3d]); // body recoloured
    expect([out.data[4], out.data[5], out.data[6]]).toEqual([0xff, 0x3d, 0x3d]);     // weapon UNTOUCHED
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- spritetint`
Expected: FAIL — `recolorSpriteSlots` not exported.

- [ ] **Step 3: Implement** — append to `src/domain/spritetint.ts`:

```ts
export interface SlotRule {
  op: 'hue' | 'colorize' | 'value';
  hue?: number;   // 'hue', 'colorize'
  sat?: number;   // 'colorize'
  lo?: number;    // 'value'
  hi?: number;    // 'value'
}

/** Recolour a sprite by per-pixel slot ids. `slotIds[p]` labels pixel p; each slot's
 *  rule is applied to its pixels. Slot 0 and slots with no rule pass through. */
export function recolorSpriteSlots(
  pngBuffer: Buffer, slotIds: Uint8Array, perSlot: Map<number, SlotRule>,
): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const d = png.data;
  const n = Math.min(slotIds.length, d.length / 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (d[i + 3] === 0) continue;
    const rule = perSlot.get(slotIds[p]);
    if (!rule) continue;
    const [r, g, b] = rule.op === 'colorize'
      ? colorize(d[i], d[i + 1], d[i + 2], rule.hue ?? 0, rule.sat ?? 0.6)
      : rule.op === 'value'
        ? valueRemap(d[i], d[i + 1], d[i + 2], rule.lo ?? 0, rule.hi ?? 1)
        : hueSwap(d[i], d[i + 1], d[i + 2], rule.hue ?? 0);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return PNG.sync.write(png);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- spritetint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/spritetint.ts tests/spritetint.test.ts
git commit -m "feat(slots): recolorSpriteSlots — per-slot shadow-preserving recolor"
```

---

### Task 3: Slot-map seeding script

**Files:**
- Create: `tools/seed-slotmaps.ts`
- Test: `tests/seed-slotmaps.test.ts`

**Interfaces:**
- Produces: `SLOT_SEED: Record<string, SeedRule[]>` where `interface SeedRule { slot: number; hexes: string[]; bbox?: [number, number, number, number] }`; `seedSlotmap(spritePng: Buffer, rules: SeedRule[]): Buffer` (returns a slot-map PNG); a CLI `main()` that writes all `slotmaps/<class>_M_<a|b>.png`.

Seeding logic: for each opaque sprite pixel, the **first** matching rule wins (rules ordered specific→general; a rule matches when the pixel's hex ∈ `hexes` AND, if `bbox` is set, the pixel is inside it). The matched slot's legend colour is written; unmatched opaque pixels ⇒ transparent (slot 0). Collisions (eyes, staff, cape) are separated by putting the **bbox rule before** the general body rule.

- [ ] **Step 1: Write the failing test**

```ts
// tests/seed-slotmaps.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { seedSlotmap, SLOT_SEED } from '../tools/seed-slotmaps';
import { readSlotmap, SLOTS } from '../src/domain/slots';

const WIZARD = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/oryx_16bit_fantasy_creatures_04.png';

describe('seedSlotmap', () => {
  it('labels the wizard robe as body and separates the eyes into their own slot', () => {
    const map = readSlotmap(seedSlotmap(readFileSync(WIZARD), SLOT_SEED.wizard));
    const bodyPixels = Array.from(map).filter((s) => s === SLOTS.body).length;
    const eyePixels = Array.from(map).filter((s) => s === SLOTS.flair).length;
    expect(bodyPixels).toBeGreaterThan(30); // the robe is labeled body
    expect(eyePixels).toBeGreaterThan(0);   // the eyes are carved out into flair, not body
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- seed-slotmaps`
Expected: FAIL — `../tools/seed-slotmaps` not found.

- [ ] **Step 3: Implement `tools/seed-slotmaps.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { LEGEND, SLOTS } from '../src/domain/slots';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { creatureSpriteFile, type Gender } from '../src/domain/classes';

export interface SeedRule { slot: number; hexes: string[]; bbox?: [number, number, number, number] }

const LEGEND_RGB = new Map<number, [number, number, number]>(LEGEND.map(([s, c]) => [s, c]));
const hx = (h: string): number => parseInt(h.replace('#', ''), 16);

/** Per-class seed rules. Collision slots (bbox) come BEFORE the general body rule.
 *  Best-effort bboxes — hand-corrected in Task 4. Fill remaining classes from regions §3. */
export const SLOT_SEED: Record<string, SeedRule[]> = {
  wizard: [
    { slot: SLOTS.flair, hexes: ['#ff3d3d'], bbox: [10, 8, 15, 12] },     // eyes (central hood)
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600'], bbox: [0, 0, 6, 23] }, // staff (left)
    { slot: SLOTS.trim, hexes: ['#eaff00'] },                             // robe trim (gold)
    { slot: SLOTS.body, hexes: ['#cf3232', '#ff3d3d', '#3d3d3d'] },       // robe
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  shaman: [
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600'], bbox: [0, 0, 6, 23] }, // staff (left)
    { slot: SLOTS.facePaint, hexes: ['#2985b2'] },
    { slot: SLOTS.body, hexes: ['#887000', '#b89600'] },                  // pelt-hood + body
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  berserker: [
    { slot: SLOTS.cape, hexes: ['#887000', '#b89600'], bbox: [17, 4, 23, 23] },  // cape drape (right)
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600', '#919191', '#c9c9c9'], bbox: [0, 0, 5, 23] }, // axe (left)
    { slot: SLOTS.headgear, hexes: ['#616060', '#919191', '#9c9c9c', '#c9c9c9'] }, // helm (grey)
    { slot: SLOTS.trim, hexes: ['#eaff00'] },                             // headband
    { slot: SLOTS.body, hexes: ['#887000', '#b89600'] },                  // tunic (what's left, center)
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  paladin: [
    { slot: SLOTS.shield, hexes: ['#ffffff', '#0e7cb3', '#0b5e87'], bbox: [12, 11, 23, 23] }, // shield (front-right)
    { slot: SLOTS.flair, hexes: ['#b4c21d'] },                            // plume/crest
    { slot: SLOTS.trim, hexes: ['#887000', '#b89600', '#eaff00'] },       // gold trim/tabard
    { slot: SLOTS.body, hexes: ['#f3f3f3', '#ffffff', '#c9c9c9', '#bdbdbd', '#919191'] }, // helm + plate
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  // knight/thief/ranger/swordsman/priest: fill from regions §3 during Task 4 (mostly hue on the
  // dominant garment with no collisions; priest robe = colorize). Seed at minimum a `body` rule
  // matching the current CLOTHING dominant so the render is unchanged for those classes.
  knight: [{ slot: SLOTS.body, hexes: ['#3cbcfc', '#9adcfd', '#2985b2'] }],
  thief: [{ slot: SLOTS.body, hexes: ['#1eba4a', '#24e35a'] }],
  ranger: [{ slot: SLOTS.body, hexes: ['#476575', '#7c94a4'] }],
  priest: [
    { slot: SLOTS.trim, hexes: ['#cf3232'] },                            // red cross/stole (leave)
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600', '#eaff00'], bbox: [0, 0, 6, 23] }, // ankh staff
    { slot: SLOTS.body, hexes: ['#c9c9c9', '#f3f3f3', '#919191'] },       // white robe
  ],
  swordsman: [{ slot: SLOTS.body, hexes: ['#0e7cb3'] }],
};

/** Seed one slot-map from a sprite + rules. First matching rule wins. */
export function seedSlotmap(spritePng: Buffer, rules: SeedRule[]): Buffer {
  const src = PNG.sync.read(spritePng);
  const out = new PNG({ width: src.width, height: src.height });
  out.data.fill(0);
  const d = src.data;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if (d[i + 3] === 0) continue;
      const rgb = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      for (const rule of rules) {
        if (!rule.hexes.some((h) => hx(h) === rgb)) continue;
        if (rule.bbox) {
          const [x0, y0, x1, y1] = rule.bbox;
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        }
        const [r, g, b] = LEGEND_RGB.get(rule.slot)!;
        out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
        break;
      }
    }
  }
  return PNG.sync.write(out);
}

// CLI: `npx tsx tools/seed-slotmaps.ts` — writes slotmaps/<class>_M_<a|b>.png for every class.
export function main(): void {
  const dir = path.resolve('slotmaps');
  fs.mkdirSync(dir, { recursive: true });
  const spritesDir = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24';
  for (const [cls, rules] of Object.entries(SLOT_SEED)) {
    for (const frame of ['a', 'b'] as const) {
      const idx = spriteFileIndex(cls, 'M' as Gender, frame);
      const sprite = fs.readFileSync(path.join(spritesDir, creatureSpriteFile(idx)));
      fs.writeFileSync(path.join(dir, `${cls}_M_${frame}.png`), seedSlotmap(sprite, rules));
      console.log(`seeded slotmaps/${cls}_M_${frame}.png`);
    }
  }
}
// Node 26 ESM entry check:
if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- seed-slotmaps`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/seed-slotmaps.ts tests/seed-slotmaps.test.ts
git commit -m "feat(slots): slot-map seeding script + per-class seed rules"
```

---

### Task 4: Generate + hand-correct the 9 male slot-maps

**Files:**
- Create: `slotmaps/*.png` (18 files: `<class>_M_a.png`, `<class>_M_b.png`)
- Test: `tests/slotmap-collisions.test.ts`

This task is scripted-seed + a manual pixel-correction pass, gated by an automated collision test.

- [ ] **Step 1: Write the failing test** (asserts the actual collision pixels are labeled their own slot, NOT `body` — so a body recolor can't reach them). This is a slot-map *content* assertion, not a render round-trip, so it can't pass tautologically:

```ts
// tests/slotmap-collisions.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { loadSlotmap, SLOTS } from '../src/domain/slots';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { creatureSpriteFile } from '../src/domain/classes';

const SPRITES = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24';
const hx = (h: string) => parseInt(h.replace('#', ''), 16);
function spritePng(cls: string) {
  return PNG.sync.read(readFileSync(`${SPRITES}/${creatureSpriteFile(spriteFileIndex(cls, 'M', 'a'))}`));
}

// Ground-truth collisions: pixels of `hex` inside `bbox` must be labeled `slot` (never body).
const COLLISIONS: Array<{ cls: string; hex: string; bbox: [number, number, number, number]; slot: number }> = [
  { cls: 'wizard', hex: '#ff3d3d', bbox: [10, 8, 15, 12], slot: SLOTS.flair },    // eyes
  { cls: 'shaman', hex: '#887000', bbox: [0, 0, 6, 23], slot: SLOTS.weapon },      // staff
  { cls: 'berserker', hex: '#887000', bbox: [17, 4, 23, 23], slot: SLOTS.cape },   // cape drape
  { cls: 'paladin', hex: '#ffffff', bbox: [12, 11, 23, 23], slot: SLOTS.shield },  // shield cross
];

describe('slot-maps isolate collision pixels from the body slot', () => {
  for (const c of COLLISIONS) {
    it(`${c.cls}: ${c.hex} in its region is NOT labeled body`, () => {
      const map = loadSlotmap(`${c.cls}_M`, 'a');
      expect(map).not.toBeNull();
      const png = spritePng(c.cls);
      let found = 0, mislabeled = 0;
      for (let y = c.bbox[1]; y <= c.bbox[3]; y++) for (let x = c.bbox[0]; x <= c.bbox[2]; x++) {
        const i = (y * 24 + x) * 4;
        if (png.data[i + 3] === 0) continue;
        if (((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]) !== hx(c.hex)) continue;
        found++;
        if (map![y * 24 + x] === SLOTS.body) mislabeled++; // labeled body ⇒ would recolor with the body
      }
      expect(found).toBeGreaterThan(0);  // the collision pixels exist in the sprite
      expect(mislabeled).toBe(0);        // and none of them are in the body slot
    });
  }
});
```

- [ ] **Step 2: Generate the slot-maps** — run the seeder:

```bash
npx tsx tools/seed-slotmaps.ts
```
Expected: writes 18 files under `slotmaps/`.

- [ ] **Step 3: Run the collision test — expect it may fail on some classes**

Run: `npm test -- slotmap-collisions`
Expected: PASS for classes whose seed bboxes cleanly isolated the collision; FAIL for any where a bbox mislabeled a pixel (body pixel leaked into a collision slot or vice-versa).

- [ ] **Step 4: Hand-correct the maps**

For any failing class, open `slotmaps/<class>_M_a.png` (and `_b`) at high zoom in a pixel editor beside the sprite, and repaint mislabeled pixels to their correct **legend colour** (Task 1): eyes → magenta `#ff00ff` (flair), staff/axe → cyan `#00ffff` (weapon), cape → green `#00ff00`, shield/cross → `#007fff`, body → red `#ff0000`. Re-run `npm test -- slotmap-collisions` until green for all four. (Frame `b` ≈ frame `a` shifted ~1px — start from the corrected `a` and nudge.)

- [ ] **Step 5: Commit**

```bash
git add slotmaps/ tests/slotmap-collisions.test.ts
git commit -m "feat(slots): author + verify the 9 male slot-maps (collisions isolated)"
```

---

### Task 5: Render the tint route through the slot-map

**Files:**
- Modify: `src/web/routes/shop.ts` (the `/sprite/tint` handler)
- Test: `tests/web-tint.test.ts` (append)

**Interfaces:**
- Consumes: `loadSlotmap`, `SLOTS` (Task 1); `recolorSpriteSlots`, `recolorSprite` (spritetint); `CLOTHING` (cosmetics).
- Behaviour: if a slot-map exists for the sprite, render the **body** slot via the class's op (`hue`/`colorize`) from the requested hue; otherwise fall back to the existing hex `recolorSprite` (unchanged — covers female sprites until 2C). URL, cache key, and view-model wiring are UNCHANGED.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/web-tint.test.ts
import { spriteFileIndex } from '../src/domain/cosmetics';
import { creatureSpriteFile } from '../src/domain/classes';
import { readFileSync } from 'node:fs';

// The wizard eyes (#ff3d3d in the central hood) must NOT change when the robe recolors.
it('renders via slot-map: wizard eyes stay while the robe recolors', async () => {
  const base = readFileSync(`assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'M', 'a'))}`);
  const basePng = PNG.sync.read(base);
  const green = PNG.sync.read((await request(app()).get('/sprite/tint/wizard_M/a/120.png')).body);
  // find an eye pixel (#ff3d3d inside x10-15,y8-12) in the base; it must be unchanged in the output
  let checkedEye = false;
  for (let y = 8; y <= 12; y++) for (let x = 10; x <= 15; x++) {
    const i = (y * 24 + x) * 4;
    if (basePng.data[i] === 0xff && basePng.data[i + 1] === 0x3d && basePng.data[i + 2] === 0x3d) {
      expect([green.data[i], green.data[i + 1], green.data[i + 2]]).toEqual([0xff, 0x3d, 0x3d]);
      checkedEye = true;
    }
  }
  expect(checkedEye).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- web-tint`
Expected: FAIL — the current hex render recolours every `#ff3d3d` including the eyes.

- [ ] **Step 3: Implement** — in `src/web/routes/shop.ts`, add imports:

```ts
import { loadSlotmap, SLOTS } from '../../domain/slots';
import { recolorSprite, recolorSpriteSlots } from '../../domain/spritetint';
```

and replace the body-recolor block (the `const c = CLOTHING[classKey]; … recolorSprite(…)` lines from Phase 1) with:

```ts
    const c = CLOTHING[classKey];
    const src = fs.readFileSync(srcFile);
    const slotIds = loadSlotmap(`${classKey}_${gender}`, frame);
    let out: Buffer;
    if (slotIds) {
      const bodyRule = c.op === 'colorize'
        ? { op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
        : { op: 'hue' as const, hue };
      out = recolorSpriteSlots(src, slotIds, new Map([[SLOTS.body, bodyRule]]));
    } else {
      // no slot-map (e.g. female) — fall back to the Phase-1 hex recolor
      const rule = c.op === 'colorize'
        ? { hexes: c.dominant, op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
        : { hexes: c.dominant, op: 'hue' as const, hue };
      out = recolorSprite(src, [rule]);
    }
```

(Leave the cache write + `res.send(out)` that follow unchanged.)

- [ ] **Step 4: Run tests + typecheck**

Run: `rm -rf data/tint-cache && npm test -- web-tint spritetint slots seed-slotmaps slotmap-collisions cosmetics-map && npm run typecheck`
Expected: PASS all; typecheck clean. (Clearing the cache avoids serving Phase-1 stale renders.)

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/shop.ts tests/web-tint.test.ts
git commit -m "feat(slots): tint route renders the body slot via slot-map (collisions fixed live)"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `rm -rf data/tint-cache && npm test && npm run typecheck` — all green.
- [ ] **Step 2:** Drive it live (fresh isolated DB/cache, as in Phase 1): start the server, and for `wizard_M`, `shaman_M`, `berserker_M`, `paladin_M` request `/sprite/tint/<sprite>/a/{0,120,240}.png`; save + eyeball that the **body** recolours while **eyes stay red, staff/axe stay, cape stays, shield-cross stays white**. Confirm a no-collision class (`knight_M`) is unchanged from Phase 1, and a female sprite still no-ops (hex fallback).
- [ ] **Step 3:** Commit any fixes. Female sprites remain no-ops (Phase 2C). The per-slot player controls, black/white finishes, character-page picker, and `player_slot_cosmetics` storage are Phase 2B.

---

## Self-Review (Phase 2A)
- **Spec coverage:** taxonomy+legend+reader (Task 1), slot render (Task 2), seeding (Task 3), authored maps + collision proof (Task 4), live wiring with hex fallback (Task 5), verification (Task 6). Per-slot storage/UI/finishes/female are explicitly deferred to 2B/2C. ✓
- **Placeholders:** the only non-code work is the manual pixel-correction in Task 4, gated by an automated collision test — not a leave-blank; every code step shows complete code + expected command output. The `SLOT_SEED` bboxes are best-effort by design (Task 4 corrects them; the test is the acceptance gate). ✓
- **Type consistency:** `SlotRule` defined in Task 2, consumed verbatim in Tasks 4–5; `SLOTS`/`LEGEND`/`readSlotmap`/`loadSlotmap` from Task 1 used in Tasks 3–5; `SeedRule`/`seedSlotmap`/`SLOT_SEED` from Task 3 used in Task 4; the route reuses `spriteFileIndex`/`creatureSpriteFile` and the `gender`/`frame` locals already in the handler. ✓
- **Backward compatibility:** URL, cache key, storage, and view-models unchanged; classes/genders without a slot-map fall back to the Phase-1 hex render, so nothing regresses. ✓

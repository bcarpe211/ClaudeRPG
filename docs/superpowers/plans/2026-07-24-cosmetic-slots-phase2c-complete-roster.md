# Cosmetic Slot System Phase 2C — Complete Roster Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before each completion claim.

**Goal:** Complete all 36 class/gender/frame slot maps, activate female dye support, add a permanent flag-gated animated cosmetics review page, and stop for user pixel approval before Phase 2C is considered complete.

**Architecture:** Corrected male slot-map PNGs remain the authored material-boundary source. A deterministic coordinate-transfer utility copies those labels to female sprites and requires explicit overrides for every female-only visible pixel. Production skin URLs gain a SHA-256 render hash covering the player rules and both slot-map frames. A read-only review domain and route read maps fresh from disk, render original/legend/focus/hue/finish modes through the real recolor engine, and animate every male/female pair for visual acceptance.

**Tech Stack:** TypeScript, Node/tsx ESM, Express, EJS, better-sqlite3, PNGJS, Vitest, Supertest, browser-native ES modules.

**Approved design:** `docs/superpowers/specs/2026-07-24-cosmetic-slots-phase2c-female-review-design.md`

**Inventory reference:** `docs/cosmetics-recolor-regions.md`

---

## Guardrails

- Work on `feat/player-shop-cosmetics`; do not merge, push, deploy, or reboot the Pi in this plan.
- Preserve the existing 12-slot taxonomy. Slot `0` is fixed/outline and is never recolored.
- Never infer female-only pixels from color or proximity. Every female-only visible pixel must have a committed explicit override.
- Never overwrite corrected male maps with the legacy palette seeder.
- Review routes are absent unless `ENABLE_COSMETICS_REVIEW=1`.
- Review routes are read-only and never inspect or mutate player records.
- Production skin routes retain immutable content-addressed caching; review renders use `no-store` and fresh map reads.
- Both frame URLs for one sprite/config use the same render hash so `/a/` → `/b/` animation substitution keeps working.
- Female availability remains data-driven through `presentSlots`; do not add a separate feature switch.
- Do not implement cosmetic tier ownership/pricing, reopen the shop, or begin timed consumables in this plan.
- Async Express handlers use `asyncHandler`.
- Relative TypeScript imports keep the repository's extensionless ESM style.
- Commit after every task using the commit message listed by that task.

## Final acceptance

Automated tests are necessary but not sufficient. After all automated checks pass, run the permanent review page with all 18 male/female variants animated through frames A and B. Stop and present it to the user. Correct every reported pixel issue, regenerate affected female maps, rerun verification, and repeat. Phase 2C is complete only after explicit user approval.

---

### Task 1: Add fresh slot-map I/O and deterministic female transfer

**Files:**

- Modify: `src/domain/slots.ts`
- Create: `tools/transfer-female-slotmaps.ts`
- Create: `tests/transfer-female-slotmaps.test.ts`
- Modify: `tests/slots.test.ts`

**Produces:**

```ts
export type SpriteFrame = 'a' | 'b';
export function slotmapFile(sprite: string, frame: SpriteFrame): string;
export function loadSlotmapFresh(sprite: string, frame: SpriteFrame): Uint8Array | null;

export interface PixelOverride {
  x: number;
  y: number;
  slot: number;
}

export interface TransferResult {
  png: Buffer;
  unresolved: Array<{ x: number; y: number }>;
}

export function transferFemaleSlotmap(
  maleMapPng: Buffer,
  maleSpritePng: Buffer,
  femaleSpritePng: Buffer,
  overrides: readonly PixelOverride[],
): TransferResult;
```

#### Step 1: Write failing fresh-load tests

Append to `tests/slots.test.ts`:

```ts
import fs from 'node:fs';
import { slotmapFile, loadSlotmapFresh } from '../src/domain/slots';

it('resolves a committed slot-map path and fresh-loads it', () => {
  expect(slotmapFile('wizard_M', 'a')).toBe(
    path.resolve('slotmaps/wizard_M_a.png'),
  );
  expect(loadSlotmapFresh('wizard_M', 'a')).toHaveLength(24 * 24);
  expect(loadSlotmapFresh('doesnotexist_M', 'a')).toBeNull();
});
```

Also add `import path from 'node:path';`. Remove the unused `fs` import if the final test does not use it.

Run:

```bash
npm test -- tests/slots.test.ts
```

Expected: FAIL because `slotmapFile` and `loadSlotmapFresh` do not exist.

#### Step 2: Implement fresh map I/O without changing cached runtime behavior

In `src/domain/slots.ts`:

```ts
export type SpriteFrame = 'a' | 'b';

const SLOTMAP_DIR = path.resolve('slotmaps');

export function slotmapFile(sprite: string, frame: SpriteFrame): string {
  return path.join(SLOTMAP_DIR, `${sprite}_${frame}.png`);
}

export function loadSlotmapFresh(
  sprite: string,
  frame: SpriteFrame,
): Uint8Array | null {
  const file = slotmapFile(sprite, frame);
  return fs.existsSync(file) ? readSlotmap(fs.readFileSync(file)) : null;
}
```

Change `loadSlotmap` to call `loadSlotmapFresh` on a cache miss. Keep the existing process-lifetime cache and `null` semantics:

```ts
export function loadSlotmap(
  sprite: string,
  frame: SpriteFrame,
): Uint8Array | null {
  const key = `${sprite}_${frame}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const result = loadSlotmapFresh(sprite, frame);
  cache.set(key, result);
  return result;
}
```

Run:

```bash
npm test -- tests/slots.test.ts
```

Expected: PASS.

#### Step 3: Write failing transfer tests

Create `tests/transfer-female-slotmaps.test.ts`. Use PNGJS helpers inside the test to construct 2×2 source/map PNGs. Cover these exact cases:

1. shared visible coordinate copies the male slot;
2. female transparent coordinate becomes slot `0`;
3. female-only visible coordinate is returned in `unresolved`;
4. a matching explicit override resolves it;
5. an override can assign slot `0`;
6. invalid dimensions, duplicate override coordinates, out-of-range coordinates, and slot ids outside `0..11` throw.

The central expectation must be:

```ts
const result = transferFemaleSlotmap(
  maleMap,
  maleSprite,
  femaleSprite,
  [{ x: 1, y: 1, slot: SLOTS.cape }],
);
expect(result.unresolved).toEqual([]);
expect(readSlotmap(result.png)).toEqual(
  Uint8Array.from([SLOTS.body, 0, 0, SLOTS.cape]),
);
```

Run:

```bash
npm test -- tests/transfer-female-slotmaps.test.ts
```

Expected: FAIL because the transfer module does not exist.

#### Step 4: Implement transfer and exact override data

Create `tools/transfer-female-slotmaps.ts`.

Implementation rules:

- Decode all three PNGs with `PNG.sync.read`.
- Require equal width and height.
- Require each override to have integer coordinates inside the image and an integer slot from `0` through `11`.
- Reject duplicate override coordinates.
- Iterate row-major.
- Female transparent: output transparent.
- Female and male visible: copy the male map id unless an override replaces it.
- Female visible and male transparent: require an override or append `{ x, y }` to `unresolved`.
- Encode slot ids using the exact RGB values in `LEGEND`; slot `0` is transparent.
- Return the generated PNG even when unresolved pixels exist so tests can inspect it, but the CLI must refuse to write any file when `unresolved.length > 0`.

Commit this exact data:

```ts
export const FEMALE_OVERRIDES: Record<string, readonly PixelOverride[]> = {
  wizard_F_b: [
    { x: 21, y: 6, slot: SLOTS.outline },
  ],
  berserker_F_a: [
    { x: 19, y: 12, slot: SLOTS.cape },
    { x: 20, y: 12, slot: SLOTS.outline },
    { x: 19, y: 13, slot: SLOTS.outline },
  ],
  paladin_F_a: [
    { x: 15, y: 8, slot: SLOTS.outline },
    { x: 23, y: 8, slot: SLOTS.outline },
    { x: 21, y: 9, slot: SLOTS.outline },
    { x: 22, y: 9, slot: SLOTS.outline },
    { x: 19, y: 10, slot: SLOTS.outline },
  ],
  paladin_F_b: [
    { x: 15, y: 9, slot: SLOTS.outline },
    { x: 23, y: 9, slot: SLOTS.outline },
    { x: 21, y: 10, slot: SLOTS.outline },
    { x: 22, y: 10, slot: SLOTS.outline },
    { x: 19, y: 11, slot: SLOTS.outline },
  ],
};
```

All other class/gender/frame combinations intentionally use an empty override
list.

The CLI loops through `CLASSES` and both frames, reads:

```text
slotmaps/{class}_M_{frame}.png
assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/{male source file}
assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/{female source file}
```

and writes:

```text
slotmaps/{class}_F_{frame}.png
```

Use `spriteFileIndex` and `creatureSpriteFile`; do not duplicate sheet index math. Print one line per generated map. If any unresolved coordinate remains, throw an error containing the class, frame, and every `(x,y)` and exit nonzero before writing that map.

Do **not** run the CLI yet. Female artifacts must be generated from the completed male maps in Task 6, not the current partial maps.

Run:

```bash
npm test -- tests/transfer-female-slotmaps.test.ts tests/slots.test.ts
npm run typecheck
```

Expected: PASS.

#### Step 5: Commit

```bash
git add src/domain/slots.ts tools/transfer-female-slotmaps.ts tests/transfer-female-slotmaps.test.ts tests/slots.test.ts
git commit -m "feat(slots): add deterministic female map transfer"
```

---

### Task 2: Make production skin hashes map-aware

**Files:**

- Modify: `src/domain/slots.ts`
- Modify: `src/domain/slotcosmetics.ts`
- Modify: `src/web/routes/shop.ts`
- Modify: `tests/slotcosmetics.test.ts`
- Modify: `tests/web-skin.test.ts`
- Modify: `tests/tvview-cosmetics.test.ts`

**Produces:**

```ts
export function slotmapFingerprintFromBuffers(
  frameA: Buffer | null,
  frameB: Buffer | null,
): string;
export function slotmapFingerprint(sprite: string): string;
export function skinRenderHash(
  sprite: string,
  config: Map<number, SlotRule>,
): string;
```

#### Step 1: Replace config-only hash tests with failing render-hash tests

In `tests/slotcosmetics.test.ts`, remove `slotConfigHash` expectations and test:

```ts
const a = new Map([[SLOTS.body, { op: 'hue' as const, hue: 120 }]]);
const b = new Map([[SLOTS.body, { op: 'hue' as const, hue: 120 }]]);
const c = new Map([[SLOTS.body, { op: 'hue' as const, hue: 220 }]]);

expect(skinRenderHash('wizard_M', a)).toBe(skinRenderHash('wizard_M', b));
expect(skinRenderHash('wizard_M', a)).not.toBe(skinRenderHash('wizard_M', c));
expect(skinRenderHash('wizard_M', a)).not.toBe(skinRenderHash('priest_M', a));
expect(skinRenderHash('wizard_M', a)).toMatch(/^[0-9a-f]{16}$/);
```

In `tests/slots.test.ts`, test the pure helper:

```ts
expect(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b')))
  .toMatch(/^[0-9a-f]{16}$/);
expect(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b')))
  .not.toBe(slotmapFingerprintFromBuffers(Buffer.from('a2'), Buffer.from('b')));
expect(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b')))
  .not.toBe(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b2')));
expect(slotmapFingerprintFromBuffers(null, Buffer.from('b')))
  .not.toBe(slotmapFingerprintFromBuffers(Buffer.alloc(0), Buffer.from('b')));
```

Update URL expectations in `tests/slotcosmetics.test.ts`,
`tests/web-skin.test.ts`, and `tests/tvview-cosmetics.test.ts` to call:

```ts
skinRenderHash(spriteId(classKey, gender), getSlotConfig(db, playerId))
```

Run:

```bash
npm test -- tests/slots.test.ts tests/slotcosmetics.test.ts tests/web-skin.test.ts tests/tvview-cosmetics.test.ts
```

Expected: FAIL because the new hash functions do not exist.

#### Step 2: Implement a stable SHA-256 map fingerprint

In `src/domain/slots.ts`, import `createHash` from `node:crypto` and add:

```ts
const MISSING_MAP = Buffer.from('clauderpg:missing-slotmap:v1');

export function slotmapFingerprintFromBuffers(
  frameA: Buffer | null,
  frameB: Buffer | null,
): string {
  const hash = createHash('sha256');
  for (const [frame, bytes] of [['a', frameA], ['b', frameB]] as const) {
    hash.update(`frame:${frame}:`);
    hash.update(bytes ?? MISSING_MAP);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function slotmapFingerprint(sprite: string): string {
  const read = (frame: SpriteFrame): Buffer | null => {
    const file = slotmapFile(sprite, frame);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  };
  return slotmapFingerprintFromBuffers(read('a'), read('b'));
}
```

The missing sentinel must be distinct from an existing empty file.

#### Step 3: Replace `slotConfigHash` with `skinRenderHash`

In `src/domain/slotcosmetics.ts`, import `createHash`, `spriteId`, and
`slotmapFingerprint`.

Keep canonical config serialization sorted by numeric slot:

```ts
function canonicalSlotConfig(config: Map<number, SlotRule>): string {
  return [...config.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, r]) =>
      `${slot}:${r.op}:${r.hue ?? ''}:${r.sat ?? ''}:${r.lo ?? ''}:${r.hi ?? ''}`)
    .join('|');
}

export function skinRenderHash(
  sprite: string,
  config: Map<number, SlotRule>,
): string {
  return createHash('sha256')
    .update('clauderpg:skin:v2\0')
    .update(sprite)
    .update('\0')
    .update(slotmapFingerprint(sprite))
    .update('\0')
    .update(canonicalSlotConfig(config))
    .digest('hex')
    .slice(0, 16);
}
```

Update `cosmeticSkinUrl`:

```ts
const sprite = spriteId(classKey, gender);
return `/sprite/skin/${playerId}/${frame}/${skinRenderHash(sprite, config)}.png`;
```

Remove the exported `slotConfigHash`; update all imports.

#### Step 4: Recompute the canonical hash in the skin route

In `src/web/routes/shop.ts`:

```ts
const sprite = spriteId(player.class_key, player.gender as Gender);
const hash = skinRenderHash(sprite, slotConfig);
```

Use `sprite` for `loadSlotmap`. Preserve route behavior:

- unknown player: `404`;
- stale hash: `302` to current URL and no immutable header;
- current hash: PNG with `public, max-age=31536000, immutable`;
- disk-cache filename includes the new 16-character hash.

Add a stale-map-hash unit test around `slotmapFingerprintFromBuffers`; the
Supertest route test only needs to prove that a stale URL redirects and lacks
`Cache-Control`.

Run:

```bash
npm test -- tests/slots.test.ts tests/slotcosmetics.test.ts tests/web-skin.test.ts tests/tvview-cosmetics.test.ts
npm run typecheck
```

Expected: PASS.

#### Step 5: Commit

```bash
git add src/domain/slots.ts src/domain/slotcosmetics.ts src/web/routes/shop.ts tests/slots.test.ts tests/slotcosmetics.test.ts tests/web-skin.test.ts tests/tvview-cosmetics.test.ts
git commit -m "fix(cosmetics): include slot maps in skin cache hashes"
```

---

### Task 3: Build the read-only review domain

**Files:**

- Create: `src/domain/cosmeticsreview.ts`
- Create: `tests/cosmeticsreview.test.ts`

**Produces:**

```ts
export type ReviewMode =
  | 'original' | 'slots' | 'focus' | 'hue'
  | 'black' | 'white' | 'steel';

export interface ReviewVariant {
  sprite: string;
  classKey: string;
  className: string;
  gender: Gender;
  channels: Array<{ slot: number; label: string }>;
  warnings: string[];
}

export const EXPECTED_CHANNELS: Record<
  string,
  { M: readonly number[]; F: readonly number[] }
>;

export function buildCosmeticsReviewRoster(): ReviewVariant[];
export function renderCosmeticsReviewSprite(input: {
  source: Buffer;
  slotIds: Uint8Array;
  mode: ReviewMode;
  slot?: number;
  hue?: number;
}): Buffer;
```

#### Step 1: Write failing target-inventory tests

Create `tests/cosmeticsreview.test.ts`.

Assert the exact target inventory:

```ts
expect(EXPECTED_CHANNELS).toEqual({
  knight: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
      SLOTS.weapon, SLOTS.shield, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
      SLOTS.boots, SLOTS.weapon, SLOTS.shield, SLOTS.skin],
  },
  thief: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.headgear, SLOTS.hair, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.headgear, SLOTS.hair, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
  },
  ranger: {
    M: [SLOTS.body, SLOTS.headgear, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.headgear, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.flair, SLOTS.skin],
  },
  wizard: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.weapon, SLOTS.flair, SLOTS.skin],
  },
  priest: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.hair, SLOTS.weapon, SLOTS.flair,
      SLOTS.skin],
  },
  shaman: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon,
      SLOTS.facePaint, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon,
      SLOTS.facePaint, SLOTS.skin],
  },
  berserker: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
  },
  swordsman: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.flair, SLOTS.skin],
  },
  paladin: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon, SLOTS.shield,
      SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon, SLOTS.shield,
      SLOTS.flair, SLOTS.skin],
  },
});
```

The array order is `PICKER_ORDER`, filtered to the expected channels. Paladin
does not expose `headgear`: its helmet belongs to `body`, and its white
feather/wings belong to `flair`.

Run:

```bash
npm test -- tests/cosmeticsreview.test.ts
```

Expected: FAIL because the domain module does not exist.

#### Step 2: Write failing renderer tests

Use a synthetic 2×2 PNG and slot ids:

```ts
const ids = Uint8Array.from([
  SLOTS.outline, SLOTS.body,
  SLOTS.weapon, SLOTS.flair,
]);
```

Cover:

- `original` returns identical decoded RGBA bytes;
- `slots` replaces every nonzero slot with its exact `LEGEND` RGB;
- `focus` changes only the selected slot to its legend color;
- `hue` changes only the selected slot using `wheelRule`;
- `black`, `white`, and `steel` use the exact shared `FINISHES` rules;
- source and map pixel-count mismatch throws;
- focus/hue/finish without a selected slot throws.

Run:

```bash
npm test -- tests/cosmeticsreview.test.ts
```

Expected: FAIL.

#### Step 3: Implement the review domain

Create `src/domain/cosmeticsreview.ts`.

Implementation requirements:

- Export the exact `EXPECTED_CHANNELS` constant above.
- Build 18 variants in `CLASSES` order, male then female.
- Read frame A and B through `loadSlotmapFresh`, never `loadSlotmap`.
- Derive actual channels from each map in `PICKER_ORDER`.
- Add warnings for:
  - missing frame A;
  - missing frame B;
  - frame A/B channel mismatch;
  - missing expected channel;
  - unexpected channel.
- Friendly labels use `SLOT_LABELS`, with the existing class-specific flair names:
  thief Feather, ranger Fletching, wizard Eyes, priest Holy symbol,
  berserker Horns, swordsman Details, paladin Wings.
- Roster construction is pure with respect to the database and performs no writes.

For rendering:

- Decode `source` with PNGJS.
- `original`: return `source`.
- `slots`: clone source, then replace RGB for each nonzero map id with `LEGEND`.
- `focus`: clone source, replacing only the selected slot with its legend RGB.
- `hue`: call `recolorSpriteSlots(source, ids, new Map([[slot, wheelRule(hue)]]))`.
- finish modes: call `recolorSpriteSlots` with the selected rule from `FINISHES`.
- Keep original alpha.

Run:

```bash
npm test -- tests/cosmeticsreview.test.ts
npm run typecheck
```

Expected: PASS.

#### Step 4: Commit

```bash
git add src/domain/cosmeticsreview.ts tests/cosmeticsreview.test.ts
git commit -m "feat(cosmetics): add slot-map review domain"
```

---

### Task 4: Add the flag-gated review page and render endpoint

**Files:**

- Modify: `src/config.ts`
- Modify: `src/web/app.ts`
- Create: `src/web/routes/cosmetics-review.ts`
- Modify: `tests/config.test.ts`
- Create: `tests/web-cosmetics-review.test.ts`

#### Step 1: Write failing config tests

Append to `tests/config.test.ts`:

```ts
describe('loadConfig enableCosmeticsReview', () => {
  it('defaults to false', () => {
    expect(loadConfig({}).enableCosmeticsReview).toBe(false);
  });
  it.each(['1', 'true'])('is true for %s', (value) => {
    expect(loadConfig({ ENABLE_COSMETICS_REVIEW: value }).enableCosmeticsReview)
      .toBe(true);
  });
});
```

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL.

#### Step 2: Add the config flag

In `Config`:

```ts
enableCosmeticsReview: boolean;
```

In `loadConfig`:

```ts
enableCosmeticsReview:
  env.ENABLE_COSMETICS_REVIEW === '1'
  || env.ENABLE_COSMETICS_REVIEW === 'true',
```

Run the config tests. Expected: PASS.

#### Step 3: Write failing route tests

Create `tests/web-cosmetics-review.test.ts`. Build apps with:

```ts
loadConfig({
  ENABLE_COSMETICS_REVIEW: enabled ? '1' : '0',
})
```

Cover:

1. `GET /cosmetics-review` is `404` when disabled.
2. Both page and render endpoint are `404` when disabled.
3. Enabled page is `200`, contains all 18 sprite ids, and includes two image
   URLs per variant for 36 rendered frames.
4. `GET /cosmetics-review/render/wizard_M/a.png?mode=original` is PNG,
   `200`, and `Cache-Control: no-store`.
5. `slots`, `focus`, `hue`, `black`, `white`, and `steel` return PNG.
6. Unknown class/gender, invalid frame, invalid mode, slot outside `0..11`,
   hue outside `0..359`, missing required slot, and missing required hue return
   `400` or `404` exactly as specified:
   - malformed/unknown sprite: `404`;
   - malformed frame path: `404`;
   - absent source/map: `404`;
   - invalid query values or required query omissions: `400`.
7. A render request after an on-disk map change observes fresh bytes. Implement
   this with a temporary test sprite/map path only if the route accepts injected
   readers; otherwise cover fresh-read behavior in the review-domain test and
   assert the route imports `loadSlotmapFresh` through behavior.

Run:

```bash
npm test -- tests/web-cosmetics-review.test.ts
```

Expected: FAIL because the route is absent.

#### Step 4: Implement and register routes

Create `src/web/routes/cosmetics-review.ts`:

```ts
export function registerCosmeticsReviewRoutes(
  app: Express,
  { config }: AppDeps,
): void {
  if (!config.enableCosmeticsReview) return;
  // GET /cosmetics-review
  // GET /cosmetics-review/render/:sprite/:frame.png
}
```

Use a Zod query schema with:

```ts
mode: z.enum(['original', 'slots', 'focus', 'hue', 'black', 'white', 'steel'])
  .default('original'),
slot: z.coerce.number().int().min(0).max(11).optional(),
hue: z.coerce.number().int().min(0).max(359).optional(),
```

After parsing:

- `focus`, `hue`, `black`, `white`, and `steel` require `slot`;
- `hue` requires `hue`;
- reject `slot === SLOTS.outline` for every mode that requires a slot because
  outline/fixed art is intentionally not a recolorable material;
- validate `:sprite` by splitting only a trailing `_M` or `_F`, then checking
  `getClass(classKey)`;
- accept only `a` or `b`;
- source path uses `config.spritesDir`, `spriteFileIndex`, and
  `creatureSpriteFile`;
- map bytes are read with `fs.readFileSync(slotmapFile(...))`, then
  `readSlotmap`; do not call cached `loadSlotmap`;
- missing source or map is `404`;
- successful render sets `Content-Type: image/png` and
  `Cache-Control: no-store`.

The page handler sends:

```ts
await renderPage('cosmetics-review', {
  title: 'Cosmetics Review',
  frame: 'lite',
  styles: ['cosmetics-review.css'],
  roster: buildCosmeticsReviewRoster(),
  slots: PICKER_ORDER.map((slot) => ({
    slot,
    label: SLOT_LABELS[slot],
  })),
});
```

Wrap both async handlers with `asyncHandler`.

Register in `src/web/app.ts` after the existing dev routes:

```ts
registerCosmeticsReviewRoutes(app, { db, config });
```

Run:

```bash
npm test -- tests/config.test.ts tests/web-cosmetics-review.test.ts
npm run typecheck
```

Expected: PASS.

#### Step 5: Commit

```bash
git add src/config.ts src/web/app.ts src/web/routes/cosmetics-review.ts tests/config.test.ts tests/web-cosmetics-review.test.ts
git commit -m "feat(cosmetics): add flag-gated review routes"
```

---

### Task 5: Build the animated male/female review interface

**Files:**

- Create: `src/web/views/cosmetics-review.ejs`
- Create: `src/web/public/cosmetics-review.css`
- Create: `src/web/public/cosmetics-review.js`
- Modify: `src/web/public/anim.js`
- Modify: `tests/anim.test.ts`
- Modify: `tests/web-cosmetics-review.test.ts`

#### Step 1: Write failing animation-controller tests

Extend `tests/anim.test.ts` with a minimal fake `document.querySelectorAll`
fixture and fake timers. `start()` must remain backward compatible and return:

```ts
{
  pause(): void;
  resume(): void;
  stop(): void;
  isPaused(): boolean;
}
```

Test:

- normal start toggles every `.sprite-anim` together;
- `pause()` freezes the current frame;
- `resume()` resumes the shared clock;
- `stop()` clears the timer and prevents further toggles;
- repeated pause/resume calls are idempotent;
- existing catalog call `start({ periodMs: 1000 })` still works.

Run:

```bash
npm test -- tests/anim.test.ts
```

Expected: FAIL because `start` does not return a controller.

#### Step 2: Implement the controller

Refactor only `start` in `src/web/public/anim.js`. Preserve `isFrameA`,
`framePartner`, and `frameAt`. Use one interval for all sprites.

The returned object owns `paused` and `timer`; `pause` clears the timer without
changing the visible frame, `resume` creates one interval only, and `stop`
permanently clears it. Do not add DOM access at module scope.

Run:

```bash
npm test -- tests/anim.test.ts
node --check src/web/public/anim.js
```

Expected: PASS.

#### Step 3: Write failing page-structure tests

Extend `tests/web-cosmetics-review.test.ts`. Assert the enabled page contains:

- exactly 18 `.review-variant` cards;
- one `.sprite-anim` with frame A and B images per card;
- nine class rows with adjacent male/female cards;
- global mode controls for original, slots, focus, hue, black, white, steel;
- one material select containing all 11 recolorable slot options;
- hue input `min="0"` and `max="359"`;
- pause/resume button;
- warning region per card;
- `/static/anim.js`;
- `/static/cosmetics-review.js`;
- `window.__COSMETICS_REVIEW__` JSON with the roster and initial state.

Run:

```bash
npm test -- tests/web-cosmetics-review.test.ts
```

Expected: FAIL because the assets/view do not exist.

#### Step 4: Implement the EJS view

Create `src/web/views/cosmetics-review.ejs`.

Required layout:

- Header: “Cosmetics Roster Review” plus a short read-only explanation.
- Sticky global toolbar:
  - mode buttons with `data-review-mode`;
  - slot `<select id="review-slot">`;
  - hue range and numeric output;
  - pause/resume button.
- One `.review-class-row` per class.
- Male and female `.review-variant` cards side by side.
- Each card includes:
  - class and gender label;
  - `.sprite-anim` containing `.frame-a` and `.frame-b`;
  - current channel chips;
  - warning list, or a “Map inventory matches” success line.

Initial images use:

```text
/cosmetics-review/render/<sprite>/a.png?mode=original
/cosmetics-review/render/<sprite>/b.png?mode=original
```

Embed only JSON-serialized server data:

```html
<script>
  window.__COSMETICS_REVIEW__ = <%- JSON.stringify({ roster, initialMode: 'original', initialSlot: 1, initialHue: 210 }).replace(/</g, '\\u003c') %>;
</script>
<script type="module" src="/static/cosmetics-review.js"></script>
```

#### Step 5: Implement pixel-art styling

Create `src/web/public/cosmetics-review.css`.

Required behavior:

- two cards per class row on desktop;
- one card per row below 760px;
- at least 144×144 sprite stage;
- `image-rendering: pixelated`;
- both frames absolutely overlap;
- `.frame-b` hidden until `.show-b`;
- controls and cards use the app's dark dungeon palette, chunky borders,
  inset highlights, compact monospace labels, and material-colored chips;
- warnings are visually distinct from success;
- sticky toolbar remains usable without obscuring the class heading;
- no smooth image scaling or CSS filters that blur pixels.

#### Step 6: Implement review controls

Create `src/web/public/cosmetics-review.js`.

Import:

```js
import { start } from '/static/anim.js';
```

Start one controller. On any mode/slot/hue change, update both image URLs on
all 18 cards:

```js
function renderUrl(sprite, frame, mode, slot, hue) {
  const params = new URLSearchParams({ mode });
  if (['focus', 'hue', 'black', 'white', 'steel'].includes(mode)) {
    params.set('slot', String(slot));
  }
  if (mode === 'hue') params.set('hue', String(hue));
  return `/cosmetics-review/render/${sprite}/${frame}.png?${params}`;
}
```

Behavior:

- selecting a mode marks exactly one active button;
- focus/hue/finish modes show the slot control;
- only hue mode shows the hue control;
- pause button calls `controller.pause()`/`resume()`, updates text, and preserves
  the current frame;
- never submit a form or navigate;
- render failures leave the card warning visible through the browser's broken
  image state; do not silently fall back to original.

Run:

```bash
npm test -- tests/anim.test.ts tests/web-cosmetics-review.test.ts
node --check src/web/public/anim.js
node --check src/web/public/cosmetics-review.js
npm run typecheck
```

Expected: PASS.

#### Step 7: Commit

```bash
git add src/web/views/cosmetics-review.ejs src/web/public/cosmetics-review.css src/web/public/cosmetics-review.js src/web/public/anim.js tests/anim.test.ts tests/web-cosmetics-review.test.ts
git commit -m "feat(cosmetics): add animated roster review interface"
```

---

### Task 6: Complete and verify all 36 authored slot maps

**Files:**

- Modify: `slotmaps/*_M_a.png`
- Modify: `slotmaps/*_M_b.png`
- Create: `slotmaps/*_F_a.png`
- Create: `slotmaps/*_F_b.png`
- Create: `tests/slotmap-coverage.test.ts`
- Create: `tests/slotmap-integrity.test.ts`
- Modify: `tests/slotmap-collisions.test.ts`
- Modify: `tests/slots-present.test.ts`
- Modify: `tools/seed-slotmaps.ts`
- Modify if corrections require it: `tools/transfer-female-slotmaps.ts`

This is an authored binary-data task. The exact expected semantic inventory is
the `EXPECTED_CHANNELS` constant from Task 3; the exact pixel boundaries are
the source sprites plus the approved visual correction loop. Do not replace
that judgment with broad color matching.

#### Step 1: Write failing exact-coverage tests

Create `tests/slotmap-coverage.test.ts`.

For every class, gender, and frame:

```ts
const actual = uniqueSlots(loadSlotmapFresh(`${classKey}_${gender}`, frame));
expect(actual).toEqual(EXPECTED_CHANNELS[classKey][gender]);
```

`uniqueSlots` must filter slot `0` and return `PICKER_ORDER` order.

Also assert frame A and B have identical channel arrays for each
class/gender.

Run:

```bash
npm test -- tests/slotmap-coverage.test.ts
```

Expected: FAIL because male maps are incomplete and female maps do not exist.

#### Step 2: Write failing integrity tests

Create `tests/slotmap-integrity.test.ts`. For all 36 expected files:

- file exists;
- decodes to 24×24;
- every opaque slot-map RGB is an exact `LEGEND` value;
- no slot id outside `0..11`;
- every nonzero map coordinate is opaque in its matching source sprite;
- map A/B channel sets match;
- every female-only visible source coordinate has a corresponding explicit
  `FEMALE_OVERRIDES` entry;
- no override targets a coordinate where the female sprite is transparent;
- no override key references an unknown class/gender/frame.

Add a second test proving male/female channel equality except:

```ts
knight_F: +SLOTS.hair
priest_F: +SLOTS.hair
swordsman_F: +SLOTS.flair
```

All other class variants must expose the same channel set.

Run:

```bash
npm test -- tests/slotmap-integrity.test.ts
```

Expected: FAIL.

#### Step 3: Expand collision regression tests to both genders and frames

Refactor `tests/slotmap-collisions.test.ts` to loop:

```ts
for (const gender of ['M', 'F'] as const) {
  for (const frame of ['a', 'b'] as const) {
    // semantic samples for that rendered frame
  }
}
```

Retain and expand these invariants:

- wizard eyes are `SLOTS.flair`, never `SLOTS.body`;
- wizard staff is `SLOTS.weapon`;
- shaman staff is `SLOTS.weapon`, never `SLOTS.body`;
- berserker tunic, helmet, cape, axe, and horns are respectively
  `body`, `headgear`, `cape`, `weapon`, and `flair`;
- paladin `#b4c21d` helmet/shirt pixels are `body`;
- paladin front panel is `trim`;
- paladin weapon is `weapon`;
- paladin shield is `shield`;
- paladin olive boots are `boots`;
- paladin white feather/wings are `flair`;
- outline/fixed pixels sampled beside each collision remain slot `0`.

Choose sample coordinates by inspecting the final maps and matching source
sprite for each frame. Encode those coordinates as committed fixtures in the
test; do not search by source color at runtime because the collision regression
must prove position-specific labels.

Run:

```bash
npm test -- tests/slotmap-collisions.test.ts
```

Expected: FAIL until the maps are complete.

#### Step 4: Complete the 18 male map artifacts

Work class by class in this order:

```text
knight, thief, ranger, wizard, priest, shaman, berserker, swordsman, paladin
```

For each class:

1. Open source frame A, source frame B, current map A, and current map B.
2. Preserve every already-approved collision boundary.
3. Assign every material listed in `EXPECTED_CHANNELS[class].M`.
4. Keep outline and intentionally fixed art transparent/slot `0`.
5. Verify frame A/B expose the same channels.
6. Run the class-filtered coverage, integrity, and collision tests.
7. Inspect the class in `/cosmetics-review` using slots, focus, hue, black,
   white, and steel before moving to the next class.

Use the established legend exactly:

```text
body       #ff0000
headgear   #ff7f00
hair       #ffff00
facePaint  #7fff00
cape       #00ff00
trim       #00ff7f
weapon     #00ffff
shield     #007fff
boots      #0000ff
skin       #7f00ff
flair      #ff00ff
slot 0     transparent
```

The source sprite, not a rendered antialias color, is authoritative. In
particular, paladin body is the source region `#b4c21d`.

#### Step 5: Prevent the bootstrap seeder from overwriting authored maps

Keep `seedSlotmap` and `SLOT_SEED` available for their unit tests, but change
`tools/seed-slotmaps.ts` CLI behavior:

- default run refuses to overwrite an existing map and reports every skipped
  file;
- an explicit `--force-bootstrap` flag is required to overwrite;
- CLI output warns that bootstrap output is incomplete and must not replace
  reviewed artifacts.

Add a unit-testable helper:

```ts
export function shouldWriteSeed(
  exists: boolean,
  argv: readonly string[],
): boolean {
  return !exists || argv.includes('--force-bootstrap');
}
```

Test both branches in `tests/seed-slotmaps.test.ts`.

#### Step 6: Generate the 18 female maps from corrected males

Run:

```bash
npx tsx tools/transfer-female-slotmaps.ts
```

Expected:

- exactly 18 female map files written;
- zero unresolved female-only visible coordinates;
- no male files modified.

Then run:

```bash
npm test -- tests/transfer-female-slotmaps.test.ts tests/slotmap-coverage.test.ts tests/slotmap-integrity.test.ts tests/slotmap-collisions.test.ts tests/slots-present.test.ts tests/seed-slotmaps.test.ts
```

Expected: PASS.

If a female material boundary differs from the transferred male label, add a
coordinate to `FEMALE_OVERRIDES`, regenerate all female maps, and rerun the
suite. Never patch only the generated female PNG without recording the
override.

#### Step 7: Verify the complete roster through the review page

Run an isolated server:

```bash
DB_PATH=/private/tmp/clauderpg-phase2c.db \
PORT=8099 \
ENABLE_COSMETICS_REVIEW=1 \
npm run dev
```

Inspect `/cosmetics-review`. This is an internal authoring pass, not the final
user stop gate. Confirm:

- 18 cards and 36 rendered frames;
- no inventory warnings;
- every target channel can be focused independently;
- known collisions remain isolated;
- neutral finishes preserve sprite shading;
- animation frame changes do not make a channel disappear.

Correct artifacts/overrides and regenerate until clean.

#### Step 8: Commit

```bash
git add slotmaps tools/seed-slotmaps.ts tools/transfer-female-slotmaps.ts tests/seed-slotmaps.test.ts tests/slotmap-coverage.test.ts tests/slotmap-integrity.test.ts tests/slotmap-collisions.test.ts tests/slots-present.test.ts
git commit -m "feat(cosmetics): complete male and female slot maps"
```

---

### Task 7: Activate and verify female runtime dye behavior

**Files:**

- Modify: `tests/dye.test.ts`
- Modify: `tests/web-dye.test.ts`
- Modify: `tests/web-skin.test.ts`

No production purchase logic should change. Female activation must occur only
because the maps now exist.

#### Step 1: Replace unavailable-female tests

In `tests/dye.test.ts`, replace the old no-map test with:

```ts
it('offers the authored channels and slotmap for a female wizard', () => {
  const player = wizard('F');
  const vm = dyeViewModel(db, player);

  expect(vm.available).toBe(true);
  expect(vm.unlocked).toBe(false);
  expect(vm.channels.map((c) => c.slot))
    .toEqual(EXPECTED_CHANNELS.wizard.F);
  expect(vm.slotmap).toHaveLength(24 * 24);
});
```

#### Step 2: Replace guarded-purchase tests

In `tests/web-dye.test.ts`, replace “does not charge a sprite whose slot-map has
not been authored” with:

```ts
it('unlocks female dyes and deducts exactly the configured price', async () => {
  const { db, app, player } = ctx('F');

  const res = await unlock(app, player.auth_token);

  expect(res.status).toBe(302);
  expect(getPlayerById(db, player.id)?.gold).toBe(500_000);
  expect(getCosmetics(db, player.id)?.wheel_tier).toBe(1);
});
```

Replace the female “Tailoring in progress” page test with an unlock-offer test.
After unlocking, post a female-present slot rule and assert it is persisted.

Keep the route's existing no-map guard by adding a test player whose class is
valid but whose map lookup is mocked/missing only if the test architecture
supports dependency injection. Do not create an invalid production player row
just to reach the guard.

#### Step 3: Prove female production skin rendering

Add to `tests/web-skin.test.ts`:

- create female wizard;
- save a body rule;
- compute `skinRenderHash('wizard_F', config)`;
- request frame A;
- assert `200`, PNG, immutable cache header;
- compare at least one `SLOTS.body` coordinate against the source and prove it
  changed;
- compare at least one `SLOTS.flair` eye coordinate and prove it did not
  change.

Run:

```bash
npm test -- tests/dye.test.ts tests/web-dye.test.ts tests/web-skin.test.ts
npm run typecheck
```

Expected: PASS without a production-code change.

#### Step 4: Commit

```bash
git add tests/dye.test.ts tests/web-dye.test.ts tests/web-skin.test.ts
git commit -m "test(cosmetics): activate female dye runtime coverage"
```

---

### Task 8: Full verification and mandatory user visual-approval gate

**Files:**

- Modify as feedback requires: `slotmaps/*.png`
- Modify as feedback requires: `tools/transfer-female-slotmaps.ts`
- Modify as feedback requires: collision/integrity tests

#### Step 1: Run the complete automated suite

Clear only the project-local generated tint cache if present; do not remove the
database:

```bash
rm -rf data/tint-cache
npm test
npm run typecheck
node --check src/web/public/anim.js
node --check src/web/public/cosmetics-review.js
```

Expected: all tests pass, typecheck exits `0`, both syntax checks exit `0`.

#### Step 2: Start an isolated review server

Use a fresh isolated DB and cache path:

```bash
DB_PATH=/private/tmp/clauderpg-phase2c-review.db \
PORT=8099 \
ENABLE_COSMETICS_REVIEW=1 \
npm run dev
```

Open:

```text
http://localhost:8099/cosmetics-review
```

Verify in the browser:

1. All nine class rows show male and female side by side.
2. All 18 variants animate in lockstep through A/B.
3. Pause freezes the current shared frame; resume restarts it.
4. Original mode matches source art.
5. Slots mode shows every expected channel and no warning.
6. Focus isolates each material.
7. Hue, black, white, and steel change only the selected material.
8. Wizard eyes, shaman staff, berserker axe/cape/helmet/tunic, and paladin
   shield/feather/front-panel/boots/helmet-shirt boundaries are correct in both
   genders and both frames.

#### Step 3: Stop for user review

Report:

- automated verification results;
- the local review URL;
- any remaining warnings (expected: none);
- that the roster is ready for pixel inspection.

Do **not** mark Phase 2C complete and do not begin tiered cosmetic products.
Wait for the user's visual verdict.

#### Step 4: Apply the pixel-correction loop

For every user correction:

1. Identify whether it is shared or female-specific.
2. Shared correction: update both male frame maps, regenerate female maps.
3. Female-specific correction: update `FEMALE_OVERRIDES`, regenerate female
   maps.
4. Add or tighten a positional collision regression test.
5. Rerun coverage, integrity, collision, full tests, typecheck, and JS checks.
6. Refresh the no-store review page and present it again.
7. Commit each coherent correction:

```bash
git add slotmaps tools/transfer-female-slotmaps.ts tests
git commit -m "fix(cosmetics): correct wizard slot boundaries"
```

Use the affected class name in place of `wizard` for each later correction.

#### Step 5: Close Phase 2C only after approval

After the user explicitly approves the animated male/female roster, rerun:

```bash
npm test
npm run typecheck
node --check src/web/public/anim.js
node --check src/web/public/cosmetics-review.js
git status --short
```

Expected:

- tests green;
- typecheck green;
- scripts valid;
- clean worktree.

Then report Phase 2C complete. The next planning target is the approved
three-tier cosmetic ownership system, not timed consumables.

---

## Plan self-check

- **Approved scope:** female transfer, complete 36-map inventory, permanent
  flag-gated review page, animated M/F variants, and user correction loop are
  all included.
- **Known collision corrections:** wizard, shaman, berserker, and paladin
  boundaries are explicit in both map authoring and positional regression
  tests.
- **Female reproducibility:** generated female maps derive from corrected male
  maps plus committed explicit overrides; no color guessing is permitted.
- **Cache correctness:** source map A and B bytes, sprite id, and canonical
  config all contribute to one shared 16-hex render hash.
- **Runtime activation:** female purchase/use changes through authored data,
  with no extra product or availability switch.
- **Review correctness:** production uses cached maps and immutable hashes;
  review uses fresh reads and `no-store`.
- **Roadmap boundary:** tier entitlements, shop reopening, deployment, and
  timed consumables remain out of scope.
- **Completion gate:** automated green is not completion; explicit user pixel
  approval is mandatory.

---

## Review-loop amendment — 2026-07-25

The Task 3 inventory and collision examples above record the pre-review
implementation target. Pixel-by-pixel review expanded and corrected that target.
The authoritative final-review inventory is now §5.2 of
`docs/superpowers/specs/2026-07-24-cosmetic-slots-phase2c-female-review-design.md`
and the executable `EXPECTED_CHANNELS` table in
`src/domain/cosmeticsreview.ts`.

The review-loop decisions that supersede the earlier examples are:

- Wizard belt and gold robe edging are independent; the latter is presented as
  **Gold trim**.
- Female visible mouth pixels are presented as **Lips**. Wizard has no visible
  mouth pixels. Shaman uses the otherwise-free flair slot for Lips because face
  paint is already independent.
- Swordsman separates Shirt, brown Clothing, silver Trim, grey Cape, Weapon,
  Boots, Hair, and Skin. Female Lips and earring Details remain independent.
- Paladin separates Clothing/front panel, Cape, Headgear, Shield, Weapon,
  Boots, Plume, and Skin. The white plume is not a wing, integrated helmet
  edging remains Headgear, and the front panel remains Clothing.
- Knight and Paladin shoulder pixels that visibly continue their rear cloth are
  Cape. Berserker’s female moving gold strand is Hair.

The correction-loop tests in `tests/slotmap-collisions.test.ts` are the
position-specific source of truth for these accepted boundaries in both
animation frames.

# Cosmetic Tier Entitlements, Tone, and Bazaar Reopening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved three-tier cosmetic product: sequential Bazaar purchases, class/gender-specific Wardrobe entitlements, a shading-preserving black/white Tone slider, and Steel/Bronze/Gold material presets.

**Architecture:** A new code-owned entitlement registry is the sole source of channel labels, gender availability, and required tiers. Raw per-slot rules remain lossless in SQLite, while one filtered render configuration enforces current class, gender, and ownership for the Wardrobe, TV, leaderboards, and immutable skin route. The Bazaar owns purchases; the character-page Wardrobe owns editing and mirrors the server's Tone math for immediate preview.

**Tech Stack:** TypeScript, Node/tsx ESM, Express, EJS, better-sqlite3, Zod, PNGJS, browser Canvas 2D, Vitest, Supertest.

**Approved design:** `docs/superpowers/specs/2026-07-25-cosmetic-tier-entitlements-design.md`

## Global Constraints

- Work on `feat/player-shop-cosmetics`; do not merge, push, deploy, or reboot the Pi in this plan.
- Node/tsx ESM has no build step; relative TypeScript imports stay extensionless.
- Add no runtime or development dependencies.
- Async Express handlers use `asyncHandler`; synchronous handlers may remain synchronous.
- Domain functions receive `now: number`; only the web layer may call `Date.now()`.
- Purchases are player-wide, permanent, cumulative, and sequential: Tier 1 costs 1,500,000g, Tier 2 costs 2,000,000g, and Tier 3 costs 2,500,000g.
- A player may edit and render a channel only when the registry exposes it for the current class/gender and `wheel_tier >= requiredTier`.
- Raw saved rules are never deleted merely because the current class/gender lacks the slot or the tier is locked.
- Tone is per rule in `[-1,1]`; `NULL`, omitted, and `0` are render-equivalent.
- The Tone endpoints preserve source shading; they are not flat black or flat white.
- Browser persistence remains `application/x-www-form-urlencoded`; do not add `express.json()`.
- Skin URLs remain immutable and content-addressed. Their hash uses only the filtered, entitled render configuration plus sprite and slot-map identity.
- Tier-0 through Tier-2 Bazaar pages show exactly one next purchase. Tier 3 removes the purchase card and shows mastery.
- The character page shows applicable locked channels, but only entitled channels are serialized as active rules or enabled controls.
- Blackened and Holy White buttons disappear from the Wardrobe. Keep legacy `value` rules readable so existing saved finishes do not change until edited.
- Token boosts, timed consumables, loot boxes, gems, pets, combat power, weapon overlays, and weapon swapping are outside this plan.
- Use a fresh temporary database/cache for visual validation; do not clear or mutate the live database.

---

## File Structure

- Create `src/domain/cosmetic-entitlements.ts` — approved class/gender/tier registry and all availability queries.
- Modify `src/domain/cosmeticsreview.ts` — derive expected channels and review labels from the registry.
- Modify `src/domain/dye.ts` — material recipes and tier-aware Wardrobe view model.
- Modify `src/domain/shop.ts` — three-SKU catalog, price lookup, and sequential transaction.
- Create `src/domain/shopview.ts` — personalized Bazaar offer/mastery view model.
- Modify `src/domain/spritetint.ts` — Tone rule field and shading-preserving pixel operation.
- Modify `src/domain/slotcosmetics.ts` — Tone persistence, canonical hashes, and entitlement-filtered render config.
- Modify `src/domain/settings.ts` and `src/domain/settings-meta.ts` — Tier-2/Tier-3 admin prices.
- Modify `src/db/migrations.ts` — nullable `tone` column migration.
- Modify `src/web/routes/character.ts` — tier-authorized set/clear routes; remove character-page purchase route.
- Modify `src/web/routes/shop.ts` — personalized Bazaar GET and purchase POST; filtered skin rendering.
- Modify `src/web/tvview.ts` and `src/domain/leaderboards.ts` — filtered cosmetic URLs.
- Rewrite `src/web/views/shop.ejs` — next-tier and mastery Bazaar scenes.
- Modify `src/web/views/character-sheet.ejs` — tier groups, locked previews, Tone, presets, and Bazaar links.
- Create `src/web/public/dye-color.js` — browser-testable mirror of server Tone math.
- Modify `src/web/public/dye.js` — Tone/preset state, preview, and autosave.
- Modify `src/web/public/dungeon.css` — Bazaar and Wardrobe tier/Tone/preset styling.
- Add or modify the focused Vitest/Supertest files named by each task.

---

### Task 1: Add the authoritative cosmetic-channel registry

**Files:**
- Create: `src/domain/cosmetic-entitlements.ts`
- Modify: `src/domain/cosmeticsreview.ts`
- Modify: `src/domain/dye.ts`
- Modify: `tests/cosmeticsreview.test.ts`
- Create: `tests/cosmetic-entitlements.test.ts`

**Interfaces:**
- Produces: `CosmeticTier`, `CosmeticChannelDefinition`, `COSMETIC_CHANNELS`, `channelsFor`, `channelFor`, `requiredTierFor`, `entitledChannelsFor`, `lockedChannelsFor`, and `channelLabel`.
- Guarantees: registry declaration order is the player-facing order within each tier; every returned definition already applies the gender filter.

- [ ] **Step 1: Write the failing exact-matrix tests**

Create `tests/cosmetic-entitlements.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CLASSES } from '../src/domain/classes';
import {
  COSMETIC_CHANNELS,
  channelsFor,
  channelFor,
  entitledChannelsFor,
  lockedChannelsFor,
} from '../src/domain/cosmetic-entitlements';

function labelsByTier(classKey: string, gender: 'M' | 'F') {
  return Object.fromEntries([1, 2, 3].map((tier) => [
    tier,
    channelsFor(classKey, gender)
      .filter((channel) => channel.requiredTier === tier)
      .map((channel) => channel.label),
  ]));
}

describe('COSMETIC_CHANNELS', () => {
  it('preserves the approved male matrix exactly', () => {
    expect(Object.fromEntries(CLASSES.map(({ key }) => [key, labelsByTier(key, 'M')]))).toEqual({
      knight: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Belt', 'Cape', 'Boots', 'Plume'], 3: ['Weapon', 'Shield'] },
      thief: { 1: ['Clothing', 'Cape', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Boots', 'Feather'], 3: ['Weapon', 'Accessory'] },
      ranger: { 1: ['Clothing', 'Cloak', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Boots', 'Feather'], 3: ['Weapon', 'Quiver'] },
      wizard: { 1: ['Clothing', 'Cloak', 'Skin'], 2: ['Gold trim', 'Belt', 'Boots'], 3: ['Weapon', 'Eyes'] },
      priest: { 1: ['Clothing', 'Skin'], 2: ['Trim', 'Belt', 'Boots'], 3: ['Weapon', 'Holy symbol'] },
      shaman: { 1: ['Pelt', 'Skin'], 2: ['Clothing', 'Boots', 'Face paint'], 3: ['Weapon'] },
      berserker: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Helmet trim', 'Cape', 'Boots'], 3: ['Weapon', 'Horns'] },
      swordsman: { 1: ['Shirt', 'Clothing', 'Skin'], 2: ['Trim', 'Cape', 'Hair', 'Boots'], 3: ['Weapon'] },
      paladin: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Cape', 'Boots', 'Plume'], 3: ['Weapon', 'Shield'] },
    });
  });

  it('preserves every approved female addition exactly', () => {
    expect(Object.fromEntries(CLASSES.map(({ key }) => [key, labelsByTier(key, 'F')]))).toEqual({
      knight: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Belt', 'Cape', 'Hair', 'Boots', 'Lips', 'Plume'], 3: ['Weapon', 'Shield'] },
      thief: { 1: ['Clothing', 'Cape', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Hair', 'Boots', 'Lips', 'Feather'], 3: ['Weapon', 'Accessory'] },
      ranger: { 1: ['Clothing', 'Cloak', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Boots', 'Lips', 'Feather'], 3: ['Weapon', 'Quiver'] },
      wizard: { 1: ['Clothing', 'Cloak', 'Skin'], 2: ['Gold trim', 'Belt', 'Boots'], 3: ['Weapon', 'Eyes'] },
      priest: { 1: ['Clothing', 'Skin'], 2: ['Trim', 'Belt', 'Hair', 'Boots', 'Lips'], 3: ['Weapon', 'Holy symbol'] },
      shaman: { 1: ['Pelt', 'Skin'], 2: ['Clothing', 'Boots', 'Face paint', 'Lips'], 3: ['Weapon'] },
      berserker: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Helmet trim', 'Cape', 'Hair', 'Boots', 'Lips'], 3: ['Weapon', 'Horns'] },
      swordsman: { 1: ['Shirt', 'Clothing', 'Skin'], 2: ['Trim', 'Cape', 'Hair', 'Boots', 'Lips', 'Details'], 3: ['Weapon'] },
      paladin: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Cape', 'Hair', 'Boots', 'Lips', 'Plume'], 3: ['Weapon', 'Shield'] },
    });
  });

  it('has one definition per present slot and computes cumulative ownership', () => {
    for (const { key } of CLASSES) for (const gender of ['M', 'F'] as const) {
      const definitions = channelsFor(key, gender);
      expect(new Set(definitions.map((channel) => channel.slot)).size).toBe(definitions.length);
      for (const definition of definitions) {
        expect(channelFor(key, gender, definition.slot)).toEqual(definition);
      }
      expect(entitledChannelsFor(key, gender, 1).every((channel) => channel.requiredTier === 1)).toBe(true);
      expect(lockedChannelsFor(key, gender, 1).every((channel) => channel.requiredTier > 1)).toBe(true);
      expect(entitledChannelsFor(key, gender, 3)).toEqual(definitions);
    }
  });

  it('contains exactly the nine known classes', () => {
    expect(Object.keys(COSMETIC_CHANNELS)).toEqual(CLASSES.map(({ key }) => key));
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npm test -- tests/cosmetic-entitlements.test.ts`

Expected: FAIL because `src/domain/cosmetic-entitlements.ts` does not exist.

- [ ] **Step 3: Implement the registry and queries**

Create `src/domain/cosmetic-entitlements.ts`. Use the exact approved definitions below:

```ts
import type { Gender } from './classes';
import { SLOTS } from './slots';

export type CosmeticTier = 1 | 2 | 3;
export interface CosmeticChannelDefinition {
  slot: number;
  label: string;
  requiredTier: CosmeticTier;
  genders: readonly Gender[];
}

const BOTH = ['M', 'F'] as const;
const FEMALE = ['F'] as const;
const c = (
  slot: number,
  label: string,
  requiredTier: CosmeticTier,
  genders: readonly Gender[] = BOTH,
): CosmeticChannelDefinition => ({ slot, label, requiredTier, genders });

export const COSMETIC_CHANNELS: Record<string, readonly CosmeticChannelDefinition[]> = {
  knight: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.belt, 'Belt', 2), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Plume', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Shield', 3)],
  thief: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.cape, 'Cape', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Feather', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Accessory', 3)],
  ranger: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.cape, 'Cloak', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Feather', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Quiver', 3)],
  wizard: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Cloak', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Gold trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.flair, 'Eyes', 3)],
  priest: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.flair, 'Holy symbol', 3)],
  shaman: [c(SLOTS.headgear, 'Pelt', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.body, 'Clothing', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Face paint', 2), c(SLOTS.flair, 'Lips', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3)],
  berserker: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Helmet trim', 2), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.flair, 'Horns', 3)],
  swordsman: [c(SLOTS.body, 'Shirt', 1), c(SLOTS.headgear, 'Clothing', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Details', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3)],
  paladin: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Plume', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Shield', 3)],
};

export function channelsFor(classKey: string, gender: Gender): CosmeticChannelDefinition[] {
  return (COSMETIC_CHANNELS[classKey] ?? []).filter((channel) => channel.genders.includes(gender));
}
export function channelFor(classKey: string, gender: Gender, slot: number): CosmeticChannelDefinition | undefined {
  return channelsFor(classKey, gender).find((channel) => channel.slot === slot);
}
export function requiredTierFor(classKey: string, gender: Gender, slot: number): CosmeticTier | undefined {
  return channelFor(classKey, gender, slot)?.requiredTier;
}
export function entitledChannelsFor(classKey: string, gender: Gender, wheelTier: number): CosmeticChannelDefinition[] {
  return channelsFor(classKey, gender).filter((channel) => wheelTier >= channel.requiredTier);
}
export function lockedChannelsFor(classKey: string, gender: Gender, wheelTier: number): CosmeticChannelDefinition[] {
  return channelsFor(classKey, gender).filter((channel) => wheelTier < channel.requiredTier);
}
export function channelLabel(classKey: string, slot: number, gender: Gender = 'M'): string {
  return channelFor(classKey, gender, slot)?.label ?? `Slot ${slot}`;
}
```

- [ ] **Step 4: Derive review inventory and remove duplicate label maps**

In `src/domain/cosmeticsreview.ts`, import `channelsFor` and `channelLabel` from `./cosmetic-entitlements`. Derive `EXPECTED_CHANNELS` in existing `PICKER_ORDER` for slot-map coverage, while rendering roster channels in registry declaration order:

```ts
export const EXPECTED_CHANNELS = Object.fromEntries(CLASSES.map(({ key }) => [
  key,
  Object.fromEntries((['M', 'F'] as const).map((gender) => {
    const expected = new Set(channelsFor(key, gender).map((channel) => channel.slot));
    return [gender, PICKER_ORDER.filter((slot) => expected.has(slot))];
  })),
])) as Record<string, { M: readonly number[]; F: readonly number[] }>;
```

Build `ReviewVariant.channels` with:

```ts
channels: channelsFor(classKey, gender)
  .filter((channel) => available.has(channel.slot))
  .map(({ slot, label }) => ({ slot, label })),
```

Delete `CLASS_SLOT_LABELS` and `FEMALE_SLOT_LABELS` from `src/domain/dye.ts`; import and re-export `channelLabel` there so current callers remain source-compatible:

```ts
import { channelLabel } from './cosmetic-entitlements';
export { channelLabel } from './cosmetic-entitlements';
```

Replace the hand-authored `EXPECTED_CHANNELS` object assertion in `tests/cosmeticsreview.test.ts` with this registry-derivation assertion. Keep all pixel-render tests intact and leave `tests/slotmap-coverage.test.ts` unchanged:

```ts
it('derives expected map coverage from the approved registry in picker order', () => {
  for (const { key } of CLASSES) for (const gender of ['M', 'F'] as const) {
    const registered = new Set(channelsFor(key, gender).map((channel) => channel.slot));
    expect(EXPECTED_CHANNELS[key][gender]).toEqual(
      PICKER_ORDER.filter((slot) => registered.has(slot)),
    );
  }
});
```

Add `CLASSES` and `channelsFor` imports to that test file.

- [ ] **Step 5: Run focused registry and slot-map verification**

Run:

```bash
npm test -- tests/cosmetic-entitlements.test.ts tests/cosmeticsreview.test.ts tests/slotmap-coverage.test.ts tests/slotmap-integrity.test.ts
npm run typecheck
```

Expected: all selected tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/cosmetic-entitlements.ts src/domain/cosmeticsreview.ts src/domain/dye.ts tests/cosmetic-entitlements.test.ts tests/cosmeticsreview.test.ts
git commit -m "feat(cosmetics): define authoritative tier channel registry"
```

---

### Task 2: Add the three sequential cosmetic purchases

**Files:**
- Modify: `src/domain/settings.ts`
- Modify: `src/domain/settings-meta.ts`
- Modify: `src/domain/shop.ts`
- Modify: `tests/shop.test.ts`
- Modify: `tests/settings-meta.test.ts`

**Interfaces:**
- Produces: `SKUS.cosmetic_wheel_t1|t2|t3`, `skuPrice(db, sku)`, `nextCosmeticSku(wheelTier)`, and a `purchase` result with `currentTier` on failures.
- Enforces: only `grantTier === currentTier + 1` may charge gold.

- [ ] **Step 1: Write failing sequential-purchase tests**

Replace the `purchase` describe block in `tests/shop.test.ts` with cases that exercise every transition:

```ts
describe('purchase', () => {
  it('buys tiers sequentially for exactly 1.5M, 2M, and 2.5M', () => {
    const p = rich(7_000_000);
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 100)).toMatchObject({ ok: true, tier: 1, newGold: 5_500_000 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t2', 200)).toMatchObject({ ok: true, tier: 2, newGold: 3_500_000 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t3', 300)).toMatchObject({ ok: true, tier: 3, newGold: 1_000_000 });
    expect(getCosmetics(db, p.id)?.wheel_tier).toBe(3);
  });

  it('rejects skipping ahead without charging', () => {
    const p = rich(7_000_000);
    expect(purchase(db, p.id, 'cosmetic_wheel_t2', 100)).toMatchObject({ ok: false, reason: 'out_of_sequence', currentTier: 0 });
    expect(getPlayerById(db, p.id)?.gold).toBe(7_000_000);
  });

  it('treats repeated and stale tiers as no-charge already-owned requests', () => {
    const p = rich(7_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 200)).toMatchObject({ ok: false, reason: 'already_owned', currentTier: 1 });
    expect(getPlayerById(db, p.id)?.gold).toBe(5_500_000);
  });

  it('rejects insufficient gold without advancing the tier', () => {
    const p = rich(1_499_999);
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 100)).toMatchObject({ ok: false, reason: 'insufficient_gold', price: 1_500_000, gold: 1_499_999 });
    expect(getCosmetics(db, p.id)).toBeUndefined();
  });

  it('rejects unknown SKUs and missing players without charging anyone', () => {
    const p = rich(7_000_000);
    expect(purchase(db, p.id, 'not-a-sku', 100)).toMatchObject({ ok: false, reason: 'unknown_sku' });
    expect(purchase(db, 999999, 'cosmetic_wheel_t1', 100)).toMatchObject({ ok: false, reason: 'no_player' });
    expect(getPlayerById(db, p.id)?.gold).toBe(7_000_000);
  });

  it('honors independent non-negative admin price overrides for all tiers', () => {
    const p = rich(1000);
    db.prepare("UPDATE settings SET value = '100' WHERE key = 'cosmetic_wheel_t1_price'").run();
    db.prepare("UPDATE settings SET value = '200' WHERE key = 'cosmetic_wheel_t2_price'").run();
    db.prepare("UPDATE settings SET value = '300' WHERE key = 'cosmetic_wheel_t3_price'").run();
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 100)).toMatchObject({ ok: true, newGold: 900 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t2', 200)).toMatchObject({ ok: true, newGold: 700 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t3', 300)).toMatchObject({ ok: true, newGold: 400 });
  });
});
```

- [ ] **Step 2: Run and verify the expected failures**

Run: `npm test -- tests/shop.test.ts tests/settings-meta.test.ts`

Expected: FAIL because Tier-2/Tier-3 SKUs and settings do not exist and skipping Tier 2 is not rejected.

- [ ] **Step 3: Add settings and metadata**

Append to `DEFAULT_SETTINGS` immediately after Tier 1:

```ts
cosmetic_wheel_t2_price: '2000000',
cosmetic_wheel_t3_price: '2500000',
```

Add matching Shop metadata:

```ts
cosmetic_wheel_t2_price: { group: 'Shop', label: 'Dye wheel (T2) price', unit: 'gold', min: 0, step: 10000,
  description: 'Gold to unlock Tier-2 detail channels after Tier 1. Cosmetic only; recoloring remains free.' },
cosmetic_wheel_t3_price: { group: 'Shop', label: 'Dye wheel (T3) price', unit: 'gold', min: 0, step: 10000,
  description: 'Gold to unlock Tier-3 weapon, shield, and equipment channels after Tier 2. Cosmetic only.' },
```

- [ ] **Step 4: Implement sequential catalog semantics**

In `src/domain/shop.ts`, define all three SKUs and these helpers:

```ts
export interface Sku {
  id: string;
  priceSetting: string;
  priceDefault: number;
  grantTier: 1 | 2 | 3;
}
export const SKUS: Record<string, Sku> = {
  cosmetic_wheel_t1: { id: 'cosmetic_wheel_t1', priceSetting: 'cosmetic_wheel_t1_price', priceDefault: 1_500_000, grantTier: 1 },
  cosmetic_wheel_t2: { id: 'cosmetic_wheel_t2', priceSetting: 'cosmetic_wheel_t2_price', priceDefault: 2_000_000, grantTier: 2 },
  cosmetic_wheel_t3: { id: 'cosmetic_wheel_t3', priceSetting: 'cosmetic_wheel_t3_price', priceDefault: 2_500_000, grantTier: 3 },
};

export function skuPrice(db: Database.Database, sku: Sku): number {
  const configured = Number(getSetting(db, sku.priceSetting));
  return Number.isFinite(configured) && configured >= 0 ? configured : sku.priceDefault;
}

export function nextCosmeticSku(wheelTier: number): Sku | undefined {
  return Object.values(SKUS).find((sku) => sku.grantTier === wheelTier + 1);
}
```

Inside the existing transaction, compute `currentTier = cos?.wheel_tier ?? 0` before checking gold, then apply checks in this order:

```ts
if (sku.grantTier <= currentTier) return { ok: false, reason: 'already_owned', currentTier };
if (sku.grantTier !== currentTier + 1) return { ok: false, reason: 'out_of_sequence', currentTier };
if (p.gold < price) return { ok: false, reason: 'insufficient_gold', price, gold: p.gold, currentTier };
```

Extend `PurchaseResult` with `out_of_sequence` and `currentTier`. Keep the gold deduction and `wheel_tier` upsert inside the same transaction.

- [ ] **Step 5: Run focused purchase/settings tests**

Run:

```bash
npm test -- tests/shop.test.ts tests/settings.test.ts tests/settings-meta.test.ts tests/web-admin-settings.test.ts
npm run typecheck
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/settings.ts src/domain/settings-meta.ts src/domain/shop.ts tests/shop.test.ts tests/settings-meta.test.ts
git commit -m "feat(shop): add sequential cosmetic tier purchases"
```

---

### Task 3: Persist Tone and include it in canonical skin hashes

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/domain/spritetint.ts`
- Modify: `src/domain/slotcosmetics.ts`
- Modify: `tests/db-slotcosmetics-migration.test.ts`
- Modify: `tests/slotcosmetics.test.ts`

**Interfaces:**
- Extends: `SlotRule` with `tone?: number`.
- Persists: `player_slot_cosmetics.tone REAL NULL`.
- Guarantees: omitted Tone and Tone `0` hash identically; nonzero Tone changes the immutable skin hash.

- [ ] **Step 1: Write failing migration, persistence, validation, and hash tests**

Update the migration expectation:

```ts
expect(cols).toEqual(['player_id', 'slot', 'op', 'hue', 'sat', 'lo', 'hi', 'updated_at', 'tone']);
```

Append to `tests/slotcosmetics.test.ts`:

```ts
it('round-trips per-slot Tone and treats null as zero', () => {
  const p = player();
  setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, sat: 0.6, tone: -0.4 }, 100);
  expect(getSlotConfig(db, p.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 20, sat: 0.6, tone: -0.4 });
});

it('rejects non-finite and out-of-range Tone at the storage boundary', () => {
  const p = player();
  expect(() => setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, tone: 1.01 }, 100)).toThrow(RangeError);
  expect(() => setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, tone: Number.NaN }, 100)).toThrow(RangeError);
});

it('hashes omitted and zero Tone identically but changes for nonzero Tone', () => {
  const omitted = new Map([[SLOTS.body, { op: 'colorize' as const, hue: 20, sat: 0.6 }]]);
  const zero = new Map([[SLOTS.body, { op: 'colorize' as const, hue: 20, sat: 0.6, tone: 0 }]]);
  const dark = new Map([[SLOTS.body, { op: 'colorize' as const, hue: 20, sat: 0.6, tone: -0.4 }]]);
  expect(skinRenderHash('wizard_M', omitted)).toBe(skinRenderHash('wizard_M', zero));
  expect(skinRenderHash('wizard_M', omitted)).not.toBe(skinRenderHash('wizard_M', dark));
});
```

- [ ] **Step 2: Run and verify the expected failures**

Run: `npm test -- tests/db-slotcosmetics-migration.test.ts tests/slotcosmetics.test.ts`

Expected: FAIL because `tone` is absent from the schema and `SlotRule`.

- [ ] **Step 3: Add migration `009_player_slot_cosmetic_tone`**

Append to `migrations`:

```ts
{
  id: '009_player_slot_cosmetic_tone',
  sql: `ALTER TABLE player_slot_cosmetics ADD COLUMN tone REAL;`,
},
```

Add `tone?: number` to `SlotRule`. Do not remove the legacy `hue`/`value` operations or the `lo`/`hi` fields.

- [ ] **Step 4: Update storage and canonical hashing**

In `src/domain/slotcosmetics.ts`:

```ts
interface Row {
  slot: number; op: string; hue: number | null; sat: number | null;
  lo: number | null; hi: number | null; tone: number | null;
}

export function normalizeTone(tone: number | undefined): number {
  return tone == null ? 0 : tone;
}

function assertTone(tone: number | undefined): void {
  if (tone !== undefined && (!Number.isFinite(tone) || tone < -1 || tone > 1)) {
    throw new RangeError('Tone must be a finite number from -1 to 1');
  }
}
```

Select `tone`, add it to `clean` only when non-null, insert/update it in `setSlotRule`, and call `assertTone(rule.tone)` before writing. Canonicalize with `normalizeTone(r.tone)`:

```ts
`${slot}:${r.op}:${r.hue ?? ''}:${r.sat ?? ''}:${r.lo ?? ''}:${r.hi ?? ''}:${normalizeTone(r.tone)}`
```

Bump the hash namespace from `clauderpg:skin:v2` to `clauderpg:skin:v3` so old cached URLs cannot collide with Tone-aware content.

- [ ] **Step 5: Run focused persistence tests**

Run:

```bash
npm test -- tests/db-slotcosmetics-migration.test.ts tests/slotcosmetics.test.ts tests/web-skin.test.ts
npm run typecheck
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/domain/spritetint.ts src/domain/slotcosmetics.ts tests/db-slotcosmetics-migration.test.ts tests/slotcosmetics.test.ts
git commit -m "feat(cosmetics): persist per-channel Tone"
```

---

### Task 4: Implement shading-preserving Tone and material recipes

**Files:**
- Modify: `src/domain/spritetint.ts`
- Modify: `src/domain/dye.ts`
- Create: `src/web/public/dye-color.js`
- Modify: `tests/spritetint.test.ts`
- Modify: `tests/dye.test.ts`
- Create: `tests/dye-client-parity.test.ts`

**Interfaces:**
- Produces: `toneColorize(r,g,b,hue,sat,tone)`, `applySlotRule`, `MATERIAL_PRESETS`, and `dyeRule(recipe,hue,tone)`.
- Browser global: `window.ClaudeRpgDyeColor` with `hsvToRgb`, `toneColorize`, and `applyRule`.

- [ ] **Step 1: Write failing Tone and recipe tests**

Append server tests:

```ts
describe('toneColorize', () => {
  it('is byte-identical to colorize at Tone zero', () => {
    expect(toneColorize(180, 120, 60, 0, 0.6, 0)).toEqual(colorize(180, 120, 60, 0, 0.6));
  });
  it('reaches shaded neutral black and white without flattening values', () => {
    expect(toneColorize(255, 0, 0, 0, 0.6, -1)).toEqual([82, 82, 82]);
    expect(toneColorize(128, 0, 0, 0, 0.6, -1)).toEqual([41, 41, 41]);
    expect(toneColorize(255, 0, 0, 0, 0.6, 1)).toEqual([255, 255, 255]);
    expect(toneColorize(128, 0, 0, 0, 0.6, 1)).toEqual([222, 222, 222]);
  });
  it('keeps highlights brighter than shadows at intermediate Tone', () => {
    expect(toneColorize(230, 20, 20, 10, 0.6, 0.45)[0])
      .toBeGreaterThan(toneColorize(90, 10, 10, 10, 0.6, 0.45)[0]);
  });
});
```

Update `tests/dye.test.ts`:

```ts
expect(MATERIAL_PRESETS).toEqual({
  steel: { op: 'colorize', hue: 212, sat: 0.13, tone: 0 },
  bronze: { op: 'colorize', hue: 28, sat: 0.58, tone: -0.12 },
  gold: { op: 'colorize', hue: 46, sat: 0.75, tone: 0.10 },
});
expect(dyeRule('wheel', 200, -0.25)).toEqual({ op: 'colorize', hue: 200, sat: 0.6, tone: -0.25 });
expect(dyeRule('steel', null, undefined)).toEqual(MATERIAL_PRESETS.steel);
expect(dyeRule('steel', null, 0.4)).toEqual({ ...MATERIAL_PRESETS.steel, tone: 0.4 });
```

Create `tests/dye-client-parity.test.ts` using `node:vm`:

```ts
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { toneColorize } from '../src/domain/spritetint';

it('browser Tone math matches server fixture pixels exactly', () => {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync('src/web/public/dye-color.js', 'utf8'), context);
  const browser = context.ClaudeRpgDyeColor as { toneColorize: (...args: number[]) => number[] };
  const fixtures: Array<[number, number, number, number, number, number]> = [
    [243, 243, 243, 0, 0.6, -1],
    [145, 145, 145, 210, 0.13, -0.12],
    [207, 50, 50, 46, 0.75, 0],
    [90, 30, 10, 280, 0.6, 0.65],
    [255, 255, 255, 120, 0.6, 1],
  ];
  for (const args of fixtures) {
    expect(Array.from(browser.toneColorize(...args))).toEqual(toneColorize(...args));
  }
});
```

- [ ] **Step 2: Run and verify the expected failures**

Run: `npm test -- tests/spritetint.test.ts tests/dye.test.ts tests/dye-client-parity.test.ts`

Expected: FAIL because Tone rendering, recipes, and browser math do not exist.

- [ ] **Step 3: Implement server Tone math once**

In `src/domain/spritetint.ts`:

```ts
const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

export function toneColorize(
  r: number, g: number, b: number,
  hueDeg: number, saturation: number, tone = 0,
): [number, number, number] {
  const sourceValue = Math.max(r, g, b) / 255;
  const t = Math.max(-1, Math.min(1, Number.isFinite(tone) ? tone : 0));
  const amount = Math.abs(t);
  const outputSaturation = lerp(saturation, 0, amount);
  const outputValue = t <= 0
    ? lerp(sourceValue, 0.32 * sourceValue, amount)
    : lerp(sourceValue, 0.74 + 0.26 * sourceValue, amount);
  return hsvToRgb(hueDeg, outputSaturation, outputValue);
}

export function applySlotRule(rule: SlotRule, r: number, g: number, b: number): [number, number, number] {
  if (rule.op === 'colorize') return toneColorize(r, g, b, rule.hue ?? 0, rule.sat ?? 0.6, rule.tone ?? 0);
  if (rule.op === 'value') return valueRemap(r, g, b, rule.lo ?? 0, rule.hi ?? 1);
  return hueSwap(r, g, b, rule.hue ?? 0);
}
```

Use `applySlotRule` in both `recolorSprite` and `recolorSpriteSlots`. Keep `value` and `hue` behavior unchanged.

- [ ] **Step 4: Define recipes and browser parity module**

In `src/domain/dye.ts`:

```ts
export const MATERIAL_PRESETS = {
  steel: { op: 'colorize', hue: 212, sat: 0.13, tone: 0 },
  bronze: { op: 'colorize', hue: 28, sat: 0.58, tone: -0.12 },
  gold: { op: 'colorize', hue: 46, sat: 0.75, tone: 0.10 },
} as const satisfies Record<string, SlotRule>;

export function dyeRule(recipe: string, hue: number | null, tone?: number): SlotRule | null {
  if (recipe === 'wheel') {
    return hue != null && Number.isInteger(hue) && hue >= 0 && hue <= 359
      ? { ...wheelRule(hue), tone: tone ?? 0 }
      : null;
  }
  const preset = (MATERIAL_PRESETS as Record<string, SlotRule>)[recipe];
  return preset ? { ...preset, tone: tone ?? preset.tone ?? 0 } : null;
}
```

Retain `FINISHES.black|white|steel` for the read-only review page and legacy tests; the Wardrobe no longer exposes black/white buttons.

Create `src/web/public/dye-color.js` as this no-import browser/VM module:

```js
'use strict';

(function exposeDyeColor(root) {
  function hsvToRgb(hueDegrees, saturation, value) {
    const hue = (((hueDegrees % 360) + 360) % 360) / 360;
    const index = Math.floor(hue * 6);
    const fraction = hue * 6 - index;
    const p = value * (1 - saturation);
    const q = value * (1 - fraction * saturation);
    const t = value * (1 - (1 - fraction) * saturation);
    return [
      [value, t, p], [q, value, p], [p, value, t],
      [p, q, value], [t, p, value], [value, p, q],
    ][index % 6].map((channel) => Math.round(channel * 255));
  }

  function toneColorize(red, green, blue, hue, saturation, tone) {
    const sourceValue = Math.max(red, green, blue) / 255;
    const t = Math.max(-1, Math.min(1, Number.isFinite(tone) ? tone : 0));
    const amount = Math.abs(t);
    const outputSaturation = saturation + (0 - saturation) * amount;
    const targetValue = t <= 0 ? 0.32 * sourceValue : 0.74 + 0.26 * sourceValue;
    const outputValue = sourceValue + (targetValue - sourceValue) * amount;
    return hsvToRgb(hue, outputSaturation, outputValue);
  }

  function applyRule(rule, red, green, blue) {
    const value = Math.max(red, green, blue) / 255;
    if (rule.op === 'value') {
      const lo = rule.lo == null ? 0 : rule.lo;
      const hi = rule.hi == null ? 1 : rule.hi;
      const channel = Math.round((lo + value * (hi - lo)) * 255);
      return [channel, channel, channel];
    }
    if (rule.op === 'colorize') {
      return toneColorize(
        red, green, blue,
        rule.hue == null ? 0 : rule.hue,
        rule.sat == null ? 0.6 : rule.sat,
        rule.tone == null ? 0 : rule.tone,
      );
    }
    const min = Math.min(red, green, blue) / 255;
    const saturation = value === 0 ? 0 : (value - min) / value;
    return hsvToRgb(rule.hue == null ? 0 : rule.hue, saturation, value);
  }

  root.ClaudeRpgDyeColor = Object.freeze({ hsvToRgb, toneColorize, applyRule });
})(globalThis);
```

- [ ] **Step 5: Run server/browser parity tests**

Run:

```bash
npm test -- tests/spritetint.test.ts tests/dye.test.ts tests/dye-client-parity.test.ts tests/cosmeticsreview.test.ts
node --check src/web/public/dye-color.js
npm run typecheck
```

Expected: all selected tests PASS and both checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/spritetint.ts src/domain/dye.ts src/web/public/dye-color.js tests/spritetint.test.ts tests/dye.test.ts tests/dye-client-parity.test.ts
git commit -m "feat(dye): add shading-preserving Tone and material recipes"
```

---

### Task 5: Filter every rendered skin through entitlements

**Files:**
- Modify: `src/domain/slotcosmetics.ts`
- Modify: `src/domain/dye.ts`
- Modify: `src/domain/leaderboards.ts`
- Modify: `src/web/tvview.ts`
- Modify: `src/web/routes/character.ts`
- Modify: `src/web/routes/shop.ts`
- Modify: `tests/slotcosmetics.test.ts`
- Modify: `tests/tvview-cosmetics.test.ts`
- Modify: `tests/web-skin.test.ts`

**Interfaces:**
- Produces: `filterEntitledSlotConfig`, `getEntitledSlotConfig`, and `cosmeticSkinUrlForPlayer`.
- Keeps: `getSlotConfig` as the raw, lossless storage read for administrative/testing use.

- [ ] **Step 1: Write failing filter and retained-rule tests**

Append to `tests/slotcosmetics.test.ts`:

```ts
it('filters raw rules by class, gender, and cumulative tier without deleting them', () => {
  const p = player('wizard');
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
  setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, sat: 0.6 }, 10);
  setSlotRule(db, p.id, SLOTS.weapon, { op: 'colorize', hue: 40, sat: 0.6 }, 10);

  expect(getEntitledSlotConfig(db, p).size).toBe(0);
  purchase(db, p.id, 'cosmetic_wheel_t1', 20);
  expect([...getEntitledSlotConfig(db, p).keys()]).toEqual([SLOTS.body]);
  purchase(db, p.id, 'cosmetic_wheel_t2', 30);
  purchase(db, p.id, 'cosmetic_wheel_t3', 40);
  expect([...getEntitledSlotConfig(db, p).keys()].sort((a, b) => a - b)).toEqual([SLOTS.body, SLOTS.weapon].sort((a, b) => a - b));
  expect(getSlotConfig(db, p.id).has(SLOTS.weapon)).toBe(true);
});

it('retains a female-only rule while male and restores it after switching back', () => {
  const p = player('knight');
  db.prepare("UPDATE players SET gender = 'F', gold = 7000000 WHERE id = ?").run(p.id);
  purchase(db, p.id, 'cosmetic_wheel_t1', 10);
  purchase(db, p.id, 'cosmetic_wheel_t2', 20);
  setSlotRule(db, p.id, SLOTS.hair, { op: 'colorize', hue: 20, sat: 0.6 }, 30);
  expect(getEntitledSlotConfig(db, { ...p, gender: 'F' }).has(SLOTS.hair)).toBe(true);
  db.prepare("UPDATE players SET gender = 'M' WHERE id = ?").run(p.id);
  expect(getEntitledSlotConfig(db, { ...p, gender: 'M' }).has(SLOTS.hair)).toBe(false);
  expect(getSlotConfig(db, p.id).has(SLOTS.hair)).toBe(true);
});
```

Add this web-skin test and import `purchase` plus `getEntitledSlotConfig`:

```ts
it('keeps a stored Tier-3 weapon rule out of pixels and hashes until Tier 3', async () => {
  const { db, app, p } = ctx();
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
  setSlotRule(db, p.id, SLOTS.weapon, { op: 'colorize', hue: 120, sat: 0.6 }, 5);
  purchase(db, p.id, 'cosmetic_wheel_t1', 10);

  const sprite = spriteId(p.class_key, p.gender);
  const source = PNG.sync.read(readFileSync(
    `assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'M', 'a'))}`,
  ));
  const slotmap = loadSlotmap(sprite, 'a')!;
  const weaponPixel = slotmap.findIndex((slot, pixel) => slot === SLOTS.weapon && source.data[pixel * 4 + 3] !== 0);
  expect(weaponPixel).toBeGreaterThanOrEqual(0);

  const tier1Config = getEntitledSlotConfig(db, p);
  expect(tier1Config.has(SLOTS.weapon)).toBe(false);
  const tier1 = await request(app).get(`/sprite/skin/${p.id}/a/${skinRenderHash(sprite, tier1Config)}.png`);
  expect(Array.from(PNG.sync.read(tier1.body).data.slice(weaponPixel * 4, weaponPixel * 4 + 3)))
    .toEqual(Array.from(source.data.slice(weaponPixel * 4, weaponPixel * 4 + 3)));

  purchase(db, p.id, 'cosmetic_wheel_t2', 20);
  purchase(db, p.id, 'cosmetic_wheel_t3', 30);
  const tier3Config = getEntitledSlotConfig(db, p);
  expect(tier3Config.has(SLOTS.weapon)).toBe(true);
  const tier3 = await request(app).get(`/sprite/skin/${p.id}/a/${skinRenderHash(sprite, tier3Config)}.png`);
  expect(Array.from(PNG.sync.read(tier3.body).data.slice(weaponPixel * 4, weaponPixel * 4 + 3)))
    .not.toEqual(Array.from(source.data.slice(weaponPixel * 4, weaponPixel * 4 + 3)));
});
```

- [ ] **Step 2: Run and verify the expected failures**

Run: `npm test -- tests/slotcosmetics.test.ts tests/web-skin.test.ts tests/tvview-cosmetics.test.ts`

Expected: FAIL because all callers currently use unfiltered `getSlotConfig`.

- [ ] **Step 3: Implement filtered configuration helpers**

In `src/domain/slotcosmetics.ts`:

```ts
export interface CosmeticPlayerRef {
  id: number;
  class_key: string;
  gender: string;
}

export function filterEntitledSlotConfig(
  config: Map<number, SlotRule>, classKey: string, gender: Gender, wheelTier: number,
): Map<number, SlotRule> {
  const allowed = new Set(entitledChannelsFor(classKey, gender, wheelTier).map((channel) => channel.slot));
  return new Map([...config].filter(([slot]) => allowed.has(slot)));
}

export function getEntitledSlotConfig(db: Database.Database, player: CosmeticPlayerRef): Map<number, SlotRule> {
  const tier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
  return filterEntitledSlotConfig(getSlotConfig(db, player.id), player.class_key, player.gender as Gender, tier);
}

export function cosmeticSkinUrlForPlayer(
  db: Database.Database, player: CosmeticPlayerRef, frame: 'a' | 'b' = 'a',
): string {
  return cosmeticSkinUrl(player.id, player.class_key, player.gender as Gender, getEntitledSlotConfig(db, player), frame);
}
```

- [ ] **Step 4: Replace every production render caller**

Use `cosmeticSkinUrlForPlayer(db, p, 'a')` in `src/web/tvview.ts`, `src/domain/leaderboards.ts`, and the character GET route. In `/sprite/skin`, replace `getSlotConfig(db, playerId)` with `getEntitledSlotConfig(db, player)` before computing the hash and recoloring. In `dyeViewModel`, serialize `getEntitledSlotConfig(db, player)` so locked raw rules never enter `window.__DYE__`. Do not pass raw storage config into any public sprite URL or browser view model.

Update affected tests so a cosmetic URL is expected only after the applicable tier is purchased. Add one explicit Tier-0 test proving a directly inserted rule yields the plain class sprite URL.

- [ ] **Step 5: Run all render-consumer tests**

Run:

```bash
npm test -- tests/slotcosmetics.test.ts tests/web-skin.test.ts tests/tvview-cosmetics.test.ts tests/tvview-state.test.ts tests/tvhub-leaderboards.test.ts
npm run typecheck
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/slotcosmetics.ts src/domain/dye.ts src/domain/leaderboards.ts src/web/tvview.ts src/web/routes/character.ts src/web/routes/shop.ts tests/slotcosmetics.test.ts tests/tvview-cosmetics.test.ts tests/web-skin.test.ts
git commit -m "feat(cosmetics): enforce entitlements in every skin render"
```

---

### Task 6: Build the tier-aware Wardrobe view model

**Files:**
- Modify: `src/domain/dye.ts`
- Modify: `tests/dye.test.ts`

**Interfaces:**
- Produces: `DyeTierGroup`, `DyeNextOffer`, and a `DyeViewModel` containing `tier`, `groups`, `channels` (entitled only), `config` (entitled only), `nextOffer`, and `presets`.

- [ ] **Step 1: Write failing Wardrobe-model tests**

Add these assertions to `tests/dye.test.ts`:

```ts
it('shows applicable groups while exposing only entitled rules and controls', () => {
  const player = wizard('F');
  const locked = dyeViewModel(db, player);
  expect(locked.tier).toBe(0);
  expect(locked.channels).toEqual([]);
  expect(locked.groups.map((group) => [group.tier, group.unlocked])).toEqual([[1, false], [2, false], [3, false]]);
  expect(locked.groups[1].channels.map((channel) => channel.label)).toEqual(['Gold trim', 'Belt', 'Boots']);
  expect(locked.nextOffer).toMatchObject({ tier: 1, price: 1_500_000 });

  purchase(db, player.id, 'cosmetic_wheel_t1', 100);
  const tier1 = dyeViewModel(db, player);
  expect(tier1.channels.map((channel) => channel.label)).toEqual(['Clothing', 'Cloak', 'Skin']);
  expect(tier1.groups.map((group) => group.unlocked)).toEqual([true, false, false]);
  expect(tier1.nextOffer).toMatchObject({ tier: 2, price: 2_000_000 });
});

it('has no next offer after Tier 3', () => {
  const player = wizard();
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
  purchase(db, player.id, 'cosmetic_wheel_t1', 10);
  purchase(db, player.id, 'cosmetic_wheel_t2', 20);
  purchase(db, player.id, 'cosmetic_wheel_t3', 30);
  expect(dyeViewModel(db, player).nextOffer).toBeNull();
});
```

- [ ] **Step 2: Run and verify the expected failures**

Run: `npm test -- tests/dye.test.ts`

Expected: FAIL because the view model still exposes every present slot after Tier 1 and has no tier groups.

- [ ] **Step 3: Implement the new view model shape**

Use `channelsFor`, `entitledChannelsFor`, `getEntitledSlotConfig`, `nextCosmeticSku`, and `skuPrice`. Define:

```ts
export interface DyeChannel {
  slot: number;
  label: string;
  requiredTier: CosmeticTier;
}
export interface DyeTierGroup {
  tier: CosmeticTier;
  unlocked: boolean;
  channels: DyeChannel[];
}
export interface DyeNextOffer { tier: CosmeticTier; price: number; }
```

Build all three groups from the applicable registry definitions and the filtered config:

```ts
const gender = player.gender as Gender;
const wheelTier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
const definitions = channelsFor(player.class_key, gender);
const groups: DyeTierGroup[] = ([1, 2, 3] as const).map((tier) => ({
  tier,
  unlocked: wheelTier >= tier,
  channels: definitions
    .filter((channel) => channel.requiredTier === tier)
    .map(({ slot, label, requiredTier }) => ({ slot, label, requiredTier })),
}));
const channels = groups
  .filter((group) => group.unlocked)
  .flatMap((group) => group.channels);
const nextSku = nextCosmeticSku(wheelTier);
const nextOffer = nextSku
  ? { tier: nextSku.grantTier, price: skuPrice(db, nextSku) }
  : null;
const config = Object.fromEntries(getEntitledSlotConfig(db, player));
```

Return those fields with `presets: MATERIAL_PRESETS`, the existing base sprite/slot map, and `wheelSat: WHEEL_SAT`.

Keep `available` based on a real frame-A map. Keep these two compatibility fields through Task 8 so the current EJS branch remains functional between commits:

```ts
unlocked: wheelTier >= 1,
price: nextOffer?.price ?? 0,
```

Task 9 removes both fields in the same commit that replaces their template references.

- [ ] **Step 4: Run the focused model tests**

Run:

```bash
npm test -- tests/dye.test.ts tests/cosmetic-entitlements.test.ts
npm run typecheck
```

Expected: all selected tests PASS with the explicit `unlocked` and `price` compatibility fields above.

- [ ] **Step 5: Commit**

```bash
git add src/domain/dye.ts tests/dye.test.ts
git commit -m "feat(dye): expose tier-aware Wardrobe model"
```

---

### Task 7: Authorize set/clear per channel and remove character-page purchases

**Files:**
- Modify: `src/web/routes/character.ts`
- Modify: `tests/web-dye.test.ts`

**Interfaces:**
- Routes: `POST /character/dye/set` accepts `token`, `slot`, `recipe`, optional `hue`, and optional `tone`; `POST /character/dye/clear` accepts `token`, `slot`.
- Removes: `POST /character/dye/unlock`.
- Statuses: 204 success, 400 malformed/unavailable, 403 locked, 404 unknown token.

- [ ] **Step 1: Rewrite endpoint tests around Bazaar ownership**

In `tests/web-dye.test.ts`, remove the HTTP `unlock` helper. Use domain `purchase` to establish tiers and cover these exact cases:

```ts
it('removes the character-page purchase endpoint', async () => {
  const { app, player } = ctx();
  expect((await request(app).post('/character/dye/unlock').type('form').send({ token: player.auth_token })).status).toBe(404);
});

it('allows Tier-1 clothing but rejects Tier-3 weapon at Tier 1', async () => {
  const { db, app, player } = ctx();
  purchase(db, player.id, 'cosmetic_wheel_t1', 10);
  const clothing = await request(app).post('/character/dye/set').type('form')
    .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, tone: -0.25 });
  const weapon = await request(app).post('/character/dye/set').type('form')
    .send({ token: player.auth_token, slot: SLOTS.weapon, recipe: 'gold' });
  expect(clothing.status).toBe(204);
  expect(weapon.status).toBe(403);
  expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 200, sat: 0.6, tone: -0.25 });
});

it('accepts the exact Bronze recipe and bounded Tone override', async () => {
  const { db, app, player } = ctx();
  purchase(db, player.id, 'cosmetic_wheel_t1', 10);
  const res = await request(app).post('/character/dye/set').type('form')
    .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'bronze', tone: 0.2 });
  expect(res.status).toBe(204);
  expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 28, sat: 0.58, tone: 0.2 });
});

it('rejects invalid Tone without changing the stored rule', async () => {
  const { db, app, player } = ctx();
  purchase(db, player.id, 'cosmetic_wheel_t1', 10);
  setSlotRule(db, player.id, SLOTS.body, wheelRule(100), 20);
  for (const tone of ['1.01', '-1.01', 'NaN', 'Infinity']) {
    const res = await request(app).post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, tone });
    expect(res.status).toBe(400);
  }
  expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual(wheelRule(100));
});

it('does not clear a retained rule while its tier is locked', async () => {
  const { db, app, player } = ctx();
  setSlotRule(db, player.id, SLOTS.weapon, MATERIAL_PRESETS.gold, 10);
  purchase(db, player.id, 'cosmetic_wheel_t1', 20);
  const res = await request(app).post('/character/dye/clear').type('form')
    .send({ token: player.auth_token, slot: SLOTS.weapon });
  expect(res.status).toBe(403);
  expect(getSlotConfig(db, player.id).has(SLOTS.weapon)).toBe(true);
});
```

- [ ] **Step 2: Run and verify the expected failures**

Run: `npm test -- tests/web-dye.test.ts`

Expected: FAIL because the old route purchases Tier 1, all present slots are treated as unlocked, and schemas use `finish` without Tone.

- [ ] **Step 3: Replace schemas and authorization**

Define the set schema:

```ts
const DyeSetInput = z.object({
  token: z.string().min(1),
  slot: z.coerce.number().int().min(0).max(MAX_RECOLOR_SLOT),
  recipe: z.enum(['wheel', 'steel', 'bronze', 'gold']),
  hue: z.coerce.number().int().min(0).max(359).optional(),
  tone: z.coerce.number().finite().min(-1).max(1).optional(),
});
```

Delete the `/character/dye/unlock` handler and its `TokenInput` use if no other handler needs it. In set and clear:

```ts
const definition = channelFor(player.class_key, player.gender as Gender, parsed.data.slot);
if (!definition) { res.sendStatus(400); return; }
const tier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
if (tier < definition.requiredTier) { res.sendStatus(403); return; }
```

For set, call `dyeRule(parsed.data.recipe, parsed.data.hue ?? null, parsed.data.tone)`. Keep `setSlotRule` and `clearSlot` mutations after authorization only.

- [ ] **Step 4: Run endpoint and full domain tests**

Run:

```bash
npm test -- tests/web-dye.test.ts tests/dye.test.ts tests/slotcosmetics.test.ts
npm run typecheck
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/character.ts tests/web-dye.test.ts
git commit -m "feat(dye): authorize edits by cosmetic tier"
```

---

### Task 8: Reopen the Bazaar with one personalized offer

**Files:**
- Create: `src/domain/shopview.ts`
- Modify: `src/web/routes/shop.ts`
- Rewrite: `src/web/views/shop.ejs`
- Modify: `src/web/public/dungeon.css`
- Rewrite: `tests/web-shop.test.ts`
- Create: `tests/shopview.test.ts`

**Interfaces:**
- Produces: `buildShopViewModel(db, playerId)` with current tier, fresh gold, animated avatar URLs, one `nextOffer`, and `mastered`.
- Routes: `GET /shop?token=...`; `POST /shop/cosmetics/purchase`.

- [ ] **Step 1: Write failing Bazaar view-model tests**

Create `tests/shopview.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';
import { purchase } from '../src/domain/shop';
import { buildShopViewModel } from '../src/domain/shopview';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

it('offers exactly the next tier and current-variant additions', () => {
  const player = createPlayer(db, { name: 'A', class_key: 'priest', gender: 'F' }, 1);
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
  const tier1 = buildShopViewModel(db, player.id)!;
  expect(tier1.nextOffer).toMatchObject({ sku: 'cosmetic_wheel_t1', tier: 1, price: 1_500_000 });
  expect(tier1.nextOffer?.channels.map((channel) => channel.label)).toEqual(['Clothing', 'Skin']);
  purchase(db, player.id, 'cosmetic_wheel_t1', 10);
  const tier2 = buildShopViewModel(db, player.id)!;
  expect(tier2.nextOffer).toMatchObject({ sku: 'cosmetic_wheel_t2', tier: 2, price: 2_000_000 });
  expect(tier2.nextOffer?.channels.map((channel) => channel.label)).toEqual(['Trim', 'Belt', 'Hair', 'Boots', 'Lips']);
});

it('has mastery and no offer after Tier 3', () => {
  const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
  purchase(db, player.id, 'cosmetic_wheel_t1', 10);
  purchase(db, player.id, 'cosmetic_wheel_t2', 20);
  purchase(db, player.id, 'cosmetic_wheel_t3', 30);
  expect(buildShopViewModel(db, player.id)).toMatchObject({ currentTier: 3, mastered: true, nextOffer: null });
});
```

- [ ] **Step 2: Write failing GET/POST route tests**

Rewrite `tests/web-shop.test.ts` with this context helper and the route cases below:

```ts
function ctx(gold = 0) {
  const db = openDb(':memory:');
  seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(gold, player.id);
  return { db, app, player };
}
```

```ts
it('prompts for character login without a token', async () => {
  const { app } = ctx();
  const res = await request(app).get('/shop');
  expect(res.status).toBe(200);
  expect(res.text).toContain('Choose your character');
  expect(res.text).not.toContain('name="sku"');
});

it('shows exactly Tier 1 for a fresh player', async () => {
  const { app, player } = ctx(7_000_000);
  const res = await request(app).get('/shop').query({ token: player.auth_token });
  expect(res.status).toBe(200);
  expect(res.text).toContain('Tier 1');
  expect(res.text).toContain('1,500,000g');
  expect(res.text.match(/name="sku"/g)).toHaveLength(1);
  expect(res.text).not.toContain('2,000,000g');
});

it('purchases the exact next tier and redirects back to the Bazaar', async () => {
  const { db, app, player } = ctx(7_000_000);
  const res = await request(app).post('/shop/cosmetics/purchase').type('form')
    .send({ token: player.auth_token, sku: 'cosmetic_wheel_t1' });
  expect(res.status).toBe(302);
  expect(res.headers.location).toContain('/shop?token=');
  expect(getPlayerById(db, player.id)?.gold).toBe(5_500_000);
  expect(getCosmetics(db, player.id)?.wheel_tier).toBe(1);
});

it('reports missing gold and never charges an insufficient purchase', async () => {
  const { db, app, player } = ctx(1_000_000);
  const post = await request(app).post('/shop/cosmetics/purchase').type('form')
    .send({ token: player.auth_token, sku: 'cosmetic_wheel_t1' });
  expect(post.status).toBe(302);
  expect(post.headers.location).toContain('result=insufficient_gold');
  expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
  const page = await request(app).get('/shop').query({ token: player.auth_token, result: 'insufficient_gold' });
  expect(page.text).toContain('You need 500,000 more gold');
});

it('rejects an out-of-sequence forged SKU without charging', async () => {
  const { db, app, player } = ctx(7_000_000);
  const post = await request(app).post('/shop/cosmetics/purchase').type('form')
    .send({ token: player.auth_token, sku: 'cosmetic_wheel_t3' });
  expect(post.status).toBe(302);
  expect(post.headers.location).toContain('result=out_of_sequence');
  expect(getPlayerById(db, player.id)?.gold).toBe(7_000_000);
  expect(getCosmetics(db, player.id)).toBeUndefined();
});

it('renders mastery with no purchase card after Tier 3', async () => {
  const { db, app, player } = ctx(7_000_000);
  purchase(db, player.id, 'cosmetic_wheel_t1', 1);
  purchase(db, player.id, 'cosmetic_wheel_t2', 2);
  purchase(db, player.id, 'cosmetic_wheel_t3', 3);
  const res = await request(app).get('/shop').query({ token: player.auth_token });
  expect(res.text).toContain('Dye Mastery Complete');
  expect(res.text).not.toContain('name="sku"');
});
```

Also retain 404 assertions for the retired `/shop/color` and `/shop/unlock` routes.

- [ ] **Step 3: Run and verify expected failures**

Run: `npm test -- tests/shopview.test.ts tests/web-shop.test.ts`

Expected: FAIL because the Bazaar is still the closed mimic scene and has no purchase route.

- [ ] **Step 4: Implement `buildShopViewModel`**

Define:

```ts
export interface ShopOffer {
  sku: string;
  tier: CosmeticTier;
  price: number;
  missingGold: number;
  channels: CosmeticChannelDefinition[];
}
export interface ShopViewModel {
  currentTier: number;
  gold: number;
  avatarA: string;
  avatarB: string;
  nextOffer: ShopOffer | null;
  mastered: boolean;
}
```

`buildShopViewModel(db, playerId): ShopViewModel | null` begins with `getPlayerById`; this prevents a stale pre-purchase player object from showing old gold. Its core is:

```ts
const player = getPlayerById(db, playerId);
if (!player) return null;
const currentTier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
const sku = nextCosmeticSku(currentTier);
const nextOffer = sku ? (() => {
  const price = skuPrice(db, sku);
  return {
    sku: sku.id,
    tier: sku.grantTier,
    price,
    missingGold: Math.max(0, price - player.gold),
    channels: channelsFor(player.class_key, player.gender)
      .filter((channel) => channel.requiredTier === sku.grantTier),
  };
})() : null;
return {
  currentTier,
  gold: player.gold,
  avatarA: cosmeticSkinUrlForPlayer(db, player, 'a'),
  avatarB: cosmeticSkinUrlForPlayer(db, player, 'b'),
  nextOffer,
  mastered: currentTier >= 3,
};
```

- [ ] **Step 5: Implement Bazaar routes and result feedback**

GET behavior:

- no token: status 200, login CTA, no offer;
- unknown token: status 404, same scene plus “No character found for that token”;
- valid token: render the view model and an allow-listed purchase result from `req.query.result`.

POST schema:

```ts
const ShopPurchaseInput = z.object({
  token: z.string().min(1),
  sku: z.string().min(1),
});
```

Authenticate by token, call `purchase(db, player.id, sku, Date.now())`, and redirect using these result codes: `success`, `insufficient_gold`, `stale`, `out_of_sequence`, or `invalid`. Never include gold, auth data, or arbitrary error text in the query string.

- [ ] **Step 6: Build the Bazaar template and styling**

`shop.ejs` must render three mutually exclusive states:

1. login prompt;
2. one `nextOffer` card with animated `.sprite-anim` frame A/B, current gold, exact added channel chips, missing-gold feedback, and a purchase form;
3. mastery scene with no form and a Wardrobe link.

Use this conditional skeleton; add the approved descriptive copy inside these exact structural states:

```ejs
<div class="panel bazaar-open">
  <% if (!player || !shop) { %>
    <section class="bazaar-login">
      <img class="px bazaar-mimic" src="<%= mimicUrl %>" alt="a suspicious treasure chest guarding the Bazaar ledger">
      <p class="dye-kicker">The merchant needs a name</p>
      <h1>Choose your character</h1>
      <% if (error) { %><p class="err"><%= error %></p><% } %>
      <a class="btn btn-gold" href="/character">Open character login</a>
    </section>
  <% } else if (shop.nextOffer) { const offer = shop.nextOffer; %>
    <section class="bazaar-offer">
      <div class="bazaar-avatar sprite-anim" aria-label="animated preview of <%= player.name %>">
        <img class="px frame-a" src="<%= shop.avatarA %>" alt="">
        <img class="px frame-b" src="<%= shop.avatarB %>" alt="">
      </div>
      <div class="bazaar-ledger">
        <p class="dye-kicker">Permanent Wardrobe upgrade</p>
        <span class="bazaar-tier">Tier <%= offer.tier %></span>
        <h1>Expand <%= player.name %>’s dye kit</h1>
        <p class="bazaar-balance"><b><%= shop.gold.toLocaleString() %>g</b> on hand</p>
        <div class="bazaar-channels">
          <% offer.channels.forEach(function (channel) { %><span class="bazaar-channel"><%= channel.label %></span><% }); %>
        </div>
        <% if (purchaseResult === 'success') { %><p class="ok">The new dyes are ready in your Wardrobe.</p><% } %>
        <% if (purchaseResult === 'insufficient_gold') { %><p class="err">You need <%= offer.missingGold.toLocaleString() %> more gold.</p><% } %>
        <% if (purchaseResult === 'stale') { %><p class="err">Your Wardrobe already advanced. This is your current offer.</p><% } %>
        <% if (purchaseResult === 'out_of_sequence' || purchaseResult === 'invalid') { %><p class="err">That ledger entry is not available. No gold was spent.</p><% } %>
        <form method="post" action="/shop/cosmetics/purchase">
          <input type="hidden" name="token" value="<%= player.auth_token %>">
          <input type="hidden" name="sku" value="<%= offer.sku %>">
          <button class="btn btn-gold" <%= offer.missingGold > 0 ? 'disabled' : '' %>>Buy Tier <%= offer.tier %> <span><%= offer.price.toLocaleString() %>g</span></button>
        </form>
        <a href="/character?token=<%= encodeURIComponent(player.auth_token) %>">Return to the Wardrobe</a>
      </div>
    </section>
  <% } else { %>
    <section class="bazaar-mastery">
      <img class="px bazaar-mimic" src="<%= mimicUrl %>" alt="the Bazaar mimic presenting a completed dye ledger">
      <p class="dye-kicker">Every cosmetic tier is yours</p>
      <h1>Dye Mastery Complete</h1>
      <p>No more dye upgrades remain to purchase. Every applicable channel is unlocked.</p>
      <a class="btn btn-gold" href="/character?token=<%= encodeURIComponent(player.auth_token) %>">Open the complete Wardrobe</a>
    </section>
  <% } %>
</div>
<% if (shop && shop.nextOffer) { %>
<script type="module">import { start } from '/static/anim.js'; start({ periodMs: 700 });</script>
<% } %>
```

Add the animation and layout rules below, then refine border/background colors using the existing dungeon variables without changing the named structure:

```css
.bazaar-offer{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(0,1.2fr);gap:28px;align-items:center}
.bazaar-avatar{position:relative;width:216px;height:216px;margin:auto}
.bazaar-avatar img{position:absolute;inset:0;width:216px;height:216px;image-rendering:pixelated}
.sprite-anim .frame-b{visibility:hidden}.sprite-anim.show-b .frame-a{visibility:hidden}.sprite-anim.show-b .frame-b{visibility:visible}
.bazaar-tier{display:inline-flex;padding:6px 10px;border:1px solid var(--gold-dim);color:var(--gold2)}
.bazaar-channels{display:flex;flex-wrap:wrap;gap:7px;margin:18px 0}
.bazaar-channel{padding:6px 9px;border:1px solid var(--line);border-radius:6px;background:#ffffff08}
.bazaar-open .ok{color:var(--live)}
.bazaar-mastery,.bazaar-login{text-align:center;max-width:720px;margin:auto}
@media(max-width:760px){.bazaar-offer{grid-template-columns:1fr}.bazaar-avatar{width:168px;height:168px}.bazaar-avatar img{width:168px;height:168px}}
```

Reuse the dungeon shell, mimic, coins, scroll, gems, and existing pixel-art assets. Do not remove the existing closed-state classes until no other test/reference uses them.

- [ ] **Step 7: Run Bazaar tests**

Run:

```bash
npm test -- tests/shopview.test.ts tests/web-shop.test.ts tests/shop.test.ts tests/web-shell.test.ts
npm run typecheck
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/shopview.ts src/web/routes/shop.ts src/web/views/shop.ejs src/web/public/dungeon.css tests/shopview.test.ts tests/web-shop.test.ts
git commit -m "feat(shop): reopen Bazaar with sequential dye offers"
```

---

### Task 9: Redesign the character-page Wardrobe for tier groups and Tone

**Files:**
- Modify: `src/web/views/character-sheet.ejs`
- Modify: `src/web/public/dungeon.css`
- Modify: `tests/web-dye.test.ts`

**Interfaces:**
- Server-rendered controls: one tier group for each applicable tier; locked buttons are disabled and absent channels are omitted.
- Client payload: entitled channels/rules only, plus material presets.

- [ ] **Step 1: Write failing Wardrobe markup tests**

Add to `tests/web-dye.test.ts`:

```ts
it('shows Tier-0 locked previews and sends purchasing to the Bazaar', async () => {
  const { app, player } = ctx('F');
  const res = await request(app).get('/character').query({ token: player.auth_token });
  expect(res.text).toContain('Wardrobe Tier 0');
  expect(res.text).toContain('Tier 1');
  expect(res.text).toContain('Tier 2');
  expect(res.text).toContain('Tier 3');
  expect(res.text).toContain(`/shop?token=${encodeURIComponent(player.auth_token)}`);
  expect(res.text).not.toContain('/character/dye/unlock');
  expect(res.text).not.toContain('window.__DYE__');
});

it('serializes only Tier-1 controls while showing higher tiers locked', async () => {
  const { db, app, player } = ctx('F');
  purchase(db, player.id, 'cosmetic_wheel_t1', 10);
  const res = await request(app).get('/character').query({ token: player.auth_token });
  expect(res.text).toContain('Wardrobe Tier 1');
  expect(res.text).toContain('window.__DYE__');
  expect(res.text).toContain('data-slot="1"');
  expect(res.text).toContain('data-required-tier="3" disabled');
  expect(res.text).toContain('id="dye-tone"');
  expect(res.text).toContain('data-recipe="steel"');
  expect(res.text).toContain('data-recipe="bronze"');
  expect(res.text).toContain('data-recipe="gold"');
  expect(res.text).not.toContain('data-finish="black"');
  expect(res.text).not.toContain('data-finish="white"');
});

it('removes the purchase prompt at Tier 3 while keeping the complete workbench', async () => {
  const { db, app, player } = ctx();
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
  purchase(db, player.id, 'cosmetic_wheel_t1', 1);
  purchase(db, player.id, 'cosmetic_wheel_t2', 2);
  purchase(db, player.id, 'cosmetic_wheel_t3', 3);
  const res = await request(app).get('/character').query({ token: player.auth_token });
  expect(res.text).toContain('Wardrobe Tier 3');
  expect(res.text).toContain('Dye mastery complete');
  expect(res.text).not.toContain('Unlock the next tier');
});
```

- [ ] **Step 2: Run and verify expected failures**

Run: `npm test -- tests/web-dye.test.ts`

Expected: FAIL because the current template has a single unlock card, flat channel list, and Blackened/Holy White buttons.

- [ ] **Step 3: Replace the unlock/picker branches with one tier-aware panel**

Keep the unavailable-map branch. For available maps, render:

```ejs
<div class="panel dye-panel">
  <div class="dye-head">
    <div>
      <p class="dye-kicker">Your personal dungeon tailor</p>
      <h2>Dye Workbench</h2>
      <p>Wardrobe Tier <%= dye.tier %> · unlocked colors stay free forever.</p>
    </div>
    <% if (dye.nextOffer) { %>
      <a class="btn btn-gold" href="/shop?token=<%= encodeURIComponent(player.auth_token) %>">Unlock the next tier</a>
    <% } else { %>
      <span class="dye-mastery">Dye mastery complete</span>
    <% } %>
  </div>
```

Render `dye.groups` in declaration order. Every channel button has `data-slot`, `data-required-tier`, label, dot, and `disabled` when the group is locked. Do not serialize unavailable gender channels because they are absent from `dye.groups`.

Render the live fitting and active controls only when `dye.channels.length > 0`. Replace finishes with:

```ejs
<label class="dye-tone-label" for="dye-tone">Tone <output id="dye-tone-value">Natural</output></label>
<div class="dye-tone-track"><span>Black</span><input id="dye-tone" type="range" min="-100" max="100" step="1" value="0"><span>White</span></div>
<div class="dye-finishes">
  <button type="button" class="dye-fin" data-recipe="steel"><span class="dye-fin-swatch dye-fin-steel"></span><span>Forged steel</span></button>
  <button type="button" class="dye-fin" data-recipe="bronze"><span class="dye-fin-swatch dye-fin-bronze"></span><span>Aged bronze</span></button>
  <button type="button" class="dye-fin" data-recipe="gold"><span class="dye-fin-swatch dye-fin-gold"></span><span>Royal gold</span></button>
  <button type="button" class="dye-fin" data-recipe="none"><span class="dye-fin-swatch dye-fin-default">↺</span><span>Restore default</span></button>
</div>
```

Load `/static/dye-color.js` before `/static/dye.js`. Serialize `dye.channels`, `dye.config`, `dye.presets`, `dye.wheelSat`, base sprite, slot map, and token only when at least one channel is entitled.

- [ ] **Step 4: Add responsive tier/Tone/preset styling**

Add these rules, using existing `--gold`, `--gold2`, `--line`, and panel variables:

```css
.dye-tier-groups{display:grid;gap:9px}
.dye-tier-group{padding:10px;border:1px solid var(--line);border-radius:9px;background:#ffffff04}
.dye-tier-group-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;color:var(--gold2);font-size:11px;font-weight:850;text-transform:uppercase}
.dye-tier-lock{color:var(--muted)}
.dye-chan:disabled{cursor:not-allowed;opacity:.42;filter:grayscale(.65)}
.dye-chan:disabled:hover{border-color:var(--line);color:var(--ink)}
.dye-tone-label{display:flex;justify-content:space-between;margin:14px 0 7px;color:var(--ink);font-size:12px;font-weight:800}
.dye-tone-track{display:grid;grid-template-columns:auto minmax(120px,1fr) auto;align-items:center;gap:9px;color:var(--muted);font-size:10px}
.dye-tone-track input{width:100%;accent-color:var(--gold);cursor:pointer}
.dye-tone-track input:focus-visible{outline:2px solid var(--gold);outline-offset:4px}
.dye-tone-track input::-webkit-slider-thumb{border-radius:2px}
.dye-fin-bronze{background:linear-gradient(135deg,#432816,#c2814b 52%,#6c3f22)}
.dye-fin-gold{background:linear-gradient(135deg,#6f4c0e,#f4d35e 52%,#a86f0b)}
.dye-mastery{display:inline-flex;padding:6px 10px;border:1px solid #376645;border-radius:999px;color:var(--live);font-size:11px;font-weight:850;text-transform:uppercase}
@media(max-width:760px){.dye-workbench{grid-template-columns:1fr}.dye-paint-row{grid-template-columns:1fr}}
```

Keep the character and wheel on the same row at desktop widths and stack them at the existing mobile breakpoint.

- [ ] **Step 5: Remove compatibility view-model fields and run markup tests**

Remove the obsolete `dye.unlocked` and `dye.price` fields from `DyeViewModel` and its construction. Run:

```bash
npm test -- tests/web-dye.test.ts tests/dye.test.ts tests/web-character.test.ts tests/web-shell.test.ts
npm run typecheck
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/dye.ts src/web/views/character-sheet.ejs src/web/public/dungeon.css tests/web-dye.test.ts tests/dye.test.ts
git commit -m "feat(dye): present tiered Wardrobe and Tone controls"
```

---

### Task 10: Wire Tone, recipes, and ordered autosave in the browser

**Files:**
- Modify: `src/web/public/dye.js`
- Modify: `tests/dye-client-parity.test.ts`
- Modify: `tests/web-dye.test.ts`

**Interfaces:**
- Sends: `recipe`, optional `hue`, and normalized `tone` on `/character/dye/set`.
- Preserves: per-slot hue, recipe saturation, and Tone while switching controls.

- [ ] **Step 1: Add failing client-contract assertions**

Append to `tests/dye-client-parity.test.ts`:

```ts
it('client script delegates pixel math and posts normalized Tone recipes', () => {
  const source = readFileSync('src/web/public/dye.js', 'utf8');
  expect(source).toContain('window.ClaudeRpgDyeColor');
  expect(source).toContain("body.set('recipe'");
  expect(source).toContain("body.set('tone'");
  expect(source).toContain("document.getElementById('dye-tone')");
  expect(source).not.toContain("data-finish");
});
```

Add a web test asserting `window.__DYE__` contains exact `steel`, `bronze`, and `gold` recipes and contains no locked weapon rule for a Tier-1 Wizard even if one was inserted directly.

- [ ] **Step 2: Run and verify expected failures**

Run: `npm test -- tests/dye-client-parity.test.ts tests/web-dye.test.ts`

Expected: FAIL because the client still owns old color math, posts `finish`, and has no Tone input.

- [ ] **Step 3: Replace local color operations with the parity module**

At startup require:

```js
const colorMath = window.ClaudeRpgDyeColor;
if (!colorMath) return;
```

Use `colorMath.applyRule(rule, r, g, b)` in `renderPreview`. Remove duplicate `hsvToRgb`/pixel-op implementations from `dye.js`; keep wheel drawing through `colorMath.hsvToRgb`.

- [ ] **Step 4: Track per-slot recipe state**

Maintain a `states` map keyed by slot:

```js
function stateFromRule(rule) {
  if (!rule) return { recipe: 'wheel', hue: 0, sat: D.wheelSat, tone: 0 };
  if (rule.op === 'value') {
    const black = rule.lo === 0 && rule.hi === 0.32;
    return { recipe: 'wheel', hue: 0, sat: D.wheelSat, tone: black ? -1 : 1 };
  }
  const preset = Object.entries(D.presets).find(([, value]) => value.hue === rule.hue && value.sat === rule.sat);
  return {
    recipe: preset ? preset[0] : 'wheel',
    hue: rule.hue == null ? 0 : rule.hue,
    sat: rule.sat == null ? D.wheelSat : rule.sat,
    tone: rule.tone == null ? 0 : rule.tone,
  };
}
```

Changing the hue sets `recipe = 'wheel'`, `sat = D.wheelSat`, and preserves `tone`. Applying a preset copies its complete recipe. Moving Tone preserves the state's hue, saturation, and recipe. Restore Default deletes config/state and calls the existing clear path.

- [ ] **Step 5: Post Tone safely through the existing per-slot queue**

Change `saveSet` to build:

```js
const body = new URLSearchParams({ token: D.token, slot: String(slot), recipe });
if (hue != null) body.set('hue', String(hue));
body.set('tone', String(tone));
```

Continue using one debounce timer, pending body, promise queue, and failed-state marker per slot. `saveClear` must clear the timer and `pendingSets` before enqueueing clear. Keep the `beforeunload` and `pagehide` flush.

Use the range's integer `-100..100` only for display; normalize to `Number(input.value) / 100` before preview and persistence. Output labels: `Black` at `-100`, `Natural` at `0`, `White` at `100`, otherwise signed percentages.

- [ ] **Step 6: Bind existing server-rendered channel buttons**

Query and bind the server-rendered controls without replacing locked markup:

```js
const channelButtons = Array.from(document.querySelectorAll('.dye-chan:not(:disabled)'));
let active = channelButtons.length > 0 ? Number(channelButtons[0].dataset.slot) : null;

function renderChannels() {
  for (const button of channelButtons) {
    const slot = Number(button.dataset.slot);
    const rule = config.get(slot);
    button.classList.toggle('active', slot === active);
    button.classList.toggle('configured', !!rule);
    button.setAttribute('aria-pressed', String(slot === active));
    const dot = button.querySelector('.dye-dot');
    if (dot) {
      const color = ruleColor(rule);
      dot.classList.toggle('is-default', !color);
      dot.style.background = color || '';
    }
  }
}

for (const button of channelButtons) {
  button.addEventListener('click', function () {
    active = Number(button.dataset.slot);
    renderControls();
  });
}
```

Set `const toneInput = document.getElementById('dye-tone')` and require it alongside the preview/wheel/status elements. Locked buttons receive no click handler. Preserve `active` when rerendering controls.

- [ ] **Step 7: Run client, web, syntax, and type checks**

Run:

```bash
npm test -- tests/dye-client-parity.test.ts tests/web-dye.test.ts tests/dye.test.ts tests/web-skin.test.ts
node --check src/web/public/dye-color.js
node --check src/web/public/dye.js
npm run typecheck
```

Expected: all selected tests PASS and syntax/type checks exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/web/public/dye.js tests/dye-client-parity.test.ts tests/web-dye.test.ts
git commit -m "feat(dye): wire Tone and material preset autosave"
```

---

### Task 11: Full regression and visual acceptance gate

**Files:**
- Verify all files changed in Tasks 1–10.
- Modify only files required by a failing regression or user-requested visual correction.

**Interfaces:**
- Produces no new API. This task proves the complete approved product and stops for user approval.

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
npm test
npm run typecheck
node --check src/web/public/dye-color.js
node --check src/web/public/dye.js
node --check src/web/public/anim.js
git diff --check
```

Expected: all tests PASS with zero failures; all checks exit 0.

- [ ] **Step 2: Audit authorization call sites**

Run:

```bash
rg -n "getSlotConfig\(|cosmeticSkinUrl\(" src
rg -n "getEntitledSlotConfig\(|cosmeticSkinUrlForPlayer\(" src
```

Expected: raw `getSlotConfig` remains only in storage/domain editing code and tests. TV, leaderboards, character avatars, Bazaar avatars, and `/sprite/skin` use the entitled helpers.

- [ ] **Step 3: Start an isolated local demo**

Create a fresh temporary database and seed four local-only players at tiers 0–3. These commands print every Bazaar and Wardrobe URL and never touch `data/claude-rpg.db`:

```bash
CLAUDERPG_DEMO_ROOT="$(mktemp -d /private/tmp/clauderpg-cosmetics-demo.XXXXXX)"
CLAUDERPG_DEMO_DB="$CLAUDERPG_DEMO_ROOT/demo.db"
DEMO_DB_PATH="$CLAUDERPG_DEMO_DB" npx --no-install tsx -e '
  import { openDb } from "./src/db/db";
  import { seedSettings } from "./src/domain/settings";
  import { createPlayer } from "./src/domain/players";
  import { purchase } from "./src/domain/shop";
  const dbPath = process.env.DEMO_DB_PATH;
  if (!dbPath) throw new Error("DEMO_DB_PATH is required");
  const db = openDb(dbPath);
  seedSettings(db);
  const specs = [
    ["Tier Zero Knight", "knight", "F", 0],
    ["Tier One Wizard", "wizard", "M", 1],
    ["Tier Two Priest", "priest", "F", 2],
    ["Tier Three Paladin", "paladin", "M", 3],
  ] as const;
  for (const [name, classKey, gender, tier] of specs) {
    const player = createPlayer(db, { name, class_key: classKey, gender }, Date.now());
    db.prepare("UPDATE players SET gold = 12000000 WHERE id = ?").run(player.id);
    for (let n = 1; n <= tier; n += 1) purchase(db, player.id, `cosmetic_wheel_t${n}`, Date.now());
    console.log(`${name}: http://localhost:8102/shop?token=${encodeURIComponent(player.auth_token)}`);
    console.log(`${name}: http://localhost:8102/character?token=${encodeURIComponent(player.auth_token)}`);
  }
  db.close();
'
```

Run the server with:

```bash
DB_PATH="$CLAUDERPG_DEMO_DB" PORT=8102 ENABLE_COSMETICS_REVIEW=1 npm run dev
```

In a second shell run `curl --fail http://localhost:8102/health`. Expected: HTTP 200, every printed demo URL loads without server errors, and `http://localhost:8102/cosmetics-review` shows all 18 animated variants.

- [ ] **Step 4: Perform the complete browser acceptance pass**

Verify and capture:

1. Bazaar Tier 1, Tier 2, Tier 3, and Dye Mastery states;
2. exact 1.5M/2M/2.5M deductions and one-card replacement after purchase;
3. all nine classes in male and female variants on the character page;
4. exact applicable locked/unlocked groups from the approved map;
5. hue with Tone `-1`, `0`, `+1`, and at least one intermediate dark and pale color;
6. Forged Steel, Aged Bronze, Royal Gold, and Restore Default;
7. animated frame A/B skins in Bazaar, TV-compatible URLs, and cosmetics review;
8. class/gender switching away and back without loss of saved rules;
9. keyboard interaction for hue and Tone plus visible focus states;
10. failed-save status by setting browser Network throttling to Offline, moving Tone once, confirming the unsaved error, restoring No throttling, and moving Tone again to confirm “All changes saved.”

- [ ] **Step 5: Stop for explicit user visual approval**

Present the local Bazaar, Wardrobe, and fully animated male/female results. Do not merge, push, deploy, begin timed consumables, or mark the cosmetic shop shipped until the user approves this visual gate.

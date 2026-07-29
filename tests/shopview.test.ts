import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { classSpriteUrl } from '../src/domain/classes';
import { createPlayer } from '../src/domain/players';
import { purchaseConsumable } from '../src/domain/inventory';
import { nextOfficeMidnight } from '../src/domain/office-time';
import { seedSettings, setSetting } from '../src/domain/settings';
import { purchase } from '../src/domain/shop';
import { buildShopViewModel } from '../src/domain/shopview';
import { setSlotRule } from '../src/domain/slotcosmetics';
import { LEGEND, slotmapFile, SLOTS } from '../src/domain/slots';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });
const now = Date.parse('2026-07-29T14:00:00.000Z');
const timeZone = 'America/New_York';

function masterWardrobe(playerId: number): void {
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(playerId);
  purchase(db, playerId, 'cosmetic_wheel_t1', 1_500_000, now - 3);
  purchase(db, playerId, 'cosmetic_wheel_t2', 2_000_000, now - 2);
  purchase(db, playerId, 'cosmetic_wheel_t3', 2_500_000, now - 1);
}

function buyDailyStock(
  playerId: number,
  skuId: 'potion_gold_t1' | 'potion_damage_t1',
  requestId: string,
): void {
  const unitPrice = skuId === 'potion_gold_t1' ? 100_000 : 150_000;
  expect(purchaseConsumable(db, {
    playerId,
    skuId,
    quantity: 3,
    expectedUnitPrice: unitPrice,
    requestId,
    now,
    timeZone,
  })).toMatchObject({ ok: true, stockRemaining: 0 });
}

function writeSolidSlotmap(file: string, slot: number): void {
  const png = new PNG({ width: 24, height: 24 });
  const color = LEGEND.find(([candidate]) => candidate === slot)?.[1];
  if (!color) throw new Error(`No slot-map legend color for slot ${slot}`);
  for (let pixel = 0; pixel < 24 * 24; pixel += 1) {
    const offset = pixel * 4;
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = 255;
  }
  writeFileSync(file, PNG.sync.write(png));
}

describe('buildShopViewModel', () => {
  it('keeps a fresh player on the plain A sprite while supplying a distinct plain B frame', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    const shop = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(shop.avatarA).toBe(classSpriteUrl('wizard', 'M'));
    expect(shop.avatarB).toBe(classSpriteUrl('wizard', 'M', 'b'));
    expect(shop.avatarB).not.toBe(shop.avatarA);
  });

  it('offers exactly the next tier and current-variant additions', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'priest', gender: 'F' }, 1);
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
    const tier1 = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;
    expect(tier1.nextOffer).toMatchObject({ sku: 'cosmetic_wheel_t1', tier: 1, price: 1_500_000 });
    expect(tier1.nextOffer?.channels.map((channel) => channel.label)).toEqual(['Clothing', 'Skin']);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 10);
    const tier2 = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;
    expect(tier2.nextOffer).toMatchObject({ sku: 'cosmetic_wheel_t2', tier: 2, price: 2_000_000 });
    expect(tier2.nextOffer?.channels.map((channel) => channel.label)).toEqual(['Trim', 'Belt', 'Hair', 'Boots', 'Lips']);
  });

  it('describes a Tier 2 Wizard offer with title-cased channel labels and an Oxford comma', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 10);

    const shop = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(shop.nextOffer?.description).toBe(
      'The merchant is offering a permanent upgrade to your dye ledger, which unlocks Gold Trim, Belt, and Boots customizations.',
    );
  });

  it('previews only next-offer slots present across the union of both animation frames', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'priest', gender: 'F' }, 1);
    const slotmapsDir = mkdtempSync(join(tmpdir(), 'clauderpg-shop-preview-'));
    try {
      writeSolidSlotmap(slotmapFile('priest_F', 'a', slotmapsDir), SLOTS.body);
      writeSolidSlotmap(slotmapFile('priest_F', 'b', slotmapsDir), SLOTS.skin);

      const shop = buildShopViewModel(db, player.id, slotmapsDir, undefined, now, timeZone)!;

      expect(shop.preview?.demoSlots).toEqual([SLOTS.body, SLOTS.skin]);
      expect(shop.preview?.frames.a.base).toBe(classSpriteUrl('priest', 'F', 'a'));
      expect(shop.preview?.frames.b.base).toBe(classSpriteUrl('priest', 'F', 'b'));
      expect(shop.preview?.frames.a.slotmap).toHaveLength(24 * 24);
      expect(shop.preview?.frames.b.slotmap).toHaveLength(24 * 24);
    } finally {
      rmSync(slotmapsDir, { recursive: true });
    }
  });

  it('keeps persisted owned rules while previewing only the next tier', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'priest', gender: 'F' }, 1);
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 10);
    setSlotRule(db, player.id, SLOTS.body, { op: 'colorize', hue: 214, sat: 0.6 }, 11);

    const shop = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(shop.preview?.config[SLOTS.body]).toEqual({ op: 'colorize', hue: 214, sat: 0.6 });
    expect(shop.preview?.demoSlots).toEqual([
      SLOTS.trim,
      SLOTS.belt,
      SLOTS.hair,
      SLOTS.boots,
      SLOTS.facePaint,
    ]);
  });

  it('has mastery and no offer after Tier 3', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 10);
    purchase(db, player.id, 'cosmetic_wheel_t2', 2_000_000, 20);
    purchase(db, player.id, 'cosmetic_wheel_t3', 2_500_000, 30);
    expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)).toMatchObject({
      currentTier: 3,
      mastered: true,
      nextOffer: null,
      preview: null,
    });
  });

  it('closes only when wardrobe and every configured potion are exhausted', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 10000000 WHERE id = ?').run(player.id);
    masterWardrobe(player.id);

    expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
      .toBe(false);
    buyDailyStock(player.id, 'potion_gold_t1', 'sold-gold');
    expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
      .toBe(false);
    buyDailyStock(player.id, 'potion_damage_t1', 'sold-damage');
    expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
      .toBe(true);
  });

  it('does not call invalid potion tuning sold out', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    masterWardrobe(player.id);
    setSetting(db, 'potion_damage_t1_base_hit_pct', 'not-a-number');

    expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
      .toBe(false);
  });

  it('builds both daily potion offers from canonical settings and fresh player state', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);

    const view = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(view.consumables.map((offer) => offer.sku)).toEqual([
      'potion_gold_t1',
      'potion_damage_t1',
    ]);
    expect(view.consumables[0]).toMatchObject({
      name: 'Beginner Gold Potion',
      potionType: 'gold',
      tier: 1,
      unitPrice: 100_000,
      durationMs: 7_200_000,
      durationLabel: '2 active hours',
      inventory: 0,
      stockRemaining: 3,
      maxQuantity: 3,
      missingGoldForOne: 100_000,
      iconClass: 'potion-gold',
      effectCopy: '50g per 1,000 effective tokens',
    });
    expect(view.consumables[1]).toMatchObject({
      name: 'Beginner Damage Potion',
      potionType: 'damage',
      unitPrice: 150_000,
      effectCopy: '+25% personal base hit',
    });
    expect(view.nextRestockAt).toBe(nextOfficeMidnight(now, timeZone));
  });

  it('derives potion effect copy from the same tuned potency settings as activation', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    setSetting(db, 'potion_gold_t1_gold_per_1000', '73');
    setSetting(db, 'potion_damage_t1_base_hit_pct', '12.5');

    const view = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(view.consumables[0].effectCopy).toBe('73g per 1,000 effective tokens');
    expect(view.consumables[1].effectCopy).toBe('+12.5% personal base hit');
  });

  it('labels valid sub-hour durations with exact meaningful units', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    setSetting(db, 'potion_gold_t1_duration_s', '1');
    setSetting(db, 'potion_damage_t1_duration_s', '1800');

    const view = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(view.consumables[0].durationLabel).toBe('1 active second');
    expect(view.consumables[1].durationLabel).toBe('30 active minutes');
  });

  it('reflects purchased inventory, remaining stock, quantity cap, and affordability', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 250000 WHERE id = ?').run(player.id);
    expect(purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      quantity: 2,
      expectedUnitPrice: 100_000,
      requestId: '11111111-1111-4111-8111-111111111111',
      now,
      timeZone,
    })).toMatchObject({ ok: true, inventory: 2, stockRemaining: 1 });

    const view = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(view.gold).toBe(50_000);
    expect(view.consumables[0]).toMatchObject({
      inventory: 2,
      stockRemaining: 1,
      maxQuantity: 1,
      missingGoldForOne: 50_000,
    });
    expect(view.consumables[1]).toMatchObject({
      inventory: 0,
      stockRemaining: 3,
      maxQuantity: 3,
      missingGoldForOne: 100_000,
    });
  });

  it('uses configured personal daily stock while capping one purchase at three', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('5', 'potion_daily_stock_per_sku');

    const view = buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)!;

    expect(view.consumables[0]).toMatchObject({
      stockRemaining: 5,
      maxQuantity: 3,
    });
  });
});

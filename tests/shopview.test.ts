import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { classSpriteUrl } from '../src/domain/classes';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';
import { purchase } from '../src/domain/shop';
import { buildShopViewModel } from '../src/domain/shopview';
import { setSlotRule } from '../src/domain/slotcosmetics';
import { LEGEND, slotmapFile, SLOTS } from '../src/domain/slots';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

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
    const shop = buildShopViewModel(db, player.id)!;

    expect(shop.avatarA).toBe(classSpriteUrl('wizard', 'M'));
    expect(shop.avatarB).toBe(classSpriteUrl('wizard', 'M', 'b'));
    expect(shop.avatarB).not.toBe(shop.avatarA);
  });

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

  it('previews only next-offer slots present across the union of both animation frames', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'priest', gender: 'F' }, 1);
    const slotmapsDir = mkdtempSync(join(tmpdir(), 'clauderpg-shop-preview-'));
    try {
      writeSolidSlotmap(slotmapFile('priest_F', 'a', slotmapsDir), SLOTS.body);
      writeSolidSlotmap(slotmapFile('priest_F', 'b', slotmapsDir), SLOTS.skin);

      const shop = buildShopViewModel(db, player.id, slotmapsDir)!;

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
    purchase(db, player.id, 'cosmetic_wheel_t1', 10);
    setSlotRule(db, player.id, SLOTS.body, { op: 'colorize', hue: 214, sat: 0.6 }, 11);

    const shop = buildShopViewModel(db, player.id)!;

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
    purchase(db, player.id, 'cosmetic_wheel_t1', 10);
    purchase(db, player.id, 'cosmetic_wheel_t2', 20);
    purchase(db, player.id, 'cosmetic_wheel_t3', 30);
    expect(buildShopViewModel(db, player.id)).toMatchObject({
      currentTier: 3,
      mastered: true,
      nextOffer: null,
      preview: null,
    });
  });
});

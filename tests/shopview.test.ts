import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { classSpriteUrl } from '../src/domain/classes';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';
import { purchase } from '../src/domain/shop';
import { buildShopViewModel } from '../src/domain/shopview';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

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

  it('has mastery and no offer after Tier 3', () => {
    const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
    purchase(db, player.id, 'cosmetic_wheel_t1', 10);
    purchase(db, player.id, 'cosmetic_wheel_t2', 20);
    purchase(db, player.id, 'cosmetic_wheel_t3', 30);
    expect(buildShopViewModel(db, player.id)).toMatchObject({ currentTier: 3, mastered: true, nextOffer: null });
  });
});

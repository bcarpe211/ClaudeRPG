import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import {
  consumableProduct,
  currentPotionConfiguration,
} from '../src/domain/shop-products';

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

describe('consumable product catalog', () => {
  it('exposes only the approved Tier 1 potion catalog at its approved defaults', () => {
    expect(consumableProduct(db, 'potion_gold_t1')).toMatchObject({
      id: 'potion_gold_t1', potionType: 'gold', tier: 1, price: 100_000, durationMs: 7_200_000,
    });
    expect(consumableProduct(db, 'potion_damage_t1')).toMatchObject({
      id: 'potion_damage_t1', potionType: 'damage', tier: 1, price: 150_000, durationMs: 7_200_000,
    });
    expect(consumableProduct(db, 'potion_gold_t2')).toBeUndefined();
    expect(consumableProduct(db, 'toString')).toBeUndefined();
  });

  it('reads valid configured price, duration, and fractional damage values', () => {
    setSetting(db, 'potion_gold_t1_price', '42');
    setSetting(db, 'potion_gold_t1_duration_s', '90');
    setSetting(db, 'potion_damage_t1_base_hit_pct', '12.5');
    expect(consumableProduct(db, 'potion_gold_t1')).toMatchObject({ price: 42, durationMs: 90_000 });
    expect(currentPotionConfiguration(db)).toMatchObject({
      damage: { baseHitPercent: 12.5 },
    });
  });

  it('accepts a 1,000% damage bonus ceiling and rejects anything above it', () => {
    setSetting(db, 'potion_damage_t1_base_hit_pct', '1000');
    expect(currentPotionConfiguration(db)).toMatchObject({
      damage: { baseHitPercent: 1_000 },
    });

    setSetting(db, 'potion_damage_t1_base_hit_pct', '1000.0001');
    expect(currentPotionConfiguration(db)).toBeUndefined();
  });

  it.each([
    ['negative price', 'potion_gold_t1_price', '-1'],
    ['fractional price', 'potion_damage_t1_price', '1.5'],
    ['unsafe payout', 'potion_gold_t1_base_cap', '9007199254740992'],
    ['malformed effect', 'potion_gold_t1_gold_per_1000', 'not-a-number'],
    ['negative damage effect', 'potion_damage_t1_base_hit_pct', '-25'],
    ['fractional stock', 'potion_daily_stock_per_sku', '1.5'],
    ['negative uses', 'potion_daily_uses_per_type', '-1'],
    ['zero duration', 'potion_damage_t1_duration_s', '0'],
    ['fractional duration milliseconds', 'potion_gold_t1_duration_s', '0.0005'],
    ['unsafe duration milliseconds', 'potion_gold_t1_duration_s', '9007199254741'],
  ])('marks the whole catalog unavailable for %s', (_label, key, value) => {
    setSetting(db, key, value);
    expect(currentPotionConfiguration(db)).toBeUndefined();
    expect(consumableProduct(db, 'potion_gold_t1')).toBeUndefined();
    expect(consumableProduct(db, 'potion_damage_t1')).toBeUndefined();
  });
});

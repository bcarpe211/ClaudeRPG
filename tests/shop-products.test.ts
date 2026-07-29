import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { consumableProduct } from '../src/domain/shop-products';

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

  it('reads valid configured price and duration values while falling back from invalid prices', () => {
    setSetting(db, 'potion_gold_t1_price', '42');
    setSetting(db, 'potion_gold_t1_duration_s', '90');
    expect(consumableProduct(db, 'potion_gold_t1')).toMatchObject({ price: 42, durationMs: 90_000 });

    setSetting(db, 'potion_gold_t1_price', '-1');
    expect(consumableProduct(db, 'potion_gold_t1')).toMatchObject({ price: 100_000 });
  });

  it('rejects a configured duration below one second', () => {
    setSetting(db, 'potion_damage_t1_duration_s', '0');
    expect(() => consumableProduct(db, 'potion_damage_t1')).toThrow(/duration/i);
  });
});

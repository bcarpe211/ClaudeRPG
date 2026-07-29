import type Database from 'better-sqlite3';
import { getSetting } from './settings';

export type PotionType = 'gold' | 'damage';

export interface ConsumableProduct {
  id: 'potion_gold_t1' | 'potion_damage_t1';
  name: string;
  potionType: PotionType;
  tier: 1;
  price: number;
  durationMs: number;
  iconClass: 'potion-gold' | 'potion-damage';
}

export const CONSUMABLE_SKUS = {
  potion_gold_t1: {
    id: 'potion_gold_t1', name: 'Beginner Gold Potion', potionType: 'gold', tier: 1,
    priceSetting: 'potion_gold_t1_price', durationSetting: 'potion_gold_t1_duration_s',
    priceDefault: 100_000, durationDefaultS: 7_200, iconClass: 'potion-gold',
  },
  potion_damage_t1: {
    id: 'potion_damage_t1', name: 'Beginner Damage Potion', potionType: 'damage', tier: 1,
    priceSetting: 'potion_damage_t1_price', durationSetting: 'potion_damage_t1_duration_s',
    priceDefault: 150_000, durationDefaultS: 7_200, iconClass: 'potion-damage',
  },
} as const;

type ConsumableSku = keyof typeof CONSUMABLE_SKUS;

function configuredNonNegative(db: Database.Database, key: string, fallback: number): number {
  const value = Number(getSetting(db, key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function configuredPrice(db: Database.Database, key: string, fallback: number): number {
  const value = configuredNonNegative(db, key, fallback);
  return Number.isSafeInteger(value) ? value : fallback;
}

export function consumableProduct(
  db: Database.Database,
  skuId: string,
): ConsumableProduct | undefined {
  if (!Object.prototype.hasOwnProperty.call(CONSUMABLE_SKUS, skuId)) return undefined;
  const sku = CONSUMABLE_SKUS[skuId as ConsumableSku];
  const durationS = configuredNonNegative(db, sku.durationSetting, sku.durationDefaultS);
  if (durationS < 1) {
    throw new RangeError(`${sku.id} duration must be at least one second`);
  }

  return {
    id: sku.id,
    name: sku.name,
    potionType: sku.potionType,
    tier: sku.tier,
    price: configuredPrice(db, sku.priceSetting, sku.priceDefault),
    durationMs: durationS * 1_000,
    iconClass: sku.iconClass,
  };
}

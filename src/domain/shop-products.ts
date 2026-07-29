import type Database from 'better-sqlite3';
import { DEFAULT_SETTINGS, getSetting } from './settings';

export type PotionType = 'gold' | 'damage';

/**
 * Operational Damage Potion ceiling: a 1,000% bonus is an 11x total hit.
 * This is deliberately above Tier 1 so future tiers retain tuning room.
 */
export const MAX_DAMAGE_POTION_BONUS_PERCENT = 1_000;
export const MAX_DAMAGE_POTION_MULTIPLIER = 11;

export interface ConsumableProduct {
  id: 'potion_gold_t1' | 'potion_damage_t1';
  name: string;
  potionType: PotionType;
  tier: 1;
  price: number;
  durationMs: number;
  iconClass: 'potion-gold' | 'potion-damage';
}

export interface GoldPotionSnapshot {
  kind: 'gold';
  durationMs: number;
  tokenUnit: 1_000;
  goldPerUnit: number;
  baseCap: number;
  stretchTokens: number;
  stretchBonus: number;
}

export interface DamagePotionSnapshot {
  kind: 'damage';
  durationMs: number;
  baseHitMultiplier: number;
}

export type PotionEffectSnapshot = GoldPotionSnapshot | DamagePotionSnapshot;

export interface PotionConfiguration {
  gold: {
    price: number;
    durationMs: number;
    goldPerUnit: number;
    baseCap: number;
    stretchTokens: number;
    stretchBonus: number;
  };
  damage: {
    price: number;
    durationMs: number;
    baseHitPercent: number;
  };
  dailyStock: number;
  dailyUses: number;
}

export const POTION_SETTING_KEYS = [
  'potion_gold_t1_price',
  'potion_gold_t1_duration_s',
  'potion_gold_t1_gold_per_1000',
  'potion_gold_t1_base_cap',
  'potion_gold_t1_stretch_tokens',
  'potion_gold_t1_stretch_bonus',
  'potion_damage_t1_price',
  'potion_damage_t1_duration_s',
  'potion_damage_t1_base_hit_pct',
  'potion_daily_stock_per_sku',
  'potion_daily_uses_per_type',
] as const;

export type PotionSettingKey = typeof POTION_SETTING_KEYS[number];

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

export function isConsumableSku(skuId: string): skuId is ConsumableSku {
  return Object.prototype.hasOwnProperty.call(CONSUMABLE_SKUS, skuId);
}

function jsonNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'number' && Number.isFinite(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function settingNumber(
  values: Partial<Record<PotionSettingKey, string>>,
  key: PotionSettingKey,
): number | undefined {
  return jsonNumber(values[key] ?? DEFAULT_SETTINGS[key]);
}

function economicInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function durationMs(seconds: number | undefined): number | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? milliseconds
    : undefined;
}

export function parsePotionConfiguration(
  values: Partial<Record<PotionSettingKey, string>>,
): PotionConfiguration | undefined {
  const goldPrice = economicInteger(settingNumber(values, 'potion_gold_t1_price'));
  const goldDurationMs = durationMs(settingNumber(values, 'potion_gold_t1_duration_s'));
  const goldPerUnit = economicInteger(
    settingNumber(values, 'potion_gold_t1_gold_per_1000'),
  );
  const baseCap = economicInteger(settingNumber(values, 'potion_gold_t1_base_cap'));
  const stretchTokens = economicInteger(
    settingNumber(values, 'potion_gold_t1_stretch_tokens'),
  );
  const stretchBonus = economicInteger(
    settingNumber(values, 'potion_gold_t1_stretch_bonus'),
  );
  const damagePrice = economicInteger(settingNumber(values, 'potion_damage_t1_price'));
  const damageDurationMs = durationMs(
    settingNumber(values, 'potion_damage_t1_duration_s'),
  );
  const baseHitPercent = settingNumber(values, 'potion_damage_t1_base_hit_pct');
  const dailyStock = economicInteger(
    settingNumber(values, 'potion_daily_stock_per_sku'),
  );
  const dailyUses = economicInteger(
    settingNumber(values, 'potion_daily_uses_per_type'),
  );
  const baseHitMultiplier = baseHitPercent === undefined
    ? undefined
    : 1 + baseHitPercent / 100;
  if (
    goldPrice === undefined
    || goldDurationMs === undefined
    || goldPerUnit === undefined
    || baseCap === undefined
    || stretchTokens === undefined
    || stretchBonus === undefined
    || damagePrice === undefined
    || damageDurationMs === undefined
    || baseHitPercent === undefined
    || baseHitPercent < 0
    || baseHitPercent > MAX_DAMAGE_POTION_BONUS_PERCENT
    || baseHitMultiplier === undefined
    || !Number.isFinite(baseHitMultiplier)
    || baseHitMultiplier <= 0
    || baseHitMultiplier > MAX_DAMAGE_POTION_MULTIPLIER
    || dailyStock === undefined
    || dailyUses === undefined
  ) {
    return undefined;
  }
  return {
    gold: {
      price: goldPrice,
      durationMs: goldDurationMs,
      goldPerUnit,
      baseCap,
      stretchTokens,
      stretchBonus,
    },
    damage: {
      price: damagePrice,
      durationMs: damageDurationMs,
      baseHitPercent,
    },
    dailyStock,
    dailyUses,
  };
}

export function currentPotionConfiguration(
  db: Database.Database,
): PotionConfiguration | undefined {
  return parsePotionConfiguration(Object.fromEntries(
    POTION_SETTING_KEYS.map((key) => [key, getSetting(db, key)]),
  ));
}

export function potionEffectSnapshotForConfiguration(
  config: PotionConfiguration,
  potionType: PotionType,
): PotionEffectSnapshot {
  if (potionType === 'gold') {
    return {
      kind: 'gold',
      durationMs: config.gold.durationMs,
      tokenUnit: 1_000,
      goldPerUnit: config.gold.goldPerUnit,
      baseCap: config.gold.baseCap,
      stretchTokens: config.gold.stretchTokens,
      stretchBonus: config.gold.stretchBonus,
    };
  }
  return {
    kind: 'damage',
    durationMs: config.damage.durationMs,
    baseHitMultiplier: 1 + config.damage.baseHitPercent / 100,
  };
}

export function consumableProductForConfiguration(
  config: PotionConfiguration,
  skuId: ConsumableSku,
): ConsumableProduct {
  const sku = CONSUMABLE_SKUS[skuId];
  const configured = sku.potionType === 'gold' ? config.gold : config.damage;
  return {
    id: sku.id,
    name: sku.name,
    potionType: sku.potionType,
    tier: sku.tier,
    price: configured.price,
    durationMs: configured.durationMs,
    iconClass: sku.iconClass,
  };
}

export function consumableProduct(
  db: Database.Database,
  skuId: string,
): ConsumableProduct | undefined {
  if (!isConsumableSku(skuId)) return undefined;
  const config = currentPotionConfiguration(db);
  return config
    ? consumableProductForConfiguration(config, skuId)
    : undefined;
}

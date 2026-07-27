import type Database from 'better-sqlite3';
import { getSetting } from './settings';

export interface Sku { id: string; priceSetting: string; priceDefault: number; grantTier: 1 | 2 | 3 }
export const SKUS: Record<string, Sku> = {
  cosmetic_wheel_t1: { id: 'cosmetic_wheel_t1', priceSetting: 'cosmetic_wheel_t1_price', priceDefault: 1_500_000, grantTier: 1 },
  cosmetic_wheel_t2: { id: 'cosmetic_wheel_t2', priceSetting: 'cosmetic_wheel_t2_price', priceDefault: 2_000_000, grantTier: 2 },
  cosmetic_wheel_t3: { id: 'cosmetic_wheel_t3', priceSetting: 'cosmetic_wheel_t3_price', priceDefault: 2_500_000, grantTier: 3 },
};

export type PurchaseResult =
  | { ok: true; newGold: number; tier: number }
  | { ok: false; reason: 'unknown_sku' | 'no_player' | 'already_owned' | 'out_of_sequence' | 'insufficient_gold' | 'invalid_price'; price?: number; gold?: number; currentTier?: number }
  | { ok: false; reason: 'price_changed'; expectedPrice: number; currentPrice: number };

export function skuPrice(db: Database.Database, sku: Sku): number {
  const configured = Number(getSetting(db, sku.priceSetting));
  return Number.isFinite(configured) && configured >= 0 ? configured : sku.priceDefault;
}

export function nextCosmeticSku(wheelTier: number): Sku | undefined {
  return Object.values(SKUS).find((sku) => sku.grantTier === wheelTier + 1);
}

export function purchase(
  db: Database.Database,
  playerId: number,
  skuId: string,
  expectedPrice: number,
  now: number,
): PurchaseResult {
  const sku = SKUS[skuId];
  if (!sku) return { ok: false, reason: 'unknown_sku' };
  if (!Number.isSafeInteger(expectedPrice) || expectedPrice < 0) {
    return { ok: false, reason: 'invalid_price' };
  }
  return db.transaction((): PurchaseResult => {
    const price = skuPrice(db, sku);
    if (price !== expectedPrice) {
      return { ok: false, reason: 'price_changed', expectedPrice, currentPrice: price };
    }
    const p = db.prepare('SELECT gold FROM players WHERE id = ?').get(playerId) as { gold: number } | undefined;
    if (!p) return { ok: false, reason: 'no_player' };
    const cos = db.prepare('SELECT wheel_tier FROM player_cosmetics WHERE player_id = ?')
      .get(playerId) as { wheel_tier: number } | undefined;
    const currentTier = cos?.wheel_tier ?? 0;
    if (sku.grantTier <= currentTier) return { ok: false, reason: 'already_owned', currentTier };
    if (sku.grantTier !== currentTier + 1) return { ok: false, reason: 'out_of_sequence', currentTier };
    if (p.gold < price) return { ok: false, reason: 'insufficient_gold', price, gold: p.gold, currentTier };
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(price, playerId);
    db.prepare(
      `INSERT INTO player_cosmetics (player_id, wheel_tier, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET wheel_tier = MAX(wheel_tier, excluded.wheel_tier), updated_at = excluded.updated_at`,
    ).run(playerId, sku.grantTier, now);
    return { ok: true, newGold: p.gold - price, tier: sku.grantTier };
  })();
}

export type SetHueResult = { ok: true } | { ok: false; reason: 'no_player' | 'locked' | 'bad_hue' };

export function setCosmeticHue(
  db: Database.Database, playerId: number, region: 'primary', hue: number, now: number,
): SetHueResult {
  if (!Number.isInteger(hue) || hue < 0 || hue > 359) return { ok: false, reason: 'bad_hue' };
  const cos = db.prepare('SELECT wheel_tier FROM player_cosmetics WHERE player_id = ?')
    .get(playerId) as { wheel_tier: number } | undefined;
  if (!cos || cos.wheel_tier < 1) return { ok: false, reason: 'locked' };
  db.prepare('UPDATE player_cosmetics SET primary_hue = ?, updated_at = ? WHERE player_id = ?').run(hue, now, playerId);
  return { ok: true };
}

import type Database from 'better-sqlite3';
import { getSetting } from './settings';

export interface Sku { id: string; priceSetting: string; priceDefault: number; grantTier: number }
export const SKUS: Record<string, Sku> = {
  cosmetic_wheel_t1: { id: 'cosmetic_wheel_t1', priceSetting: 'cosmetic_wheel_t1_price', priceDefault: 1_500_000, grantTier: 1 },
};

export type PurchaseResult =
  | { ok: true; newGold: number; tier: number }
  | { ok: false; reason: 'unknown_sku' | 'no_player' | 'already_owned' | 'insufficient_gold'; price?: number; gold?: number };

function priceOf(db: Database.Database, sku: Sku): number {
  const raw = getSetting(db, sku.priceSetting);
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : sku.priceDefault;
}

export function purchase(db: Database.Database, playerId: number, skuId: string, now: number): PurchaseResult {
  const sku = SKUS[skuId];
  if (!sku) return { ok: false, reason: 'unknown_sku' };
  const price = priceOf(db, sku);
  return db.transaction((): PurchaseResult => {
    const p = db.prepare('SELECT gold FROM players WHERE id = ?').get(playerId) as { gold: number } | undefined;
    if (!p) return { ok: false, reason: 'no_player' };
    const cos = db.prepare('SELECT wheel_tier FROM player_cosmetics WHERE player_id = ?')
      .get(playerId) as { wheel_tier: number } | undefined;
    if (cos && cos.wheel_tier >= sku.grantTier) return { ok: false, reason: 'already_owned' };
    if (p.gold < price) return { ok: false, reason: 'insufficient_gold', price, gold: p.gold };
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

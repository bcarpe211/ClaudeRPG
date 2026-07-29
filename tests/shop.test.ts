import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { getPlayerById } from '../src/domain/players';
import {
  purchase,
  setCosmeticHue,
  skuPrice,
  SKUS,
} from '../src/domain/shop';
import { getCosmetics, cosmeticSpriteUrl } from '../src/domain/cosmetics';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });
function rich(gold: number) {
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(gold, p.id);
  return p;
}

describe('purchase', () => {
  it('buys tiers sequentially for exactly 1.5M, 2M, and 2.5M', () => {
    const p = rich(7_000_000);
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 100)).toMatchObject({ ok: true, tier: 1, newGold: 5_500_000 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t2', 2_000_000, 200)).toMatchObject({ ok: true, tier: 2, newGold: 3_500_000 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t3', 2_500_000, 300)).toMatchObject({ ok: true, tier: 3, newGold: 1_000_000 });
    expect(getCosmetics(db, p.id)?.wheel_tier).toBe(3);
    expect(db.prepare("SELECT amount, reason FROM gold_ledger WHERE reason='shop_purchase'").get())
      .toMatchObject({ amount: -1_500_000, reason: 'shop_purchase' });
    expect(db.prepare("SELECT balance_after FROM gold_ledger WHERE reason='shop_purchase' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ balance_after: getPlayerById(db, p.id)?.gold });
  });

  it('rejects skipping ahead without charging', () => {
    const p = rich(7_000_000);
    expect(purchase(db, p.id, 'cosmetic_wheel_t2', 2_000_000, 100)).toMatchObject({ ok: false, reason: 'out_of_sequence', currentTier: 0 });
    expect(getPlayerById(db, p.id)?.gold).toBe(7_000_000);
  });

  it('treats repeated and stale tiers as no-charge already-owned requests', () => {
    const p = rich(7_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 100);
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 200)).toMatchObject({ ok: false, reason: 'already_owned', currentTier: 1 });
    expect(getPlayerById(db, p.id)?.gold).toBe(5_500_000);
  });

  it('rejects insufficient gold without advancing the tier', () => {
    const p = rich(1_499_999);
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 100)).toMatchObject({ ok: false, reason: 'insufficient_gold', price: 1_500_000, gold: 1_499_999 });
    expect(getCosmetics(db, p.id)).toBeUndefined();
  });

  it('rejects unknown SKUs and missing players without charging anyone', () => {
    const p = rich(7_000_000);
    expect(purchase(db, p.id, 'not-a-sku', 0, 100)).toMatchObject({ ok: false, reason: 'unknown_sku' });
    expect(purchase(db, 999999, 'cosmetic_wheel_t1', 1_500_000, 100)).toMatchObject({ ok: false, reason: 'no_player' });
    expect(getPlayerById(db, p.id)?.gold).toBe(7_000_000);
  });

  it('honors independent non-negative admin price overrides for all tiers', () => {
    const p = rich(1000);
    db.prepare("UPDATE settings SET value = '100' WHERE key = 'cosmetic_wheel_t1_price'").run();
    db.prepare("UPDATE settings SET value = '200' WHERE key = 'cosmetic_wheel_t2_price'").run();
    db.prepare("UPDATE settings SET value = '300' WHERE key = 'cosmetic_wheel_t3_price'").run();
    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 100, 100)).toMatchObject({ ok: true, newGold: 900 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t2', 200, 200)).toMatchObject({ ok: true, newGold: 700 });
    expect(purchase(db, p.id, 'cosmetic_wheel_t3', 300, 300)).toMatchObject({ ok: true, newGold: 400 });
  });

  it.each([
    ['fractional', '1.5'],
    ['unsafe', '9007199254740992'],
  ])('falls back from a %s configured cosmetic price', (_label, value) => {
    db.prepare(
      "UPDATE settings SET value=? WHERE key='cosmetic_wheel_t1_price'",
    ).run(value);
    expect(skuPrice(db, SKUS.cosmetic_wheel_t1)).toBe(1_500_000);
  });

  it('rejects a price increase from the displayed offer without charging or granting', () => {
    const p = rich(7_000_000);
    db.prepare("UPDATE settings SET value = '1600000' WHERE key = 'cosmetic_wheel_t1_price'").run();

    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 100)).toEqual({
      ok: false,
      reason: 'price_changed',
      expectedPrice: 1_500_000,
      currentPrice: 1_600_000,
    });
    expect(getPlayerById(db, p.id)?.gold).toBe(7_000_000);
    expect(getCosmetics(db, p.id)).toBeUndefined();
  });

  it('rejects a price decrease from the displayed offer without charging or granting', () => {
    const p = rich(7_000_000);
    db.prepare("UPDATE settings SET value = '1400000' WHERE key = 'cosmetic_wheel_t1_price'").run();

    expect(purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 100)).toEqual({
      ok: false,
      reason: 'price_changed',
      expectedPrice: 1_500_000,
      currentPrice: 1_400_000,
    });
    expect(getPlayerById(db, p.id)?.gold).toBe(7_000_000);
    expect(getCosmetics(db, p.id)).toBeUndefined();
  });
});

describe('setCosmeticHue', () => {
  it('rejects when the wheel is not unlocked', () => {
    const p = rich(0);
    expect(setCosmeticHue(db, p.id, 'primary', 210, 100)).toMatchObject({ ok: false, reason: 'locked' });
  });
  it('rejects an out-of-range hue', () => {
    const p = rich(2_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 100);
    expect(setCosmeticHue(db, p.id, 'primary', 400, 200)).toMatchObject({ ok: false, reason: 'bad_hue' });
  });
  it('sets the hue once unlocked and drives the tinted URL', () => {
    const p = rich(2_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 100);
    expect(setCosmeticHue(db, p.id, 'primary', 210, 200)).toEqual({ ok: true });
    expect(cosmeticSpriteUrl('wizard', 'M', getCosmetics(db, p.id), 'a'))
      .toBe('/sprite/tint/wizard_M/a/210.png');
  });

  it('uses the requested frame B for an untinted cosmetic sprite', () => {
    expect(cosmeticSpriteUrl('wizard', 'M', undefined, 'b'))
      .toBe('/sprites/creatures_24x24/oryx_16bit_fantasy_creatures_22.png');
  });
});

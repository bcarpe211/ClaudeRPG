import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { getPlayerById } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { getCosmetics, cosmeticSpriteUrl } from '../src/domain/cosmetics';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });
function rich(gold: number) {
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(gold, p.id);
  return p;
}

describe('purchase', () => {
  it('rejects insufficient gold, no deduction', () => {
    const p = rich(1000);
    const r = purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(r.ok).toBe(false);
    expect(getPlayerById(db, p.id)!.gold).toBe(1000);
  });
  it('deducts exactly the price and grants tier 1', () => {
    const p = rich(2_000_000);
    const r = purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(r).toMatchObject({ ok: true, tier: 1, newGold: 500_000 });
    expect(getPlayerById(db, p.id)!.gold).toBe(500_000);
    expect(getCosmetics(db, p.id)!.wheel_tier).toBe(1);
  });
  it('is idempotent — owning it again is a no-op (no double charge)', () => {
    const p = rich(4_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    const r = purchase(db, p.id, 'cosmetic_wheel_t1', 200);
    expect(r).toMatchObject({ ok: false, reason: 'already_owned' });
    expect(getPlayerById(db, p.id)!.gold).toBe(2_500_000);
  });
});

describe('setCosmeticHue', () => {
  it('rejects when the wheel is not unlocked', () => {
    const p = rich(0);
    expect(setCosmeticHue(db, p.id, 'primary', 210, 100)).toMatchObject({ ok: false, reason: 'locked' });
  });
  it('rejects an out-of-range hue', () => {
    const p = rich(2_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(setCosmeticHue(db, p.id, 'primary', 400, 200)).toMatchObject({ ok: false, reason: 'bad_hue' });
  });
  it('sets the hue once unlocked and drives the tinted URL', () => {
    const p = rich(2_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(setCosmeticHue(db, p.id, 'primary', 210, 200)).toEqual({ ok: true });
    expect(cosmeticSpriteUrl('wizard', 'M', getCosmetics(db, p.id), 'a'))
      .toBe('/sprite/tint/wizard_M/a/210.png');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { SLOTS } from '../src/domain/slots';
import { getSlotConfig, setSlotRule, clearSlot, skinRenderHash, cosmeticSkinUrl } from '../src/domain/slotcosmetics';
import { classSpriteUrl } from '../src/domain/classes';
import { getCosmetics, spriteId } from '../src/domain/cosmetics';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });
function player(cls = 'wizard') {
  const p = createPlayer(db, { name: 'A', class_key: cls, gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
  return p;
}

describe('getSlotConfig', () => {
  it('is empty for a fresh player', () => {
    expect(getSlotConfig(db, player().id).size).toBe(0);
  });
  it('falls back to the legacy body hue from player_cosmetics', () => {
    const p = player('wizard'); // wizard op = hue
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    const cfg = getSlotConfig(db, p.id);
    expect(cfg.get(SLOTS.body)).toEqual({ op: 'hue', hue: 210 });
  });
  it('per-slot rows win over the legacy body hue, and add other slots', () => {
    const p = player();
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 40 }, 300);
    setSlotRule(db, p.id, SLOTS.weapon, { op: 'value', lo: 0, hi: 0.3 }, 300);
    const cfg = getSlotConfig(db, p.id);
    expect(cfg.get(SLOTS.body)).toEqual({ op: 'hue', hue: 40 });          // row wins over legacy 210
    expect(cfg.get(SLOTS.weapon)).toEqual({ op: 'value', lo: 0, hi: 0.3 });
  });
  it('clearSlot removes a slot', () => {
    const p = player();
    setSlotRule(db, p.id, SLOTS.cape, { op: 'hue', hue: 90 }, 300);
    clearSlot(db, p.id, SLOTS.cape, 400);
    expect(getSlotConfig(db, p.id).has(SLOTS.cape)).toBe(false);
  });
  it('clearSlot body also clears the legacy hue fallback', () => {
    const p = player();
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    expect(getSlotConfig(db, p.id).has(SLOTS.body)).toBe(true);

    clearSlot(db, p.id, SLOTS.body, 300);

    expect(getSlotConfig(db, p.id).has(SLOTS.body)).toBe(false);
    expect(getCosmetics(db, p.id)?.primary_hue).toBeNull();
  });
});

describe('skinRenderHash + cosmeticSkinUrl', () => {
  it('is stable, map-aware, and changes with the render inputs', () => {
    const a = new Map([[SLOTS.body, { op: 'hue' as const, hue: 120 }]]);
    const b = new Map([[SLOTS.body, { op: 'hue' as const, hue: 120 }]]);
    const c = new Map([[SLOTS.body, { op: 'hue' as const, hue: 220 }]]);
    expect(skinRenderHash('wizard_M', a)).toBe(skinRenderHash('wizard_M', b));
    expect(skinRenderHash('wizard_M', a)).not.toBe(skinRenderHash('wizard_M', c));
    expect(skinRenderHash('wizard_M', a)).not.toBe(skinRenderHash('priest_M', a));
    expect(skinRenderHash('wizard_M', a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('cosmeticSkinUrl: plain sprite when empty, skin URL otherwise', () => {
    const empty = new Map();
    expect(cosmeticSkinUrl(5, 'wizard', 'M', empty)).toBe(classSpriteUrl('wizard', 'M'));
    const cfg = new Map([[1, { op: 'hue' as const, hue: 210 }]]);
    expect(cosmeticSkinUrl(5, 'wizard', 'M', cfg, 'a')).toBe(`/sprite/skin/5/a/${skinRenderHash(spriteId('wizard', 'M'), cfg)}.png`);
  });
});

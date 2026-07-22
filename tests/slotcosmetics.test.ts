import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { SLOTS } from '../src/domain/slots';
import { getSlotConfig, setSlotRule, clearSlot } from '../src/domain/slotcosmetics';

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
    clearSlot(db, p.id, SLOTS.cape);
    expect(getSlotConfig(db, p.id).has(SLOTS.cape)).toBe(false);
  });
});

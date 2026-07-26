import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { SLOTS } from '../src/domain/slots';
import {
  applySlotMutationBatch, beginSlotMutationSession, getSlotConfig, getEntitledSlotConfig,
  setSlotRule, clearSlot, skinRenderHash, cosmeticSkinUrl,
} from '../src/domain/slotcosmetics';
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

describe('getEntitledSlotConfig', () => {
  it('filters raw rules by class, gender, and cumulative tier without deleting them', () => {
    const p = player('wizard');
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
    setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, sat: 0.6 }, 10);
    setSlotRule(db, p.id, SLOTS.weapon, { op: 'colorize', hue: 40, sat: 0.6 }, 10);

    expect(getEntitledSlotConfig(db, p).size).toBe(0);
    purchase(db, p.id, 'cosmetic_wheel_t1', 20);
    expect([...getEntitledSlotConfig(db, p).keys()]).toEqual([SLOTS.body]);
    purchase(db, p.id, 'cosmetic_wheel_t2', 30);
    purchase(db, p.id, 'cosmetic_wheel_t3', 40);
    expect([...getEntitledSlotConfig(db, p).keys()].sort((a, b) => a - b))
      .toEqual([SLOTS.body, SLOTS.weapon].sort((a, b) => a - b));
    expect(getSlotConfig(db, p.id).has(SLOTS.weapon)).toBe(true);
  });

  it('retains a female-only rule while male and restores it after switching back', () => {
    const p = player('knight');
    db.prepare("UPDATE players SET gender = 'F', gold = 7000000 WHERE id = ?").run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 10);
    purchase(db, p.id, 'cosmetic_wheel_t2', 20);
    setSlotRule(db, p.id, SLOTS.hair, { op: 'colorize', hue: 20, sat: 0.6 }, 30);
    expect(getEntitledSlotConfig(db, { ...p, gender: 'F' }).has(SLOTS.hair)).toBe(true);
    db.prepare("UPDATE players SET gender = 'M' WHERE id = ?").run(p.id);
    expect(getEntitledSlotConfig(db, { ...p, gender: 'M' }).has(SLOTS.hair)).toBe(false);
    expect(getSlotConfig(db, p.id).has(SLOTS.hair)).toBe(true);
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

describe('Tone persistence and hashing', () => {
  it('round-trips per-slot Tone and treats null as zero', () => {
    const p = player();
    setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, sat: 0.6, tone: -0.4 }, 100);
    expect(getSlotConfig(db, p.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 20, sat: 0.6, tone: -0.4 });
  });

  it('rejects non-finite and out-of-range Tone at the storage boundary', () => {
    const p = player();
    expect(() => setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, tone: 1.01 }, 100)).toThrow(RangeError);
    expect(() => setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 20, tone: Number.NaN }, 100)).toThrow(RangeError);
  });

  it('hashes omitted and zero Tone identically but changes for nonzero Tone', () => {
    const omitted = new Map([[SLOTS.body, { op: 'colorize' as const, hue: 20, sat: 0.6 }]]);
    const zero = new Map([[SLOTS.body, { op: 'colorize' as const, hue: 20, sat: 0.6, tone: 0 }]]);
    const dark = new Map([[SLOTS.body, { op: 'colorize' as const, hue: 20, sat: 0.6, tone: -0.4 }]]);
    expect(skinRenderHash('wizard_M', omitted)).toBe(skinRenderHash('wizard_M', zero));
    expect(skinRenderHash('wizard_M', omitted)).not.toBe(skinRenderHash('wizard_M', dark));
  });
});

describe('applySlotMutationBatch', () => {
  it('applies a multi-slot set and clear with one shared revision', () => {
    const created = player();
    const session = beginSlotMutationSession(db, created.id);
    setSlotRule(db, created.id, SLOTS.cape, { op: 'colorize', hue: 10, sat: 0.6 }, 1);
    expect(applySlotMutationBatch(db, created.id, session.session, 1, [
      { slot: SLOTS.body, rule: { op: 'colorize', hue: 200, sat: 0.6, tone: 0.2 } },
      { slot: SLOTS.cape, rule: null },
    ], 100)).toBe('applied');
    expect(getSlotConfig(db, created.id).get(SLOTS.body)).toEqual({
      op: 'colorize', hue: 200, sat: 0.6, tone: 0.2,
    });
    expect(getSlotConfig(db, created.id).has(SLOTS.cape)).toBe(false);
  });

  it('treats an exact replay as duplicate and rejects mixed duplicate/new state', () => {
    const created = player();
    const session = beginSlotMutationSession(db, created.id);
    const operations = [
      { slot: SLOTS.body, rule: { op: 'colorize' as const, hue: 120, sat: 0.6 } },
      { slot: SLOTS.skin, rule: { op: 'colorize' as const, hue: 24, sat: 0.6 } },
    ];
    expect(applySlotMutationBatch(db, created.id, session.session, 7, operations, 100)).toBe('applied');
    expect(applySlotMutationBatch(db, created.id, session.session, 7, operations, 101)).toBe('duplicate');
    expect(applySlotMutationBatch(db, created.id, session.session, 7, [
      operations[0], { slot: SLOTS.cape, rule: null },
    ], 102)).toBe('stale');
  });

  it('rolls back rules and tombstones when any write throws', () => {
    const created = player();
    const session = beginSlotMutationSession(db, created.id);
    expect(() => applySlotMutationBatch(db, created.id, session.session, 1, [
      { slot: SLOTS.body, rule: { op: 'colorize', hue: 10, sat: 0.6 } },
      { slot: SLOTS.skin, rule: { op: 'colorize', hue: 10, sat: 0.6, tone: 2 } },
    ], 100)).toThrow(RangeError);
    expect(getSlotConfig(db, created.id).has(SLOTS.body)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM player_slot_cosmetic_revisions WHERE player_id = ?')
      .get(created.id)).toEqual({ n: 0 });
  });
});

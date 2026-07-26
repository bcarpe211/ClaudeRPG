import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';
import { purchase } from '../src/domain/shop';
import { setSlotRule } from '../src/domain/slotcosmetics';
import { SLOTS } from '../src/domain/slots';
import { channelsFor } from '../src/domain/cosmetic-entitlements';
import {
  channelLabel,
  dyeRule,
  dyeViewModel,
  FINISHES,
  MATERIAL_PRESETS,
  WHEEL_SAT,
  wheelRule,
} from '../src/domain/dye';

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

function wizard(gender: 'M' | 'F' = 'M') {
  const player = createPlayer(
    db,
    { name: 'A', class_key: 'wizard', gender },
    1,
  );
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(player.id);
  return player;
}

describe('dye rules', () => {
  it('paints wheel colors through colorize at the shared saturation', () => {
    expect(wheelRule(200)).toEqual({
      op: 'colorize',
      hue: 200,
      sat: WHEEL_SAT,
    });
  });

  it('maps picker intent to stored rules and rejects invalid intent', () => {
    expect(dyeRule('wheel', 200, -0.25)).toEqual({ op: 'colorize', hue: 200, sat: 0.6, tone: -0.25 });
    expect(dyeRule('steel', null, undefined)).toEqual(MATERIAL_PRESETS.steel);
    expect(dyeRule('steel', null, 0.4)).toEqual({ ...MATERIAL_PRESETS.steel, tone: 0.4 });
    expect(dyeRule('wheel', null)).toBeNull();
    expect(dyeRule('wheel', 360)).toBeNull();
    expect(dyeRule('bogus', 10)).toBeNull();
  });

  it('defines the approved black, white, and steel finish ramps', () => {
    expect(FINISHES).toEqual({
      black: { op: 'value', lo: 0, hi: 0.32 },
      white: { op: 'value', lo: 0.74, hi: 1 },
      steel: { op: 'colorize', hue: 212, sat: 0.13 },
    });
  });

  it('defines the approved material recipes', () => {
    expect(MATERIAL_PRESETS).toEqual({
      steel: { op: 'colorize', hue: 212, sat: 0.13, tone: 0 },
      bronze: { op: 'colorize', hue: 28, sat: 0.58, tone: -0.12 },
      gold: { op: 'colorize', hue: 46, sat: 0.75, tone: 0.10 },
    });
  });

  it('uses class-facing equipment labels for repurposed material channels', () => {
    expect(channelLabel('knight', SLOTS.belt)).toBe('Belt');
    expect(channelLabel('thief', SLOTS.trim)).toBe('Trim');
    expect(channelLabel('thief', SLOTS.belt)).toBe('Belt');
    expect(channelLabel('thief', SLOTS.shield)).toBe('Accessory');
    expect(channelLabel('ranger', SLOTS.trim)).toBe('Trim');
    expect(channelLabel('ranger', SLOTS.belt)).toBe('Belt');
    expect(channelLabel('ranger', SLOTS.cape)).toBe('Cloak');
    expect(channelLabel('ranger', SLOTS.shield)).toBe('Quiver');
    expect(channelLabel('ranger', SLOTS.flair)).toBe('Feather');
    expect(channelLabel('wizard', SLOTS.headgear)).toBe('Cloak');
    expect(channelLabel('wizard', SLOTS.trim)).toBe('Gold trim');
    expect(channelLabel('wizard', SLOTS.belt)).toBe('Belt');
    expect(channelLabel('priest', SLOTS.belt)).toBe('Belt');
    expect(channelLabel('shaman', SLOTS.headgear)).toBe('Pelt');
    expect(channelLabel('berserker', SLOTS.trim)).toBe('Helmet trim');
    expect(channelLabel('swordsman', SLOTS.body)).toBe('Shirt');
    expect(channelLabel('swordsman', SLOTS.headgear)).toBe('Clothing');
    expect(channelLabel('swordsman', SLOTS.flair, 'F')).toBe('Details');
    expect(channelLabel('paladin', SLOTS.flair)).toBe('Plume');
  });

  it('labels each applicable female-only mouth channel as Lips', () => {
    for (const classKey of [
      'knight', 'thief', 'ranger', 'priest', 'berserker', 'swordsman', 'paladin',
    ]) {
      expect(channelLabel(classKey, SLOTS.facePaint, 'F')).toBe('Lips');
    }
    expect(channelLabel('shaman', SLOTS.flair, 'F')).toBe('Lips');
    expect(channelLabel('shaman', SLOTS.facePaint, 'F')).toBe('Face paint');
    expect(channelLabel('shaman', SLOTS.flair, 'M')).toBe('Slot 11');
  });
});

describe('dyeViewModel', () => {
  it('shows applicable groups while exposing only entitled rules and controls', () => {
    const player = wizard('F');
    const locked = dyeViewModel(db, player);
    expect(locked.tier).toBe(0);
    expect(locked.channels).toEqual([]);
    expect(locked.groups.map((group) => [group.tier, group.unlocked])).toEqual([[1, false], [2, false], [3, false]]);
    expect(locked.groups[1].channels.map((channel) => channel.label)).toEqual(['Gold trim', 'Belt', 'Boots']);
    expect(locked.nextOffer).toMatchObject({ tier: 1, price: 1_500_000 });

    purchase(db, player.id, 'cosmetic_wheel_t1', 100);
    const tier1 = dyeViewModel(db, player);
    expect(tier1.channels.map((channel) => channel.label)).toEqual(['Clothing', 'Cloak', 'Skin']);
    expect(tier1.groups.map((group) => group.unlocked)).toEqual([true, false, false]);
    expect(tier1.nextOffer).toMatchObject({ tier: 2, price: 2_000_000 });
  });

  it('has no next offer after Tier 3', () => {
    const player = wizard();
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
    purchase(db, player.id, 'cosmetic_wheel_t1', 10);
    purchase(db, player.id, 'cosmetic_wheel_t2', 20);
    purchase(db, player.id, 'cosmetic_wheel_t3', 30);
    expect(dyeViewModel(db, player).nextOffer).toBeNull();
  });

  it('reports locked, available channels and a full slotmap for a fresh male wizard', () => {
    const player = wizard();
    const vm = dyeViewModel(db, player);

    expect(vm.available).toBe(true);
    expect(vm.tier).toBe(0);
    expect(vm.nextOffer).toMatchObject({ tier: 1, price: 1_500_000 });
    expect(vm.channels).toEqual([]);
    expect(vm.groups.flatMap((group) => group.channels).find((channel) => channel.slot === SLOTS.flair)?.label).toBe('Eyes');
    expect(vm.slotmap).toHaveLength(24 * 24);
  });

  it('reflects an unlock and saved slot rule in the serializable config', () => {
    const player = wizard();
    purchase(db, player.id, 'cosmetic_wheel_t1', 100);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(120), 200);

    const vm = dyeViewModel(db, player);
    expect(vm.tier).toBe(1);
    expect(vm.config[SLOTS.body]).toEqual(wheelRule(120));
  });

  it('does not serialize a stored locked channel into the browser config', () => {
    const player = wizard();
    purchase(db, player.id, 'cosmetic_wheel_t1', 100);
    setSlotRule(db, player.id, SLOTS.weapon, wheelRule(120), 200);

    expect(dyeViewModel(db, player).config[SLOTS.weapon]).toBeUndefined();
  });

  it('offers the authored channels and slotmap for a female wizard', () => {
    const player = wizard('F');
    const vm = dyeViewModel(db, player);

    expect(vm.available).toBe(true);
    expect(vm.tier).toBe(0);
    expect(vm.channels).toEqual([]);
    expect(vm.groups.flatMap((group) => group.channels).map((channel) => channel.slot))
      .toEqual(channelsFor('wizard', 'F').map((channel) => channel.slot));
    expect(vm.slotmap).toHaveLength(24 * 24);
  });

  it('labels the Knight flair channel as Plume in the player picker', () => {
    const player = createPlayer(
      db,
      { name: 'Knight', class_key: 'knight', gender: 'M' },
      1,
    );
    db.prepare('UPDATE players SET gold = 4000000 WHERE id = ?').run(player.id);
    purchase(db, player.id, 'cosmetic_wheel_t1', 10);
    purchase(db, player.id, 'cosmetic_wheel_t2', 20);

    const vm = dyeViewModel(db, player);

    expect(vm.channels.find((channel) => channel.slot === SLOTS.flair)?.label)
      .toBe('Plume');
  });

  it('marks a valid player unavailable when the configured slot-map directory is empty', () => {
    const slotmapsDir = mkdtempSync(join(tmpdir(), 'clauderpg-empty-slotmaps-'));
    try {
      const player = wizard('F');
      const vm = dyeViewModel(db, player, slotmapsDir);

      expect(vm.available).toBe(false);
      expect(vm.channels).toEqual([]);
      expect(vm.slotmap).toEqual([]);
    } finally {
      rmSync(slotmapsDir, { recursive: true });
    }
  });
});

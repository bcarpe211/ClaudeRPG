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
import { EXPECTED_CHANNELS } from '../src/domain/cosmeticsreview';
import {
  channelLabel,
  dyeRule,
  dyeViewModel,
  FINISHES,
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
    expect(dyeRule('wheel', 200)).toEqual(wheelRule(200));
    expect(dyeRule('steel', null)).toEqual(FINISHES.steel);
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

  it('uses class-facing equipment labels for repurposed material channels', () => {
    expect(channelLabel('thief', SLOTS.trim)).toBe('Belt');
    expect(channelLabel('thief', SLOTS.shield)).toBe('Accessory');
    expect(channelLabel('ranger', SLOTS.trim)).toBe('Belt');
    expect(channelLabel('ranger', SLOTS.cape)).toBe('Cloak');
    expect(channelLabel('ranger', SLOTS.shield)).toBe('Quiver');
    expect(channelLabel('ranger', SLOTS.flair)).toBe('Feather');
    expect(channelLabel('wizard', SLOTS.headgear)).toBe('Cloak');
    expect(channelLabel('wizard', SLOTS.trim)).toBe('Belt');
    expect(channelLabel('priest', SLOTS.trim)).toBe('Belt');
    expect(channelLabel('shaman', SLOTS.headgear)).toBe('Pelt');
    expect(channelLabel('berserker', SLOTS.trim)).toBe('Helmet trim');
  });
});

describe('dyeViewModel', () => {
  it('reports locked, available channels and a full slotmap for a fresh male wizard', () => {
    const player = wizard();
    const vm = dyeViewModel(db, player);

    expect(vm.available).toBe(true);
    expect(vm.unlocked).toBe(false);
    expect(vm.price).toBe(1_500_000);
    expect(vm.channels.some((channel) => channel.slot === SLOTS.body)).toBe(true);
    expect(vm.channels.find((channel) => channel.slot === SLOTS.flair)?.label).toBe('Eyes');
    expect(vm.slotmap).toHaveLength(24 * 24);
  });

  it('reflects an unlock and saved slot rule in the serializable config', () => {
    const player = wizard();
    purchase(db, player.id, 'cosmetic_wheel_t1', 100);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(120), 200);

    const vm = dyeViewModel(db, player);
    expect(vm.unlocked).toBe(true);
    expect(vm.config[SLOTS.body]).toEqual(wheelRule(120));
  });

  it('offers the authored channels and slotmap for a female wizard', () => {
    const player = wizard('F');
    const vm = dyeViewModel(db, player);

    expect(vm.available).toBe(true);
    expect(vm.unlocked).toBe(false);
    expect(vm.channels.map((channel) => channel.slot))
      .toEqual(EXPECTED_CHANNELS.wizard.F);
    expect(vm.slotmap).toHaveLength(24 * 24);
  });

  it('labels the Knight flair channel as Plume in the player picker', () => {
    const player = createPlayer(
      db,
      { name: 'Knight', class_key: 'knight', gender: 'M' },
      1,
    );

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

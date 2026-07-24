import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';
import { purchase } from '../src/domain/shop';
import { setSlotRule } from '../src/domain/slotcosmetics';
import { SLOTS } from '../src/domain/slots';
import {
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

  it('makes the authored female sprite and its channels available', () => {
    const player = wizard('F');
    const vm = dyeViewModel(db, player);

    expect(vm.available).toBe(true);
    expect(vm.channels.some((channel) => channel.slot === SLOTS.flair)).toBe(true);
    expect(vm.slotmap).toHaveLength(24 * 24);
  });
});

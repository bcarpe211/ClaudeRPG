import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type PotionMote = {
  type: 'gold' | 'damage';
  color: string;
  dx: number;
  dy: number;
  size: number;
  alpha: number;
};

type PotionFx = {
  frame(input: {
    playerId: number;
    goldTier: number | null;
    damageTier: number | null;
    timeMs: number;
  }): PotionMote[];
};

function loadPotionFx(): PotionFx {
  const context: Record<string, unknown> = {};
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync('src/web/public/potion-fx.js', 'utf8'), context);
  return context.ClaudeRpgPotionFx as PotionFx;
}

describe('shared potion mote vocabulary', () => {
  it('draws four deterministic beginner motes in crisp source pixels', () => {
    const api = loadPotionFx();
    const input = {
      playerId: 7,
      goldTier: 1,
      damageTier: null,
      timeMs: 1_000,
    };

    const gold = api.frame(input);

    expect(gold).toHaveLength(4);
    expect(new Set(gold.map((mote) => mote.type))).toEqual(new Set(['gold']));
    expect(new Set(gold.map((mote) => mote.color))).toEqual(new Set(['#f1c75b']));
    expect(gold.every((mote) => [1, 2, 3].includes(mote.size))).toBe(true);
    expect(gold.every((mote) => (
      Number.isInteger(mote.dx)
      && Number.isInteger(mote.dy)
      && mote.dy <= 2
      && mote.dy >= -28
      && mote.alpha >= 0
      && mote.alpha <= 1
    ))).toBe(true);
    expect(api.frame(input)).toEqual(gold);
  });

  it('interleaves both colors within one six-mote player budget', () => {
    const api = loadPotionFx();

    const dual = api.frame({
      playerId: 7,
      goldTier: 1,
      damageTier: 1,
      timeMs: 1_000,
    });

    expect(dual).toHaveLength(6);
    expect(new Set(dual.map((mote) => mote.type))).toEqual(new Set(['gold', 'damage']));
    expect(new Set(dual.map((mote) => mote.color))).toEqual(new Set(['#f1c75b', '#e14b4b']));
    expect(Math.max(...dual.map((mote) => -mote.dy))).toBeLessThanOrEqual(28);
  });

  it('changes only stepped integer positions as time advances', () => {
    const api = loadPotionFx();
    const base = { playerId: 19, goldTier: 1, damageTier: null };
    const earlier = api.frame({ ...base, timeMs: 1_000 });
    const later = api.frame({ ...base, timeMs: 1_300 });

    expect(later.some((mote, index) => mote.dx !== earlier[index]?.dx)).toBe(true);
    expect(later.every((mote) => Number.isInteger(mote.dx) && Number.isInteger(mote.dy))).toBe(true);
  });

  it('returns no motes when neither potion effect is visible', () => {
    const api = loadPotionFx();

    expect(api.frame({ playerId: 7, goldTier: null, damageTier: null, timeMs: 1_000 }))
      .toEqual([]);
  });
});

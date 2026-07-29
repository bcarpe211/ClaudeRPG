import { describe, it, expect } from 'vitest';
import {
  allocateEncounterGold,
  splitGold,
  validateRewardConfig,
} from '../src/domain/rewards';

const P = [
  { playerId: 1, tokens: 300, damage: 100 },
  { playerId: 2, tokens: 100, damage: 900 },
];

describe('splitGold', () => {
  it('splits by pure token share at weight 0', () => {
    const g = splitGold(P, 1000, 0);
    expect(g.get(1)).toBe(750); // 300/400
    expect(g.get(2)).toBe(250); // 100/400
  });
  it('blends damage share at weight > 0', () => {
    const g = splitGold(P, 1000, 0.5);
    // p1: .5*(300/400)+.5*(100/1000)=.375+.05=.425 -> 425
    expect(g.get(1)).toBe(425);
    expect(g.get(2)).toBe(575);
  });
  it('falls back to damage share when nobody burned tokens', () => {
    const q = [{ playerId: 1, tokens: 0, damage: 100 }, { playerId: 2, tokens: 0, damage: 300 }];
    const g = splitGold(q, 400, 0);
    expect(g.get(1)).toBe(100);
    expect(g.get(2)).toBe(300);
  });
  it('splits equally when neither tokens nor damage exist', () => {
    const q = [{ playerId: 1, tokens: 0, damage: 0 }, { playerId: 2, tokens: 0, damage: 0 }];
    const g = splitGold(q, 100, 0);
    expect(g.get(1)).toBe(50);
    expect(g.get(2)).toBe(50);
  });
  it('awards nothing from a zero/empty pool', () => {
    expect(splitGold(P, 0, 0).get(1)).toBe(0);
    expect(splitGold([], 100, 0).size).toBe(0);
  });
});

describe('allocateEncounterGold', () => {
  const cfg = { workPct: 80, damagePct: 10, podiumPct: [5, 3, 2] as const };

  it('allocates work, damage, and 5/3/2 podium without changing the pool', () => {
    const awards = allocateEncounterGold([
      { playerId: 1, tokens: 800, damage: 100, potionBonusDamage: 0 },
      { playerId: 2, tokens: 200, damage: 900, potionBonusDamage: 200 },
    ], 1000, cfg);
    expect(awards.reduce((sum, award) => sum + award.totalGold, 0)).toBe(1000);
    expect(awards.find((award) => award.playerId === 2)?.damageRank).toBe(1);
    expect(awards.find((award) => award.playerId === 2)?.podiumGold).toBeGreaterThan(0);
  });

  it('returns missing podium shares to proportional damage', () => {
    const [award] = allocateEncounterGold([
      { playerId: 1, tokens: 100, damage: 100, potionBonusDamage: 0 },
    ], 101, cfg);
    expect(award.totalGold).toBe(101);
  });

  it('falls work back to damage when no eligible tokens exist', () => {
    const awards = allocateEncounterGold([
      { playerId: 1, tokens: 0, damage: 100, potionBonusDamage: 0 },
      { playerId: 2, tokens: 0, damage: 300, potionBonusDamage: 0 },
    ], 1000, cfg);
    expect(awards.find((award) => award.playerId === 2)?.totalGold)
      .toBeGreaterThan(awards.find((award) => award.playerId === 1)?.totalGold ?? 0);
  });

  it('breaks damage ties by tokens then player ID', () => {
    const awards = allocateEncounterGold([
      { playerId: 9, tokens: 50, damage: 100, potionBonusDamage: 0 },
      { playerId: 3, tokens: 100, damage: 100, potionBonusDamage: 0 },
    ], 100, cfg);
    expect(awards.find((award) => award.playerId === 3)?.damageRank).toBe(1);
  });

  it('rejects percentages that do not total 100', () => {
    expect(() => validateRewardConfig({ ...cfg, workPct: 79 })).toThrow(/100/);
  });
});

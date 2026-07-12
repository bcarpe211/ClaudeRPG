import { describe, it, expect } from 'vitest';
import { splitGold } from '../src/domain/rewards';

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

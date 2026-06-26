import { describe, it, expect } from 'vitest';
import { levelForXp, xpForLevelStart, damageMultiplier } from '../src/domain/leveling';

const BASE = 50000, GROWTH = 1.5;

describe('leveling', () => {
  it('starts at level 1 with 0 xp', () => {
    expect(levelForXp(0, BASE, GROWTH)).toBe(1);
    expect(levelForXp(49999, BASE, GROWTH)).toBe(1);
  });

  it('reaches level 2 at base_xp', () => {
    expect(levelForXp(50000, BASE, GROWTH)).toBe(2);
  });

  it('level 3 needs base + base*growth', () => {
    // reach L3 = 50000 + 75000 = 125000
    expect(xpForLevelStart(3, BASE, GROWTH)).toBe(125000);
    expect(levelForXp(124999, BASE, GROWTH)).toBe(2);
    expect(levelForXp(125000, BASE, GROWTH)).toBe(3);
  });

  it('is monotonic and handed large xp', () => {
    expect(levelForXp(10_000_000, BASE, GROWTH)).toBeGreaterThan(5);
  });

  it('damageMultiplier grows linearly with level', () => {
    expect(damageMultiplier(1, 0.1)).toBeCloseTo(1.0);
    expect(damageMultiplier(10, 0.1)).toBeCloseTo(1.9);
  });
});

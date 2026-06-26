import { describe, it, expect } from 'vitest';
import { tokenModifier, attackDamage } from '../src/domain/combat';

describe('combat', () => {
  it('tokenModifier floors at 1.0 when idle', () => {
    expect(tokenModifier(0, 20000)).toBe(1);
  });

  it('tokenModifier rises with recent tokens', () => {
    expect(tokenModifier(20000, 20000)).toBeCloseTo(2); // 1 + 20000/20000
    expect(tokenModifier(10000, 20000)).toBeCloseTo(1.5);
  });

  it('attackDamage = round(baseHit * levelMult * modifier), min 1', () => {
    // baseHit 100, level 1 (mult 1.0, slope .1), modifier 1 -> 100
    expect(attackDamage(100, 1, 0.1, 1)).toBe(100);
    // level 10 (mult 1.9), modifier 2 -> 100*1.9*2 = 380
    expect(attackDamage(100, 10, 0.1, 2)).toBe(380);
  });

  it('never deals less than 1', () => {
    expect(attackDamage(0, 1, 0.1, 1)).toBe(1);
  });
});

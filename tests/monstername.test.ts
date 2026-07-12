import { describe, it, expect } from 'vitest';
import { monsterTitle } from '../src/domain/monstername';
import { monsterName } from '../src/domain/bestiary';

describe('monsterTitle', () => {
  it('is deterministic for the same inputs', () => {
    expect(monsterTitle(42, 291, 'undead')).toBe(monsterTitle(42, 291, 'undead'));
  });

  it('is "<Adjective> <Creature name>"', () => {
    const t = monsterTitle(7, 291, 'undead'); // Skeleton
    expect(t.endsWith(monsterName(291))).toBe(true);
    expect(t.split(' ')[0][0]).toBe(t.split(' ')[0][0].toUpperCase()); // capitalized adjective
    expect(t.length).toBeGreaterThan(monsterName(291).length + 1);
  });

  it('varies across encounter ids', () => {
    const titles = new Set(Array.from({ length: 40 }, (_, i) => monsterTitle(i + 1, 291, 'undead')));
    expect(titles.size).toBeGreaterThan(1);
  });
});

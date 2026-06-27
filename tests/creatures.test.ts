import { describe, it, expect } from 'vitest';
import { pickEncounterCreature, MONSTER_TIERS, BOSSES } from '../src/domain/creatures';

// deterministic rng: always returns 0 (picks first element)
const rng0 = () => 0;

describe('creatures', () => {
  it('has ordered tiers and bosses', () => {
    expect(MONSTER_TIERS.length).toBeGreaterThan(3);
    expect(BOSSES.length).toBeGreaterThan(2);
    expect(MONSTER_TIERS[0].length).toBeGreaterThan(0);
  });

  it('regular encounter picks a 1x1 creature from the dungeon-level tier', () => {
    const c = pickEncounterCreature(1, 'single', rng0);
    expect(c.footprint).toBe(1);
    expect(c.creatureIndex).toBe(MONSTER_TIERS[0][0]);
  });

  it('boss encounter picks a 2x2 boss creature', () => {
    const c = pickEncounterCreature(1, 'boss', rng0);
    expect(c.footprint).toBe(2);
    expect(c.creatureIndex).toBe(BOSSES[0]);
  });

  it('higher dungeon levels select tougher tiers (clamped at the top)', () => {
    const lowTier = pickEncounterCreature(1, 'single', rng0).creatureIndex;
    const highTier = pickEncounterCreature(99, 'single', rng0).creatureIndex;
    expect(highTier).toBe(MONSTER_TIERS[MONSTER_TIERS.length - 1][0]);
    expect(highTier).not.toBe(lowTier);
  });

  it('pack kind is still a 1x1 creature', () => {
    expect(pickEncounterCreature(2, 'pack', rng0).footprint).toBe(1);
  });
});

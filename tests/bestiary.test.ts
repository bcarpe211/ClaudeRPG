import { describe, it, expect } from 'vitest';
import {
  MONSTERS, monsterByIndex, monsterName, monstersFor, bossesFor,
  type MonsterCategory,
} from '../src/domain/bestiary';
import { nameForCreatureFile } from '../src/web/catalog/build';
import { CREATURE_SHEET_NAMES } from '../src/web/catalog/spritenames';

const ALL_CATEGORIES: MonsterCategory[] = [
  'undead','demon','beast','vermin','elemental','dragon',
  'construct','humanoid','ooze','giant','aberration','plant',
];

describe('bestiary', () => {
  it('every monster index is a valid frame-A file with a name', () => {
    for (const m of MONSTERS) {
      expect(nameForCreatureFile(m.index, CREATURE_SHEET_NAMES)).not.toBeNull();
      expect(monsterName(m.index).length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate indices', () => {
    const seen = new Set(MONSTERS.map((m) => m.index));
    expect(seen.size).toBe(MONSTERS.length);
  });

  it('every category is represented, and every category has a boss', () => {
    for (const c of ALL_CATEGORIES) {
      expect(monstersFor([c]).length).toBeGreaterThan(0);
      expect(bossesFor([c]).length).toBeGreaterThan(0);
    }
  });

  it('monstersFor filters by category; bossesFor returns only bosses', () => {
    for (const m of monstersFor(['undead'])) expect(m.category).toBe('undead');
    for (const m of bossesFor(['dragon'])) { expect(m.boss).toBe(true); expect(m.category).toBe('dragon'); }
  });

  it('monsterByIndex resolves known creatures', () => {
    expect(monsterByIndex(291)?.category).toBe('undead'); // Skeleton
    expect(monsterName(325)).toBe('Red Dragon');
    expect(monsterByIndex(9999)).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { chooseGroup, DUNGEONS, COMPAT, FLOOR_GROUPS } from '../src/domain/floorgroups';
import { makeRng } from '../src/domain/dungeon';

describe('chooseGroup', () => {
  it('finds an eligible group for every one of the 22 dungeons', () => {
    for (const d of DUNGEONS) {
      const g = chooseGroup(d.name, makeRng(1));
      const c = COMPAT[g.handle];
      expect([c.home, ...c.great, ...c.good, ...c.feature]).toContain(d.name);
    }
  });

  it('covers Wintermarch Keep, which has no home group', () => {
    expect(FLOOR_GROUPS.some((g) => COMPAT[g.handle].home === 'Wintermarch Keep')).toBe(false);
    expect(() => chooseGroup('Wintermarch Keep', makeRng(3))).not.toThrow();
  });

  it('is deterministic for a fixed rng seed', () => {
    expect(chooseGroup('Emberforge', makeRng(42)).handle)
      .toBe(chooseGroup('Emberforge', makeRng(42)).handle);
  });

  it('throws for an unknown dungeon', () => {
    expect(() => chooseGroup('Nowhere', makeRng(1))).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { pickDungeonTheme } from '../src/domain/encounters';
import { getDungeon } from '../src/domain/floorgroups';
import { makeRng } from '../src/domain/dungeon';

describe('pickDungeonTheme', () => {
  it('always returns a valid dungeon2 name', () => {
    for (let s = 1; s <= 50; s++) {
      const name = pickDungeonTheme(makeRng(s));
      expect(getDungeon(name)).toBeDefined();
    }
  });

  it('is deterministic for a fixed rng seed', () => {
    expect(pickDungeonTheme(makeRng(42))).toBe(pickDungeonTheme(makeRng(42)));
  });

  it('never returns an old hard-coded theme', () => {
    const olds = new Set(['stone_crypt', 'cave', 'wood_fort']);
    for (let s = 1; s <= 50; s++) expect(olds.has(pickDungeonTheme(makeRng(s)))).toBe(false);
  });

  it('a down-weighted theme appears less often than a baseline one', () => {
    const rng = makeRng(7);
    const counts = new Map<string, number>();
    for (let i = 0; i < 20000; i++) {
      const n = pickDungeonTheme(rng);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    // Auric Deep is weighted 3 vs baseline 10 -> should be materially rarer than a baseline theme.
    expect((counts.get('Auric Deep') ?? 0)).toBeLessThan((counts.get('Greystone Keep') ?? 0));
  });
});

import { describe, it, expect } from 'vitest';
import { THEME_MONSTERS, FALLBACK_THEME, themeMonsters } from '../src/domain/dungeonthemes';
import { monstersFor, bossesFor } from '../src/domain/bestiary';
import { DUNGEONS } from '../src/domain/floorgroups';

describe('dungeonthemes', () => {
  it('maps every dungeon in the roster', () => {
    for (const d of DUNGEONS) expect(THEME_MONSTERS[d.name]).toBeDefined();
  });

  it('every theme can spawn a regular and a boss', () => {
    for (const [name, tm] of Object.entries(THEME_MONSTERS)) {
      expect(monstersFor(tm.categories).length, name).toBeGreaterThan(0);
      expect(bossesFor(tm.bossCategories ?? tm.categories).length, name).toBeGreaterThan(0);
    }
  });

  it('the fallback is usable and returned for unknown names', () => {
    expect(monstersFor(FALLBACK_THEME.categories).length).toBeGreaterThan(0);
    expect(bossesFor(FALLBACK_THEME.bossCategories ?? FALLBACK_THEME.categories).length).toBeGreaterThan(0);
    expect(themeMonsters('nonesuch legacy theme')).toEqual(FALLBACK_THEME);
    expect(themeMonsters('Ossuary Pale')).toBe(THEME_MONSTERS['Ossuary Pale']);
  });
});

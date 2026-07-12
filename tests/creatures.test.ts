import { describe, it, expect } from 'vitest';
import { pickEncounterCreature } from '../src/domain/creatures';
import { monsterByIndex } from '../src/domain/bestiary';
import { THEME_MONSTERS, themeMonsters } from '../src/domain/dungeonthemes';

const rng0 = () => 0;

describe('creatures — theme-gated selection', () => {
  it('regular pick is a 1x1 creature whose category is in the theme', () => {
    const tm = THEME_MONSTERS['Ossuary Pale'];
    const c = pickEncounterCreature('Ossuary Pale', 'single', rng0);
    expect(c.footprint).toBe(1);
    expect(tm.categories).toContain(monsterByIndex(c.creatureIndex)!.category);
  });

  it('pack pick is also 1x1 and theme-valid', () => {
    const c = pickEncounterCreature('Emberforge', 'pack', rng0);
    expect(c.footprint).toBe(1);
    expect(THEME_MONSTERS['Emberforge'].categories)
      .toContain(monsterByIndex(c.creatureIndex)!.category);
  });

  it('boss pick is a 2x2 boss whose category is in the theme boss pool', () => {
    const tm = THEME_MONSTERS['Ossuary Pale'];
    const c = pickEncounterCreature('Ossuary Pale', 'boss', rng0);
    expect(c.footprint).toBe(2);
    const m = monsterByIndex(c.creatureIndex)!;
    expect(m.boss).toBe(true);
    expect(tm.bossCategories ?? tm.categories).toContain(m.category);
  });

  it('is deterministic for a fixed rng', () => {
    const seq = () => 0.42;
    expect(pickEncounterCreature('Cinderdeep', 'single', seq).creatureIndex)
      .toBe(pickEncounterCreature('Cinderdeep', 'single', seq).creatureIndex);
  });

  it('unknown theme falls back without throwing and returns a valid creature', () => {
    const c = pickEncounterCreature('legacy_stone_crypt', 'single', rng0);
    expect(c.footprint).toBe(1);
    expect(monsterByIndex(c.creatureIndex)).toBeDefined();
    expect(themeMonsters('legacy_stone_crypt').categories)
      .toContain(monsterByIndex(c.creatureIndex)!.category);
  });
});

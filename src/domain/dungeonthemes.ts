import type { MonsterCategory } from './bestiary';

export interface ThemeMonsters {
  categories: MonsterCategory[];        // regular/pack pool
  bossCategories?: MonsterCategory[];   // boss pool; defaults to `categories`
}

// One entry per usable dungeon in DUNGEONS (floorgroups). Category assignments
// are pragmatic-thematic; every bossCategories resolves to >=1 boss (tested).
export const THEME_MONSTERS: Record<string, ThemeMonsters> = {
  'Greystone Keep':    { categories: ['humanoid', 'beast', 'undead'],       bossCategories: ['undead'] },
  'Crimson Court':     { categories: ['humanoid', 'demon', 'undead'],       bossCategories: ['demon'] },
  'Mossmarch Hold':    { categories: ['beast', 'ooze', 'plant'],            bossCategories: ['giant'] },
  'Emberforge':        { categories: ['demon', 'elemental', 'construct'],   bossCategories: ['demon', 'dragon'] },
  'Oakenvault':        { categories: ['humanoid', 'beast', 'vermin'],       bossCategories: ['giant'] },
  'Verdant Crypt':     { categories: ['undead', 'plant', 'vermin'],         bossCategories: ['undead'] },
  'Tideglass Halls':   { categories: ['elemental', 'ooze', 'aberration'],   bossCategories: ['elemental'] },
  'Frostiron Bastion': { categories: ['elemental', 'undead', 'construct'],  bossCategories: ['construct'] },
  'Auric Deep':        { categories: ['construct', 'dragon', 'demon'],      bossCategories: ['dragon'] },
  'Rustpipe Sewers':   { categories: ['vermin', 'ooze', 'humanoid'],        bossCategories: ['giant'] },
  'Drowned Foundry':   { categories: ['construct', 'elemental', 'ooze'],    bossCategories: ['construct'] },
  'Duskstone Warren':  { categories: ['humanoid', 'beast', 'vermin'],       bossCategories: ['giant'] },
  'Thornwind Ruins':   { categories: ['plant', 'beast', 'elemental'],       bossCategories: ['plant'] },
  'Cinderdeep':        { categories: ['demon', 'elemental', 'dragon'],      bossCategories: ['dragon'] },
  'Wildroot Barrow':   { categories: ['plant', 'beast', 'undead'],          bossCategories: ['plant'] },
  'Ossuary Pale':      { categories: ['undead', 'construct'],               bossCategories: ['undead'] },
  'Glacierhold':       { categories: ['elemental', 'beast', 'giant'],       bossCategories: ['giant'] },
  'Bogstone Mire':     { categories: ['ooze', 'vermin', 'undead'],          bossCategories: ['giant'] },
  'Dunewatch':         { categories: ['undead', 'vermin', 'humanoid'],      bossCategories: ['undead'] },
  'Cobblemoor':        { categories: ['beast', 'humanoid', 'vermin'],       bossCategories: ['giant'] },
  'Bloodstone Cairn':  { categories: ['undead', 'demon'],                   bossCategories: ['demon'] },
};

export const FALLBACK_THEME: ThemeMonsters = {
  categories: ['beast', 'vermin', 'humanoid'],
  bossCategories: ['giant'],
};

export function themeMonsters(name: string): ThemeMonsters {
  return THEME_MONSTERS[name] ?? FALLBACK_THEME;
}

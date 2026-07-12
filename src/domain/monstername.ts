import { monsterName, type MonsterCategory } from './bestiary';

// Shared pool (applies to any creature) + category-flavored pools. The union
// gives >=15 adjectives per category for variety. Grow freely (BACKLOG #12).
const GENERAL = [
  'ancient', 'cursed', 'feral', 'vile', 'dread', 'savage',
  'wretched', 'grim', 'ravenous', 'baleful',
];

const BY_CATEGORY: Record<MonsterCategory, string[]> = {
  undead: ['rotting', 'spectral', 'grave-touched', 'undying', 'skeletal', 'ghoulish'],
  demon: ['hellish', 'infernal', 'sulfurous', 'damned', 'fiendish'],
  beast: ['rabid', 'snarling', 'wild', 'hulking', 'bristling'],
  vermin: ['swarming', 'venomous', 'diseased', 'skittering', 'plagued'],
  elemental: ['crackling', 'surging', 'volatile', 'primal', 'roiling'],
  dragon: ['elder', 'tyrant', 'apex', 'wingbound', 'scaled'],
  construct: ['runed', 'animated', 'tireless', 'forgebound', 'grinding'],
  giant: ['towering', 'colossal', 'brutish', 'mountainous', 'looming'],
  ooze: ['gelatinous', 'acidic', 'oozing', 'corrosive', 'viscous'],
  aberration: ['unblinking', 'maddening', 'warped', 'eldritch', 'otherworldly'],
  plant: ['thorned', 'overgrown', 'blighted', 'verdant', 'gnarled'],
  humanoid: ['rogue', 'outcast', 'marauding', 'renegade', 'bloodthirsty'],
};

// Deterministic 32-bit integer hash (no Math.random / Date.now).
function hash(n: number): number {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "<Adjective> <Creature>", stable for a given encounter id. */
export function monsterTitle(
  encounterId: number,
  index: number,
  category: MonsterCategory,
): string {
  const pool = GENERAL.concat(BY_CATEGORY[category] ?? []);
  const adj = pool[hash(encounterId) % pool.length];
  return `${cap(adj)} ${monsterName(index)}`;
}

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

// Pluralize one word by regular English rules — enough for the bestiary's head
// nouns (Mummy->Mummies, Wolf->Wolves, Witch->Witches, Skeleton->Skeletons).
function pluralWord(w: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  if (/fe$/i.test(w)) return `${w.slice(0, -2)}ves`;
  if (/f$/i.test(w)) return `${w.slice(0, -1)}ves`;
  return `${w}s`;
}

/** Pluralize a creature name by its head noun (the last word): "Grey Wolf" -> "Grey Wolves". */
export function pluralizeCreature(name: string): string {
  const i = name.lastIndexOf(' ');
  return name.slice(0, i + 1) + pluralWord(name.slice(i + 1));
}

/**
 * "<Adjective> <Creature>", stable for a given encounter id. When `plural` is set
 * (a pack of several mobs), the creature noun is pluralized: "Grim Mummies".
 */
export function monsterTitle(
  encounterId: number,
  index: number,
  category: MonsterCategory,
  plural = false,
): string {
  const pool = GENERAL.concat(BY_CATEGORY[category] ?? []);
  const adj = pool[hash(encounterId) % pool.length];
  const noun = plural ? pluralizeCreature(monsterName(index)) : monsterName(index);
  return `${cap(adj)} ${noun}`;
}

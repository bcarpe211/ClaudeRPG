export type EncounterKind = 'single' | 'pack' | 'boss';

export interface PickedCreature {
  creatureIndex: number;
  footprint: number; // 1 = 1x1, 2 = 2x2
}

// creature_key.doc indices. Ordered easiest -> hardest. All 1x1 regulars.
export const MONSTER_TIERS: number[][] = [
  [121, 122, 116, 117, 114, 115, 124], // rats, bats, slimes, beetle
  [20, 132, 133, 123, 119, 126],       // bandit, goblins, cobra, spider, wolf
  [137, 134, 153, 155, 151],           // orc, goblin captain, skeletons, zombie
  [140, 138, 85, 95, 158],             // troll, orc captain, lizardman, gnoll, mummy
  [144, 160, 163, 99, 156],            // death knight, necromancer, vampire, minotaur, shadow
  [105, 142, 184, 103, 147],           // stone golem, cyclops, ettin, fire demon, earth elemental
  [170, 172, 102, 162, 173],           // red/gold dragon, elder demon, Death, green dragon
];

// 2x2 bosses, ordered easiest -> hardest.
export const BOSSES: number[] = [
  99,  // Minotaur Axe
  140, // Troll
  105, // Stone Golem
  142, // Cyclops
  184, // Ettin
  103, // Fire Demon
  102, // Elder Demon
  170, // Red Dragon
  172, // Gold Dragon
  162, // Death
];

function pick<T>(arr: T[], rng: () => number): T {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}

/** Choose a creature for an encounter. dungeonLevel is 1-based. */
export function pickEncounterCreature(
  dungeonLevel: number,
  kind: EncounterKind,
  rng: () => number,
): PickedCreature {
  if (kind === 'boss') {
    const i = Math.min(dungeonLevel - 1, BOSSES.length - 1);
    return { creatureIndex: BOSSES[i], footprint: 2 };
  }
  const tierIndex = Math.min(dungeonLevel - 1, MONSTER_TIERS.length - 1);
  return { creatureIndex: pick(MONSTER_TIERS[tierIndex], rng), footprint: 1 };
}

import { nameForCreatureFile } from '../web/catalog/build';
import { CREATURE_SHEET_NAMES } from '../web/catalog/spritenames';

export type MonsterCategory =
  | 'undead' | 'demon' | 'beast' | 'vermin' | 'elemental'
  | 'dragon' | 'construct' | 'humanoid' | 'ooze' | 'giant'
  | 'aberration' | 'plant';

export type MonsterSize = 'S' | 'M' | 'L';

export interface Monster {
  index: number;          // frame-A file index in creatures_24x24 (== sprite file number)
  category: MonsterCategory;
  size: MonsterSize;      // selects the ground-shadow tile
  flying: boolean;        // raise sprite + keep shadow on the ground for a float
  boss: boolean;          // eligible to be a 2x2 boss
}

export const MONSTERS: Monster[] = [
  { index: 265, category: 'undead', size: 'M', flying: false, boss: false }, // Death Knight
  { index: 266, category: 'undead', size: 'M', flying: false, boss: false }, // Death Knight Alt
  { index: 267, category: 'undead', size: 'M', flying: false, boss: false }, // Death Knight Alt
  { index: 289, category: 'undead', size: 'M', flying: false, boss: false }, // Zombie
  { index: 290, category: 'undead', size: 'M', flying: false, boss: false }, // Headless Zombie
  { index: 291, category: 'undead', size: 'M', flying: false, boss: false }, // Skeleton
  { index: 292, category: 'undead', size: 'M', flying: false, boss: false }, // Skeleton Archer
  { index: 293, category: 'undead', size: 'M', flying: false, boss: false }, // Skeleton Warrior
  { index: 294, category: 'undead', size: 'M', flying: true, boss: false }, // Shadow
  { index: 295, category: 'undead', size: 'M', flying: true, boss: false }, // Ghost
  { index: 296, category: 'undead', size: 'M', flying: false, boss: false }, // Mummy
  { index: 297, category: 'undead', size: 'M', flying: false, boss: true }, // Pharoah
  { index: 298, category: 'undead', size: 'M', flying: false, boss: false }, // Necromancer
  { index: 299, category: 'undead', size: 'M', flying: false, boss: false }, // Dark Wizard
  { index: 300, category: 'undead', size: 'L', flying: true, boss: true }, // Death
  { index: 301, category: 'undead', size: 'M', flying: false, boss: false }, // Vampire
  { index: 302, category: 'undead', size: 'M', flying: false, boss: false }, // Vampire Alt
  { index: 303, category: 'undead', size: 'M', flying: false, boss: true }, // Vampire Lord
  { index: 371, category: 'undead', size: 'S', flying: true, boss: false }, // Red Specter
  { index: 372, category: 'undead', size: 'S', flying: true, boss: false }, // Blue Specter
  { index: 373, category: 'undead', size: 'S', flying: true, boss: false }, // Brown Specter
  { index: 188, category: 'demon', size: 'L', flying: false, boss: true }, // Elder Demon
  { index: 189, category: 'demon', size: 'L', flying: false, boss: true }, // Fire Demon
  { index: 190, category: 'demon', size: 'M', flying: false, boss: false }, // Horned Demon
  { index: 342, category: 'demon', size: 'S', flying: true, boss: false }, // Imp/Demon/Devil
  { index: 365, category: 'demon', size: 'S', flying: false, boss: false }, // Fire Minion
  { index: 367, category: 'demon', size: 'S', flying: true, boss: false }, // Smoke Minion
  { index: 185, category: 'beast', size: 'L', flying: false, boss: true }, // Minotaur Axe
  { index: 186, category: 'beast', size: 'L', flying: false, boss: false }, // Minotaur Club
  { index: 187, category: 'beast', size: 'L', flying: false, boss: false }, // Minotaur Alt
  { index: 226, category: 'beast', size: 'S', flying: false, boss: false }, // Cobra
  { index: 229, category: 'beast', size: 'M', flying: false, boss: false }, // Grey Wolf
  { index: 230, category: 'beast', size: 'M', flying: false, boss: false }, // Brown Wolf
  { index: 231, category: 'beast', size: 'M', flying: false, boss: false }, // Black Wolf
  { index: 329, category: 'beast', size: 'L', flying: false, boss: true }, // Yeti
  { index: 330, category: 'beast', size: 'L', flying: false, boss: false }, // Yeti Alt
  { index: 333, category: 'beast', size: 'M', flying: false, boss: false }, // Brown Bear
  { index: 334, category: 'beast', size: 'M', flying: false, boss: true }, // Grey Bear
  { index: 335, category: 'beast', size: 'L', flying: false, boss: true }, // Polar Bear
  { index: 219, category: 'vermin', size: 'S', flying: true, boss: false }, // Black Bat
  { index: 220, category: 'vermin', size: 'S', flying: true, boss: false }, // Red Bat
  { index: 222, category: 'vermin', size: 'S', flying: false, boss: false }, // Red Spider
  { index: 223, category: 'vermin', size: 'S', flying: false, boss: true }, // Black Spider
  { index: 224, category: 'vermin', size: 'S', flying: false, boss: false }, // Grey Rat
  { index: 225, category: 'vermin', size: 'S', flying: false, boss: false }, // Brown Rat
  { index: 227, category: 'vermin', size: 'S', flying: false, boss: false }, // Beetle
  { index: 228, category: 'vermin', size: 'S', flying: false, boss: false }, // Fire Beetle
  { index: 331, category: 'vermin', size: 'S', flying: false, boss: true }, // Giant Leech
  { index: 332, category: 'vermin', size: 'M', flying: false, boss: false }, // Giant Worm
  { index: 336, category: 'vermin', size: 'M', flying: false, boss: true }, // Giant Scorpion
  { index: 337, category: 'vermin', size: 'M', flying: false, boss: false }, // Scorpion Alt
  { index: 338, category: 'vermin', size: 'M', flying: false, boss: false }, // Scorpion Alt
  { index: 196, category: 'elemental', size: 'M', flying: true, boss: true }, // Djinn
  { index: 268, category: 'elemental', size: 'L', flying: false, boss: true }, // Earth Elemental
  { index: 269, category: 'elemental', size: 'M', flying: false, boss: false }, // Ice/Water Elemental
  { index: 270, category: 'elemental', size: 'M', flying: true, boss: false }, // Air Elemental
  { index: 361, category: 'elemental', size: 'S', flying: true, boss: false }, // Wisp
  { index: 362, category: 'elemental', size: 'S', flying: true, boss: false }, // Wisp Alt
  { index: 366, category: 'elemental', size: 'S', flying: false, boss: false }, // Ice Minion
  { index: 368, category: 'elemental', size: 'S', flying: false, boss: false }, // Mud Minion
  { index: 377, category: 'elemental', size: 'S', flying: true, boss: false }, // Flame
  { index: 378, category: 'elemental', size: 'S', flying: true, boss: false }, // Cold Flame
  { index: 325, category: 'dragon', size: 'L', flying: false, boss: true }, // Red Dragon
  { index: 326, category: 'dragon', size: 'L', flying: false, boss: true }, // Purple Dragon
  { index: 327, category: 'dragon', size: 'L', flying: false, boss: true }, // Gold Dragon
  { index: 328, category: 'dragon', size: 'L', flying: false, boss: true }, // Green Dragon
  { index: 191, category: 'construct', size: 'L', flying: false, boss: true }, // Stone Golem
  { index: 192, category: 'construct', size: 'L', flying: false, boss: false }, // Mud Golem
  { index: 193, category: 'construct', size: 'L', flying: false, boss: false }, // Flesh Golem
  { index: 194, category: 'construct', size: 'L', flying: false, boss: true }, // Lava Golem
  { index: 195, category: 'construct', size: 'L', flying: false, boss: true }, // Bone Golem
  { index: 198, category: 'construct', size: 'M', flying: false, boss: true }, // Mimic
  { index: 261, category: 'giant', size: 'L', flying: false, boss: true }, // Troll
  { index: 262, category: 'giant', size: 'L', flying: false, boss: false }, // Troll Captain
  { index: 263, category: 'giant', size: 'L', flying: false, boss: true }, // Cycops
  { index: 264, category: 'giant', size: 'L', flying: false, boss: false }, // Cyclops Alt
  { index: 339, category: 'giant', size: 'L', flying: false, boss: true }, // Ettin
  { index: 340, category: 'giant', size: 'L', flying: false, boss: false }, // Ettin Alt
  { index: 217, category: 'ooze', size: 'S', flying: false, boss: false }, // Purple Slime
  { index: 218, category: 'ooze', size: 'S', flying: false, boss: false }, // Green Slime
  { index: 374, category: 'ooze', size: 'M', flying: false, boss: true }, // Blue Jelly
  { index: 375, category: 'ooze', size: 'M', flying: false, boss: true }, // Green Jelly
  { index: 376, category: 'ooze', size: 'M', flying: false, boss: true }, // Red Jelly
  { index: 221, category: 'aberration', size: 'M', flying: true, boss: true }, // Beholder
  { index: 369, category: 'aberration', size: 'S', flying: true, boss: false }, // Eye
  { index: 370, category: 'aberration', size: 'S', flying: true, boss: false }, // Eyes
  { index: 197, category: 'plant', size: 'L', flying: false, boss: true }, // Treant
  { index: 341, category: 'plant', size: 'S', flying: true, boss: false }, // Pixie/Fairy/Sprite
  { index: 363, category: 'plant', size: 'S', flying: false, boss: false }, // Turnip
  { index: 364, category: 'plant', size: 'S', flying: false, boss: false }, // Rotten Turnip
  { index: 109, category: 'humanoid', size: 'M', flying: false, boss: false }, // Assassin
  { index: 110, category: 'humanoid', size: 'M', flying: false, boss: false }, // Bandit
  { index: 114, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Assassin
  { index: 115, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Fighter
  { index: 116, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Ranger
  { index: 117, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Mage
  { index: 118, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Sorceress
  { index: 153, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Warrior
  { index: 154, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Archer
  { index: 155, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Captain
  { index: 156, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Shaman
  { index: 157, category: 'humanoid', size: 'M', flying: false, boss: true }, // Lizardman High Shaman
  { index: 181, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Fighter
  { index: 182, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Fighter Alt
  { index: 183, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Fighter Captain
  { index: 184, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Shaman
  { index: 253, category: 'humanoid', size: 'S', flying: false, boss: false }, // Goblin Fighter
  { index: 254, category: 'humanoid', size: 'S', flying: false, boss: false }, // Goblin Archer
  { index: 255, category: 'humanoid', size: 'M', flying: false, boss: true }, // Goblin Captain
  { index: 256, category: 'humanoid', size: 'M', flying: false, boss: true }, // Goblin King
  { index: 257, category: 'humanoid', size: 'S', flying: false, boss: false }, // Goblin Mystic
  { index: 258, category: 'humanoid', size: 'M', flying: false, boss: false }, // Orc Fighter
  { index: 259, category: 'humanoid', size: 'M', flying: false, boss: true }, // Orc Captain
  { index: 260, category: 'humanoid', size: 'M', flying: false, boss: false }, // Orc Mystic
  { index: 304, category: 'humanoid', size: 'M', flying: false, boss: false }, // Witch
  { index: 305, category: 'humanoid', size: 'M', flying: false, boss: true }, // Frost Witch
  { index: 306, category: 'humanoid', size: 'M', flying: false, boss: false }, // Green Witch
];

const BY_INDEX = new Map<number, Monster>(MONSTERS.map((m) => [m.index, m]));

export function monsterByIndex(index: number): Monster | undefined {
  return BY_INDEX.get(index);
}

/** Clean singular display name from the doc, or 'Monster' for an unknown index. */
export function monsterName(index: number): string {
  return nameForCreatureFile(index, CREATURE_SHEET_NAMES) ?? 'Monster';
}

export function monstersFor(cats: MonsterCategory[]): Monster[] {
  const set = new Set(cats);
  return MONSTERS.filter((m) => set.has(m.category));
}

export function bossesFor(cats: MonsterCategory[]): Monster[] {
  const set = new Set(cats);
  return MONSTERS.filter((m) => m.boss && set.has(m.category));
}

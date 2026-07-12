import { monstersFor, bossesFor } from './bestiary';
import { themeMonsters, FALLBACK_THEME } from './dungeonthemes';

export type EncounterKind = 'single' | 'pack' | 'boss';

export interface PickedCreature {
  creatureIndex: number;
  footprint: number; // 1 = 1x1, 2 = 2x2
}

function pick<T>(arr: T[], rng: () => number): T {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}

/** Choose a creature for an encounter, gated by the dungeon theme. */
export function pickEncounterCreature(
  theme: string,
  kind: EncounterKind,
  rng: () => number,
): PickedCreature {
  const tm = themeMonsters(theme);
  if (kind === 'boss') {
    const pool = bossesFor(tm.bossCategories ?? tm.categories);
    const m = pick(pool.length ? pool : bossesFor(FALLBACK_THEME.bossCategories!), rng);
    return { creatureIndex: m.index, footprint: 2 };
  }
  const pool = monstersFor(tm.categories);
  const m = pick(pool.length ? pool : monstersFor(FALLBACK_THEME.categories), rng);
  return { creatureIndex: m.index, footprint: 1 };
}

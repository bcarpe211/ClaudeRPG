export type Gender = 'M' | 'F';

export interface ClassDef {
  key: string;
  name: string;
  /** creature_key.doc index for the Male variant; Female = maleIndex + 9 */
  maleIndex: number;
}

// Order matches creature_key.doc indices 1..9 (Male) / 10..18 (Female).
export const CLASSES: ClassDef[] = [
  { key: 'knight', name: 'Knight', maleIndex: 1 },
  { key: 'thief', name: 'Thief', maleIndex: 2 },
  { key: 'ranger', name: 'Ranger', maleIndex: 3 },
  { key: 'wizard', name: 'Wizard', maleIndex: 4 },
  { key: 'priest', name: 'Priest', maleIndex: 5 },
  { key: 'shaman', name: 'Shaman', maleIndex: 6 },
  { key: 'berserker', name: 'Berserker', maleIndex: 7 },
  { key: 'swordsman', name: 'Swordsman', maleIndex: 8 },
  { key: 'paladin', name: 'Paladin', maleIndex: 9 },
];

export function getClass(key: string): ClassDef | undefined {
  return CLASSES.find((c) => c.key === key);
}

export function spriteIndexFor(key: string, gender: Gender): number {
  const def = getClass(key);
  if (!def) throw new Error(`Unknown class key: ${key}`);
  return gender === 'M' ? def.maleIndex : def.maleIndex + 9;
}

export function creatureSpriteFile(index: number): string {
  const padded = String(index).padStart(2, '0');
  return `oryx_16bit_fantasy_creatures_${padded}.png`;
}

/** Relative URL under the /sprites static mount. */
export function classSpriteUrl(key: string, gender: Gender): string {
  return `/sprites/creatures_24x24/${creatureSpriteFile(
    spriteIndexFor(key, gender),
  )}`;
}

import type Database from 'better-sqlite3';
import { spriteIndexFor, classSpriteUrl, type Gender } from './classes';

/** Which palette colors are the recolorable clothing ramp, per class. Hand-authored + verified. */
export const CLOTHING: Record<string, { dominant: string[]; secondary?: string[]; weapon?: string[] }> = {
  knight: { dominant: ['#3cbcfc', '#9adcfd', '#2985b2'] },
  thief: { dominant: ['#1eba4a', '#24e35a'] },
  ranger: { dominant: ['#476575', '#7c94a4'] },
  wizard: { dominant: ['#cf3232', '#ff3d3d'] },
  priest: { dominant: ['#cf3232'] },
  shaman: { dominant: ['#887000', '#b89600'] },
  berserker: { dominant: ['#887000', '#b89600'] },
  swordsman: { dominant: ['#0e7cb3', '#b86e28'] },
  paladin: { dominant: ['#0e7cb3'] },
};

export function spriteId(classKey: string, gender: Gender): string {
  return `${classKey}_${gender}`;
}
export function spriteFileIndex(classKey: string, gender: Gender, frame: 'a' | 'b'): number {
  const base = spriteIndexFor(classKey, gender);
  return frame === 'b' ? base + 18 : base;
}

export interface CosmeticState { wheel_tier: number; primary_hue: number | null }

export function getCosmetics(db: Database.Database, playerId: number): CosmeticState | undefined {
  return db.prepare('SELECT wheel_tier, primary_hue FROM player_cosmetics WHERE player_id = ?')
    .get(playerId) as CosmeticState | undefined;
}

/** Sprite URL for a character on any surface: tinted if a hue is set, else the plain class sprite. */
export function cosmeticSpriteUrl(
  classKey: string, gender: Gender, cos: CosmeticState | undefined, frame: 'a' | 'b' = 'a',
): string {
  if (cos && cos.primary_hue != null)
    return `/sprite/tint/${spriteId(classKey, gender)}/${frame}/${cos.primary_hue}.png`;
  return classSpriteUrl(classKey, gender);
}

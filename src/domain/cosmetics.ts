import type Database from 'better-sqlite3';
import { spriteIndexFor, classSpriteUrl, type Gender } from './classes';

/** Which palette colors are the recolorable clothing ramp, per class. Hand-authored + verified.
 *  `op` selects the recolor operation for the dominant ramp: 'hue' (chromatic, default) or
 *  'colorize' (achromatic — white/grey garments, keeps shading via injected saturation). */
export interface ClothingRule {
  dominant: string[];
  op?: 'hue' | 'colorize';
  sat?: number;
  secondary?: string[];
  weapon?: string[];
}
export const CLOTHING: Record<string, ClothingRule> = {
  knight: { dominant: ['#3cbcfc', '#9adcfd', '#2985b2'] },
  thief: { dominant: ['#1eba4a', '#24e35a'] },
  ranger: { dominant: ['#476575', '#7c94a4'] },
  wizard: { dominant: ['#cf3232', '#ff3d3d'] },
  priest: { dominant: ['#c9c9c9', '#f3f3f3', '#919191'], op: 'colorize', sat: 0.6 }, // white robe
  shaman: { dominant: ['#887000', '#b89600'] },
  berserker: { dominant: ['#887000', '#b89600'] }, // body/tunic (hue) — color the body, not the helm; helm + cape are Phase-2 slots (cape shares the body olive for now)
  swordsman: { dominant: ['#0e7cb3'] },
  paladin: { dominant: ['#b4c21d'] }, // yellow-green helmet + shirt garment (hue); white wings = headgear, olive = boots, shield left alone
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

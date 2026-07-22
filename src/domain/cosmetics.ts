import { spriteIndexFor, type Gender } from './classes';

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

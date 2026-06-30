import { describe, it, expect } from 'vitest';
import { buildCatalog, spriteIndex } from '../src/web/catalog/build';
import type { ThemeTiles } from '../src/domain/tilemanifest';

const themes: Record<string, ThemeTiles> = {
  stone_crypt: {
    wall: 'oryx_16bit_fantasy_world_70.png',
    wallVariants: ['oryx_16bit_fantasy_world_71.png'],
    floor: 'oryx_16bit_fantasy_world_59.png',
    floorVariants: ['oryx_16bit_fantasy_world_60.png'],
    door: 'oryx_16bit_fantasy_world_208.png',
    decor: ['oryx_16bit_fantasy_world_94.png'],
  },
};

function run() {
  return buildCatalog({
    creatureFiles: [
      'oryx_16bit_fantasy_creatures_01.png', // class avatar Knight M
      'oryx_16bit_fantasy_creatures_19.png', // Bandit: tier 1 + boss (fake)
      'oryx_16bit_fantasy_creatures_50.png', // unused
    ],
    worldFiles: [
      'oryx_16bit_fantasy_world_70.png',  // stone_crypt.wall
      'oryx_16bit_fantasy_world_71.png',  // stone_crypt.wallVariant
      'oryx_16bit_fantasy_world_59.png',  // stone_crypt.floor
      'oryx_16bit_fantasy_world_60.png',  // stone_crypt.floorVariant
      'oryx_16bit_fantasy_world_208.png', // stone_crypt.door
      'oryx_16bit_fantasy_world_94.png',  // stone_crypt.decor
      'oryx_16bit_fantasy_world_999.png', // unused
    ],
    classSheetFiles: ['oryx_16bit_fantasy_classes_trans_03.png'],
    creatureNames: ['Knight M', ...Array(17).fill('x'), 'Bandit'], // [18] -> idx 19
    tiers: [[19]],
    bosses: [19],
    classAvatars: [{ name: 'Knight M', index: 1 }],
    themes,
  });
}

describe('spriteIndex', () => {
  it('parses the trailing number', () => {
    expect(spriteIndex('oryx_16bit_fantasy_creatures_01.png')).toBe(1);
    expect(spriteIndex('oryx_16bit_fantasy_world_1142.png')).toBe(1142);
  });

  it('returns NaN for a non-sprite filename', () => {
    expect(Number.isNaN(spriteIndex('not-a-sprite.txt'))).toBe(true);
  });
});

describe('buildCatalog', () => {
  it('annotates class avatars, tiers+boss, unused; aligns names', () => {
    const v = run();
    const c1 = v.creatures.find((c) => c.index === 1)!;
    expect(c1.annotation).toEqual(['class: Knight M']);
    expect(c1.name).toBe('Knight M');

    const c19 = v.creatures.find((c) => c.index === 19)!;
    expect(c19.annotation).toEqual(['tier 1', 'boss']);
    expect(c19.name).toBe('Bandit');

    const c50 = v.creatures.find((c) => c.index === 50)!;
    expect(c50.annotation).toEqual(['unused']);
    expect(c50.name).toBe(null);
  });

  it('annotates every world tile role and unused', () => {
    const v = run();
    const role = (i: number) => v.worldTiles.find((t) => t.index === i)!.annotation;
    expect(role(70)).toEqual(['stone_crypt.wall']);
    expect(role(71)).toEqual(['stone_crypt.wallVariant']);
    expect(role(59)).toEqual(['stone_crypt.floor']);
    expect(role(60)).toEqual(['stone_crypt.floorVariant']);
    expect(role(208)).toEqual(['stone_crypt.door']);
    expect(role(94)).toEqual(['stone_crypt.decor']);
    expect(role(999)).toEqual(['unused']);
  });

  it('marks the class sheet as candidate art', () => {
    const v = run();
    expect(v.classSheet[0].annotation).toEqual(['unused — candidate class art (#2)']);
    expect(v.counts.classSheet).toBe(1);
  });
});

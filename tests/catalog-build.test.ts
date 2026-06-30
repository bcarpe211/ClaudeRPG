import { describe, it, expect } from 'vitest';
import { buildCatalog, spriteIndex, nameForCreatureFile } from '../src/web/catalog/build';
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

function names37(): string[] {
  const n = Array(37).fill('x');
  n[0] = 'Knight M';
  n[17] = 'Paladin F';
  n[18] = 'Bandit';     // file 37 -> names[37-19]=names[18]
  n[36] = 'Bandit B';   // file 55 -> names[55-19]=names[36]
  return n;
}

function run() {
  return buildCatalog({
    creatureFiles: [
      'oryx_16bit_fantasy_creatures_01.png', // frame A (class Knight M); partner 19
      'oryx_16bit_fantasy_creatures_19.png', // frame B of #1
      'oryx_16bit_fantasy_creatures_37.png', // frame A (Bandit); partner 55
      'oryx_16bit_fantasy_creatures_55.png', // frame B of #37
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
    creatureNames: names37(),
    tiers: [[37]],
    bosses: [37],
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

describe('nameForCreatureFile (Model B)', () => {
  const names = (() => {
    const n = Array(200).fill('x');
    n[0] = 'Knight M'; n[17] = 'Paladin F'; n[18] = 'Bandit'; n[36] = 'Bandit B'; n[197] = 'Last';
    return n;
  })();
  it('maps classes and +18-shifted creatures, nulls the gaps', () => {
    expect(nameForCreatureFile(1, names)).toBe('Knight M');
    expect(nameForCreatureFile(18, names)).toBe('Paladin F');
    expect(nameForCreatureFile(19, names)).toBe(null); // class B-frame gap
    expect(nameForCreatureFile(36, names)).toBe(null);
    expect(nameForCreatureFile(37, names)).toBe('Bandit');
    expect(nameForCreatureFile(55, names)).toBe('Bandit B');
    expect(nameForCreatureFile(216, names)).toBe('Last'); // 216-19 = 197
    expect(nameForCreatureFile(217, names)).toBe(null);
  });
});

describe('buildCatalog creaturePairs', () => {
  it('one pair per frame-A file, +18 partner, both names, A-frame annotation', () => {
    const v = run();
    expect(v.creaturePairs.length).toBe(2);
    expect(v.counts.creaturePairs).toBe(2);

    const p1 = v.creaturePairs.find((p) => p.aIndex === 1)!;
    expect(p1.bIndex).toBe(19);
    expect(p1.aFile).toBe('oryx_16bit_fantasy_creatures_01.png');
    expect(p1.bFile).toBe('oryx_16bit_fantasy_creatures_19.png');
    expect(p1.aName).toBe('Knight M');
    expect(p1.bName).toBe(null);
    expect(p1.annotation).toEqual(['class: Knight M']);

    const p37 = v.creaturePairs.find((p) => p.aIndex === 37)!;
    expect(p37.bIndex).toBe(55);
    expect(p37.aName).toBe('Bandit');
    expect(p37.bName).toBe('Bandit B');
    expect(p37.annotation).toEqual(['tier 1', 'boss']);
  });
});

describe('buildCatalog world tiles + class sheet (unchanged)', () => {
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

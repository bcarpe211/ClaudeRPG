import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  creatureSpriteFile,
  type Gender,
} from '../src/domain/classes';
import { spriteFileIndex } from '../src/domain/cosmetics';
import {
  loadSlotmapFresh,
  SLOTS,
  type SpriteFrame,
} from '../src/domain/slots';

interface Position {
  x: number;
  y: number;
}

interface CollisionFixture {
  name: string;
  classKey: 'wizard' | 'shaman' | 'berserker' | 'paladin';
  slot: number;
  positions: Record<SpriteFrame, Position>;
  sourceHex: string | { M: string; F: string };
}

const SPRITES_DIR = path.resolve(
  'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24',
);

// These are hand-inspected semantic coordinates, not source-color searches.
// The source RGB assertion keeps each fixture attached to the intended art.
const FIXTURES: readonly CollisionFixture[] = [
  {
    name: 'wizard left eye',
    classKey: 'wizard',
    slot: SLOTS.flair,
    positions: { a: { x: 9, y: 9 }, b: { x: 9, y: 10 } },
    sourceHex: '#cf3232',
  },
  {
    name: 'wizard right eye',
    classKey: 'wizard',
    slot: SLOTS.flair,
    positions: { a: { x: 12, y: 9 }, b: { x: 12, y: 10 } },
    sourceHex: '#cf3232',
  },
  {
    name: 'wizard staff',
    classKey: 'wizard',
    slot: SLOTS.weapon,
    positions: { a: { x: 3, y: 4 }, b: { x: 3, y: 5 } },
    sourceHex: '#887000',
  },
  {
    name: 'wizard fixed hood pixel between the eyes',
    classKey: 'wizard',
    slot: SLOTS.outline,
    positions: { a: { x: 10, y: 9 }, b: { x: 10, y: 10 } },
    sourceHex: '#262626',
  },
  {
    name: 'shaman staff',
    classKey: 'shaman',
    slot: SLOTS.weapon,
    positions: { a: { x: 3, y: 8 }, b: { x: 3, y: 9 } },
    sourceHex: '#b89600',
  },
  {
    name: 'shaman fixed staff outline',
    classKey: 'shaman',
    slot: SLOTS.outline,
    positions: { a: { x: 4, y: 8 }, b: { x: 4, y: 9 } },
    sourceHex: '#262626',
  },
  {
    name: 'berserker tunic',
    classKey: 'berserker',
    slot: SLOTS.body,
    positions: { a: { x: 11, y: 16 }, b: { x: 11, y: 17 } },
    sourceHex: '#887000',
  },
  {
    name: 'berserker helmet',
    classKey: 'berserker',
    slot: SLOTS.headgear,
    positions: { a: { x: 13, y: 4 }, b: { x: 13, y: 5 } },
    sourceHex: { M: '#616060', F: '#ff3d3d' },
  },
  {
    name: 'berserker cape',
    classKey: 'berserker',
    slot: SLOTS.cape,
    positions: { a: { x: 18, y: 18 }, b: { x: 18, y: 19 } },
    sourceHex: '#b89600',
  },
  {
    name: 'berserker axe blade',
    classKey: 'berserker',
    slot: SLOTS.weapon,
    positions: { a: { x: 2, y: 9 }, b: { x: 2, y: 10 } },
    sourceHex: '#919191',
  },
  {
    name: 'berserker left horn',
    classKey: 'berserker',
    slot: SLOTS.flair,
    positions: { a: { x: 5, y: 4 }, b: { x: 5, y: 5 } },
    sourceHex: '#c9c9c9',
  },
  {
    name: 'berserker right horn',
    classKey: 'berserker',
    slot: SLOTS.flair,
    positions: { a: { x: 21, y: 4 }, b: { x: 21, y: 5 } },
    sourceHex: '#c9c9c9',
  },
  {
    name: 'berserker fixed pixel beside the left horn',
    classKey: 'berserker',
    slot: SLOTS.outline,
    positions: { a: { x: 6, y: 4 }, b: { x: 6, y: 5 } },
    sourceHex: '#262626',
  },
  {
    name: 'berserker boots',
    classKey: 'berserker',
    slot: SLOTS.boots,
    positions: { a: { x: 8, y: 22 }, b: { x: 8, y: 22 } },
    sourceHex: '#696969',
  },
  {
    name: 'paladin body helmet',
    classKey: 'paladin',
    slot: SLOTS.body,
    positions: { a: { x: 11, y: 3 }, b: { x: 11, y: 4 } },
    sourceHex: '#b4c21d',
  },
  {
    name: 'paladin body shirt',
    classKey: 'paladin',
    slot: SLOTS.body,
    positions: { a: { x: 9, y: 16 }, b: { x: 9, y: 17 } },
    sourceHex: '#b4c21d',
  },
  {
    name: 'paladin front panel',
    classKey: 'paladin',
    slot: SLOTS.trim,
    positions: { a: { x: 9, y: 19 }, b: { x: 9, y: 20 } },
    sourceHex: '#f3f3f3',
  },
  {
    name: 'paladin weapon',
    classKey: 'paladin',
    slot: SLOTS.weapon,
    positions: { a: { x: 2, y: 7 }, b: { x: 2, y: 8 } },
    sourceHex: '#919191',
  },
  {
    name: 'paladin shield field',
    classKey: 'paladin',
    slot: SLOTS.shield,
    positions: { a: { x: 15, y: 16 }, b: { x: 15, y: 17 } },
    sourceHex: { M: '#0e7cb3', F: '#cf3232' },
  },
  {
    name: 'paladin white shield cross',
    classKey: 'paladin',
    slot: SLOTS.shield,
    positions: { a: { x: 16, y: 15 }, b: { x: 16, y: 16 } },
    sourceHex: '#ffffff',
  },
  {
    name: 'paladin olive boots',
    classKey: 'paladin',
    slot: SLOTS.boots,
    positions: { a: { x: 7, y: 22 }, b: { x: 7, y: 22 } },
    sourceHex: '#b89600',
  },
  {
    name: 'paladin white wing',
    classKey: 'paladin',
    slot: SLOTS.flair,
    positions: { a: { x: 20, y: 7 }, b: { x: 20, y: 8 } },
    sourceHex: '#f3f3f3',
  },
  {
    name: 'paladin fixed outline below the wing',
    classKey: 'paladin',
    slot: SLOTS.outline,
    positions: { a: { x: 18, y: 10 }, b: { x: 18, y: 11 } },
    sourceHex: '#262626',
  },
];

function sourceAt(
  classKey: string,
  gender: Gender,
  frame: SpriteFrame,
  { x, y }: Position,
): { hex: string; alpha: number } {
  const file = path.join(
    SPRITES_DIR,
    creatureSpriteFile(spriteFileIndex(classKey, gender, frame)),
  );
  const png = PNG.sync.read(readFileSync(file));
  const offset = (y * png.width + x) * 4;
  return {
    hex: `#${Buffer.from(png.data.slice(offset, offset + 3)).toString('hex')}`,
    alpha: png.data[offset + 3],
  };
}

describe('position-specific slot-map collision regressions', () => {
  for (const gender of ['M', 'F'] as const) {
    for (const frame of ['a', 'b'] as const) {
      for (const fixture of FIXTURES) {
        it(`${fixture.classKey}_${gender}_${frame}: ${fixture.name}`, () => {
          const position = fixture.positions[frame];
          const expectedHex = typeof fixture.sourceHex === 'string'
            ? fixture.sourceHex
            : fixture.sourceHex[gender];
          const source = sourceAt(fixture.classKey, gender, frame, position);
          const map = loadSlotmapFresh(`${fixture.classKey}_${gender}`, frame);

          expect(source).toEqual({ hex: expectedHex, alpha: 255 });
          expect(map, 'slot map must exist').not.toBeNull();
          expect(map?.[position.y * 24 + position.x]).toBe(fixture.slot);
          if (
            (fixture.classKey === 'wizard' && fixture.name.includes('eye'))
            || (fixture.classKey === 'shaman' && fixture.name === 'shaman staff')
          ) {
            expect(map?.[position.y * 24 + position.x]).not.toBe(SLOTS.body);
          }
        });
      }
    }
  }
});

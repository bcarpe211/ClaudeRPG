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
  classKey: 'knight' | 'thief' | 'ranger' | 'wizard' | 'priest'
    | 'shaman' | 'berserker' | 'paladin';
  slot: number | { M: number; F: number };
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
    name: 'knight detached helmet highlight beside the sword',
    classKey: 'knight',
    slot: SLOTS.headgear,
    positions: { a: { x: 6, y: 5 }, b: { x: 6, y: 6 } },
    sourceHex: '#c9c9c9',
  },
  {
    name: 'knight grey collar under the face',
    classKey: 'knight',
    slot: SLOTS.body,
    positions: { a: { x: 9, y: 15 }, b: { x: 9, y: 16 } },
    sourceHex: '#c9c9c9',
  },
  {
    name: 'knight plume',
    classKey: 'knight',
    slot: SLOTS.flair,
    positions: { a: { x: 17, y: 3 }, b: { x: 17, y: 4 } },
    sourceHex: { M: '#887000', F: '#cdd199' },
  },
  {
    name: 'knight cape at the left shoulder',
    classKey: 'knight',
    slot: SLOTS.cape,
    positions: { a: { x: 6, y: 12 }, b: { x: 6, y: 13 } },
    sourceHex: '#887000',
  },
  {
    name: 'knight cape at the left shoulder lower pixel',
    classKey: 'knight',
    slot: SLOTS.cape,
    positions: { a: { x: 7, y: 13 }, b: { x: 7, y: 14 } },
    sourceHex: '#887000',
  },
  {
    name: 'knight cape tip beside the right boot',
    classKey: 'knight',
    slot: SLOTS.cape,
    positions: { a: { x: 19, y: 22 }, b: { x: 19, y: 22 } },
    sourceHex: '#887000',
  },
  {
    name: 'knight outer helmet streak',
    classKey: 'knight',
    slot: SLOTS.headgear,
    positions: { a: { x: 10, y: 2 }, b: { x: 10, y: 3 } },
    sourceHex: { M: '#c9c9c9', F: '#ff3d3d' },
  },
  {
    name: 'knight inner helmet streak',
    classKey: 'knight',
    slot: SLOTS.headgear,
    positions: { a: { x: 11, y: 6 }, b: { x: 11, y: 7 } },
    sourceHex: '#f3f3f3',
  },
  {
    name: 'knight lower garment',
    classKey: 'knight',
    slot: SLOTS.body,
    positions: { a: { x: 9, y: 19 }, b: { x: 9, y: 20 } },
    sourceHex: { M: '#3cbcfc', F: '#cf3232' },
  },
  {
    name: 'knight female first hair pixel replaces male helmet',
    classKey: 'knight',
    slot: { M: SLOTS.headgear, F: SLOTS.hair },
    positions: { a: { x: 6, y: 7 }, b: { x: 6, y: 8 } },
    sourceHex: { M: '#2985b2', F: '#eaff00' },
  },
  {
    name: 'knight female second hair pixel replaces male outline',
    classKey: 'knight',
    slot: { M: SLOTS.outline, F: SLOTS.hair },
    positions: { a: { x: 7, y: 7 }, b: { x: 7, y: 8 } },
    sourceHex: { M: '#262626', F: '#eaff00' },
  },
  {
    name: 'thief top-right headgear below the feather',
    classKey: 'thief',
    slot: SLOTS.headgear,
    positions: { a: { x: 18, y: 9 }, b: { x: 18, y: 10 } },
    sourceHex: { M: '#1eba4a', F: '#32ae93' },
  },
  {
    name: 'thief feather stays separate from the split headgear',
    classKey: 'thief',
    slot: SLOTS.flair,
    positions: { a: { x: 18, y: 5 }, b: { x: 18, y: 6 } },
    sourceHex: '#cf3232',
  },
  {
    name: 'thief cape under the neck',
    classKey: 'thief',
    slot: SLOTS.cape,
    positions: { a: { x: 6, y: 12 }, b: { x: 6, y: 13 } },
    sourceHex: { M: '#1eba4a', F: '#32ae93' },
  },
  {
    name: 'thief cape at the right side',
    classKey: 'thief',
    slot: SLOTS.cape,
    positions: { a: { x: 18, y: 18 }, b: { x: 18, y: 19 } },
    sourceHex: { M: '#1eba4a', F: '#32ae93' },
  },
  {
    name: 'thief brown tunic',
    classKey: 'thief',
    slot: SLOTS.body,
    positions: { a: { x: 8, y: 16 }, b: { x: 8, y: 17 } },
    sourceHex: '#887000',
  },
  {
    name: 'thief black belt',
    classKey: 'thief',
    slot: SLOTS.trim,
    positions: { a: { x: 9, y: 17 }, b: { x: 9, y: 18 } },
    sourceHex: '#3d3d3d',
  },
  {
    name: 'thief hand-held dagger hilt',
    classKey: 'thief',
    slot: SLOTS.weapon,
    positions: { a: { x: 3, y: 17 }, b: { x: 3, y: 18 } },
    sourceHex: '#887000',
  },
  {
    name: 'thief dark back accessory',
    classKey: 'thief',
    slot: SLOTS.shield,
    positions: { a: { x: 20, y: 10 }, b: { x: 20, y: 11 } },
    sourceHex: '#887000',
  },
  {
    name: 'thief bright back accessory',
    classKey: 'thief',
    slot: SLOTS.shield,
    positions: { a: { x: 20, y: 9 }, b: { x: 20, y: 10 } },
    sourceHex: '#b89600',
  },
  {
    name: 'thief face shadow',
    classKey: 'thief',
    slot: SLOTS.skin,
    positions: { a: { x: 10, y: 8 }, b: { x: 10, y: 9 } },
    sourceHex: '#b86e28',
  },
  {
    name: 'thief female first hair pixel replaces male face shadow',
    classKey: 'thief',
    slot: { M: SLOTS.skin, F: SLOTS.hair },
    positions: { a: { x: 8, y: 7 }, b: { x: 8, y: 8 } },
    sourceHex: { M: '#b86e28', F: '#eaff00' },
  },
  {
    name: 'thief female second hair pixel replaces male face shadow',
    classKey: 'thief',
    slot: { M: SLOTS.skin, F: SLOTS.hair },
    positions: { a: { x: 9, y: 7 }, b: { x: 9, y: 8 } },
    sourceHex: { M: '#b86e28', F: '#eaff00' },
  },
  {
    name: 'ranger hat remains separate from the cloak',
    classKey: 'ranger',
    slot: SLOTS.headgear,
    positions: { a: { x: 11, y: 3 }, b: { x: 11, y: 3 } },
    sourceHex: { M: '#476575', F: '#b86e28' },
  },
  {
    name: 'ranger feather above the cloak',
    classKey: 'ranger',
    slot: SLOTS.flair,
    positions: { a: { x: 18, y: 5 }, b: { x: 18, y: 6 } },
    sourceHex: '#f3f3f3',
  },
  {
    name: 'ranger quiver fletching',
    classKey: 'ranger',
    slot: SLOTS.shield,
    positions: { a: { x: 20, y: 8 }, b: { x: 20, y: 8 } },
    sourceHex: '#ff0000',
  },
  {
    name: 'ranger quiver body',
    classKey: 'ranger',
    slot: SLOTS.shield,
    positions: { a: { x: 20, y: 12 }, b: { x: 20, y: 13 } },
    sourceHex: '#887000',
  },
  {
    name: 'ranger belt',
    classKey: 'ranger',
    slot: SLOTS.trim,
    positions: { a: { x: 12, y: 17 }, b: { x: 13, y: 17 } },
    sourceHex: '#887000',
  },
  {
    name: 'ranger cloak field at the back',
    classKey: 'ranger',
    slot: SLOTS.cape,
    positions: { a: { x: 19, y: 19 }, b: { x: 19, y: 20 } },
    sourceHex: { M: '#476575', F: '#b86e28' },
  },
  {
    name: 'ranger gold cloak edging',
    classKey: 'ranger',
    slot: SLOTS.cape,
    positions: { a: { x: 8, y: 5 }, b: { x: 8, y: 5 } },
    sourceHex: '#eaff00',
  },
  {
    name: 'ranger shadowed face',
    classKey: 'ranger',
    slot: SLOTS.skin,
    positions: { a: { x: 12, y: 9 }, b: { x: 12, y: 9 } },
    sourceHex: '#887000',
  },
  {
    name: 'wizard cloak field',
    classKey: 'wizard',
    slot: SLOTS.headgear,
    positions: { a: { x: 14, y: 2 }, b: { x: 14, y: 3 } },
    sourceHex: { M: '#cf3232', F: '#7c6098' },
  },
  {
    name: 'wizard gold cloak edging',
    classKey: 'wizard',
    slot: SLOTS.headgear,
    positions: { a: { x: 9, y: 5 }, b: { x: 9, y: 6 } },
    sourceHex: '#eaff00',
  },
  {
    name: 'wizard dark clothing',
    classKey: 'wizard',
    slot: SLOTS.body,
    positions: { a: { x: 8, y: 19 }, b: { x: 8, y: 16 } },
    sourceHex: '#3d3d3d',
  },
  {
    name: 'wizard belt',
    classKey: 'wizard',
    slot: SLOTS.trim,
    positions: { a: { x: 12, y: 17 }, b: { x: 12, y: 18 } },
    sourceHex: '#887000',
  },
  {
    name: 'wizard boots',
    classKey: 'wizard',
    slot: SLOTS.boots,
    positions: { a: { x: 9, y: 22 }, b: { x: 9, y: 22 } },
    sourceHex: '#b89600',
  },
  {
    name: 'priest robe edging stays with the robe',
    classKey: 'priest',
    slot: SLOTS.body,
    positions: { a: { x: 10, y: 2 }, b: { x: 10, y: 3 } },
    sourceHex: '#cf3232',
  },
  {
    name: 'priest belt',
    classKey: 'priest',
    slot: SLOTS.trim,
    positions: { a: { x: 10, y: 17 }, b: { x: 10, y: 18 } },
    sourceHex: '#cf3232',
  },
  {
    name: 'priest red boots',
    classKey: 'priest',
    slot: SLOTS.boots,
    positions: { a: { x: 9, y: 22 }, b: { x: 9, y: 22 } },
    sourceHex: '#ff3d3d',
  },
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
    name: 'shaman pelt field',
    classKey: 'shaman',
    slot: SLOTS.headgear,
    positions: { a: { x: 11, y: 4 }, b: { x: 11, y: 5 } },
    sourceHex: { M: '#887000', F: '#919191' },
  },
  {
    name: 'shaman light pelt edging',
    classKey: 'shaman',
    slot: SLOTS.headgear,
    positions: { a: { x: 15, y: 8 }, b: { x: 15, y: 9 } },
    sourceHex: { M: '#ffd1a6', F: '#ffffff' },
  },
  {
    name: 'shaman dark body',
    classKey: 'shaman',
    slot: SLOTS.body,
    positions: { a: { x: 9, y: 16 }, b: { x: 9, y: 17 } },
    sourceHex: { M: '#696969', F: '#2985b2' },
  },
  {
    name: 'shaman pelt drawstring',
    classKey: 'shaman',
    slot: SLOTS.headgear,
    positions: { a: { x: 11, y: 15 }, b: { x: 11, y: 16 } },
    sourceHex: '#ffffff',
  },
  {
    name: 'shaman right boot',
    classKey: 'shaman',
    slot: SLOTS.boots,
    positions: { a: { x: 16, y: 22 }, b: { x: 16, y: 22 } },
    sourceHex: '#696969',
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
    name: 'berserker white helmet trim pixel',
    classKey: 'berserker',
    slot: SLOTS.trim,
    positions: { a: { x: 13, y: 6 }, b: { x: 13, y: 7 } },
    sourceHex: '#ffffff',
  },
  {
    name: 'berserker cap tail joins the cape',
    classKey: 'berserker',
    slot: SLOTS.cape,
    positions: { a: { x: 17, y: 6 }, b: { x: 17, y: 7 } },
    sourceHex: '#919191',
  },
  {
    name: 'berserker lower cap tail joins the cape',
    classKey: 'berserker',
    slot: SLOTS.cape,
    positions: { a: { x: 19, y: 19 }, b: { x: 19, y: 20 } },
    sourceHex: { M: '#616060', F: '#ba1a1a' },
  },
  {
    name: 'berserker clothing beside the axe hilt',
    classKey: 'berserker',
    slot: SLOTS.body,
    positions: { a: { x: 5, y: 15 }, b: { x: 5, y: 16 } },
    sourceHex: '#887000',
  },
  {
    name: 'berserker female brown pixel below the belt',
    classKey: 'berserker',
    slot: { M: SLOTS.outline, F: SLOTS.body },
    positions: { a: { x: 14, y: 13 }, b: { x: 14, y: 14 } },
    sourceHex: { M: '#5d4b00', F: '#887000' },
  },
  {
    name: 'berserker female gold hair strand',
    classKey: 'berserker',
    slot: { M: SLOTS.skin, F: SLOTS.hair },
    positions: { a: { x: 13, y: 8 }, b: { x: 13, y: 9 } },
    sourceHex: { M: '#b86e28', F: '#eaff00' },
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
          const expectedSlot = typeof fixture.slot === 'number'
            ? fixture.slot
            : fixture.slot[gender];
          const source = sourceAt(fixture.classKey, gender, frame, position);
          const map = loadSlotmapFresh(`${fixture.classKey}_${gender}`, frame);

          expect(source).toEqual({ hex: expectedHex, alpha: 255 });
          expect(map, 'slot map must exist').not.toBeNull();
          expect(map?.[position.y * 24 + position.x]).toBe(expectedSlot);
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

describe('gender-specific hair boundaries', () => {
  const hairCounts = {
    berserker: { M: 0, F: 4 },
    knight: { M: 0, F: 2 },
    ranger: { M: 0, F: 0 },
    thief: { M: 0, F: 2 },
  } as const;

  for (const [classKey, expected] of Object.entries(hairCounts)) {
    for (const frame of ['a', 'b'] as const) {
      it(`${classKey}_${frame}: exposes only the authored hair pixels`, () => {
        const male = loadSlotmapFresh(`${classKey}_M`, frame);
        const female = loadSlotmapFresh(`${classKey}_F`, frame);

        expect(male, 'male slot map must exist').not.toBeNull();
        expect(female, 'female slot map must exist').not.toBeNull();
        expect(Array.from(male ?? []).filter((slot) => slot === SLOTS.hair))
          .toHaveLength(expected.M);
        expect(Array.from(female ?? []).filter((slot) => slot === SLOTS.hair))
          .toHaveLength(expected.F);
      });
    }
  }
});

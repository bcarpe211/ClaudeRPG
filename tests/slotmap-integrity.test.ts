import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  CLASSES,
  creatureSpriteFile,
  type Gender,
} from '../src/domain/classes';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { EXPECTED_CHANNELS } from '../src/domain/cosmeticsreview';
import {
  LEGEND,
  loadSlotmapFresh,
  PICKER_ORDER,
  readSlotmap,
  slotmapFile,
  SLOTS,
  type SpriteFrame,
} from '../src/domain/slots';
import { FEMALE_OVERRIDES } from '../tools/transfer-female-slotmaps';

const GENDERS = ['M', 'F'] as const satisfies readonly Gender[];
const FRAMES = ['a', 'b'] as const satisfies readonly SpriteFrame[];
const SPRITES_DIR = path.resolve(
  'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24',
);
const LEGEND_RGB = new Set(
  LEGEND.map(([, [r, g, b]]) => (r << 16) | (g << 8) | b),
);

function sourceFile(classKey: string, gender: Gender, frame: SpriteFrame): string {
  return path.join(
    SPRITES_DIR,
    creatureSpriteFile(spriteFileIndex(classKey, gender, frame)),
  );
}

function isVisible(png: PNG, x: number, y: number): boolean {
  return png.data[(y * png.width + x) * 4 + 3] !== 0;
}

function uniqueSlots(ids: Uint8Array | null): number[] {
  if (!ids) return [];
  const present = new Set(ids);
  present.delete(SLOTS.outline);
  return PICKER_ORDER.filter((slot) => present.has(slot));
}

describe('authored slot-map artifact integrity', () => {
  for (const { key: classKey } of CLASSES) {
    for (const gender of GENDERS) {
      for (const frame of FRAMES) {
        it(`${classKey}_${gender}_${frame} is a valid 24x24 legend map aligned to visible source pixels`, () => {
          const file = slotmapFile(`${classKey}_${gender}`, frame);
          expect(fs.existsSync(file), `${file} must exist`).toBe(true);
          if (!fs.existsSync(file)) return;

          const bytes = fs.readFileSync(file);
          const map = PNG.sync.read(bytes);
          const source = PNG.sync.read(fs.readFileSync(sourceFile(classKey, gender, frame)));
          expect([map.width, map.height]).toEqual([24, 24]);
          expect([source.width, source.height]).toEqual([24, 24]);

          const ids = readSlotmap(bytes);
          expect(ids).toHaveLength(24 * 24);
          for (let pixel = 0; pixel < ids.length; pixel++) {
            const offset = pixel * 4;
            const alpha = map.data[offset + 3];
            if (alpha !== 0) {
              const rgb = (map.data[offset] << 16)
                | (map.data[offset + 1] << 8)
                | map.data[offset + 2];
              expect(LEGEND_RGB.has(rgb), `unknown legend RGB at pixel ${pixel}`).toBe(true);
            }
            expect(ids[pixel]).toBeGreaterThanOrEqual(SLOTS.outline);
            expect(ids[pixel]).toBeLessThanOrEqual(SLOTS.flair);
            if (ids[pixel] !== SLOTS.outline) {
              expect(source.data[offset + 3], `slot ${ids[pixel]} labels transparent source pixel ${pixel}`)
                .not.toBe(0);
            }
          }
        });
      }

      it(`${classKey}_${gender} has the same channel set in frames A and B`, () => {
        expect(uniqueSlots(loadSlotmapFresh(`${classKey}_${gender}`, 'a')))
          .toEqual(uniqueSlots(loadSlotmapFresh(`${classKey}_${gender}`, 'b')));
      });
    }
  }

  it('records every female-only visible source coordinate as an explicit override', () => {
    for (const { key: classKey } of CLASSES) {
      for (const frame of FRAMES) {
        const male = PNG.sync.read(fs.readFileSync(sourceFile(classKey, 'M', frame)));
        const female = PNG.sync.read(fs.readFileSync(sourceFile(classKey, 'F', frame)));
        const overrideCoordinates = new Set(
          (FEMALE_OVERRIDES[`${classKey}_F_${frame}`] ?? [])
            .map(({ x, y }) => `${x},${y}`),
        );
        for (let y = 0; y < 24; y++) {
          for (let x = 0; x < 24; x++) {
            if (!isVisible(female, x, y) || isVisible(male, x, y)) continue;
            expect(
              overrideCoordinates.has(`${x},${y}`),
              `${classKey}_F_${frame} female-only pixel (${x},${y}) needs an override`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('contains only known override keys with in-bounds targets on visible female pixels', () => {
    const knownKeys = new Set(
      CLASSES.flatMap(({ key }) => FRAMES.map((frame) => `${key}_F_${frame}`)),
    );
    for (const [key, overrides] of Object.entries(FEMALE_OVERRIDES)) {
      expect(knownKeys.has(key), `unknown override key ${key}`).toBe(true);
      const match = /^(.+)_F_([ab])$/.exec(key);
      if (!match) continue;
      const classKey = match[1];
      const frame = match[2] as SpriteFrame;
      const female = PNG.sync.read(fs.readFileSync(sourceFile(classKey, 'F', frame)));
      for (const { x, y, slot } of overrides) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(24);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(24);
        expect(slot).toBeGreaterThanOrEqual(SLOTS.outline);
        expect(slot).toBeLessThanOrEqual(SLOTS.flair);
        expect(isVisible(female, x, y), `${key} override (${x},${y}) targets transparency`)
          .toBe(true);
      }
    }
  });
});

describe('male and female semantic channel parity', () => {
  for (const { key: classKey } of CLASSES) {
    it(`${classKey} differs only by its approved female-only channels`, () => {
      const male = uniqueSlots(loadSlotmapFresh(`${classKey}_M`, 'a'));
      const female = uniqueSlots(loadSlotmapFresh(`${classKey}_F`, 'a'));
      const additions: Record<string, readonly number[]> = {
        knight: [SLOTS.hair],
        priest: [SLOTS.hair],
        swordsman: [SLOTS.flair],
      };
      const expectedFemale = PICKER_ORDER.filter(
        (slot) => male.includes(slot) || (additions[classKey] ?? []).includes(slot),
      );

      expect(female).toEqual(expectedFemale);
      expect(female).toEqual(EXPECTED_CHANNELS[classKey].F);
    });
  }
});

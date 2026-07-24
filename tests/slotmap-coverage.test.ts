import { describe, expect, it } from 'vitest';
import { CLASSES, type Gender } from '../src/domain/classes';
import { EXPECTED_CHANNELS } from '../src/domain/cosmeticsreview';
import {
  loadSlotmapFresh,
  PICKER_ORDER,
  SLOTS,
  type SpriteFrame,
} from '../src/domain/slots';

const GENDERS = ['M', 'F'] as const satisfies readonly Gender[];
const FRAMES = ['a', 'b'] as const satisfies readonly SpriteFrame[];

function uniqueSlots(ids: Uint8Array | null): number[] {
  if (!ids) return [];
  const present = new Set(ids);
  present.delete(SLOTS.outline);
  return PICKER_ORDER.filter((slot) => present.has(slot));
}

describe('authored slot-map channel coverage', () => {
  for (const { key: classKey } of CLASSES) {
    for (const gender of GENDERS) {
      for (const frame of FRAMES) {
        it(`${classKey}_${gender}_${frame} exposes the exact expected channels`, () => {
          const actual = uniqueSlots(loadSlotmapFresh(`${classKey}_${gender}`, frame));
          expect(actual).toEqual(EXPECTED_CHANNELS[classKey][gender]);
        });
      }

      it(`${classKey}_${gender} exposes identical channels in frames A and B`, () => {
        const frameA = uniqueSlots(loadSlotmapFresh(`${classKey}_${gender}`, 'a'));
        const frameB = uniqueSlots(loadSlotmapFresh(`${classKey}_${gender}`, 'b'));
        expect(frameA).toEqual(frameB);
      });
    }
  }
});

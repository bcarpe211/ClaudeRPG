import { PNG } from 'pngjs';
import { CLASSES, type Gender } from './classes';
import { spriteId } from './cosmetics';
import { FINISHES, wheelRule } from './dye';
import {
  LEGEND,
  loadSlotmapFresh,
  PICKER_ORDER,
  SLOT_LABELS,
  SLOTS,
} from './slots';
import { recolorSpriteSlots } from './spritetint';

export type ReviewMode =
  | 'original' | 'slots' | 'focus' | 'hue'
  | 'black' | 'white' | 'steel';

export interface ReviewVariant {
  sprite: string;
  classKey: string;
  className: string;
  gender: Gender;
  channels: Array<{ slot: number; label: string }>;
  warnings: string[];
}

export const EXPECTED_CHANNELS: Record<
  string,
  { M: readonly number[]; F: readonly number[] }
> = {
  knight: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
      SLOTS.weapon, SLOTS.shield, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
      SLOTS.boots, SLOTS.weapon, SLOTS.shield, SLOTS.skin],
  },
  thief: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.headgear, SLOTS.hair, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.headgear, SLOTS.hair, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
  },
  ranger: {
    M: [SLOTS.body, SLOTS.headgear, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.headgear, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.flair, SLOTS.skin],
  },
  wizard: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.weapon, SLOTS.flair, SLOTS.skin],
  },
  priest: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.hair, SLOTS.weapon, SLOTS.flair,
      SLOTS.skin],
  },
  shaman: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon,
      SLOTS.facePaint, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon,
      SLOTS.facePaint, SLOTS.skin],
  },
  berserker: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
      SLOTS.weapon, SLOTS.flair, SLOTS.skin],
  },
  swordsman: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
      SLOTS.flair, SLOTS.skin],
  },
  paladin: {
    M: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon, SLOTS.shield,
      SLOTS.flair, SLOTS.skin],
    F: [SLOTS.body, SLOTS.trim, SLOTS.boots, SLOTS.weapon, SLOTS.shield,
      SLOTS.flair, SLOTS.skin],
  },
};

const LEGEND_RGB = new Map<number, [number, number, number]>(LEGEND);
const FLAIR_LABELS: Record<string, string> = {
  thief: 'Feather',
  ranger: 'Fletching',
  wizard: 'Eyes',
  priest: 'Holy symbol',
  berserker: 'Horns',
  swordsman: 'Details',
  paladin: 'Wings',
};

function channelsFor(ids: Uint8Array | null): number[] {
  if (!ids) return [];
  const present = new Set(ids);
  return PICKER_ORDER.filter((slot) => present.has(slot));
}

function labelFor(classKey: string, slot: number): string {
  if (slot === SLOTS.flair && FLAIR_LABELS[classKey]) return FLAIR_LABELS[classKey];
  return SLOT_LABELS[slot] ?? `Slot ${slot}`;
}

function warnChannelDifferences(
  warnings: string[],
  expected: readonly number[],
  actual: readonly number[],
  frame: 'A' | 'B',
  classKey: string,
): void {
  for (const slot of expected) {
    if (!actual.includes(slot)) warnings.push(`Missing expected ${frame} channel: ${labelFor(classKey, slot)}`);
  }
  for (const slot of actual) {
    if (!expected.includes(slot)) warnings.push(`Unexpected ${frame} channel: ${labelFor(classKey, slot)}`);
  }
}

export function buildCosmeticsReviewRoster(slotmapsDir?: string): ReviewVariant[] {
  return CLASSES.flatMap(({ key: classKey, name: className }) => (
    (['M', 'F'] as const).map((gender) => {
      const sprite = spriteId(classKey, gender);
      const frameAIds = loadSlotmapFresh(sprite, 'a', slotmapsDir);
      const frameBIds = loadSlotmapFresh(sprite, 'b', slotmapsDir);
      const frameA = channelsFor(frameAIds);
      const frameB = channelsFor(frameBIds);
      const expected = EXPECTED_CHANNELS[classKey][gender];
      const warnings: string[] = [];

      if (!frameAIds) warnings.push('Missing frame A slot map');
      if (!frameBIds) warnings.push('Missing frame B slot map');
      if (frameA.join(',') !== frameB.join(',')) warnings.push('Frame A/B channel mismatch');
      warnChannelDifferences(warnings, expected, frameA, 'A', classKey);
      warnChannelDifferences(warnings, expected, frameB, 'B', classKey);

      const available = new Set([...frameA, ...frameB]);
      return {
        sprite,
        classKey,
        className,
        gender,
        channels: PICKER_ORDER.filter((slot) => available.has(slot))
          .map((slot) => ({ slot, label: labelFor(classKey, slot) })),
        warnings,
      };
    })
  ));
}

function selectedSlot(slot: number | undefined): number {
  if (slot === undefined) throw new Error('A slot is required for this review mode');
  if (slot === SLOTS.outline) throw new Error('Outline slot is fixed and cannot be rendered');
  return slot;
}

export function renderCosmeticsReviewSprite(input: {
  source: Buffer;
  slotIds: Uint8Array;
  mode: ReviewMode;
  slot?: number;
  hue?: number;
}): Buffer {
  const sourcePng = PNG.sync.read(input.source);
  if (sourcePng.data.length / 4 !== input.slotIds.length) {
    throw new Error('Source and slot map pixel counts differ');
  }
  if (input.mode === 'original') return input.source;

  if (input.mode === 'slots' || input.mode === 'focus') {
    const selected = input.mode === 'focus' ? selectedSlot(input.slot) : undefined;
    const output = PNG.sync.read(input.source);
    for (let pixel = 0; pixel < input.slotIds.length; pixel++) {
      const slot = input.slotIds[pixel];
      if (slot === SLOTS.outline || (selected !== undefined && slot !== selected)) continue;
      const color = LEGEND_RGB.get(slot);
      if (!color) continue;
      const offset = pixel * 4;
      output.data[offset] = color[0];
      output.data[offset + 1] = color[1];
      output.data[offset + 2] = color[2];
    }
    return PNG.sync.write(output);
  }

  const slot = selectedSlot(input.slot);
  if (input.mode === 'hue') {
    return recolorSpriteSlots(input.source, input.slotIds, new Map([[slot, wheelRule(input.hue ?? 0)]]));
  }
  return recolorSpriteSlots(input.source, input.slotIds, new Map([[slot, FINISHES[input.mode]]]));
}

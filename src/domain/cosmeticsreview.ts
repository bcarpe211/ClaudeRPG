import { PNG } from 'pngjs';
import { CLASSES, type Gender } from './classes';
import { channelLabel, channelsFor } from './cosmetic-entitlements';
import { spriteId } from './cosmetics';
import { FINISHES, wheelRule } from './dye';
import {
  LEGEND,
  loadSlotmapFresh,
  PICKER_ORDER,
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

export const EXPECTED_CHANNELS: Record<string, { M: readonly number[]; F: readonly number[] }> =
  Object.fromEntries(CLASSES.map(({ key }) => {
    const expectedFor = (gender: Gender) => {
      const expected = new Set(channelsFor(key, gender).map((channel) => channel.slot));
      return PICKER_ORDER.filter((slot) => expected.has(slot));
    };
    return [key, { M: expectedFor('M'), F: expectedFor('F') }];
  }));

const LEGEND_RGB = new Map<number, [number, number, number]>(LEGEND);

function slotChannelsFor(ids: Uint8Array | null): number[] {
  if (!ids) return [];
  const present = new Set(ids);
  return PICKER_ORDER.filter((slot) => present.has(slot));
}

function warnChannelDifferences(
  warnings: string[],
  expected: readonly number[],
  actual: readonly number[],
  frame: 'A' | 'B',
  classKey: string,
  gender: Gender,
): void {
  for (const slot of expected) {
    if (!actual.includes(slot)) warnings.push(`Missing expected ${frame} channel: ${channelLabel(classKey, slot, gender)}`);
  }
  for (const slot of actual) {
    if (!expected.includes(slot)) warnings.push(`Unexpected ${frame} channel: ${channelLabel(classKey, slot, gender)}`);
  }
}

export function buildCosmeticsReviewRoster(slotmapsDir?: string): ReviewVariant[] {
  return CLASSES.flatMap(({ key: classKey, name: className }) => (
    (['M', 'F'] as const).map((gender) => {
      const sprite = spriteId(classKey, gender);
      const frameAIds = loadSlotmapFresh(sprite, 'a', slotmapsDir);
      const frameBIds = loadSlotmapFresh(sprite, 'b', slotmapsDir);
      const frameA = slotChannelsFor(frameAIds);
      const frameB = slotChannelsFor(frameBIds);
      const expected = EXPECTED_CHANNELS[classKey][gender];
      const warnings: string[] = [];

      if (!frameAIds) warnings.push('Missing frame A slot map');
      if (!frameBIds) warnings.push('Missing frame B slot map');
      if (frameA.join(',') !== frameB.join(',')) warnings.push('Frame A/B channel mismatch');
      warnChannelDifferences(warnings, expected, frameA, 'A', classKey, gender);
      warnChannelDifferences(warnings, expected, frameB, 'B', classKey, gender);

      const available = new Set([...frameA, ...frameB]);
      return {
        sprite,
        classKey,
        className,
        gender,
        channels: channelsFor(classKey, gender)
          .filter((channel) => available.has(channel.slot))
          .map(({ slot, label }) => ({ slot, label })),
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

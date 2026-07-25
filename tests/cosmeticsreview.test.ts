import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { FINISHES, wheelRule } from '../src/domain/dye';
import {
  LEGEND,
  PICKER_ORDER,
  SLOTS,
} from '../src/domain/slots';
import { colorize, recolorSpriteSlots } from '../src/domain/spritetint';
import {
  buildCosmeticsReviewRoster,
  EXPECTED_CHANNELS,
  renderCosmeticsReviewSprite,
} from '../src/domain/cosmeticsreview';

const LEGEND_RGB = new Map<number, [number, number, number]>(LEGEND);
const ids = Uint8Array.from([
  SLOTS.outline, SLOTS.body,
  SLOTS.weapon, SLOTS.flair,
]);

function sourcePng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  png.data.set([
    8, 9, 10, 255,
    120, 80, 40, 255,
    200, 220, 240, 128,
    160, 160, 160, 255,
  ]);
  return PNG.sync.write(png);
}

function rgba(buffer: Buffer): number[] {
  return Array.from(PNG.sync.read(buffer).data);
}

function pixel(buffer: Buffer, pixelIndex: number): number[] {
  return rgba(buffer).slice(pixelIndex * 4, pixelIndex * 4 + 4);
}

describe('EXPECTED_CHANNELS', () => {
  it('defines the exact target inventory in picker order', () => {
    expect(EXPECTED_CHANNELS).toEqual({
      knight: {
        M: [SLOTS.body, SLOTS.belt, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
          SLOTS.weapon, SLOTS.shield, SLOTS.flair, SLOTS.skin],
        F: [SLOTS.body, SLOTS.belt, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
          SLOTS.boots, SLOTS.weapon, SLOTS.shield, SLOTS.facePaint, SLOTS.flair,
          SLOTS.skin],
      },
      thief: {
        M: [SLOTS.body, SLOTS.trim, SLOTS.belt, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
          SLOTS.weapon, SLOTS.shield, SLOTS.flair, SLOTS.skin],
        F: [SLOTS.body, SLOTS.trim, SLOTS.belt, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
          SLOTS.boots, SLOTS.weapon, SLOTS.shield, SLOTS.facePaint, SLOTS.flair,
          SLOTS.skin],
      },
      ranger: {
        M: [SLOTS.body, SLOTS.trim, SLOTS.belt, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
          SLOTS.weapon, SLOTS.shield, SLOTS.flair, SLOTS.skin],
        F: [SLOTS.body, SLOTS.trim, SLOTS.belt, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
          SLOTS.weapon, SLOTS.shield, SLOTS.facePaint, SLOTS.flair, SLOTS.skin],
      },
      wizard: {
        M: [SLOTS.body, SLOTS.trim, SLOTS.belt, SLOTS.headgear, SLOTS.boots,
          SLOTS.weapon,
          SLOTS.flair, SLOTS.skin],
        F: [SLOTS.body, SLOTS.trim, SLOTS.belt, SLOTS.headgear, SLOTS.boots,
          SLOTS.weapon,
          SLOTS.flair, SLOTS.skin],
      },
      priest: {
        M: [SLOTS.body, SLOTS.belt, SLOTS.boots, SLOTS.weapon, SLOTS.flair,
          SLOTS.skin],
        F: [SLOTS.body, SLOTS.belt, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
          SLOTS.facePaint, SLOTS.flair, SLOTS.skin],
      },
      shaman: {
        M: [SLOTS.body, SLOTS.headgear, SLOTS.boots, SLOTS.weapon,
          SLOTS.facePaint, SLOTS.skin],
        F: [SLOTS.body, SLOTS.headgear, SLOTS.boots, SLOTS.weapon,
          SLOTS.facePaint, SLOTS.flair, SLOTS.skin],
      },
      berserker: {
        M: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.boots,
          SLOTS.weapon, SLOTS.flair, SLOTS.skin],
        F: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
          SLOTS.boots, SLOTS.weapon, SLOTS.facePaint, SLOTS.flair, SLOTS.skin],
      },
      swordsman: {
        M: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
          SLOTS.boots, SLOTS.weapon, SLOTS.skin],
        F: [SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
          SLOTS.boots, SLOTS.weapon, SLOTS.facePaint, SLOTS.flair, SLOTS.skin],
      },
      paladin: {
        M: [SLOTS.body, SLOTS.cape, SLOTS.headgear, SLOTS.boots, SLOTS.weapon,
          SLOTS.shield,
          SLOTS.flair, SLOTS.skin],
        F: [SLOTS.body, SLOTS.cape, SLOTS.headgear, SLOTS.hair, SLOTS.boots, SLOTS.weapon,
          SLOTS.shield, SLOTS.facePaint, SLOTS.flair, SLOTS.skin],
      },
    });
    for (const variants of Object.values(EXPECTED_CHANNELS)) {
      for (const channels of [variants.M, variants.F]) {
        expect(channels.map((slot) => PICKER_ORDER.indexOf(slot)))
          .toEqual([...channels.map((slot) => PICKER_ORDER.indexOf(slot))].sort((a, b) => a - b));
      }
    }
  });
});

describe('buildCosmeticsReviewRoster', () => {
  it('builds the complete warning-free roster with friendly flair labels', () => {
    const roster = buildCosmeticsReviewRoster();

    expect(roster).toHaveLength(18);
    expect(roster.map(({ sprite }) => sprite)).toEqual([
      'knight_M', 'knight_F', 'thief_M', 'thief_F', 'ranger_M', 'ranger_F',
      'wizard_M', 'wizard_F', 'priest_M', 'priest_F', 'shaman_M', 'shaman_F',
      'berserker_M', 'berserker_F', 'swordsman_M', 'swordsman_F', 'paladin_M', 'paladin_F',
    ]);
    expect(roster.find(({ sprite }) => sprite === 'wizard_M')?.channels)
      .toContainEqual({ slot: SLOTS.flair, label: 'Eyes' });
    expect(roster.find(({ sprite }) => sprite === 'wizard_M')?.channels)
      .toContainEqual({ slot: SLOTS.trim, label: 'Gold trim' });
    expect(roster.find(({ sprite }) => sprite === 'wizard_M')?.channels)
      .toContainEqual({ slot: SLOTS.belt, label: 'Belt' });
    expect(roster.find(({ sprite }) => sprite === 'knight_M')?.channels)
      .toContainEqual({ slot: SLOTS.flair, label: 'Plume' });
    expect(roster.find(({ sprite }) => sprite === 'thief_M')?.channels)
      .toContainEqual({ slot: SLOTS.shield, label: 'Accessory' });
    expect(roster.find(({ sprite }) => sprite === 'thief_M')?.channels)
      .toContainEqual({ slot: SLOTS.trim, label: 'Trim' });
    expect(roster.find(({ sprite }) => sprite === 'thief_M')?.channels)
      .toContainEqual({ slot: SLOTS.belt, label: 'Belt' });
    expect(roster.find(({ sprite }) => sprite === 'ranger_M')?.channels)
      .toContainEqual({ slot: SLOTS.shield, label: 'Quiver' });
    expect(roster.find(({ sprite }) => sprite === 'ranger_M')?.channels)
      .toContainEqual({ slot: SLOTS.trim, label: 'Trim' });
    expect(roster.find(({ sprite }) => sprite === 'ranger_M')?.channels)
      .toContainEqual({ slot: SLOTS.belt, label: 'Belt' });
    expect(roster.find(({ sprite }) => sprite === 'shaman_M')?.channels)
      .toContainEqual({ slot: SLOTS.headgear, label: 'Pelt' });
    expect(roster.find(({ sprite }) => sprite === 'swordsman_F')?.channels)
      .toContainEqual({ slot: SLOTS.facePaint, label: 'Lips' });
    expect(roster.find(({ sprite }) => sprite === 'swordsman_F')?.channels)
      .toContainEqual({ slot: SLOTS.flair, label: 'Details' });
    expect(roster.find(({ sprite }) => sprite === 'paladin_F')?.channels)
      .toContainEqual({ slot: SLOTS.flair, label: 'Plume' });
    expect(roster.every(({ warnings }) => warnings.length === 0)).toBe(true);
  });
});

describe('renderCosmeticsReviewSprite', () => {
  it('returns the original source with identical decoded RGBA bytes', () => {
    const source = sourcePng();
    const result = renderCosmeticsReviewSprite({ source, slotIds: ids, mode: 'original' });

    expect(result).toBe(source);
    expect(rgba(result)).toEqual(rgba(source));
  });

  it('renders every nonzero slot in its exact legend RGB', () => {
    const source = sourcePng();
    const result = renderCosmeticsReviewSprite({ source, slotIds: ids, mode: 'slots' });

    expect(pixel(result, 0)).toEqual([8, 9, 10, 255]);
    expect(pixel(result, 1)).toEqual([...LEGEND_RGB.get(SLOTS.body)!, 255]);
    expect(pixel(result, 2)).toEqual([...LEGEND_RGB.get(SLOTS.weapon)!, 128]);
    expect(pixel(result, 3)).toEqual([...LEGEND_RGB.get(SLOTS.flair)!, 255]);
  });

  it('focuses only the selected slot with its legend RGB', () => {
    const source = sourcePng();
    const result = renderCosmeticsReviewSprite({
      source, slotIds: ids, mode: 'focus', slot: SLOTS.weapon,
    });

    expect(pixel(result, 0)).toEqual(pixel(source, 0));
    expect(pixel(result, 1)).toEqual(pixel(source, 1));
    expect(pixel(result, 2)).toEqual([...LEGEND_RGB.get(SLOTS.weapon)!, 128]);
    expect(pixel(result, 3)).toEqual(pixel(source, 3));
  });

  it('hues only the selected slot through the shared wheel rule', () => {
    const source = sourcePng();
    const result = renderCosmeticsReviewSprite({
      source, slotIds: ids, mode: 'hue', slot: SLOTS.body, hue: 210,
    });

    const expected = colorize(120, 80, 40, wheelRule(210).hue!, wheelRule(210).sat!);
    expect(pixel(result, 0)).toEqual(pixel(source, 0));
    expect(pixel(result, 1)).toEqual([...expected, 255]);
    expect(pixel(result, 2)).toEqual(pixel(source, 2));
    expect(pixel(result, 3)).toEqual(pixel(source, 3));
  });

  for (const mode of ['black', 'white', 'steel'] as const) {
    it(`applies the shared ${mode} finish only to the selected slot`, () => {
      const source = sourcePng();
      const result = renderCosmeticsReviewSprite({
        source, slotIds: ids, mode, slot: SLOTS.flair,
      });
      const expected = recolorSpriteSlots(source, ids, new Map([[SLOTS.flair, FINISHES[mode]]]));

      expect(rgba(result)).toEqual(rgba(expected));
      expect(pixel(result, 0)).toEqual(pixel(source, 0));
      expect(pixel(result, 1)).toEqual(pixel(source, 1));
      expect(pixel(result, 2)).toEqual(pixel(source, 2));
    });
  }

  it('rejects a source and slot map with different pixel counts', () => {
    expect(() => renderCosmeticsReviewSprite({
      source: sourcePng(), slotIds: Uint8Array.from([SLOTS.body]), mode: 'slots',
    })).toThrow('Source and slot map pixel counts differ');
  });

  for (const mode of ['focus', 'hue', 'black', 'white', 'steel'] as const) {
    it(`requires a selected slot for ${mode}`, () => {
      expect(() => renderCosmeticsReviewSprite({
        source: sourcePng(), slotIds: ids, mode,
      })).toThrow('A slot is required for this review mode');
    });
  }
});

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { LEGEND, readSlotmap, SLOTS } from '../src/domain/slots';
import { transferFemaleSlotmap } from '../tools/transfer-female-slotmaps';

const LEGEND_RGB = new Map<number, [number, number, number]>(LEGEND);

function slotmap(width: number, height: number, slots: readonly number[]): Buffer {
  const png = new PNG({ width, height });
  for (let pixel = 0; pixel < slots.length; pixel++) {
    const slot = slots[pixel];
    if (slot === SLOTS.outline) continue;
    const [r, g, b] = LEGEND_RGB.get(slot)!;
    png.data.set([r, g, b, 255], pixel * 4);
  }
  return PNG.sync.write(png);
}

function sprite(width: number, height: number, visible: readonly boolean[]): Buffer {
  const png = new PNG({ width, height });
  for (let pixel = 0; pixel < visible.length; pixel++) {
    if (visible[pixel]) png.data.set([255, 255, 255, 255], pixel * 4);
  }
  return PNG.sync.write(png);
}

describe('transferFemaleSlotmap', () => {
  it('copies a shared visible male slot and lets an override replace it', () => {
    const maleMap = slotmap(2, 2, [SLOTS.body, SLOTS.trim, 0, SLOTS.body]);
    const maleSprite = sprite(2, 2, [true, true, false, true]);
    const femaleSprite = sprite(2, 2, [true, false, false, true]);

    const result = transferFemaleSlotmap(
      maleMap,
      maleSprite,
      femaleSprite,
      [{ x: 1, y: 1, slot: SLOTS.cape }],
    );
    expect(result.unresolved).toEqual([]);
    expect(readSlotmap(result.png)).toEqual(
      Uint8Array.from([SLOTS.body, 0, 0, SLOTS.cape]),
    );
  });

  it('makes a female transparent coordinate slot 0', () => {
    const result = transferFemaleSlotmap(
      slotmap(2, 2, [SLOTS.body, SLOTS.trim, 0, 0]),
      sprite(2, 2, [true, true, false, false]),
      sprite(2, 2, [true, false, false, false]),
      [],
    );

    expect(readSlotmap(result.png)).toEqual(Uint8Array.from([SLOTS.body, 0, 0, 0]));
  });

  it('returns a female-only visible coordinate as unresolved', () => {
    const result = transferFemaleSlotmap(
      slotmap(2, 2, [SLOTS.body, 0, 0, 0]),
      sprite(2, 2, [true, false, false, false]),
      sprite(2, 2, [true, false, false, true]),
      [],
    );

    expect(result.unresolved).toEqual([{ x: 1, y: 1 }]);
  });

  it('resolves a female-only visible coordinate with an explicit override', () => {
    const result = transferFemaleSlotmap(
      slotmap(2, 2, [SLOTS.body, 0, 0, 0]),
      sprite(2, 2, [true, false, false, false]),
      sprite(2, 2, [true, false, false, true]),
      [{ x: 1, y: 1, slot: SLOTS.cape }],
    );

    expect(result.unresolved).toEqual([]);
    expect(readSlotmap(result.png)).toEqual(
      Uint8Array.from([SLOTS.body, 0, 0, SLOTS.cape]),
    );
  });

  it('allows an override to assign slot 0', () => {
    const result = transferFemaleSlotmap(
      slotmap(2, 2, [SLOTS.body, 0, 0, 0]),
      sprite(2, 2, [true, false, false, false]),
      sprite(2, 2, [true, false, false, true]),
      [{ x: 1, y: 1, slot: SLOTS.outline }],
    );

    expect(result.unresolved).toEqual([]);
    expect(readSlotmap(result.png)).toEqual(Uint8Array.from([SLOTS.body, 0, 0, 0]));
  });

  it('rejects invalid dimensions and invalid overrides', () => {
    const maleMap = slotmap(2, 2, [SLOTS.body, 0, 0, 0]);
    const maleSprite = sprite(2, 2, [true, false, false, false]);
    const femaleSprite = sprite(2, 2, [true, false, false, true]);

    expect(() => transferFemaleSlotmap(
      slotmap(1, 1, [SLOTS.body]), maleSprite, femaleSprite, [],
    )).toThrow();
    expect(() => transferFemaleSlotmap(
      maleMap, maleSprite, femaleSprite,
      [{ x: 1, y: 1, slot: SLOTS.cape }, { x: 1, y: 1, slot: SLOTS.body }],
    )).toThrow();
    expect(() => transferFemaleSlotmap(
      maleMap, maleSprite, femaleSprite, [{ x: 2, y: 1, slot: SLOTS.cape }],
    )).toThrow();
    expect(() => transferFemaleSlotmap(
      maleMap, maleSprite, femaleSprite, [{ x: 1.5, y: 1, slot: SLOTS.cape }],
    )).toThrow();
    expect(() => transferFemaleSlotmap(
      maleMap, maleSprite, femaleSprite, [{ x: 1, y: 1, slot: 12 }],
    )).toThrow();
  });
});

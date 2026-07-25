import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { CLASSES, creatureSpriteFile } from '../src/domain/classes';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { LEGEND, SLOTS, slotmapFile, type SpriteFrame } from '../src/domain/slots';

export interface PixelOverride {
  x: number;
  y: number;
  slot: number;
}

export interface TransferResult {
  png: Buffer;
  unresolved: Array<{ x: number; y: number }>;
}

const SLOT_BY_RGB = new Map<number, number>(
  LEGEND.map(([slot, [r, g, b]]) => [(r << 16) | (g << 8) | b, slot]),
);
const LEGEND_RGB = new Map<number, [number, number, number]>(LEGEND);

function rgbaIndex(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function slotAt(png: PNG, x: number, y: number): number {
  const i = rgbaIndex(png.width, x, y);
  if (png.data[i + 3] === 0) return SLOTS.outline;
  return SLOT_BY_RGB.get((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2])
    ?? SLOTS.outline;
}

function isVisible(png: PNG, x: number, y: number): boolean {
  return png.data[rgbaIndex(png.width, x, y) + 3] !== 0;
}

function setSlot(png: PNG, x: number, y: number, slot: number): void {
  if (slot === SLOTS.outline) return;
  const [r, g, b] = LEGEND_RGB.get(slot)!;
  png.data.set([r, g, b, 255], rgbaIndex(png.width, x, y));
}

function validateOverrides(
  overrides: readonly PixelOverride[],
  width: number,
  height: number,
): Map<string, number> {
  const slots = new Map<string, number>();
  for (const { x, y, slot } of overrides) {
    if (!Number.isInteger(x) || !Number.isInteger(y)
      || x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error(`Invalid override coordinate (${x},${y})`);
    }
    if (!Number.isInteger(slot) || slot < SLOTS.outline || slot > SLOTS.flair) {
      throw new Error(`Invalid override slot ${slot}`);
    }
    const key = `${x},${y}`;
    if (slots.has(key)) throw new Error(`Duplicate override coordinate (${x},${y})`);
    slots.set(key, slot);
  }
  return slots;
}

export function transferFemaleSlotmap(
  maleMapPng: Buffer,
  maleSpritePng: Buffer,
  femaleSpritePng: Buffer,
  overrides: readonly PixelOverride[],
): TransferResult {
  const maleMap = PNG.sync.read(maleMapPng);
  const maleSprite = PNG.sync.read(maleSpritePng);
  const femaleSprite = PNG.sync.read(femaleSpritePng);
  const { width, height } = femaleSprite;

  if (maleMap.width !== width || maleMap.height !== height
    || maleSprite.width !== width || maleSprite.height !== height) {
    throw new Error('Male map, male sprite, and female sprite dimensions must match');
  }

  const overrideSlots = validateOverrides(overrides, width, height);
  const output = new PNG({ width, height });
  output.data.fill(0);
  const unresolved: Array<{ x: number; y: number }> = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isVisible(femaleSprite, x, y)) continue;

      const override = overrideSlots.get(`${x},${y}`);
      if (isVisible(maleSprite, x, y)) {
        setSlot(output, x, y, override ?? slotAt(maleMap, x, y));
      } else if (override !== undefined) {
        setSlot(output, x, y, override);
      } else {
        unresolved.push({ x, y });
      }
    }
  }

  return { png: PNG.sync.write(output), unresolved };
}

export const FEMALE_OVERRIDES: Record<string, readonly PixelOverride[]> = {
  berserker_F_a: [
    { x: 13, y: 8, slot: SLOTS.trim },
    { x: 14, y: 9, slot: SLOTS.trim },
    { x: 16, y: 9, slot: SLOTS.outline },
    { x: 18, y: 9, slot: SLOTS.outline },
    { x: 15, y: 10, slot: SLOTS.trim },
    { x: 16, y: 10, slot: SLOTS.trim },
    { x: 19, y: 12, slot: SLOTS.cape },
    { x: 20, y: 12, slot: SLOTS.outline },
    { x: 19, y: 13, slot: SLOTS.outline },
    { x: 13, y: 14, slot: SLOTS.outline },
    { x: 9, y: 15, slot: SLOTS.skin },
    { x: 11, y: 15, slot: SLOTS.skin },
    { x: 10, y: 16, slot: SLOTS.skin },
    { x: 8, y: 17, slot: SLOTS.outline },
    { x: 19, y: 18, slot: SLOTS.cape },
    { x: 7, y: 19, slot: SLOTS.outline },
    { x: 19, y: 19, slot: SLOTS.cape },
    { x: 19, y: 20, slot: SLOTS.cape },
    { x: 19, y: 21, slot: SLOTS.cape },
    { x: 20, y: 21, slot: SLOTS.cape },
    { x: 19, y: 22, slot: SLOTS.cape },
    { x: 20, y: 22, slot: SLOTS.cape },
  ],
  berserker_F_b: [
    { x: 13, y: 9, slot: SLOTS.trim },
    { x: 14, y: 10, slot: SLOTS.trim },
    { x: 16, y: 10, slot: SLOTS.outline },
    { x: 18, y: 10, slot: SLOTS.outline },
    { x: 15, y: 11, slot: SLOTS.trim },
    { x: 16, y: 11, slot: SLOTS.trim },
    { x: 13, y: 15, slot: SLOTS.outline },
    { x: 9, y: 16, slot: SLOTS.skin },
    { x: 11, y: 16, slot: SLOTS.skin },
    { x: 10, y: 17, slot: SLOTS.skin },
    { x: 8, y: 18, slot: SLOTS.outline },
    { x: 19, y: 19, slot: SLOTS.cape },
    { x: 7, y: 20, slot: SLOTS.outline },
    { x: 19, y: 20, slot: SLOTS.cape },
    { x: 19, y: 21, slot: SLOTS.cape },
    { x: 20, y: 21, slot: SLOTS.cape },
    { x: 19, y: 22, slot: SLOTS.cape },
    { x: 20, y: 22, slot: SLOTS.cape },
  ],
  knight_F_a: [
    { x: 6, y: 7, slot: SLOTS.hair },
    { x: 7, y: 7, slot: SLOTS.hair },
    { x: 7, y: 16, slot: SLOTS.outline },
    { x: 8, y: 17, slot: SLOTS.outline },
    { x: 18, y: 21, slot: SLOTS.cape },
  ],
  knight_F_b: [
    { x: 6, y: 8, slot: SLOTS.hair },
    { x: 7, y: 8, slot: SLOTS.hair },
    { x: 7, y: 17, slot: SLOTS.outline },
    { x: 8, y: 18, slot: SLOTS.outline },
  ],
  paladin_F_a: [
    { x: 15, y: 8, slot: SLOTS.outline },
    { x: 23, y: 8, slot: SLOTS.outline },
    { x: 21, y: 9, slot: SLOTS.outline },
    { x: 22, y: 9, slot: SLOTS.outline },
    { x: 19, y: 10, slot: SLOTS.outline },
    { x: 7, y: 16, slot: SLOTS.outline },
    { x: 8, y: 17, slot: SLOTS.outline },
    { x: 7, y: 19, slot: SLOTS.outline },
  ],
  paladin_F_b: [
    { x: 15, y: 9, slot: SLOTS.outline },
    { x: 23, y: 9, slot: SLOTS.outline },
    { x: 21, y: 10, slot: SLOTS.outline },
    { x: 22, y: 10, slot: SLOTS.outline },
    { x: 19, y: 11, slot: SLOTS.outline },
    { x: 7, y: 17, slot: SLOTS.outline },
    { x: 8, y: 18, slot: SLOTS.outline },
    { x: 7, y: 20, slot: SLOTS.outline },
  ],
  priest_F_a: [
    { x: 14, y: 9, slot: SLOTS.hair },
    { x: 15, y: 10, slot: SLOTS.hair },
    { x: 15, y: 11, slot: SLOTS.outline },
    { x: 16, y: 11, slot: SLOTS.hair },
    { x: 17, y: 11, slot: SLOTS.outline },
    { x: 7, y: 12, slot: SLOTS.body },
    { x: 16, y: 12, slot: SLOTS.hair },
    { x: 17, y: 12, slot: SLOTS.hair },
    { x: 8, y: 13, slot: SLOTS.body },
    { x: 16, y: 13, slot: SLOTS.outline },
    { x: 17, y: 13, slot: SLOTS.hair },
    { x: 18, y: 13, slot: SLOTS.outline },
    { x: 17, y: 14, slot: SLOTS.outline },
    { x: 9, y: 17, slot: SLOTS.outline },
    { x: 19, y: 17, slot: SLOTS.outline },
    { x: 20, y: 18, slot: SLOTS.outline },
  ],
  priest_F_b: [
    { x: 14, y: 10, slot: SLOTS.hair },
    { x: 15, y: 11, slot: SLOTS.hair },
    { x: 15, y: 12, slot: SLOTS.outline },
    { x: 16, y: 12, slot: SLOTS.hair },
    { x: 17, y: 12, slot: SLOTS.outline },
    { x: 7, y: 13, slot: SLOTS.body },
    { x: 16, y: 13, slot: SLOTS.hair },
    { x: 17, y: 13, slot: SLOTS.hair },
    { x: 8, y: 14, slot: SLOTS.body },
    { x: 16, y: 14, slot: SLOTS.outline },
    { x: 17, y: 14, slot: SLOTS.hair },
    { x: 18, y: 14, slot: SLOTS.outline },
    { x: 17, y: 15, slot: SLOTS.outline },
    { x: 9, y: 18, slot: SLOTS.outline },
    { x: 19, y: 18, slot: SLOTS.outline },
    { x: 20, y: 19, slot: SLOTS.outline },
  ],
  ranger_F_a: [
    { x: 8, y: 17, slot: SLOTS.outline },
  ],
  ranger_F_b: [
    { x: 14, y: 16, slot: SLOTS.outline },
    { x: 8, y: 17, slot: SLOTS.outline },
  ],
  shaman_F_a: [
    { x: 9, y: 17, slot: SLOTS.outline },
    { x: 8, y: 19, slot: SLOTS.outline },
  ],
  shaman_F_b: [
    { x: 9, y: 18, slot: SLOTS.outline },
    { x: 8, y: 20, slot: SLOTS.outline },
  ],
  swordsman_F_a: [
    { x: 16, y: 10, slot: SLOTS.flair },
    { x: 9, y: 12, slot: SLOTS.flair },
    { x: 10, y: 12, slot: SLOTS.flair },
    { x: 10, y: 14, slot: SLOTS.skin },
    { x: 10, y: 15, slot: SLOTS.skin },
    { x: 8, y: 18, slot: SLOTS.outline },
    { x: 7, y: 19, slot: SLOTS.outline },
  ],
  swordsman_F_b: [
    { x: 16, y: 11, slot: SLOTS.flair },
    { x: 9, y: 13, slot: SLOTS.flair },
    { x: 10, y: 13, slot: SLOTS.flair },
    { x: 10, y: 15, slot: SLOTS.skin },
    { x: 10, y: 16, slot: SLOTS.skin },
    { x: 8, y: 19, slot: SLOTS.outline },
    { x: 7, y: 20, slot: SLOTS.outline },
    { x: 9, y: 22, slot: SLOTS.outline },
  ],
  thief_F_a: [
    { x: 8, y: 7, slot: SLOTS.hair },
    { x: 9, y: 7, slot: SLOTS.hair },
    { x: 10, y: 14, slot: SLOTS.skin },
    { x: 8, y: 17, slot: SLOTS.outline },
    { x: 18, y: 17, slot: SLOTS.outline },
    { x: 19, y: 18, slot: SLOTS.outline },
  ],
  thief_F_b: [
    { x: 8, y: 8, slot: SLOTS.hair },
    { x: 9, y: 8, slot: SLOTS.hair },
    { x: 10, y: 15, slot: SLOTS.skin },
    { x: 8, y: 18, slot: SLOTS.outline },
    { x: 18, y: 18, slot: SLOTS.outline },
    { x: 19, y: 19, slot: SLOTS.outline },
  ],
  wizard_F_a: [
    { x: 8, y: 16, slot: SLOTS.outline },
    { x: 19, y: 17, slot: SLOTS.outline },
    { x: 20, y: 18, slot: SLOTS.outline },
  ],
  wizard_F_b: [
    { x: 21, y: 6, slot: SLOTS.outline },
    { x: 8, y: 17, slot: SLOTS.outline },
    { x: 19, y: 18, slot: SLOTS.outline },
    { x: 20, y: 19, slot: SLOTS.outline },
  ],
};

const SPRITES_DIR = path.resolve('assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24');

export function main(): void {
  for (const { key: classKey } of CLASSES) {
    for (const frame of ['a', 'b'] as const) {
      const maleMapFile = slotmapFile(`${classKey}_M`, frame);
      const femaleMapFile = slotmapFile(`${classKey}_F`, frame);
      const maleSprite = fs.readFileSync(path.join(
        SPRITES_DIR,
        creatureSpriteFile(spriteFileIndex(classKey, 'M', frame)),
      ));
      const femaleSprite = fs.readFileSync(path.join(
        SPRITES_DIR,
        creatureSpriteFile(spriteFileIndex(classKey, 'F', frame)),
      ));
      const result = transferFemaleSlotmap(
        fs.readFileSync(maleMapFile),
        maleSprite,
        femaleSprite,
        FEMALE_OVERRIDES[`${classKey}_F_${frame}`] ?? [],
      );

      if (result.unresolved.length > 0) {
        throw new Error(
          `Unresolved female slot-map pixels for ${classKey} ${frame}: ${result.unresolved
            .map(({ x, y }) => `(${x},${y})`).join(', ')}`,
        );
      }

      fs.writeFileSync(femaleMapFile, result.png);
      console.log(`generated slotmaps/${classKey}_F_${frame}.png`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

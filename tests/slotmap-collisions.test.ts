import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { loadSlotmap, SLOTS } from '../src/domain/slots';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { creatureSpriteFile } from '../src/domain/classes';

const SPRITES = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24';
const hx = (h: string) => parseInt(h.replace('#', ''), 16);
function spritePng(cls: string) {
  return PNG.sync.read(readFileSync(`${SPRITES}/${creatureSpriteFile(spriteFileIndex(cls, 'M', 'a'))}`));
}

// Ground-truth collisions: pixels of `hex` inside `bbox` must be labeled `slot` (never body).
const COLLISIONS: Array<{ cls: string; hex: string; bbox: [number, number, number, number]; slot: number }> = [
  { cls: 'wizard', hex: '#cf3232', bbox: [8, 8, 13, 11], slot: SLOTS.flair },     // eyes
  { cls: 'shaman', hex: '#887000', bbox: [0, 0, 6, 23], slot: SLOTS.weapon },      // staff
  { cls: 'berserker', hex: '#887000', bbox: [0, 0, 5, 23], slot: SLOTS.weapon },   // axe handle (left)
  { cls: 'paladin', hex: '#f3f3f3', bbox: [0, 0, 23, 10], slot: SLOTS.headgear },  // white wings/helmet must NOT be body
  { cls: 'paladin', hex: '#887000', bbox: [0, 0, 23, 23], slot: SLOTS.boots },     // olive boots/trim must NOT be body
];

describe('slot-maps isolate collision pixels from the body slot', () => {
  for (const c of COLLISIONS) {
    it(`${c.cls}: ${c.hex} in its region is NOT labeled body`, () => {
      const map = loadSlotmap(`${c.cls}_M`, 'a');
      expect(map).not.toBeNull();
      const png = spritePng(c.cls);
      let found = 0, mislabeled = 0;
      for (let y = c.bbox[1]; y <= c.bbox[3]; y++) for (let x = c.bbox[0]; x <= c.bbox[2]; x++) {
        const i = (y * 24 + x) * 4;
        if (png.data[i + 3] === 0) continue;
        if (((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]) !== hx(c.hex)) continue;
        found++;
        if (map![y * 24 + x] === SLOTS.body) mislabeled++; // labeled body ⇒ would recolor with the body
      }
      expect(found).toBeGreaterThan(0);  // the collision pixels exist in the sprite
      expect(mislabeled).toBe(0);        // and none of them are in the body slot
    });
  }

  it('paladin garment (#b4c21d helmet+shirt) IS the body slot', () => {
    const map = loadSlotmap('paladin_M', 'a')!;
    const png = spritePng('paladin');
    let total = 0, body = 0;
    for (let p = 0; p < map.length; p++) {
      const i = p * 4;
      if (png.data[i + 3] === 0) continue;
      if (((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]) !== hx('#b4c21d')) continue;
      total++;
      if (map[p] === SLOTS.body) body++;
    }
    expect(total).toBeGreaterThan(0);
    expect(body).toBe(total); // the whole helmet+shirt garment recolors with the body channel
  });
});

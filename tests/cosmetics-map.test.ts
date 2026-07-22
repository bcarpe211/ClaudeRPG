import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { CLOTHING, spriteId, spriteFileIndex } from '../src/domain/cosmetics';
import { CLASSES } from '../src/domain/classes';
import { creatureSpriteFile } from '../src/domain/classes';

const SPRITES = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24';
function spriteHexes(idx: number): Set<string> {
  const png = PNG.sync.read(readFileSync(`${SPRITES}/${creatureSpriteFile(idx)}`));
  const s = new Set<string>();
  for (let i = 0; i < png.data.length; i += 4)
    if (png.data[i + 3] > 0)
      s.add(((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]).toString(16).padStart(6, '0'));
  return s;
}

describe('CLOTHING map', () => {
  it('every class has a non-empty dominant ramp', () => {
    for (const c of CLASSES) {
      expect(CLOTHING[c.key], c.key).toBeDefined();
      expect(CLOTHING[c.key].dominant.length, c.key).toBeGreaterThan(0);
    }
  });
  it('every dominant color actually exists in that class sprite (M frame A)', () => {
    for (const c of CLASSES) {
      const hexes = spriteHexes(spriteFileIndex(c.key, 'M', 'a'));
      for (const hex of CLOTHING[c.key].dominant)
        expect(hexes.has(hex.replace('#', '').toLowerCase()), `${c.key} ${hex}`).toBe(true);
    }
  });
  it('spriteId / spriteFileIndex', () => {
    expect(spriteId('knight', 'M')).toBe('knight_M');
    expect(spriteFileIndex('knight', 'M', 'a')).toBe(1);
    expect(spriteFileIndex('knight', 'M', 'b')).toBe(19);
    expect(spriteFileIndex('knight', 'F', 'a')).toBe(10);
  });
});

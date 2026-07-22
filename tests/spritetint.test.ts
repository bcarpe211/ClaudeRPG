import { describe, it, expect } from 'vitest';
import { hueSwap, recolorSprite } from '../src/domain/spritetint';
import { PNG } from 'pngjs';

describe('hueSwap', () => {
  it('preserves brightness/saturation, replaces hue (red -> green at 120)', () => {
    const [r, g, b] = hueSwap(0xff, 0x3d, 0x3d, 120); // vivid red -> vivid green
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(g).toBe(0xff); // max channel (V) preserved
  });
  it('keeps a shade dark (dark red -> dark green)', () => {
    const [, g] = hueSwap(0xcf, 0x32, 0x32, 120);
    expect(g).toBe(0xcf); // same V as the input's max channel
  });
});

describe('recolorSprite', () => {
  it('recolors only clothing pixels; leaves others intact', () => {
    const png = new PNG({ width: 2, height: 1 });
    // px0 = clothing red #ff3d3d, px1 = skin #ffd1a6
    png.data.set([0xff, 0x3d, 0x3d, 255], 0);
    png.data.set([0xff, 0xd1, 0xa6, 255], 4);
    const out = PNG.sync.read(recolorSprite(PNG.sync.write(png), ['#ff3d3d'], 120));
    expect([out.data[0], out.data[1], out.data[2]]).not.toEqual([0xff, 0x3d, 0x3d]); // px0 changed
    expect([out.data[4], out.data[5], out.data[6]]).toEqual([0xff, 0xd1, 0xa6]);     // px1 untouched
  });
});

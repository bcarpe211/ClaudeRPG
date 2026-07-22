import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { hueSwap, recolorSprite, colorize, valueRemap } from '../src/domain/spritetint';
import { PNG } from 'pngjs';

const PRIEST_M_A = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/oryx_16bit_fantasy_creatures_05.png';

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

describe('colorize (keeps per-pixel brightness, repaints chroma)', () => {
  it('turns a white pixel into a light saturated color', () => {
    // #f3f3f3 (near-white robe highlight) -> hue 0 (red), sat 0.6
    expect(colorize(243, 243, 243, 0, 0.6)).toEqual([243, 97, 97]);
  });
  it('preserves shading: a darker source stays a darker result', () => {
    const hi = colorize(243, 243, 243, 0, 0.6)[0]; // robe highlight -> R
    const lo = colorize(145, 145, 145, 0, 0.6)[0]; // robe shadow    -> R
    expect(hi).toBeGreaterThan(lo);
  });
  it('hueSwap still leaves a grey pixel grey (documents the limitation colorize fixes)', () => {
    expect(hueSwap(200, 200, 200, 120)).toEqual([200, 200, 200]);
  });
});

describe('recolorSprite (rule list)', () => {
  it('recolors only matching pixels; leaves others intact', () => {
    const png = new PNG({ width: 2, height: 1 });
    // px0 = clothing red #ff3d3d, px1 = skin #ffd1a6
    png.data.set([0xff, 0x3d, 0x3d, 255], 0);
    png.data.set([0xff, 0xd1, 0xa6, 255], 4);
    const out = PNG.sync.read(recolorSprite(PNG.sync.write(png), [{ hexes: ['#ff3d3d'], op: 'hue', hue: 120 }]));
    expect([out.data[0], out.data[1], out.data[2]]).not.toEqual([0xff, 0x3d, 0x3d]); // px0 changed
    expect([out.data[4], out.data[5], out.data[6]]).toEqual([0xff, 0xd1, 0xa6]);     // px1 untouched
  });
  it('colorizes the priest white robe into a saturated red', () => {
    const out = recolorSprite(readFileSync(PRIEST_M_A), [
      { hexes: ['#c9c9c9', '#f3f3f3', '#919191'], op: 'colorize', hue: 0, sat: 0.6 },
    ]);
    const png = PNG.sync.read(out);
    let found = false;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i] === 243 && png.data[i + 1] === 97 && png.data[i + 2] === 97) { found = true; break; }
    }
    expect(found).toBe(true); // #f3f3f3 robe highlight -> (243,97,97)
  });
});

describe('valueRemap (greyscale finish, brightness remapped)', () => {
  it('compresses a white pixel toward mid-grey when hi=0.5', () => {
    // 243/255 * 0.5 * 255 = 121.5 -> Math.round rounds up to 122 (plan doc said 121; rounding typo)
    expect(valueRemap(243, 243, 243, 0, 0.5)).toEqual([122, 122, 122]);
  });
  it('keeps relative order (highlight stays lighter than shadow)', () => {
    const hi = valueRemap(243, 243, 243, 0, 0.5)[0];
    const lo = valueRemap(145, 145, 145, 0, 0.5)[0];
    expect(hi).toBeGreaterThan(lo);
  });
});

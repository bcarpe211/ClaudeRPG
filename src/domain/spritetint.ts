import { PNG } from 'pngjs';

/** HSV (h degrees, s,v in 0..1) → RGB 0..255. */
export function hsvToRgb(hDeg: number, s: number, v: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let rr = 0, gg = 0, bb = 0;
  switch (i % 6) {
    case 0: rr = v; gg = t; bb = p; break;
    case 1: rr = q; gg = v; bb = p; break;
    case 2: rr = p; gg = v; bb = t; break;
    case 3: rr = p; gg = q; bb = v; break;
    case 4: rr = t; gg = p; bb = v; break;
    case 5: rr = v; gg = p; bb = q; break;
  }
  return [Math.round(rr * 255), Math.round(gg * 255), Math.round(bb * 255)];
}

/** RGB 0..255 → HSV (h degrees, s,v in 0..1). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const v = max, s = max === 0 ? 0 : (max - min) / max, d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = ((gf - bf) / d) % 6;
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, v];
}

/** Replace hue, keep saturation & value. Chromatic materials only (S=0 stays grey). */
export function hueSwap(r: number, g: number, b: number, hueDeg: number): [number, number, number] {
  const [, s, v] = rgbToHsv(r, g, b);
  return hsvToRgb(hueDeg, s, v);
}

/** Repaint chroma (hue + injected saturation), KEEP the pixel's brightness ramp.
 *  This is what recolors white/grey/steel while preserving shading. */
export function colorize(r: number, g: number, b: number, hueDeg: number, sat: number): [number, number, number] {
  const v = Math.max(r, g, b) / 255;
  return hsvToRgb(hueDeg, sat, v);
}

/** Hue-swap every pixel whose RGB is in `clothing` (hex strings). Returns a new PNG buffer. */
export function recolorSprite(pngBuffer: Buffer, clothing: string[], hueDeg: number): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const set = new Set(clothing.map((h) => h.replace('#', '').toLowerCase()));
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const hex = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0');
    if (set.has(hex)) {
      const [r, g, b] = hueSwap(d[i], d[i + 1], d[i + 2], hueDeg);
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  }
  return PNG.sync.write(png);
}

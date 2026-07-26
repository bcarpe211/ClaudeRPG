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

const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

/** Repaint chroma while moving the source brightness ramp toward black or white. */
export function toneColorize(
  r: number, g: number, b: number,
  hueDeg: number, saturation: number, tone = 0,
): [number, number, number] {
  const sourceValue = Math.max(r, g, b) / 255;
  const t = Math.max(-1, Math.min(1, Number.isFinite(tone) ? tone : 0));
  const amount = Math.abs(t);
  const outputSaturation = lerp(saturation, 0, amount);
  const outputValue = t <= 0
    ? lerp(sourceValue, 0.32 * sourceValue, amount)
    : lerp(sourceValue, 0.74 + 0.26 * sourceValue, amount);
  return hsvToRgb(hueDeg, outputSaturation, outputValue);
}

/** Keep greyscale; remap brightness into [lo,hi]. lo=0,hi=1 is identity. */
export function valueRemap(r: number, g: number, b: number, lo: number, hi: number): [number, number, number] {
  const v = Math.max(r, g, b) / 255;
  const c = Math.round((lo + v * (hi - lo)) * 255);
  return [c, c, c];
}

export interface RecolorRule {
  hexes: string[];
  op: 'hue' | 'colorize' | 'value';
  hue?: number;   // 'hue', 'colorize'
  sat?: number;   // 'colorize'
  lo?: number;    // 'value'
  hi?: number;    // 'value'
  tone?: number;  // 'colorize'
}

export interface SlotRule {
  op: 'hue' | 'colorize' | 'value';
  hue?: number;   // 'hue', 'colorize'
  sat?: number;   // 'colorize'
  lo?: number;    // 'value'
  hi?: number;    // 'value'
  tone?: number;  // -1 (black) to 1 (white)
}

/** Apply a persisted per-slot rule while preserving legacy hue/value behavior. */
export function applySlotRule(rule: SlotRule, r: number, g: number, b: number): [number, number, number] {
  if (rule.op === 'colorize') return toneColorize(r, g, b, rule.hue ?? 0, rule.sat ?? 0.6, rule.tone ?? 0);
  if (rule.op === 'value') return valueRemap(r, g, b, rule.lo ?? 0, rule.hi ?? 1);
  return hueSwap(r, g, b, rule.hue ?? 0);
}

/** Apply per-slot transforms to matching pixels. Later rules win on hex collision. */
export function recolorSprite(pngBuffer: Buffer, rules: RecolorRule[]): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const map = new Map<string, (r: number, g: number, b: number) => [number, number, number]>();
  for (const rule of rules) {
    const fn = (r: number, g: number, b: number) => applySlotRule(rule, r, g, b);
    for (const h of rule.hexes) map.set(h.replace('#', '').toLowerCase(), fn);
  }
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const hex = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0');
    const fn = map.get(hex);
    if (fn) { const [r, g, b] = fn(d[i], d[i + 1], d[i + 2]); d[i] = r; d[i + 1] = g; d[i + 2] = b; }
  }
  return PNG.sync.write(png);
}

/** Recolour a sprite by per-pixel slot ids. `slotIds[p]` labels pixel p; each slot's
 *  rule is applied to its pixels. Slot 0 and slots with no rule pass through. */
export function recolorSpriteSlots(
  pngBuffer: Buffer, slotIds: Uint8Array, perSlot: Map<number, SlotRule>,
): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const d = png.data;
  const n = Math.min(slotIds.length, d.length / 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (d[i + 3] === 0) continue;
    const rule = perSlot.get(slotIds[p]);
    if (!rule) continue;
    const [r, g, b] = applySlotRule(rule, d[i], d[i + 1], d[i + 2]);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return PNG.sync.write(png);
}

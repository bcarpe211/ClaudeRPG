import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/** The 12 material slots (per the regions doc §4). Slot 0 is never tinted. */
export const SLOTS = {
  outline: 0, body: 1, headgear: 2, hair: 3, facePaint: 4, cape: 5,
  trim: 6, weapon: 7, shield: 8, boots: 9, skin: 10, flair: 11,
} as const;

/** Slot id ⇄ legend colour used inside the slot-map PNGs (human-viewable/editable). */
export const LEGEND: Array<[number, [number, number, number]]> = [
  [SLOTS.body, [255, 0, 0]], [SLOTS.headgear, [255, 127, 0]], [SLOTS.hair, [255, 255, 0]],
  [SLOTS.facePaint, [127, 255, 0]], [SLOTS.cape, [0, 255, 0]], [SLOTS.trim, [0, 255, 127]],
  [SLOTS.weapon, [0, 255, 255]], [SLOTS.shield, [0, 127, 255]], [SLOTS.boots, [0, 0, 255]],
  [SLOTS.skin, [127, 0, 255]], [SLOTS.flair, [255, 0, 255]],
  // slot 0 (outline) has no legend colour: transparent / unknown ⇒ 0.
];
const LOOKUP = new Map<number, number>(); // packed rgb -> slot id
for (const [slot, [r, g, b]] of LEGEND) LOOKUP.set((r << 16) | (g << 8) | b, slot);

/** Decode a slot-map PNG → per-pixel slot ids (row-major, same order as the sprite). */
export function readSlotmap(pngBuffer: Buffer): Uint8Array {
  const png = PNG.sync.read(pngBuffer);
  const out = new Uint8Array(png.width * png.height);
  const d = png.data;
  for (let p = 0; p < out.length; p++) {
    const i = p * 4;
    if (d[i + 3] === 0) { out[p] = 0; continue; }
    out[p] = LOOKUP.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) ?? 0;
  }
  return out;
}

const SLOTMAP_DIR = path.resolve('slotmaps');
const cache = new Map<string, Uint8Array | null>();

/** Load `slotmaps/<sprite>_<frame>.png` → slot ids, cached. null when the file is absent. */
export function loadSlotmap(sprite: string, frame: 'a' | 'b'): Uint8Array | null {
  const key = `${sprite}_${frame}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const file = path.join(SLOTMAP_DIR, `${key}.png`);
  const res = fs.existsSync(file) ? readSlotmap(fs.readFileSync(file)) : null;
  cache.set(key, res);
  return res;
}

/** Friendly default labels for the character-page picker. */
export const SLOT_LABELS: Record<number, string> = {
  [SLOTS.body]: 'Clothing',
  [SLOTS.headgear]: 'Headgear',
  [SLOTS.hair]: 'Hair',
  [SLOTS.facePaint]: 'Face paint',
  [SLOTS.cape]: 'Cape',
  [SLOTS.trim]: 'Trim',
  [SLOTS.weapon]: 'Weapon',
  [SLOTS.shield]: 'Shield',
  [SLOTS.boots]: 'Boots',
  [SLOTS.skin]: 'Skin',
  [SLOTS.flair]: 'Details',
};

/** Display order for all recolorable materials; outline is intentionally absent. */
export const PICKER_ORDER: number[] = [
  SLOTS.body,
  SLOTS.trim,
  SLOTS.cape,
  SLOTS.headgear,
  SLOTS.hair,
  SLOTS.boots,
  SLOTS.weapon,
  SLOTS.shield,
  SLOTS.facePaint,
  SLOTS.flair,
  SLOTS.skin,
];

/** Distinct recolorable slots present in a sprite's frame-A map, in picker order. */
export function presentSlots(sprite: string): number[] {
  const ids = loadSlotmap(sprite, 'a');
  if (!ids) return [];

  const seen = new Set<number>();
  for (const slot of ids) {
    if (slot !== SLOTS.outline) seen.add(slot);
  }
  return PICKER_ORDER.filter((slot) => seen.has(slot));
}

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { LEGEND, SLOTS } from '../src/domain/slots';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { creatureSpriteFile, type Gender } from '../src/domain/classes';

export interface SeedRule { slot: number; hexes: string[]; bbox?: [number, number, number, number] }

const LEGEND_RGB = new Map<number, [number, number, number]>(LEGEND.map(([s, c]) => [s, c]));
const hx = (h: string): number => parseInt(h.replace('#', ''), 16);

/** Per-class seed rules. Collision slots (bbox) come BEFORE the general body rule.
 *  Best-effort bboxes — hand-corrected in Task 4. Fill remaining classes from regions §3. */
export const SLOT_SEED: Record<string, SeedRule[]> = {
  wizard: [
    { slot: SLOTS.flair, hexes: ['#cf3232'], bbox: [8, 8, 13, 11] },      // eyes (two dots in the dark hood)
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600'], bbox: [0, 0, 6, 23] }, // staff (left)
    { slot: SLOTS.trim, hexes: ['#eaff00'] },                             // robe trim (gold)
    { slot: SLOTS.body, hexes: ['#cf3232', '#ff3d3d', '#3d3d3d'] },       // robe
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  shaman: [
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600'], bbox: [0, 0, 6, 23] }, // staff (left)
    { slot: SLOTS.facePaint, hexes: ['#2985b2'] },
    { slot: SLOTS.body, hexes: ['#887000', '#b89600'] },                  // pelt-hood + body
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  berserker: [
    { slot: SLOTS.cape, hexes: ['#887000', '#b89600'], bbox: [17, 4, 23, 23] },  // cape drape (right)
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600', '#919191', '#c9c9c9'], bbox: [0, 0, 5, 23] }, // axe (left)
    { slot: SLOTS.headgear, hexes: ['#616060', '#919191', '#9c9c9c', '#c9c9c9'] }, // helm (grey)
    { slot: SLOTS.trim, hexes: ['#eaff00'] },                             // headband
    { slot: SLOTS.body, hexes: ['#887000', '#b89600'] },                  // tunic (what's left, center)
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  paladin: [
    { slot: SLOTS.shield, hexes: ['#ffffff', '#0e7cb3', '#0b5e87'], bbox: [12, 11, 23, 23] }, // shield (front-right)
    { slot: SLOTS.flair, hexes: ['#b4c21d'] },                            // plume/crest
    { slot: SLOTS.trim, hexes: ['#887000', '#b89600', '#eaff00'] },       // gold trim/tabard
    { slot: SLOTS.body, hexes: ['#f3f3f3', '#ffffff', '#c9c9c9', '#bdbdbd', '#919191'] }, // helm + plate
    { slot: SLOTS.skin, hexes: ['#fc9838', '#ffd1a6', '#b86e28'] },
  ],
  // knight/thief/ranger/swordsman: no collisions — body = the current CLOTHING dominant.
  knight: [{ slot: SLOTS.body, hexes: ['#3cbcfc', '#9adcfd', '#2985b2'] }],
  thief: [{ slot: SLOTS.body, hexes: ['#1eba4a', '#24e35a'] }],
  ranger: [{ slot: SLOTS.body, hexes: ['#476575', '#7c94a4'] }],
  priest: [
    { slot: SLOTS.trim, hexes: ['#cf3232'] },                            // red cross/stole (leave)
    { slot: SLOTS.weapon, hexes: ['#887000', '#b89600', '#eaff00'], bbox: [0, 0, 6, 23] }, // ankh staff
    { slot: SLOTS.body, hexes: ['#c9c9c9', '#f3f3f3', '#919191'] },       // white robe
  ],
  swordsman: [{ slot: SLOTS.body, hexes: ['#0e7cb3'] }],
};

/** Seed one slot-map from a sprite + rules. First matching rule wins. */
export function seedSlotmap(spritePng: Buffer, rules: SeedRule[]): Buffer {
  const src = PNG.sync.read(spritePng);
  const out = new PNG({ width: src.width, height: src.height });
  out.data.fill(0);
  const d = src.data;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if (d[i + 3] === 0) continue;
      const rgb = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      for (const rule of rules) {
        if (!rule.hexes.some((h) => hx(h) === rgb)) continue;
        if (rule.bbox) {
          const [x0, y0, x1, y1] = rule.bbox;
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        }
        const [r, g, b] = LEGEND_RGB.get(rule.slot)!;
        out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255;
        break;
      }
    }
  }
  return PNG.sync.write(out);
}

// CLI: `npx tsx tools/seed-slotmaps.ts` — writes slotmaps/<class>_M_<a|b>.png for every class.
export function main(): void {
  const dir = path.resolve('slotmaps');
  fs.mkdirSync(dir, { recursive: true });
  const spritesDir = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24';
  for (const [cls, rules] of Object.entries(SLOT_SEED)) {
    for (const frame of ['a', 'b'] as const) {
      const idx = spriteFileIndex(cls, 'M' as Gender, frame);
      const sprite = fs.readFileSync(path.join(spritesDir, creatureSpriteFile(idx)));
      fs.writeFileSync(path.join(dir, `${cls}_M_${frame}.png`), seedSlotmap(sprite, rules));
      console.log(`seeded slotmaps/${cls}_M_${frame}.png`);
    }
  }
}
// Node ESM entry check:
if (import.meta.url === `file://${process.argv[1]}`) main();

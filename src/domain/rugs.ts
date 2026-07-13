import type { TileCoord } from './tilesheet';

export interface RugBorderTile { dx: number; dy: number; col: number; row: number; } // dx/dy 0..2, skips center (1,1)
export interface Rug { border: RugBorderTile[]; crests: TileCoord[]; }

// 8 border tiles (corners + edges) for a rug whose top-left sheet tile is (c0,r0).
function border(c0: number, r0: number): RugBorderTile[] {
  const out: RugBorderTile[] = [];
  for (let dy = 0; dy < 3; dy++)
    for (let dx = 0; dx < 3; dx++)
      if (!(dx === 1 && dy === 1)) out.push({ dx, dy, col: c0 + dx, row: r0 + dy }); // center is the crest
  return out;
}

export const RED_RUG: Rug = {
  border: border(5, 24),
  crests: [{ col: 5, row: 27 }, { col: 6, row: 27 }, { col: 7, row: 27 }], // phoenix / shield / knot
};
export const BLUE_RUG: Rug = {
  border: border(8, 24),
  crests: [{ col: 8, row: 27 }, { col: 9, row: 27 }, { col: 10, row: 27 }], // cross / crown / skull
};

// Warm-palette dungeons get the red rug; everything else the blue.
export const RUG_WARM = new Set([
  'Crimson Court', 'Emberforge', 'Cinderdeep', 'Bloodstone Cairn',
  'Auric Deep', 'Dunewatch', 'Oakenvault',
]);

export const RUG_CHANCE = 0.15; // ~1 in 7 dungeons gets a rug centerpiece

/** The rug (8 border tiles + one chosen crest) for a dungeon; consumes one rng draw for the crest. */
export function rugFor(dungeonName: string, rng: () => number): { border: RugBorderTile[]; crest: TileCoord } {
  const rug = RUG_WARM.has(dungeonName) ? RED_RUG : BLUE_RUG;
  const crest = rug.crests[Math.floor(rng() * rug.crests.length)];
  return { border: rug.border, crest };
}

export interface RugTile { dx: number; dy: number; col: number; row: number; } // dx/dy 0..3

// A 4x4 rug built from a 3x3 sheet block (top-left tile at c0,r0): the four corners are the
// sheet corners, the two middle rows/cols repeat the sheet's edge tiles, and the inner 2x2
// uses the sheet's centre fill. Even-sized (4x4) so a 2x2 boss centres exactly on it.
function rug4(c0: number, r0: number): RugTile[] {
  const map = (d: number) => (d === 0 ? 0 : d === 3 ? 2 : 1); // 0..3 -> sheet offset 0/1/1/2
  const out: RugTile[] = [];
  for (let dy = 0; dy < 4; dy++)
    for (let dx = 0; dx < 4; dx++)
      out.push({ dx, dy, col: c0 + map(dx), row: r0 + map(dy) });
  return out;
}

export const RED_RUG: RugTile[] = rug4(5, 24);
export const BLUE_RUG: RugTile[] = rug4(8, 24);

// Warm-palette dungeons get the red rug; everything else the blue.
export const RUG_WARM = new Set([
  'Crimson Court', 'Emberforge', 'Cinderdeep', 'Bloodstone Cairn',
  'Auric Deep', 'Dunewatch', 'Oakenvault',
]);

export const RUG_CHANCE = 0.15; // ~1 in 7 dungeons gets a rug centerpiece

/** The 16 rug tiles for a dungeon, themed warm (red) or cool (blue). */
export function rugFor(dungeonName: string): RugTile[] {
  return RUG_WARM.has(dungeonName) ? RED_RUG : BLUE_RUG;
}

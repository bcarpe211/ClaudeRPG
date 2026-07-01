export interface TileCoord { col: number; row: number; }

export const SHEET = { url: '/sheet/world.png', tile: 24, cols: 56, rows: 41 } as const;

export function tileRect(c: TileCoord) {
  return { sx: c.col * SHEET.tile, sy: c.row * SHEET.tile, sw: SHEET.tile, sh: SHEET.tile };
}

// 4-bit orthogonal edge mask: bit 1=N floor, 2=E, 4=S, 8=W (set when that
// neighbour is also floor). Values are offsets WITHIN a floor skin's block,
// added to skin.floorBase. mask 15 = interior ("full").
//
// Every mask currently maps to the block's full tile (offset 0,0): floors render
// solid and skinned, which already reads cohesively in /dungeon-preview (verified
// — clean skinned border + solid floor for both proof skins). Populating the
// per-mask edge/corner offsets (a FOLLOW-ON) gives floor-to-wall edge shading; it
// needs the floor block's blob-arrangement key, best decoded iteratively against
// the preview. The 9 masks that occur in a rectangular room are 15 (full),
// 14/11/7/13 (N/S/W/E edges) and 6/12/3/9 (the four corners); the other 7 only
// appear in corridors/peninsulas. The autotiler already computes these masks and
// looks them up here, so this is pure data to fill in later.
export const FLOOR_EDGES: Record<number, TileCoord> = {
  0: { col: 0, row: 0 }, 1: { col: 0, row: 0 }, 2: { col: 0, row: 0 }, 3: { col: 0, row: 0 },
  4: { col: 0, row: 0 }, 5: { col: 0, row: 0 }, 6: { col: 0, row: 0 }, 7: { col: 0, row: 0 },
  8: { col: 0, row: 0 }, 9: { col: 0, row: 0 }, 10: { col: 0, row: 0 }, 11: { col: 0, row: 0 },
  12: { col: 0, row: 0 }, 13: { col: 0, row: 0 }, 14: { col: 0, row: 0 }, 15: { col: 0, row: 0 },
};

// A floor "set": one main floor tile the whole dungeon uses, plus its own
// accent tiles sprinkled in at accentChance (0 = none). A theme lists 1..N sets;
// the generator picks ONE per dungeon, so a given dungeon has a single coherent
// floor look (accents are variants of that main, never a different main mixed in).
export interface FloorSet {
  main: TileCoord;
  accents: TileCoord[];
  accentChance: number;
}

// Wall pieces sit at fixed COLUMNS within any wall band (a skin is just a row),
// so the piece->column map is shared and a skin only needs its wallRow. These
// are the pseudo-3D wall autotile pieces: straight runs, the 4 outer corners,
// and the cracked straight-run variants. Corners have no cracked version.
// T/L/cross junction columns exist too (reserved for the future "rooms" feature).
export const WALL_COLS = {
  horizontal: 12, // straight run, wall on E+W
  vertical: 15,   // straight run, wall on N+S
  tl: 17, tr: 18, // top corners (wall on E+S / W+S)
  bl: 19, br: 20, // bottom corners (wall on E+N / W+N)
  lend: 11, rend: 13, // horizontal wall-ends (soft cap at a doorway): wall on E only / W only
  tend: 14, bend: 16, // vertical wall-ends: wall on S only / N only
  crackedH: 27,   // cracked horizontal run
  crackedV: 26,   // cracked vertical run
} as const;

// Door tiles live on the world sheet at row 3 cols 29-42 and row 4 cols 29-31.
// A doorway cell renders one of these instead of an open floor gap. Doors are a
// single GLOBAL weighted pool (theme-matched doors are a future refinement): the
// weight sets relative frequency, so brown wooden doors dominate, barricaded are
// common, grey stone / iron portcullis less frequent, ice / portal rare.
export interface WeightedTile { coord: TileCoord; weight: number; }
export const DOORS: WeightedTile[] = [
  // brown wooden — most often
  ...[29, 30, 31, 32, 33, 34, 35].map((col) => ({ coord: { col, row: 3 }, weight: 8 })),
  // brown barricaded — common
  ...[40, 41].map((col) => ({ coord: { col, row: 3 }, weight: 5 })),
  // grey stone — less frequent
  ...[36, 37].map((col) => ({ coord: { col, row: 3 }, weight: 3 })),
  // iron portcullis — less frequent
  ...[29, 30].map((col) => ({ coord: { col, row: 4 }, weight: 3 })),
  // ice — rare
  ...[38, 39].map((col) => ({ coord: { col, row: 3 }, weight: 1 })),
  { coord: { col: 42, row: 3 }, weight: 1 }, // purple portal — rare
  { coord: { col: 31, row: 4 }, weight: 1 }, // ice w/ handle — rare
];

// Weighted pick: draw one item with probability proportional to its weight.
// Consumes exactly one rng() call so the generator's stream stays deterministic.
export function pickWeighted<T extends { weight: number }>(items: T[], rng: () => number): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

export interface Skin {
  name: string;
  wallRow: number;             // the wall band's row; wall tiles = WALL_COLS[piece] @ this row
  wallVariantChance: number;   // chance a straight-run wall shows its cracked variant
  floorSets: FloorSet[];       // main-floor options; generator picks ONE per dungeon
  decor: TileCoord[];
  // Reserved: real archway doors (generator currently opens doorways as the
  // dungeon's floor) and the unused blob-floor path / future open-world floors.
  door: TileCoord;
  floorBase: TileCoord;
}

// Proof skins (decoded from oryx_16bit_fantasy_world_trans.png). Each wall pack
// is a horizontal band: col 1 = solid wall, cols 2-3 = cracked wall variants,
// cols 4-7 = themed floor tiles (this pack: 4=plain, 5=inset panel, 6=cracked
// plain (accent of 4), 7=small tiles). crypt = grey band (row 1); cave = brown
// band (row 3). Per-theme floor rules are typed data here — described per theme
// as we add them (cave's mapping mirrors crypt for now; refine when reviewed).
export const SKINS: Skin[] = [
  {
    name: 'crypt',
    wallRow: 1,
    wallVariantChance: 0.1,
    floorSets: [
      { main: { col: 4, row: 1 }, accents: [{ col: 6, row: 1 }], accentChance: 0.1 }, // plain + cracked-plain
      { main: { col: 5, row: 1 }, accents: [], accentChance: 0 },                       // inset panel
    ], // col 7 (small tiles) dropped — too busy as a full floor
    decor: [],
    door: { col: 4, row: 1 },
    floorBase: { col: 4, row: 1 },
  },
  {
    name: 'cave',
    wallRow: 3,
    wallVariantChance: 0.1,
    floorSets: [
      // row 3 = same as row 1 (minus col 7)
      { main: { col: 4, row: 3 }, accents: [{ col: 6, row: 3 }], accentChance: 0.1 },
      { main: { col: 5, row: 3 }, accents: [], accentChance: 0 },
    ],
    decor: [],
    door: { col: 4, row: 3 },
    floorBase: { col: 4, row: 3 },
  },
];

export function getSkin(name: string): Skin | undefined {
  return SKINS.find((s) => s.name === name);
}

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

export interface Skin {
  name: string;
  wall: TileCoord;             // solid wall block (wall-pack col 1)
  wallVariants?: TileCoord[];
  floors: TileCoord[];         // themed dungeon floor tiles (wall-pack cols 4-7)
  crackedFloors: TileCoord[];  // sporadic cracked accents (wall-pack cols 2-3)
  door: TileCoord;             // first pass: a floor tile (reads as an opening)
  decor: TileCoord[];
  // Kept for the (currently unused) blob-floor path / future open-world floors.
  floorBase: TileCoord;
}

// Proof skins (decoded from oryx_16bit_fantasy_world_trans.png). Each wall pack
// is a horizontal band: col 1 = solid wall, cols 2-3 = cracked variants, cols
// 4-7 = themed floor tiles. crypt = grey-stone band (row 1); cave = brown band
// (row 3).
export const SKINS: Skin[] = [
  {
    name: 'crypt',
    wall: { col: 1, row: 1 },
    floors: [
      { col: 4, row: 1 }, { col: 5, row: 1 }, { col: 6, row: 1 }, { col: 7, row: 1 },
    ],
    crackedFloors: [{ col: 2, row: 1 }, { col: 3, row: 1 }],
    door: { col: 4, row: 1 },
    decor: [],
    floorBase: { col: 4, row: 1 },
  },
  {
    name: 'cave',
    wall: { col: 1, row: 3 },
    floors: [
      { col: 4, row: 3 }, { col: 5, row: 3 }, { col: 6, row: 3 }, { col: 7, row: 3 },
    ],
    crackedFloors: [{ col: 2, row: 3 }, { col: 3, row: 3 }],
    door: { col: 4, row: 3 },
    decor: [],
    floorBase: { col: 4, row: 3 },
  },
];

export function getSkin(name: string): Skin | undefined {
  return SKINS.find((s) => s.name === name);
}

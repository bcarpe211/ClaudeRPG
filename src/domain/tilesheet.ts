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
  floorBase: TileCoord;        // origin of this skin's floor block (the full tile)
  wall: TileCoord;             // solid wall block
  wallVariants?: TileCoord[];
  door: TileCoord;             // first pass: a floor tile (reads as an opening)
  decor: TileCoord[];
}

// Proof skins (decoded from oryx_16bit_fantasy_world_trans.png; bases refined in
// the /dungeon-preview pass). Wall solids sit at col 1 of each wall band; floor
// blocks are the 2-row bands starting at col 29.
export const SKINS: Skin[] = [
  {
    name: 'crypt',
    wall: { col: 1, row: 1 },     // grey stone
    floorBase: { col: 30, row: 20 }, // olive/stone floor band
    door: { col: 30, row: 20 },
    decor: [],
  },
  {
    name: 'cave',
    wall: { col: 1, row: 3 },     // brown stone
    floorBase: { col: 30, row: 16 }, // green floor band
    door: { col: 30, row: 16 },
    decor: [],
  },
];

export function getSkin(name: string): Skin | undefined {
  return SKINS.find((s) => s.name === name);
}

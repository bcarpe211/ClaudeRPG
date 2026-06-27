export interface ThemeTiles {
  wall: string;
  wallVariants?: string[];
  floor: string;
  floorVariants: string[];
  door: string;
  decor: string[];
}

// Best-effort curated tiles per theme; tuned visually in Plan E.
// Every value must be a real file in Sliced/world_24x24/.
//
// Tile selection notes (verified by visual inspection of contact sheets):
//   stone_crypt: beveled grey stone blocks (70/71) as walls; cracked grey stone (59/60/62/63)
//     as floor; grey stone door archway (208); skull piles, torches, pot, rock as decor.
//   cave: dark earthy cave wall with green vine texture (686); brown earthy floor (173/174/175);
//     dark stone arch doorway (209); torches, crystal gem, rock as decor.
//   wood_fort: brown wooden panel wall (296); sandy flagstone floor (1142/1144/1150);
//     golden wooden door (207); torches, pot, rock as decor.
export const TILE_MANIFEST: Record<string, ThemeTiles> = {
  stone_crypt: {
    wall: 'oryx_16bit_fantasy_world_70.png',
    wallVariants: ['oryx_16bit_fantasy_world_71.png'],
    floor: 'oryx_16bit_fantasy_world_59.png',
    floorVariants: [
      'oryx_16bit_fantasy_world_60.png',
      'oryx_16bit_fantasy_world_62.png',
      'oryx_16bit_fantasy_world_63.png',
    ],
    door: 'oryx_16bit_fantasy_world_208.png',
    decor: [
      'oryx_16bit_fantasy_world_94.png',  // skull pile
      'oryx_16bit_fantasy_world_95.png',  // skull pile variant
      'oryx_16bit_fantasy_world_99.png',  // torch on pedestal
      'oryx_16bit_fantasy_world_100.png', // torch on pedestal (larger)
      'oryx_16bit_fantasy_world_163.png', // brown pot/vase
      'oryx_16bit_fantasy_world_164.png', // grey rock/boulder
    ],
  },
  cave: {
    wall: 'oryx_16bit_fantasy_world_686.png',
    floor: 'oryx_16bit_fantasy_world_173.png',
    floorVariants: [
      'oryx_16bit_fantasy_world_174.png',
      'oryx_16bit_fantasy_world_175.png',
    ],
    door: 'oryx_16bit_fantasy_world_209.png',
    decor: [
      'oryx_16bit_fantasy_world_156.png', // torch on pedestal
      'oryx_16bit_fantasy_world_157.png', // torch on pedestal (variant)
      'oryx_16bit_fantasy_world_165.png', // green crystal gem
      'oryx_16bit_fantasy_world_164.png', // grey rock/boulder
    ],
  },
  wood_fort: {
    wall: 'oryx_16bit_fantasy_world_296.png',
    floor: 'oryx_16bit_fantasy_world_1142.png',
    floorVariants: [
      'oryx_16bit_fantasy_world_1144.png',
      'oryx_16bit_fantasy_world_1150.png',
    ],
    door: 'oryx_16bit_fantasy_world_207.png',
    decor: [
      'oryx_16bit_fantasy_world_99.png',  // torch on pedestal
      'oryx_16bit_fantasy_world_100.png', // torch on pedestal (larger)
      'oryx_16bit_fantasy_world_163.png', // brown pot/vase
      'oryx_16bit_fantasy_world_164.png', // grey rock/boulder
    ],
  },
};

export const DEFAULT_THEME = 'stone_crypt';

export function themeTiles(theme: string): ThemeTiles {
  return TILE_MANIFEST[theme] ?? TILE_MANIFEST[DEFAULT_THEME];
}

export function worldSpriteUrl(file: string): string {
  return `/sprites/world_24x24/${file}`;
}

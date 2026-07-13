import type { TileCoord } from './tilesheet';

export type DecorTag =
  | 'generic' | 'crypt' | 'bones' | 'nature' | 'fire' | 'ice'
  | 'water' | 'stone' | 'sand' | 'blood' | 'poison' | 'treasure' | 'arcane';
export type DecorPlacement = 'floor' | 'corner' | 'wall';

export interface DecorTile {
  col: number; row: number; name: string;
  placement: DecorPlacement;
  tags: DecorTag[];
  walkable: boolean;               // hero/monster may stand on it (rugs true; props false)
  animB?: { col: number; row: number };  // 2nd frame — captured for Build 2, not rendered now
}

export const DECOR_TILES: DecorTile[] = [
  // corner — cobwebs
  { col: 29, row: 2, name: 'cobweb small', placement: 'corner', walkable: false, tags: ['generic','crypt','stone','water'] },
  { col: 30, row: 2, name: 'cobweb',       placement: 'corner', walkable: false, tags: ['generic','crypt','stone','ice'] },
  { col: 32, row: 2, name: 'cobweb 3',     placement: 'corner', walkable: false, tags: ['generic','crypt','stone'] },
  { col: 33, row: 2, name: 'cobweb full',  placement: 'corner', walkable: false, tags: ['crypt','stone'] }, // heavy only
  // wall — torches (animated in Build 2)
  { col: 41, row: 2, name: 'wall torch',   placement: 'wall', walkable: false, tags: ['fire','crypt','stone','treasure','blood'], animB: { col: 42, row: 2 } },
  // floor — crypt / bones
  { col: 29, row: 1, name: 'gravestone',       placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 30, row: 1, name: 'broken tombstone', placement: 'floor', walkable: false, tags: ['crypt','bones','stone'] },
  { col: 32, row: 1, name: 'crossed bones',    placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 34, row: 1, name: 'scattered bones',  placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 36, row: 1, name: 'skull pile',       placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 38, row: 1, name: 'skeleton',         placement: 'floor', walkable: false, tags: ['crypt','bones'] },
  { col: 41, row: 9, name: 'skull',            placement: 'floor', walkable: false, tags: ['crypt','bones'], animB: { col: 41, row: 10 } },
  // floor — fire / forge (animated)
  { col: 39, row: 1, name: 'flame',    placement: 'floor', walkable: false, tags: ['fire'], animB: { col: 40, row: 1 } },
  { col: 41, row: 1, name: 'brazier',  placement: 'floor', walkable: false, tags: ['fire','treasure'], animB: { col: 42, row: 1 } },
  { col: 31, row: 6, name: 'cauldron', placement: 'floor', walkable: false, tags: ['fire','poison'], animB: { col: 32, row: 6 } },
  // floor — arcane (tomes, animated)
  { col: 38, row: 9, name: 'grey tome',  placement: 'floor', walkable: false, tags: ['arcane','crypt'], animB: { col: 38, row: 10 } },
  { col: 39, row: 9, name: 'blue tome',  placement: 'floor', walkable: false, tags: ['arcane','water'], animB: { col: 39, row: 10 } },
  { col: 40, row: 9, name: 'green tome', placement: 'floor', walkable: false, tags: ['arcane','nature','poison'], animB: { col: 40, row: 10 } },
  // floor — treasure
  { col: 32, row: 4, name: 'chest',       placement: 'floor', walkable: false, tags: ['treasure'] },
  { col: 33, row: 4, name: 'gold chest',  placement: 'floor', walkable: false, tags: ['treasure'] },
  { col: 36, row: 4, name: 'gold idol',   placement: 'floor', walkable: false, tags: ['treasure','stone'] },
  { col: 36, row: 5, name: 'throne',      placement: 'floor', walkable: false, tags: ['treasure'] },
  // floor — generic props
  { col: 39, row: 4, name: 'barrel',      placement: 'floor', walkable: false, tags: ['generic','stone','sand','fire'] },
  { col: 40, row: 4, name: 'barrel open', placement: 'floor', walkable: false, tags: ['generic','stone','water'] },
  { col: 29, row: 5, name: 'crate',       placement: 'floor', walkable: false, tags: ['generic','stone'] },
  { col: 41, row: 5, name: 'wood crate',  placement: 'floor', walkable: false, tags: ['generic','sand'] },
  { col: 37, row: 6, name: 'stone urn',   placement: 'floor', walkable: false, tags: ['generic','stone','crypt'] },
  { col: 39, row: 6, name: 'stone pot',   placement: 'floor', walkable: false, tags: ['generic','stone'] },
  { col: 42, row: 6, name: 'broken pot',  placement: 'floor', walkable: false, tags: ['generic','stone','crypt'] },
  // floor — colored urns
  { col: 37, row: 7, name: 'blue urn',  placement: 'floor', walkable: false, tags: ['water','ice'] },
  { col: 40, row: 7, name: 'green urn', placement: 'floor', walkable: false, tags: ['poison','nature'] },
  { col: 37, row: 8, name: 'red urn',   placement: 'floor', walkable: false, tags: ['blood','fire'] },
  { col: 40, row: 8, name: 'clay pot',  placement: 'floor', walkable: false, tags: ['sand','generic'] },
  // floor — rubble / rock
  { col: 31, row: 1, name: 'rubble',       placement: 'floor', walkable: false, tags: ['stone','sand','generic'] },
  { col: 34, row: 6, name: 'rocks',        placement: 'floor', walkable: false, tags: ['stone','sand','ice','generic'] },
  { col: 33, row: 7, name: 'cracked rock', placement: 'floor', walkable: false, tags: ['stone','sand'] },
  // floor — blood / poison
  { col: 35, row: 2, name: 'blood splat',  placement: 'floor', walkable: false, tags: ['blood'] },
  { col: 36, row: 2, name: 'blood specks', placement: 'floor', walkable: false, tags: ['blood'] },
  { col: 38, row: 2, name: 'slime splat',  placement: 'floor', walkable: false, tags: ['poison','nature'] },
  { col: 39, row: 2, name: 'green slime',  placement: 'floor', walkable: false, tags: ['poison','water'] },
  // floor — water
  { col: 29, row: 8, name: 'fountain', placement: 'floor', walkable: false, tags: ['water'] },
  { col: 30, row: 8, name: 'well',     placement: 'floor', walkable: false, tags: ['water','stone'] },
  // floor — nature
  { col: 44, row: 1, name: 'bush',         placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 45, row: 1, name: 'bush b',       placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 52, row: 3, name: 'round bush',   placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 44, row: 2, name: 'flowers',      placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 46, row: 2, name: 'flowers b',    placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 50, row: 3, name: 'cactus',       placement: 'floor', walkable: false, tags: ['nature','sand'] },
  { col: 54, row: 2, name: 'red mushroom', placement: 'floor', walkable: false, tags: ['nature','poison'] },
  { col: 52, row: 2, name: 'blue mushroom',placement: 'floor', walkable: false, tags: ['nature','water'] },
  { col: 45, row: 3, name: 'brown rock',   placement: 'floor', walkable: false, tags: ['nature','stone','sand'] },
  { col: 46, row: 3, name: 'grey rock',    placement: 'floor', walkable: false, tags: ['nature','stone','ice'] },
  { col: 49, row: 4, name: 'small pine',   placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 45, row: 8, name: 'small tree',   placement: 'floor', walkable: false, tags: ['nature'] },
  { col: 50, row: 4, name: 'snowy pine',   placement: 'floor', walkable: false, tags: ['ice'] },
];

export const DUNGEON_DECOR: Record<string, DecorTag[]> = {
  'Greystone Keep':    ['stone','generic','crypt'],
  'Crimson Court':     ['blood','treasure','stone','fire'],
  'Mossmarch Hold':    ['nature','water','stone'],
  'Emberforge':        ['fire','stone','treasure'],
  'Oakenvault':        ['generic','treasure','stone','nature','arcane'],
  'Verdant Crypt':     ['crypt','bones','nature','poison'],
  'Tideglass Halls':   ['water','ice','generic'],
  'Frostiron Bastion': ['ice','stone','generic'],
  'Auric Deep':        ['treasure','fire','stone'],
  'Rustpipe Sewers':   ['water','poison','generic'],
  'Drowned Foundry':   ['water','fire','stone','generic'],
  'Duskstone Warren':  ['stone','crypt','generic','arcane'],
  'Thornwind Ruins':   ['nature','stone','crypt'],
  'Cinderdeep':        ['fire','stone','blood'],
  'Wildroot Barrow':   ['nature','crypt','bones'],
  'Ossuary Pale':      ['crypt','bones','stone','arcane'],
  'Glacierhold':       ['ice','stone','water'],
  'Bogstone Mire':     ['poison','water','nature','crypt'],
  'Dunewatch':         ['sand','stone','crypt','treasure'],
  'Cobblemoor':        ['stone','nature','generic'],
  'Bloodstone Cairn':  ['blood','crypt','bones','fire'],
};

// Dungeons that get more cobwebs (old / abandoned / crypt).
export const COBWEB_HEAVY = new Set(['Ossuary Pale','Duskstone Warren','Verdant Crypt','Bogstone Mire','Greystone Keep']);

const FALLBACK_DECOR: DecorTag[] = ['generic','stone'];

export interface DecorPool { floor: DecorTile[]; corner: DecorTile[]; wall: DecorTile[]; }

/** Decor tiles for a dungeon, split by placement. `corner` excludes 'heavy-only' full webs
 *  unless the dungeon is cobweb-heavy. */
export function decorFor(dungeonName: string): DecorPool {
  const tags = new Set(DUNGEON_DECOR[dungeonName] ?? FALLBACK_DECOR);
  const heavy = COBWEB_HEAVY.has(dungeonName);
  const match = (t: DecorTile) => t.tags.some((tag) => tags.has(tag));
  return {
    floor: DECOR_TILES.filter((t) => t.placement === 'floor' && match(t)),
    corner: DECOR_TILES.filter((t) => t.placement === 'corner' && match(t) && (heavy || t.name !== 'cobweb full')),
    wall: DECOR_TILES.filter((t) => t.placement === 'wall' && match(t)),
  };
}

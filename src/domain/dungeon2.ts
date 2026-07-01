import { makeRng } from './dungeon';
import { getSkin, WALL_COLS, type Skin, type FloorSet, type TileCoord } from './tilesheet';
import { type LogicalKind } from './autotile';

const at = <T>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];

// mulberry32's first outputs are strongly correlated for small sequential
// seeds (1,2,3 all yield a high first value). Feeding the seed through an
// integer avalanche hash first decorrelates the whole stream, so per-dungeon
// choices (floor set, doors, cracks) vary across adjacent seeds. Deterministic.
const scrambleSeed = (n: number): number => {
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  return (n ^ (n >>> 15)) >>> 0;
};

// Neighbour-aware wall autotiling: a wall cell picks its tile from which of its
// N/E/S/W neighbours are also wall. Corners connect two runs; a cell beside a
// doorway (gap) becomes a soft wall-end; straight runs sprinkle cracks. This
// also handles interior walls / rooms later (T/L/cross masks). Doors and floor
// count as NOT wall.
function pickWall(
  x: number, y: number, kinds: LogicalKind[][], w: number, h: number,
  skin: Skin, rng: () => number,
): TileCoord {
  const row = skin.wallRow;
  const C = (col: number): TileCoord => ({ col, row });
  const isWall = (xx: number, yy: number) =>
    xx >= 0 && yy >= 0 && xx < w && yy < h && kinds[yy][xx] === 'wall';
  const N = isWall(x, y - 1), E = isWall(x + 1, y), S = isWall(x, y + 1), Wt = isWall(x - 1, y);
  const cracked = rng() < skin.wallVariantChance;
  if (E && Wt && !N && !S) return C(cracked ? WALL_COLS.crackedH : WALL_COLS.horizontal);
  if (N && S && !E && !Wt) return C(cracked ? WALL_COLS.crackedV : WALL_COLS.vertical);
  if (E && S && !N && !Wt) return C(WALL_COLS.tl);
  if (Wt && S && !N && !E) return C(WALL_COLS.tr);
  if (E && N && !S && !Wt) return C(WALL_COLS.bl);
  if (Wt && N && !S && !E) return C(WALL_COLS.br);
  if (Wt && !E && !N && !S) return C(WALL_COLS.rend); // wall to the west only -> east cap
  if (E && !Wt && !N && !S) return C(WALL_COLS.lend);
  if (N && !S && !E && !Wt) return C(WALL_COLS.bend); // wall to the north only -> south cap
  if (S && !N && !E && !Wt) return C(WALL_COLS.tend);
  return C(WALL_COLS.horizontal); // junctions/isolated (rooms: future)
}

// Floor: the dungeon's chosen main tile, with this set's accents sprinkled in.
function pickFloor(set: FloorSet, rng: () => number): TileCoord {
  if (set.accents.length > 0 && rng() < set.accentChance) {
    return at(set.accents, rng);
  }
  return set.main;
}

export interface RenderCell { x: number; y: number; kind: LogicalKind; col: number; row: number; }
export interface AutoDungeon {
  width: number; height: number; skin: string; seed: number;
  cells: RenderCell[];
  decor: { x: number; y: number; col: number; row: number }[];
}
export interface GenOpts { width?: number; height?: number; }

export function generateAutotiledDungeon(
  skinName: string, seed: number, opts: GenOpts = {},
): AutoDungeon {
  const skin = getSkin(skinName);
  if (!skin) throw new Error(`unknown skin: ${skinName}`);
  const width = opts.width ?? 20;
  const height = opts.height ?? 15;
  const rng = makeRng(scrambleSeed(seed));
  // Pick ONE floor set for this whole dungeon (coherent look; accents vary it).
  const floorSet = at(skin.floorSets, rng);

  const isEdge = (x: number, y: number) => x === 0 || y === 0 || x === width - 1 || y === height - 1;
  const isCorner = (x: number, y: number) =>
    (x === 0 || x === width - 1) && (y === 0 || y === height - 1);

  // 1) Logical kinds.
  const kinds: LogicalKind[][] = [];
  for (let y = 0; y < height; y++) {
    const row: LogicalKind[] = [];
    for (let x = 0; x < width; x++) row.push(isEdge(x, y) ? 'wall' : 'floor');
    kinds.push(row);
  }
  // doors: 2-4 non-corner border cells
  const doorCount = 2 + Math.floor(rng() * 3);
  let guard = 0; let placed = 0;
  while (placed < doorCount && guard++ < 200) {
    const side = Math.floor(rng() * 4);
    let x = 0, y = 0;
    if (side === 0) { y = 0; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 1) { y = height - 1; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 2) { x = 0; y = 1 + Math.floor(rng() * (height - 2)); }
    else { x = width - 1; y = 1 + Math.floor(rng() * (height - 2)); }
    if (isCorner(x, y) || kinds[y][x] === 'door') continue;
    kinds[y][x] = 'door'; placed++;
  }

  // 2) Resolve every cell to a sheet coord.
  const cells: RenderCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const kind = kinds[y][x];
      let coord;
      if (kind === 'wall') coord = pickWall(x, y, kinds, width, height, skin, rng);
      else if (kind === 'door') coord = floorSet.main; // opening = the dungeon's floor
      else coord = pickFloor(floorSet, rng);
      cells.push({ x, y, kind, col: coord.col, row: coord.row });
    }
  }

  // 3) Decor on a few interior floor cells (deterministic).
  const interior: { x: number; y: number }[] = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) if (kinds[y][x] === 'floor') interior.push({ x, y });
  for (let i = interior.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [interior[i], interior[j]] = [interior[j], interior[i]];
  }
  const decorCount = skin.decor.length === 0 ? 0 : Math.min(interior.length, 6 + Math.floor(rng() * 7));
  const decor = [];
  for (let i = 0; i < decorCount; i++) {
    const d = skin.decor[Math.min(skin.decor.length - 1, Math.floor(rng() * skin.decor.length))];
    decor.push({ x: interior[i].x, y: interior[i].y, col: d.col, row: d.row });
  }

  return { width, height, skin: skinName, seed, cells, decor };
}

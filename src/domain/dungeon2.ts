import { makeRng } from './dungeon';
import { WALL_COLS, DOORS, pickWeighted, type TileCoord } from './tilesheet';
import { getDungeon, chooseGroup, pickCell, mainTile, type Dungeon, type FloorGroup } from './floorgroups';
import { type LogicalKind } from './autotile';
import { decorFor, COBWEB_HEAVY } from './decor';

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
// also handles interior walls / rooms later (T/L/cross masks).
//
// A DOOR is an OPENING, not wall. So for run/cap/corner logic doors count as NOT
// wall, which means:
//  - a wall run that MEETS a doorway CAPS at it (soft end piece = a beveled
//    doorframe) instead of butting it with a raw straight edge;
//  - a corner stays a corner only when BOTH its walls actually continue — a door
//    directly beside a corner degrades it to a beveled end (so the bevel faces the
//    door), rather than a raw corner face butting the opening;
//  - a 1-tile wall isolated BETWEEN two doorways uses a double-capped piece
//    (beveled on both ends), oriented to its border edge.
function pickWall(
  x: number, y: number, kinds: LogicalKind[][], w: number, h: number,
  dungeon: Dungeon, rng: () => number,
): TileCoord {
  const row = dungeon.wallRow;
  const C = (col: number): TileCoord => ({ col, row });
  const cracked = rng() < dungeon.wallVariantChance; // 1 rng/wall cell
  const isWall = (xx: number, yy: number) =>
    xx >= 0 && yy >= 0 && xx < w && yy < h && kinds[yy][xx] === 'wall';
  const N = isWall(x, y - 1), E = isWall(x + 1, y), S = isWall(x, y + 1), Wt = isWall(x - 1, y);
  if (E && Wt && !N && !S) return C(cracked ? WALL_COLS.crackedH : WALL_COLS.horizontal);
  if (N && S && !E && !Wt) return C(cracked ? WALL_COLS.crackedV : WALL_COLS.vertical);
  if (E && S && !N && !Wt) return C(WALL_COLS.tl);
  if (Wt && S && !N && !E) return C(WALL_COLS.tr);
  if (E && N && !S && !Wt) return C(WALL_COLS.bl);
  if (Wt && N && !S && !E) return C(WALL_COLS.br);
  if (Wt && !E && !N && !S) return C(WALL_COLS.rend); // wall to the west only -> east cap (meets a door/gap east)
  if (E && !Wt && !N && !S) return C(WALL_COLS.lend);
  if (N && !S && !E && !Wt) return C(WALL_COLS.bend); // wall to the north only -> south cap
  if (S && !N && !E && !Wt) return C(WALL_COLS.tend);
  return C(WALL_COLS.isolated); // 1-tile wall between two doorways: double-capped block
}

// `under`: an optional tile drawn BEHIND this cell's tile. Door tiles are
// transparent around the arch, so a door cell carries the dungeon's floor as its
// underlay — the renderer paints `under` first, then the door, so no black shows.
export interface RenderCell {
  x: number; y: number; kind: LogicalKind; col: number; row: number;
  under?: { col: number; row: number };
}
export interface AutoDungeon {
  width: number; height: number; dungeon: string; seed: number;
  cells: RenderCell[];
  decor: { x: number; y: number; col: number; row: number; walkable: boolean }[];
}
export interface GenOpts { width?: number; height?: number; }

export function generateAutotiledDungeon(
  dungeonName: string, seed: number, opts: GenOpts = {},
): AutoDungeon {
  const dungeon = getDungeon(dungeonName);
  if (!dungeon) throw new Error(`unknown dungeon: ${dungeonName}`);
  const width = opts.width ?? 20;
  const height = opts.height ?? 15;
  const rng = makeRng(scrambleSeed(seed));
  // One coherent floor group for the whole dungeon.
  const group: FloorGroup = chooseGroup(dungeonName, rng);
  const underlay = mainTile(group); // floor behind transparent door tiles

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
  // doors: 2-3 non-corner border cells, never adjacent to another door.
  const isDoorAt = (xx: number, yy: number) =>
    xx >= 0 && yy >= 0 && xx < width && yy < height && kinds[yy][xx] === 'door';
  const hasAdjacentDoor = (x: number, y: number) =>
    isDoorAt(x - 1, y) || isDoorAt(x + 1, y) || isDoorAt(x, y - 1) || isDoorAt(x, y + 1);
  const doorCount = 2 + Math.floor(rng() * 2);
  let guard = 0; let placed = 0;
  while (placed < doorCount && guard++ < 200) {
    const side = Math.floor(rng() * 4);
    let x = 0, y = 0;
    if (side === 0) { y = 0; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 1) { y = height - 1; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 2) { x = 0; y = 1 + Math.floor(rng() * (height - 2)); }
    else { x = width - 1; y = 1 + Math.floor(rng() * (height - 2)); }
    if (isCorner(x, y) || kinds[y][x] === 'door' || hasAdjacentDoor(x, y)) continue;
    kinds[y][x] = 'door'; placed++;
  }

  // 2) Resolve every cell to a sheet coord.
  const cells: RenderCell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const kind = kinds[y][x];
      let coord: TileCoord;
      let under: { col: number; row: number } | undefined;
      if (kind === 'wall') coord = pickWall(x, y, kinds, width, height, dungeon, rng);
      else if (kind === 'door') {
        coord = pickWeighted(DOORS, rng).coord;
        under = { col: underlay.col, row: underlay.row };
      } else coord = pickCell(group, rng);
      cells.push({ x, y, kind, col: coord.col, row: coord.row, under });
    }
  }

  // 3) Decor: corner cobwebs, wall torches, and floor scatter (clear of the monster zone).
  const pools = decorFor(dungeonName);
  const decor: { x: number; y: number; col: number; row: number; walkable: boolean }[] = [];
  const used = new Set<string>();
  const at2 = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const shuffle = <T>(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  };
  const place = (x: number, y: number, t: { col: number; row: number; walkable: boolean }) => {
    decor.push({ x, y, col: t.col, row: t.row, walkable: t.walkable }); used.add(`${x},${y}`);
  };
  // corners
  if (pools.corner.length) {
    const p = COBWEB_HEAVY.has(dungeonName) ? 0.85 : 0.5;
    for (const [cx, cy] of [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]] as const) {
      if (kinds[cy][cx] === 'floor' && rng() < p) place(cx, cy, at2(pools.corner));
    }
  }
  // wall torches (non-corner border walls, not doors)
  if (pools.wall.length) {
    const wallCells: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (kinds[y][x] === 'wall' && !isCorner(x, y)) wallCells.push({ x, y });
    shuffle(wallCells);
    const n = Math.min(6, Math.max(1, Math.floor(wallCells.length / 5)));
    for (let i = 0; i < n && i < wallCells.length; i++) place(wallCells[i].x, wallCells[i].y, at2(pools.wall));
  }
  // floor scatter, avoiding the fixed 2x2 monster zone + already-used cells
  const mx = Math.floor(width / 2) - 1, my = Math.floor(height / 2) - 1;
  const inMonster = (x: number, y: number) => x >= mx && x <= mx + 1 && y >= my && y <= my + 1;
  const floorCells: { x: number; y: number }[] = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      if (kinds[y][x] === 'floor' && !inMonster(x, y) && !used.has(`${x},${y}`)) floorCells.push({ x, y });
  shuffle(floorCells);
  if (pools.floor.length) {
    const n = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < n && i < floorCells.length; i++) place(floorCells[i].x, floorCells[i].y, at2(pools.floor));
  }

  return { width, height, dungeon: dungeonName, seed, cells, decor };
}

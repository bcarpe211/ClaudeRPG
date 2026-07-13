import { makeRng } from './dungeon';
import { WALL_COLS, DOORS, pickWeighted, type TileCoord } from './tilesheet';
import { getDungeon, chooseGroup, pickCell, mainTile, type Dungeon, type FloorGroup } from './floorgroups';
import { type LogicalKind } from './autotile';
import { decorFor, COBWEB_HEAVY } from './decor';
import { rugFor, RUG_CHANCE } from './rugs';

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
export function pickWall(
  x: number, y: number, kinds: LogicalKind[][], w: number, h: number,
  dungeon: Dungeon, rng: () => number,
): TileCoord {
  const row = dungeon.wallRow;
  const C = (col: number): TileCoord => ({ col, row });
  const cracked = rng() < dungeon.wallVariantChance; // 1 rng/wall cell
  const isWall = (xx: number, yy: number) =>
    xx >= 0 && yy >= 0 && xx < w && yy < h && kinds[yy][xx] === 'wall';
  const N = isWall(x, y - 1), E = isWall(x + 1, y), S = isWall(x, y + 1), Wt = isWall(x - 1, y);
  const nbrs = [N, E, S, Wt].filter(Boolean).length;
  if (nbrs === 4) return C(WALL_COLS.cross);
  if (nbrs === 3) {
    if (!N) return C(WALL_COLS.tOpenN);
    if (!E) return C(WALL_COLS.tOpenE);
    if (!S) return C(WALL_COLS.tOpenS);
    return C(WALL_COLS.tOpenW); // !Wt
  }
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
  decor: { x: number; y: number; col: number; row: number; walkable: boolean; animB?: { col: number; row: number } }[];
  monster: { x: number; y: number; footprint: number };
  arena: { x: number; y: number; w: number; h: number };
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
  // BSP: split the interior into 2-4 rooms with interior walls + a connecting door each.
  interface Rect { x: number; y: number; w: number; h: number; }
  // A split's wall (pos, on the vertical/horizontal axis) plus the range perpendicular
  // to it (lo..hi) that the door may land on. Door placement is deferred (see below).
  interface Split { vertical: boolean; pos: number; lo: number; hi: number; }
  const MIN_ROOM = 5;
  const targetRooms = 2 + Math.floor(rng() * 3); // 2-4
  const queue: Rect[] = [{ x: 1, y: 1, w: width - 2, h: height - 2 }];
  const leaves: Rect[] = [];
  const splits: Split[] = [];
  while (leaves.length + queue.length < targetRooms && queue.length > 0) {
    queue.sort((a, b) => b.w * b.h - a.w * a.h); // split the biggest
    const r = queue.shift()!;
    const canV = r.w >= MIN_ROOM * 2 + 1;
    const canH = r.h >= MIN_ROOM * 2 + 1;
    if (!canV && !canH) { leaves.push(r); continue; }
    const vertical = canV && (!canH || r.w >= r.h);
    if (vertical) {
      const wx = r.x + MIN_ROOM + Math.floor(rng() * (r.w - 2 * MIN_ROOM)); // keeps both halves >= MIN_ROOM
      for (let y = r.y; y < r.y + r.h; y++) kinds[y][wx] = 'wall';
      splits.push({ vertical: true, pos: wx, lo: r.y, hi: r.y + r.h - 1 });
      queue.push({ x: r.x, y: r.y, w: wx - r.x, h: r.h });
      queue.push({ x: wx + 1, y: r.y, w: r.x + r.w - 1 - wx, h: r.h });
    } else {
      const wy = r.y + MIN_ROOM + Math.floor(rng() * (r.h - 2 * MIN_ROOM));
      for (let x = r.x; x < r.x + r.w; x++) kinds[wy][x] = 'wall';
      splits.push({ vertical: false, pos: wy, lo: r.x, hi: r.x + r.w - 1 });
      queue.push({ x: r.x, y: r.y, w: r.w, h: wy - r.y });
      queue.push({ x: r.x, y: wy + 1, w: r.w, h: r.y + r.h - 1 - wy });
    }
  }
  leaves.push(...queue);
  const arena = leaves.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  // Place each split's connecting door AFTER every wall is drawn. A later, nested split's
  // own wall can cross the exact row/col an earlier split picked for its door (turning the
  // door's neighbor cell to wall), which would orphan that door and disconnect a room.
  // Choosing from the *final* wall layout — restricted to rows/cols still open on both
  // sides — guarantees every door actually connects floor to floor.
  for (const s of splits) {
    const candidates: number[] = [];
    for (let p = s.lo + 1; p <= s.hi - 1; p++) {
      const a = s.vertical ? kinds[p][s.pos - 1] : kinds[s.pos - 1][p];
      const b = s.vertical ? kinds[p][s.pos + 1] : kinds[s.pos + 1][p];
      if (a === 'floor' && b === 'floor') candidates.push(p);
    }
    const at = candidates.length ? candidates[Math.floor(rng() * candidates.length)] : Math.floor((s.lo + s.hi) / 2);
    if (candidates.length === 0) {
      // Degenerate case only (dungeon too small for MIN_ROOM headroom): force the
      // neighbor cells open so the door still connects both sides.
      if (s.vertical) { kinds[at][s.pos - 1] = 'floor'; kinds[at][s.pos + 1] = 'floor'; }
      else { kinds[s.pos - 1][at] = 'floor'; kinds[s.pos + 1][at] = 'floor'; }
    }
    if (s.vertical) kinds[at][s.pos] = 'door'; else kinds[s.pos][at] = 'door';
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
    const innerWall =
      (side === 0 && kinds[1][x] === 'wall') || (side === 1 && kinds[height - 2][x] === 'wall') ||
      (side === 2 && kinds[y][1] === 'wall') || (side === 3 && kinds[y][width - 2] === 'wall');
    if (isCorner(x, y) || kinds[y][x] === 'door' || hasAdjacentDoor(x, y) || innerWall) continue;
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
  const decor: { x: number; y: number; col: number; row: number; walkable: boolean; animB?: { col: number; row: number } }[] = [];
  const used = new Set<string>();
  const at2 = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const shuffle = <T>(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  };
  const place = (x: number, y: number, t: { col: number; row: number; walkable: boolean; animB?: { col: number; row: number } }) => {
    decor.push({ x, y, col: t.col, row: t.row, walkable: t.walkable, animB: t.animB }); used.add(`${x},${y}`);
  };
  const mx = arena.x + Math.floor(arena.w / 2) - 1, my = arena.y + Math.floor(arena.h / 2) - 1; // monster zone (2x2) top-left, inside the arena
  const inMonster = (x: number, y: number) => x >= mx && x <= mx + 1 && y >= my && y <= my + 1;
  // rug centerpiece (occasional) — placed FIRST so nothing overlaps it
  if (rng() < RUG_CHANCE) {
    const rx = mx - 1, ry = my - 1;
    const rugCells: [number, number][] = [];
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) rugCells.push([rx + dx, ry + dy]);
    const fits = rugCells.every(([x, y]) => x >= 1 && y >= 1 && x <= width - 2 && y <= height - 2 && kinds[y][x] === 'floor');
    if (fits) {
      const rug = rugFor(dungeonName, rng);
      for (const b of rug.border) place(rx + b.dx, ry + b.dy, { col: b.col, row: b.row, walkable: true });
      place(rx + 1, ry + 1, { col: rug.crest.col, row: rug.crest.row, walkable: true }); // center crest
    }
  }
  // corners
  if (pools.corner.length) {
    const p = COBWEB_HEAVY.has(dungeonName) ? 0.85 : 0.5;
    for (const rm of leaves)
      for (const [cx, cy] of [[rm.x, rm.y], [rm.x + rm.w - 1, rm.y], [rm.x, rm.y + rm.h - 1], [rm.x + rm.w - 1, rm.y + rm.h - 1]] as const)
        if (kinds[cy][cx] === 'floor' && !used.has(`${cx},${cy}`) && rng() < p) place(cx, cy, at2(pools.corner));
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
  const floorCells: { x: number; y: number }[] = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      if (kinds[y][x] === 'floor' && !inMonster(x, y) && !used.has(`${x},${y}`)) floorCells.push({ x, y });
  shuffle(floorCells);
  if (pools.floor.length) {
    const n = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < n && i < floorCells.length; i++) place(floorCells[i].x, floorCells[i].y, at2(pools.floor));
  }

  return { width, height, dungeon: dungeonName, seed, cells, decor,
           monster: { x: mx, y: my, footprint: 2 }, arena };
}

import { makeRng } from './dungeon';
import { getSkin, type Skin, type TileCoord } from './tilesheet';
import { resolveWall, resolveDoor, type LogicalKind } from './autotile';

// Themed dungeon floor: mostly the base floor (floors[0]), with sporadic accent
// tiles (floors[1..] — panel/cracked-stone/grid) and occasional cracked tiles.
const CRACK_CHANCE = 0.08;
const ACCENT_CHANCE = 0.2;
function pickThemedFloor(skin: Skin, rng: () => number): TileCoord {
  if (skin.crackedFloors.length > 0 && rng() < CRACK_CHANCE) {
    return skin.crackedFloors[Math.floor(rng() * skin.crackedFloors.length)];
  }
  if (skin.floors.length > 1 && rng() < ACCENT_CHANCE) {
    return skin.floors[1 + Math.floor(rng() * (skin.floors.length - 1))];
  }
  return skin.floors[0];
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
  const rng = makeRng(seed);

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
      if (kind === 'wall') coord = resolveWall(skin);
      else if (kind === 'door') coord = resolveDoor(skin);
      else coord = pickThemedFloor(skin, rng);
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

import { themeTiles } from './tilemanifest';

export interface Pos { x: number; y: number; }
export interface Cell { type: 'wall' | 'floor' | 'door'; sprite: string; }
export interface Decor { x: number; y: number; sprite: string; }
export interface DungeonLayout {
  width: number;
  height: number;
  theme: string;
  seed: number;
  cells: Cell[][]; // [y][x]
  doors: Pos[];
  monster: { x: number; y: number; footprint: number }; // reserved 2x2 anchor
  heroSlots: Pos[];
  decor: Decor[];
}

export interface GenerateOpts {
  width?: number;
  height?: number;
  heroSlots?: number;
}

/** Deterministic PRNG (mulberry32). Same seed -> same stream. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

export function generateDungeon(
  theme: string,
  seed: number,
  opts: GenerateOpts = {},
): DungeonLayout {
  const width = opts.width ?? 20;
  const height = opts.height ?? 15;
  const t = themeTiles(theme);
  const rng = makeRng(seed);
  const wallSprites = [t.wall, ...(t.wallVariants ?? [])];
  const floorSprites = [t.floor, ...t.floorVariants];

  const isEdge = (x: number, y: number) =>
    x === 0 || y === 0 || x === width - 1 || y === height - 1;
  const isCorner = (x: number, y: number) =>
    (x === 0 || x === width - 1) && (y === 0 || y === height - 1);

  // Base grid: border walls, interior floor (occasional variant).
  const cells: Cell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) {
      if (isEdge(x, y)) {
        row.push({ type: 'wall', sprite: pick(wallSprites, rng) });
      } else {
        const sprite = rng() < 0.15 ? pick(t.floorVariants, rng) : t.floor;
        row.push({ type: 'floor', sprite });
      }
    }
    cells.push(row);
  }

  // Doors: 2-4 non-corner border cells.
  const doorCount = 2 + Math.floor(rng() * 3);
  const doors: Pos[] = [];
  let guard = 0;
  while (doors.length < doorCount && guard++ < 200) {
    const side = Math.floor(rng() * 4);
    let x = 0, y = 0;
    if (side === 0) { y = 0; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 1) { y = height - 1; x = 1 + Math.floor(rng() * (width - 2)); }
    else if (side === 2) { x = 0; y = 1 + Math.floor(rng() * (height - 2)); }
    else { x = width - 1; y = 1 + Math.floor(rng() * (height - 2)); }
    if (isCorner(x, y)) continue;
    if (doors.some((d) => d.x === x && d.y === y)) continue;
    doors.push({ x, y });
    cells[y][x] = { type: 'door', sprite: t.door };
  }

  // Placement (monster zone, hero slots, decor) is filled in Task 3.
  const monster = { x: 0, y: 0, footprint: 2 };
  const heroSlots: Pos[] = [];
  const decor: Decor[] = [];

  return { width, height, theme, seed, cells, doors, monster, heroSlots, decor };
}

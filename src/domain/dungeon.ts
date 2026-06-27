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
        const sprite = rng() < 0.15 && t.floorVariants.length > 0 ? pick(t.floorVariants, rng) : t.floor;
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

  // Reserve a 2x2 monster zone near the centre (kept clear of decor/heroes).
  const monster = {
    x: Math.floor(width / 2) - 1,
    y: Math.floor(height / 2) - 1,
    footprint: 2,
  };
  const inMonster = (x: number, y: number) =>
    x >= monster.x && x <= monster.x + 1 && y >= monster.y && y <= monster.y + 1;

  // Candidate interior floor tiles (exclude border, doors, monster zone).
  const candidates: Pos[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (cells[y][x].type !== 'floor') continue;
      if (inMonster(x, y)) continue;
      candidates.push({ x, y });
    }
  }
  // Deterministic Fisher-Yates shuffle.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const heroSlotCount = Math.min(opts.heroSlots ?? 24, candidates.length);
  const heroSlots: Pos[] = candidates.slice(0, heroSlotCount);

  // Decor from the remaining candidates (never overlaps heroes/monster).
  const rest = candidates.slice(heroSlotCount);
  const decorCount = Math.min(rest.length, 6 + Math.floor(rng() * 7)); // 6-12
  const decor: Decor[] = [];
  for (let i = 0; i < decorCount; i++) {
    decor.push({ x: rest[i].x, y: rest[i].y, sprite: pick(t.decor, rng) });
  }

  return { width, height, theme, seed, cells, doors, monster, heroSlots, decor };
}

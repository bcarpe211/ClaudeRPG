import type Database from 'better-sqlite3';
import { generateAutotiledDungeon } from '../domain/dungeon2';
import { getDungeon } from '../domain/floorgroups';
import { makeRng } from '../domain/dungeon';

export interface TvLayoutCell {
  type: 'wall' | 'floor' | 'door';
  col: number; row: number;
  under?: { col: number; row: number };
  shadow?: boolean; // floor cell with a wall/door directly north -> draw the wall shadow
}
export interface TvLayout {
  dungeonId: number; theme: string; width: number; height: number;
  cells: TvLayoutCell[][];
  doors: { x: number; y: number }[];
  monster: { x: number; y: number; footprint: number };
  heroSlots: { x: number; y: number }[];
  decor: { x: number; y: number; col: number; row: number }[];
}

const FALLBACK_DUNGEON = 'Greystone Keep';
const MAX_HERO_SLOTS = 24;

/** Build the active dungeon's TV render payload from dungeon2, or null if none. */
export function currentTvLayout(db: Database.Database): TvLayout | null {
  const gs = db.prepare('SELECT current_dungeon_id FROM game_state WHERE id=1').get() as
    { current_dungeon_id: number | null } | undefined;
  if (!gs || !gs.current_dungeon_id) return null;
  const d = db.prepare('SELECT theme, seed FROM dungeons WHERE id=?')
    .get(gs.current_dungeon_id) as { theme: string; seed: number } | undefined;
  if (!d) return null;

  // Legacy/in-flight rows may hold an old theme (e.g. 'stone_crypt') that isn't a
  // dungeon2 name -> fall back so /tv never 500s; self-corrects on the next spawn.
  const primary = getDungeon(d.theme) ? d.theme : FALLBACK_DUNGEON;
  const tryGenerate = (n: string) => {
    try { return generateAutotiledDungeon(n, d.seed); } catch { return null; }
  };

  // generateAutotiledDungeon can also throw (e.g. no eligible floor group for a
  // theme, from a bad vendored-data edit) -> retry once with the fallback dungeon,
  // and give up gracefully (return null) rather than ever 500ing /tv.
  let name = primary;
  let auto = tryGenerate(name);
  if (!auto) {
    if (name === FALLBACK_DUNGEON) return null;
    name = FALLBACK_DUNGEON;
    auto = tryGenerate(name);
    if (!auto) return null;
  }
  const { width, height } = auto;

  // Flat cells -> [y][x] render payload; collect door positions.
  const cells: TvLayoutCell[][] = Array.from({ length: height }, () => new Array<TvLayoutCell>(width));
  const doors: { x: number; y: number }[] = [];
  for (const c of auto.cells) {
    cells[c.y][c.x] = { type: c.kind as 'wall' | 'floor' | 'door', col: c.col, row: c.row, under: c.under };
    if (c.kind === 'door') doors.push({ x: c.x, y: c.y });
  }

  // Wall shadow: a floor cell whose NORTH neighbour is a wall or door gets a shadow
  // (the wall casts it downward). Neighbour-based, so it also covers interior room
  // walls when those arrive later.
  for (let y = 1; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = cells[y][x];
      const n = cells[y - 1][x];
      if (c.type === 'floor' && n && (n.type === 'wall' || n.type === 'door')) c.shadow = true;
    }

  // Fixed 2x2 centre monster zone (drawn on top of floor).
  const monster = { x: Math.floor(width / 2) - 1, y: Math.floor(height / 2) - 1, footprint: 2 };
  const inMonster = (x: number, y: number) =>
    x >= monster.x && x <= monster.x + 1 && y >= monster.y && y <= monster.y + 1;

  // Hero slots: shuffled interior floor cells clear of the monster zone. Own
  // deterministic rng (dungeon2 doesn't expose its stream).
  const candidates: { x: number; y: number }[] = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      if (cells[y][x].type === 'floor' && !inMonster(x, y)) candidates.push({ x, y });
  const rng = makeRng(d.seed);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const heroSlots = candidates.slice(0, Math.min(MAX_HERO_SLOTS, candidates.length));

  const decor = auto.decor.map((p) => ({ x: p.x, y: p.y, col: p.col, row: p.row }));

  return { dungeonId: gs.current_dungeon_id, theme: name, width, height, cells, doors, monster, heroSlots, decor };
}

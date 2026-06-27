import type Database from 'better-sqlite3';
import { currentLayout } from '../domain/dungeon';
import { worldSpriteUrl } from '../domain/tilemanifest';

export interface TvLayoutCell { type: string; url: string; }
export interface TvLayout {
  dungeonId: number;
  theme: string;
  width: number;
  height: number;
  cells: TvLayoutCell[][];
  doors: { x: number; y: number }[];
  monster: { x: number; y: number; footprint: number };
  decor: { x: number; y: number; url: string }[];
}

/** Map the active dungeon layout to a sprite-URL payload for the TV, or null. */
export function buildTvLayout(db: Database.Database): TvLayout | null {
  const layout = currentLayout(db);
  if (!layout) return null;
  const gs = db.prepare('SELECT current_dungeon_id FROM game_state WHERE id=1').get() as any;
  return {
    dungeonId: gs.current_dungeon_id,
    theme: layout.theme,
    width: layout.width,
    height: layout.height,
    cells: layout.cells.map((row) =>
      row.map((c) => ({ type: c.type, url: worldSpriteUrl(c.sprite) })),
    ),
    doors: layout.doors,
    monster: layout.monster,
    decor: layout.decor.map((d) => ({ x: d.x, y: d.y, url: worldSpriteUrl(d.sprite) })),
  };
}

/** Zip players (in order) onto slot coordinates; extras get {x:null,y:null}. */
export function assignHeroSlots<T extends { id: number }>(
  players: T[],
  slots: { x: number; y: number }[],
): (T & { x: number | null; y: number | null })[] {
  return players.map((p, i) => ({
    ...p,
    x: i < slots.length ? slots[i].x : null,
    y: i < slots.length ? slots[i].y : null,
  }));
}

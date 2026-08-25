import type Database from 'better-sqlite3';
import { lastRaiderActivityAt } from './run-presence';

export interface GameState {
  id: number;
  current_dungeon_id: number | null;
  current_encounter_id: number | null;
  paused: number;
  last_activity_at: number | null;
  defeat_until: number | null;
  last_defeat_encounter_id: number | null;
  combat_active_ms: number;
}

export function getGameState(db: Database.Database): GameState {
  return db.prepare('SELECT * FROM game_state WHERE id=1').get() as GameState;
}

export function setPaused(db: Database.Database, paused: boolean, now: number): void {
  db.prepare(
    'UPDATE game_state SET paused=?, last_activity_at=? WHERE id=1',
  ).run(paused ? 1 : 0, now);
}

/** Latest enabled legacy or Run presence activity (0 if none). */
export function lastActivityAt(db: Database.Database): number {
  return lastRaiderActivityAt(db);
}

/** Office is idle if no activity exists, or last activity is older than the window. */
export function isIdle(db: Database.Database, now: number, pauseAfterMinutes: number): boolean {
  const last = lastActivityAt(db);
  if (last === 0) return true;
  return now - last > pauseAfterMinutes * 60_000;
}

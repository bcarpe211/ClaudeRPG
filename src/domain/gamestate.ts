import type Database from 'better-sqlite3';

export interface GameState {
  id: number;
  current_dungeon_id: number | null;
  current_encounter_id: number | null;
  paused: number;
  last_activity_at: number | null;
  defeat_until: number | null;
  last_defeat_encounter_id: number | null;
}

export function getGameState(db: Database.Database): GameState {
  return db.prepare('SELECT * FROM game_state WHERE id=1').get() as GameState;
}

export function setPaused(db: Database.Database, paused: boolean, now: number): void {
  db.prepare(
    'UPDATE game_state SET paused=?, last_activity_at=? WHERE id=1',
  ).run(paused ? 1 : 0, now);
}

/** Max last_token_at across all players (0 if none). */
export function lastActivityAt(db: Database.Database): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(last_token_at), 0) AS m FROM players',
  ).get() as { m: number };
  return row.m;
}

/** Office is idle if no tokens ever, or last activity is older than the window. */
export function isIdle(db: Database.Database, now: number, pauseAfterMinutes: number): boolean {
  const last = lastActivityAt(db);
  if (last === 0) return true;
  return now - last > pauseAfterMinutes * 60_000;
}

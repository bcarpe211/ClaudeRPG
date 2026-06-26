import type Database from 'better-sqlite3';
import type { Gender } from './classes';
import { randomToken } from './auth';

export interface Player {
  id: number;
  name: string;
  class_key: string;
  gender: Gender;
  auth_token: string;
  level: number;
  total_tokens: number;
  effective_tokens: number;
  gold: number;
  disabled: number;
  last_token_at: number | null;
  created_at: number;
}

export interface NewPlayer {
  name: string;
  class_key: string;
  gender: Gender;
}

export function createPlayer(
  db: Database.Database,
  input: NewPlayer,
  now: number,
): Player {
  const token = randomToken();
  const info = db
    .prepare(
      `INSERT INTO players (name, class_key, gender, auth_token, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.name, input.class_key, input.gender, token, now);
  return getPlayerById(db, Number(info.lastInsertRowid))!;
}

export function getPlayerById(
  db: Database.Database,
  id: number,
): Player | undefined {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) as
    | Player
    | undefined;
}

export function getPlayerByToken(
  db: Database.Database,
  token: string,
): Player | undefined {
  return db.prepare('SELECT * FROM players WHERE auth_token = ?').get(token) as
    | Player
    | undefined;
}

export function listPlayers(db: Database.Database): Player[] {
  return db
    .prepare('SELECT * FROM players ORDER BY created_at DESC, id DESC')
    .all() as Player[];
}

export function renamePlayer(
  db: Database.Database,
  id: number,
  name: string,
): void {
  db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
}

export type PlayerPatch = Partial<
  Pick<
    Player,
    'name' | 'class_key' | 'gender' | 'level' | 'gold' | 'disabled' |
    'total_tokens' | 'effective_tokens'
  >
>;

export function updatePlayer(
  db: Database.Database,
  id: number,
  patch: PlayerPatch,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE players SET ${set} WHERE id = @id`).run({ ...patch, id });
}

export function deletePlayer(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM players WHERE id = ?').run(id);
}

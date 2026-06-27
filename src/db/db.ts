import Database from 'better-sqlite3';
import { runMigrations } from './migrate';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // FULL (not the WAL default of NORMAL) fsyncs the WAL on every commit so
  // committed transactions survive power loss — this is a kiosk that gets
  // unplugged. NORMAL silently rolls back recent commits after a hard reset.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

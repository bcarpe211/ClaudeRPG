import type Database from 'better-sqlite3';
import { migrations } from './migrations';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((r: any) => r.id),
  );
  const insert = db.prepare(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );
  const tx = db.transaction(() => {
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      db.exec(m.sql);
      insert.run(m.id, Date.now());
    }
  });
  tx();
}

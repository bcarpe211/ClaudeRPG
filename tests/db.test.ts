import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../src/db/db';
import { migrations } from '../src/db/migrations';
import { createPlayer } from '../src/domain/players';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('openDb', () => {
  it('creates the players and settings tables', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('players');
    expect(tables).toContain('settings');
    expect(tables).toContain('_migrations');
  });

  it('is idempotent: running migrations twice does not error', () => {
    const db = openDb(':memory:');
    const count = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get() as any;
    expect(count.c).toBeGreaterThanOrEqual(2);
  });
});

describe('020_raider_presence migration', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('creates an empty player-keyed presence projection with cascade deletion', () => {
    const db = openDb(':memory:');
    try {
      const player = createPlayer(
        db,
        { name: 'Presence Raider', class_key: 'knight', gender: 'M' },
        1,
      );

      expect(db.prepare('SELECT COUNT(*) AS count FROM raider_presence').get())
        .toEqual({ count: 0 });
      expect(db.prepare('PRAGMA table_info(raider_presence)').all()).toEqual([
        expect.objectContaining({ name: 'player_id', type: 'INTEGER', pk: 1 }),
        expect.objectContaining({
          name: 'last_run_activity_at', type: 'INTEGER', notnull: 1, pk: 0,
        }),
      ]);
      expect(db.prepare('PRAGMA foreign_key_list(raider_presence)').all()).toEqual([
        expect.objectContaining({
          from: 'player_id', table: 'players', to: 'id', on_delete: 'CASCADE',
        }),
      ]);

      db.prepare(`
        INSERT INTO raider_presence (player_id, last_run_activity_at)
        VALUES (?, ?)
      `).run(player.id, Number.MAX_SAFE_INTEGER);
      db.prepare('DELETE FROM players WHERE id = ?').run(player.id);
      expect(db.prepare('SELECT COUNT(*) AS count FROM raider_presence').get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsafe presence timestamp: %s',
    (invalid) => {
      const db = openDb(':memory:');
      try {
        const player = createPlayer(
          db,
          { name: 'Checked Raider', class_key: 'wizard', gender: 'F' },
          1,
        );
        expect(() => db.prepare(`
          INSERT INTO raider_presence (player_id, last_run_activity_at)
          VALUES (?, ?)
        `).run(player.id, invalid)).toThrow();
      } finally {
        db.close();
      }
    },
  );

  it('does not backfill existing players and applies idempotently across reopens', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-rpg-presence-'));
    const path = join(dir, 'presence.db');
    const legacy = new Database(path);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE _migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    const record = legacy.prepare(
      'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
    );
    for (const migration of migrations.filter((item) => item.id !== '020_raider_presence')) {
      legacy.exec(migration.sql);
      record.run(migration.id, 1);
    }
    legacy.prepare(`
      INSERT INTO players (name, class_key, gender, auth_token, created_at)
      VALUES ('Legacy Raider', 'thief', 'M', 'legacy-token', 1)
    `).run();
    legacy.close();

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const db = openDb(path);
      try {
        expect(db.prepare('SELECT COUNT(*) AS count FROM raider_presence').get())
          .toEqual({ count: 0 });
        expect(db.prepare(`
          SELECT COUNT(*) AS count FROM _migrations WHERE id = '020_raider_presence'
        `).get()).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    }
  });
});

describe('openDb durability (power-loss safety)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('uses WAL with synchronous=FULL so committed writes survive power loss', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-rpg-db-'));
    const db = openDb(join(dir, 'durability.db'));

    const journal = db.pragma('journal_mode', { simple: true });
    const synchronous = db.pragma('synchronous', { simple: true });

    expect(journal).toBe('wal');
    // 2 === FULL: WAL is fsync'd on every commit. NORMAL (1) can lose
    // committed transactions on power loss; that is the bug this guards.
    expect(synchronous).toBe(2);
  });
});

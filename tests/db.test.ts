import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../src/db/db';
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

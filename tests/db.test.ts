import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

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

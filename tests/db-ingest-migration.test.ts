import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('ingestion migration', () => {
  it('creates token_events and metric_series tables', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('token_events');
    expect(tables).toContain('metric_series');
  });

  it('token_events has an index on (player_id, ts)', () => {
    const db = openDb(':memory:');
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: any) => r.name);
    expect(idx).toContain('idx_token_events_player_ts');
  });
});

import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('ingestion migration', () => {
  it('creates token events, cumulative checkpoints, and delivery identities', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('token_events');
    expect(tables).toContain('metric_series');
    expect(tables).toContain('metric_deliveries');
    expect(db.prepare('PRAGMA table_info(metric_deliveries)').all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'series_key', pk: 1 }),
        expect.objectContaining({ name: 'time_unix_nano', pk: 2 }),
        expect.objectContaining({ name: 'received_at' }),
      ]));
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

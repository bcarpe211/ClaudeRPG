import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { migrations } from '../src/db/migrations';

describe('OTLP delivery identity upgrade', () => {
  it('adds durable delivery keys without disturbing cumulative checkpoints', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-otlp-upgrade-'));
    const dbPath = join(fixtureDir, 'pre-delivery-keys.db');
    let upgraded: Database.Database | undefined;
    try {
      const legacy = new Database(dbPath);
      legacy.exec(
        'CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
      );
      const record = legacy.prepare(
        'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
      );
      for (const [index, migration] of migrations.slice(0, 16).entries()) {
        legacy.exec(migration.sql);
        record.run(migration.id, 1_000 + index);
      }
      legacy.prepare(
        `INSERT INTO metric_series (series_key, last_value, updated_at)
         VALUES ('legacy|input|model|start', 1234, 5678)`,
      ).run();
      legacy.close();

      upgraded = openDb(dbPath);

      expect(upgraded.prepare(
        'SELECT series_key, last_value, updated_at FROM metric_series',
      ).all()).toEqual([{
        series_key: 'legacy|input|model|start',
        last_value: 1234,
        updated_at: 5678,
      }]);
      expect(upgraded.prepare(
        'SELECT series_key, time_unix_nano, received_at FROM metric_deliveries',
      ).all()).toEqual([]);
      expect(upgraded.prepare(
        'SELECT id FROM _migrations WHERE id=?',
      ).get('017_otlp_delivery_keys')).toEqual({
        id: '017_otlp_delivery_keys',
      });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

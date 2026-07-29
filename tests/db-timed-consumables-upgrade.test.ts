import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { migrations } from '../src/db/migrations';

const columns = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name);

describe('timed-consumables database upgrades', () => {
  it('preserves a live encounter and records one opening ledger balance', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'pre-timed-consumables.db');
    let upgraded: Database.Database | undefined;
    try {
      const legacy = new Database(dbPath);
      legacy.pragma('foreign_keys = ON');
      legacy.exec(`
        CREATE TABLE _migrations (
          id TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        )
      `);
      const recordMigration = legacy.prepare(
        'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
      );
      for (const [index, migration] of migrations.slice(0, 11).entries()) {
        legacy.exec(migration.sql);
        recordMigration.run(migration.id, 1_000 + index);
      }

      legacy.prepare(
        `INSERT INTO players
         (id, name, class_key, gender, auth_token, gold, created_at)
         VALUES (1, 'Legacy Hero', 'wizard', 'M', 'legacy-token', 7654321, 1111)`,
      ).run();
      const dungeon = legacy.prepare(
        'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (4, ?, 42, 3, 4000)',
      ).run('Ossuary Pale');
      const encounter = legacy.prepare(
        `INSERT INTO encounters
         (dungeon_id, index_in_dungeon, kind, creature_index, footprint, pack_count,
          max_hp, current_hp, status, started_at)
         VALUES (?, 2, 'boss', 9, 2, 1, 5000, 3200, 'active', 5000)`,
      ).run(Number(dungeon.lastInsertRowid));
      legacy.close();

      upgraded = openDb(dbPath);

      expect(upgraded.prepare('SELECT gold FROM players WHERE id = 1').get())
        .toEqual({ gold: 7654321 });
      expect(upgraded.prepare(
        'SELECT id, status, reward_model_version FROM encounters WHERE id = ?',
      ).get(Number(encounter.lastInsertRowid))).toEqual({
        id: Number(encounter.lastInsertRowid), status: 'active', reward_model_version: 'legacy-v0',
      });
      expect(upgraded.prepare(
        `SELECT amount, balance_after, reason
         FROM gold_ledger WHERE player_id = 1 AND reason = 'opening_balance'`,
      ).all()).toEqual([{
        amount: 7654321, balance_after: 7654321, reason: 'opening_balance',
      }]);
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('adds immutable retry stock snapshots to an existing 012 database', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'timed-consumables-012.db');
    let upgraded: Database.Database | undefined;
    try {
      const legacy = new Database(dbPath);
      legacy.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      const recordMigration = legacy.prepare(
        'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
      );
      for (const [index, migration] of migrations.slice(0, 12).entries()) {
        legacy.exec(migration.sql);
        recordMigration.run(migration.id, 1_000 + index);
      }
      legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('potion_daily_stock_per_sku', '3');
      legacy.prepare(
        `INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
         VALUES (1, 'Snapshot Hero', 'wizard', 'M', 'snapshot-token', 1111)`,
      ).run();
      legacy.prepare(
        `INSERT INTO shop_purchases
          (player_id, sku, quantity, unit_price, total_price, office_day, request_id,
           inventory_after, gold_after, created_at)
         VALUES (1, 'potion_gold_t1', 1, 100000, 100000, '2026-07-28', 'legacy-purchase', 1, 0, 1111)`,
      ).run();
      legacy.close();

      upgraded = openDb(dbPath);

      expect(columns(upgraded, 'shop_purchases')).toContain('stock_remaining_after');
      expect(upgraded.prepare('SELECT stock_remaining_after FROM shop_purchases WHERE id = 1').get())
        .toEqual({ stock_remaining_after: 2 });
      expect(upgraded.prepare('SELECT id FROM _migrations WHERE id = ?').get('013_shop_purchase_stock_snapshot'))
        .toEqual({ id: '013_shop_purchase_stock_snapshot' });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

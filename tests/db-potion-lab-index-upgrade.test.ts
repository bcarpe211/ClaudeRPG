import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { migrations } from '../src/db/migrations';

const POTION_LAB_INDEXES = [
  'idx_potion_lab_activations_activated',
  'idx_potion_lab_activations_player_activated',
  'idx_potion_lab_activations_sku_activated',
  'idx_potion_lab_activations_readiness',
  'idx_potion_lab_purchases_created',
  'idx_potion_lab_purchases_player_created',
  'idx_potion_lab_purchases_sku_created',
  'idx_potion_lab_ledger_created',
  'idx_potion_lab_ledger_player_created',
];

describe('Potion Lab index upgrade', () => {
  it('adds ordered report indexes without changing existing potion history', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-lab-upgrade-'));
    const dbPath = join(fixtureDir, 'pre-lab-indexes.db');
    let upgraded: Database.Database | undefined;
    try {
      const legacy = new Database(dbPath);
      legacy.exec(
        'CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
      );
      const record = legacy.prepare(
        'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
      );
      for (const [index, migration] of migrations.slice(0, 17).entries()) {
        legacy.exec(migration.sql);
        record.run(migration.id, 1_000 + index);
      }
      legacy.prepare(
        `INSERT INTO players
          (id, name, class_key, gender, auth_token, created_at)
         VALUES (1, 'Upgrade Hero', 'wizard', 'F', 'upgrade-token', 1)`,
      ).run();
      const purchaseId = Number(legacy.prepare(
        `INSERT INTO shop_purchases
          (player_id, sku, quantity, unit_price, total_price, office_day,
           request_id, inventory_after, gold_after, created_at)
         VALUES (1, 'potion_gold_t1', 1, 100000, 100000, '2026-07-29',
                 'upgrade-purchase', 1, 0, 1000)`,
      ).run().lastInsertRowid);
      legacy.prepare(
        `INSERT INTO potion_activations
          (player_id, sku, potion_type, tier, purchase_id, purchase_unit_price,
           request_id, activation_day, activated_at, start_game_ms,
           expires_game_ms, status, effect_snapshot)
         VALUES (1, 'potion_gold_t1', 'gold', 1, ?, 100000,
                 'upgrade-activation', '2026-07-29', 2000, 0, 7200000,
                 'active', '{}')`,
      ).run(purchaseId);
      legacy.close();

      upgraded = openDb(dbPath);

      expect(upgraded.prepare(
        `SELECT request_id, activated_at
         FROM potion_activations`,
      ).all()).toEqual([{
        request_id: 'upgrade-activation',
        activated_at: 2000,
      }]);
      const indexes = (upgraded.prepare(
        "SELECT name FROM sqlite_master WHERE type='index'",
      ).all() as { name: string }[]).map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining(POTION_LAB_INDEXES));
      expect(upgraded.prepare(
        'SELECT id FROM _migrations WHERE id=?',
      ).get('018_potion_lab_query_indexes')).toEqual({
        id: '018_potion_lab_query_indexes',
      });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

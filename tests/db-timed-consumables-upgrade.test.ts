import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { migrations } from '../src/db/migrations';
import { GameEngine } from '../src/domain/engine';

const columns = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name);

function create012PurchaseDatabase(dbPath: string, dailyStock: string): void {
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
    .run('potion_daily_stock_per_sku', dailyStock);
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
}

function create013ActivationDatabase(dbPath: string): void {
  const legacy = new Database(dbPath);
  legacy.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const recordMigration = legacy.prepare(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );
  for (const [index, migration] of migrations.slice(0, 13).entries()) {
    legacy.exec(migration.sql);
    recordMigration.run(migration.id, 1_000 + index);
  }
  legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run('potion_daily_uses_per_type', '3');
  legacy.prepare(
    `INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
     VALUES (1, 'Activation Hero', 'wizard', 'M', 'activation-token', 1000)`,
  ).run();
  const purchase = legacy.prepare(
    `INSERT INTO shop_purchases
      (player_id, sku, quantity, unit_price, total_price, office_day, request_id,
       inventory_after, gold_after, created_at, stock_remaining_after)
     VALUES (1, 'potion_gold_t1', 3, 100000, 300000, '2026-07-28',
             'legacy-purchase', 3, 0, 1000, 0)`,
  ).run();
  legacy.prepare(
    `INSERT INTO player_inventory
      (player_id, sku, quantity, updated_at)
     VALUES (1, 'potion_gold_t1', 2, 2000)`,
  ).run();
  legacy.prepare(
    `INSERT INTO player_inventory_lots
      (purchase_id, player_id, sku, remaining_quantity, unit_price, purchased_at)
     VALUES (?, 1, 'potion_gold_t1', 2, 100000, 1000)`,
  ).run(Number(purchase.lastInsertRowid));
  legacy.prepare(
    `INSERT INTO potion_activations
      (player_id, sku, potion_type, tier, purchase_id, purchase_unit_price,
       request_id, activation_day, activated_at, start_game_ms, expires_game_ms,
       status, completed_at, effect_snapshot)
     VALUES (1, 'potion_gold_t1', 'gold', 1, ?, 100000, 'legacy-activation',
             '2026-07-28', 2000, 0, 7200000, 'completed', 3000, ?)`,
  ).run(
    Number(purchase.lastInsertRowid),
    JSON.stringify({
      kind: 'gold', durationMs: 7_200_000, tokenUnit: 1_000,
      goldPerUnit: 50, baseCap: 125_000,
      stretchTokens: 2_500_000, stretchBonus: 25_000,
    }),
  );
  legacy.close();
}

function create014RewardPoolDatabase(dbPath: string, goldFactor = '0.5'): {
  activeHybridId: number;
  defeatedHybridId: number;
  legacyId: number;
} {
  const legacy = new Database(dbPath);
  legacy.pragma('foreign_keys = ON');
  legacy.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const recordMigration = legacy.prepare(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );
  for (const [index, migration] of migrations.slice(0, 14).entries()) {
    legacy.exec(migration.sql);
    recordMigration.run(migration.id, 1_000 + index);
  }
  legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run('gold_factor', goldFactor);
  legacy.prepare(
    `INSERT INTO players
      (id, name, class_key, gender, auth_token, created_at)
     VALUES (1, 'Reward Hero', 'wizard', 'M', 'reward-token', 1000)`,
  ).run();
  const dungeon = legacy.prepare(
    `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
     VALUES (3, 'Ossuary Pale', 42, 3, 1000)`,
  ).run();
  const insertEncounter = legacy.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at, ended_at,
       reward_model_version, reward_work_pct, reward_damage_pct,
       reward_podium_first_pct, reward_podium_second_pct,
       reward_podium_third_pct)
     VALUES (?, ?, 'single', 1, 1, 1, 101, ?, ?, 2000, ?, ?, 80, 10, 5, 3, 2)`,
  );
  const activeHybridId = Number(insertEncounter.run(
    Number(dungeon.lastInsertRowid),
    0,
    101,
    'active',
    null,
    'hybrid-v1',
  ).lastInsertRowid);
  const defeatedHybridId = Number(insertEncounter.run(
    Number(dungeon.lastInsertRowid),
    1,
    0,
    'defeated',
    3000,
    'hybrid-v1',
  ).lastInsertRowid);
  const legacyId = Number(insertEncounter.run(
    Number(dungeon.lastInsertRowid),
    2,
    101,
    'active',
    null,
    'legacy-v0',
  ).lastInsertRowid);
  legacy.prepare(
    `INSERT INTO encounter_reward_awards
      (encounter_id, player_id, effective_tokens, damage_total,
       potion_bonus_damage, damage_rank, work_gold, damage_gold,
       podium_gold, total_gold, model_version, awarded_at)
     VALUES (?, 1, 100, 100, 0, 1, 60, 10, 7, 77, 'hybrid-v1', 3000)`,
  ).run(defeatedHybridId);
  legacy.close();
  return { activeHybridId, defeatedHybridId, legacyId };
}

function prepareResolvableHybridDatabase(dbPath: string, encounterId: number): void {
  const legacy = new Database(dbPath);
  legacy.pragma('foreign_keys = ON');
  const encounter = legacy.prepare(
    'SELECT dungeon_id FROM encounters WHERE id=?',
  ).get(encounterId) as { dungeon_id: number };
  legacy.prepare('UPDATE encounters SET current_hp=0 WHERE id=?').run(encounterId);
  legacy.prepare(
    `INSERT INTO encounter_damage
      (encounter_id, player_id, damage_total, hits, max_hit, potion_bonus_damage)
     VALUES (?, 1, 100, 1, 100, 0)`,
  ).run(encounterId);
  legacy.prepare(
    `UPDATE game_state
     SET current_dungeon_id=?, current_encounter_id=?, last_activity_at=2000, paused=0
     WHERE id=1`,
  ).run(encounter.dungeon_id, encounterId);
  legacy.prepare('UPDATE players SET last_token_at=2000 WHERE id=1').run();
  legacy.close();
}

function create015UnsafeRewardPoolDatabase(dbPath: string): {
  activeHybridId: number;
  defeatedHybridId: number;
  missingHybridId: number;
  legacyId: number;
} {
  const fixture = create014RewardPoolDatabase(dbPath, '1e999');
  const legacy = new Database(dbPath);
  legacy.exec(`
    ALTER TABLE encounters
      ADD COLUMN reward_gold_pool INTEGER
      CHECK (
        reward_gold_pool IS NULL
        OR (
          typeof(reward_gold_pool) = 'integer'
          AND reward_gold_pool >= 0
        )
      );

    UPDATE encounters
    SET reward_gold_pool = COALESCE(
      (
        SELECT SUM(award.total_gold)
        FROM encounter_reward_awards AS award
        WHERE award.encounter_id = encounters.id
      ),
      CAST(ROUND(
        encounters.max_hp
        * (
            SELECT dungeon.level
            FROM dungeons AS dungeon
            WHERE dungeon.id = encounters.dungeon_id
          )
        * CASE
            WHEN json_valid(TRIM(COALESCE(
              (SELECT value FROM settings WHERE key = 'gold_factor'),
              ''
            ))) = 1
            AND json_type(TRIM((
              SELECT value FROM settings WHERE key = 'gold_factor'
            ))) IN ('integer', 'real')
            AND json_extract(TRIM((
              SELECT value FROM settings WHERE key = 'gold_factor'
            )), '$') >= 0
            THEN json_extract(TRIM((
              SELECT value FROM settings WHERE key = 'gold_factor'
            )), '$')
            ELSE 0.01
          END
      ) AS INTEGER)
    )
    WHERE reward_model_version = 'hybrid-v1';
  `);
  legacy.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)')
    .run('015_encounter_reward_gold_pool', 2_000);
  const dungeon = legacy.prepare(
    'SELECT dungeon_id FROM encounters WHERE id=?',
  ).get(fixture.activeHybridId) as { dungeon_id: number };
  const missingHybridId = Number(legacy.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at,
       reward_model_version, reward_work_pct, reward_damage_pct,
       reward_podium_first_pct, reward_podium_second_pct,
       reward_podium_third_pct)
     VALUES (?, 3, 'single', 1, 1, 1, 101, 101, 'active', 2000,
             'hybrid-v1', 80, 10, 5, 3, 2)`,
  ).run(dungeon.dungeon_id).lastInsertRowid);
  const historicalActive = legacy.prepare(
    'SELECT reward_gold_pool FROM encounters WHERE id=?',
  ).get(fixture.activeHybridId) as { reward_gold_pool: number | null };
  expect(
    historicalActive.reward_gold_pool === null
      || historicalActive.reward_gold_pool > Number.MAX_SAFE_INTEGER,
  ).toBe(true);
  expect(legacy.prepare(
    'SELECT reward_gold_pool FROM encounters WHERE id=?',
  ).get(missingHybridId)).toEqual({ reward_gold_pool: null });
  legacy.close();
  prepareResolvableHybridDatabase(dbPath, fixture.activeHybridId);
  return { ...fixture, missingHybridId };
}

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
      create012PurchaseDatabase(dbPath, '5');

      upgraded = openDb(dbPath);

      expect(columns(upgraded, 'shop_purchases')).toContain('stock_remaining_after');
      expect(upgraded.prepare('SELECT stock_remaining_after FROM shop_purchases WHERE id = 1').get())
        .toEqual({ stock_remaining_after: 4 });
      expect(upgraded.prepare('SELECT id FROM _migrations WHERE id = ?').get('013_shop_purchase_stock_snapshot'))
        .toEqual({ id: '013_shop_purchase_stock_snapshot' });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('adds deterministic activation-response snapshots to an existing 013 database', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'timed-consumables-013.db');
    let upgraded: Database.Database | undefined;
    try {
      create013ActivationDatabase(dbPath);

      upgraded = openDb(dbPath);

      expect(columns(upgraded, 'potion_activations')).toEqual(expect.arrayContaining([
        'inventory_remaining_after', 'uses_remaining_after', 'initial_state',
      ]));
      expect(upgraded.prepare(
        `SELECT inventory_remaining_after, uses_remaining_after, initial_state
         FROM potion_activations WHERE request_id = 'legacy-activation'`,
      ).get()).toEqual({
        inventory_remaining_after: 2,
        uses_remaining_after: 2,
        initial_state: 'armed',
      });
      expect(upgraded.prepare(
        'SELECT id FROM _migrations WHERE id = ?',
      ).get('014_potion_activation_response_snapshots')).toEqual({
        id: '014_potion_activation_response_snapshots',
      });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('backfills immutable hybrid reward pools while leaving legacy encounters untouched', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'timed-consumables-014.db');
    let upgraded: Database.Database | undefined;
    try {
      const fixture = create014RewardPoolDatabase(dbPath);
      upgraded = openDb(dbPath);

      expect(columns(upgraded, 'encounters')).toContain('reward_gold_pool');
      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.activeHybridId)).toEqual({ reward_gold_pool: 152 });
      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.defeatedHybridId)).toEqual({ reward_gold_pool: 77 });
      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.legacyId)).toEqual({ reward_gold_pool: null });
      expect(upgraded.prepare(
        'SELECT id FROM _migrations WHERE id=?',
      ).get('015_encounter_reward_gold_pool')).toEqual({
        id: '015_encounter_reward_gold_pool',
      });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('uses the canonical runtime fallback for a non-finite pre-015 reward factor and resolves safely', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'timed-consumables-infinite-factor-014.db');
    let upgraded: Database.Database | undefined;
    try {
      const fixture = create014RewardPoolDatabase(dbPath, '1e999');
      prepareResolvableHybridDatabase(dbPath, fixture.activeHybridId);

      upgraded = openDb(dbPath);

      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.activeHybridId)).toEqual({ reward_gold_pool: 3 });
      expect(() => upgraded!.exec(
        `UPDATE encounters SET reward_gold_pool=9007199254740992
         WHERE id=${fixture.activeHybridId}`,
      )).toThrow();

      const engine = new GameEngine(upgraded, { rng: () => 0.5 });
      engine.tick(2_000);

      expect(upgraded.prepare(
        'SELECT status, reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.activeHybridId)).toEqual({
        status: 'defeated',
        reward_gold_pool: 3,
      });
      expect(upgraded.prepare(
        'SELECT SUM(total_gold) AS total FROM encounter_reward_awards WHERE encounter_id=?',
      ).get(fixture.activeHybridId)).toEqual({ total: 3 });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('repairs genuine historical-015 unsafe and missing pools and resolves safely', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'timed-consumables-infinite-factor-015.db');
    let upgraded: Database.Database | undefined;
    try {
      const fixture = create015UnsafeRewardPoolDatabase(dbPath);

      upgraded = openDb(dbPath);

      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.activeHybridId)).toEqual({ reward_gold_pool: 3 });
      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.missingHybridId)).toEqual({ reward_gold_pool: 3 });
      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.defeatedHybridId)).toEqual({ reward_gold_pool: 77 });
      expect(upgraded.prepare(
        'SELECT reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.legacyId)).toEqual({ reward_gold_pool: null });
      expect(upgraded.prepare(
        'SELECT id FROM _migrations WHERE id=?',
      ).get('016_safe_encounter_reward_gold_pool')).toEqual({
        id: '016_safe_encounter_reward_gold_pool',
      });

      const engine = new GameEngine(upgraded, { rng: () => 0.5 });
      engine.tick(2_000);

      expect(upgraded.prepare(
        'SELECT status, reward_gold_pool FROM encounters WHERE id=?',
      ).get(fixture.activeHybridId)).toEqual({
        status: 'defeated',
        reward_gold_pool: 3,
      });
      expect(upgraded.prepare(
        'SELECT SUM(total_gold) AS total FROM encounter_reward_awards WHERE encounter_id=?',
      ).get(fixture.activeHybridId)).toEqual({ total: 3 });
      expect(() => upgraded!.exec(
        `UPDATE encounters SET reward_gold_pool=9007199254740992
         WHERE id=${fixture.activeHybridId}`,
      )).toThrow();
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['invalid text', 'invalid'],
    ['malformed numeric prefix', '4oops'],
    ['non-JSON numeric text', '0x10'],
    ['negative value', '-1'],
    ['fractional value', '1.5'],
    ['unsafe integer', '9007199254740992'],
  ])('uses the runtime default for a %s daily-stock setting', (_label, dailyStock) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'timed-consumables-invalid-setting.db');
    let upgraded: Database.Database | undefined;
    try {
      create012PurchaseDatabase(dbPath, dailyStock);
      upgraded = openDb(dbPath);

      expect(upgraded.prepare('SELECT stock_remaining_after FROM shop_purchases WHERE id = 1').get())
        .toEqual({ stock_remaining_after: 2 });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

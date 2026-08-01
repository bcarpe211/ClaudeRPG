import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { migrations } from '../src/db/migrations';

const TABLES = [
  'raider_identities',
  'raider_enrollments',
  'raider_devices',
  'runs',
  'run_events',
];

const RUN_SAFE_COLUMNS = [
  'usage_input',
  'usage_output',
  'usage_cache_read',
  'usage_cache_write',
  'usage_reasoning_output',
  'awarded_usage_credit',
  'awarded_completion_credit',
  'awarded_duration_credit',
  'raid_power',
];

const EVENT_SAFE_COLUMNS = [
  'usage_input',
  'usage_output',
  'usage_cache_read',
  'usage_cache_write',
  'usage_reasoning_output',
  'awarded_delta',
];

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name);
}

function primaryKey(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
}

function uniqueIndexes(db: Database.Database, table: string): string[][] {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
    unique: number;
  }[];
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) => (db.prepare(`PRAGMA index_info(${index.name})`).all() as {
      name: string;
      seqno: number;
    }[])
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => column.name));
}

function foreignKeys(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }[])
    .map((key) => `${key.from}->${key.table}.${key.to}:${key.on_delete}`)
    .sort();
}

function insertRunFixture(db: Database.Database): number {
  return Number(db.prepare(`
    INSERT INTO runs
      (player_id, provider, surface, run_key, state, started_at_ms,
       last_event_at_ms, last_observed_at_ms, policy_version, created_at, updated_at)
    VALUES
      (1, 'codex', 'codex_desktop', ?, 'open', 1000, 1100, 1200,
       'raid-power-v1', 1200, 1200)
  `).run('a'.repeat(64)).lastInsertRowid);
}

function insertEventFixture(db: Database.Database, runId: number): void {
  db.prepare(`
    INSERT INTO run_events
      (event_key, run_id, device_id, sequence, schema_version, companion_version,
       provider, surface, run_key, event_time_ms, observed_at_ms, started_at_ms,
       state, policy_version, received_at)
    VALUES
      (?, ?, '11111111-1111-4111-8111-111111111111', 1, 1, '0.1.0',
       'codex', 'codex_desktop', ?, 1100, 1200, 1000, 'open',
       'raid-power-v1', 1200)
  `).run('b'.repeat(64), runId, 'a'.repeat(64));
}

describe('019_runtime_raiders_runs migration', () => {
  it('creates the five persistence tables with durable relationships and identities', () => {
    const db = openDb(':memory:');
    try {
      const tables = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'",
      ).all() as { name: string }[]).map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(TABLES));

      expect(columns(db, 'raider_identities')).toEqual([
        'player_id', 'dedupe_secret', 'created_at',
      ]);
      expect(columns(db, 'raider_enrollments')).toEqual([
        'code_hash', 'player_id', 'created_at', 'expires_at', 'consumed_at',
      ]);
      expect(columns(db, 'raider_devices')).toEqual([
        'device_id', 'player_id', 'token_hash', 'companion_version',
        'created_at', 'last_seen_at', 'revoked_at',
      ]);
      expect(columns(db, 'runs')).toEqual([
        'id', 'player_id', 'provider', 'surface', 'run_key', 'state',
        'started_at_ms', 'terminal_at_ms', 'last_event_at_ms',
        'last_observed_at_ms', 'usage_input', 'usage_output', 'usage_cache_read',
        'usage_cache_write', 'usage_reasoning_output', 'latest_model',
        'latest_effort', 'policy_version', 'awarded_usage_credit',
        'awarded_completion_credit', 'awarded_duration_credit', 'raid_power',
        'created_at', 'updated_at',
      ]);
      expect(columns(db, 'run_events')).toEqual([
        'event_key', 'run_id', 'device_id', 'sequence', 'schema_version',
        'companion_version', 'provider', 'surface', 'run_key', 'event_time_ms',
        'observed_at_ms', 'started_at_ms', 'state', 'usage_input',
        'usage_output', 'usage_cache_read', 'usage_cache_write',
        'usage_reasoning_output', 'model', 'effort', 'policy_version',
        'awarded_delta', 'received_at',
      ]);

      expect(primaryKey(db, 'raider_identities')).toEqual(['player_id']);
      expect(primaryKey(db, 'run_events')).toEqual(['event_key']);
      expect(uniqueIndexes(db, 'raider_devices')).toContainEqual(['token_hash']);
      expect(uniqueIndexes(db, 'runs')).toContainEqual(['player_id', 'provider', 'run_key']);
      expect(uniqueIndexes(db, 'run_events')).toContainEqual(['run_id', 'sequence']);

      expect(foreignKeys(db, 'raider_identities')).toEqual([
        'player_id->players.id:CASCADE',
      ]);
      expect(foreignKeys(db, 'raider_enrollments')).toEqual([
        'player_id->raider_identities.player_id:CASCADE',
      ]);
      expect(foreignKeys(db, 'raider_devices')).toEqual([
        'player_id->raider_identities.player_id:CASCADE',
      ]);
      expect(foreignKeys(db, 'runs')).toEqual([
        'player_id->raider_identities.player_id:CASCADE',
      ]);
      expect(foreignKeys(db, 'run_events')).toEqual([
        'device_id->raider_devices.device_id:CASCADE',
        'run_id->runs.id:CASCADE',
      ]);
      expect(db.prepare('SELECT id FROM _migrations WHERE id = ?').get(
        '019_runtime_raiders_runs',
      )).toEqual({ id: '019_runtime_raiders_runs' });
    } finally {
      db.close();
    }
  });

  it('enforces enum, identity, and non-negative safe-integer constraints', () => {
    const db = openDb(':memory:');
    try {
      db.prepare(`
        INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
        VALUES (1, 'Run Hero', 'wizard', 'F', 'run-token', 1)
      `).run();
      db.prepare(`
        INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
        VALUES (1, ?, 1)
      `).run('c'.repeat(64));
      db.prepare(`
        INSERT INTO raider_devices
          (device_id, player_id, token_hash, companion_version, created_at)
        VALUES ('11111111-1111-4111-8111-111111111111', 1, ?, '0.1.0', 1)
      `).run('d'.repeat(64));

      const runId = insertRunFixture(db);
      insertEventFixture(db, runId);

      for (const column of RUN_SAFE_COLUMNS) {
        for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(() => db.prepare(`UPDATE runs SET ${column} = ? WHERE id = ?`)
            .run(invalid, runId), `${column} accepted ${invalid}`).toThrow();
        }
      }
      for (const column of EVENT_SAFE_COLUMNS) {
        for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(() => db.prepare(`UPDATE run_events SET ${column} = ? WHERE event_key = ?`)
            .run(invalid, 'b'.repeat(64)), `${column} accepted ${invalid}`).toThrow();
        }
      }

      expect(() => db.prepare("UPDATE runs SET state = 'stalled' WHERE id = ?").run(runId))
        .toThrow();
      expect(() => db.prepare("UPDATE runs SET surface = 'claude_code' WHERE id = ?").run(runId))
        .toThrow();
      expect(() => db.prepare("UPDATE run_events SET provider = 'openai' WHERE event_key = ?")
        .run('b'.repeat(64))).toThrow();
      expect(() => db.prepare("UPDATE run_events SET surface = 'omp' WHERE event_key = ?")
        .run('b'.repeat(64))).toThrow();

      expect(() => db.prepare(`
        INSERT INTO raider_devices
          (device_id, player_id, token_hash, companion_version, created_at)
        VALUES ('22222222-2222-4222-8222-222222222222', 1, ?, '0.1.0', 2)
      `).run('d'.repeat(64))).toThrow();
      expect(() => insertRunFixture(db)).toThrow();
      expect(() => db.prepare(`
        INSERT INTO run_events
          (event_key, run_id, device_id, sequence, schema_version, companion_version,
           provider, surface, run_key, event_time_ms, observed_at_ms, started_at_ms,
           state, policy_version, received_at)
        SELECT ?, run_id, device_id, sequence, schema_version, companion_version,
               provider, surface, run_key, event_time_ms, observed_at_ms, started_at_ms,
               state, policy_version, received_at
        FROM run_events WHERE event_key = ?
      `).run('e'.repeat(64), 'b'.repeat(64))).toThrow();
    } finally {
      db.close();
    }
  });

  it('upgrades populated legacy state without changing player activity or possessions', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-raiders-upgrade-'));
    const dbPath = join(fixtureDir, 'pre-runtime-raiders.db');
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      db.pragma('foreign_keys = ON');
      db.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      const record = db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
      for (const [index, migration] of migrations.slice(0, 18).entries()) {
        db.exec(migration.sql);
        record.run(migration.id, 1_000 + index);
      }

      db.prepare(`
        INSERT INTO players
          (id, name, class_key, gender, auth_token, level, total_tokens,
           effective_tokens, gold, disabled, last_token_at, created_at, peak_modifier)
        VALUES
          (7, 'Legacy Raider', 'warrior', 'M', 'legacy-raider-token', 11,
           123456, 120000, 7654321, 0, 4444, 1111, 2.75)
      `).run();
      db.prepare(`
        INSERT INTO token_events (id, player_id, ts, effective_delta, total_delta)
        VALUES (8, 7, 2222, 30, 40)
      `).run();
      db.prepare(`
        INSERT INTO player_inventory (player_id, sku, quantity, updated_at)
        VALUES (7, 'potion_damage_t2', 3, 3333)
      `).run();
      db.prepare(`
        INSERT INTO gold_ledger
          (id, player_id, amount, balance_after, reason, source_table, source_id, created_at)
        VALUES (9, 7, 4321, 7654321, 'legacy-award', 'legacy_source', 'abc', 4444)
      `).run();
      db.prepare(`
        INSERT INTO player_cosmetics
          (player_id, wheel_tier, primary_hue, secondary_hue, weapon_hue, updated_at)
        VALUES (7, 3, 210, 30, 75, 5555)
      `).run();
      db.prepare(`
        INSERT INTO player_slot_cosmetics
          (player_id, slot, op, hue, sat, lo, hi, updated_at, tone)
        VALUES (7, 2, 'colorize', 120, 0.6, 0.1, 0.9, 6666, -0.25)
      `).run();
      db.close();
      db = openDb(dbPath);

      expect(db.prepare('SELECT * FROM players WHERE id = 7').get()).toEqual({
        id: 7,
        name: 'Legacy Raider',
        class_key: 'warrior',
        gender: 'M',
        auth_token: 'legacy-raider-token',
        level: 11,
        total_tokens: 123456,
        effective_tokens: 120000,
        gold: 7654321,
        disabled: 0,
        last_token_at: 4444,
        created_at: 1111,
        peak_modifier: 2.75,
      });
      expect(db.prepare('SELECT * FROM token_events WHERE id = 8').get()).toEqual({
        id: 8, player_id: 7, ts: 2222, effective_delta: 30, total_delta: 40,
      });
      expect(db.prepare('SELECT * FROM player_inventory WHERE player_id = 7').get()).toEqual({
        player_id: 7, sku: 'potion_damage_t2', quantity: 3, updated_at: 3333,
      });
      expect(db.prepare('SELECT * FROM gold_ledger WHERE id = 9').get()).toEqual({
        id: 9,
        player_id: 7,
        amount: 4321,
        balance_after: 7654321,
        reason: 'legacy-award',
        source_table: 'legacy_source',
        source_id: 'abc',
        created_at: 4444,
      });
      expect(db.prepare('SELECT * FROM player_cosmetics WHERE player_id = 7').get()).toEqual({
        player_id: 7,
        wheel_tier: 3,
        primary_hue: 210,
        secondary_hue: 30,
        weapon_hue: 75,
        updated_at: 5555,
      });
      expect(db.prepare(
        'SELECT * FROM player_slot_cosmetics WHERE player_id = 7 AND slot = 2',
      ).get()).toEqual({
        player_id: 7,
        slot: 2,
        op: 'colorize',
        hue: 120,
        sat: 0.6,
        lo: 0.1,
        hi: 0.9,
        updated_at: 6666,
        tone: -0.25,
      });
      for (const table of TABLES) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      db?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

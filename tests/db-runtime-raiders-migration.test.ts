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
  'raider_device_replacements',
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

function snapshotTables(db: Database.Database, tables: string[]): string {
  return JSON.stringify(tables.map((table) => {
    const primaryKeyColumns = primaryKey(db, table);
    const orderBy = primaryKeyColumns.length > 0
      ? primaryKeyColumns.map((column) => `"${column}"`).join(', ')
      : 'rowid';
    return [table, db.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all()];
  }));
}

function insertReplacementFixture(
  db: Database.Database,
  {
    operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    oldDeviceId = '11111111-1111-4111-8111-111111111111',
    replacementDeviceId = '22222222-2222-4222-8222-222222222222',
    codeHash = 'e'.repeat(64),
    createdAt = 300,
  }: {
    operationId?: unknown;
    oldDeviceId?: unknown;
    replacementDeviceId?: unknown;
    codeHash?: unknown;
    createdAt?: unknown;
  } = {},
): void {
  db.prepare(`
    INSERT INTO raider_device_replacements
      (operation_id, old_device_id, replacement_device_id, code_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(operationId, oldDeviceId, replacementDeviceId, codeHash, createdAt);
}

function insertRunFixture(
  db: Database.Database,
  runKey: string | Buffer = 'a'.repeat(64),
): number {
  return Number(db.prepare(`
    INSERT INTO runs
      (player_id, provider, surface, run_key, state, started_at_ms,
       last_event_at_ms, last_observed_at_ms, policy_version, created_at, updated_at)
    VALUES
      (1, 'codex', 'codex_desktop', ?, 'open', 1000, 1100, 1200,
       'raid-power-v1', 1200, 1200)
  `).run(runKey).lastInsertRowid);
}

function insertEventFixture(
  db: Database.Database,
  runId: number,
  eventKey: string | Buffer | null = 'b'.repeat(64),
  sequence = 1,
  runKey: string | Buffer = 'a'.repeat(64),
): void {
  db.prepare(`
    INSERT INTO run_events
      (event_key, run_id, device_id, sequence, schema_version, companion_version,
       provider, surface, run_key, event_time_ms, observed_at_ms, started_at_ms,
       state, policy_version, received_at)
    VALUES
      (?, ?, '11111111-1111-4111-8111-111111111111', ?, 1, '0.1.0',
       'codex', 'codex_desktop', ?, 1100, 1200, 1000, 'open',
       'raid-power-v1', 1200)
  `).run(eventKey, runId, sequence, runKey);
}

function constraintDb(): { db: Database.Database; runId: number } {
  const db = openDb(':memory:');
  db.prepare(`
    INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
    VALUES (1, 'Run Hero', 'wizard', 'F', 'run-token', 1)
  `).run();
  db.prepare(`
    INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
    VALUES (2, 'Second Hero', 'wizard', 'M', 'second-run-token', 1)
  `).run();
  db.prepare(`
    INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
    VALUES (1, ?, 100)
  `).run('c'.repeat(64));
  db.prepare(`
    INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
    VALUES (2, ?, 100)
  `).run('a'.repeat(64));
  db.prepare(`
    INSERT INTO raider_enrollments
      (code_hash, player_id, created_at, expires_at)
    VALUES (?, 1, 100, 200)
  `).run('e'.repeat(64));
  db.prepare(`
    INSERT INTO raider_enrollments
      (code_hash, player_id, created_at, expires_at)
    VALUES (?, 2, 100, 200)
  `).run('f'.repeat(64));
  db.prepare(`
    INSERT INTO raider_devices
      (device_id, player_id, token_hash, companion_version, created_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 1, ?, '0.1.0', 100)
  `).run('d'.repeat(64));
  db.prepare(`
    INSERT INTO raider_devices
      (device_id, player_id, token_hash, companion_version, created_at)
    VALUES ('22222222-2222-4222-8222-222222222222', 2, ?, '0.1.0', 100)
  `).run('b'.repeat(64));
  db.prepare(`
    INSERT INTO raider_devices
      (device_id, player_id, token_hash, companion_version, created_at)
    VALUES ('33333333-3333-4333-8333-333333333333', 2, ?, '0.1.0', 100)
  `).run('a'.repeat(64));
  db.prepare(`
    INSERT INTO raider_devices
      (device_id, player_id, token_hash, companion_version, created_at)
    VALUES ('44444444-4444-4444-8444-444444444444', 2, ?, '0.1.0', 100)
  `).run('9'.repeat(64));
  const runId = insertRunFixture(db);
  insertEventFixture(db, runId);
  return { db, runId };
}

describe('Runtime Raiders persistence migrations', () => {
  it('creates persistence tables with durable relationships and identities', () => {
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
      expect(columns(db, 'raider_device_replacements')).toEqual([
        'operation_id',
        'old_device_id',
        'replacement_device_id',
        'code_hash',
        'created_at',
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
      expect(primaryKey(db, 'raider_device_replacements')).toEqual(['operation_id']);
      expect(uniqueIndexes(db, 'raider_devices')).toContainEqual(['token_hash']);
      expect(uniqueIndexes(db, 'raider_device_replacements')).toEqual(expect.arrayContaining([
        ['old_device_id'],
        ['replacement_device_id'],
      ]));
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
      expect(foreignKeys(db, 'raider_device_replacements')).toEqual([
        'code_hash->raider_enrollments.code_hash:CASCADE',
        'old_device_id->raider_devices.device_id:CASCADE',
        'replacement_device_id->raider_devices.device_id:CASCADE',
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
      expect(db.prepare('SELECT id FROM _migrations WHERE id = ?').get(
        '021_raider_device_replacements',
      )).toEqual({ id: '021_raider_device_replacements' });
    } finally {
      db.close();
    }
  });

  it('enforces replacement identity, relationship, uniqueness, and timestamp constraints', () => {
    const { db } = constraintDb();
    try {
      expect(() => insertReplacementFixture(db, {
        operationId: 'not-a-uuid',
      }), 'malformed UUID operation ID').toThrow();
      expect(() => insertReplacementFixture(db, {
        oldDeviceId: 'missing-device',
      }), 'missing old device').toThrow();
      expect(() => insertReplacementFixture(db, {
        replacementDeviceId: 'missing-device',
      }), 'missing replacement device').toThrow();
      expect(() => insertReplacementFixture(db, {
        codeHash: 'c'.repeat(64),
      }), 'missing enrollment').toThrow();
      expect(() => insertReplacementFixture(db, {
        createdAt: 1.5,
      }), 'non-integer timestamp').toThrow();
      expect(() => insertReplacementFixture(db, {
        createdAt: -1,
      }), 'negative timestamp').toThrow();
      expect(() => insertReplacementFixture(db, {
        createdAt: Number.MAX_SAFE_INTEGER + 1,
      }), 'unsafe timestamp').toThrow();
      expect(() => insertReplacementFixture(db, {
        oldDeviceId: '11111111-1111-4111-8111-111111111111',
        replacementDeviceId: '11111111-1111-4111-8111-111111111111',
      }), 'same old and replacement device').toThrow();

      insertReplacementFixture(db);
      expect(() => insertReplacementFixture(db, {
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        replacementDeviceId: '33333333-3333-4333-8333-333333333333',
        codeHash: 'f'.repeat(64),
      }), 'same old device twice').toThrow();
      expect(() => insertReplacementFixture(db, {
        operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        oldDeviceId: '33333333-3333-4333-8333-333333333333',
        codeHash: 'f'.repeat(64),
      }), 'same replacement device twice').toThrow();
      expect(() => insertReplacementFixture(db, {
        operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        oldDeviceId: '33333333-3333-4333-8333-333333333333',
        replacementDeviceId: '44444444-4444-4444-8444-444444444444',
      }), 'same enrollment code twice').toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    ['enrollment code hash', (db: Database.Database) => db.prepare(`
      INSERT INTO raider_enrollments (code_hash, player_id, created_at, expires_at)
      VALUES (NULL, 1, 101, 201)
    `).run()],
    ['device id', (db: Database.Database) => db.prepare(`
      INSERT INTO raider_devices
        (device_id, player_id, token_hash, companion_version, created_at)
      VALUES (NULL, 1, ?, '0.1.0', 101)
    `).run('f'.repeat(64))],
  ])('rejects a NULL %s despite SQLite nullable text primary keys', (_label, insert) => {
    const { db } = constraintDb();
    try {
      expect(() => insert(db)).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects multiple NULL event keys instead of treating them as distinct identities', () => {
    const { db, runId } = constraintDb();
    try {
      const insertTwoNullKeys = db.transaction(() => {
        insertEventFixture(db, runId, null, 2);
        insertEventFixture(db, runId, null, 3);
      });

      expect(() => insertTwoNullKeys()).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM run_events WHERE event_key IS NULL').get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it.each([
    ['Raider dedupe secret', (db: Database.Database) => db.prepare(`
      INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
      VALUES (2, ?, 100)
    `).run(Buffer.from('f'.repeat(64)))],
    ['enrollment code hash', (db: Database.Database) => db.prepare(`
      INSERT INTO raider_enrollments (code_hash, player_id, created_at, expires_at)
      VALUES (?, 1, 101, 201)
    `).run(Buffer.from('f'.repeat(64)))],
    ['device id', (db: Database.Database) => db.prepare(`
      INSERT INTO raider_devices
        (device_id, player_id, token_hash, companion_version, created_at)
      VALUES (?, 1, ?, '0.1.0', 101)
    `).run(Buffer.from('22222222-2222-4222-8222-222222222222'), 'f'.repeat(64))],
    ['device token hash', (db: Database.Database) => db.prepare(`
      INSERT INTO raider_devices
        (device_id, player_id, token_hash, companion_version, created_at)
      VALUES ('22222222-2222-4222-8222-222222222222', 1, ?, '0.1.0', 101)
    `).run(Buffer.from('f'.repeat(64)))],
    ['Run key', (db: Database.Database) => insertRunFixture(
      db, Buffer.from('f'.repeat(64)),
    )],
    ['event key matching an existing text key', (db: Database.Database, runId: number) =>
      insertEventFixture(db, runId, Buffer.from('b'.repeat(64)), 2)],
    ['event Run key', (db: Database.Database, runId: number) =>
      insertEventFixture(db, runId, 'f'.repeat(64), 2, Buffer.from('a'.repeat(64)))],
  ])('rejects a BLOB in the %s text identity', (_label, insert) => {
    const { db, runId } = constraintDb();
    try {
      expect(() => insert(db, runId)).toThrow();
    } finally {
      db.close();
    }
  });

  it('does not allow TEXT and byte-identical BLOB event keys to bypass idempotency', () => {
    const { db, runId } = constraintDb();
    try {
      expect(() => insertEventFixture(db, runId, Buffer.from('b'.repeat(64)), 2)).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('enforces lowercase-hex identity and key formats', () => {
    const { db, runId } = constraintDb();
    const mutations: [string, () => unknown][] = [
      ['dedupe-secret length', () => db.prepare(
        'UPDATE raider_identities SET dedupe_secret = ? WHERE player_id = 1',
      ).run('c'.repeat(63))],
      ['dedupe-secret alphabet', () => db.prepare(
        'UPDATE raider_identities SET dedupe_secret = ? WHERE player_id = 1',
      ).run('C'.repeat(64))],
      ['enrollment-code alphabet', () => db.prepare(
        'UPDATE raider_enrollments SET code_hash = ?',
      ).run('z'.repeat(64))],
      ['token-hash length', () => db.prepare(
        'UPDATE raider_devices SET token_hash = ?',
      ).run('d'.repeat(65))],
      ['Run-key alphabet', () => db.prepare(
        'UPDATE runs SET run_key = ? WHERE id = ?',
      ).run('G'.repeat(64), runId)],
      ['event-key length', () => db.prepare(
        'UPDATE run_events SET event_key = ? WHERE event_key = ?',
      ).run('b'.repeat(63), 'b'.repeat(64))],
      ['event Run-key alphabet', () => db.prepare(
        'UPDATE run_events SET run_key = ? WHERE event_key = ?',
      ).run('z'.repeat(64), 'b'.repeat(64))],
    ];
    try {
      for (const [label, mutate] of mutations) {
        expect(() => mutate(), label).toThrow();
      }
    } finally {
      db.close();
    }
  });

  it('enforces safe timestamps and their ordering relationships', () => {
    const { db, runId } = constraintDb();
    const mutations: [string, string, unknown[]][] = [
      ['identity timestamp storage', 'UPDATE raider_identities SET created_at = ? WHERE player_id = 1', [1.5]],
      ['enrollment expiry ordering', 'UPDATE raider_enrollments SET expires_at = ?', [99]],
      ['enrollment consumption ordering', 'UPDATE raider_enrollments SET consumed_at = ?', [99]],
      ['device last-seen lower bound', 'UPDATE raider_devices SET last_seen_at = ?', [-1]],
      ['device revocation upper bound', 'UPDATE raider_devices SET revoked_at = ?', [Number.MAX_SAFE_INTEGER + 1]],
      ['Run start lower bound', 'UPDATE runs SET started_at_ms = ? WHERE id = ?', [-1, runId]],
      ['Run terminal ordering', "UPDATE runs SET state = 'completed', terminal_at_ms = ? WHERE id = ?", [999, runId]],
      ['Run event ordering', 'UPDATE runs SET last_event_at_ms = ? WHERE id = ?', [999, runId]],
      ['Run observation ordering', 'UPDATE runs SET last_observed_at_ms = ? WHERE id = ?', [1099, runId]],
      ['Run update ordering', 'UPDATE runs SET updated_at = ? WHERE id = ?', [1199, runId]],
      ['event time lower bound', 'UPDATE run_events SET event_time_ms = ? WHERE event_key = ?', [-1, 'b'.repeat(64)]],
      ['event observation ordering', 'UPDATE run_events SET observed_at_ms = ? WHERE event_key = ?', [1099, 'b'.repeat(64)]],
      ['event start ordering', 'UPDATE run_events SET started_at_ms = ? WHERE event_key = ?', [1101, 'b'.repeat(64)]],
      ['event duration cap', 'UPDATE run_events SET started_at_ms = ? WHERE event_key = ?', [1100 - 604800001, 'b'.repeat(64)]],
      ['server receipt upper bound', 'UPDATE run_events SET received_at = ? WHERE event_key = ?', [Number.MAX_SAFE_INTEGER + 1, 'b'.repeat(64)]],
    ];
    try {
      for (const [label, sql, parameters] of mutations) {
        expect(() => db.prepare(sql).run(...parameters), label).toThrow();
      }
    } finally {
      db.close();
    }
  });

  it('couples a Run terminal state to its terminal time', () => {
    const { db, runId } = constraintDb();
    try {
      expect(() => db.prepare("UPDATE runs SET state = 'completed' WHERE id = ?").run(runId))
        .toThrow();
      expect(() => db.prepare('UPDATE runs SET terminal_at_ms = 1200 WHERE id = ?').run(runId))
        .toThrow();
    } finally {
      db.close();
    }
  });

  it('enforces schema version, provider/surface pairs, and lifecycle states', () => {
    const { db, runId } = constraintDb();
    const mutations: [string, string, unknown[]][] = [
      ['Run provider', "UPDATE runs SET provider = 'openai' WHERE id = ?", [runId]],
      ['Run surface/provider pairing', "UPDATE runs SET surface = 'claude_code' WHERE id = ?", [runId]],
      ['Run state', "UPDATE runs SET state = 'stalled' WHERE id = ?", [runId]],
      ['event schema version', 'UPDATE run_events SET schema_version = 2 WHERE event_key = ?', ['b'.repeat(64)]],
      ['event schema storage class', 'UPDATE run_events SET schema_version = 1.5 WHERE event_key = ?', ['b'.repeat(64)]],
      ['event provider', "UPDATE run_events SET provider = 'openai' WHERE event_key = ?", ['b'.repeat(64)]],
      ['event surface/provider pairing', "UPDATE run_events SET surface = 'omp' WHERE event_key = ?", ['b'.repeat(64)]],
      ['event state', "UPDATE run_events SET state = 'stalled' WHERE event_key = ?", ['b'.repeat(64)]],
    ];
    try {
      for (const [label, sql, parameters] of mutations) {
        expect(() => db.prepare(sql).run(...parameters), label).toThrow();
      }
    } finally {
      db.close();
    }
  });

  it('enforces bounded text fields', () => {
    const { db, runId } = constraintDb();
    const mutations: [string, string, unknown[]][] = [
      ['device id empty', 'UPDATE raider_devices SET device_id = ?', ['']],
      ['device id long', 'UPDATE raider_devices SET device_id = ?', ['x'.repeat(101)]],
      ['device companion version empty', 'UPDATE raider_devices SET companion_version = ?', ['']],
      ['device companion version long', 'UPDATE raider_devices SET companion_version = ?', ['x'.repeat(101)]],
      ['Run model', 'UPDATE runs SET latest_model = ? WHERE id = ?', ['x'.repeat(101), runId]],
      ['Run effort', 'UPDATE runs SET latest_effort = ? WHERE id = ?', ['x'.repeat(101), runId]],
      ['Run policy version', 'UPDATE runs SET policy_version = ? WHERE id = ?', ['', runId]],
      ['event companion version', 'UPDATE run_events SET companion_version = ? WHERE event_key = ?', ['', 'b'.repeat(64)]],
      ['event model', 'UPDATE run_events SET model = ? WHERE event_key = ?', ['x'.repeat(101), 'b'.repeat(64)]],
      ['event effort', 'UPDATE run_events SET effort = ? WHERE event_key = ?', ['x'.repeat(101), 'b'.repeat(64)]],
      ['event policy version', 'UPDATE run_events SET policy_version = ? WHERE event_key = ?', ['', 'b'.repeat(64)]],
    ];
    try {
      for (const [label, sql, parameters] of mutations) {
        expect(() => db.prepare(sql).run(...parameters), label).toThrow();
      }
    } finally {
      db.close();
    }
  });

  it.each([
    ['device companion version', (db: Database.Database, _runId: number) => db.prepare(
      'UPDATE raider_devices SET companion_version = ?',
    ).run(Buffer.from('0.1.0'))],
    ['Run model', (db: Database.Database, runId: number) => db.prepare(
      'UPDATE runs SET latest_model = ? WHERE id = ?',
    ).run(Buffer.from('gpt-test'), runId)],
    ['Run effort', (db: Database.Database, runId: number) => db.prepare(
      'UPDATE runs SET latest_effort = ? WHERE id = ?',
    ).run(Buffer.from('high'), runId)],
    ['Run policy version', (db: Database.Database, runId: number) => db.prepare(
      'UPDATE runs SET policy_version = ? WHERE id = ?',
    ).run(Buffer.from('raid-power-v1'), runId)],
    ['event companion version', (db: Database.Database, _runId: number) => db.prepare(
      'UPDATE run_events SET companion_version = ? WHERE event_key = ?',
    ).run(Buffer.from('0.1.0'), 'b'.repeat(64))],
    ['event model', (db: Database.Database, _runId: number) => db.prepare(
      'UPDATE run_events SET model = ? WHERE event_key = ?',
    ).run(Buffer.from('gpt-test'), 'b'.repeat(64))],
    ['event effort', (db: Database.Database, _runId: number) => db.prepare(
      'UPDATE run_events SET effort = ? WHERE event_key = ?',
    ).run(Buffer.from('high'), 'b'.repeat(64))],
    ['event policy version', (db: Database.Database, _runId: number) => db.prepare(
      'UPDATE run_events SET policy_version = ? WHERE event_key = ?',
    ).run(Buffer.from('raid-power-v1'), 'b'.repeat(64))],
  ])('rejects BLOB storage for the bounded %s text field', (_label, mutate) => {
    const { db, runId } = constraintDb();
    try {
      expect(() => mutate(db, runId)).toThrow();
    } finally {
      db.close();
    }
  });

  it('continues to accept NULL for optional Run and event model metadata', () => {
    const { db, runId } = constraintDb();
    try {
      expect(() => db.prepare(`
        UPDATE runs SET latest_model = NULL, latest_effort = NULL WHERE id = ?
      `).run(runId)).not.toThrow();
      expect(() => db.prepare(`
        UPDATE run_events SET model = NULL, effort = NULL WHERE event_key = ?
      `).run('b'.repeat(64))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('enforces non-negative safe-integer usage, score, and sequence values', () => {
    const { db, runId } = constraintDb();
    try {

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

      for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => db.prepare('UPDATE run_events SET sequence = ? WHERE event_key = ?')
          .run(invalid, 'b'.repeat(64)), `sequence accepted ${invalid}`).toThrow();
      }
    } finally {
      db.close();
    }
  });

  it('enforces device-token, Run, event-key, and Run-sequence uniqueness', () => {
    const { db, runId } = constraintDb();
    try {

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

  it('upgrades a populated 020 database without changing existing rows', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-replacement-upgrade-'));
    const dbPath = join(fixtureDir, 'pre-device-replacements.db');
    let db: Database.Database | undefined;
    try {
      const legacy = new Database(dbPath);
      legacy.pragma('foreign_keys = ON');
      legacy.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      const record = legacy.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
      for (const [index, migration] of migrations.slice(0, 20).entries()) {
        legacy.exec(migration.sql);
        record.run(migration.id, 1_000 + index);
      }

      legacy.prepare(`
        INSERT INTO players
          (id, name, class_key, gender, auth_token, level, total_tokens,
           effective_tokens, gold, disabled, last_token_at, created_at, peak_modifier)
        VALUES
          (1, 'Original Raider', 'wizard', 'F', 'original-token', 12,
           123456, 120000, 7654321, 0, 4444, 1111, 2.75),
          (2, 'Replacement Raider', 'knight', 'M', 'replacement-token', 7,
           3456, 3000, 12345, 0, 5555, 2222, 1.25)
      `).run();
      legacy.prepare(`
        INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
        VALUES (1, ?, 100), (2, ?, 101)
      `).run('a'.repeat(64), 'b'.repeat(64));
      legacy.prepare(`
        INSERT INTO raider_enrollments
          (code_hash, player_id, created_at, expires_at, consumed_at)
        VALUES (?, 1, 110, 210, 120)
      `).run('c'.repeat(64));
      legacy.prepare(`
        INSERT INTO raider_devices
          (device_id, player_id, token_hash, companion_version, created_at, last_seen_at)
        VALUES
          ('11111111-1111-4111-8111-111111111111', 1, ?, '0.1.0', 100, 200),
          ('22222222-2222-4222-8222-222222222222', 2, ?, '0.1.0', 101, 201)
      `).run('d'.repeat(64), 'e'.repeat(64));
      const runId = insertRunFixture(legacy);
      insertEventFixture(legacy, runId);
      legacy.prepare(`
        INSERT INTO raider_presence (player_id, last_run_activity_at) VALUES (1, 1200)
      `).run();

      legacy.prepare(`
        INSERT INTO token_events (id, player_id, ts, effective_delta, total_delta)
        VALUES (1, 1, 2222, 30, 40)
      `).run();
      legacy.prepare(`
        INSERT INTO metric_series (series_key, last_value, updated_at)
        VALUES ('codex.tokens', 40, 2222)
      `).run();
      legacy.prepare(`
        INSERT INTO dungeons (id, level, theme, seed, regular_count, created_at)
        VALUES (1, 12, 'crypt', 42, 3, 3000)
      `).run();
      legacy.prepare(`
        INSERT INTO encounters
          (id, dungeon_id, index_in_dungeon, kind, creature_index, footprint,
           max_hp, current_hp, status, started_at, reward_model_version, reward_gold_pool)
        VALUES (1, 1, 0, 'boss', 9, 2, 1000, 500, 'active', 3010, 'hybrid-v1', 500)
      `).run();
      legacy.prepare(`
        UPDATE game_state
        SET current_dungeon_id = 1, current_encounter_id = 1, paused = 0,
            last_activity_at = 3020, combat_active_ms = 20
        WHERE id = 1
      `).run();
      legacy.prepare(`
        INSERT INTO encounter_damage
          (encounter_id, player_id, damage_total, hits, max_hit, potion_bonus_damage)
        VALUES (1, 1, 500, 3, 250, 25)
      `).run();
      legacy.prepare(`
        INSERT INTO level_ups (id, player_id, new_level, ts) VALUES (1, 1, 12, 3030)
      `).run();
      legacy.prepare(`
        INSERT INTO monster_attacks (id, encounter_id, player_id, kind, gold_delta, ts)
        VALUES (1, 1, 1, 'gold', 100, 3040)
      `).run();
      legacy.prepare(`
        INSERT INTO player_inventory (player_id, sku, quantity, updated_at)
        VALUES (1, 'potion_damage_t2', 3, 3050)
      `).run();
      legacy.prepare(`
        INSERT INTO player_cosmetics
          (player_id, wheel_tier, primary_hue, secondary_hue, weapon_hue, updated_at)
        VALUES (1, 3, 210, 30, 75, 3060)
      `).run();
      legacy.prepare(`
        INSERT INTO player_slot_cosmetics
          (player_id, slot, op, hue, sat, lo, hi, updated_at, tone)
        VALUES (1, 2, 'colorize', 120, 0.6, 0.1, 0.9, 3070, -0.25)
      `).run();
      legacy.prepare(`
        INSERT INTO encounter_reward_awards
          (encounter_id, player_id, effective_tokens, damage_total, potion_bonus_damage,
           damage_rank, work_gold, damage_gold, podium_gold, total_gold, model_version, awarded_at)
        VALUES (1, 1, 40, 500, 25, 1, 10, 20, 30, 60, 'hybrid-v1', 3080)
      `).run();
      legacy.prepare(`
        INSERT INTO gold_ledger
          (id, player_id, amount, balance_after, reason, source_table, source_id, created_at)
        VALUES (1, 1, 60, 7654321, 'encounter-award', 'encounter_reward_awards', '1', 3080)
      `).run();
      legacy.prepare(`
        INSERT INTO game_clock_days (office_day, active_ms) VALUES ('2026-08-26', 20)
      `).run();
      legacy.prepare(`
        INSERT INTO player_daily_combat (player_id, office_day, damage, potion_bonus_damage)
        VALUES (1, '2026-08-26', 500, 25)
      `).run();

      const existingTables = (legacy.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'
        ORDER BY name
      `).all() as { name: string }[]).map((row) => row.name);
      const before = snapshotTables(legacy, existingTables);
      legacy.close();

      db = openDb(dbPath);
      expect(snapshotTables(db, existingTables)).toBe(before);
      expect(db.prepare('SELECT COUNT(*) AS count FROM raider_device_replacements').get())
        .toEqual({ count: 0 });
    } finally {
      db?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
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

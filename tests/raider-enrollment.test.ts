import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import {
  authenticateDevice,
  createEnrollment,
  exchangeEnrollment,
  getDeviceEnrollmentConfiguration,
  recordDeviceContact,
  revokeDeviceCredential,
  replaceDeviceEnrollment,
  type ReplacementRequest,
} from '../src/domain/raider-enrollment';

const NOW = 1_700_000_000_000;

function enrollmentDb(): Database.Database {
  const db = openDb(':memory:');
  db.prepare(`
    INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
    VALUES (1, 'Enrollment Raider', 'wizard', 'F', 'raider-key', ?)
  `).run(NOW);
  db.prepare(`
    INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
    VALUES (2, 'Target Raider', 'warrior', 'M', 'target-key', ?)
  `).run(NOW);
  return db;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newDeviceId(): string {
  return randomUUID();
}

function snapshotTables(db: Database.Database, excluded: string[] = []): string {
  const tables = (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> '_migrations'
    ORDER BY name
  `).all() as { name: string }[])
    .map((row) => row.name)
    .filter((table) => !excluded.includes(table));

  return JSON.stringify(tables.map((table) => {
    const primaryKey = (db.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string;
      pk: number;
    }[])
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => `"${column.name}"`);
    const orderBy = primaryKey.length > 0 ? primaryKey.join(', ') : 'rowid';
    return [table, db.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all()];
  }));
}

function seedExistingHistory(db: Database.Database, deviceId: string): void {
  db.prepare(`
    UPDATE players
    SET level = 7, total_tokens = 1200, effective_tokens = 900,
        gold = 321, last_token_at = ?
    WHERE id = 1
  `).run(NOW - 1);
  db.prepare(`
    INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
    VALUES (1, ?, 30, 40)
  `).run(NOW - 2);
  db.prepare(`
    INSERT INTO runs
      (player_id, provider, surface, run_key, state, started_at_ms,
       last_event_at_ms, last_observed_at_ms, usage_input, awarded_usage_credit,
       raid_power, policy_version, created_at, updated_at)
    VALUES
      (1, 'codex', 'codex_desktop', ?, 'open', ?, ?, ?, 30, 30, 30,
       'raid-power-v1', ?, ?)
  `).run('a'.repeat(64), NOW - 100, NOW - 50, NOW - 40, NOW - 40, NOW - 40);
  const runId = (db.prepare('SELECT id FROM runs').get() as { id: number }).id;
  db.prepare(`
    INSERT INTO run_events
      (event_key, run_id, device_id, sequence, schema_version, companion_version,
       provider, surface, run_key, event_time_ms, observed_at_ms, started_at_ms,
       state, usage_input, policy_version, awarded_delta, received_at)
    VALUES
      (?, ?, ?, 1, 1, '0.4.8', 'codex', 'codex_desktop', ?, ?, ?, ?,
       'open', 30, 'raid-power-v1', 30, ?)
  `).run(
    'b'.repeat(64),
    runId,
    deviceId,
    'a'.repeat(64),
    NOW - 50,
    NOW - 40,
    NOW - 100,
    NOW - 40,
  );
  db.prepare(`
    INSERT INTO raider_presence (player_id, last_run_activity_at)
    VALUES (1, ?)
  `).run(NOW - 40);
  db.prepare(`
    INSERT INTO player_inventory (player_id, sku, quantity, updated_at)
    VALUES (1, 'potion_damage_t1', 2, ?)
  `).run(NOW - 30);
  db.prepare(`
    INSERT INTO player_cosmetics
      (player_id, wheel_tier, primary_hue, secondary_hue, weapon_hue, updated_at)
    VALUES (1, 2, 120, 180, 240, ?)
  `).run(NOW - 30);
  db.prepare(`
    INSERT INTO player_slot_cosmetics
      (player_id, slot, op, hue, sat, lo, hi, updated_at, tone)
    VALUES (1, 2, 'colorize', 120, 0.5, 0.1, 0.9, ?, -0.25)
  `).run(NOW - 30);
  db.prepare(`
    INSERT INTO dungeons (id, level, theme, seed, regular_count, created_at)
    VALUES (1, 7, 'crypt', 42, 1, ?)
  `).run(NOW - 200);
  db.prepare(`
    INSERT INTO encounters
      (id, dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at, ended_at,
       reward_model_version)
    VALUES (1, 1, 0, 'single', 1, 1, 1, 500, 0, 'defeated', ?, ?, 'hybrid-v1')
  `).run(NOW - 190, NOW - 150);
  db.prepare(`
    INSERT INTO encounter_damage
      (encounter_id, player_id, damage_total, hits, max_hit, potion_bonus_damage)
    VALUES (1, 1, 500, 3, 250, 25)
  `).run();
  db.prepare(`
    INSERT INTO encounter_reward_awards
      (encounter_id, player_id, effective_tokens, damage_total, potion_bonus_damage,
       damage_rank, work_gold, damage_gold, podium_gold, total_gold,
       model_version, awarded_at)
    VALUES (1, 1, 30, 500, 25, 1, 10, 20, 30, 60, 'hybrid-v1', ?)
  `).run(NOW - 140);
  db.prepare(`
    INSERT INTO level_ups (player_id, new_level, ts)
    VALUES (1, 7, ?)
  `).run(NOW - 130);
  db.prepare(`
    INSERT INTO gold_ledger
      (player_id, amount, balance_after, reason, source_table, source_id, created_at)
    VALUES (1, 60, 321, 'encounter-award', 'encounter_reward_awards', '1', ?)
  `).run(NOW - 140);
  db.prepare(`
    INSERT INTO player_daily_combat
      (player_id, office_day, damage, potion_bonus_damage)
    VALUES (1, '2026-08-26', 500, 25)
  `).run();
}

function replacementFixture(
  db: Database.Database,
  targetPlayerId = 1,
): {
  oldDeviceId: string;
  oldToken: string;
  targetCode: string;
  targetDedupeSecret: string;
  request: ReplacementRequest;
} {
  const oldEnrollment = createEnrollment(db, 1, NOW);
  const oldDeviceId = newDeviceId();
  const old = exchangeEnrollment(db, oldEnrollment.code, oldDeviceId, '0.4.8', NOW + 1);
  if (!old) throw new Error('old enrollment fixture failed');

  const targetEnrollment = createEnrollment(db, targetPlayerId, NOW + 2);
  const identity = db.prepare(`
    SELECT dedupe_secret
    FROM raider_identities
    WHERE player_id = ?
  `).get(targetPlayerId) as { dedupe_secret: string };
  const request: ReplacementRequest = {
    bearerToken: old.deviceToken,
    code: targetEnrollment.code,
    operationId: randomUUID(),
    replacementDeviceId: randomUUID(),
    replacementDeviceToken: 'R'.repeat(43),
    companionVersion: '0.4.9',
  };
  return {
    oldDeviceId,
    oldToken: old.deviceToken,
    targetCode: targetEnrollment.code,
    targetDedupeSecret: identity.dedupe_secret,
    request,
  };
}

describe('raider enrollment', () => {
  it('hashes a one-time ten-minute enrollment code and device token', () => {
    const db = enrollmentDb();
    try {
      const enrollment = createEnrollment(db, 1, NOW);
      const deviceId = newDeviceId();

      expect(enrollment.expiresAt).toBe(NOW + 10 * 60_000);
      expect(enrollment.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(db.prepare('SELECT code_hash FROM raider_enrollments').get()).toEqual({
        code_hash: sha256(enrollment.code),
      });
      expect(JSON.stringify(db.prepare('SELECT * FROM raider_enrollments').all()))
        .not.toContain(enrollment.code);

      const exchanged = exchangeEnrollment(
        db,
        enrollment.code,
        deviceId,
        '0.1.0',
        enrollment.expiresAt - 1,
      );

      expect(exchanged).not.toBeNull();
      expect(exchanged!.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(db.prepare('SELECT token_hash FROM raider_devices').get()).toEqual({
        token_hash: sha256(exchanged!.deviceToken),
      });
      expect(JSON.stringify(db.prepare('SELECT * FROM raider_devices').all()))
        .not.toContain(exchanged!.deviceToken);
      expect(db.prepare('SELECT consumed_at FROM raider_enrollments').get())
        .toEqual({ consumed_at: enrollment.expiresAt - 1 });
    } finally {
      db.close();
    }
  });

  it('gives devices for one Raider distinct credentials and a shared dedupe secret', () => {
    const db = enrollmentDb();
    try {
      const firstEnrollment = createEnrollment(db, 1, NOW);
      const secondEnrollment = createEnrollment(db, 1, NOW + 1);
      const firstDeviceId = newDeviceId();
      const secondDeviceId = newDeviceId();

      const first = exchangeEnrollment(db, firstEnrollment.code, firstDeviceId, '0.1.0', NOW + 2);
      const second = exchangeEnrollment(db, secondEnrollment.code, secondDeviceId, '0.1.0', NOW + 3);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.deviceToken).not.toBe(second!.deviceToken);
      expect(first!.dedupeSecret).toBe(second!.dedupeSecret);
      expect(first!.dedupeSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM raider_identities').get())
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('rejects expired and already-consumed enrollment codes', () => {
    const db = enrollmentDb();
    try {
      const expired = createEnrollment(db, 1, NOW);
      expect(exchangeEnrollment(db, expired.code, newDeviceId(), '0.1.0', expired.expiresAt))
        .toBeNull();

      const active = createEnrollment(db, 1, NOW + 1);
      expect(exchangeEnrollment(db, active.code, newDeviceId(), '0.1.0', NOW + 2))
        .not.toBeNull();
      expect(exchangeEnrollment(db, active.code, newDeviceId(), '0.1.0', NOW + 3))
        .toBeNull();
    } finally {
      db.close();
    }
  });

  it('rolls back code consumption when device creation cannot commit', () => {
    const db = enrollmentDb();
    try {
      const firstEnrollment = createEnrollment(db, 1, NOW);
      const existingDeviceId = newDeviceId();
      expect(exchangeEnrollment(db, firstEnrollment.code, existingDeviceId, '0.1.0', NOW + 1))
        .not.toBeNull();

      const retryableEnrollment = createEnrollment(db, 1, NOW + 2);
      expect(() => exchangeEnrollment(
        db,
        retryableEnrollment.code,
        existingDeviceId,
        '0.1.0',
        NOW + 3,
      )).toThrow();
      expect(db.prepare('SELECT consumed_at FROM raider_enrollments WHERE code_hash = ?')
        .get(sha256(retryableEnrollment.code))).toEqual({ consumed_at: null });
      expect(exchangeEnrollment(
        db,
        retryableEnrollment.code,
        newDeviceId(),
        '0.1.0',
        NOW + 4,
      )).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('keeps credential lookup read-only and records contact monotonically when requested', () => {
    const db = enrollmentDb();
    try {
      const enrollment = createEnrollment(db, 1, NOW);
      const deviceId = newDeviceId();
      const exchanged = exchangeEnrollment(db, enrollment.code, deviceId, '0.1.0', NOW + 1);
      expect(exchanged).not.toBeNull();

      expect(authenticateDevice(db, exchanged!.deviceToken, NOW + 2)).toEqual({
        deviceId,
        playerId: 1,
        companionVersion: '0.1.0',
      });
      expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
        .get(deviceId)).toEqual({ last_seen_at: null });

      expect(recordDeviceContact(db, deviceId, NOW + 2)).toBe(true);
      expect(recordDeviceContact(db, deviceId, NOW + 1)).toBe(true);
      expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
        .get(deviceId)).toEqual({ last_seen_at: NOW + 2 });
      expect(authenticateDevice(db, exchanged!.deviceToken, NOW + 3)).toEqual({
        deviceId,
        playerId: 1,
        companionVersion: '0.1.0',
      });
      expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
        .get(deviceId)).toEqual({ last_seen_at: NOW + 2 });
    } finally {
      db.close();
    }
  });

  it('rejects revoked and malformed credentials without touching device state', () => {
    const db = enrollmentDb();
    try {
      const enrollment = createEnrollment(db, 1, NOW);
      const deviceId = newDeviceId();
      const exchanged = exchangeEnrollment(db, enrollment.code, deviceId, '0.1.0', NOW + 1);
      expect(exchanged).not.toBeNull();

      for (const credential of [[], {}, Symbol('token'), null, 'x'.repeat(44)]) {
        expect(authenticateDevice(db, credential as unknown as string, NOW + 2)).toBeNull();
      }
      expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
        .get(deviceId)).toEqual({ last_seen_at: null });

      db.prepare('UPDATE raider_devices SET revoked_at = ? WHERE device_id = ?')
        .run(NOW + 3, deviceId);
      expect(authenticateDevice(db, exchanged!.deviceToken, NOW + 4)).toBeNull();
      expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
        .get(deviceId)).toEqual({ last_seen_at: null });
    } finally {
      db.close();
    }
  });

  it('returns only active enrollment configuration and revokes credentials monotonically', () => {
    const db = enrollmentDb();
    try {
      const enrollment = createEnrollment(db, 1, NOW);
      const deviceId = newDeviceId();
      const exchanged = exchangeEnrollment(db, enrollment.code, deviceId, '0.1.0', NOW + 1);
      if (!exchanged) throw new Error('device enrollment fixture failed');
      const identity = db.prepare(`
        SELECT dedupe_secret
        FROM raider_identities
        WHERE player_id = 1
      `).get() as { dedupe_secret: string };

      expect(getDeviceEnrollmentConfiguration(db, exchanged.deviceToken, NOW + 2)).toEqual({
        deviceId,
        dedupeSecret: identity.dedupe_secret,
      });
      expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
        .get(deviceId)).toEqual({ last_seen_at: null });

      expect(revokeDeviceCredential(db, exchanged.deviceToken, NOW + 3)).toBe('revoked');
      expect(db.prepare(`
        SELECT revoked_at, last_seen_at
        FROM raider_devices
        WHERE device_id = ?
      `).get(deviceId)).toEqual({ revoked_at: NOW + 3, last_seen_at: null });
      expect(authenticateDevice(db, exchanged.deviceToken, NOW + 4)).toBeNull();
      expect(getDeviceEnrollmentConfiguration(db, exchanged.deviceToken, NOW + 4)).toBeNull();

      expect(revokeDeviceCredential(db, exchanged.deviceToken, NOW + 5)).toBe('already_revoked');
      expect(db.prepare(`
        SELECT revoked_at, last_seen_at
        FROM raider_devices
        WHERE device_id = ?
      `).get(deviceId)).toEqual({ revoked_at: NOW + 3, last_seen_at: null });

      const beforeMalformed = snapshotTables(db);
      for (const invalidToken of [
        [],
        {},
        Symbol('token'),
        null,
        'malformed',
        'x'.repeat(44),
        'Z'.repeat(43),
      ]) {
        expect(getDeviceEnrollmentConfiguration(
          db,
          invalidToken as unknown as string,
          NOW + 6,
        )).toBeNull();
        expect(revokeDeviceCredential(db, invalidToken as unknown as string, NOW + 7)).toBeNull();
      }
      expect(snapshotTables(db)).toBe(beforeMalformed);
    } finally {
      db.close();
    }
  });

  it('rejects inputs outside the persistence schema bounds before writing', () => {
    const db = enrollmentDb();
    try {
      expect(() => createEnrollment(db, 0, NOW)).toThrow(RangeError);
      expect(() => createEnrollment(db, 1, -1)).toThrow(RangeError);
      const enrollment = createEnrollment(db, 1, NOW);
      const deviceId = newDeviceId();
      expect(exchangeEnrollment(db, enrollment.code, 'not-a-uuid', '0.1.0', NOW + 1)).toBeNull();
      expect(exchangeEnrollment(db, enrollment.code, deviceId, '', NOW + 1)).toBeNull();
      expect(exchangeEnrollment(db, enrollment.code, deviceId, 'x'.repeat(101), NOW + 1))
        .toBeNull();
      expect(exchangeEnrollment(
        db,
        enrollment.code,
        null as unknown as string,
        '0.1.0',
        NOW + 1,
      )).toBeNull();
      for (const credential of [[], {}, Symbol('code'), null, 'x'.repeat(44)]) {
        expect(exchangeEnrollment(
          db,
          credential as unknown as string,
          deviceId,
          '0.1.0',
          NOW + 1,
        )).toBeNull();
      }
      expect(db.prepare('SELECT consumed_at FROM raider_enrollments').get())
        .toEqual({ consumed_at: null });
    } finally {
      db.close();
    }
  });

  it.each([
    ['the current Raider', 1],
    ['a different Raider', 2],
  ] as const)('atomically replaces a device onto %s without changing history', (_label, targetId) => {
    const db = enrollmentDb();
    try {
      const fixture = replacementFixture(db, targetId);
      seedExistingHistory(db, fixture.oldDeviceId);
      const immutableBefore = snapshotTables(db, [
        'raider_enrollments',
        'raider_devices',
        'raider_device_replacements',
      ]);

      expect(replaceDeviceEnrollment(db, fixture.request, NOW + 10)).toEqual({
        kind: 'created',
        deviceId: fixture.request.replacementDeviceId,
        dedupeSecret: fixture.targetDedupeSecret,
      });

      expect(authenticateDevice(db, fixture.oldToken, NOW + 11)).toBeNull();
      expect(authenticateDevice(db, fixture.request.replacementDeviceToken, NOW + 11)).toEqual({
        deviceId: fixture.request.replacementDeviceId,
        playerId: targetId,
        companionVersion: '0.4.9',
      });
      expect(db.prepare(`
        SELECT consumed_at
        FROM raider_enrollments
        WHERE code_hash = ?
      `).get(sha256(fixture.targetCode))).toEqual({ consumed_at: NOW + 10 });
      expect(db.prepare(`
        SELECT operation_id, old_device_id, replacement_device_id, code_hash, created_at
        FROM raider_device_replacements
      `).get()).toEqual({
        operation_id: fixture.request.operationId,
        old_device_id: fixture.oldDeviceId,
        replacement_device_id: fixture.request.replacementDeviceId,
        code_hash: sha256(fixture.targetCode),
        created_at: NOW + 10,
      });
      expect(db.prepare(`
        SELECT token_hash
        FROM raider_devices
        WHERE device_id = ?
      `).get(fixture.request.replacementDeviceId)).toEqual({
        token_hash: sha256(fixture.request.replacementDeviceToken),
      });
      const persistedCredentials = JSON.stringify(db.prepare(`
        SELECT *
        FROM raider_devices
        ORDER BY device_id
      `).all());
      expect(persistedCredentials).not.toContain(fixture.oldToken);
      expect(persistedCredentials).not.toContain(fixture.request.replacementDeviceToken);
      expect(JSON.stringify(db.prepare('SELECT * FROM raider_enrollments').all()))
        .not.toContain(fixture.targetCode);
      expect(immutableBefore).toBe(snapshotTables(db, [
        'raider_enrollments',
        'raider_devices',
        'raider_device_replacements',
      ]));
    } finally {
      db.close();
    }
  });

  it('rejects invalid, expired, consumed, and malformed enrollment inputs without mutation', () => {
    const cases: {
      name: string;
      alter: (db: Database.Database, fixture: ReturnType<typeof replacementFixture>) => {
        request?: ReplacementRequest;
        now?: number;
        expected?: unknown;
      };
    }[] = [
      {
        name: 'unknown enrollment',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, code: 'Z'.repeat(43) },
          expected: { kind: 'invalid_enrollment' },
        }),
      },
      {
        name: 'expired enrollment',
        alter: (_db, fixture) => ({
          request: fixture.request,
          now: NOW + 2 + 10 * 60_000,
          expected: { kind: 'invalid_enrollment' },
        }),
      },
      {
        name: 'consumed enrollment',
        alter: (db, fixture) => {
          expect(exchangeEnrollment(
            db,
            fixture.targetCode,
            newDeviceId(),
            '0.4.8',
            NOW + 3,
          )).not.toBeNull();
          return {
            request: fixture.request,
            expected: { kind: 'invalid_enrollment' },
          };
        },
      },
      {
        name: 'malformed enrollment',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, code: 'malformed' },
          expected: { kind: 'invalid_enrollment' },
        }),
      },
      {
        name: 'malformed bearer',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, bearerToken: 'malformed' },
          expected: { kind: 'unauthorized' },
        }),
      },
      {
        name: 'malformed operation ID',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, operationId: 'malformed' },
          expected: { kind: 'conflict' },
        }),
      },
      {
        name: 'malformed replacement device ID',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, replacementDeviceId: 'malformed' },
          expected: { kind: 'conflict' },
        }),
      },
      {
        name: 'malformed replacement token',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, replacementDeviceToken: 'malformed' },
          expected: { kind: 'conflict' },
        }),
      },
      {
        name: 'empty companion version',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, companionVersion: '' },
          expected: { kind: 'conflict' },
        }),
      },
      {
        name: 'oversized companion version',
        alter: (_db, fixture) => ({
          request: { ...fixture.request, companionVersion: 'x'.repeat(101) },
          expected: { kind: 'conflict' },
        }),
      },
    ];

    for (const testCase of cases) {
      const db = enrollmentDb();
      try {
        const fixture = replacementFixture(db);
        const altered = testCase.alter(db, fixture);
        const before = snapshotTables(db);
        expect(
          replaceDeviceEnrollment(
            db,
            altered.request ?? fixture.request,
            altered.now ?? NOW + 10,
          ),
          testCase.name,
        ).toEqual(altered.expected);
        expect(snapshotTables(db), testCase.name).toBe(before);
        expect(authenticateDevice(db, fixture.oldToken, NOW + 11), testCase.name).toEqual({
          deviceId: fixture.oldDeviceId,
          playerId: 1,
          companionVersion: '0.4.8',
        });
        expect(db.prepare(`
          SELECT COUNT(*) AS count
          FROM raider_devices
          WHERE device_id = ?
        `).get(fixture.request.replacementDeviceId), testCase.name).toEqual({ count: 0 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM raider_device_replacements').get(),
          testCase.name).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    }
  });

  it('validates replacement timestamps before opening a transaction', () => {
    const db = enrollmentDb();
    try {
      const fixture = replacementFixture(db);
      const before = snapshotTables(db);
      expect(() => replaceDeviceEnrollment(db, fixture.request, -1)).toThrow(RangeError);
      expect(snapshotTables(db)).toBe(before);
      expect(authenticateDevice(db, fixture.oldToken, NOW + 11)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects duplicate device material and operation IDs without consuming the target code', () => {
    const db = enrollmentDb();
    try {
      const fixture = replacementFixture(db);
      for (const request of [
        { ...fixture.request, replacementDeviceId: fixture.oldDeviceId },
        { ...fixture.request, replacementDeviceToken: fixture.oldToken },
      ]) {
        const before = snapshotTables(db);
        expect(replaceDeviceEnrollment(db, request, NOW + 10)).toEqual({ kind: 'conflict' });
        expect(snapshotTables(db)).toBe(before);
      }

      const otherOldEnrollment = createEnrollment(db, 2, NOW + 3);
      const otherOld = exchangeEnrollment(
        db,
        otherOldEnrollment.code,
        newDeviceId(),
        '0.4.8',
        NOW + 4,
      );
      if (!otherOld) throw new Error('other old enrollment fixture failed');
      const otherTarget = createEnrollment(db, 2, NOW + 5);
      expect(replaceDeviceEnrollment(db, {
        bearerToken: otherOld.deviceToken,
        code: otherTarget.code,
        operationId: fixture.request.operationId,
        replacementDeviceId: newDeviceId(),
        replacementDeviceToken: 'Q'.repeat(43),
        companionVersion: '0.4.9',
      }, NOW + 10)).toMatchObject({ kind: 'created' });

      const beforeConflict = snapshotTables(db);
      expect(replaceDeviceEnrollment(db, fixture.request, NOW + 11))
        .toEqual({ kind: 'conflict' });
      expect(snapshotTables(db)).toBe(beforeConflict);
      expect(authenticateDevice(db, fixture.oldToken, NOW + 12)).not.toBeNull();
      expect(db.prepare(`
        SELECT consumed_at
        FROM raider_enrollments
        WHERE code_hash = ?
      `).get(sha256(fixture.targetCode))).toEqual({ consumed_at: null });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM raider_devices
        WHERE device_id = ?
      `).get(fixture.request.replacementDeviceId)).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rolls back code consumption, device insertion, and revocation when operation recording fails', () => {
    const db = enrollmentDb();
    try {
      const fixture = replacementFixture(db);
      db.exec(`
        CREATE TRIGGER reject_replacement_operation
        BEFORE INSERT ON raider_device_replacements
        BEGIN
          SELECT RAISE(ABORT, 'fixture operation failure');
        END
      `);
      const before = snapshotTables(db);

      expect(() => replaceDeviceEnrollment(db, fixture.request, NOW + 10))
        .toThrow('fixture operation failure');
      expect(snapshotTables(db)).toBe(before);
      expect(authenticateDevice(db, fixture.oldToken, NOW + 11)).toEqual({
        deviceId: fixture.oldDeviceId,
        playerId: 1,
        companionVersion: '0.4.8',
      });
      expect(db.prepare(`
        SELECT consumed_at
        FROM raider_enrollments
        WHERE code_hash = ?
      `).get(sha256(fixture.targetCode))).toEqual({ consumed_at: null });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM raider_devices
        WHERE device_id = ?
      `).get(fixture.request.replacementDeviceId)).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM raider_device_replacements').get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('replays only the exact committed request and keeps every replay path read-only', () => {
    const db = enrollmentDb();
    try {
      const fixture = replacementFixture(db, 2);
      expect(replaceDeviceEnrollment(db, fixture.request, NOW + 10)).toMatchObject({
        kind: 'created',
      });
      const committed = snapshotTables(db);

      expect(replaceDeviceEnrollment(db, fixture.request, NOW + 20)).toEqual({
        kind: 'replayed',
        deviceId: fixture.request.replacementDeviceId,
        dedupeSecret: fixture.targetDedupeSecret,
      });
      expect(snapshotTables(db)).toBe(committed);

      const conflicts: ReplacementRequest[] = [
        { ...fixture.request, operationId: randomUUID() },
        { ...fixture.request, code: 'C'.repeat(43) },
        { ...fixture.request, replacementDeviceId: randomUUID() },
        { ...fixture.request, replacementDeviceToken: 'S'.repeat(43) },
        { ...fixture.request, companionVersion: '0.4.10' },
      ];
      for (const request of conflicts) {
        expect(replaceDeviceEnrollment(db, request, NOW + 21)).toEqual({ kind: 'conflict' });
        expect(snapshotTables(db)).toBe(committed);
      }
      expect(authenticateDevice(db, fixture.oldToken, NOW + 22)).toBeNull();

      const unrelatedEnrollment = createEnrollment(db, 1, NOW + 30);
      const unrelatedDeviceId = newDeviceId();
      const unrelated = exchangeEnrollment(
        db,
        unrelatedEnrollment.code,
        unrelatedDeviceId,
        '0.4.8',
        NOW + 31,
      );
      if (!unrelated) throw new Error('unrelated enrollment fixture failed');
      db.prepare('UPDATE raider_devices SET revoked_at = ? WHERE device_id = ?')
        .run(NOW + 32, unrelatedDeviceId);
      const unrelatedBefore = snapshotTables(db);
      expect(replaceDeviceEnrollment(db, {
        ...fixture.request,
        bearerToken: unrelated.deviceToken,
        operationId: randomUUID(),
        replacementDeviceId: randomUUID(),
        replacementDeviceToken: 'T'.repeat(43),
      }, NOW + 33)).toEqual({ kind: 'unauthorized' });
      expect(snapshotTables(db)).toBe(unrelatedBefore);
      expect(authenticateDevice(db, unrelated.deviceToken, NOW + 34)).toBeNull();
    } finally {
      db.close();
    }
  });
});

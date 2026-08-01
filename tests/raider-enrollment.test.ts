import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import {
  authenticateDevice,
  createEnrollment,
  exchangeEnrollment,
} from '../src/domain/raider-enrollment';

const NOW = 1_700_000_000_000;

function enrollmentDb(): Database.Database {
  const db = openDb(':memory:');
  db.prepare(`
    INSERT INTO players (id, name, class_key, gender, auth_token, created_at)
    VALUES (1, 'Enrollment Raider', 'wizard', 'F', 'raider-key', ?)
  `).run(NOW);
  return db;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('raider enrollment', () => {
  it('hashes a one-time ten-minute enrollment code and device token', () => {
    const db = enrollmentDb();
    try {
      const enrollment = createEnrollment(db, 1, NOW);

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
        'device-one',
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

      const first = exchangeEnrollment(db, firstEnrollment.code, 'device-one', '0.1.0', NOW + 2);
      const second = exchangeEnrollment(db, secondEnrollment.code, 'device-two', '0.1.0', NOW + 3);

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
      expect(exchangeEnrollment(db, expired.code, 'expired-device', '0.1.0', expired.expiresAt))
        .toBeNull();

      const active = createEnrollment(db, 1, NOW + 1);
      expect(exchangeEnrollment(db, active.code, 'live-device', '0.1.0', NOW + 2))
        .not.toBeNull();
      expect(exchangeEnrollment(db, active.code, 'other-device', '0.1.0', NOW + 3))
        .toBeNull();
    } finally {
      db.close();
    }
  });

  it('rolls back code consumption when device creation cannot commit', () => {
    const db = enrollmentDb();
    try {
      const firstEnrollment = createEnrollment(db, 1, NOW);
      expect(exchangeEnrollment(db, firstEnrollment.code, 'device-one', '0.1.0', NOW + 1))
        .not.toBeNull();

      const retryableEnrollment = createEnrollment(db, 1, NOW + 2);
      expect(() => exchangeEnrollment(
        db,
        retryableEnrollment.code,
        'device-one',
        '0.1.0',
        NOW + 3,
      )).toThrow();
      expect(db.prepare('SELECT consumed_at FROM raider_enrollments WHERE code_hash = ?')
        .get(sha256(retryableEnrollment.code))).toEqual({ consumed_at: null });
      expect(exchangeEnrollment(
        db,
        retryableEnrollment.code,
        'device-two',
        '0.1.0',
        NOW + 4,
      )).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('authenticates active devices and rejects revoked or malformed credentials', () => {
    const db = enrollmentDb();
    try {
      const enrollment = createEnrollment(db, 1, NOW);
      const exchanged = exchangeEnrollment(db, enrollment.code, 'device-one', '0.1.0', NOW + 1);
      expect(exchanged).not.toBeNull();

      expect(authenticateDevice(db, exchanged!.deviceToken, NOW + 2)).toEqual({
        deviceId: 'device-one',
        playerId: 1,
        companionVersion: '0.1.0',
      });
      expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
        .get('device-one')).toEqual({ last_seen_at: NOW + 2 });

      db.prepare('UPDATE raider_devices SET revoked_at = ? WHERE device_id = ?')
        .run(NOW + 3, 'device-one');
      expect(authenticateDevice(db, exchanged!.deviceToken, NOW + 4)).toBeNull();
      expect(authenticateDevice(db, '', NOW + 4)).toBeNull();
      expect(authenticateDevice(db, 'x'.repeat(44), NOW + 4)).toBeNull();
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
      expect(exchangeEnrollment(db, enrollment.code, '', '0.1.0', NOW + 1)).toBeNull();
      expect(exchangeEnrollment(db, enrollment.code, 'device-one', '', NOW + 1)).toBeNull();
      expect(exchangeEnrollment(db, enrollment.code, 'x'.repeat(101), '0.1.0', NOW + 1))
        .toBeNull();
      expect(exchangeEnrollment(
        db,
        enrollment.code,
        null as unknown as string,
        '0.1.0',
        NOW + 1,
      )).toBeNull();
      expect(db.prepare('SELECT consumed_at FROM raider_enrollments').get())
        .toEqual({ consumed_at: null });
    } finally {
      db.close();
    }
  });
});

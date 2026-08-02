import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createPlayer, type NewPlayer, type Player } from './players';

const ENROLLMENT_LIFETIME_MS = 10 * 60_000;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const deviceIdSchema = z.string().uuid();

export interface EnrollmentResult {
  deviceToken: string;
  dedupeSecret: string;
}

export interface AuthenticatedDevice {
  deviceId: string;
  playerId: number;
  companionVersion: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomCredential(): string {
  return randomBytes(32).toString('base64url');
}

function randomDedupeSecret(): string {
  return randomBytes(32).toString('hex');
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function validPlayerId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMESTAMP;
}

function validBoundedText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 100
    && !value.includes('\0');
}

function validCredential(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_PATTERN.test(value);
}

function validDeviceId(value: unknown): value is string {
  return deviceIdSchema.safeParse(value).success;
}

function requireTimestamp(now: number): void {
  if (!validTimestamp(now)) {
    throw new RangeError('now must be a non-negative safe integer timestamp');
  }
}

function enrollmentExpiry(playerId: number, now: number): number {
  requireTimestamp(now);
  if (!validPlayerId(playerId)) {
    throw new RangeError('playerId must be a positive safe integer');
  }
  const expiresAt = now + ENROLLMENT_LIFETIME_MS;
  if (!validTimestamp(expiresAt)) {
    throw new RangeError('enrollment expiry exceeds the safe timestamp range');
  }
  return expiresAt;
}

function insertEnrollment(
  db: Database.Database,
  playerId: number,
  now: number,
  expiresAt: number,
  code: string,
): void {
  const player = db.prepare('SELECT 1 FROM players WHERE id = ?').get(playerId);
  if (!player) throw new RangeError('player does not exist');

  db.prepare(`
    INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(player_id) DO NOTHING
  `).run(playerId, randomDedupeSecret(), now);
  db.prepare(`
    INSERT INTO raider_enrollments (code_hash, player_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(sha256(code), playerId, now, expiresAt);
}

/** Create a one-time enrollment code, creating the Raider identity if needed. */
export function createEnrollment(
  db: Database.Database,
  playerId: number,
  now: number,
): { code: string; expiresAt: number } {
  const expiresAt = enrollmentExpiry(playerId, now);
  const code = randomCredential();
  const create = db.transaction(() => {
    insertEnrollment(db, playerId, now, expiresAt, code);
  });
  create();
  return { code, expiresAt };
}

/** Create a player, Raider identity, and one-time enrollment as one SQLite transaction. */
export function createPlayerWithEnrollment(
  db: Database.Database,
  input: NewPlayer,
  now: number,
): { player: Player; enrollment: { code: string; expiresAt: number } } {
  requireTimestamp(now);
  const code = randomCredential();
  const create = db.transaction(() => {
    const player = createPlayer(db, input, now);
    const expiresAt = enrollmentExpiry(player.id, now);
    insertEnrollment(db, player.id, now, expiresAt, code);
    return { player, enrollment: { code, expiresAt } };
  });
  return create();
}

/** Consume an unexpired enrollment code and create a device in the same transaction. */
export function exchangeEnrollment(
  db: Database.Database,
  code: string,
  deviceId: string,
  companionVersion: string,
  now: number,
): EnrollmentResult | null {
  requireTimestamp(now);
  if (
    !validCredential(code)
    || !validDeviceId(deviceId)
    || !validBoundedText(companionVersion)
  ) {
    return null;
  }

  const deviceToken = randomCredential();
  const exchange = db.transaction((): EnrollmentResult | null => {
    const enrollment = db.prepare(`
      SELECT enrollment.player_id, identity.dedupe_secret AS dedupe_secret
      FROM raider_enrollments AS enrollment
      JOIN raider_identities AS identity ON identity.player_id = enrollment.player_id
      WHERE enrollment.code_hash = ?
        AND enrollment.consumed_at IS NULL
        AND enrollment.expires_at > ?
    `).get(sha256(code), now) as { player_id: number; dedupe_secret: string } | undefined;
    if (!enrollment) return null;

    const consumed = db.prepare(`
      UPDATE raider_enrollments
      SET consumed_at = ?
      WHERE code_hash = ?
        AND consumed_at IS NULL
        AND expires_at > ?
    `).run(now, sha256(code), now);
    if (consumed.changes !== 1) return null;

    db.prepare(`
      INSERT INTO raider_devices
        (device_id, player_id, token_hash, companion_version, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(deviceId, enrollment.player_id, sha256(deviceToken), companionVersion, now);
    return { deviceToken, dedupeSecret: enrollment.dedupe_secret };
  });
  return exchange();
}

/** Validate an active device credential and record the successful contact time. */
export function authenticateDevice(
  db: Database.Database,
  bearerToken: string,
  now: number,
): AuthenticatedDevice | null {
  requireTimestamp(now);
  if (!validCredential(bearerToken)) return null;

  const authenticate = db.transaction((): AuthenticatedDevice | null => {
    const device = db.prepare(`
      SELECT device_id, player_id, companion_version
      FROM raider_devices
      WHERE token_hash = ? AND revoked_at IS NULL
    `).get(sha256(bearerToken)) as {
      device_id: string;
      player_id: number;
      companion_version: string;
    } | undefined;
    if (!device) return null;

    const updated = db.prepare(`
      UPDATE raider_devices
      SET last_seen_at = CASE
        WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ?
        ELSE last_seen_at
      END
      WHERE device_id = ? AND revoked_at IS NULL
    `).run(now, now, device.device_id);
    if (updated.changes !== 1) return null;

    return {
      deviceId: device.device_id,
      playerId: device.player_id,
      companionVersion: device.companion_version,
    };
  });
  return authenticate();
}

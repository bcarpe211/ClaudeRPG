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

export interface ReplacementRequest {
  bearerToken: string;
  code: string;
  operationId: string;
  replacementDeviceId: string;
  replacementDeviceToken: string;
  companionVersion: string;
}

export interface DeviceEnrollmentConfiguration {
  deviceId: string;
  dedupeSecret: string;
}

export type ReplacementResult =
  | ({ kind: 'created' | 'replayed' } & DeviceEnrollmentConfiguration)
  | { kind: 'invalid_enrollment' | 'unauthorized' | 'conflict' };

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

/** Atomically replace an active device enrollment, allowing only exact committed replay. */
export function replaceDeviceEnrollment(
  db: Database.Database,
  request: ReplacementRequest,
  now: number,
): ReplacementResult {
  requireTimestamp(now);
  if (!validCredential(request.bearerToken)) return { kind: 'unauthorized' };
  if (!validCredential(request.code)) return { kind: 'invalid_enrollment' };
  if (
    !validDeviceId(request.operationId)
    || !validDeviceId(request.replacementDeviceId)
    || !validCredential(request.replacementDeviceToken)
    || !validBoundedText(request.companionVersion)
  ) {
    return { kind: 'conflict' };
  }

  const oldTokenHash = sha256(request.bearerToken);
  const codeHash = sha256(request.code);
  const replacementTokenHash = sha256(request.replacementDeviceToken);
  const replace = db.transaction((): ReplacementResult => {
    const old = db.prepare(`
      SELECT device_id, revoked_at
      FROM raider_devices
      WHERE token_hash = ?
    `).get(oldTokenHash) as {
      device_id: string;
      revoked_at: number | null;
    } | undefined;
    if (!old) return { kind: 'unauthorized' };

    if (old.revoked_at !== null) {
      const replay = db.prepare(`
        SELECT
          operation.operation_id,
          operation.code_hash,
          operation.replacement_device_id,
          operation.companion_version,
          replacement.token_hash AS replacement_token_hash,
          identity.dedupe_secret
        FROM raider_device_replacements AS operation
        JOIN raider_devices AS replacement
          ON replacement.device_id = operation.replacement_device_id
        JOIN raider_enrollments AS enrollment
          ON enrollment.code_hash = operation.code_hash
        JOIN raider_identities AS identity
          ON identity.player_id = enrollment.player_id
         AND identity.player_id = replacement.player_id
        WHERE operation.old_device_id = ?
      `).get(old.device_id) as {
        operation_id: string;
        code_hash: string;
        replacement_device_id: string;
        replacement_token_hash: string;
        companion_version: string;
        dedupe_secret: string;
      } | undefined;
      if (!replay) return { kind: 'unauthorized' };
      if (
        replay.operation_id !== request.operationId
        || replay.code_hash !== codeHash
        || replay.replacement_device_id !== request.replacementDeviceId
        || replay.replacement_token_hash !== replacementTokenHash
        || replay.companion_version !== request.companionVersion
      ) {
        return { kind: 'conflict' };
      }
      return {
        kind: 'replayed',
        deviceId: replay.replacement_device_id,
        dedupeSecret: replay.dedupe_secret,
      };
    }

    const operationConflict = db.prepare(`
      SELECT 1
      FROM raider_device_replacements
      WHERE operation_id = ?
         OR old_device_id = ?
         OR replacement_device_id = ?
    `).get(request.operationId, old.device_id, request.replacementDeviceId);
    const deviceConflict = db.prepare(`
      SELECT 1
      FROM raider_devices
      WHERE device_id = ? OR token_hash = ?
    `).get(request.replacementDeviceId, replacementTokenHash);
    if (operationConflict || deviceConflict) return { kind: 'conflict' };

    const enrollment = db.prepare(`
      SELECT enrollment.player_id, identity.dedupe_secret AS dedupe_secret
      FROM raider_enrollments AS enrollment
      JOIN raider_identities AS identity ON identity.player_id = enrollment.player_id
      WHERE enrollment.code_hash = ?
        AND enrollment.consumed_at IS NULL
        AND enrollment.expires_at > ?
    `).get(codeHash, now) as {
      player_id: number;
      dedupe_secret: string;
    } | undefined;
    if (!enrollment) return { kind: 'invalid_enrollment' };

    const consumed = db.prepare(`
      UPDATE raider_enrollments
      SET consumed_at = ?
      WHERE code_hash = ?
        AND consumed_at IS NULL
        AND expires_at > ?
    `).run(now, codeHash, now);
    if (consumed.changes !== 1) {
      throw new Error('replacement enrollment consumption did not update one row');
    }

    const insertedDevice = db.prepare(`
      INSERT INTO raider_devices
        (device_id, player_id, token_hash, companion_version, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      request.replacementDeviceId,
      enrollment.player_id,
      replacementTokenHash,
      request.companionVersion,
      now,
    );
    if (insertedDevice.changes !== 1) {
      throw new Error('replacement device insertion did not write one row');
    }

    const revoked = db.prepare(`
      UPDATE raider_devices
      SET revoked_at = ?
      WHERE device_id = ? AND revoked_at IS NULL
    `).run(now, old.device_id);
    if (revoked.changes !== 1) {
      throw new Error('old device revocation did not update one row');
    }

    const recorded = db.prepare(`
      INSERT INTO raider_device_replacements
        (operation_id, old_device_id, replacement_device_id, code_hash,
         companion_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      request.operationId,
      old.device_id,
      request.replacementDeviceId,
      codeHash,
      request.companionVersion,
      now,
    );
    if (recorded.changes !== 1) {
      throw new Error('replacement operation insertion did not write one row');
    }

    return {
      kind: 'created',
      deviceId: request.replacementDeviceId,
      dedupeSecret: enrollment.dedupe_secret,
    };
  });
  return replace();
}

/** Validate an active device credential without mutating device state. */
export function authenticateDevice(
  db: Database.Database,
  bearerToken: string,
  now: number,
): AuthenticatedDevice | null {
  requireTimestamp(now);
  if (!validCredential(bearerToken)) return null;

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

  return {
    deviceId: device.device_id,
    playerId: device.player_id,
    companionVersion: device.companion_version,
  };
}

/** Return recovery configuration for an active device credential without recording contact. */
export function getDeviceEnrollmentConfiguration(
  db: Database.Database,
  bearerToken: string,
  now: number,
): DeviceEnrollmentConfiguration | null {
  requireTimestamp(now);
  if (!validCredential(bearerToken)) return null;

  const configuration = db.prepare(`
    SELECT device.device_id, identity.dedupe_secret
    FROM raider_devices AS device
    JOIN raider_identities AS identity ON identity.player_id = device.player_id
    WHERE device.token_hash = ? AND device.revoked_at IS NULL
  `).get(sha256(bearerToken)) as {
    device_id: string;
    dedupe_secret: string;
  } | undefined;
  if (!configuration) return null;

  return {
    deviceId: configuration.device_id,
    dedupeSecret: configuration.dedupe_secret,
  };
}

/** Revoke a device credential once without recording contact. */
export function revokeDeviceCredential(
  db: Database.Database,
  bearerToken: string,
  now: number,
): 'revoked' | 'already_revoked' | null {
  requireTimestamp(now);
  if (!validCredential(bearerToken)) return null;

  const tokenHash = sha256(bearerToken);
  const device = db.prepare(`
    SELECT revoked_at
    FROM raider_devices
    WHERE token_hash = ?
  `).get(tokenHash) as { revoked_at: number | null } | undefined;
  if (!device) return null;
  if (device.revoked_at !== null) return 'already_revoked';

  const revoked = db.prepare(`
    UPDATE raider_devices
    SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `).run(now, tokenHash);
  if (revoked.changes !== 1) {
    throw new Error('device credential revocation did not update one row');
  }
  return 'revoked';
}

/** Record contact only after route-level quotas and request validation accept the request. */
export function recordDeviceContact(
  db: Database.Database,
  deviceId: string,
  now: number,
): boolean {
  requireTimestamp(now);
  if (!validDeviceId(deviceId)) return false;
  const updated = db.prepare(`
    UPDATE raider_devices
    SET last_seen_at = CASE
      WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ?
      ELSE last_seen_at
    END
    WHERE device_id = ? AND revoked_at IS NULL
  `).run(now, now, deviceId);
  return updated.changes === 1;
}

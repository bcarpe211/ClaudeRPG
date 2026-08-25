import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import {
  RUN_PRESENCE_MAX_EVENT_AGE_MS,
  activeRaiderIds,
  lastRaiderActivityAt,
  recordFreshRunPresence,
} from '../src/domain/run-presence';

const NOW = 1_800_000;

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  if (db.open) db.close();
});

function player(name: string): ReturnType<typeof createPlayer> {
  return createPlayer(db, { name, class_key: 'knight', gender: 'M' }, 1);
}

describe('recordFreshRunPresence', () => {
  it('accepts an observation exactly at the freshness boundary', () => {
    const raider = player('Boundary');

    expect(RUN_PRESENCE_MAX_EVENT_AGE_MS).toBe(120_000);
    expect(recordFreshRunPresence(db, raider.id, NOW - 120_000, NOW)).toBe(true);
    expect(lastRaiderActivityAt(db, raider.id)).toBe(NOW);
  });

  it('rejects stale and future observations without changing presence', () => {
    const raider = player('Freshness');

    expect(recordFreshRunPresence(db, raider.id, NOW - 120_001, NOW)).toBe(false);
    expect(recordFreshRunPresence(db, raider.id, NOW + 1, NOW)).toBe(false);
    expect(lastRaiderActivityAt(db, raider.id)).toBe(0);
  });

  it('advances by receipt time and cannot be rolled back by an older receipt', () => {
    const raider = player('Monotonic');

    expect(recordFreshRunPresence(db, raider.id, NOW - 10, NOW)).toBe(true);
    expect(recordFreshRunPresence(db, raider.id, NOW + 90, NOW + 100)).toBe(true);
    expect(recordFreshRunPresence(db, raider.id, NOW - 110, NOW - 100)).toBe(true);

    expect(lastRaiderActivityAt(db, raider.id)).toBe(NOW + 100);
    expect(db.prepare(`
      SELECT last_run_activity_at FROM raider_presence WHERE player_id = ?
    `).get(raider.id)).toEqual({ last_run_activity_at: NOW + 100 });
  });

  it('rejects disabled and missing players', () => {
    const disabled = player('Disabled');
    db.prepare('UPDATE players SET disabled = 1 WHERE id = ?').run(disabled.id);

    expect(recordFreshRunPresence(db, disabled.id, NOW, NOW)).toBe(false);
    expect(recordFreshRunPresence(db, disabled.id + 1000, NOW, NOW)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM raider_presence').get())
      .toEqual({ count: 0 });
  });

  it.each([
    ['playerId', -1, NOW, NOW],
    ['playerId', 1.5, NOW, NOW],
    ['playerId', Number.MAX_SAFE_INTEGER + 1, NOW, NOW],
    ['observedAtMs', 1, -1, NOW],
    ['observedAtMs', 1, 1.5, NOW],
    ['observedAtMs', 1, Number.MAX_SAFE_INTEGER + 1, NOW],
    ['receivedAtMs', 1, NOW, -1],
    ['receivedAtMs', 1, NOW, 1.5],
    ['receivedAtMs', 1, NOW, Number.MAX_SAFE_INTEGER + 1],
  ] as const)('validates invalid %s before accessing SQL', (_name, playerId, observed, received) => {
    db.close();
    expect(() => recordFreshRunPresence(db, playerId, observed, received))
      .toThrow(RangeError);
  });
});

describe('unified Raider activity', () => {
  it('uses the latest legacy or presence timestamp and excludes disabled players', () => {
    const legacy = player('Legacy');
    const presence = player('Presence');
    const mixed = player('Mixed');
    const disabled = player('Disabled');
    const idle = player('Idle');

    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?')
      .run(NOW - 1_000, legacy.id);
    db.prepare('INSERT INTO raider_presence VALUES (?, ?)')
      .run(presence.id, NOW - 500);
    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?')
      .run(NOW - 200, mixed.id);
    db.prepare('INSERT INTO raider_presence VALUES (?, ?)')
      .run(mixed.id, NOW - 400);
    db.prepare('UPDATE players SET disabled = 1, last_token_at = ? WHERE id = ?')
      .run(NOW + 1_000, disabled.id);
    db.prepare('INSERT INTO raider_presence VALUES (?, ?)')
      .run(disabled.id, NOW + 2_000);

    expect(lastRaiderActivityAt(db)).toBe(NOW - 200);
    expect(lastRaiderActivityAt(db, legacy.id)).toBe(NOW - 1_000);
    expect(lastRaiderActivityAt(db, presence.id)).toBe(NOW - 500);
    expect(lastRaiderActivityAt(db, mixed.id)).toBe(NOW - 200);
    expect(lastRaiderActivityAt(db, disabled.id)).toBe(0);
    expect(lastRaiderActivityAt(db, idle.id)).toBe(0);
  });

  it('includes activity exactly at the window boundary and excludes one millisecond older', () => {
    const windowMs = 15 * 60_000;
    const legacyBoundary = player('Legacy boundary');
    const presenceBoundary = player('Presence boundary');
    const expired = player('Expired');
    const disabled = player('Disabled');

    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?')
      .run(NOW - windowMs, legacyBoundary.id);
    db.prepare('INSERT INTO raider_presence VALUES (?, ?)')
      .run(presenceBoundary.id, NOW - windowMs);
    db.prepare('INSERT INTO raider_presence VALUES (?, ?)')
      .run(expired.id, NOW - windowMs - 1);
    db.prepare('UPDATE players SET disabled = 1, last_token_at = ? WHERE id = ?')
      .run(NOW, disabled.id);
    db.prepare('INSERT INTO raider_presence VALUES (?, ?)')
      .run(disabled.id, NOW);

    expect(activeRaiderIds(db, NOW, windowMs)).toEqual(new Set([
      legacyBoundary.id,
      presenceBoundary.id,
    ]));
  });

  it.each([
    ['lastRaiderActivityAt playerId', () => lastRaiderActivityAt(db, -1)],
    ['activeRaiderIds now', () => activeRaiderIds(db, -1, 0)],
    ['activeRaiderIds windowMs', () => activeRaiderIds(db, 0, -1)],
  ])('validates invalid %s before accessing SQL', (_name, query) => {
    db.close();
    expect(query).toThrow(RangeError);
  });
});

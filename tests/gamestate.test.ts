import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { getGameState, setPaused, lastActivityAt, isIdle } from '../src/domain/gamestate';
import { recordFreshRunPresence } from '../src/domain/run-presence';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

describe('gamestate', () => {
  it('reads the singleton and starts paused', () => {
    expect(getGameState(db).paused).toBe(1);
  });

  it('setPaused toggles and stamps last_activity', () => {
    setPaused(db, false, 1234);
    const gs = getGameState(db);
    expect(gs.paused).toBe(0);
    expect(gs.last_activity_at).toBe(1234);
  });

  it('lastActivityAt returns the latest enabled legacy or Run presence activity', () => {
    const legacy = createPlayer(db, { name: 'Legacy', class_key: 'knight', gender: 'M' }, 1);
    const both = createPlayer(db, { name: 'Both', class_key: 'thief', gender: 'F' }, 1);
    const presence = createPlayer(db, { name: 'Presence', class_key: 'ranger', gender: 'M' }, 1);
    const disabled = createPlayer(db, { name: 'Disabled', class_key: 'priest', gender: 'F' }, 1);

    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(9_500, legacy.id);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(6_000, both.id);
    expect(recordFreshRunPresence(db, both.id, 8_000, 8_000)).toBe(true);
    expect(recordFreshRunPresence(db, presence.id, 9_000, 9_000)).toBe(true);
    expect(recordFreshRunPresence(db, disabled.id, 10_000, 10_000)).toBe(true);
    db.prepare('UPDATE players SET last_token_at=?, disabled=1 WHERE id=?')
      .run(11_000, disabled.id);

    expect(lastActivityAt(db)).toBe(9_500);

    expect(recordFreshRunPresence(db, presence.id, 10_000, 10_000)).toBe(true);
    expect(lastActivityAt(db)).toBe(10_000);
  });

  it('lastActivityAt returns zero when enabled Raiders have no activity', () => {
    const disabled = createPlayer(db, { name: 'Disabled', class_key: 'knight', gender: 'M' }, 1);
    expect(recordFreshRunPresence(db, disabled.id, 9_000, 9_000)).toBe(true);
    db.prepare('UPDATE players SET last_token_at=?, disabled=1 WHERE id=?')
      .run(10_000, disabled.id);

    createPlayer(db, { name: 'Idle', class_key: 'thief', gender: 'F' }, 1);

    expect(lastActivityAt(db)).toBe(0);
  });

  it('isIdle true when no activity or activity older than pause window', () => {
    expect(isIdle(db, 100000, 15)).toBe(true); // no tokens ever
    const a = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(100000, a.id);
    expect(isIdle(db, 100000 + 14 * 60000, 15)).toBe(false); // within 15 min
    expect(isIdle(db, 100000 + 16 * 60000, 15)).toBe(true);  // beyond 15 min
  });
});

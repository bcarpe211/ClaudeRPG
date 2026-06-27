import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, updatePlayer } from '../src/domain/players';
import { getGameState, setPaused, lastActivityAt, isIdle } from '../src/domain/gamestate';

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

  it('lastActivityAt is the max player last_token_at', () => {
    const a = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const b = createPlayer(db, { name: 'B', class_key: 'thief', gender: 'F' }, 1);
    updatePlayer(db, a.id, {}); // no-op
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(5000, a.id);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(9000, b.id);
    expect(lastActivityAt(db)).toBe(9000);
  });

  it('isIdle true when no activity or activity older than pause window', () => {
    expect(isIdle(db, 100000, 15)).toBe(true); // no tokens ever
    const a = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(100000, a.id);
    expect(isIdle(db, 100000 + 14 * 60000, 15)).toBe(false); // within 15 min
    expect(isIdle(db, 100000 + 16 * 60000, 15)).toBe(true);  // beyond 15 min
  });
});

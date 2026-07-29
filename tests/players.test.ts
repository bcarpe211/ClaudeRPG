import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import {
  createPlayer,
  getPlayerById,
  getPlayerByToken,
  listPlayers,
  renamePlayer,
  updatePlayer,
  deletePlayer,
} from '../src/domain/players';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
});

const base = { name: 'Sir Reginald', class_key: 'knight', gender: 'M' as const };

describe('players', () => {
  it('creates a player with a unique token and sane defaults', () => {
    const p = createPlayer(db, base, 1000);
    expect(p.id).toBeGreaterThan(0);
    expect(p.auth_token.length).toBeGreaterThan(10);
    expect(p.level).toBe(1);
    expect(p.gold).toBe(0);
    expect(p.disabled).toBe(0);
    expect(p.created_at).toBe(1000);
  });

  it('fetches by id and by token', () => {
    const p = createPlayer(db, base, 1000);
    expect(getPlayerById(db, p.id)?.name).toBe('Sir Reginald');
    expect(getPlayerByToken(db, p.auth_token)?.id).toBe(p.id);
    expect(getPlayerByToken(db, 'bogus')).toBeUndefined();
  });

  it('lists players newest-first', () => {
    createPlayer(db, base, 1000);
    createPlayer(db, { ...base, name: 'Gandalf', class_key: 'wizard' }, 2000);
    const all = listPlayers(db);
    expect(all.map((p) => p.name)).toEqual(['Gandalf', 'Sir Reginald']);
  });

  it('renames and updates fields', () => {
    const p = createPlayer(db, base, 1000);
    renamePlayer(db, p.id, 'Reginald the Bold');
    expect(getPlayerById(db, p.id)?.name).toBe('Reginald the Bold');
    updatePlayer(db, p.id, { level: 5, disabled: 1 });
    const u = getPlayerById(db, p.id)!;
    expect(u.level).toBe(5);
    expect(u.disabled).toBe(1);
  });

  it('rejects gold in a generic player patch', () => {
    const p = createPlayer(db, base, 1000);
    expect(() =>
      // @ts-expect-error - gold must use setGoldBalance
      updatePlayer(db, p.id, { gold: 250 }),
    ).toThrow(/illegal column/);
    expect(getPlayerById(db, p.id)?.gold).toBe(0);
  });

  it('deletes a player', () => {
    const p = createPlayer(db, base, 1000);
    deletePlayer(db, p.id);
    expect(getPlayerById(db, p.id)).toBeUndefined();
  });

  it('rejects an unknown column in updatePlayer', () => {
    const p = createPlayer(db, base, 1000);
    expect(() =>
      // @ts-expect-error - intentionally passing an illegal key at runtime
      updatePlayer(db, p.id, { id: 999 }),
    ).toThrow(/illegal column/);
  });
});

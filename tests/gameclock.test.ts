import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import {
  advanceCombatClock,
  combatActiveMs,
  combatActiveMsForDay,
  isCombatAcceptingWork,
} from '../src/domain/gameclock';
import { createPlayer } from '../src/domain/players';

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
});

function seedActiveEncounter(now: number): void {
  const player = createPlayer(
    db,
    { name: 'Clock Tester', class_key: 'knight', gender: 'M' },
    now,
  );
  db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(now, player.id);
  const dungeon = db.prepare(
    `INSERT INTO dungeons
     (level, theme, seed, regular_count, created_at)
     VALUES (1, 'Ossuary Pale', 1, 2, ?)`,
  ).run(now);
  const encounter = db.prepare(
    `INSERT INTO encounters
     (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
      pack_count, max_hp, current_hp, status, started_at)
     VALUES (?, 0, 'single', 1, 1, 1, 100, 100, 'active', ?)`,
  ).run(Number(dungeon.lastInsertRowid), now);
  db.prepare(
    `UPDATE game_state
     SET current_dungeon_id=?, current_encounter_id=? WHERE id=1`,
  ).run(Number(dungeon.lastInsertRowid), Number(encounter.lastInsertRowid));
}

describe('combat-active game clock', () => {
  it('advances only by a non-negative integer delta', () => {
    expect(combatActiveMs(db)).toBe(0);
    advanceCombatClock(db, 1000, 1000, 'America/New_York');
    expect(combatActiveMs(db)).toBe(1000);
    expect(combatActiveMsForDay(db, '1969-12-31')).toBe(1000);
    expect(() => advanceCombatClock(db, -1, 1000, 'America/New_York'))
      .toThrow(RangeError);
    expect(() => advanceCombatClock(db, 0.5, 1000, 'America/New_York'))
      .toThrow(RangeError);
  });

  it('splits elapsed time exactly across office midnight', () => {
    const midnight = Date.parse('2026-07-28T04:00:00Z');
    advanceCombatClock(db, 2000, midnight + 1000, 'America/New_York');

    expect(combatActiveMs(db)).toBe(2000);
    expect(combatActiveMsForDay(db, '2026-07-27')).toBe(1000);
    expect(combatActiveMsForDay(db, '2026-07-28')).toBe(1000);
  });

  it('accepts work only for a live encounter outside idle and defeat state', () => {
    expect(isCombatAcceptingWork(db, 1000, 15)).toBe(false);

    seedActiveEncounter(1000);
    expect(isCombatAcceptingWork(db, 1000, 15)).toBe(true);

    db.prepare('UPDATE game_state SET defeat_until=? WHERE id=1').run(2000);
    expect(isCombatAcceptingWork(db, 1500, 15)).toBe(false);
    expect(isCombatAcceptingWork(db, 2000, 15)).toBe(true);

    db.prepare("UPDATE encounters SET status='defeated'").run();
    expect(isCombatAcceptingWork(db, 2000, 15)).toBe(false);
  });

  it('does not let a stale paused flag override otherwise-live combat eligibility', () => {
    seedActiveEncounter(1_000);
    db.prepare('UPDATE game_state SET paused=1 WHERE id=1').run();

    expect(db.prepare('SELECT paused FROM game_state WHERE id=1').get())
      .toEqual({ paused: 1 });
    expect(isCombatAcceptingWork(db, 1_000, 15)).toBe(true);
  });
});

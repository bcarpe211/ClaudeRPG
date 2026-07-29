import type Database from 'better-sqlite3';
import { isIdle } from './gamestate';
import { nextOfficeMidnight, officeDayKey } from './office-time';

export function combatActiveMs(db: Database.Database): number {
  const row = db.prepare(
    'SELECT combat_active_ms FROM game_state WHERE id=1',
  ).get() as { combat_active_ms: number };
  return row.combat_active_ms;
}

export function combatActiveMsForDay(
  db: Database.Database,
  dayKey: string,
): number {
  const row = db.prepare(
    'SELECT active_ms FROM game_clock_days WHERE office_day=?',
  ).get(dayKey) as { active_ms: number } | undefined;
  return row?.active_ms ?? 0;
}

export function advanceCombatClock(
  db: Database.Database,
  deltaMs: number,
  intervalEnd: number,
  timeZone: string,
): number {
  if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
    throw new RangeError('deltaMs must be a non-negative integer');
  }
  if (!Number.isSafeInteger(intervalEnd)) {
    throw new RangeError('intervalEnd must be an integer epoch millisecond');
  }
  const intervalStart = intervalEnd - deltaMs;
  if (!Number.isSafeInteger(intervalStart)) {
    throw new RangeError('clock interval is outside the safe integer range');
  }
  if (deltaMs === 0) return combatActiveMs(db);

  const activeMsByDay = new Map<string, number>();
  let cursor = intervalStart;
  while (cursor < intervalEnd) {
    const dayKey = officeDayKey(cursor, timeZone);
    const segmentEnd = Math.min(
      intervalEnd,
      nextOfficeMidnight(cursor, timeZone),
    );
    activeMsByDay.set(
      dayKey,
      (activeMsByDay.get(dayKey) ?? 0) + segmentEnd - cursor,
    );
    cursor = segmentEnd;
  }

  return db.transaction(() => {
    db.prepare(
      `UPDATE game_state
       SET combat_active_ms = combat_active_ms + ?
       WHERE id=1`,
    ).run(deltaMs);
    const addDay = db.prepare(
      `INSERT INTO game_clock_days (office_day, active_ms)
       VALUES (?, ?)
       ON CONFLICT(office_day) DO UPDATE SET
         active_ms = active_ms + excluded.active_ms`,
    );
    for (const [dayKey, activeMs] of activeMsByDay) {
      addDay.run(dayKey, activeMs);
    }
    return combatActiveMs(db);
  })();
}

export function isCombatAcceptingWork(
  db: Database.Database,
  now: number,
  pauseAfterMinutes: number,
): boolean {
  if (isIdle(db, now, pauseAfterMinutes)) return false;

  const state = db.prepare(
    `SELECT gs.defeat_until, e.status AS encounter_status
     FROM game_state gs
     LEFT JOIN encounters e ON e.id = gs.current_encounter_id
     WHERE gs.id=1`,
  ).get() as {
    defeat_until: number | null;
    encounter_status: string | null;
  };
  if (state.defeat_until !== null && now < state.defeat_until) return false;
  return state.encounter_status === 'active';
}

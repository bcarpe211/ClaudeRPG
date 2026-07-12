import type Database from 'better-sqlite3';

export interface ActivityCfg {
  decayAfterMinutes: number;
  decaySpanMinutes: number;
}

/**
 * Accumulated effective tokens for a player's CURRENT activity session, with
 * linear post-idle decay. Uncapped. Pure function of token_events + now.
 * Session = a run of events with no gap >= decayAfterMinutes.
 */
export function activityScore(
  db: Database.Database, playerId: number, now: number, cfg: ActivityCfg,
): number {
  const afterMs = cfg.decayAfterMinutes * 60_000;
  const spanMs = Math.max(1, cfg.decaySpanMinutes * 60_000);
  const LOOKBACK_MS = 24 * 60 * 60_000;
  const rows = db.prepare(
    'SELECT ts, effective_delta FROM token_events WHERE player_id=? AND ts>=? AND ts<=? ORDER BY ts DESC',
  ).all(playerId, now - LOOKBACK_MS, now) as { ts: number; effective_delta: number }[];
  if (rows.length === 0) return 0;

  let sessionSum = 0;
  let prevTs = rows[0].ts;
  for (const r of rows) {
    if (prevTs - r.ts >= afterMs) break;
    sessionSum += r.effective_delta;
    prevTs = r.ts;
  }

  const gap0 = now - rows[0].ts;
  if (gap0 <= afterMs) return sessionSum;
  const factor = Math.max(0, 1 - (gap0 - afterMs) / spanMs);
  return sessionSum * factor;
}

import type Database from 'better-sqlite3';
import { parseTokenDataPoints, type TokenDataPoint } from './otlp';
import { getPlayerByToken } from './players';

function seriesKey(p: TokenDataPoint): string {
  return `${p.token ?? ' '}|${p.type}|${p.model}|${p.startTimeUnixNano}`;
}

/**
 * Convert a data point to the increment to apply.
 * - delta: the value IS the increment.
 * - cumulative: diff against the last value stored for this series; first
 *   sighting counts the full value; a drop (counter reset) counts the new value.
 */
export function computeIncrement(
  db: Database.Database,
  p: TokenDataPoint,
): number {
  if (p.temporality === 'delta') {
    return Math.max(0, Math.round(p.value));
  }
  const key = seriesKey(p);
  const row = db
    .prepare('SELECT last_value FROM metric_series WHERE series_key = ?')
    .get(key) as { last_value: number } | undefined;
  const current = Math.round(p.value);
  let delta: number;
  if (!row) {
    delta = Math.max(0, current);
  } else if (current >= row.last_value) {
    delta = current - row.last_value;
  } else {
    delta = Math.max(0, current); // counter reset
  }
  db.prepare(
    `INSERT INTO metric_series (series_key, last_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(series_key) DO UPDATE SET last_value = excluded.last_value, updated_at = excluded.updated_at`,
  ).run(key, current, Date.now());
  return delta;
}

// Re-export for future use in this module (avoids unused-import issues if TS
// strict mode is ever enabled, while keeping these imports available for the
// next tasks that will extend this file).
export { parseTokenDataPoints, getPlayerByToken };

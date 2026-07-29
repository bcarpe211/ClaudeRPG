import type Database from 'better-sqlite3';
import { parseTokenDataPoints, type TokenDataPoint } from './otlp';
import { getPlayerByToken } from './players';
import { applyGoldPotionWork } from './potions';

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
  now: number,
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
  ).run(key, current, now);
  return delta;
}

export interface IngestOptions {
  cacheReadWeight: number;
}

export interface IngestResult {
  appliedPlayers: number; // distinct players whose stats changed
  ignoredUnknownTokens: number;
}

interface PerToken {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

function emptyPerToken(): PerToken {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/**
 * Parse an OTLP body, recover per-data-point increments, aggregate per token,
 * and apply to players: bump total_tokens, effective_tokens, last_token_at, and
 * append a token_events row. Unknown tokens and disabled players are ignored.
 */
export function ingestTokenUsage(
  db: Database.Database,
  body: unknown,
  now: number,
  opts: IngestOptions,
): IngestResult {
  const points = parseTokenDataPoints(body);
  const apply = db.transaction((): IngestResult => {
    const byToken = new Map<string, PerToken>();
    const claimDelivery = db.prepare(
      `INSERT OR IGNORE INTO metric_deliveries
        (series_key, time_unix_nano, received_at)
       VALUES (?, ?, ?)`,
    );
    for (const p of points) {
      const claimed = claimDelivery.run(seriesKey(p), p.timeUnixNano, now);
      if (claimed.changes === 0) continue;
      const inc = computeIncrement(db, p, now);
      if (inc <= 0 || p.token == null) continue;
      const agg = byToken.get(p.token) ?? emptyPerToken();
      if (p.type === 'input') agg.input += inc;
      else if (p.type === 'output') agg.output += inc;
      else if (p.type === 'cacheCreation') agg.cacheCreation += inc;
      else if (p.type === 'cacheRead') agg.cacheRead += inc;
      // unknown type strings contribute nothing
      byToken.set(p.token, agg);
    }

    let appliedPlayers = 0;
    let ignoredUnknownTokens = 0;
    for (const [token, agg] of byToken) {
      const player = getPlayerByToken(db, token);
      if (!player) {
        ignoredUnknownTokens++;
        continue;
      }
      if (player.disabled) continue;

      const effective =
        agg.input +
        agg.output +
        agg.cacheCreation +
        Math.round(agg.cacheRead * opts.cacheReadWeight);
      const total = agg.input + agg.output + agg.cacheCreation + agg.cacheRead;
      if (effective <= 0 && total <= 0) continue;

      db.prepare(
        `UPDATE players
         SET total_tokens = total_tokens + ?,
             effective_tokens = effective_tokens + ?,
             last_token_at = ?
         WHERE id = ?`,
      ).run(total, effective, now, player.id);

      const tokenEvent = db.prepare(
        `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
         VALUES (?, ?, ?, ?)`,
      ).run(player.id, now, effective, total);

      applyGoldPotionWork(
        db,
        player.id,
        Number(tokenEvent.lastInsertRowid),
        effective,
        now,
      );

      appliedPlayers++;
    }
    return { appliedPlayers, ignoredUnknownTokens };
  });
  return apply();
}

/** Sum of effective tokens a player received at or after `since` (engine helper). */
export function sumEffectiveSince(
  db: Database.Database,
  playerId: number,
  since: number,
): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(effective_delta), 0) AS s FROM token_events WHERE player_id = ? AND ts >= ?',
    )
    .get(playerId, since) as { s: number };
  return row.s;
}

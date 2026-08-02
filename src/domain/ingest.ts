import type Database from 'better-sqlite3';
import { parseTokenDataPoints, type TokenDataPoint } from './otlp';
import { getPlayerByToken } from './players';
import { applyGoldPotionWork } from './potions';
import { METRICS_INGEST_LIMITS } from './metrics-policy';

const SUPPORTED_TOKEN_TYPES = new Set([
  'input',
  'output',
  'cacheCreation',
  'cacheRead',
]);

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

function validPointIdentity(p: TokenDataPoint): boolean {
  const roundedValue = Math.round(p.value);
  return SUPPORTED_TOKEN_TYPES.has(p.type)
    && Number.isFinite(p.value)
    && p.value >= 0
    && Number.isSafeInteger(roundedValue)
    && p.timeUnixNano.length > 0
    && p.timeUnixNano.length <= METRICS_INGEST_LIMITS.maxIdentityFieldLength
    && p.startTimeUnixNano.length <= METRICS_INGEST_LIMITS.maxIdentityFieldLength
    && p.model.length <= METRICS_INGEST_LIMITS.maxIdentityFieldLength;
}

function addIncrement(
  aggregate: PerToken,
  type: keyof PerToken,
  increment: number,
): void {
  const next = aggregate[type] + increment;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new RangeError('token metric aggregate must be a non-negative safe integer');
  }
  aggregate[type] = next;
}

/**
 * Project one positive activity credit through the legacy player/token-event
 * compatibility path. Callers may wrap this in a larger transaction; nested
 * better-sqlite3 transactions use a savepoint and preserve all-or-nothing
 * behavior through potion attribution.
 */
export function applyActivityCredit(
  db: Database.Database,
  playerId: number,
  effectiveDelta: number,
  totalDelta: number,
  now: number,
): number {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) {
    throw new RangeError('playerId must be a positive safe integer');
  }
  for (const [label, value] of [
    ['effectiveDelta', effectiveDelta],
    ['totalDelta', totalDelta],
    ['now', now],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer`);
    }
  }
  if (effectiveDelta <= 0 && totalDelta <= 0) {
    throw new RangeError('activity credit must contain a positive delta');
  }

  const apply = db.transaction((): number => {
    const player = db.prepare(`
      SELECT effective_tokens, total_tokens FROM players WHERE id = ?
    `).get(playerId) as {
      effective_tokens: number;
      total_tokens: number;
    } | undefined;
    if (!player) throw new RangeError('player does not exist');
    if (!Number.isSafeInteger(player.effective_tokens + effectiveDelta)
      || !Number.isSafeInteger(player.total_tokens + totalDelta)) {
      throw new RangeError('persisted token totals must remain safe integers');
    }

    const updated = db.prepare(
      `UPDATE players
       SET total_tokens = total_tokens + ?,
           effective_tokens = effective_tokens + ?,
           last_token_at = ?
       WHERE id = ?`,
    ).run(totalDelta, effectiveDelta, now, playerId);
    if (updated.changes !== 1) throw new Error('activity player update was not applied');

    const tokenEvent = db.prepare(
      `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
       VALUES (?, ?, ?, ?)`,
    ).run(playerId, now, effectiveDelta, totalDelta);
    const tokenEventId = Number(tokenEvent.lastInsertRowid);
    if (!Number.isSafeInteger(tokenEventId) || tokenEventId <= 0) {
      throw new RangeError('token event id must be a positive safe integer');
    }

    applyGoldPotionWork(db, playerId, tokenEventId, effectiveDelta, now);
    return tokenEventId;
  });
  return apply();
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
  const knownPlayers = new Map<string, NonNullable<ReturnType<typeof getPlayerByToken>>>();
  const unknownTokens = new Set<string>();
  const acceptedPoints: TokenDataPoint[] = [];

  // Resolve every token and validate every point before the first stateful
  // operation. Invalid/null/unknown points cannot claim delivery identities or
  // advance cumulative checkpoints.
  for (const point of points) {
    if (!validPointIdentity(point) || point.token == null) continue;
    let player = knownPlayers.get(point.token);
    if (!player && !unknownTokens.has(point.token)) {
      player = getPlayerByToken(db, point.token);
      if (player) knownPlayers.set(point.token, player);
      else unknownTokens.add(point.token);
    }
    if (player) acceptedPoints.push(point);
  }

  const apply = db.transaction((): IngestResult => {
    const byToken = new Map<string, PerToken>();
    const claimDelivery = db.prepare(
      `INSERT OR IGNORE INTO metric_deliveries
        (series_key, time_unix_nano, received_at)
       VALUES (?, ?, ?)`,
    );
    for (const p of acceptedPoints) {
      const claimed = claimDelivery.run(seriesKey(p), p.timeUnixNano, now);
      if (claimed.changes === 0) continue;
      const inc = computeIncrement(db, p, now);
      if (inc <= 0 || p.token == null) continue;
      const agg = byToken.get(p.token) ?? emptyPerToken();
      addIncrement(agg, p.type as keyof PerToken, inc);
      byToken.set(p.token, agg);
    }

    let appliedPlayers = 0;
    for (const [token, agg] of byToken) {
      const player = knownPlayers.get(token)!;
      if (player.disabled) continue;

      const effective =
        agg.input +
        agg.output +
        agg.cacheCreation +
        Math.round(agg.cacheRead * opts.cacheReadWeight);
      const total = agg.input + agg.output + agg.cacheCreation + agg.cacheRead;
      if (effective <= 0 && total <= 0) continue;
      if (!Number.isSafeInteger(effective) || !Number.isSafeInteger(total)) {
        throw new RangeError('persisted token totals must remain safe integers');
      }

      applyActivityCredit(db, player.id, effective, total, now);

      appliedPlayers++;
    }
    return {
      appliedPlayers,
      ignoredUnknownTokens: unknownTokens.size,
    };
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

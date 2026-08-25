import type Database from 'better-sqlite3';

export const RUN_PRESENCE_MAX_EVENT_AGE_MS = 120_000;

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function recordFreshRunPresence(
  db: Database.Database,
  playerId: number,
  observedAtMs: number,
  receivedAtMs: number,
): boolean {
  assertNonNegativeSafeInteger(playerId, 'playerId');
  assertNonNegativeSafeInteger(observedAtMs, 'observedAtMs');
  assertNonNegativeSafeInteger(receivedAtMs, 'receivedAtMs');

  if (observedAtMs > receivedAtMs
    || receivedAtMs - observedAtMs > RUN_PRESENCE_MAX_EVENT_AGE_MS) {
    return false;
  }

  const enabled = db.prepare(`
    SELECT 1 AS enabled
    FROM players
    WHERE id = ? AND disabled = 0
  `).get(playerId) as { enabled: 1 } | undefined;
  if (!enabled) return false;

  db.prepare(`
    INSERT INTO raider_presence (player_id, last_run_activity_at)
    VALUES (?, ?)
    ON CONFLICT(player_id) DO UPDATE SET
      last_run_activity_at = MAX(
        last_run_activity_at,
        excluded.last_run_activity_at
      )
  `).run(playerId, receivedAtMs);
  return true;
}

export function lastRaiderActivityAt(
  db: Database.Database,
  playerId?: number,
): number {
  if (playerId !== undefined) {
    assertNonNegativeSafeInteger(playerId, 'playerId');
  }

  const row = db.prepare(`
    WITH activity AS (
      SELECT player.last_token_at AS activity_at
      FROM players AS player
      WHERE player.disabled = 0
        AND player.last_token_at IS NOT NULL
        AND (@playerId IS NULL OR player.id = @playerId)

      UNION ALL

      SELECT presence.last_run_activity_at AS activity_at
      FROM raider_presence AS presence
      JOIN players AS player ON player.id = presence.player_id
      WHERE player.disabled = 0
        AND (@playerId IS NULL OR player.id = @playerId)
    )
    SELECT COALESCE(MAX(activity_at), 0) AS activity_at
    FROM activity
  `).get({ playerId: playerId ?? null }) as { activity_at: number };
  return row.activity_at;
}

export function activeRaiderIds(
  db: Database.Database,
  now: number,
  windowMs: number,
): ReadonlySet<number> {
  assertNonNegativeSafeInteger(now, 'now');
  assertNonNegativeSafeInteger(windowMs, 'windowMs');

  const rows = db.prepare(`
    WITH activity AS (
      SELECT player.id AS player_id, player.last_token_at AS activity_at
      FROM players AS player
      WHERE player.disabled = 0
        AND player.last_token_at IS NOT NULL

      UNION ALL

      SELECT player.id AS player_id, presence.last_run_activity_at AS activity_at
      FROM raider_presence AS presence
      JOIN players AS player ON player.id = presence.player_id
      WHERE player.disabled = 0
    )
    SELECT DISTINCT player_id
    FROM activity
    WHERE activity_at >= ?
  `).all(now - windowMs) as { player_id: number }[];

  return new Set(rows.map((row) => row.player_id));
}

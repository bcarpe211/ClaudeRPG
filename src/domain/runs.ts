import type Database from 'better-sqlite3';
import type {
  RunEventV1,
  RunProvider,
  RunSurface,
  UsageCountersV1,
} from './run-events';

export interface RunSummary {
  provider: RunProvider;
  surface: RunSurface;
  state: RunEventV1['state'];
  startedAt: number;
  terminalAt: number | null;
  lastEventAt: number;
  lastObservedAt: number;
  usage: UsageCountersV1;
  model: string | null;
  effort: string | null;
  policyVersion: string;
  raidPower: number;
  updatedAt: number;
}

interface RunSummaryRow {
  provider: RunProvider;
  surface: RunSurface;
  state: RunEventV1['state'];
  started_at_ms: number;
  terminal_at_ms: number | null;
  last_event_at_ms: number;
  last_observed_at_ms: number;
  usage_input: number;
  usage_output: number;
  usage_cache_read: number;
  usage_cache_write: number;
  usage_reasoning_output: number;
  latest_model: string | null;
  latest_effort: string | null;
  policy_version: string;
  raid_power: number;
  updated_at: number;
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function recentRuns(
  db: Database.Database,
  playerId: number,
  limit: number,
): RunSummary[] {
  requirePositiveSafeInteger(playerId, 'playerId');
  requirePositiveSafeInteger(limit, 'limit');

  const rows = db.prepare(`
    SELECT provider, surface, state, started_at_ms, terminal_at_ms,
           last_event_at_ms, last_observed_at_ms, usage_input, usage_output,
           usage_cache_read, usage_cache_write, usage_reasoning_output,
           latest_model, latest_effort, policy_version, raid_power, updated_at
    FROM runs
    WHERE player_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(playerId, Math.min(limit, 20)) as RunSummaryRow[];

  return rows.map((row) => ({
    provider: row.provider,
    surface: row.surface,
    state: row.state,
    startedAt: row.started_at_ms,
    terminalAt: row.terminal_at_ms,
    lastEventAt: row.last_event_at_ms,
    lastObservedAt: row.last_observed_at_ms,
    usage: {
      input: row.usage_input,
      output: row.usage_output,
      cache_read: row.usage_cache_read,
      cache_write: row.usage_cache_write,
      reasoning_output: row.usage_reasoning_output,
    },
    model: row.latest_model,
    effort: row.latest_effort,
    policyVersion: row.policy_version,
    raidPower: row.raid_power,
    updatedAt: row.updated_at,
  }));
}

export function activeRunCount(
  db: Database.Database,
  playerId: number,
  now: number,
  staleAfterMs: number,
): number {
  requirePositiveSafeInteger(playerId, 'playerId');
  requireNonNegativeSafeInteger(now, 'now');
  requireNonNegativeSafeInteger(staleAfterMs, 'staleAfterMs');
  const freshSince = Math.max(0, now - staleAfterMs);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM runs
    WHERE player_id = ?
      AND state = 'open'
      AND last_observed_at_ms >= ?
  `).get(playerId, freshSince) as { count: number };
  return row.count;
}

export function collectorStatus(
  db: Database.Database,
  playerId: number,
): { lastSeenAt: number | null; devices: number } {
  requirePositiveSafeInteger(playerId, 'playerId');
  const row = db.prepare(`
    SELECT MAX(last_seen_at) AS lastSeenAt, COUNT(*) AS devices
    FROM raider_devices
    WHERE player_id = ? AND revoked_at IS NULL
  `).get(playerId) as { lastSeenAt: number | null; devices: number };
  return row;
}

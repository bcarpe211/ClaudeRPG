import type Database from 'better-sqlite3';
import { applyActivityCredit } from './ingest';
import type { AuthenticatedDevice } from './raider-enrollment';
import {
  durationCredit,
  usageCredit,
  type RaidPowerPolicy,
} from './raid-power-policy';
import {
  policyForRunStart,
  type RaidPowerPolicySchedule,
} from './raid-power-policy-schedule';
import { recordFreshRunPresence } from './run-presence';
import type { RunEventV1, UsageCountersV1 } from './run-events';

export interface RunIngestResult {
  accepted: number;
  duplicate: number;
  ignored: number;
}

interface RunRow {
  id: number;
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
  policy_version: string;
  awarded_usage_credit: number;
  awarded_completion_credit: number;
  awarded_duration_credit: number;
  raid_power: number;
  updated_at: number;
}

const usageColumns: ReadonlyArray<[
  keyof UsageCountersV1,
  keyof Pick<
    RunRow,
    | 'usage_input'
    | 'usage_output'
    | 'usage_cache_read'
    | 'usage_cache_write'
    | 'usage_reasoning_output'
  >,
]> = [
  ['input', 'usage_input'],
  ['output', 'usage_output'],
  ['cache_read', 'usage_cache_read'],
  ['cache_write', 'usage_cache_write'],
  ['reasoning_output', 'usage_reasoning_output'],
];

function safeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  safeNonNegativeInteger(left, label);
  safeNonNegativeInteger(right, label);
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return sum;
}

function policyKey(policy: RaidPowerPolicy): string {
  const version = safeNonNegativeInteger(policy.policy_version, 'policy version');
  return `raid-power-v${version}`;
}

function cumulativeUsage(run: RunRow, event: RunEventV1): UsageCountersV1 {
  const target = {} as UsageCountersV1;
  for (const [eventKey, runKey] of usageColumns) {
    target[eventKey] = Math.max(run[runKey], event.usage[eventKey]);
  }
  return target;
}

function findRun(
  db: Database.Database,
  playerId: number,
  event: RunEventV1,
): RunRow | undefined {
  return db.prepare(`
    SELECT id, state, started_at_ms, terminal_at_ms, last_event_at_ms,
           last_observed_at_ms, usage_input, usage_output, usage_cache_read,
           usage_cache_write, usage_reasoning_output, policy_version,
           awarded_usage_credit, awarded_completion_credit,
           awarded_duration_credit, raid_power, updated_at
    FROM runs
    WHERE player_id = ? AND provider = ? AND run_key = ?
  `).get(playerId, event.provider, event.run_key) as RunRow | undefined;
}

function createRun(
  db: Database.Database,
  playerId: number,
  event: RunEventV1,
  policyVersion: string,
  now: number,
): RunRow {
  db.prepare(`
    INSERT INTO runs
      (player_id, provider, surface, run_key, state, started_at_ms,
       terminal_at_ms, last_event_at_ms, last_observed_at_ms, latest_model,
       latest_effort, policy_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    playerId,
    event.provider,
    event.surface,
    event.run_key,
    event.started_at_ms,
    event.event_time_ms,
    event.observed_at_ms,
    event.model,
    event.effort,
    policyVersion,
    now,
    now,
  );
  return findRun(db, playerId, event)!;
}

function claimRunEvent(
  db: Database.Database,
  runId: number,
  event: RunEventV1,
  policyVersion: string,
  now: number,
): boolean {
  const claim = db.prepare(`
    INSERT INTO run_events
      (event_key, run_id, device_id, sequence, schema_version,
       companion_version, provider, surface, run_key, event_time_ms,
       observed_at_ms, started_at_ms, state, usage_input, usage_output,
       usage_cache_read, usage_cache_write, usage_reasoning_output, model,
       effort, policy_version, awarded_delta, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(
    event.idempotency_key,
    runId,
    event.device_id,
    event.sequence,
    event.schema_version,
    event.companion_version,
    event.provider,
    event.surface,
    event.run_key,
    event.event_time_ms,
    event.observed_at_ms,
    event.started_at_ms,
    event.state,
    event.usage.input,
    event.usage.output,
    event.usage.cache_read,
    event.usage.cache_write,
    event.usage.reasoning_output,
    event.model,
    event.effort,
    policyVersion,
    0,
    now,
  );
  return claim.changes === 1;
}

/**
 * Apply an authenticated device's already-parsed Run events in one atomic
 * batch. Events before the explicit cutover are rejected without claiming an
 * identity; exact identities and already-seen Run sequences are duplicates.
 */
export function ingestRunEvents(
  db: Database.Database,
  device: AuthenticatedDevice,
  events: readonly RunEventV1[],
  schedule: RaidPowerPolicySchedule,
  now: number,
): RunIngestResult {
  safeNonNegativeInteger(now, 'now');

  const ingest = db.transaction((): RunIngestResult => {
    const result: RunIngestResult = { accepted: 0, duplicate: 0, ignored: 0 };
    const player = db.prepare('SELECT disabled FROM players WHERE id = ?')
      .get(device.playerId) as { disabled: number } | undefined;
    if (!player) throw new RangeError('authenticated Raider does not exist');

    for (const event of events) {
      const policy = policyForRunStart(schedule, event.started_at_ms);
      if (event.device_id !== device.deviceId || policy === null) {
        result.ignored++;
        continue;
      }

      const exactIdentity = db.prepare(`
        SELECT 1 FROM run_events WHERE event_key = ?
      `).get(event.idempotency_key);
      if (exactIdentity) {
        result.duplicate++;
        continue;
      }

      const version = policyKey(policy);
      let run = findRun(db, device.playerId, event);
      const createdRun = run === undefined;
      if (!run) run = createRun(db, device.playerId, event, version, now);
      if (run.policy_version !== version) {
        throw new Error(
          `Run policy ${run.policy_version} cannot be rescored with ${version}`,
        );
      }

      if (!claimRunEvent(db, run.id, event, version, now)) {
        if (createdRun) {
          db.prepare(`
            DELETE FROM runs
            WHERE id = ?
              AND NOT EXISTS (SELECT 1 FROM run_events WHERE run_id = ?)
          `).run(run.id, run.id);
        }
        result.duplicate++;
        continue;
      }

      if (policy.policy_version === 2) {
        usageCredit(policy, event.provider, event.usage);
      }
      const recordedPresence = !player.disabled && recordFreshRunPresence(
        db,
        device.playerId,
        event.observed_at_ms,
        now,
      );

      const priorSequence = db.prepare(`
        SELECT MAX(sequence) AS sequence
        FROM run_events WHERE run_id = ? AND event_key <> ?
      `).get(run.id, event.idempotency_key) as { sequence: number | null };
      if (priorSequence.sequence !== null && event.sequence < priorSequence.sequence) {
        result.accepted++;
        continue;
      }

      const usage = cumulativeUsage(run, event);
      const cumulativeUsageCredit = usageCredit(policy, event.provider, usage);
      const v1UsageExpired = policy.policy_version === 1 && now >= schedule.v2CutoverAt;
      const targetUsageCredit = v1UsageExpired
        ? run.awarded_usage_credit
        : cumulativeUsageCredit;
      if (targetUsageCredit < run.awarded_usage_credit) {
        throw new RangeError('cumulative usage credit cannot roll back');
      }
      const usageDelta = targetUsageCredit - run.awarded_usage_credit;

      const acceptsTerminal = run.state === 'open' && event.state !== 'open';
      const state = acceptsTerminal ? event.state : run.state;
      const terminalAt = acceptsTerminal ? event.event_time_ms : run.terminal_at_ms;

      let targetCompletionCredit = run.awarded_completion_credit;
      if (state === 'completed' && (cumulativeUsageCredit > 0 || player.disabled)) {
        targetCompletionCredit = Math.max(
          targetCompletionCredit,
          safeNonNegativeInteger(policy.completion_credit, 'completion credit'),
        );
      }
      const completionDelta = targetCompletionCredit - run.awarded_completion_credit;

      let targetDurationCredit = run.awarded_duration_credit;
      if (state === 'completed'
        && terminalAt !== null
        && (cumulativeUsageCredit > 0 || player.disabled)) {
        targetDurationCredit = Math.max(
          targetDurationCredit,
          safeNonNegativeInteger(
            durationCredit(policy, terminalAt - run.started_at_ms),
            'duration credit',
          ),
        );
      }
      const durationDelta = targetDurationCredit - run.awarded_duration_credit;
      const eligibleDelta = safeAdd(
        safeAdd(usageDelta, completionDelta, 'combined Run credit'),
        durationDelta,
        'combined Run credit',
      );
      const awardedDelta = player.disabled ? 0 : eligibleDelta;
      const raidPower = player.disabled
        ? run.raid_power
        : safeAdd(run.raid_power, awardedDelta, 'Run Raid Power');

      const updatedAt = Math.max(run.updated_at, now);
      db.prepare(`
        UPDATE runs
        SET state = ?, terminal_at_ms = ?,
            last_event_at_ms = MAX(last_event_at_ms, ?),
            last_observed_at_ms = MAX(last_observed_at_ms, ?),
            usage_input = ?, usage_output = ?, usage_cache_read = ?,
            usage_cache_write = ?, usage_reasoning_output = ?,
            latest_model = ?, latest_effort = ?, awarded_usage_credit = ?,
            awarded_completion_credit = ?, awarded_duration_credit = ?,
            raid_power = ?, updated_at = ?
        WHERE id = ?
      `).run(
        state,
        terminalAt,
        event.event_time_ms,
        event.observed_at_ms,
        usage.input,
        usage.output,
        usage.cache_read,
        usage.cache_write,
        usage.reasoning_output,
        event.model,
        event.effort,
        targetUsageCredit,
        targetCompletionCredit,
        targetDurationCredit,
        raidPower,
        updatedAt,
        run.id,
      );

      db.prepare(`
        UPDATE run_events SET awarded_delta = ? WHERE event_key = ?
      `).run(awardedDelta, event.idempotency_key);
      if (awardedDelta > 0) {
        applyActivityCredit(db, device.playerId, awardedDelta, 0, now, {
          updateLastTokenAt: recordedPresence,
        });
      }
      result.accepted++;
    }
    return result;
  });
  return ingest();
}

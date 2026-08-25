import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { applyActivityCredit } from '../src/domain/ingest';
import { purchaseConsumable } from '../src/domain/inventory';
import { activatePotion } from '../src/domain/potions';
import type { AuthenticatedDevice } from '../src/domain/raider-enrollment';
import type {
  RaidPowerPolicyV1,
  RaidPowerPolicyV2,
} from '../src/domain/raid-power-policy';
import { InvalidNestedUsageError } from '../src/domain/raid-power-policy';
import { createRaidPowerPolicySchedule } from '../src/domain/raid-power-policy-schedule';
import type { RunEventV1, UsageCountersV1 } from '../src/domain/run-events';
import { ingestRunEvents } from '../src/domain/run-ingest';
import { createPlayer, getPlayerById, updatePlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';

const NOW = 1_800_000_000_000;
const CUTOVER = NOW - 60_000;
const V2_CUTOVER = NOW;
const ZERO_USAGE: UsageCountersV1 = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning_output: 0,
};
const POLICY: RaidPowerPolicyV1 = {
  policy_version: 1,
  enabled_providers: ['codex'],
  usage_weights: {
    input: 1,
    output: 1,
    cache_read: 0,
    cache_write: 1,
    reasoning_output: 1,
  },
  provider_multipliers: { codex: 1 },
  completion_credit: 10,
  duration: { scale: 2, cap: 50 },
};
const POLICY_V2: RaidPowerPolicyV2 = {
  policy_version: 2,
  enabled_providers: ['codex'],
  usage_model: 'codex-nested-counters',
  provider_multipliers: { codex: 1 },
  completion_credit: 10,
  duration: { scale: 2, cap: 50 },
};
const SCHEDULE = createRaidPowerPolicySchedule(
  POLICY,
  POLICY_V2,
  CUTOVER,
  V2_CUTOVER,
);

let db: ReturnType<typeof openDb>;
let player: ReturnType<typeof createPlayer>;
let device: AuthenticatedDevice;
let eventIdentity = 0;

function hexKey(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function event(overrides: Omit<Partial<RunEventV1>, 'usage'> & {
  usage?: Partial<UsageCountersV1>;
} = {}): RunEventV1 {
  eventIdentity++;
  const startedAt = overrides.started_at_ms ?? CUTOVER + 1_000;
  const eventTime = overrides.event_time_ms ?? startedAt + 60_000;
  return {
    schema_version: 1,
    companion_version: device.companionVersion,
    device_id: device.deviceId,
    provider: 'codex',
    surface: 'codex_desktop',
    run_key: 'a'.repeat(64),
    sequence: 1,
    event_time_ms: eventTime,
    observed_at_ms: Math.max(eventTime, overrides.observed_at_ms ?? eventTime),
    started_at_ms: startedAt,
    state: 'open',
    model: 'gpt-test',
    effort: 'high',
    idempotency_key: hexKey(eventIdentity),
    ...overrides,
    usage: { ...ZERO_USAGE, input: 100, ...overrides.usage },
  };
}

function runRow(runKey = 'a'.repeat(64)) {
  return db.prepare('SELECT * FROM runs WHERE player_id = ? AND run_key = ?')
    .get(player.id, runKey) as Record<string, number | string | null> | undefined;
}

function eventRows() {
  return db.prepare(`
    SELECT event_key, sequence, state, awarded_delta
    FROM run_events ORDER BY received_at, event_key
  `).all() as Array<{
    event_key: string;
    sequence: number;
    state: string;
    awarded_delta: number;
  }>;
}

function tokenRows() {
  return db.prepare(`
    SELECT id, effective_delta, total_delta, ts
    FROM token_events WHERE player_id = ? ORDER BY id
  `).all(player.id) as Array<{
    id: number;
    effective_delta: number;
    total_delta: number;
    ts: number;
  }>;
}

function enrollPlayer(): void {
  db.prepare(`
    INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
    VALUES (?, ?, ?)
  `).run(player.id, 'd'.repeat(64), NOW - 100_000);
  db.prepare(`
    INSERT INTO raider_devices
      (device_id, player_id, token_hash, companion_version, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(device.deviceId, player.id, 'e'.repeat(64), device.companionVersion, NOW - 90_000);
}

function activateGoldPotion(at: number): void {
  seedSettings(db);
  applyGoldMutation(db, {
    playerId: player.id,
    amount: 100_000,
    reason: 'opening_balance',
    sourceTable: 'test_players',
    sourceId: `${player.id}`,
    now: at - 10_000,
  });
  expect(purchaseConsumable(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    quantity: 1,
    expectedUnitPrice: 100_000,
    requestId: `buy-${player.id}`,
    now: at - 2_000,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true });

  const dungeon = db.prepare(`
    INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
    VALUES (1, 'Ossuary Pale', 1, 2, ?)
  `).run(at);
  const encounter = db.prepare(`
    INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at)
    VALUES (?, 0, 'single', 1, 1, 1, 100, 100, 'active', ?)
  `).run(Number(dungeon.lastInsertRowid), at);
  db.prepare(`
    UPDATE game_state
    SET current_dungeon_id = ?, current_encounter_id = ?, defeat_until = NULL
    WHERE id = 1
  `).run(Number(dungeon.lastInsertRowid), Number(encounter.lastInsertRowid));
  expect(activatePotion(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    requestId: `drink-${player.id}`,
    now: at,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true, potionType: 'gold' });
}

beforeEach(() => {
  db = openDb(':memory:');
  player = createPlayer(db, { name: 'Run Raider', class_key: 'knight', gender: 'M' }, 1);
  device = {
    deviceId: randomUUID(),
    playerId: player.id,
    companionVersion: '0.1.0',
  };
  eventIdentity = 0;
  enrollPlayer();
});

afterEach(() => db.close());

describe('applyActivityCredit compatibility projection', () => {
  it('preserves legacy total/effective activity and potion attribution semantics', () => {
    activateGoldPotion(NOW - 1_000);

    const tokenEventId = applyActivityCredit(db, player.id, 1_000, 1_200, NOW);

    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 1_000,
      total_tokens: 1_200,
      last_token_at: NOW,
      gold: 50,
    });
    expect(tokenRows()).toEqual([{
      id: tokenEventId,
      effective_delta: 1_000,
      total_delta: 1_200,
      ts: NOW,
    }]);
    expect(db.prepare(`
      SELECT token_event_id, effective_delta FROM potion_work_events
    `).all()).toEqual([{ token_event_id: tokenEventId, effective_delta: 1_000 }]);
  });
});

describe('ingestRunEvents', () => {
  it('keeps v1 additive scoring before the v2 boundary and applies nested scoring at it', () => {
    const usage = {
      input: 74_226,
      output: 486,
      cache_read: 71_424,
      reasoning_output: 284,
    };
    const v1 = event({
      run_key: '1'.repeat(64),
      started_at_ms: V2_CUTOVER - 1,
      event_time_ms: V2_CUTOVER + 1_000,
      observed_at_ms: V2_CUTOVER + 1_000,
      usage,
    });
    const v2 = event({
      run_key: '2'.repeat(64),
      started_at_ms: V2_CUTOVER,
      event_time_ms: V2_CUTOVER + 1_000,
      observed_at_ms: V2_CUTOVER + 1_000,
      usage,
    });

    expect(ingestRunEvents(db, device, [v1, v2], SCHEDULE, NOW))
      .toEqual({ accepted: 2, duplicate: 0, ignored: 0 });
    expect(db.prepare(`
      SELECT run_key, policy_version, awarded_usage_credit, usage_input,
             usage_cache_read, usage_output, usage_reasoning_output
      FROM runs WHERE player_id = ? ORDER BY run_key
    `).all(player.id)).toEqual([
      {
        run_key: v1.run_key,
        policy_version: 'raid-power-v1',
        awarded_usage_credit: 74_996,
        usage_input: 74_226,
        usage_cache_read: 71_424,
        usage_output: 486,
        usage_reasoning_output: 284,
      },
      {
        run_key: v2.run_key,
        policy_version: 'raid-power-v2',
        awarded_usage_credit: 3_288,
        usage_input: 74_226,
        usage_cache_read: 71_424,
        usage_output: 486,
        usage_reasoning_output: 284,
      },
    ]);
  });

  it('keeps a pre-v2 Run on v1 for late events and awards exact retries nothing', () => {
    const first = event({
      started_at_ms: V2_CUTOVER - 1,
      event_time_ms: V2_CUTOVER - 1,
      observed_at_ms: V2_CUTOVER - 1,
      usage: { input: 100, output: 20, cache_read: 90, reasoning_output: 10 },
    });
    const late = event({
      sequence: 2,
      started_at_ms: first.started_at_ms,
      event_time_ms: V2_CUTOVER + 60_000,
      observed_at_ms: V2_CUTOVER + 60_000,
      usage: { input: 200, output: 30, cache_read: 199, reasoning_output: 15 },
    });

    expect(ingestRunEvents(db, device, [first], SCHEDULE, NOW))
      .toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(ingestRunEvents(db, device, [late], SCHEDULE, NOW + 1))
      .toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(ingestRunEvents(db, device, [late], SCHEDULE, NOW + 2))
      .toEqual({ accepted: 0, duplicate: 1, ignored: 0 });
    expect(runRow()).toMatchObject({
      policy_version: 'raid-power-v1',
      awarded_usage_credit: 245,
      raid_power: 245,
    });
    expect(tokenRows().map((row) => row.effective_delta)).toEqual([130, 115]);
  });

  it('rolls back a forged Run identity whose claimed start crosses the v2 cutoff', () => {
    const v1 = event({
      sequence: 1,
      started_at_ms: V2_CUTOVER - 1,
      event_time_ms: V2_CUTOVER - 1,
      observed_at_ms: V2_CUTOVER - 1,
      usage: { input: 100 },
    });
    const forgedV2 = event({
      sequence: 2,
      started_at_ms: V2_CUTOVER,
      event_time_ms: V2_CUTOVER + 1,
      observed_at_ms: V2_CUTOVER + 1,
      usage: { input: 200 },
    });

    expect(() => ingestRunEvents(db, device, [v1, forgedV2], SCHEDULE, NOW))
      .toThrow('Run policy raid-power-v1 cannot be rescored with raid-power-v2');
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_events').get()).toEqual({ count: 0 });
    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 0,
      total_tokens: 0,
      last_token_at: null,
    });
  });

  it('rolls back the whole batch when one v2 event has invalid nested usage', () => {
    const valid = event({
      run_key: '3'.repeat(64),
      started_at_ms: V2_CUTOVER,
      event_time_ms: V2_CUTOVER + 1,
      observed_at_ms: V2_CUTOVER + 1,
      usage: { input: 100, output: 20, cache_read: 80, reasoning_output: 10 },
    });
    const malformed = event({
      run_key: '4'.repeat(64),
      started_at_ms: V2_CUTOVER,
      event_time_ms: V2_CUTOVER + 2,
      observed_at_ms: V2_CUTOVER + 2,
      usage: { input: 100, cache_read: 101 },
    });

    expect(() => ingestRunEvents(db, device, [valid, malformed], SCHEDULE, NOW))
      .toThrow(InvalidNestedUsageError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_events').get()).toEqual({ count: 0 });
    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 0,
      total_tokens: 0,
      last_token_at: null,
    });
  });

  it('awards only positive cumulative usage differences through compatibility activity', () => {
    activateGoldPotion(NOW - 1_000);
    const first = event({ usage: { input: 100, cache_read: 9_000 } });
    const second = event({
      sequence: 2,
      event_time_ms: first.event_time_ms + 1,
      observed_at_ms: first.observed_at_ms + 1,
      usage: { input: 130, output: 20, cache_read: 10_000, cache_write: 5 },
    });

    expect(ingestRunEvents(db, device, [first, second], SCHEDULE, NOW))
      .toEqual({ accepted: 2, duplicate: 0, ignored: 0 });

    expect(runRow()).toMatchObject({
      usage_input: 130,
      usage_output: 20,
      usage_cache_read: 10_000,
      usage_cache_write: 5,
      awarded_usage_credit: 155,
      awarded_completion_credit: 0,
      awarded_duration_credit: 0,
      raid_power: 155,
    });
    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 155,
      total_tokens: 0,
      last_token_at: NOW,
    });
    expect(tokenRows().map(({ effective_delta, total_delta }) => ({
      effective_delta,
      total_delta,
    }))).toEqual([
      { effective_delta: 100, total_delta: 0 },
      { effective_delta: 55, total_delta: 0 },
    ]);
    expect(db.prepare(`
      SELECT token_event_id, effective_delta
      FROM potion_work_events ORDER BY token_event_id
    `).all()).toEqual(tokenRows().map((row) => ({
      token_event_id: row.id,
      effective_delta: row.effective_delta,
    })));
  });

  it('claims exact retries idempotently and retains lower reordered sequences at zero award', () => {
    const higher = event({ sequence: 2, usage: { input: 200 } });
    const lower = event({
      sequence: 1,
      event_time_ms: higher.event_time_ms - 1,
      observed_at_ms: higher.observed_at_ms,
      usage: { input: 50 },
    });

    expect(ingestRunEvents(db, device, [higher], SCHEDULE, NOW))
      .toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(ingestRunEvents(db, device, [higher], SCHEDULE, NOW + 1))
      .toEqual({ accepted: 0, duplicate: 1, ignored: 0 });
    expect(ingestRunEvents(db, device, [lower], SCHEDULE, NOW + 2))
      .toEqual({ accepted: 1, duplicate: 0, ignored: 0 });

    expect(eventRows().map(({ sequence, awarded_delta }) => ({ sequence, awarded_delta })))
      .toEqual([{ sequence: 2, awarded_delta: 200 }, { sequence: 1, awarded_delta: 0 }]);
    expect(runRow()).toMatchObject({ usage_input: 200, raid_power: 200 });
    expect(tokenRows()).toHaveLength(1);
  });

  it('never rolls cumulative counters back on a later sequence', () => {
    const events = [
      event({ sequence: 1, usage: { input: 200, output: 10 } }),
      event({ sequence: 2, usage: { input: 50, output: 5 } }),
      event({ sequence: 3, usage: { input: 250, output: 5 } }),
    ];

    expect(ingestRunEvents(db, device, events, SCHEDULE, NOW))
      .toEqual({ accepted: 3, duplicate: 0, ignored: 0 });
    expect(runRow()).toMatchObject({
      usage_input: 250,
      usage_output: 10,
      awarded_usage_credit: 260,
      raid_power: 260,
    });
    expect(eventRows().map((row) => row.awarded_delta)).toEqual([210, 0, 50]);
  });

  it('gives an open Run, including one old enough to be displayed as stalled, usage only', () => {
    const open = event({
      event_time_ms: CUTOVER + 2_000,
      observed_at_ms: CUTOVER + 2_000,
      usage: { input: 25 },
    });

    ingestRunEvents(db, device, [open], SCHEDULE, NOW);

    expect(runRow()).toMatchObject({
      state: 'open',
      terminal_at_ms: null,
      awarded_usage_credit: 25,
      awarded_completion_credit: 0,
      awarded_duration_credit: 0,
      raid_power: 25,
    });
  });

  it('awards completion exactly once after meaningful usage and duration only on completion', () => {
    const startedAt = CUTOVER + 1_000;
    const open = event({
      sequence: 1,
      started_at_ms: startedAt,
      event_time_ms: startedAt + 60_000,
      usage: { input: 100 },
    });
    const completed = event({
      sequence: 2,
      started_at_ms: startedAt,
      event_time_ms: startedAt + 4 * 60_000,
      observed_at_ms: startedAt + 4 * 60_000,
      state: 'completed',
      usage: { input: 100 },
    });
    const conflicting = event({
      sequence: 3,
      started_at_ms: startedAt,
      event_time_ms: startedAt + 5 * 60_000,
      observed_at_ms: startedAt + 5 * 60_000,
      state: 'failed',
      usage: { input: 100 },
    });

    ingestRunEvents(db, device, [open], SCHEDULE, NOW);
    ingestRunEvents(db, device, [completed], SCHEDULE, NOW + 1);
    ingestRunEvents(db, device, [completed], SCHEDULE, NOW + 2);
    ingestRunEvents(db, device, [conflicting], SCHEDULE, NOW + 3);

    expect(runRow()).toMatchObject({
      state: 'completed',
      terminal_at_ms: completed.event_time_ms,
      awarded_usage_credit: 100,
      awarded_completion_credit: 10,
      awarded_duration_credit: 4,
      raid_power: 114,
    });
    expect(tokenRows().map((row) => row.effective_delta)).toEqual([100, 14]);
    expect(eventRows().map((row) => row.awarded_delta)).toEqual([100, 14, 0]);
  });

  it('does not award completion or duration for a completed Run without positive normalized usage', () => {
    activateGoldPotion(NOW - 1_000);
    const startedAt = CUTOVER + 1;
    const completed = event({
      state: 'completed',
      started_at_ms: startedAt,
      event_time_ms: startedAt + 7 * 24 * 60 * 60_000,
      observed_at_ms: startedAt + 7 * 24 * 60 * 60_000,
      usage: { input: 0, cache_read: 10_000 },
    });

    ingestRunEvents(db, device, [completed], SCHEDULE, NOW);

    expect(runRow()).toMatchObject({
      state: 'completed',
      awarded_usage_credit: 0,
      awarded_completion_credit: 0,
      awarded_duration_credit: 0,
      raid_power: 0,
    });
    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 0,
      total_tokens: 0,
      last_token_at: null,
    });
    expect(tokenRows()).toEqual([]);
    expect(db.prepare('SELECT * FROM potion_work_events').all()).toEqual([]);
  });

  it.each(['failed', 'cancelled'] as const)(
    'makes the first %s terminal state immutable and usage-only',
    (terminalState) => {
      const terminal = event({ state: terminalState, usage: { input: 40 } });
      const lateCompletion = event({
        sequence: 2,
        state: 'completed',
        event_time_ms: terminal.event_time_ms + 1,
        observed_at_ms: terminal.observed_at_ms + 1,
        usage: { input: 50 },
      });

      ingestRunEvents(db, device, [terminal, lateCompletion], SCHEDULE, NOW);

      expect(runRow()).toMatchObject({
        state: terminalState,
        terminal_at_ms: terminal.event_time_ms,
        awarded_usage_credit: 50,
        awarded_completion_credit: 0,
        awarded_duration_credit: 0,
        raid_power: 50,
      });
      expect(eventRows().map((row) => row.awarded_delta)).toEqual([40, 10]);
    },
  );

  it('caps duration credit for a seven-day completed Run', () => {
    const startedAt = CUTOVER + 1;
    const completed = event({
      state: 'completed',
      started_at_ms: startedAt,
      event_time_ms: startedAt + 7 * 24 * 60 * 60_000,
      observed_at_ms: startedAt + 7 * 24 * 60 * 60_000,
      usage: { input: 1 },
    });

    ingestRunEvents(db, device, [completed], SCHEDULE, NOW);

    expect(runRow()).toMatchObject({
      awarded_usage_credit: 1,
      awarded_completion_credit: 10,
      awarded_duration_credit: 50,
      raid_power: 61,
    });
  });

  it('scores parallel stable Run keys independently and additively', () => {
    const runA = event({ run_key: 'a'.repeat(64), usage: { input: 20 } });
    const runB = event({ run_key: 'b'.repeat(64), usage: { input: 30 } });

    ingestRunEvents(db, device, [runA, runB], SCHEDULE, NOW);

    expect(db.prepare(`
      SELECT run_key, raid_power FROM runs WHERE player_id = ? ORDER BY run_key
    `).all(player.id)).toEqual([
      { run_key: 'a'.repeat(64), raid_power: 20 },
      { run_key: 'b'.repeat(64), raid_power: 30 },
    ]);
    expect(getPlayerById(db, player.id)?.effective_tokens).toBe(50);
  });

  it('treats a second surface for the same provider Run sequence as duplicate observation', () => {
    const desktop = event({ surface: 'codex_desktop', usage: { input: 20 } });
    const cli = event({
      surface: 'codex_cli',
      idempotency_key: 'f'.repeat(64),
      usage: { input: 500 },
    });

    expect(ingestRunEvents(db, device, [desktop, cli], SCHEDULE, NOW))
      .toEqual({ accepted: 1, duplicate: 1, ignored: 0 });
    expect(runRow()).toMatchObject({ surface: 'codex_desktop', raid_power: 20 });
    expect(eventRows()).toHaveLength(1);
  });

  it('rolls the whole batch back when the player projection would overflow', () => {
    updatePlayer(db, player.id, { effective_tokens: Number.MAX_SAFE_INTEGER - 10 });
    const runA = event({ run_key: 'a'.repeat(64), usage: { input: 6 } });
    const runB = event({ run_key: 'b'.repeat(64), usage: { input: 6 } });

    expect(() => ingestRunEvents(db, device, [runA, runB], SCHEDULE, NOW))
      .toThrow(RangeError);

    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: Number.MAX_SAFE_INTEGER - 10,
      total_tokens: 0,
      last_token_at: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_events').get()).toEqual({ count: 0 });
  });

  it('rolls back before persistence when combined Run credit is not a safe integer', () => {
    const unsafePolicy: RaidPowerPolicyV1 = {
      ...POLICY,
      completion_credit: Number.MAX_SAFE_INTEGER,
      duration: { scale: 1, cap: 0 },
    };
    const completed = event({ state: 'completed', usage: { input: 1 } });

    expect(() => ingestRunEvents(
      db,
      device,
      [completed],
      createRaidPowerPolicySchedule(unsafePolicy, POLICY_V2, CUTOVER, V2_CUTOVER),
      NOW,
    )).toThrow(RangeError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_events').get()).toEqual({ count: 0 });
  });

  it('retains disabled Raider events as a non-scoring baseline without later backfill', () => {
    updatePlayer(db, player.id, { disabled: 1 });
    const disabledUsage = event({ sequence: 1, usage: { input: 100 } });

    expect(ingestRunEvents(db, device, [disabledUsage], SCHEDULE, NOW))
      .toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(runRow()).toMatchObject({
      usage_input: 100,
      awarded_usage_credit: 100,
      raid_power: 0,
    });
    expect(tokenRows()).toEqual([]);

    updatePlayer(db, player.id, { disabled: 0 });
    const enabledUsage = event({
      sequence: 2,
      event_time_ms: disabledUsage.event_time_ms + 1,
      observed_at_ms: disabledUsage.observed_at_ms + 1,
      usage: { input: 110 },
    });
    ingestRunEvents(db, device, [enabledUsage], SCHEDULE, NOW + 1);

    expect(runRow()).toMatchObject({ awarded_usage_credit: 110, raid_power: 10 });
    expect(tokenRows().map((row) => row.effective_delta)).toEqual([10]);
  });

  it('permanently suppresses completion observed while disabled before later usage', () => {
    updatePlayer(db, player.id, { disabled: 1 });
    const startedAt = CUTOVER + 1;
    const disabledCompletion = event({
      sequence: 1,
      state: 'completed',
      started_at_ms: startedAt,
      event_time_ms: startedAt + 7 * 24 * 60 * 60_000,
      observed_at_ms: startedAt + 7 * 24 * 60 * 60_000,
      usage: { input: 0, cache_read: 10_000 },
    });

    ingestRunEvents(db, device, [disabledCompletion], SCHEDULE, NOW);

    expect(runRow()).toMatchObject({
      state: 'completed',
      awarded_usage_credit: 0,
      awarded_completion_credit: 10,
      awarded_duration_credit: 50,
      raid_power: 0,
    });
    expect(tokenRows()).toEqual([]);

    updatePlayer(db, player.id, { disabled: 0 });
    const laterUsage = event({
      sequence: 2,
      event_time_ms: disabledCompletion.event_time_ms + 1,
      observed_at_ms: disabledCompletion.observed_at_ms + 1,
      usage: { input: 10, cache_read: 10_000 },
    });
    ingestRunEvents(db, device, [laterUsage], SCHEDULE, NOW + 1);

    expect(runRow()).toMatchObject({
      awarded_usage_credit: 10,
      awarded_completion_credit: 10,
      awarded_duration_credit: 50,
      raid_power: 10,
    });
    expect(eventRows().map((row) => row.awarded_delta)).toEqual([0, 10]);
    expect(tokenRows().map((row) => ({
      effective_delta: row.effective_delta,
      total_delta: row.total_delta,
    }))).toEqual([{ effective_delta: 10, total_delta: 0 }]);
  });

  it('ignores a Run whose recorded start precedes the explicit cutover', () => {
    const preCutover = event({
      started_at_ms: CUTOVER - 1,
      event_time_ms: CUTOVER + 1,
      observed_at_ms: CUTOVER + 1,
      usage: { input: 500 },
    });

    expect(ingestRunEvents(db, device, [preCutover], SCHEDULE, NOW))
      .toEqual({ accepted: 0, duplicate: 0, ignored: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_events').get()).toEqual({ count: 0 });
    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 0,
      total_tokens: 0,
      last_token_at: null,
    });
  });
});

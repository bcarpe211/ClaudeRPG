import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import type {
  RunProvider,
  RunSurface,
  UsageCountersV1,
} from '../src/domain/run-events';
import {
  activeRunCount,
  collectorStatus,
  recentRuns,
} from '../src/domain/runs';
import { createPlayer } from '../src/domain/players';

const NOW = 1_800_000_000_000;
const STALE_AFTER_MS = 15 * 60_000;
const ZERO_USAGE: UsageCountersV1 = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning_output: 0,
};

type RunState = 'open' | 'completed' | 'failed' | 'cancelled';

interface RunSeed {
  playerId?: number;
  provider?: RunProvider;
  surface?: RunSurface;
  state?: RunState;
  startedAt?: number;
  terminalAt?: number | null;
  lastEventAt?: number;
  lastObservedAt?: number;
  usage?: Partial<UsageCountersV1>;
  model?: string | null;
  effort?: string | null;
  policyVersion?: string;
  raidPower?: number;
  createdAt?: number;
  updatedAt?: number;
}

let db: Database.Database;
let playerId: number;
let otherPlayerId: number;
let identity = 0;

function hexKey(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function enroll(id: number): void {
  identity++;
  db.prepare(`
    INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
    VALUES (?, ?, ?)
  `).run(id, hexKey(identity), NOW - 10_000);
}

function seedRun(seed: RunSeed = {}): number {
  identity++;
  const state = seed.state ?? 'open';
  const lastObservedAt = seed.lastObservedAt ?? seed.lastEventAt ?? NOW - 1_000;
  const lastEventAt = seed.lastEventAt ?? lastObservedAt;
  const startedAt = seed.startedAt ?? Math.max(0, lastEventAt - 1_000);
  const terminalAt = seed.terminalAt
    ?? (state === 'open' ? null : lastEventAt);
  const createdAt = seed.createdAt ?? startedAt;
  const updatedAt = seed.updatedAt ?? lastObservedAt;
  const usage = { ...ZERO_USAGE, ...seed.usage };

  return Number(db.prepare(`
    INSERT INTO runs
      (player_id, provider, surface, run_key, state, started_at_ms,
       terminal_at_ms, last_event_at_ms, last_observed_at_ms, usage_input,
       usage_output, usage_cache_read, usage_cache_write,
       usage_reasoning_output, latest_model, latest_effort, policy_version,
       raid_power, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    seed.playerId ?? playerId,
    seed.provider ?? 'codex',
    seed.surface ?? 'codex_desktop',
    hexKey(identity),
    state,
    startedAt,
    terminalAt,
    lastEventAt,
    lastObservedAt,
    usage.input,
    usage.output,
    usage.cache_read,
    usage.cache_write,
    usage.reasoning_output,
    seed.model ?? null,
    seed.effort ?? null,
    seed.policyVersion ?? 'raid-power-v1',
    seed.raidPower ?? 0,
    createdAt,
    updatedAt,
  ).lastInsertRowid);
}

function seedDevice(
  ownerId: number,
  lastSeenAt: number | null,
  revokedAt: number | null = null,
): void {
  identity++;
  db.prepare(`
    INSERT INTO raider_devices
      (device_id, player_id, token_hash, companion_version, created_at,
       last_seen_at, revoked_at)
    VALUES (?, ?, ?, '0.1.0', ?, ?, ?)
  `).run(
    randomUUID(),
    ownerId,
    hexKey(identity),
    NOW - 10_000,
    lastSeenAt,
    revokedAt,
  );
}

beforeEach(() => {
  db = openDb(':memory:');
  playerId = createPlayer(
    db,
    { name: 'Query Raider', class_key: 'knight', gender: 'M' },
    NOW - 20_000,
  ).id;
  otherPlayerId = createPlayer(
    db,
    { name: 'Other Raider', class_key: 'wizard', gender: 'F' },
    NOW - 20_000,
  ).id;
  identity = 0;
  enroll(playerId);
  enroll(otherPlayerId);
});

afterEach(() => db.close());

describe('recentRuns', () => {
  it('returns an empty list when the Raider has no Runs', () => {
    expect(recentRuns(db, playerId, 20)).toEqual([]);
  });

  it('returns literal display and scoring facts without opaque identities', () => {
    seedRun({
      provider: 'codex',
      surface: 'codex_cli',
      state: 'completed',
      startedAt: NOW - 2_000,
      terminalAt: NOW - 500,
      lastEventAt: NOW - 500,
      lastObservedAt: NOW - 400,
      usage: {
        input: 11,
        output: 22,
        cache_read: 33,
        cache_write: 44,
        reasoning_output: 55,
      },
      model: 'gpt-display',
      effort: 'xhigh',
      policyVersion: 'raid-power-v1',
      raidPower: 321,
      createdAt: NOW - 2_000,
      updatedAt: NOW - 300,
    });

    expect(recentRuns(db, playerId, 1)).toEqual([{
      provider: 'codex',
      surface: 'codex_cli',
      state: 'completed',
      startedAt: NOW - 2_000,
      terminalAt: NOW - 500,
      lastEventAt: NOW - 500,
      lastObservedAt: NOW - 400,
      usage: {
        input: 11,
        output: 22,
        cache_read: 33,
        cache_write: 44,
        reasoning_output: 55,
      },
      model: 'gpt-display',
      effort: 'xhigh',
      policyVersion: 'raid-power-v1',
      raidPower: 321,
      updatedAt: NOW - 300,
    }]);
  });

  it('orders newest first and breaks updated-time ties by newest stored Run', () => {
    seedRun({ model: 'oldest', updatedAt: NOW - 3 });
    seedRun({ model: 'tie-first', updatedAt: NOW - 2 });
    seedRun({ model: 'tie-second', updatedAt: NOW - 2 });
    seedRun({ model: 'newest', updatedAt: NOW - 1 });

    expect(recentRuns(db, playerId, 20).map((run) => run.model)).toEqual([
      'newest',
      'tie-second',
      'tie-first',
      'oldest',
    ]);
  });

  it('caps results at 20, honors smaller limits, and isolates Raiders', () => {
    for (let index = 0; index < 25; index++) {
      seedRun({ model: `own-${index}`, updatedAt: NOW + index });
    }
    seedRun({
      playerId: otherPlayerId,
      model: 'other-newest',
      updatedAt: NOW + 1_000,
    });

    const capped = recentRuns(db, playerId, 100);
    expect(capped).toHaveLength(20);
    expect(capped.map((run) => run.model)).toEqual(
      Array.from({ length: 20 }, (_, index) => `own-${24 - index}`),
    );
    expect(recentRuns(db, playerId, 3).map((run) => run.model)).toEqual([
      'own-24',
      'own-23',
      'own-22',
    ]);
  });
});

describe('activeRunCount', () => {
  it('counts parallel open Runs through the freshness boundary without changing lifecycle state', () => {
    seedRun({ model: 'fresh', lastObservedAt: NOW - 1 });
    seedRun({ model: 'boundary', lastObservedAt: NOW - STALE_AFTER_MS });
    seedRun({ model: 'stalled', lastObservedAt: NOW - STALE_AFTER_MS - 1 });
    seedRun({ state: 'completed', model: 'completed', lastObservedAt: NOW - 1 });
    seedRun({ state: 'failed', model: 'failed', lastObservedAt: NOW - 1 });
    seedRun({ state: 'cancelled', model: 'cancelled', lastObservedAt: NOW - 1 });
    seedRun({ playerId: otherPlayerId, model: 'other', lastObservedAt: NOW });
    const before = db.prepare(`
      SELECT id, state, terminal_at_ms FROM runs ORDER BY id
    `).all();

    expect(activeRunCount(db, playerId, NOW, STALE_AFTER_MS)).toBe(2);
    expect(db.prepare(`
      SELECT id, state, terminal_at_ms FROM runs ORDER BY id
    `).all()).toEqual(before);
  });

  it('allows a zero freshness window and isolates a missing Raider', () => {
    seedRun({ lastObservedAt: NOW });
    seedRun({ lastObservedAt: NOW - 1 });

    expect(activeRunCount(db, playerId, NOW, 0)).toBe(1);
    expect(activeRunCount(db, otherPlayerId + 1_000, NOW, STALE_AFTER_MS)).toBe(0);
  });
});

describe('collectorStatus', () => {
  it('returns an empty status when the Raider has no devices', () => {
    expect(collectorStatus(db, playerId)).toEqual({
      lastSeenAt: null,
      devices: 0,
    });
  });

  it('counts only non-revoked devices and uses only their latest contact', () => {
    seedDevice(playerId, null);
    seedDevice(playerId, NOW - 20);
    seedDevice(playerId, NOW - 10);
    seedDevice(playerId, NOW + 100, NOW + 101);
    seedDevice(otherPlayerId, NOW + 200);

    expect(collectorStatus(db, playerId)).toEqual({
      lastSeenAt: NOW - 10,
      devices: 3,
    });
  });
});

describe('Run query argument validation', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
    'rejects invalid playerId %s consistently',
    (invalidPlayerId) => {
      expect(() => recentRuns(db, invalidPlayerId, 1)).toThrow(RangeError);
      expect(() => activeRunCount(db, invalidPlayerId, NOW, STALE_AFTER_MS))
        .toThrow(RangeError);
      expect(() => collectorStatus(db, invalidPlayerId)).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
    'rejects invalid recent limit %s',
    (invalidLimit) => {
      expect(() => recentRuns(db, playerId, invalidLimit)).toThrow(RangeError);
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
    'rejects invalid query timestamp %s',
    (invalidTimestamp) => {
      expect(() => activeRunCount(db, playerId, invalidTimestamp, STALE_AFTER_MS))
        .toThrow(RangeError);
      expect(() => activeRunCount(db, playerId, NOW, invalidTimestamp))
        .toThrow(RangeError);
    },
  );
});

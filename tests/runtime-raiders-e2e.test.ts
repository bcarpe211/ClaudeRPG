import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { GameEngine } from '../src/domain/engine';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { activatePotion } from '../src/domain/potions';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { recentRuns } from '../src/domain/runs';
import type { RunEventV1, UsageCountersV1 } from '../src/domain/run-events';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';
import { buildCompanionInstallCommand } from '../src/web/companion-install';
import { buildTvState } from '../src/web/tvview';

const NOW = 1_800_000_000_000;
const CUTOVER = NOW - 60_000;
const POLICY_PATH = resolve('config/raid-power-policy-v1.json');
const POLICY_V2_PATH = resolve('config/raid-power-policy-v2.json');
const ZERO_USAGE: UsageCountersV1 = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning_output: 0,
};

let db: ReturnType<typeof openDb>;
let player: ReturnType<typeof createPlayer>;
let app: ReturnType<typeof createApp>;
let databaseDirectory: string;
let eventIdentity = 0;

function runtimeConfig() {
  return loadConfig({
    PUBLIC_URL: 'http://127.0.0.1:1',
    SCORING_MODE: 'runtime-raiders',
    RUN_SCORING_CUTOVER_AT: String(CUTOVER),
    RAID_POWER_POLICY_PATH: POLICY_PATH,
    RAID_POWER_POLICY_V2_PATH: POLICY_V2_PATH,
    RAID_POWER_V2_CUTOVER_AT: String(NOW),
    RUN_ENABLED_SURFACES: 'codex_desktop,codex_cli',
  });
}

function hexKey(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function runEvent(
  deviceId: string,
  overrides: Omit<Partial<RunEventV1>, 'usage'> & {
    usage?: Partial<UsageCountersV1>;
  } = {},
): RunEventV1 {
  eventIdentity += 1;
  const startedAt = overrides.started_at_ms ?? CUTOVER + 1_000;
  const eventTime = overrides.event_time_ms ?? startedAt + 1_000;
  return {
    schema_version: 1,
    companion_version: '0.1.0-synthetic',
    device_id: deviceId,
    provider: 'codex',
    surface: 'codex_desktop',
    run_key: hexKey(eventIdentity + 10_000),
    sequence: 1,
    event_time_ms: eventTime,
    observed_at_ms: eventTime,
    started_at_ms: startedAt,
    state: 'open',
    model: 'synthetic-model',
    effort: 'synthetic-effort',
    idempotency_key: hexKey(eventIdentity),
    ...overrides,
    usage: { ...ZERO_USAGE, input: 100, ...overrides.usage },
  };
}

function post(path: string, body: object, token?: string) {
  const outgoing = request(app)
    .post(path)
    .set('content-type', 'application/json')
    .send(body);
  return token === undefined ? outgoing : outgoing.set('authorization', `Bearer ${token}`);
}

async function enrollDevice(): Promise<{ deviceId: string; deviceToken: string }> {
  const issued = await post('/api/raiders/enrollments', { raider_key: player.auth_token });
  expect(issued.status).toBe(201);
  const issuedBody = issued.body as { install_command: string; enrollment_code: string };
  const code = issuedBody.enrollment_code;
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(issuedBody.install_command).toBe(
    'curl -fsSL https://raiders.redlattice.com/install.sh | sh',
  );
  expect(issuedBody.install_command).not.toContain(code);

  const deviceId = randomUUID();
  const enrolled = await post('/api/raiders/enroll', {
    code,
    device_id: deviceId,
    companion_version: '0.1.0-synthetic',
  });
  expect(enrolled.status).toBe(201);
  const enrollment = enrolled.body as { device_token: string; enabled_surfaces: string[] };
  expect(enrollment.enabled_surfaces).toEqual(['codex_desktop', 'codex_cli']);
  return { deviceId, deviceToken: enrollment.device_token };
}

function armGoldPotion(): void {
  applyGoldMutation(db, {
    playerId: player.id,
    amount: 100_000,
    reason: 'opening_balance',
    sourceTable: 'runtime_raiders_e2e',
    sourceId: String(player.id),
    now: NOW - 3_000,
  });
  expect(purchaseConsumable(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    quantity: 1,
    expectedUnitPrice: 100_000,
    requestId: `runtime-raiders-e2e-buy-${player.id}`,
    now: NOW - 2_000,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true });
  expect(activatePotion(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    requestId: `runtime-raiders-e2e-drink-${player.id}`,
    now: NOW - 1_000,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true, potionType: 'gold' });
}

function count(table: 'runs' | 'run_events' | 'token_events' | 'potion_work_events'): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function presenceReceipt(): number | null {
  const row = db.prepare(`
    SELECT last_run_activity_at
    FROM raider_presence
    WHERE player_id = ?
  `).get(player.id) as { last_run_activity_at: number } | undefined;
  return row?.last_run_activity_at ?? null;
}

function scoringAndEconomySnapshot(runKey: string) {
  const currentPlayer = getPlayerById(db, player.id)!;
  return {
    player: {
      totalTokens: currentPlayer.total_tokens,
      effectiveTokens: currentPlayer.effective_tokens,
      lastTokenAt: currentPlayer.last_token_at,
      gold: currentPlayer.gold,
      level: currentPlayer.level,
    },
    runAward: db.prepare(`
      SELECT awarded_usage_credit, awarded_completion_credit,
             awarded_duration_credit, raid_power
      FROM runs
      WHERE player_id = ? AND run_key = ?
    `).get(player.id, runKey),
    tokenCount: count('token_events'),
  };
}

function scoringProgressionSnapshot() {
  return {
    runs: count('runs'),
    events: count('run_events'),
    tokens: count('token_events'),
    potionWork: count('potion_work_events'),
    player: db.prepare(`
      SELECT level, total_tokens, effective_tokens, last_token_at, gold, peak_modifier
      FROM players WHERE id = ?
    `).get(player.id),
    game: db.prepare(`
      SELECT paused, last_activity_at, combat_active_ms FROM game_state WHERE id = 1
    `).get(),
    inventory: db.prepare('SELECT COUNT(*) AS count FROM player_inventory WHERE player_id = ?')
      .get(player.id),
    potions: db.prepare('SELECT COUNT(*) AS count FROM potion_activations WHERE player_id = ?')
      .get(player.id),
  };
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  databaseDirectory = mkdtempSync(join(tmpdir(), 'runtime-raiders-e2e-'));
  db = openDb(join(databaseDirectory, 'runtime-raiders.db'));
  seedSettings(db);
  player = createPlayer(db, { name: 'Synthetic Raider', class_key: 'knight', gender: 'M' }, NOW);
  eventIdentity = 0;
  app = createApp({ db, config: runtimeConfig() });
});

afterEach(() => {
  db.close();
  rmSync(databaseDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Runtime Raiders local integration gate', () => {
  it('displays the one-line employee installer command', () => {
    expect(buildCompanionInstallCommand()).toBe(
      'curl -fsSL https://raiders.redlattice.com/install.sh | sh',
    );
  });

  it('passes the production acceptance query for a real accepted canary Run', async () => {
    const device = await enrollDevice();
    const accepted = await post(
      '/api/runs/events',
      { events: [runEvent(device.deviceId)] },
      device.deviceToken,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });

    const result = db.prepare(`
      SELECT count(*) AS invalid
      FROM runs
      WHERE started_at_ms < ? OR policy_version <> ?
    `).get(CUTOVER, 'raid-power-v1') as { invalid: number };

    expect(result.invalid).toBe(0);
  });

  it('wakes and expires dungeon presence from an accepted zero-credit Run without scoring it', async () => {
    const device = await enrollDevice();
    const opening = runEvent(device.deviceId, {
      started_at_ms: NOW,
      event_time_ms: NOW,
      observed_at_ms: NOW,
      usage: ZERO_USAGE,
    });

    expect(buildTvState(db, NOW)).toMatchObject({ paused: true, activeRaiders: 0 });
    const accepted = await post(
      '/api/runs/events',
      { events: [opening] },
      device.deviceToken,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(presenceReceipt()).toBe(NOW);

    const beforeTick = scoringAndEconomySnapshot(opening.run_key);
    expect(beforeTick).toEqual({
      player: {
        totalTokens: 0,
        effectiveTokens: 0,
        lastTokenAt: null,
        gold: 0,
        level: 1,
      },
      runAward: {
        awarded_usage_credit: 0,
        awarded_completion_credit: 0,
        awarded_duration_credit: 0,
        raid_power: 0,
      },
      tokenCount: 0,
    });

    const engine = new GameEngine(db, { rng: () => 0.5 });
    engine.tick(NOW);
    const awake = buildTvState(db, NOW);
    expect(awake).toMatchObject({ paused: false, activeRaiders: 1 });
    expect(awake.players.find((hero) => hero.id === player.id)).toMatchObject({
      modifier: 1,
      connected: false,
    });
    expect(scoringAndEconomySnapshot(opening.run_key)).toEqual(beforeTick);

    const originalReceipt = presenceReceipt();
    const duplicateAt = NOW + 15 * 60_000;
    vi.mocked(Date.now).mockReturnValue(duplicateAt);
    const duplicate = await post(
      '/api/runs/events',
      { events: [opening] },
      device.deviceToken,
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ accepted: 0, duplicate: 1, ignored: 0 });
    expect(presenceReceipt()).toBe(originalReceipt);
    expect(buildTvState(db, duplicateAt).activeRaiders).toBe(1);

    const expiredAt = NOW + 15 * 60_000 + 1;
    engine.tick(expiredAt);
    expect(buildTvState(db, expiredAt)).toMatchObject({ paused: true, activeRaiders: 0 });
    expect(scoringAndEconomySnapshot(opening.run_key)).toEqual(beforeTick);
  });

  it.each([
    {
      name: 'stale backlog',
      receivedAt: NOW + 120_001,
      observedAt: NOW,
    },
    {
      name: 'future observation',
      receivedAt: NOW,
      observedAt: NOW + 1,
    },
  ])('scores a positive $name without creating activity or waking the dungeon', async ({
    receivedAt,
    observedAt,
  }) => {
    const device = await enrollDevice();
    const priorActivity = receivedAt - 15 * 60_000 - 1;
    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?')
      .run(priorActivity, player.id);
    const excluded = runEvent(device.deviceId, {
      started_at_ms: NOW,
      event_time_ms: NOW,
      observed_at_ms: observedAt,
      usage: { input: 100 },
    });
    vi.mocked(Date.now).mockReturnValue(receivedAt);

    const accepted = await post(
      '/api/runs/events',
      { events: [excluded] },
      device.deviceToken,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(presenceReceipt()).toBeNull();
    expect(scoringAndEconomySnapshot(excluded.run_key)).toMatchObject({
      player: {
        effectiveTokens: 100,
        lastTokenAt: priorActivity,
      },
      runAward: {
        awarded_usage_credit: 100,
        raid_power: 100,
      },
      tokenCount: 1,
    });

    new GameEngine(db, { rng: () => 0.5 }).tick(receivedAt);
    expect(buildTvState(db, receivedAt)).toMatchObject({ paused: true, activeRaiders: 0 });
    expect(presenceReceipt()).toBeNull();
  });

  it('scores parallel synthetic Codex Runs once, preserves legacy projection, potion work, wake, and recent Run queries', async () => {
    db.prepare('UPDATE game_state SET paused = 1, last_activity_at = ? WHERE id = 1')
      .run(NOW - 20 * 60_000);
    const device = await enrollDevice();
    const wakingEvent = runEvent(device.deviceId, {
      run_key: hexKey(20_000),
      started_at_ms: NOW,
      event_time_ms: NOW,
      observed_at_ms: NOW,
    });
    const wake = await post('/api/runs/events', { events: [wakingEvent] }, device.deviceToken);
    expect(wake.status).toBe(200);
    expect(wake.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(NOW + 1);
    expect(db.prepare('SELECT paused FROM game_state WHERE id = 1').get()).toEqual({ paused: 0 });
    armGoldPotion();
    const desktopOpen = runEvent(device.deviceId, {
      run_key: hexKey(20_001),
      sequence: 1,
      started_at_ms: NOW,
      event_time_ms: NOW,
      observed_at_ms: NOW,
      usage: { input: 120 },
    });
    const desktopCompleted = runEvent(device.deviceId, {
      run_key: desktopOpen.run_key,
      sequence: 2,
      started_at_ms: desktopOpen.started_at_ms,
      event_time_ms: desktopOpen.event_time_ms + 1_000,
      observed_at_ms: desktopOpen.observed_at_ms + 1_000,
      state: 'completed',
      usage: { input: 200, output: 20 },
    });
    const cliCompleted = runEvent(device.deviceId, {
      surface: 'codex_cli',
      run_key: hexKey(20_002),
      sequence: 1,
      started_at_ms: NOW + 2_000,
      event_time_ms: NOW + 2_000 + 6 * 24 * 60 * 60 * 1_000,
      observed_at_ms: NOW + 2_000 + 6 * 24 * 60 * 60 * 1_000,
      state: 'completed',
      usage: { input: 300, output: 30, reasoning_output: 30 },
    });
    const desktopLong = runEvent(device.deviceId, {
      run_key: hexKey(20_003),
      started_at_ms: NOW + 3_000,
      event_time_ms: NOW + 3_000 + 6 * 24 * 60 * 60 * 1_000,
      observed_at_ms: NOW + 3_000 + 6 * 24 * 60 * 60 * 1_000,
      state: 'completed',
      usage: { input: 250 },
    });
    const cliShort = runEvent(device.deviceId, {
      surface: 'codex_cli',
      run_key: hexKey(20_004),
      started_at_ms: NOW + 4_000,
      event_time_ms: NOW + 5_000,
      observed_at_ms: NOW + 5_000,
      state: 'completed',
      usage: { input: 150 },
    });

    const accepted = await post('/api/runs/events', {
      events: [desktopOpen, desktopCompleted, cliCompleted, desktopLong, cliShort],
    }, device.deviceToken);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: 5, duplicate: 0, ignored: 0 });

    const duplicate = await post('/api/runs/events', { events: [desktopCompleted] }, device.deviceToken);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ accepted: 0, duplicate: 1, ignored: 0 });
    expect(count('runs')).toBe(5);
    expect(count('run_events')).toBe(6);
    expect(count('token_events')).toBe(6);
    expect(count('potion_work_events')).toBe(5);

    const raidPower = db.prepare('SELECT COALESCE(SUM(raid_power), 0) AS total FROM runs')
      .get() as { total: number };
    const tokenProjection = db.prepare(`
      SELECT COALESCE(SUM(effective_delta), 0) AS effective,
             COALESCE(SUM(total_delta), 0) AS total
      FROM token_events WHERE player_id = ?
    `).get(player.id) as { effective: number; total: number };
    expect(tokenProjection).toEqual({ effective: raidPower.total, total: 0 });
    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: raidPower.total,
      total_tokens: 0,
      last_token_at: NOW,
    });

    expect(recentRuns(db, player.id, 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: 'codex_desktop', state: 'completed' }),
      expect.objectContaining({ surface: 'codex_cli', state: 'completed' }),
    ]));
  });

  it('rejects reserved and mixed synthetic surfaces atomically without Run, audit, or progression mutation', async () => {
    const device = await enrollDevice();
    // authenticateDevice intentionally advances raider_devices.last_seen_at.
    const before = scoringProgressionSnapshot();
    const enabled = runEvent(device.deviceId, { run_key: hexKey(30_001) });
    const claude = runEvent(device.deviceId, {
      provider: 'claude',
      surface: 'claude_code',
      run_key: hexKey(30_002),
    });
    const omp = runEvent(device.deviceId, {
      provider: 'omp',
      surface: 'omp',
      run_key: hexKey(30_003),
    });

    for (const events of [[claude], [omp], [enabled, claude]]) {
      const rejected = await post('/api/runs/events', { events }, device.deviceToken);
      expect(rejected.status).toBe(422);
      expect(rejected.body).toEqual({ reason: 'surface_disabled' });
      expect(scoringProgressionSnapshot()).toEqual(before);
    }
  });
});

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createPlayer } from '../src/domain/players';
import type { RunEventV1, UsageCountersV1 } from '../src/domain/run-events';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

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
let app: ReturnType<typeof createApp>;
let player: ReturnType<typeof createPlayer>;
let eventIdentity = 0;

function runtimeConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    PUBLIC_URL: 'https://raiders.test',
    SCORING_MODE: 'runtime-raiders',
    RUN_SCORING_CUTOVER_AT: String(CUTOVER),
    RAID_POWER_POLICY_PATH: POLICY_PATH,
    RAID_POWER_POLICY_V2_PATH: POLICY_V2_PATH,
    RAID_POWER_V2_CUTOVER_AT: String(NOW),
    RUN_ENABLED_SURFACES: 'codex_desktop,codex_cli',
    ...overrides,
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
    companion_version: '0.1.0',
    device_id: deviceId,
    provider: 'codex',
    surface: 'codex_desktop',
    run_key: hexKey(eventIdentity + 10_000),
    sequence: 1,
    event_time_ms: eventTime,
    observed_at_ms: eventTime,
    started_at_ms: startedAt,
    state: 'open',
    model: 'gpt-test',
    effort: 'high',
    idempotency_key: hexKey(eventIdentity),
    ...overrides,
    usage: {
      input: overrides.usage?.input ?? 100,
      output: overrides.usage?.output ?? ZERO_USAGE.output,
      cache_read: overrides.usage?.cache_read ?? ZERO_USAGE.cache_read,
      cache_write: overrides.usage?.cache_write ?? ZERO_USAGE.cache_write,
      reasoning_output: overrides.usage?.reasoning_output ?? ZERO_USAGE.reasoning_output,
    },
  };
}

function countRows(table: 'runs' | 'run_events'): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

async function postChunkedGzip(
  path: string,
  compressedBody: Buffer,
): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  try {
    return await new Promise((resolveResponse, reject) => {
      const outgoing = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Transfer-Encoding': 'chunked',
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveResponse({
            status: incoming.statusCode ?? 0,
            body: text.length === 0 ? null : JSON.parse(text),
          });
        });
      });
      outgoing.on('error', reject);
      for (let offset = 0; offset < compressedBody.length; offset += 4_096) {
        outgoing.write(compressedBody.subarray(offset, offset + 4_096));
      }
      outgoing.end();
    });
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

async function postChunkedGzipWithDelayedEnd(
  path: string,
  compressedBody: Buffer,
): Promise<{ status: number; body: unknown; responseBeforeRequestEnd: boolean }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  let outgoing: ReturnType<typeof httpRequest> | undefined;
  let delayedEnd: NodeJS.Timeout | undefined;
  let failTimer: NodeJS.Timeout | undefined;
  try {
    return await new Promise((resolveResponse, reject) => {
      let requestEnded = false;
      let responseStarted = false;
      failTimer = setTimeout(() => reject(new Error('live raw cutoff timed out')), 2_000);
      outgoing = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Transfer-Encoding': 'chunked',
        },
      }, (incoming) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveResponse({
            status: incoming.statusCode ?? 0,
            body: text.length === 0 ? null : JSON.parse(text),
            responseBeforeRequestEnd: !requestEnded,
          });
        });
      });
      outgoing.on('error', (error) => {
        if (!responseStarted) reject(error);
      });
      for (let offset = 0; offset < compressedBody.length; offset += 4_096) {
        outgoing.write(compressedBody.subarray(offset, offset + 4_096));
      }
      delayedEnd = setTimeout(() => {
        requestEnded = true;
        if (!outgoing?.destroyed) outgoing?.end();
      }, 300);
    });
  } finally {
    if (delayedEnd) clearTimeout(delayedEnd);
    if (failTimer) clearTimeout(failTimer);
    outgoing?.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

async function createEnrollment() {
  const response = await request(app)
    .post('/api/raiders/enrollments')
    .send({ raider_key: player.auth_token });
  expect(response.status).toBe(201);
  const code = response.body.enrollment_code as unknown;
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(response.body.install_command).not.toContain(code);
  expect(response.body.install_command).not.toContain('--code');
  return { response, code: code as string };
}

async function enrollDevice(deviceId = randomUUID()) {
  const { code } = await createEnrollment();
  const response = await request(app)
    .post('/api/raiders/enroll')
    .send({ code, device_id: deviceId, companion_version: '0.1.0' });
  expect(response.status).toBe(201);
  return {
    deviceId,
    deviceToken: response.body.device_token as string,
    dedupeSecret: response.body.dedupe_secret as string,
    response,
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  db = openDb(':memory:');
  seedSettings(db);
  player = createPlayer(db, { name: 'Route Raider', class_key: 'knight', gender: 'M' }, NOW);
  eventIdentity = 0;
  app = createApp({ db, config: runtimeConfig() });
});

afterEach(() => {
  if (db.open) db.close();
  vi.restoreAllMocks();
});

describe('private Run JSON boundaries', () => {
  it.each([
    '/api/raiders/enrollments',
    '/api/raiders/enroll',
    '/api/runs/events',
    '/api/runs/heartbeat',
  ])('requires JSON on %s', async (path) => {
    const response = await request(app)
      .post(path)
      .set('Content-Type', 'text/plain')
      .send('private-value');
    expect(response.status).toBe(415);
    expect(response.text).not.toContain('private-value');
  });

  it.each([
    '/api/raiders/enrollments',
    '/api/raiders/enroll',
    '/api/runs/events',
    '/api/runs/heartbeat',
  ])('rejects malformed JSON privately on %s', async (path) => {
    const secret = 'malformed-private-value';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .send(`{"secret":"${secret}"`);
    expect(response.status).toBe(400);
    expect(response.text).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects an unsupported content encoding without logging or echoing the body', async () => {
    const secret = 'encoded-private-value';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(app)
      .post('/api/raiders/enrollments')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'compress')
      .send(JSON.stringify({ raider_key: secret }));

    expect(response.status).toBe(415);
    expect(response.text).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
  });

  it('enforces the 256 KiB wire/body limit, including inflated gzip bodies', async () => {
    const oversized = JSON.stringify({ raider_key: 'x'.repeat(256 * 1_024) });
    const raw = await request(app)
      .post('/api/raiders/enrollments')
      .set('Content-Type', 'application/json')
      .send(oversized);
    expect(raw.status).toBe(413);

    const compressed = await request(app)
      .post('/api/raiders/enrollments')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((value: unknown) => value as string)
      .send(gzipSync(Buffer.from(oversized)) as unknown as string);
    expect(compressed.status).toBe(413);
  });

  it('enforces the raw wire cap for oversized chunked gzip without Content-Length', async () => {
    const prefix = '{"raider_key":"';
    const suffix = '"}';
    const raw = Buffer.from(
      `${prefix}${'x'.repeat(256 * 1_024 - prefix.length - suffix.length)}${suffix}`,
    );
    const compressed = gzipSync(raw, { level: 0 });
    expect(raw.length).toBe(256 * 1_024);
    expect(compressed.length).toBeGreaterThan(256 * 1_024);

    const response = await postChunkedGzip('/api/raiders/enrollments', compressed);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ reason: 'payload_too_large' });
  });

  it('returns 413 and terminates a chunked gzip stream before request end', async () => {
    const validMember = gzipSync(Buffer.from(JSON.stringify({
      raider_key: player.auth_token,
    })));
    const emptyMember = gzipSync(Buffer.alloc(0));
    const compressed = Buffer.concat([
      validMember,
      ...Array.from(
        { length: Math.ceil((280_000 - validMember.length) / emptyMember.length) },
        () => emptyMember,
      ),
    ]);
    expect(compressed.length).toBeGreaterThanOrEqual(280_000);

    const response = await postChunkedGzipWithDelayedEnd(
      '/api/raiders/enrollments',
      compressed,
    );

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ reason: 'payload_too_large' });
    expect(response.responseBeforeRequestEnd).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM raider_enrollments').get())
      .toEqual({ count: 0 });
  });

  it('rejects more than 100 events before creating any Run state', async () => {
    const device = await enrollDevice();
    const events = Array.from({ length: 101 }, () => runEvent(device.deviceId));
    const response = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events });

    expect(response.status).toBe(400);
    expect(countRows('runs')).toBe(0);
    expect(countRows('run_events')).toBe(0);
  });
});

describe('Raider enrollment routes', () => {
  it('creates a private one-time install command and exchanges it exactly once', async () => {
    const { response: created, code } = await createEnrollment();
    expect(created.body).toEqual({
      install_command: 'curl -fsSL https://raiders.redlattice.com/install.sh | sh',
      enrollment_code: code,
      expires_at: NOW + 10 * 60_000,
    });

    const deviceId = randomUUID();
    const exchanged = await request(app)
      .post('/api/raiders/enroll')
      .send({ code, device_id: deviceId, companion_version: '0.1.0' });
    expect(exchanged.status).toBe(201);
    expect(exchanged.body).toEqual({
      device_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      dedupe_secret: expect.stringMatching(/^[0-9a-f]{64}$/),
      server_url: 'https://raiders.test',
      cutover_at: CUTOVER,
      enabled_surfaces: ['codex_desktop', 'codex_cli'],
    });

    const retried = await request(app)
      .post('/api/raiders/enroll')
      .send({ code, device_id: randomUUID(), companion_version: '0.1.0' });
    expect(retried.status).toBe(401);
    expect(retried.body).toEqual({ reason: 'invalid_enrollment' });
    expect(retried.text).not.toContain(code);
  });

  it('does not echo invalid Raider keys or enrollment codes', async () => {
    const raiderKey = 'private-raider-key';
    const enrollment = await request(app)
      .post('/api/raiders/enrollments')
      .send({ raider_key: raiderKey });
    expect(enrollment.status).toBe(401);
    expect(enrollment.text).not.toContain(raiderKey);

    const code = 'A'.repeat(43);
    const exchange = await request(app)
      .post('/api/raiders/enroll')
      .send({ code, device_id: randomUUID(), companion_version: '0.1.0' });
    expect(exchange.status).toBe(401);
    expect(exchange.text).not.toContain(code);
  });

  it('rate-limits repeated enrollment attempts by client IP', async () => {
    let limitedStatus: number | undefined;
    let retryAfter: string | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await request(app)
        .post('/api/raiders/enrollments')
        .send({ raider_key: 'invalid' });
      if (response.status === 429) {
        limitedStatus = response.status;
        retryAfter = response.headers['retry-after'];
        break;
      }
      expect(response.status).toBe(401);
    }
    expect(limitedStatus).toBe(429);
    expect(retryAfter).toBeDefined();
  });

  it('uses only Caddy\'s rightmost forwarded client for enrollment quotas', async () => {
    let limited = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await request(app)
        .post('/api/raiders/enrollments')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ raider_key: 'invalid' });
      if (response.status === 429) {
        limited = true;
        break;
      }
      expect(response.status).toBe(401);
    }
    expect(limited).toBe(true);

    const prependedSpoof = await request(app)
      .post('/api/raiders/enrollments')
      .set('X-Forwarded-For', '203.0.113.99, 198.51.100.10')
      .send({ raider_key: 'invalid' });
    expect(prependedSpoof.status).toBe(429);

    const isolatedClient = await request(app)
      .post('/api/raiders/enrollments')
      .set('X-Forwarded-For', '198.51.100.11')
      .send({ raider_key: 'invalid' });
    expect(isolatedClient.status).toBe(401);
  });
});

describe('Run event authentication and ingestion', () => {
  it('rate-limits an IP before parsing or credential database work', async () => {
    const authorization = `Bearer ${'A'.repeat(43)}`;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .post('/api/runs/events')
        .set('Authorization', authorization)
        .send({ events: [] });
      expect(response.status).toBe(401);
    }

    db.close();
    const malformed = await request(app)
      .post('/api/runs/events')
      .set('Authorization', authorization)
      .set('Content-Type', 'application/json')
      .send('{"events":');
    const valid = await request(app)
      .post('/api/runs/events')
      .set('Authorization', authorization)
      .send({ events: [] });

    expect(malformed.status).toBe(429);
    expect(valid.status).toBe(429);
  });

  it('returns the same private 401 for missing, malformed, and invalid Bearer credentials', async () => {
    const event = runEvent(randomUUID());
    const credentials = [undefined, 'Basic private', 'Bearer', 'Bearer malformed', `Bearer ${'A'.repeat(43)}`];
    for (const authorization of credentials) {
      const call = request(app).post('/api/runs/events').send({ events: [event] });
      if (authorization) call.set('Authorization', authorization);
      const response = await call;
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ reason: 'unauthorized' });
      expect(response.text).not.toContain(authorization ?? 'private');
    }
  });

  it('accepts a valid device once and reports an exact retry as duplicate', async () => {
    const device = await enrollDevice();
    const event = runEvent(device.deviceId);

    const accepted = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [event] });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });

    const duplicate = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [event] });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ accepted: 0, duplicate: 1, ignored: 0 });
    expect(countRows('runs')).toBe(1);
    expect(countRows('run_events')).toBe(1);
  });

  it.each([
    ['cache_read above input', { input: 100, cache_read: 101 }],
    ['reasoning_output above output', { output: 10, reasoning_output: 11 }],
  ] as const)('rejects v2 %s as invalid_usage_counters without persistence', async (
    _name,
    usage,
  ) => {
    const device = await enrollDevice();
    const invalid = runEvent(device.deviceId, {
      started_at_ms: NOW,
      event_time_ms: NOW + 1,
      observed_at_ms: NOW + 1,
      usage,
    });

    const response = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [invalid] });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ reason: 'invalid_usage_counters' });
    expect(countRows('runs')).toBe(0);
    expect(countRows('run_events')).toBe(0);
  });

  it('keeps unexpected ingestion failures on the private 500 path', async () => {
    const device = await enrollDevice();
    const overflow = [
      runEvent(device.deviceId, { usage: { input: Number.MAX_SAFE_INTEGER } }),
      runEvent(device.deviceId, { usage: { input: 1 } }),
    ];

    const response = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: overflow });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ reason: 'internal_error' });
    expect(countRows('runs')).toBe(0);
    expect(countRows('run_events')).toBe(0);
  });

  it('rate-limits an authenticated device without consuming another device quota', async () => {
    const first = await enrollDevice();
    const second = await enrollDevice();
    let limited = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await request(app)
        .post('/api/runs/events')
        .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
        .set('Authorization', `Bearer ${first.deviceToken}`)
        .send({ events: [] });
      if (response.status === 429) {
        expect(response.headers['retry-after']).toBeDefined();
        limited = true;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(limited).toBe(true);

    const isolated = await request(app)
      .post('/api/runs/events')
      .set('X-Forwarded-For', '203.0.113.1')
      .set('Authorization', `Bearer ${second.deviceToken}`)
      .send({ events: [] });
    expect(isolated.status).toBe(200);
  });

  it('does not record contact or ingest when the authenticated device quota is exhausted', async () => {
    const device = await enrollDevice();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .post('/api/runs/events')
        .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
        .set('Authorization', `Bearer ${device.deviceToken}`)
        .send({ events: [] });
      expect(response.status).toBe(200);
    }
    db.prepare('UPDATE raider_devices SET last_seen_at = NULL WHERE device_id = ?')
      .run(device.deviceId);

    const limited = await request(app)
      .post('/api/runs/events')
      .set('X-Forwarded-For', '198.51.100.100')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [runEvent(device.deviceId)] });

    expect(limited.status).toBe(429);
    expect(db.prepare('SELECT last_seen_at FROM raider_devices WHERE device_id = ?')
      .get(device.deviceId)).toEqual({ last_seen_at: null });
    expect(countRows('runs')).toBe(0);
    expect(countRows('run_events')).toBe(0);
  });

  it('authenticates heartbeat, updates the companion version, and sends an empty 204', async () => {
    const device = await enrollDevice();
    const response = await request(app)
      .post('/api/runs/heartbeat')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ companion_version: '0.2.0' });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(db.prepare(`
      SELECT companion_version, last_seen_at FROM raider_devices WHERE device_id = ?
    `).get(device.deviceId)).toEqual({ companion_version: '0.2.0', last_seen_at: NOW });

    const invalid = await request(app)
      .post('/api/runs/heartbeat')
      .set('Authorization', `Bearer ${'A'.repeat(43)}`)
      .send({ companion_version: '0.2.0' });
    expect(invalid.status).toBe(401);
    expect(invalid.text).not.toContain('A'.repeat(43));
  });
});

describe('mutually exclusive scoring and atomic surface allowlist', () => {
  it.each(['legacy-otlp', 'disabled'] as const)(
    'rejects Run scoring in %s mode without writing',
    async (scoringMode) => {
      app = createApp({ db, config: loadConfig({ SCORING_MODE: scoringMode }) });
      const response = await request(app)
        .post('/api/runs/events')
        .send({ events: [runEvent(randomUUID())] });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ reason: 'scoring_disabled' });
      expect(countRows('runs')).toBe(0);
    },
  );

  it.each(['legacy-otlp', 'disabled'] as const)(
    'gates %s scoring before content type, parsing, decompression, and size checks',
    async (scoringMode) => {
      app = createApp({ db, config: loadConfig({ SCORING_MODE: scoringMode }) });
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const calls = [
        request(app)
          .post('/api/runs/events')
          .set('Content-Type', 'text/plain')
          .send('not-json'),
        request(app)
          .post('/api/runs/events')
          .set('Content-Type', 'application/json')
          .send('{"events":'),
        request(app)
          .post('/api/runs/events')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ events: 'x'.repeat(300 * 1_024) })),
        request(app)
          .post('/api/runs/events')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send(`events=${'x'.repeat(120 * 1_024)}`),
      ];

      for (const call of calls) {
        const response = await call;
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ reason: 'scoring_disabled' });
      }
      expect(countRows('runs')).toBe(0);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Claude', { provider: 'claude', surface: 'claude_code' }],
    ['Omp', { provider: 'omp', surface: 'omp' }],
    ['provider mismatch', { provider: 'claude', surface: 'codex_desktop' }],
  ] as const)('rejects %s events atomically with surface_disabled', async (_name, override) => {
    const device = await enrollDevice();
    const event = runEvent(device.deviceId, override);
    const response = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [event] });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ reason: 'surface_disabled' });
    expect(countRows('runs')).toBe(0);
    expect(countRows('run_events')).toBe(0);
  });

  it('rejects a mixed enabled/disabled batch without ingesting its enabled event', async () => {
    const device = await enrollDevice();
    const enabled = runEvent(device.deviceId);
    const disabled = runEvent(device.deviceId, {
      provider: 'claude',
      surface: 'claude_code',
    });
    const response = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [enabled, disabled] });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ reason: 'surface_disabled' });
    expect(countRows('runs')).toBe(0);
    expect(countRows('run_events')).toBe(0);
  });
});

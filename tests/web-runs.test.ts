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

function presenceReceipt(playerId = player.id): number | null {
  const row = db.prepare(`
    SELECT last_run_activity_at FROM raider_presence WHERE player_id = ?
  `).get(playerId) as { last_run_activity_at: number } | undefined;
  return row?.last_run_activity_at ?? null;
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

async function createEnrollment(targetPlayer = player) {
  const response = await request(app)
    .post('/api/raiders/enrollments')
    .send({ raider_key: targetPlayer.auth_token });
  expect(response.status).toBe(201);
  const code = response.body.enrollment_code as unknown;
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(response.body.install_command).not.toContain(code);
  expect(response.body.install_command).not.toContain('--code');
  return { response, code: code as string };
}

async function enrollDevice(deviceId = randomUUID(), targetPlayer = player) {
  const { code } = await createEnrollment(targetPlayer);
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

async function lifecycleFixture() {
  const old = await enrollDevice();
  const targetPlayer = createPlayer(
    db,
    { name: `Target Raider ${randomUUID()}`, class_key: 'mage', gender: 'F' },
    NOW,
  );
  const { code } = await createEnrollment(targetPlayer);
  const identity = db.prepare(`
    SELECT dedupe_secret FROM raider_identities WHERE player_id = ?
  `).get(targetPlayer.id) as { dedupe_secret: string };
  const body = {
    code,
    operation_id: randomUUID(),
    replacement_device_id: randomUUID(),
    replacement_device_token: `${randomUUID().replaceAll('-', '')}${'R'.repeat(11)}`,
    companion_version: '0.4.9',
  };
  return {
    old,
    targetPlayer,
    targetDedupeSecret: identity.dedupe_secret,
    body,
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
    '/api/raiders/re-enroll',
    '/api/raiders/devices/revoke-current',
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
    '/api/raiders/re-enroll',
    '/api/raiders/devices/revoke-current',
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

describe('Raider device lifecycle routes', () => {
  it('replaces, replays, recovers, and revokes a device without echoing request credentials', async () => {
    const fixture = await lifecycleFixture();
    const expectedConfiguration = {
      device_id: fixture.body.replacement_device_id,
      dedupe_secret: fixture.targetDedupeSecret,
      server_url: 'https://raiders.test',
      cutover_at: CUTOVER,
      enabled_surfaces: ['codex_desktop', 'codex_cli'],
    };

    const created = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .send(fixture.body);
    expect(created.status).toBe(201);
    expect(created.body).toEqual(expectedConfiguration);

    const replayed = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .send(fixture.body);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(expectedConfiguration);

    for (const response of [created, replayed]) {
      expect(response.text).not.toContain(fixture.old.deviceToken);
      expect(response.text).not.toContain(fixture.body.replacement_device_token);
      expect(response.text).not.toContain(fixture.body.code);
    }

    const configured = await request(app)
      .get('/api/raiders/enrollment-config')
      .set('Authorization', `Bearer ${fixture.body.replacement_device_token}`);
    expect(configured.status).toBe(200);
    expect(configured.body).toEqual(expectedConfiguration);
    expect(configured.text).not.toContain(fixture.body.replacement_device_token);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revoked = await request(app)
        .post('/api/raiders/devices/revoke-current')
        .set('Authorization', `Bearer ${fixture.body.replacement_device_token}`)
        .send({});
      expect(revoked.status).toBe(200);
      expect(revoked.body).toEqual({ revoked: true });
      expect(revoked.text).not.toContain(fixture.body.replacement_device_token);
    }

    const rejectedConfiguration = await request(app)
      .get('/api/raiders/enrollment-config')
      .set('Authorization', `Bearer ${fixture.body.replacement_device_token}`);
    expect(rejectedConfiguration.status).toBe(401);
    expect(rejectedConfiguration.body).toEqual({ reason: 'unauthorized' });

    const rejectedEvent = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${fixture.body.replacement_device_token}`)
      .send({ events: [runEvent(fixture.body.replacement_device_id)] });
    expect(rejectedEvent.status).toBe(401);
    expect(rejectedEvent.body).toEqual({ reason: 'unauthorized' });
  });

  it('rejects every malformed or non-strict replacement body without logging credentials', async () => {
    const fixture = await lifecycleFixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invalidBodies: Array<Record<string, unknown>> = [
      { ...fixture.body, extra: true },
      { ...fixture.body, code: undefined },
      { ...fixture.body, code: 'A'.repeat(42) },
      { ...fixture.body, operation_id: 'not-a-uuid' },
      { ...fixture.body, replacement_device_id: 'not-a-uuid' },
      { ...fixture.body, replacement_device_token: 'R'.repeat(42) },
      { ...fixture.body, companion_version: '' },
      { ...fixture.body, companion_version: 'v'.repeat(101) },
    ];

    for (const body of invalidBodies) {
      const response = await request(app)
        .post('/api/raiders/re-enroll')
        .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ reason: 'invalid_request' });
      expect(response.text).not.toContain(fixture.old.deviceToken);
      expect(response.text).not.toContain(fixture.body.replacement_device_token);
      expect(response.text).not.toContain(fixture.body.code);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects unsupported replacement content encoding without logging or echoing credentials', async () => {
    const fixture = await lifecycleFixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'compress')
      .send(JSON.stringify(fixture.body));
    expect(response.status).toBe(415);
    expect(response.text).not.toContain(fixture.old.deviceToken);
    expect(response.text).not.toContain(fixture.body.replacement_device_token);
    expect(response.text).not.toContain(fixture.body.code);
    expect(log).not.toHaveBeenCalled();
  });

  it('enforces raw, inflated, and chunked 256 KiB replacement body limits', async () => {
    const fixture = await lifecycleFixture();
    const oversized = JSON.stringify({ ...fixture.body, padding: 'x'.repeat(256 * 1_024) });
    const raw = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .set('Content-Type', 'application/json')
      .send(oversized);
    expect(raw.status).toBe(413);
    expect(raw.body).toEqual({ reason: 'payload_too_large' });

    const inflated = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((value: unknown) => value as string)
      .send(gzipSync(Buffer.from(oversized)) as unknown as string);
    expect(inflated.status).toBe(413);
    expect(inflated.body).toEqual({ reason: 'payload_too_large' });

    const chunkedRaw = Buffer.from(oversized);
    const chunked = await postChunkedGzip(
      '/api/raiders/re-enroll',
      gzipSync(chunkedRaw, { level: 0 }),
    );
    expect(chunked.status).toBe(413);
    expect(chunked.body).toEqual({ reason: 'payload_too_large' });
  });

  it('returns private unauthorized responses for missing, malformed, and unknown lifecycle bearers', async () => {
    const fixture = await lifecycleFixture();
    const credentials = [
      undefined,
      'Basic private',
      'Bearer',
      'Bearer malformed',
      `Bearer ${'A'.repeat(43)}`,
    ];
    for (const authorization of credentials) {
      const replacement = request(app).post('/api/raiders/re-enroll').send(fixture.body);
      const configuration = request(app).get('/api/raiders/enrollment-config');
      const revocation = request(app)
        .post('/api/raiders/devices/revoke-current')
        .send({});
      if (authorization !== undefined) {
        replacement.set('Authorization', authorization);
        configuration.set('Authorization', authorization);
        revocation.set('Authorization', authorization);
      }
      for (const response of [await replacement, await configuration, await revocation]) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ reason: 'unauthorized' });
        expect(response.text).not.toContain('A'.repeat(43));
      }
    }
  });

  it('maps expired and consumed replacement codes to invalid_enrollment without echoing them', async () => {
    const fixture = await lifecycleFixture();
    db.prepare('UPDATE raider_enrollments SET expires_at = ? WHERE player_id = ?')
      .run(NOW, fixture.targetPlayer.id);

    const expired = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .send(fixture.body);
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual({ reason: 'invalid_enrollment' });
    expect(expired.text).not.toContain(fixture.body.code);

    const consumedFixture = await lifecycleFixture();
    const consumed = await request(app)
      .post('/api/raiders/enroll')
      .send({
        code: consumedFixture.body.code,
        device_id: randomUUID(),
        companion_version: '0.4.9',
      });
    expect(consumed.status).toBe(201);
    const rejected = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${consumedFixture.old.deviceToken}`)
      .send(consumedFixture.body);
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({ reason: 'invalid_enrollment' });
    expect(rejected.text).not.toContain(consumedFixture.body.code);
  });

  it('maps conflicting replay to replacement_conflict without echoing request credentials', async () => {
    const fixture = await lifecycleFixture();
    const created = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .send(fixture.body);
    expect(created.status).toBe(201);

    const conflict = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${fixture.old.deviceToken}`)
      .send({ ...fixture.body, operation_id: randomUUID() });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ reason: 'replacement_conflict' });
    expect(conflict.text).not.toContain(fixture.old.deviceToken);
    expect(conflict.text).not.toContain(fixture.body.replacement_device_token);
    expect(conflict.text).not.toContain(fixture.body.code);
  });

  it('rejects an unrelated revoked device from replacement', async () => {
    const fixture = await lifecycleFixture();
    const unrelated = await enrollDevice();
    const revoked = await request(app)
      .post('/api/raiders/devices/revoke-current')
      .set('Authorization', `Bearer ${unrelated.deviceToken}`)
      .send({});
    expect(revoked.status).toBe(200);

    const rejected = await request(app)
      .post('/api/raiders/re-enroll')
      .set('Authorization', `Bearer ${unrelated.deviceToken}`)
      .send(fixture.body);
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({ reason: 'unauthorized' });
    expect(rejected.text).not.toContain(unrelated.deviceToken);
  });

  it('requires configuration recovery to have no request body', async () => {
    const device = await enrollDevice();
    const response = await request(app)
      .get('/api/raiders/enrollment-config')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ unexpected: true });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ reason: 'invalid_request' });
  });

  it('requires revocation to receive exactly an empty JSON object', async () => {
    const device = await enrollDevice();
    const missingJson = await request(app)
      .post('/api/raiders/devices/revoke-current')
      .set('Authorization', `Bearer ${device.deviceToken}`);
    expect(missingJson.status).toBe(415);
    expect(missingJson.body).toEqual({ reason: 'unsupported_media_type' });

    for (const body of [{ extra: true }, []]) {
      const response = await request(app)
        .post('/api/raiders/devices/revoke-current')
        .set('Authorization', `Bearer ${device.deviceToken}`)
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ reason: 'invalid_request' });
    }
  });

  it.each([
    ['/api/raiders/re-enroll', { malformed: true }],
    ['/api/raiders/devices/revoke-current', {}],
  ])('rate-limits %s by IP before parsing or credential database work', async (path, body) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${'A'.repeat(43)}`)
        .send(body);
      expect([400, 401]).toContain(response.status);
    }
    db.close();
    const response = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${'A'.repeat(43)}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ reason: 'rate_limited' });
  });

  it('rate-limits configuration recovery by IP before credential database work', async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .get('/api/raiders/enrollment-config')
        .set('Authorization', `Bearer ${'A'.repeat(43)}`);
      expect(response.status).toBe(401);
    }
    db.close();
    const response = await request(app)
      .get('/api/raiders/enrollment-config')
      .set('Authorization', `Bearer ${'A'.repeat(43)}`);
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ reason: 'rate_limited' });
  });

  it('isolates configuration recovery device quotas by device ID', async () => {
    const first = await enrollDevice();
    const second = await enrollDevice();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .get('/api/raiders/enrollment-config')
        .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
        .set('Authorization', `Bearer ${first.deviceToken}`);
      expect(response.status).toBe(200);
    }
    const limited = await request(app)
      .get('/api/raiders/enrollment-config')
      .set('X-Forwarded-For', '198.51.101.1')
      .set('Authorization', `Bearer ${first.deviceToken}`);
    expect(limited.status).toBe(429);

    const isolated = await request(app)
      .get('/api/raiders/enrollment-config')
      .set('X-Forwarded-For', '198.51.101.2')
      .set('Authorization', `Bearer ${second.deviceToken}`);
    expect(isolated.status).toBe(200);
  });

  it('isolates replacement device quotas by device ID', async () => {
    const first = await lifecycleFixture();
    const second = await lifecycleFixture();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .post('/api/raiders/re-enroll')
        .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
        .set('Authorization', `Bearer ${first.old.deviceToken}`)
        .send(first.body);
      expect(response.status).toBe(attempt === 0 ? 201 : 200);
    }
    const limited = await request(app)
      .post('/api/raiders/re-enroll')
      .set('X-Forwarded-For', '198.51.101.1')
      .set('Authorization', `Bearer ${first.old.deviceToken}`)
      .send(first.body);
    expect(limited.status).toBe(429);

    const isolated = await request(app)
      .post('/api/raiders/re-enroll')
      .set('X-Forwarded-For', '198.51.101.2')
      .set('Authorization', `Bearer ${second.old.deviceToken}`)
      .send(second.body);
    expect(isolated.status).toBe(201);
  });

  it('isolates revocation device quotas by device ID', async () => {
    const first = await enrollDevice();
    const second = await enrollDevice();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(app)
        .post('/api/raiders/devices/revoke-current')
        .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
        .set('Authorization', `Bearer ${first.deviceToken}`)
        .send({});
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ revoked: true });
    }
    const limited = await request(app)
      .post('/api/raiders/devices/revoke-current')
      .set('X-Forwarded-For', '198.51.101.1')
      .set('Authorization', `Bearer ${first.deviceToken}`)
      .send({});
    expect(limited.status).toBe(429);

    const isolated = await request(app)
      .post('/api/raiders/devices/revoke-current')
      .set('X-Forwarded-For', '198.51.101.2')
      .set('Authorization', `Bearer ${second.deviceToken}`)
      .send({});
    expect(isolated.status).toBe(200);
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
    const device = await enrollDevice();
    const event = runEvent(device.deviceId);
    const credentials = [undefined, 'Basic private', 'Bearer', 'Bearer malformed', `Bearer ${'A'.repeat(43)}`];
    for (const authorization of credentials) {
      const call = request(app).post('/api/runs/events').send({ events: [event] });
      if (authorization) call.set('Authorization', authorization);
      const response = await call;
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ reason: 'unauthorized' });
      expect(response.text).not.toContain(authorization ?? 'private');
    }
    expect(presenceReceipt()).toBeNull();
  });

  it('records an exact server receipt for a fresh zero-usage event and keeps its retry duplicate', async () => {
    const device = await enrollDevice();
    const event = runEvent(device.deviceId, {
      started_at_ms: NOW,
      event_time_ms: NOW,
      observed_at_ms: NOW,
      usage: ZERO_USAGE,
    });

    const accepted = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [event] });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(presenceReceipt()).toBe(NOW);

    const duplicate = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [event] });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ accepted: 0, duplicate: 1, ignored: 0 });
    expect(countRows('runs')).toBe(1);
    expect(countRows('run_events')).toBe(1);
  });

  it('does not record presence for malformed event JSON', async () => {
    const device = await enrollDevice();
    const response = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .set('Content-Type', 'application/json')
      .send('{"events":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ reason: 'invalid_request' });
    expect(presenceReceipt()).toBeNull();
  });

  it('accepts a stale valid event without recording presence', async () => {
    app = createApp({
      db,
      config: runtimeConfig({ RUN_SCORING_CUTOVER_AT: String(NOW - 200_000) }),
    });
    const device = await enrollDevice();
    const staleAt = NOW - 120_001;
    const event = runEvent(device.deviceId, {
      started_at_ms: staleAt - 1,
      event_time_ms: staleAt,
      observed_at_ms: staleAt,
      usage: ZERO_USAGE,
    });

    const response = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [event] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(presenceReceipt()).toBeNull();
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
      event_time_ms: NOW,
      observed_at_ms: NOW,
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
    expect(presenceReceipt()).toBeNull();
  });

  it('rejects a newly claimed malformed v2 lower sequence without extending presence', async () => {
    const device = await enrollDevice();
    const higher = runEvent(device.deviceId, {
      sequence: 2,
      started_at_ms: NOW,
      event_time_ms: NOW,
      observed_at_ms: NOW,
      usage: { input: 200 },
    });
    const accepted = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [higher] });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
    expect(presenceReceipt()).toBe(NOW);

    vi.mocked(Date.now).mockReturnValue(NOW + 1);
    const malformedLower = runEvent(device.deviceId, {
      run_key: higher.run_key,
      sequence: 1,
      started_at_ms: higher.started_at_ms,
      event_time_ms: NOW,
      observed_at_ms: NOW + 1,
      usage: { input: 10, cache_read: 11 },
    });
    const rejected = await request(app)
      .post('/api/runs/events')
      .set('Authorization', `Bearer ${device.deviceToken}`)
      .send({ events: [malformedLower] });

    expect(rejected.status).toBe(422);
    expect(rejected.body).toEqual({ reason: 'invalid_usage_counters' });
    expect(countRows('runs')).toBe(1);
    expect(countRows('run_events')).toBe(1);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM run_events WHERE event_key = ?
    `).get(malformedLower.idempotency_key)).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT usage_input, awarded_usage_credit, raid_power
      FROM runs WHERE run_key = ?
    `).get(higher.run_key)).toEqual({
      usage_input: 200,
      awarded_usage_credit: 200,
      raid_power: 200,
    });
    expect(presenceReceipt()).toBe(NOW);
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
    expect(presenceReceipt()).toBeNull();

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
    expect(presenceReceipt()).toBeNull();
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

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createApp } from '../src/web/app';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { resolve } from 'node:path';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  app = createApp({ db, config: loadConfig({}) });
});

function body(token: string, byType: Record<string, number>) {
  const dataPoints = Object.entries(byType).map(([type, v]) => ({
    asInt: String(v), startTimeUnixNano: 's', timeUnixNano: 't',
    attributes: [{ key: 'type', value: { stringValue: type } }],
  }));
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
      scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints } }] }],
    }],
  };
}

describe('POST /v1/metrics', () => {
  it('ingests JSON and returns 200 {}', async () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .send(body(p.auth_token, { input: 100, output: 20 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(120);
  });

  it('honors cache_read_weight from settings', async () => {
    setSetting(db, 'cache_read_weight', '0.1');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    await request(app).post('/v1/metrics').set('Content-Type', 'application/json')
      .send(body(p.auth_token, { cacheRead: 1000 }));
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(100);
  });

  it('accepts gzip-encoded bodies', async () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const raw = Buffer.from(JSON.stringify(body(p.auth_token, { input: 77 })));
    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((d: unknown) => d as string) // send the Buffer as-is, no JSON re-encoding
      .send(gzipSync(raw) as unknown as string);
    expect(res.status).toBe(200);
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(77);
  });

  it('returns 200 on a malformed body without crashing', async () => {
    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .send('{ not valid json ');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('rejects a gzip bomb without crashing (returns 200, ingests nothing)', async () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    // ~80 MB of zeros compresses to a tiny gzip but would blow past the output cap.
    const huge = Buffer.alloc(80 * 1024 * 1024, 0);
    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize((d: unknown) => d as string)
      .send(gzipSync(huge) as unknown as string);
    expect(res.status).toBe(200);
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(0); // nothing ingested
  });

  it('rejects an over-limit point batch before any ingestion state is written', async () => {
    const p = createPlayer(
      db,
      { name: 'Bounded Batch', class_key: 'knight', gender: 'M' },
      1,
    );
    const overLimit = body(p.auth_token, {});
    const metric = overLimit.resourceMetrics[0].scopeMetrics[0].metrics[0];
    metric.sum.aggregationTemporality = 2;
    metric.sum.dataPoints = Array.from({ length: 1_025 }, (_, index) => ({
      asInt: '1',
      startTimeUnixNano: 'bounded-series',
      timeUnixNano: `bounded-${index}`,
      attributes: [{ key: 'type', value: { stringValue: 'input' } }],
    }));

    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .send(overLimit);

    expect(res.status).toBe(200);
    expect(getPlayerById(db, p.id)).toMatchObject({
      effective_tokens: 0,
      total_tokens: 0,
      last_token_at: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM metric_series').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM metric_deliveries').get())
      .toEqual({ count: 0 });
  });

  it('allows 600 requests per client per minute and rate-limits the next one', async () => {
    for (let requestNumber = 1; requestNumber <= 600; requestNumber += 1) {
      const accepted = await request(app)
        .post('/v1/metrics')
        .set('Content-Type', 'application/json')
        .send({});
      expect(accepted.status, `request ${requestNumber}`).toBe(200);
    }

    const limited = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .send({});
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('acknowledges without writing when Runtime Raiders scoring is active', async () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    app = createApp({
      db,
      config: loadConfig({
        SCORING_MODE: 'runtime-raiders',
        RUN_SCORING_CUTOVER_AT: '1800000000000',
        RAID_POWER_POLICY_PATH: resolve('config/raid-power-policy-v1.json'),
        RAID_POWER_POLICY_V2_PATH: resolve('config/raid-power-policy-v2.json'),
        RAID_POWER_V2_CUTOVER_AT: '1800000000000',
        RUN_ENABLED_SURFACES: 'codex_desktop,codex_cli',
      }),
    });

    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .send(body(p.auth_token, { input: 100, output: 20 }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(getPlayerById(db, p.id)).toMatchObject({
      effective_tokens: 0,
      total_tokens: 0,
      last_token_at: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM metric_deliveries').get())
      .toEqual({ count: 0 });
  });
});

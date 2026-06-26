import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createApp } from '../src/web/app';
import { createPlayer, getPlayerById } from '../src/domain/players';

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
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

describe('health', () => {
  it('GET /health returns ok', async () => {
    const app = createApp({ db: openDb(':memory:'), config: loadConfig({}) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

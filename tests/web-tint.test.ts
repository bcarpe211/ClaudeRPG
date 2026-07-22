import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';
import { PNG } from 'pngjs';

function app() {
  const db = openDb(':memory:'); seedSettings(db);
  return createApp({ db, config: loadConfig({}) });
}

describe('GET /sprite/tint', () => {
  it('returns a recolored PNG for a valid sprite/frame/hue', async () => {
    const res = await request(app()).get('/sprite/tint/wizard_M/a/120.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    const png = PNG.sync.read(res.body);
    expect(png.width).toBe(24);
  });
  it('404s an unknown class', async () => {
    expect((await request(app()).get('/sprite/tint/nope_M/a/120.png')).status).toBe(404);
  });
  it('400s an out-of-range hue', async () => {
    expect((await request(app()).get('/sprite/tint/wizard_M/a/999.png')).status).toBe(400);
  });
});

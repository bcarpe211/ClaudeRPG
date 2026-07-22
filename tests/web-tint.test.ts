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
  it('colorizes the priest white robe (was a no-op under hue-swap)', async () => {
    const res = await request(app()).get('/sprite/tint/priest_M/a/0.png'); // hue 0 = red
    expect(res.status).toBe(200);
    const png = PNG.sync.read(res.body);
    let saturatedReds = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (png.data[i + 3] > 0 && r > 120 && r - Math.max(g, b) > 60) saturatedReds++;
    }
    expect(saturatedReds).toBeGreaterThan(20); // the robe is now red, not grey
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

describe('dungeon-preview route gating', () => {
  it('404s when the flag is off', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({}) });
    const res = await request(app).get('/dungeon-preview');
    expect(res.status).toBe(404);
  });
  it('renders when ENABLE_DUNGEON_PREVIEW=1', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({ ENABLE_DUNGEON_PREVIEW: '1' }) });
    const res = await request(app).get('/dungeon-preview');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dungeon Preview');
    expect(res.text).toContain('/sheet/world.png');
  });
});

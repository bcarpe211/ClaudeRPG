import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, config: loadConfig({}) });
});

describe('dungeon shell', () => {
  it('wraps renderPage views in the torch-lit frame and links dungeon.css', async () => {
    const res = await request(app).get('/register');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/static/dungeon.css"');
    expect(res.text).toContain('class="wall wall-l"');
    expect(res.text).toContain('class="wall wall-r"');
  });

  it('full-frame pages render the gutter loot rails', async () => {
    const res = await request(app).get('/register');
    expect(res.text).toContain('class="loot-rail left"');
    expect(res.text).toContain('class="loot-rail right"');
    expect(res.text).not.toContain('frame-lite');
  });
});

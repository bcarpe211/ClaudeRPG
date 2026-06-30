import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-rpg-sprites-'));
  for (const sub of ['creatures_24x24', 'world_24x24', 'classes_26x28']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, 'creatures_24x24', 'oryx_16bit_fantasy_creatures_19.png'), '');
  writeFileSync(join(dir, 'world_24x24', 'oryx_16bit_fantasy_world_70.png'), '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('catalog route gating', () => {
  it('404s when ENABLE_CATALOG is unset', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({ SPRITES_DIR: dir }) });
    const res = await request(app).get('/catalog');
    expect(res.status).toBe(404);
  });

  it('renders the catalog when ENABLE_CATALOG=1', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, config: loadConfig({ SPRITES_DIR: dir, ENABLE_CATALOG: '1' }) });
    const res = await request(app).get('/catalog');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sprite Catalog');
    expect(res.text).toContain('oryx_16bit_fantasy_creatures_19.png');
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PNG } from 'pngjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';
import { LEGEND, loadSlotmap, readSlotmap, SLOTS, slotmapFile } from '../src/domain/slots';
import { setSlotRule, skinRenderHash, getSlotConfig } from '../src/domain/slotcosmetics';
import { spriteFileIndex, spriteId } from '../src/domain/cosmetics';
import { creatureSpriteFile } from '../src/domain/classes';

function ctx(env: NodeJS.ProcessEnv = {}) {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig(env) });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  return { db, app, p };
}

describe('GET /sprite/skin', () => {
  it('404s an unknown player', async () => {
    const { app } = ctx();
    expect((await request(app).get('/sprite/skin/99999/a/deadbeef.png')).status).toBe(404);
  });
  it('renders the player per-slot config: body recolors, weapon/eye slots stay', async () => {
    const { db, app, p } = ctx();
    setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 120 }, 100); // green robe
    const hash = skinRenderHash(spriteId(p.class_key, p.gender), getSlotConfig(db, p.id));
    const res = await request(app).get(`/sprite/skin/${p.id}/a/${hash}.png`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    const out = PNG.sync.read(res.body);
    const base = PNG.sync.read(readFileSync(
      `assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'M', 'a'))}`));
    // an eye pixel (#cf3232 in the hood, flair slot) stays unchanged when only the body is set
    let checkedEye = false;
    for (let y = 8; y <= 11; y++) for (let x = 8; x <= 13; x++) {
      const i = (y * 24 + x) * 4;
      if (base.data[i] === 0xcf && base.data[i + 1] === 0x32 && base.data[i + 2] === 0x32) {
        expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([0xcf, 0x32, 0x32]);
        checkedEye = true;
      }
    }
    expect(checkedEye).toBe(true);
  });
  it('redirects a stale hash to the current immutable skin URL', async () => {
    const { db, app, p } = ctx();
    setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 210, sat: 0.6 }, 100);
    const currentHash = skinRenderHash(spriteId(p.class_key, p.gender), getSlotConfig(db, p.id));

    const res = await request(app).get(`/sprite/skin/${p.id}/a/stale000.png`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `/sprite/skin/${p.id}/a/${currentHash}.png`,
    );
    expect(res.headers['cache-control']).toBeUndefined();
  });
  it('renders a newly hashed URL with fresh slot-map data', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'claude-rpg-skin-cache-'));
    const { db, app, p } = ctx({ DB_PATH: join(cacheDir, 'test.db') });
    const sprite = spriteId(p.class_key, p.gender);
    const file = slotmapFile(sprite, 'a');
    const original = readFileSync(file);
    const source = PNG.sync.read(readFileSync(
      `assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'M', 'a'))}`));
    const originalSlots = readSlotmap(original);
    const map = PNG.sync.read(original);
    const pixel = originalSlots.findIndex((slot, p) => {
      const i = p * 4;
      return slot !== SLOTS.body && source.data[i + 3] !== 0
        && (source.data[i] !== 255 || source.data[i + 1] !== 255 || source.data[i + 2] !== 255);
    });
    const [, body] = LEGEND.find(([slot]) => slot === SLOTS.body)!;
    const i = pixel * 4;

    try {
      expect(loadSlotmap(sprite, 'a')).toEqual(originalSlots); // warm decoded-map cache
      expect(pixel).toBeGreaterThanOrEqual(0);
      map.data.set([...body, 255], i);
      writeFileSync(file, PNG.sync.write(map));

      setSlotRule(db, p.id, SLOTS.body, { op: 'value', lo: 1, hi: 1 }, 100);
      const hash = skinRenderHash(sprite, getSlotConfig(db, p.id));
      const res = await request(app).get(`/sprite/skin/${p.id}/a/${hash}.png`);
      const out = PNG.sync.read(res.body);

      expect(res.status).toBe(200);
      expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([255, 255, 255]);
    } finally {
      writeFileSync(file, original);
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

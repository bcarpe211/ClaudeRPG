import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PNG } from 'pngjs';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';
import { LEGEND, loadSlotmap, readSlotmap, SLOTS, slotmapFile } from '../src/domain/slots';
import { setSlotRule, skinRenderHash, getSlotConfig, getEntitledSlotConfig } from '../src/domain/slotcosmetics';
import { spriteFileIndex, spriteId } from '../src/domain/cosmetics';
import { creatureSpriteFile } from '../src/domain/classes';
import { purchase } from '../src/domain/shop';

function ctx(
  env: NodeJS.ProcessEnv = {},
  slotmapsDir?: string,
  gender: 'M' | 'F' = 'M',
) {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig(env), slotmapsDir });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender }, 1);
  return { db, app, p };
}

describe('GET /sprite/skin', () => {
  it('404s an unknown player', async () => {
    const { app } = ctx();
    expect((await request(app).get('/sprite/skin/99999/a/deadbeef.png')).status).toBe(404);
  });
  it('keeps a stored Tier-3 weapon rule out of pixels and hashes until Tier 3', async () => {
    const { db, app, p } = ctx();
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
    setSlotRule(db, p.id, SLOTS.weapon, { op: 'colorize', hue: 120, sat: 0.6 }, 5);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 10);

    const sprite = spriteId(p.class_key, p.gender);
    const source = PNG.sync.read(readFileSync(
      `assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'M', 'a'))}`,
    ));
    const slotmap = loadSlotmap(sprite, 'a')!;
    const weaponPixel = slotmap.findIndex((slot, pixel) => slot === SLOTS.weapon && source.data[pixel * 4 + 3] !== 0);
    expect(weaponPixel).toBeGreaterThanOrEqual(0);

    const tier1Config = getEntitledSlotConfig(db, p);
    expect(tier1Config.has(SLOTS.weapon)).toBe(false);
    const tier1 = await request(app).get(`/sprite/skin/${p.id}/a/${skinRenderHash(sprite, tier1Config)}.png`);
    expect(Array.from(PNG.sync.read(tier1.body).data.slice(weaponPixel * 4, weaponPixel * 4 + 3)))
      .toEqual(Array.from(source.data.slice(weaponPixel * 4, weaponPixel * 4 + 3)));

    purchase(db, p.id, 'cosmetic_wheel_t2', 2_000_000, 20);
    purchase(db, p.id, 'cosmetic_wheel_t3', 2_500_000, 30);
    const tier3Config = getEntitledSlotConfig(db, p);
    expect(tier3Config.has(SLOTS.weapon)).toBe(true);
    const tier3 = await request(app).get(`/sprite/skin/${p.id}/a/${skinRenderHash(sprite, tier3Config)}.png`);
    expect(Array.from(PNG.sync.read(tier3.body).data.slice(weaponPixel * 4, weaponPixel * 4 + 3)))
      .not.toEqual(Array.from(source.data.slice(weaponPixel * 4, weaponPixel * 4 + 3)));
  });
  it('renders the player per-slot config: body recolors, weapon/eye slots stay', async () => {
    const { db, app, p } = ctx();
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 99);
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
  it('renders a female body rule without changing a mapped flair eye pixel', async () => {
    const { db, app, p } = ctx({}, undefined, 'F');
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 99);
    const sprite = 'wizard_F';
    const slotmap = loadSlotmap(sprite, 'a')!;
    const source = PNG.sync.read(readFileSync(
      `assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'F', 'a'))}`,
    ));
    const bodyPixel = slotmap.findIndex((slot, pixel) => {
      const i = pixel * 4;
      return slot === SLOTS.body && source.data[i + 3] !== 0
        && (source.data[i] !== 0 || source.data[i + 1] !== 0 || source.data[i + 2] !== 0);
    });
    const flairEyePixel = slotmap.findIndex((slot, pixel) => {
      const i = pixel * 4;
      return slot === SLOTS.flair && source.data[i] === 0xcf
        && source.data[i + 1] === 0x32 && source.data[i + 2] === 0x32;
    });
    expect(bodyPixel).toBeGreaterThanOrEqual(0);
    expect(flairEyePixel).toBeGreaterThanOrEqual(0);

    setSlotRule(db, p.id, SLOTS.body, { op: 'colorize', hue: 120, sat: 0.6 }, 100);
    const hash = skinRenderHash(sprite, getSlotConfig(db, p.id));
    const res = await request(app).get(`/sprite/skin/${p.id}/a/${hash}.png`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const out = PNG.sync.read(res.body);
    for (const pixel of [bodyPixel, flairEyePixel]) {
      expect(out.data[pixel * 4 + 3]).toBe(source.data[pixel * 4 + 3]);
    }
    expect(Array.from(out.data.slice(bodyPixel * 4, bodyPixel * 4 + 3)))
      .not.toEqual(Array.from(source.data.slice(bodyPixel * 4, bodyPixel * 4 + 3)));
    expect(Array.from(out.data.slice(flairEyePixel * 4, flairEyePixel * 4 + 3)))
      .toEqual(Array.from(source.data.slice(flairEyePixel * 4, flairEyePixel * 4 + 3)));
  });
  it('redirects a stale hash to the current immutable skin URL', async () => {
    const { db, app, p } = ctx();
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 99);
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
    const fixtureDir = mkdtempSync(join(tmpdir(), 'claude-rpg-skin-fixture-'));
    const slotmapsDir = join(fixtureDir, 'slotmaps');
    mkdirSync(slotmapsDir);
    const { db, app, p } = ctx({ DB_PATH: join(fixtureDir, 'test.db') }, slotmapsDir);
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 99);
    const sprite = spriteId(p.class_key, p.gender);
    const file = join(slotmapsDir, `${sprite}_a.png`);
    copyFileSync(slotmapFile(sprite, 'a'), file);
    copyFileSync(slotmapFile(sprite, 'b'), join(slotmapsDir, `${sprite}_b.png`));
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
      expect(loadSlotmap(sprite, 'a', slotmapsDir)).toEqual(originalSlots); // warm decoded-map cache
      expect(pixel).toBeGreaterThanOrEqual(0);
      map.data.set([...body, 255], i);
      writeFileSync(file, PNG.sync.write(map));

      setSlotRule(db, p.id, SLOTS.body, { op: 'value', lo: 1, hi: 1 }, 100);
      const hash = skinRenderHash(sprite, getSlotConfig(db, p.id), slotmapsDir);
      const res = await request(app).get(`/sprite/skin/${p.id}/a/${hash}.png`);

      expect(res.status).toBe(200);
      const out = PNG.sync.read(res.body);
      expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([255, 255, 255]);
    } finally {
      writeFileSync(file, original);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { getCosmetics } from '../src/domain/cosmetics';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import {
  getSlotConfig,
  setSlotRule,
} from '../src/domain/slotcosmetics';
import { MATERIAL_PRESETS, wheelRule } from '../src/domain/dye';
import { SLOTS } from '../src/domain/slots';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

function ctx(gender: 'M' | 'F' = 'M') {
  const db = openDb(':memory:');
  seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const player = createPlayer(
    db,
    { name: 'A', class_key: 'wizard', gender },
    1,
  );
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
  return { db, app, player };
}

function buy(db: ReturnType<typeof openDb>, playerId: number, tier: 1 | 2 | 3) {
  return purchase(db, playerId, `cosmetic_wheel_t${tier}`, 10);
}

describe('character dye endpoints', () => {
  it('removes the character-page purchase endpoint', async () => {
    const { app, player } = ctx();
    expect((await request(app).post('/character/dye/unlock').type('form').send({ token: player.auth_token })).status).toBe(404);
  });

  it('returns 404 for an unknown token without mutating anything', async () => {
    const { app } = ctx();
    const res = await request(app).post('/character/dye/set').type('form').send({
      token: 'missing-token', slot: SLOTS.body, recipe: 'wheel', hue: 200,
    });
    expect(res.status).toBe(404);
  });

  it('allows Tier-1 clothing but rejects Tier-3 weapon at Tier 1', async () => {
    const { db, app, player } = ctx();
    expect(buy(db, player.id, 1)).toMatchObject({ ok: true, tier: 1 });
    const clothing = await request(app).post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, tone: -0.25 });
    const weapon = await request(app).post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.weapon, recipe: 'gold' });
    expect(clothing.status).toBe(204);
    expect(weapon.status).toBe(403);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 200, sat: 0.6, tone: -0.25 });
  });

  it('accepts the exact Bronze recipe and bounded Tone override', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    const res = await request(app).post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'bronze', tone: 0.2 });
    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 28, sat: 0.58, tone: 0.2 });
  });

  it('rejects invalid Tone without changing the stored rule', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(100), 20);
    for (const tone of ['1.01', '-1.01', 'NaN', 'Infinity']) {
      const res = await request(app).post('/character/dye/set').type('form')
        .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, tone });
      expect(res.status).toBe(400);
    }
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual(wheelRule(100));
  });

  it('rejects malformed recipes and hues without changing the stored rule', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(100), 20);
    for (const body of [
      { recipe: 'bogus' },
      { recipe: 'wheel', hue: 360 },
      { recipe: 'wheel', hue: -1 },
      { recipe: 'wheel', hue: 'NaN' },
    ]) {
      const res = await request(app).post('/character/dye/set').type('form').send({
        token: player.auth_token, slot: SLOTS.body, ...body,
      });
      expect(res.status).toBe(400);
    }
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual(wheelRule(100));
  });

  it('does not clear a retained rule while its tier is locked', async () => {
    const { db, app, player } = ctx();
    setSlotRule(db, player.id, SLOTS.weapon, MATERIAL_PRESETS.gold, 10);
    buy(db, player.id, 1);
    const res = await request(app).post('/character/dye/clear').type('form')
      .send({ token: player.auth_token, slot: SLOTS.weapon });
    expect(res.status).toBe(403);
    expect(getSlotConfig(db, player.id).has(SLOTS.weapon)).toBe(true);
  });

  it('rejects an unavailable channel with 400', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    const res = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.facePaint, recipe: 'steel',
    });
    expect(res.status).toBe(400);
  });

  it('rejects set and clear until the required tier is owned', async () => {
    const { app, player } = ctx();
    const set = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200,
    });
    const clear = await request(app).post('/character/dye/clear').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body });
    expect(set.status).toBe(403);
    expect(clear.status).toBe(403);
  });

  it('restores true default even when a legacy body hue existed', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    setCosmeticHue(db, player.id, 'primary', 210, 100);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(true);
    const res = await request(app).post('/character/dye/clear').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body });
    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(false);
  });
});

describe('character wardrobe panel', () => {
  it('offers the next tier on the character page without purchasing it there', async () => {
    const { app, player } = ctx();
    const res = await request(app).get('/character').query({ token: player.auth_token });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Unlock Dye Wheel');
    expect(res.text).toContain('1,500,000g');
  });

  it('renders the workbench, authored channels, and client config after Tier 1', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    const res = await request(app).get('/character').query({ token: player.auth_token });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dye Workbench');
    expect(res.text).toContain('data-finish="none"');
    expect(res.text).toContain('Restore default');
    expect(res.text).toContain('window.__DYE__');
    expect(res.text).toContain('"label":"Clothing"');
    expect(res.text).not.toContain('"label":"Eyes"');
    expect(res.text).toContain('/static/dye.js');
  });

  it('persists a rule for an authored female channel after Tier 1', async () => {
    const { db, app, player } = ctx('F');
    buy(db, player.id, 1);
    const set = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200,
    });
    expect(set.status).toBe(204);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({
      op: 'colorize', hue: 200, sat: 0.6, tone: 0,
    });
  });
});

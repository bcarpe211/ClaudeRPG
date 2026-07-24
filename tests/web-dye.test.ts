import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { getCosmetics } from '../src/domain/cosmetics';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { setCosmeticHue } from '../src/domain/shop';
import { getSlotConfig } from '../src/domain/slotcosmetics';
import { presentSlots, SLOTS } from '../src/domain/slots';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

function ctx(gender: 'M' | 'F' = 'M', slotmapsDir?: string) {
  const db = openDb(':memory:');
  seedSettings(db);
  const app = createApp({ db, config: loadConfig({}), slotmapsDir });
  const player = createPlayer(
    db,
    { name: 'A', class_key: 'wizard', gender },
    1,
  );
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(player.id);
  return { db, app, player };
}

function unlock(app: ReturnType<typeof createApp>, token: string) {
  return request(app)
    .post('/character/dye/unlock')
    .type('form')
    .send({ token });
}

describe('character dye endpoints', () => {
  it('unlocks the wheel, deducts gold, and redirects to the character page', async () => {
    const { db, app, player } = ctx();

    const res = await unlock(app, player.auth_token);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `/character?token=${encodeURIComponent(player.auth_token)}`,
    );
    expect(getPlayerById(db, player.id)?.gold).toBe(500_000);
    expect(getCosmetics(db, player.id)?.wheel_tier).toBe(1);
  });

  it('unlocks the wheel for an authored female sprite', async () => {
    const { db, app, player } = ctx('F');

    const res = await unlock(app, player.auth_token);

    expect(res.status).toBe(302);
    expect(getPlayerById(db, player.id)?.gold).toBe(500_000);
    expect(getCosmetics(db, player.id)?.wheel_tier).toBe(1);
  });

  it('does not charge or offer unlock when the configured slot-map directory is empty', async () => {
    const slotmapsDir = mkdtempSync(join(tmpdir(), 'clauderpg-empty-slotmaps-'));
    try {
      const { db, app, player } = ctx('F', slotmapsDir);

      const unlockRes = await unlock(app, player.auth_token);

      expect(unlockRes.status).toBe(409);
      expect(getPlayerById(db, player.id)?.gold).toBe(2_000_000);
      expect(getCosmetics(db, player.id)).toBeUndefined();

      const pageRes = await request(app)
        .get('/character')
        .query({ token: player.auth_token });

      expect(pageRes.status).toBe(200);
      expect(pageRes.text).toContain('Tailoring in progress');
      expect(pageRes.text).not.toContain('/character/dye/unlock');
    } finally {
      rmSync(slotmapsDir, { recursive: true });
    }
  });

  it('rejects set and clear until the wheel is unlocked', async () => {
    const { app, player } = ctx();
    const set = await request(app)
      .post('/character/dye/set')
      .type('form')
      .send({
        token: player.auth_token,
        slot: String(SLOTS.body),
        finish: 'wheel',
        hue: '200',
      });
    const clear = await request(app)
      .post('/character/dye/clear')
      .type('form')
      .send({ token: player.auth_token, slot: String(SLOTS.body) });

    expect(set.status).toBe(403);
    expect(clear.status).toBe(403);
  });

  it('stores a wheel color after unlock', async () => {
    const { db, app, player } = ctx();
    await unlock(app, player.auth_token);

    const res = await request(app)
      .post('/character/dye/set')
      .type('form')
      .send({
        token: player.auth_token,
        slot: String(SLOTS.body),
        finish: 'wheel',
        hue: '200',
      });

    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({
      op: 'colorize',
      hue: 200,
      sat: 0.6,
    });
  });

  it('stores each named finish using the shared domain rule', async () => {
    const { db, app, player } = ctx();
    await unlock(app, player.auth_token);

    const res = await request(app)
      .post('/character/dye/set')
      .type('form')
      .send({
        token: player.auth_token,
        slot: String(SLOTS.weapon),
        finish: 'steel',
      });

    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).get(SLOTS.weapon)).toEqual({
      op: 'colorize',
      hue: 212,
      sat: 0.13,
    });
  });

  it('rejects absent, outline, and invalid picker inputs', async () => {
    const { app, player } = ctx();
    await unlock(app, player.auth_token);
    const absent = [
      SLOTS.body,
      SLOTS.headgear,
      SLOTS.hair,
      SLOTS.facePaint,
      SLOTS.cape,
      SLOTS.trim,
      SLOTS.weapon,
      SLOTS.shield,
      SLOTS.boots,
      SLOTS.skin,
      SLOTS.flair,
    ].find((slot) => !presentSlots('wizard_M').includes(slot));
    expect(absent).toBeDefined();

    const requests = [
      { slot: String(absent), finish: 'steel' },
      { slot: String(SLOTS.outline), finish: 'steel' },
      { slot: String(SLOTS.body), finish: 'wheel', hue: '360' },
      { slot: String(SLOTS.body), finish: 'bogus' },
    ];
    for (const body of requests) {
      const res = await request(app)
        .post('/character/dye/set')
        .type('form')
        .send({ token: player.auth_token, ...body });
      expect(res.status).toBe(400);
    }
  });

  it('restores true default even when a legacy body hue existed', async () => {
    const { db, app, player } = ctx();
    await unlock(app, player.auth_token);
    setCosmeticHue(db, player.id, 'primary', 210, 100);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(true);

    const res = await request(app)
      .post('/character/dye/clear')
      .type('form')
      .send({ token: player.auth_token, slot: String(SLOTS.body) });

    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(false);
  });
});

describe('character wardrobe panel', () => {
  it('offers the unlock on the character page without choosing a default color', async () => {
    const { app, player } = ctx();

    const res = await request(app)
      .get('/character')
      .query({ token: player.auth_token });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Unlock Dye Wheel');
    expect(res.text).toContain('1,500,000g');
    expect(res.text).not.toContain('window.__DYE__');
  });

  it('renders the workbench, authored channels, and client config after unlock', async () => {
    const { app, player } = ctx();
    await unlock(app, player.auth_token);

    const res = await request(app)
      .get('/character')
      .query({ token: player.auth_token });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Dye Workbench');
    expect(res.text).toContain('data-finish="none"');
    expect(res.text).toContain('Restore default');
    expect(res.text).toContain('window.__DYE__');
    expect(res.text).toContain('"label":"Eyes"');
    expect(res.text).toContain('/static/dye.js');
  });

  it('offers the unlock to an authored female sprite', async () => {
    const { app, player } = ctx('F');

    const res = await request(app)
      .get('/character')
      .query({ token: player.auth_token });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Unlock Dye Wheel');
    expect(res.text).toContain('/character/dye/unlock');
    expect(res.text).not.toContain('Tailoring in progress');
  });
});

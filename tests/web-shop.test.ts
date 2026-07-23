import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

function ctx() {
  const db = openDb(':memory:');
  seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const player = createPlayer(
    db,
    { name: 'A', class_key: 'wizard', gender: 'M' },
    1,
  );
  return { app, player };
}

describe('shop closed bazaar', () => {
  it('shows the closed state and suspicious mimic without requiring login', async () => {
    const { app } = ctx();

    const res = await request(app).get('/shop');

    expect(res.status).toBe(200);
    expect(res.text).toContain('The Bazaar is Closed');
    expect(res.text).toContain('suspicious treasure chest');
    expect(res.text).toContain('oryx_16bit_fantasy_creatures_198.png');
  });

  it('links a supplied character token back to its wardrobe', async () => {
    const { app, player } = ctx();

    const res = await request(app)
      .get('/shop')
      .query({ token: player.auth_token });

    expect(res.status).toBe(200);
    expect(res.text).toContain(
      `/character?token=${player.auth_token}`,
    );
  });

  it('removes both retired single-hue picker routes', async () => {
    const { app, player } = ctx();
    const color = await request(app)
      .post('/shop/color')
      .type('form')
      .send({ token: player.auth_token, hue: '1' });
    const unlock = await request(app)
      .post('/shop/unlock')
      .type('form')
      .send({ token: player.auth_token });

    expect(color.status).toBe(404);
    expect(unlock.status).toBe(404);
  });
});

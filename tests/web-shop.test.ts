import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';

function ctx() {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
  return { db, app, p };
}

describe('shop', () => {
  it('GET /shop without a token shows the character login', async () => {
    const { app } = ctx();
    const res = await request(app).get('/shop');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Character Login');
  });
  it('POST /shop/unlock deducts gold and unlocks the wheel', async () => {
    const { db, app, p } = ctx();
    const res = await request(app).post('/shop/unlock').type('form').send({ token: p.auth_token });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)!.gold).toBe(500000);
  });
  it('POST /shop/color sets the hue after unlock', async () => {
    const { db, app, p } = ctx();
    await request(app).post('/shop/unlock').type('form').send({ token: p.auth_token });
    const res = await request(app).post('/shop/color').type('form').send({ token: p.auth_token, hue: '210' });
    expect(res.status).toBe(302);
    expect((db.prepare('SELECT primary_hue FROM player_cosmetics WHERE player_id=?').get(p.id) as any).primary_hue).toBe(210);
  });
});

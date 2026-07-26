import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { getCosmetics } from '../src/domain/cosmetics';
import { getPlayerById, createPlayer } from '../src/domain/players';
import { purchase } from '../src/domain/shop';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

function ctx(gold = 0) {
  const db = openDb(':memory:');
  seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(gold, player.id);
  return { db, app, player };
}

describe('Bazaar', () => {
  it('prompts for character login without a token', async () => {
    const { app } = ctx();
    const res = await request(app).get('/shop');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Choose your character');
    expect(res.text).not.toContain('name="sku"');
  });

  it('shows the login scene with a 404 for an unknown token', async () => {
    const { app } = ctx();
    const res = await request(app).get('/shop').query({ token: 'not-a-character' });

    expect(res.status).toBe(404);
    expect(res.text).toContain('Choose your character');
    expect(res.text).toContain('No character found for that token.');
    expect(res.text).not.toContain('name="sku"');
  });

  it('shows exactly Tier 1 for a fresh player', async () => {
    const { app, player } = ctx(7_000_000);
    const res = await request(app).get('/shop').query({ token: player.auth_token });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Tier 1');
    expect(res.text).toContain('1,500,000g');
    expect(res.text.match(/name="sku"/g)).toHaveLength(1);
    expect(res.text).not.toContain('2,000,000g');
  });

  it('purchases the exact next tier and redirects back to the Bazaar', async () => {
    const { db, app, player } = ctx(7_000_000);
    const res = await request(app).post('/shop/cosmetics/purchase').type('form')
      .send({ token: player.auth_token, sku: 'cosmetic_wheel_t1' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/shop?token=');
    expect(getPlayerById(db, player.id)?.gold).toBe(5_500_000);
    expect(getCosmetics(db, player.id)?.wheel_tier).toBe(1);
  });

  it('reports missing gold and never charges an insufficient purchase', async () => {
    const { db, app, player } = ctx(1_000_000);
    const post = await request(app).post('/shop/cosmetics/purchase').type('form')
      .send({ token: player.auth_token, sku: 'cosmetic_wheel_t1' });
    expect(post.status).toBe(302);
    expect(post.headers.location).toContain('result=insufficient_gold');
    expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
    const page = await request(app).get('/shop').query({ token: player.auth_token, result: 'insufficient_gold' });
    expect(page.text).toContain('You need 500,000 more gold');
  });

  it('rejects an out-of-sequence forged SKU without charging', async () => {
    const { db, app, player } = ctx(7_000_000);
    const post = await request(app).post('/shop/cosmetics/purchase').type('form')
      .send({ token: player.auth_token, sku: 'cosmetic_wheel_t3' });
    expect(post.status).toBe(302);
    expect(post.headers.location).toContain('result=out_of_sequence');
    expect(getPlayerById(db, player.id)?.gold).toBe(7_000_000);
    expect(getCosmetics(db, player.id)).toBeUndefined();
  });

  it('redirects malformed or missing purchase input to the safe invalid result', async () => {
    const { app } = ctx();
    const post = await request(app).post('/shop/cosmetics/purchase').type('form').send({});

    expect(post.status).toBe(302);
    expect(post.headers.location).toBe('/shop?result=invalid');
  });

  it('ignores non-allow-listed purchase result values', async () => {
    const { app, player } = ctx(7_000_000);
    const res = await request(app).get('/shop').query({ token: player.auth_token, result: 'untrusted-copy' });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('untrusted-copy');
    expect(res.text).not.toContain('That ledger entry is not available');
  });

  it('renders mastery with no purchase card after Tier 3', async () => {
    const { db, app, player } = ctx(7_000_000);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1);
    purchase(db, player.id, 'cosmetic_wheel_t2', 2);
    purchase(db, player.id, 'cosmetic_wheel_t3', 3);
    const res = await request(app).get('/shop').query({ token: player.auth_token });
    expect(res.text).toContain('Dye Mastery Complete');
    expect(res.text).not.toContain('name="sku"');
  });

  it('keeps retired single-hue picker routes removed', async () => {
    const { app, player } = ctx();
    const color = await request(app).post('/shop/color').type('form')
      .send({ token: player.auth_token, hue: '1' });
    const unlock = await request(app).post('/shop/unlock').type('form')
      .send({ token: player.auth_token });
    expect(color.status).toBe(404);
    expect(unlock.status).toBe(404);
  });
});

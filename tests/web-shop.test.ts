import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { getCosmetics } from '../src/domain/cosmetics';
import { getPlayerById, createPlayer } from '../src/domain/players';
import { purchase } from '../src/domain/shop';
import { seedSettings } from '../src/domain/settings';
import { createApp, renderPage } from '../src/web/app';

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
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).toContain('Tier 1');
    expect(res.text).toContain('1,500,000g');
    expect(res.text.match(/name="sku"/g)).toHaveLength(1);
    expect(res.text).not.toContain('2,000,000g');
  });

  it('enhances only an enabled next-offer purchase form', async () => {
    const ready = ctx(7_000_000);
    const readyPage = await request(ready.app).get('/shop').query({ token: ready.player.auth_token });
    const readyForm = readyPage.text.match(/<form[^>]*action="\/shop\/cosmetics\/purchase"[\s\S]*?<\/form>/)?.[0] ?? '';

    expect(readyForm).toContain('data-purchase-effect');
    expect(readyForm).toContain(`name="token" value="${ready.player.auth_token}"`);
    expect(readyForm).toContain('name="sku" value="cosmetic_wheel_t1"');
    expect(readyPage.text).toContain('<script src="/static/shop.js" defer></script>');

    const poor = ctx(0);
    const poorPage = await request(poor.app).get('/shop').query({ token: poor.player.auth_token });
    const poorForm = poorPage.text.match(/<form[^>]*action="\/shop\/cosmetics\/purchase"[\s\S]*?<\/form>/)?.[0] ?? '';
    expect(poorForm).not.toContain('data-purchase-effect');
    expect(poorForm).toContain('disabled');

    const loginPage = await request(poor.app).get('/shop');
    expect(loginPage.text).not.toContain('data-purchase-effect');
  });

  it('renders the compact Gilded Mimic offer and keeps navigation in the Adventurer Ledger', async () => {
    const { db, app, player } = ctx(7_000_000);
    purchase(db, player.id, 'cosmetic_wheel_t1', 10);

    const res = await request(app).get('/shop').query({ token: player.auth_token });
    const product = res.text.match(/<article class="bazaar-product"[\s\S]*?<\/article>/)?.[0] ?? '';
    const ledger = res.text.match(/<aside class="adventurer-ledger"[\s\S]*?<\/aside>/)?.[0] ?? '';

    expect(res.text).toContain('The Gilded Mimic');
    expect(res.text).toContain('Permanent Wardrobe Upgrade — Tier 2');
    expect(res.text.match(/class="bazaar-product"/g)).toHaveLength(1);
    expect(res.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
    expect(res.text).toContain('5,500,000g');
    expect(res.text).toContain('Wardrobe Tier 1');
    expect(ledger).toContain('Inventory');
    expect(ledger).toContain('Coming Soon');
    expect(ledger).toContain('Potions');
    expect(ledger).toContain('Loot Boxes');
    expect(ledger).toContain('Pets');
    expect(product).not.toContain('Return to Character');
    expect(ledger.match(/Return to Character/g)).toHaveLength(1);
    expect(res.text.match(/Return to Character/g)).toHaveLength(1);
    for (const asset of ['potion.png', 'sword.png', 'shield.png', 'coins.png', 'gem_purple.png']) {
      expect(res.text).toContain(`/static/landing/${asset}`);
    }
  });

  it('embeds a token-free next-offer canvas payload before the local preview script', async () => {
    const { app, player } = ctx(7_000_000);
    const res = await request(app).get('/shop').query({ token: player.auth_token });

    expect(res.text).toContain('<canvas id="shop-preview"');
    expect(res.text).toContain('aria-label="Animated preview of A’s next Wardrobe tier"');
    const bootstrap = res.text.match(/window\.__SHOP_PREVIEW__ = ([\s\S]*?);<\/script>/)?.[1];
    expect(bootstrap).toBeDefined();
    expect(bootstrap).not.toContain(player.auth_token);
    expect(JSON.parse(bootstrap ?? 'null')).toMatchObject({
      frames: {
        a: { base: expect.any(String), slotmap: expect.any(Array) },
        b: { base: expect.any(String), slotmap: expect.any(Array) },
      },
      config: {},
      demoSlots: expect.any(Array),
    });
    const colorScript = res.text.indexOf('<script src="/static/dye-color.js"></script>');
    const bootstrapScript = res.text.indexOf('window.__SHOP_PREVIEW__ =');
    const previewScript = res.text.indexOf('<script src="/static/shop-preview.js"></script>');
    expect(colorScript).toBeGreaterThan(-1);
    expect(bootstrapScript).toBeGreaterThan(colorScript);
    expect(previewScript).toBeGreaterThan(bootstrapScript);
  });

  it('escapes less-than signs when serializing the shop preview bootstrap', async () => {
    const html = await renderPage('shop', {
      title: 'The Bazaar',
      frame: 'full',
      player: { name: 'A', auth_token: 'secret-token' },
      shop: {
        currentTier: 0,
        gold: 7_000_000,
        avatarA: '/a.png',
        avatarB: '/b.png',
        nextOffer: {
          sku: 'cosmetic_wheel_t1', tier: 1, price: 1_500_000, missingGold: 0, channels: [],
          description: 'The merchant is offering a permanent upgrade to your dye ledger.',
        },
        preview: {
          frames: {
            a: { base: '</script><script>unsafe()</script>', slotmap: [] },
            b: { base: '/b.png', slotmap: [] },
          },
          config: {},
          demoSlots: [],
        },
        mastered: false,
      },
      purchaseResult: undefined,
      mimicUrl: '/mimic.png',
    });

    expect(html).toContain('\\u003c/script>\\u003cscript>unsafe()\\u003c/script>');
    expect(html).not.toContain('</script><script>unsafe()</script>');
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
    expect(res.text).not.toContain('action="/shop/cosmetics/purchase"');
    expect(res.text).not.toContain('data-purchase-effect');
    expect(res.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
    expect(res.text).toContain('Wardrobe Tier 3');
    expect(res.text).toContain('Inventory');
    expect(res.text).toContain('Coming Soon');
    expect(res.text.match(/Return to Character/g)).toHaveLength(1);
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

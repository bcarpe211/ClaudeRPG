import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { getCosmetics } from '../src/domain/cosmetics';
import { inventoryQuantity, purchaseConsumable } from '../src/domain/inventory';
import { getPlayerById, createPlayer } from '../src/domain/players';
import { purchase } from '../src/domain/shop';
import { seedSettings, setSetting } from '../src/domain/settings';
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
    expect(res.text.match(/name="sku"/g)).toHaveLength(3);
    expect(res.text).not.toContain('2,000,000g');
  });

  it('renders both daily potion cards with canonical copy, stock, inventory, and unique request IDs', async () => {
    const { app, player } = ctx(700_000);
    const res = await request(app).get('/shop').query({ token: player.auth_token });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).toContain('Beginner Gold Potion');
    expect(res.text).toContain('Beginner Damage Potion');
    expect(res.text).toContain('50g per 1,000 effective tokens');
    expect(res.text).toContain('+25% personal base hit');
    expect(res.text.match(/2 active hours/g)).toHaveLength(2);
    expect(res.text.match(/action="\/shop\/consumables\/purchase"/g)).toHaveLength(2);
    expect(res.text).toContain('name="quantity" min="1" max="3" value="1"');
    expect(res.text.match(/Restocks at midnight/g)).toHaveLength(2);
    expect(res.text).toMatch(/Inventory<\/dt><dd><strong>0<\/strong>/);
    expect(res.text).toMatch(/Stock<\/dt><dd><strong>3<\/strong>/);
    expect(res.text).toContain('Buy 1 · 100,000g');
    expect(res.text).toContain('Buy 1 · 150,000g');
    expect(res.text).toContain(
      'data-ready-copy="Ready to turn hard work into bonus gold."',
    );
    expect(res.text).toContain(
      'data-ready-copy="Ready to put more force behind every hit."',
    );
    expect(res.text).toContain('Ready to turn hard work into bonus gold.');
    expect(res.text).toContain('Ready to put more force behind every hit.');
    expect(res.text).not.toContain('Your purse is ready for 1.');

    const requestIds = [...res.text.matchAll(/name="request_id" value="([^"]+)"/g)]
      .map((match) => match[1]);
    expect(requestIds).toHaveLength(2);
    expect(new Set(requestIds).size).toBe(2);
    expect(requestIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))
      .toBe(true);
  });

  it('renders tuned potion potency and valid sub-hour durations without rounding to zero hours', async () => {
    const { db, app, player } = ctx(700_000);
    setSetting(db, 'potion_gold_t1_gold_per_1000', '73');
    setSetting(db, 'potion_damage_t1_base_hit_pct', '12.5');
    setSetting(db, 'potion_gold_t1_duration_s', '1');
    setSetting(db, 'potion_damage_t1_duration_s', '1800');

    const res = await request(app).get('/shop').query({ token: player.auth_token });

    expect(res.text).toContain('73g per 1,000 effective tokens');
    expect(res.text).toContain('+12.5% personal base hit');
    expect(res.text).toContain('1 active second');
    expect(res.text).toContain('30 active minutes');
    expect(res.text).not.toContain('0 active hours');
  });

  it('enhances only an enabled next-offer purchase form', async () => {
    const ready = ctx(7_000_000);
    const readyPage = await request(ready.app).get('/shop').query({ token: ready.player.auth_token });
    const readyForm = readyPage.text.match(/<form[^>]*action="\/shop\/cosmetics\/purchase"[\s\S]*?<\/form>/)?.[0] ?? '';

    expect(readyForm).toContain('data-purchase-effect');
    expect(readyForm).toContain(`name="token" value="${ready.player.auth_token}"`);
    expect(readyForm).toContain('name="sku" value="cosmetic_wheel_t1"');
    expect(readyForm).toContain('name="expected_price" value="1500000"');
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
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 10);

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
        marketplaceClosed: false,
        consumables: [],
        nextRestockAt: Date.parse('2026-07-30T04:00:00.000Z'),
      },
      purchaseResult: undefined,
      mimicUrl: '/mimic.png',
      consumableRequestIds: {},
    });

    expect(html).toContain('\\u003c/script>\\u003cscript>unsafe()\\u003c/script>');
    expect(html).not.toContain('</script><script>unsafe()</script>');
  });

  it('shows the closed mimic only when rendered without permanent or consumable offers', async () => {
    const html = await renderPage('shop', {
      title: 'The Bazaar',
      frame: 'full',
      player: { name: 'A', auth_token: 'secret-token' },
      shop: {
        currentTier: 3,
        gold: 0,
        avatarA: '/a.png',
        avatarB: '/b.png',
        nextOffer: null,
        preview: null,
        mastered: true,
        marketplaceClosed: true,
        consumables: [],
        nextRestockAt: Date.parse('2026-07-30T04:00:00.000Z'),
      },
      purchaseResult: undefined,
      mimicUrl: '/mimic.png',
      consumableRequestIds: {},
    });

    expect(html).toContain('class="bazaar-closed"');
    expect(html).toContain('The Bazaar is Closed');
    expect(html).not.toContain('action="/shop/cosmetics/purchase"');
    expect(html).not.toContain('action="/shop/consumables/purchase"');
  });

  it('purchases the exact next tier and redirects back to the Bazaar', async () => {
    const { db, app, player } = ctx(7_000_000);
    const res = await request(app).post('/shop/cosmetics/purchase').type('form')
      .send({ token: player.auth_token, sku: 'cosmetic_wheel_t1', expected_price: '1500000' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/shop?token=');
    expect(getPlayerById(db, player.id)?.gold).toBe(5_500_000);
    expect(getCosmetics(db, player.id)?.wheel_tier).toBe(1);
  });

  it.each([
    ['increase', '1600000'],
    ['decrease', '1400000'],
  ])('rejects a price %s after display without charging or granting', async (_direction, currentPrice) => {
    const { db, app, player } = ctx(7_000_000);
    const page = await request(app).get('/shop').query({ token: player.auth_token });
    const displayedPrice = page.text.match(/name="expected_price" value="(\d+)"/)?.[1];
    expect(displayedPrice).toBe('1500000');
    db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run(currentPrice, 'cosmetic_wheel_t1_price');

    const post = await request(app).post('/shop/cosmetics/purchase').type('form').send({
      token: player.auth_token,
      sku: 'cosmetic_wheel_t1',
      expected_price: displayedPrice,
    });

    expect(post.status).toBe(302);
    expect(post.headers.location).toContain('result=price_changed');
    expect(getPlayerById(db, player.id)?.gold).toBe(7_000_000);
    expect(getCosmetics(db, player.id)).toBeUndefined();
    const refreshed = await request(app).get(post.headers.location);
    expect(refreshed.text).toContain('This offer was repriced. Review the current offer; no gold was spent.');
    expect(refreshed.text).not.toContain('Your Wardrobe already advanced');
  });

  it('reports missing gold and never charges an insufficient purchase', async () => {
    const { db, app, player } = ctx(1_000_000);
    const post = await request(app).post('/shop/cosmetics/purchase').type('form')
      .send({ token: player.auth_token, sku: 'cosmetic_wheel_t1', expected_price: '1500000' });
    expect(post.status).toBe(302);
    expect(post.headers.location).toContain('result=insufficient_gold');
    expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
    const page = await request(app).get('/shop').query({ token: player.auth_token, result: 'insufficient_gold' });
    expect(page.text).toContain('You need 500,000 more gold');
  });

  it('rejects an out-of-sequence forged SKU without charging', async () => {
    const { db, app, player } = ctx(7_000_000);
    const post = await request(app).post('/shop/cosmetics/purchase').type('form')
      .send({ token: player.auth_token, sku: 'cosmetic_wheel_t3', expected_price: '2500000' });
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

  it.each(['', '-1', '1.5', 'not-a-price'])('rejects invalid submitted prices: %j', async (expectedPrice) => {
    const { app, player } = ctx(7_000_000);
    const post = await request(app).post('/shop/cosmetics/purchase').type('form').send({
      token: player.auth_token,
      sku: 'cosmetic_wheel_t1',
      expected_price: expectedPrice,
    });

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

  it('renders one-time mastery immediately after the final successful purchase', async () => {
    const { db, app, player } = ctx(7_000_000);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 1);
    purchase(db, player.id, 'cosmetic_wheel_t2', 2_000_000, 2);
    purchase(db, player.id, 'cosmetic_wheel_t3', 2_500_000, 3);

    const res = await request(app).get('/shop').query({
      token: player.auth_token,
      result: 'success',
    });

    expect(res.text).toContain('data-consume-shop-result');
    expect(res.text).toContain('Dye Mastery Complete');
    expect(res.text).not.toContain('The Bazaar is Closed');
    expect(res.text.match(/name="sku"/g)).toHaveLength(2);
    expect(res.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
    expect(res.text).toContain('Wardrobe Tier 3');
    expect(res.text).toContain('Mastered');
  });

  it('keeps the Bazaar open for potion stock after the Wardrobe is mastered', async () => {
    const { db, app, player } = ctx(7_000_000);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 1);
    purchase(db, player.id, 'cosmetic_wheel_t2', 2_000_000, 2);
    purchase(db, player.id, 'cosmetic_wheel_t3', 2_500_000, 3);

    const res = await request(app).get('/shop').query({ token: player.auth_token });

    expect(res.text).not.toContain('class="bazaar-closed"');
    expect(res.text).not.toContain('The Bazaar is Closed');
    expect(res.text).toContain('Beginner Gold Potion');
    expect(res.text).toContain('Beginner Damage Potion');
    expect(res.text).not.toContain('Dye Mastery Complete');
    expect(res.text).not.toContain('data-consume-shop-result');
    expect(res.text).not.toContain('action="/shop/cosmetics/purchase"');
    expect(res.text.match(/action="\/shop\/consumables\/purchase"/g)).toHaveLength(2);
    expect(res.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
    expect(res.text).toContain('Wardrobe Tier 3');
    expect(res.text).toContain('Mastered');
    expect(res.text.match(/Return to Character/g)).toHaveLength(1);
  });

  it('keeps a sold-out potion visible and disables its buy action until midnight', async () => {
    const { db, app, player } = ctx(10_000_000);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 1);
    purchase(db, player.id, 'cosmetic_wheel_t2', 2_000_000, 2);
    purchase(db, player.id, 'cosmetic_wheel_t3', 2_500_000, 3);
    expect(purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      quantity: 3,
      expectedUnitPrice: 100_000,
      requestId: '22222222-2222-4222-8222-222222222222',
      now: Date.now(),
      timeZone: 'America/New_York',
    }).ok).toBe(true);

    const res = await request(app).get('/shop').query({ token: player.auth_token });
    const card = res.text.match(/<article class="bazaar-product potion-gold[^"]*"[\s\S]*?<\/article>/)?.[0] ?? '';

    expect(card).toContain('Beginner Gold Potion');
    expect(card).toMatch(/Stock<\/dt><dd><strong>0<\/strong>/);
    expect(card).toContain('Back at midnight');
    expect(card).toContain('disabled');
    expect(card).not.toContain('data-purchase-effect');
  });

  it('shows the closed mimic after wardrobe mastery and both daily stocks are exhausted', async () => {
    const { db, app, player } = ctx(10_000_000);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 1);
    purchase(db, player.id, 'cosmetic_wheel_t2', 2_000_000, 2);
    purchase(db, player.id, 'cosmetic_wheel_t3', 2_500_000, 3);
    for (const [skuId, price, requestId] of [
      ['potion_gold_t1', 100_000, 'closed-gold'],
      ['potion_damage_t1', 150_000, 'closed-damage'],
    ] as const) {
      expect(purchaseConsumable(db, {
        playerId: player.id,
        skuId,
        quantity: 3,
        expectedUnitPrice: price,
        requestId,
        now: Date.now(),
        timeZone: 'America/New_York',
      })).toMatchObject({ ok: true, stockRemaining: 0 });
    }

    const response = await request(app).get('/shop').query({
      token: player.auth_token,
      result: 'potion_success',
    });

    expect(response.text).toContain('Potion stock added to your inventory.');
    expect(response.text).toContain('class="bazaar-closed"');
    expect(response.text).toContain('The Bazaar is Closed');
    expect(response.text).not.toContain('id="daily-potions-title"');
    expect(response.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
  });

  it('keeps the Wardrobe affordability visible after a potion purchase result', async () => {
    const { app, player } = ctx(250_000);

    const response = await request(app).get('/shop').query({
      token: player.auth_token,
      result: 'potion_success',
    });

    expect(response.text).toContain('Potion stock added to your inventory.');
    expect(response.text).toContain('Gather 1,250,000g more to unlock this ledger page.');
  });

  it('buys a selected potion quantity and redirects with an allow-listed success result', async () => {
    const { db, app, player } = ctx(500_000);
    const post = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: player.auth_token,
      sku: 'potion_gold_t1',
      quantity: '2',
      expected_unit_price: '100000',
      request_id: '33333333-3333-4333-8333-333333333333',
    });

    expect(post.status).toBe(302);
    expect(post.headers['cache-control']).toBe('private, no-store');
    expect(post.headers.location).toContain('result=potion_success');
    expect(getPlayerById(db, player.id)?.gold).toBe(300_000);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(2);
    const refreshed = await request(app).get(post.headers.location);
    expect(refreshed.text).toContain('Potion stock added to your inventory.');
  });

  it.each(['0', '4', '1.5', 'forged'])('rejects forged potion quantity %j without mutation', async (quantity) => {
    const { db, app, player } = ctx(500_000);
    const post = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: player.auth_token,
      sku: 'potion_gold_t1',
      quantity,
      expected_unit_price: '100000',
      request_id: '44444444-4444-4444-8444-444444444444',
    });

    expect(post.status).toBe(302);
    expect(post.headers.location).toBe('/shop?result=invalid');
    expect(getPlayerById(db, player.id)?.gold).toBe(500_000);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(0);
  });

  it('keeps changed potion prices authoritative on the server', async () => {
    const { db, app, player } = ctx(500_000);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('110000', 'potion_gold_t1_price');

    const post = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: player.auth_token,
      sku: 'potion_gold_t1',
      quantity: '2',
      expected_unit_price: '100000',
      request_id: '55555555-5555-4555-8555-555555555555',
    });

    expect(post.headers.location).toContain('result=potion_price_changed');
    expect(getPlayerById(db, player.id)?.gold).toBe(500_000);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(0);
  });

  it('rejects a stale purchase as unavailable when current potion effects are unusable', async () => {
    const { db, app, player } = ctx(500_000);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('not-a-number', 'potion_damage_t1_base_hit_pct');

    const post = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: player.auth_token,
      sku: 'potion_gold_t1',
      quantity: '1',
      expected_unit_price: '100000',
      request_id: '56565656-5656-4565-8565-565656565656',
    });

    expect(post.status).toBe(302);
    expect(post.headers.location).toContain('result=potion_unavailable');
    expect(getPlayerById(db, player.id)?.gold).toBe(500_000);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM shop_purchases').get())
      .toEqual({ count: 0 });
  });

  it('renders an unusable potion configuration as unavailable instead of throwing', async () => {
    const { db, app, player } = ctx(500_000);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run('0', 'potion_gold_t1_duration_s');

    const response = await request(app).get('/shop').query({ token: player.auth_token });

    expect(response.status).toBe(200);
    expect(response.text.match(/Temporarily unavailable/g)).toHaveLength(2);
    expect(response.text).not.toContain('action="/shop/consumables/purchase"');
  });

  it('keeps stock authoritative when a submitted quantity is no longer available', async () => {
    const { db, app, player } = ctx(1_000_000);
    expect(purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      quantity: 2,
      expectedUnitPrice: 100_000,
      requestId: '66666666-6666-4666-8666-666666666666',
      now: Date.now(),
      timeZone: 'America/New_York',
    }).ok).toBe(true);

    const post = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: player.auth_token,
      sku: 'potion_gold_t1',
      quantity: '2',
      expected_unit_price: '100000',
      request_id: '77777777-7777-4777-8777-777777777777',
    });

    expect(post.headers.location).toContain('result=potion_sold_out');
    expect(getPlayerById(db, player.id)?.gold).toBe(800_000);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(2);
  });

  it('keeps the fresh balance authoritative when funds are no longer sufficient', async () => {
    const { db, app, player } = ctx(100_000);
    const post = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: player.auth_token,
      sku: 'potion_damage_t1',
      quantity: '1',
      expected_unit_price: '150000',
      request_id: '88888888-8888-4888-8888-888888888888',
    });

    expect(post.headers.location).toContain('result=potion_insufficient_gold');
    expect(getPlayerById(db, player.id)?.gold).toBe(100_000);
    expect(inventoryQuantity(db, player.id, 'potion_damage_t1')).toBe(0);
  });

  it('rejects unknown tokens and malformed potion identities without echoing them', async () => {
    const { app } = ctx(500_000);
    const unknown = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: 'unknown-token',
      sku: 'potion_gold_t1',
      quantity: '1',
      expected_unit_price: '100000',
      request_id: '99999999-9999-4999-8999-999999999999',
    });
    const forged = await request(app).post('/shop/consumables/purchase').type('form').send({
      token: 'unknown-token',
      sku: 'potion_gold_t2',
      quantity: '1',
      expected_unit_price: '100000',
      request_id: 'not-a-uuid',
    });

    expect(unknown.headers.location).toBe('/shop?result=invalid');
    expect(forged.headers.location).toBe('/shop?result=invalid');
    expect(forged.headers.location).not.toContain('potion_gold_t2');
  });

  it('replays an exact request ID without charging twice', async () => {
    const { db, app, player } = ctx(500_000);
    const input = {
      token: player.auth_token,
      sku: 'potion_gold_t1',
      quantity: '1',
      expected_unit_price: '100000',
      request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };

    const first = await request(app).post('/shop/consumables/purchase').type('form').send(input);
    const duplicate = await request(app).post('/shop/consumables/purchase').type('form').send(input);

    expect(first.headers.location).toContain('result=potion_success');
    expect(duplicate.headers.location).toContain('result=potion_success');
    expect(getPlayerById(db, player.id)?.gold).toBe(400_000);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(1);
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

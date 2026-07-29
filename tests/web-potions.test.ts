import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { inventoryQuantity, purchaseConsumable } from '../src/domain/inventory';
import { createPlayer } from '../src/domain/players';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createApp } from '../src/web/app';

const timeZone = 'America/New_York';

describe('character potion API', () => {
  let db: ReturnType<typeof openDb>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(':memory:');
    seedSettings(db);
    app = createApp({ db, config: loadConfig({ OFFICE_TIME_ZONE: timeZone }) });
  });

  function playerWithStock(
    sku: 'potion_gold_t1' | 'potion_damage_t1' = 'potion_gold_t1',
    quantity = 1,
  ) {
    const now = Date.now() - 1_000;
    const player = createPlayer(db, {
      name: 'Potion Web Tester', class_key: 'wizard', gender: 'M',
    }, now);
    applyGoldMutation(db, {
      playerId: player.id,
      amount: 2_000_000,
      reason: 'opening_balance',
      sourceTable: 'test_players',
      sourceId: `${player.id}`,
      now,
    });
    const bought = purchaseConsumable(db, {
      playerId: player.id,
      skuId: sku,
      quantity,
      expectedUnitPrice: sku === 'potion_gold_t1' ? 100_000 : 150_000,
      requestId: `stock-${player.id}-${sku}`,
      now,
      timeZone,
    });
    expect(bought).toMatchObject({ ok: true });
    return player;
  }

  it('returns private authoritative state without authentication fields', async () => {
    const player = playerWithStock();

    const response = await request(app)
      .get('/character/state')
      .query({ token: player.auth_token });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      inventory: expect.any(Array),
      effects: expect.any(Array),
      today: expect.any(Object),
      currentFight: expect.any(Object),
    });
    expect(JSON.stringify(response.body)).not.toContain(player.auth_token);
    expect(JSON.stringify(response.body)).not.toContain('auth_token');
  });

  it('returns owned inventory as unavailable and rejects activation when tuning is invalid', async () => {
    const player = playerWithStock();
    setSetting(db, 'potion_damage_t1_base_hit_pct', 'not-a-number');

    const state = await request(app)
      .get('/character/state')
      .query({ token: player.auth_token });
    const activation = await request(app)
      .post('/character/potions/activate')
      .type('form')
      .send({
        token: player.auth_token,
        sku: 'potion_gold_t1',
        request_id: crypto.randomUUID(),
      });

    expect(state.status).toBe(200);
    expect(state.body.inventory).toEqual([
      expect.objectContaining({
        sku: 'potion_gold_t1',
        quantity: 1,
        available: false,
        durationMs: null,
        effectCopy: 'Potion tuning is temporarily unavailable.',
        usesRemaining: null,
      }),
    ]);
    expect(activation.status).toBe(409);
    expect(activation.body).toEqual({ ok: false, reason: 'invalid_config' });
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_activations').get())
      .toEqual({ count: 0 });
  });

  it('activates one owned potion and replays an exact UUID idempotently', async () => {
    const player = playerWithStock();
    const requestId = crypto.randomUUID();
    const payload = {
      token: player.auth_token,
      sku: 'potion_gold_t1',
      request_id: requestId,
    };

    const drink = await request(app)
      .post('/character/potions/activate')
      .type('form')
      .send(payload);
    const retry = await request(app)
      .post('/character/potions/activate')
      .type('form')
      .send(payload);

    expect(drink.status).toBe(200);
    expect(drink.headers['cache-control']).toBe('private, no-store');
    expect(drink.body).toMatchObject({
      ok: true,
      duplicate: false,
      potionType: 'gold',
      inventoryRemaining: 0,
      usesRemaining: 2,
      state: 'armed',
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, duplicate: true, inventoryRemaining: 0 });
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_activations').get())
      .toEqual({ count: 1 });
  });

  it.each([
    [{ sku: 'potion_gold_t1', request_id: 'not-a-uuid' }, 'bad UUID'],
    [{ sku: 'potion_unknown', request_id: crypto.randomUUID() }, 'bad SKU'],
  ])('rejects malformed activation input: %s', async (fields) => {
    const player = playerWithStock();
    const before = inventoryQuantity(db, player.id, 'potion_gold_t1');

    const response = await request(app)
      .post('/character/potions/activate')
      .type('form')
      .send({ token: player.auth_token, ...fields });

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ ok: false, reason: 'invalid_input' });
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_activations').get())
      .toEqual({ count: 0 });
  });

  it('returns 404 for an unknown token without mutation', async () => {
    const response = await request(app)
      .post('/character/potions/activate')
      .type('form')
      .send({
        token: 'unknown-token',
        sku: 'potion_gold_t1',
        request_id: crypto.randomUUID(),
      });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ ok: false, reason: 'no_player' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_activations').get())
      .toEqual({ count: 0 });
  });

  it('returns stable 409 reasons for unavailable but valid actions', async () => {
    const noStock = createPlayer(db, {
      name: 'Empty', class_key: 'thief', gender: 'F',
    }, Date.now());
    const noInventory = await request(app)
      .post('/character/potions/activate')
      .type('form')
      .send({
        token: noStock.auth_token,
        sku: 'potion_gold_t1',
        request_id: crypto.randomUUID(),
      });
    expect(noInventory.status).toBe(409);
    expect(noInventory.body).toEqual({ ok: false, reason: 'no_inventory' });

    const limited = playerWithStock('potion_damage_t1');
    setSetting(db, 'potion_daily_uses_per_type', '0');
    const dailyLimit = await request(app)
      .post('/character/potions/activate')
      .type('form')
      .send({
        token: limited.auth_token,
        sku: 'potion_damage_t1',
        request_id: crypto.randomUUID(),
      });
    expect(dailyLimit.status).toBe(409);
    expect(dailyLimit.body).toEqual({ ok: false, reason: 'daily_limit' });
    expect(inventoryQuantity(db, limited.id, 'potion_damage_t1')).toBe(1);
  });

  it('returns type_active and request_conflict without consuming another item', async () => {
    const player = playerWithStock('potion_gold_t1', 2);
    const firstId = crypto.randomUUID();
    const first = await request(app).post('/character/potions/activate').type('form').send({
      token: player.auth_token, sku: 'potion_gold_t1', request_id: firstId,
    });
    expect(first.status).toBe(200);

    const active = await request(app).post('/character/potions/activate').type('form').send({
      token: player.auth_token, sku: 'potion_gold_t1', request_id: crypto.randomUUID(),
    });
    expect(active.status).toBe(409);
    expect(active.body).toEqual({ ok: false, reason: 'type_active' });
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(1);

    const conflict = await request(app).post('/character/potions/activate').type('form').send({
      token: player.auth_token, sku: 'potion_damage_t1', request_id: firstId,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ ok: false, reason: 'request_conflict' });
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(1);
  });
});

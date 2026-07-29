import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { inventoryQuantity, listInventory, purchaseConsumable, remainingDailyStock } from '../src/domain/inventory';
import { officeDayKey } from '../src/domain/office-time';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { seedSettings, setSetting } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
const timeZone = 'America/New_York';
const dayOne = Date.parse('2026-07-28T16:00:00Z');
const dayTwo = Date.parse('2026-07-29T16:00:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

function playerWithGold(gold: number) {
  const player = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, dayOne);
  applyGoldMutation(db, {
    playerId: player.id, amount: gold, reason: 'opening_balance',
    sourceTable: 'test_players', sourceId: `${player.id}`, now: dayOne,
  });
  return player;
}

function request(playerId: number, requestId: string, overrides: Partial<{
  skuId: string;
  quantity: number;
  expectedUnitPrice: number;
  now: number;
}> = {}) {
  return {
    playerId,
    skuId: 'potion_gold_t1',
    quantity: 1,
    expectedUnitPrice: 100_000,
    requestId,
    now: dayOne,
    timeZone,
    ...overrides,
  };
}

function rowCount(table: 'shop_purchases' | 'player_inventory_lots' | 'player_inventory' | 'gold_ledger') {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('personal consumable inventory purchases', () => {
  it('purchases a requested quantity atomically and returns canonical balances', () => {
    const player = playerWithGold(1_000_000);

    expect(purchaseConsumable(db, request(player.id, 'purchase-1', { quantity: 2 })))
      .toMatchObject({ ok: true, inventory: 2, stockRemaining: 1, newGold: 800_000, duplicate: false });
    expect(getPlayerById(db, player.id)?.gold).toBe(800_000);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(2);
    expect(listInventory(db, player.id)).toEqual([{ sku: 'potion_gold_t1', quantity: 2 }]);
    expect(db.prepare('SELECT quantity, unit_price, total_price, inventory_after, gold_after FROM shop_purchases').get())
      .toEqual({ quantity: 2, unit_price: 100_000, total_price: 200_000, inventory_after: 2, gold_after: 800_000 });
    expect(db.prepare('SELECT remaining_quantity, unit_price FROM player_inventory_lots').get())
      .toEqual({ remaining_quantity: 2, unit_price: 100_000 });
  });

  it('requires an explicit integer quantity from one through three', () => {
    const player = playerWithGold(1_000_000);
    for (const quantity of [undefined, 0, 4]) {
      expect(purchaseConsumable(db, request(player.id, `quantity-${quantity}`, { quantity })))
        .toEqual({ ok: false, reason: 'invalid_quantity' });
    }
    expect(rowCount('shop_purchases')).toBe(0);
    expect(rowCount('player_inventory_lots')).toBe(0);
    expect(rowCount('player_inventory')).toBe(0);
    expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
  });

  it('enforces non-rolling daily stock independently for each potion SKU', () => {
    const player = playerWithGold(1_000_000);

    expect(purchaseConsumable(db, request(player.id, 'gold-day-one', { quantity: 3 })))
      .toMatchObject({ ok: true, stockRemaining: 0 });
    expect(purchaseConsumable(db, request(player.id, 'gold-sold-out')))
      .toEqual({ ok: false, reason: 'sold_out' });
    expect(purchaseConsumable(db, request(player.id, 'damage-day-one', {
      skuId: 'potion_damage_t1', quantity: 1, expectedUnitPrice: 150_000,
    }))).toMatchObject({ ok: true, inventory: 1, stockRemaining: 2 });

    const nextDay = officeDayKey(dayTwo, timeZone);
    expect(remainingDailyStock(db, player.id, 'potion_gold_t1', nextDay, 3)).toBe(3);
    expect(purchaseConsumable(db, request(player.id, 'gold-day-two', { now: dayTwo, quantity: 3 })))
      .toMatchObject({ ok: true, inventory: 6, stockRemaining: 0 });
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(6);
    expect(inventoryQuantity(db, player.id, 'potion_damage_t1')).toBe(1);
  });

  it('rejects malformed daily stock as an unusable configuration without mutation', () => {
    const player = playerWithGold(1_000_000);
    setSetting(db, 'potion_daily_stock_per_sku', '0x10');

    expect(purchaseConsumable(db, request(player.id, 'malformed-daily-stock')))
      .toEqual({ ok: false, reason: 'invalid_config' });
    expect(rowCount('shop_purchases')).toBe(0);
    expect(rowCount('player_inventory_lots')).toBe(0);
    expect(rowCount('player_inventory')).toBe(0);
    expect(rowCount('gold_ledger')).toBe(1);
    expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
  });

  it('returns the original purchase on an exact request retry without another charge', () => {
    const player = playerWithGold(1_000_000);
    const input = request(player.id, 'retry-1', { quantity: 2 });
    const original = purchaseConsumable(db, input);
    const retry = purchaseConsumable(db, input);

    expect(original).toMatchObject({ ok: true, duplicate: false, inventory: 2, newGold: 800_000 });
    expect(retry).toMatchObject({ ok: true, duplicate: true, inventory: 2, newGold: 800_000 });
    expect(rowCount('shop_purchases')).toBe(1);
    expect(rowCount('player_inventory_lots')).toBe(1);
    expect(rowCount('gold_ledger')).toBe(2);
    expect(getPlayerById(db, player.id)?.gold).toBe(800_000);
  });

  it('returns the original stock snapshot when a later purchase shares its office day', () => {
    const player = playerWithGold(1_000_000);
    const first = request(player.id, 'original-snapshot');
    purchaseConsumable(db, first);
    purchaseConsumable(db, request(player.id, 'later-purchase'));

    expect(purchaseConsumable(db, first)).toMatchObject({
      ok: true, duplicate: true, inventory: 1, stockRemaining: 2, newGold: 900_000,
    });
    expect(getPlayerById(db, player.id)?.gold).toBe(800_000);
  });

  it('returns the persisted stock snapshot after the daily-stock setting changes', () => {
    const player = playerWithGold(1_000_000);
    const input = request(player.id, 'immutable-stock', { quantity: 2 });
    expect(purchaseConsumable(db, input)).toMatchObject({
      ok: true, duplicate: false, inventory: 2, stockRemaining: 1, newGold: 800_000,
    });
    const mutationsBeforeRetry = {
      purchases: rowCount('shop_purchases'),
      lots: rowCount('player_inventory_lots'),
      inventory: rowCount('player_inventory'),
      ledger: rowCount('gold_ledger'),
    };
    setSetting(db, 'potion_daily_stock_per_sku', '99');

    expect(purchaseConsumable(db, input)).toMatchObject({
      ok: true, duplicate: true, inventory: 2, stockRemaining: 1, newGold: 800_000,
    });
    expect(db.prepare('SELECT stock_remaining_after FROM shop_purchases WHERE player_id = ?').get(player.id))
      .toEqual({ stock_remaining_after: 1 });
    expect({
      purchases: rowCount('shop_purchases'),
      lots: rowCount('player_inventory_lots'),
      inventory: rowCount('player_inventory'),
      ledger: rowCount('gold_ledger'),
    }).toEqual(mutationsBeforeRetry);
    expect(getPlayerById(db, player.id)?.gold).toBe(800_000);
  });

  it('rejects reusing a request ID with a different SKU, quantity, or displayed price', () => {
    const player = playerWithGold(1_000_000);
    purchaseConsumable(db, request(player.id, 'conflict-1'));

    for (const changes of [
      { skuId: 'potion_damage_t1', expectedUnitPrice: 150_000 },
      { quantity: 2 },
      { expectedUnitPrice: 99_999 },
    ]) {
      expect(purchaseConsumable(db, request(player.id, 'conflict-1', changes)))
        .toEqual({ ok: false, reason: 'request_conflict' });
    }
    expect(rowCount('shop_purchases')).toBe(1);
    expect(getPlayerById(db, player.id)?.gold).toBe(900_000);
  });

  it('rejects a changed displayed price without any mutation', () => {
    const player = playerWithGold(1_000_000);
    setSetting(db, 'potion_gold_t1_price', '110000');

    expect(purchaseConsumable(db, request(player.id, 'stale-price')))
      .toEqual({ ok: false, reason: 'price_changed' });
    expect(rowCount('shop_purchases')).toBe(0);
    expect(rowCount('player_inventory_lots')).toBe(0);
    expect(rowCount('player_inventory')).toBe(0);
    expect(rowCount('gold_ledger')).toBe(1);
    expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
  });

  it('rejects a stale purchase when current activation settings are unusable', () => {
    const player = playerWithGold(1_000_000);
    setSetting(db, 'potion_damage_t1_base_hit_pct', 'not-a-number');

    expect(purchaseConsumable(db, request(player.id, 'stale-effect-config')))
      .toEqual({ ok: false, reason: 'invalid_config' });
    expect(rowCount('shop_purchases')).toBe(0);
    expect(rowCount('player_inventory_lots')).toBe(0);
    expect(rowCount('player_inventory')).toBe(0);
    expect(rowCount('gold_ledger')).toBe(1);
    expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
  });

  it('rejects an unsafe unit-price total before any mutation', () => {
    const player = playerWithGold(1_000_000);
    setSetting(db, 'potion_gold_t1_price', String(Number.MAX_SAFE_INTEGER));

    expect(purchaseConsumable(db, request(player.id, 'unsafe-total', {
      quantity: 2,
      expectedUnitPrice: Number.MAX_SAFE_INTEGER,
    }))).toEqual({ ok: false, reason: 'invalid_config' });
    expect(rowCount('shop_purchases')).toBe(0);
    expect(rowCount('player_inventory_lots')).toBe(0);
    expect(rowCount('player_inventory')).toBe(0);
    expect(rowCount('gold_ledger')).toBe(1);
    expect(getPlayerById(db, player.id)?.gold).toBe(1_000_000);
  });

  it('leaves every purchase record untouched when the player cannot afford it', () => {
    const player = playerWithGold(99_999);

    expect(purchaseConsumable(db, request(player.id, 'too-poor')))
      .toEqual({ ok: false, reason: 'insufficient_gold' });
    expect(rowCount('shop_purchases')).toBe(0);
    expect(rowCount('player_inventory_lots')).toBe(0);
    expect(rowCount('player_inventory')).toBe(0);
    expect(rowCount('gold_ledger')).toBe(1);
    expect(getPlayerById(db, player.id)?.gold).toBe(99_999);
  });

  it('keeps the stack quantity equal to all remaining FIFO lots', () => {
    const player = playerWithGold(1_000_000);
    purchaseConsumable(db, request(player.id, 'lot-one', { quantity: 1 }));
    purchaseConsumable(db, request(player.id, 'lot-two', { now: dayTwo, quantity: 2 }));

    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(3);
    expect(db.prepare(
      'SELECT COALESCE(SUM(remaining_quantity), 0) AS quantity FROM player_inventory_lots WHERE player_id = ? AND sku = ?',
    ).get(player.id, 'potion_gold_t1')).toEqual({ quantity: 3 });
  });
});

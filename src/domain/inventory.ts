import type Database from 'better-sqlite3';
import { applyGoldMutation } from './goldledger';
import { officeDayKey } from './office-time';
import { getSetting } from './settings';
import { consumableProduct } from './shop-products';

const DEFAULT_DAILY_STOCK = 3;

export function inventoryQuantity(db: Database.Database, playerId: number, sku: string): number {
  const row = db.prepare(
    'SELECT quantity FROM player_inventory WHERE player_id = ? AND sku = ?',
  ).get(playerId, sku) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

export function listInventory(db: Database.Database, playerId: number): { sku: string; quantity: number }[] {
  return db.prepare(
    'SELECT sku, quantity FROM player_inventory WHERE player_id = ? AND quantity > 0 ORDER BY sku',
  ).all(playerId) as { sku: string; quantity: number }[];
}

export function remainingDailyStock(
  db: Database.Database,
  playerId: number,
  sku: string,
  dayKey: string,
  dailyStock: number,
): number {
  if (!Number.isSafeInteger(dailyStock) || dailyStock < 0) {
    throw new RangeError('daily stock must be a non-negative safe integer');
  }
  const row = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS purchased
     FROM shop_purchases WHERE player_id = ? AND sku = ? AND office_day = ?`,
  ).get(playerId, sku, dayKey) as { purchased: number };
  return Math.max(0, dailyStock - row.purchased);
}

export type ConsumablePurchaseResult =
  | { ok: true; purchaseId: number; inventory: number; stockRemaining: number; newGold: number; duplicate: boolean }
  | { ok: false; reason: 'unknown_sku' | 'invalid_quantity' | 'price_changed' | 'sold_out' | 'insufficient_gold' | 'no_player' | 'request_conflict' };

type PurchaseRow = {
  id: number;
  sku: string;
  quantity: number;
  unit_price: number;
  office_day: string;
  inventory_after: number;
  gold_after: number;
  stock_remaining_after: number;
};

function configuredDailyStock(db: Database.Database): number {
  const raw = getSetting(db, 'potion_daily_stock_per_sku');
  if (raw === undefined) return DEFAULT_DAILY_STOCK;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : DEFAULT_DAILY_STOCK;
  } catch {
    return DEFAULT_DAILY_STOCK;
  }
}

function fifoLotQuantity(db: Database.Database, playerId: number, sku: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(remaining_quantity), 0) AS quantity
     FROM player_inventory_lots WHERE player_id = ? AND sku = ?`,
  ).get(playerId, sku) as { quantity: number };
  return row.quantity;
}

function duplicateResult(purchase: PurchaseRow): ConsumablePurchaseResult {
  return {
    ok: true,
    purchaseId: purchase.id,
    inventory: purchase.inventory_after,
    stockRemaining: purchase.stock_remaining_after,
    newGold: purchase.gold_after,
    duplicate: true,
  };
}

export function purchaseConsumable(
  db: Database.Database,
  input: {
    playerId: number; skuId: string; quantity: number; expectedUnitPrice: number;
    requestId: string; now: number; timeZone: string;
  },
): ConsumablePurchaseResult {
  try {
    const execute = db.transaction((): ConsumablePurchaseResult => {
    const prior = db.prepare(
      `SELECT id, sku, quantity, unit_price, office_day, inventory_after, gold_after, stock_remaining_after
       FROM shop_purchases WHERE player_id = ? AND request_id = ?`,
    ).get(input.playerId, input.requestId) as PurchaseRow | undefined;
    if (prior) {
      if (
        prior.sku !== input.skuId
        || prior.quantity !== input.quantity
        || prior.unit_price !== input.expectedUnitPrice
      ) {
        return { ok: false, reason: 'request_conflict' };
      }
      return duplicateResult(prior);
    }

    const product = consumableProduct(db, input.skuId);
    if (!product) return { ok: false, reason: 'unknown_sku' };
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 3) {
      return { ok: false, reason: 'invalid_quantity' };
    }
    if (input.expectedUnitPrice !== product.price) {
      return { ok: false, reason: 'price_changed' };
    }

    const player = db.prepare('SELECT gold FROM players WHERE id = ?').get(input.playerId) as
      | { gold: number }
      | undefined;
    if (!player) return { ok: false, reason: 'no_player' };

    const officeDay = officeDayKey(input.now, input.timeZone);
    const dailyStock = configuredDailyStock(db);
    const stockRemaining = remainingDailyStock(db, input.playerId, product.id, officeDay, dailyStock);
    if (input.quantity > stockRemaining) return { ok: false, reason: 'sold_out' };
    const stockRemainingAfter = stockRemaining - input.quantity;

    const totalPrice = product.price * input.quantity;
    const inventoryAfter = fifoLotQuantity(db, input.playerId, product.id) + input.quantity;
    const goldAfter = player.gold - totalPrice;
    if (goldAfter < 0) return { ok: false, reason: 'insufficient_gold' };
    const purchase = db.prepare(
      `INSERT INTO shop_purchases
        (player_id, sku, quantity, unit_price, total_price, office_day, request_id,
         inventory_after, gold_after, created_at, stock_remaining_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.playerId, product.id, input.quantity, product.price, totalPrice,
      officeDay, input.requestId, inventoryAfter, goldAfter, input.now, stockRemainingAfter,
    );
    const purchaseId = Number(purchase.lastInsertRowid);
    db.prepare(
      `INSERT INTO player_inventory_lots
        (purchase_id, player_id, sku, remaining_quantity, unit_price, purchased_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(purchaseId, input.playerId, product.id, input.quantity, product.price, input.now);

    const gold = applyGoldMutation(db, {
      playerId: input.playerId,
      amount: -totalPrice,
      reason: 'shop_purchase',
      sourceTable: 'shop_purchases',
      sourceId: `${purchaseId}`,
      now: input.now,
    });
    if (gold.status === 'insufficient_gold') {
      throw new InsufficientGoldPurchase();
    }
    if (gold.status !== 'applied') {
      throw new Error(`unable to debit shop purchase: ${gold.status}`);
    }

    db.prepare(
      `INSERT INTO player_inventory (player_id, sku, quantity, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id, sku) DO UPDATE SET
         quantity = excluded.quantity,
         updated_at = excluded.updated_at`,
    ).run(input.playerId, product.id, inventoryAfter, input.now);

    return {
      ok: true,
      purchaseId,
      inventory: inventoryAfter,
      stockRemaining: stockRemainingAfter,
      newGold: gold.balance,
      duplicate: false,
    };
    });
    return execute();
  } catch (error) {
    if (error instanceof InsufficientGoldPurchase) {
      return { ok: false, reason: 'insufficient_gold' };
    }
    throw error;
  }
}

class InsufficientGoldPurchase extends Error {}

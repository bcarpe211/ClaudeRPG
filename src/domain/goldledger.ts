import type Database from 'better-sqlite3';

export type GoldReason =
  | 'opening_balance' | 'encounter_reward' | 'shop_purchase'
  | 'gold_potion_base' | 'gold_potion_stretch'
  | 'monster_steal' | 'admin_adjustment';

export interface GoldMutationInput {
  playerId: number;
  amount: number;
  reason: GoldReason;
  sourceTable: string;
  sourceId: string;
  now: number;
}

export type GoldMutationResult =
  | { status: 'applied' | 'duplicate'; balance: number }
  | { status: 'no_player' | 'insufficient_gold'; balance?: number };

interface LedgerRow {
  amount: number;
  balance_after: number;
}

function validateInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
}

function validateMutationInput(input: GoldMutationInput): void {
  validateInteger(input.playerId, 'playerId');
  validateInteger(input.amount, 'amount');
  validateInteger(input.now, 'now');
}

function existingMutation(
  db: Database.Database,
  playerId: number,
  reason: GoldReason,
  sourceTable: string,
  sourceId: string,
): LedgerRow | undefined {
  return db.prepare(
    `SELECT amount, balance_after FROM gold_ledger
     WHERE player_id = ? AND reason = ? AND source_table = ? AND source_id = ?`,
  ).get(playerId, reason, sourceTable, sourceId) as LedgerRow | undefined;
}

function applyGoldMutationInTransaction(
  db: Database.Database,
  input: GoldMutationInput,
): GoldMutationResult {
  const prior = existingMutation(db, input.playerId, input.reason, input.sourceTable, input.sourceId);
  if (prior) {
    if (prior.amount !== input.amount) {
      throw new Error('gold ledger source reused with a different amount');
    }
    return { status: 'duplicate', balance: prior.balance_after };
  }

  const player = db.prepare('SELECT gold FROM players WHERE id = ?').get(input.playerId) as
    | { gold: number }
    | undefined;
  if (!player) return { status: 'no_player' };

  const balance = player.gold + input.amount;
  if (!Number.isSafeInteger(balance)) throw new RangeError('balance must be a safe integer');
  if (balance < 0) return { status: 'insufficient_gold', balance: player.gold };

  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(balance, input.playerId);
  db.prepare(
    `INSERT INTO gold_ledger
      (player_id, amount, balance_after, reason, source_table, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.playerId,
    input.amount,
    balance,
    input.reason,
    input.sourceTable,
    input.sourceId,
    input.now,
  );
  return { status: 'applied', balance };
}

export function applyGoldMutation(
  db: Database.Database,
  input: GoldMutationInput,
): GoldMutationResult {
  validateMutationInput(input);
  return db.transaction(() => applyGoldMutationInTransaction(db, input))();
}

export function setGoldBalance(
  db: Database.Database,
  playerId: number,
  target: number,
  requestId: string,
  now: number,
): GoldMutationResult {
  validateInteger(playerId, 'playerId');
  validateInteger(target, 'target');
  validateInteger(now, 'now');
  if (target < 0) throw new RangeError('target must not be negative');

  return db.transaction(() => {
    const prior = existingMutation(db, playerId, 'admin_adjustment', 'admin_requests', requestId);
    if (prior) {
      if (prior.balance_after !== target) {
        throw new Error('gold ledger source reused with a different target');
      }
      return { status: 'duplicate', balance: prior.balance_after } as GoldMutationResult;
    }

    const player = db.prepare('SELECT gold FROM players WHERE id = ?').get(playerId) as
      | { gold: number }
      | undefined;
    if (!player) return { status: 'no_player' } as GoldMutationResult;

    return applyGoldMutationInTransaction(db, {
      playerId,
      amount: target - player.gold,
      reason: 'admin_adjustment',
      sourceTable: 'admin_requests',
      sourceId: requestId,
      now,
    });
  })();
}

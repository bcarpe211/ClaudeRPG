import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { applyGoldMutation, setGoldBalance } from '../src/domain/goldledger';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

describe('gold ledger', () => {
  it('applies a signed mutation and stores the resulting balance', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    expect(applyGoldMutation(db, {
      playerId: p.id, amount: 500, reason: 'encounter_reward',
      sourceTable: 'encounters', sourceId: '7', now: 10,
    })).toEqual({ status: 'applied', balance: 500 });
    expect(db.prepare('SELECT amount, balance_after FROM gold_ledger WHERE player_id=?').get(p.id))
      .toMatchObject({ amount: 500, balance_after: 500 });
  });

  it('returns the original balance for an exact source retry', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const input = { playerId: p.id, amount: 500, reason: 'encounter_reward' as const,
      sourceTable: 'encounters', sourceId: '7', now: 10 };
    expect(applyGoldMutation(db, input).status).toBe('applied');
    expect(applyGoldMutation(db, { ...input, now: 20 })).toEqual({ status: 'duplicate', balance: 500 });
    expect(getPlayerById(db, p.id)?.gold).toBe(500);
  });

  it('rejects reuse of one source with a different amount', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const source = { playerId: p.id, reason: 'encounter_reward' as const,
      sourceTable: 'encounters', sourceId: '7', now: 10 };
    applyGoldMutation(db, { ...source, amount: 500 });
    expect(() => applyGoldMutation(db, { ...source, amount: 501, now: 20 }))
      .toThrow(/source/i);
    expect(getPlayerById(db, p.id)?.gold).toBe(500);
  });

  it('rejects a debit that would make the player negative', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    expect(applyGoldMutation(db, {
      playerId: p.id, amount: -1, reason: 'shop_purchase',
      sourceTable: 'shop_purchases', sourceId: 'x', now: 10,
    })).toEqual({ status: 'insufficient_gold', balance: 0 });
  });

  it('records an absolute admin adjustment as one signed difference', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    expect(setGoldBalance(db, p.id, 250, 'admin-request-1', 20)).toEqual({ status: 'applied', balance: 250 });
    expect(db.prepare("SELECT amount FROM gold_ledger WHERE reason='admin_adjustment'").get())
      .toEqual({ amount: 250 });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { computeIncrement, ingestTokenUsage } from '../src/domain/ingest';
import { purchaseConsumable } from '../src/domain/inventory';
import type { TokenDataPoint } from '../src/domain/otlp';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { activatePotion } from '../src/domain/potions';
import { seedSettings } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

function dp(over: Partial<TokenDataPoint>): TokenDataPoint {
  return { token: 'T', type: 'input', model: 'm', value: 0, startTimeUnixNano: 's1', temporality: 'cumulative', ...over };
}

function cumulativeBody(token: string, value: number) {
  return {
    resourceMetrics: [{
      resource: {
        attributes: [{
          key: 'claude_rpg_token',
          value: { stringValue: token },
        }],
      },
      scopeMetrics: [{
        metrics: [{
          name: 'claude_code.token.usage',
          sum: {
            aggregationTemporality: 2,
            dataPoints: [{
              asInt: String(value),
              startTimeUnixNano: 'gold-series',
              timeUnixNano: 't',
              attributes: [
                { key: 'type', value: { stringValue: 'input' } },
                { key: 'model', value: { stringValue: 'm' } },
              ],
            }],
          },
        }],
      }],
    }],
  };
}

function activeGoldPotionPlayer(at: number) {
  seedSettings(db);
  const player = createPlayer(
    db,
    { name: 'Cumulative Potion', class_key: 'knight', gender: 'M' },
    at - 10_000,
  );
  applyGoldMutation(db, {
    playerId: player.id,
    amount: 100_000,
    reason: 'opening_balance',
    sourceTable: 'test_players',
    sourceId: `${player.id}`,
    now: at - 10_000,
  });
  expect(purchaseConsumable(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    quantity: 1,
    expectedUnitPrice: 100_000,
    requestId: 'buy-cumulative',
    now: at - 2_000,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true });
  const dungeon = db.prepare(
    `INSERT INTO dungeons
      (level, theme, seed, regular_count, created_at)
     VALUES (1, 'Ossuary Pale', 1, 2, ?)`,
  ).run(at);
  const encounter = db.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at)
     VALUES (?, 0, 'single', 1, 1, 1, 100, 100, 'active', ?)`,
  ).run(Number(dungeon.lastInsertRowid), at);
  db.prepare(
    `UPDATE game_state
     SET current_dungeon_id = ?, current_encounter_id = ?
     WHERE id = 1`,
  ).run(Number(dungeon.lastInsertRowid), Number(encounter.lastInsertRowid));
  expect(activatePotion(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    requestId: 'drink-cumulative',
    now: at,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true });
  return player;
}

describe('computeIncrement', () => {
  it('delta points pass through unchanged and store no series', () => {
    expect(computeIncrement(db, dp({ temporality: 'delta', value: 30 }))).toBe(30);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM metric_series').get() as any;
    expect(rows.c).toBe(0);
  });

  it('cumulative: first sighting counts the full value, then diffs', () => {
    expect(computeIncrement(db, dp({ value: 100 }))).toBe(100); // first
    expect(computeIncrement(db, dp({ value: 130 }))).toBe(30);  // +30
    expect(computeIncrement(db, dp({ value: 130 }))).toBe(0);   // no change
  });

  it('cumulative: a counter reset (value drops) counts the new value', () => {
    computeIncrement(db, dp({ value: 100 }));
    expect(computeIncrement(db, dp({ value: 20 }))).toBe(20); // reset → treat as full
  });

  it('different series (startTime/type/model) are tracked independently', () => {
    expect(computeIncrement(db, dp({ value: 50, startTimeUnixNano: 's1' }))).toBe(50);
    expect(computeIncrement(db, dp({ value: 70, startTimeUnixNano: 's2' }))).toBe(70);
    expect(computeIncrement(db, dp({ value: 9, type: 'output' }))).toBe(9);
  });

  it('a null token still computes (series keyed by literal null) but is harmless', () => {
    expect(computeIncrement(db, dp({ token: null, value: 5 }))).toBe(5);
  });

  it('credits Gold Potion work from cumulative increments, not cumulative totals', () => {
    const now = 1_000_000;
    const player = activeGoldPotionPlayer(now);

    ingestTokenUsage(
      db,
      cumulativeBody(player.auth_token, 999),
      now,
      { cacheReadWeight: 0 },
    );
    ingestTokenUsage(
      db,
      cumulativeBody(player.auth_token, 1_000),
      now + 1,
      { cacheReadWeight: 0 },
    );

    expect(db.prepare(
      `SELECT effective_delta FROM token_events
       WHERE player_id = ? ORDER BY id`,
    ).all(player.id)).toEqual([
      { effective_delta: 999 },
      { effective_delta: 1 },
    ]);
    expect(db.prepare(
      `SELECT effective_delta, base_gold FROM potion_work_events ORDER BY id`,
    ).all()).toEqual([
      { effective_delta: 999, base_gold: 0 },
      { effective_delta: 1, base_gold: 50 },
    ]);
    expect(db.prepare(
      `SELECT eligible_tokens, base_gold, stretch_gold
       FROM potion_activations WHERE player_id = ?`,
    ).get(player.id)).toEqual({
      eligible_tokens: 1_000,
      base_gold: 50,
      stretch_gold: 0,
    });
    expect(getPlayerById(db, player.id)?.gold).toBe(50);
  });
});

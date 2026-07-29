import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { advanceCombatClock } from '../src/domain/gameclock';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { createPlayer, getPlayerById } from '../src/domain/players';
import {
  activatePotion,
  applyGoldPotionWork,
} from '../src/domain/potions';
import { seedSettings } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
const timeZone = 'America/New_York';
const now = Date.parse('2026-07-28T16:00:00Z');
const durationMs = 7_200_000;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

function seedActiveEncounter(playerId: number, at: number): void {
  db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?').run(at, playerId);
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
     SET current_dungeon_id = ?, current_encounter_id = ?, defeat_until = NULL
     WHERE id = 1`,
  ).run(Number(dungeon.lastInsertRowid), Number(encounter.lastInsertRowid));
}

function createGoldActivation(withEncounter = true) {
  const player = createPlayer(
    db,
    { name: 'Gold Tester', class_key: 'knight', gender: 'M' },
    now - 10_000,
  );
  applyGoldMutation(db, {
    playerId: player.id,
    amount: 100_000,
    reason: 'opening_balance',
    sourceTable: 'test_players',
    sourceId: `${player.id}`,
    now: now - 10_000,
  });
  const purchase = purchaseConsumable(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    quantity: 1,
    expectedUnitPrice: 100_000,
    requestId: `buy-${player.id}`,
    now: now - 2_000,
    timeZone,
  });
  expect(purchase).toMatchObject({ ok: true, newGold: 0 });
  if (withEncounter) seedActiveEncounter(player.id, now);
  const activation = activatePotion(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    requestId: `drink-${player.id}`,
    now,
    timeZone,
  });
  expect(activation).toMatchObject({
    ok: true,
    duplicate: false,
    potionType: 'gold',
  });
  if (!activation.ok) throw new Error(`activation fixture failed: ${activation.reason}`);
  return { player, activationId: activation.activationId };
}

function insertTokenEvent(
  playerId: number,
  effectiveDelta: number,
  at: number,
): number {
  const event = db.prepare(
    `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
     VALUES (?, ?, ?, ?)`,
  ).run(playerId, at, effectiveDelta, effectiveDelta);
  return Number(event.lastInsertRowid);
}

function activationTotals(activationId: number) {
  return db.prepare(
    `SELECT eligible_tokens, base_gold, stretch_gold
     FROM potion_activations WHERE id = ?`,
  ).get(activationId);
}

describe('Gold Potion work', () => {
  it('accumulates partial units and credits only newly completed 1,000-token units', () => {
    const { player, activationId } = createGoldActivation();
    const event1 = insertTokenEvent(player.id, 999, now);
    const event2 = insertTokenEvent(player.id, 1, now + 1);

    expect(applyGoldPotionWork(db, player.id, event1, 999, now)).toEqual({
      activationId,
      eligibleTokens: 999,
      baseGold: 0,
      stretchGold: 0,
      duplicate: false,
    });
    expect(applyGoldPotionWork(db, player.id, event2, 1, now + 1)).toEqual({
      activationId,
      eligibleTokens: 1,
      baseGold: 50,
      stretchGold: 0,
      duplicate: false,
    });

    expect(getPlayerById(db, player.id)?.gold).toBe(50);
    expect(activationTotals(activationId)).toEqual({
      eligible_tokens: 1_000,
      base_gold: 50,
      stretch_gold: 0,
    });
    expect(db.prepare(
      `SELECT token_event_id, effective_delta, base_gold, stretch_gold
       FROM potion_work_events ORDER BY id`,
    ).all()).toEqual([
      { token_event_id: event1, effective_delta: 999, base_gold: 0, stretch_gold: 0 },
      { token_event_id: event2, effective_delta: 1, base_gold: 50, stretch_gold: 0 },
    ]);
  });

  it('crosses many units at once, breaks even at 2M, caps base, and awards stretch once', () => {
    const { player, activationId } = createGoldActivation();
    const breakEven = insertTokenEvent(player.id, 2_000_000, now);
    const nearCap = insertTokenEvent(player.id, 499_999, now + 1);
    const capAndStretch = insertTokenEvent(player.id, 1, now + 2);
    const beyondCap = insertTokenEvent(player.id, 1_000_000, now + 3);

    expect(applyGoldPotionWork(db, player.id, breakEven, 2_000_000, now))
      .toMatchObject({ baseGold: 100_000, stretchGold: 0 });
    expect(getPlayerById(db, player.id)?.gold).toBe(100_000);

    expect(applyGoldPotionWork(db, player.id, nearCap, 499_999, now + 1))
      .toMatchObject({ baseGold: 24_950, stretchGold: 0 });
    expect(applyGoldPotionWork(db, player.id, capAndStretch, 1, now + 2))
      .toMatchObject({ baseGold: 50, stretchGold: 25_000 });
    expect(applyGoldPotionWork(db, player.id, beyondCap, 1_000_000, now + 3))
      .toMatchObject({ baseGold: 0, stretchGold: 0 });

    expect(getPlayerById(db, player.id)?.gold).toBe(150_000);
    expect(activationTotals(activationId)).toEqual({
      eligible_tokens: 3_500_000,
      base_gold: 125_000,
      stretch_gold: 25_000,
    });
    expect(db.prepare(
      `SELECT reason, amount, source_table, source_id
       FROM gold_ledger
       WHERE reason IN ('gold_potion_base', 'gold_potion_stretch')
       ORDER BY id`,
    ).all()).toEqual([
      {
        reason: 'gold_potion_base',
        amount: 100_000,
        source_table: 'potion_work_events',
        source_id: '1',
      },
      {
        reason: 'gold_potion_base',
        amount: 24_950,
        source_table: 'potion_work_events',
        source_id: '2',
      },
      {
        reason: 'gold_potion_base',
        amount: 50,
        source_table: 'potion_work_events',
        source_id: '3',
      },
      {
        reason: 'gold_potion_stretch',
        amount: 25_000,
        source_table: 'potion_work_events',
        source_id: '3',
      },
    ]);
  });

  it('replays one token-event result without later cleanup or ledger mutation', () => {
    const { player, activationId } = createGoldActivation();
    const tokenEventId = insertTokenEvent(player.id, 1_000, now);
    const first = applyGoldPotionWork(db, player.id, tokenEventId, 1_000, now);
    expect(first).toEqual({
      activationId,
      eligibleTokens: 1_000,
      baseGold: 50,
      stretchGold: 0,
      duplicate: false,
    });
    const laterEventId = insertTokenEvent(player.id, 1_000, now + 1);
    expect(applyGoldPotionWork(
      db,
      player.id,
      laterEventId,
      1_000,
      now + 1,
    )).toMatchObject({
      eligibleTokens: 1_000,
      baseGold: 50,
      stretchGold: 0,
      duplicate: false,
    });

    advanceCombatClock(db, durationMs, now + durationMs, timeZone);
    db.prepare("UPDATE encounters SET status = 'defeated'").run();
    db.prepare(
      `UPDATE potion_activations SET effect_snapshot = 'malformed'
       WHERE id = ?`,
    ).run(activationId);
    const before = {
      activation: db.prepare('SELECT * FROM potion_activations WHERE id = ?').get(activationId),
      work: db.prepare('SELECT * FROM potion_work_events').all(),
      ledger: db.prepare('SELECT * FROM gold_ledger ORDER BY id').all(),
      gold: getPlayerById(db, player.id)?.gold,
    };

    expect(applyGoldPotionWork(
      db,
      player.id,
      tokenEventId,
      1_000,
      now + durationMs,
    )).toEqual({ ...first, duplicate: true });
    expect({
      activation: db.prepare('SELECT * FROM potion_activations WHERE id = ?').get(activationId),
      work: db.prepare('SELECT * FROM potion_work_events').all(),
      ledger: db.prepare('SELECT * FROM gold_ledger ORDER BY id').all(),
      gold: getPlayerById(db, player.id)?.gold,
    }).toEqual(before);
  });

  it('earns zero for non-positive, idle, defeat-window, and malformed work', () => {
    const zero = {
      activationId: null,
      eligibleTokens: 0,
      baseGold: 0,
      stretchGold: 0,
      duplicate: false,
    };

    {
      const { player, activationId } = createGoldActivation();
      const event = insertTokenEvent(player.id, 0, now);
      expect(applyGoldPotionWork(db, player.id, event, 0, now)).toEqual(zero);
      expect(activationTotals(activationId)).toEqual({
        eligible_tokens: 0,
        base_gold: 0,
        stretch_gold: 0,
      });
    }

    db = openDb(':memory:');
    seedSettings(db);
    {
      const { player } = createGoldActivation();
      db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?')
        .run(now - 15 * 60_000 - 1, player.id);
      const event = insertTokenEvent(player.id, 1_000, now);
      expect(applyGoldPotionWork(db, player.id, event, 1_000, now)).toEqual(zero);
    }

    db = openDb(':memory:');
    seedSettings(db);
    {
      const { player } = createGoldActivation();
      db.prepare('UPDATE game_state SET defeat_until = ? WHERE id = 1').run(now + 1);
      const event = insertTokenEvent(player.id, 1_000, now);
      expect(applyGoldPotionWork(db, player.id, event, 1_000, now)).toEqual(zero);
    }

    db = openDb(':memory:');
    seedSettings(db);
    {
      const { player, activationId } = createGoldActivation();
      db.prepare(
        `UPDATE potion_activations SET effect_snapshot = '{"kind":"gold"}'
         WHERE id = ?`,
      ).run(activationId);
      const event = insertTokenEvent(player.id, 1_000, now);
      expect(applyGoldPotionWork(db, player.id, event, 1_000, now)).toEqual(zero);
    }

    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_work_events').get())
      .toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM gold_ledger
       WHERE reason IN ('gold_potion_base', 'gold_potion_stretch')`,
    ).get()).toEqual({ count: 0 });
  });

  it('earns zero after combat-clock expiry', () => {
    const { player, activationId } = createGoldActivation();
    advanceCombatClock(db, durationMs, now + durationMs, timeZone);
    const event = insertTokenEvent(player.id, 1_000, now + durationMs);

    expect(applyGoldPotionWork(
      db,
      player.id,
      event,
      1_000,
      now + durationMs,
    )).toEqual({
      activationId: null,
      eligibleTokens: 0,
      baseGold: 0,
      stretchGold: 0,
      duplicate: false,
    });
    expect(activationTotals(activationId)).toEqual({
      eligible_tokens: 0,
      base_gold: 0,
      stretch_gold: 0,
    });
    expect(db.prepare(
      'SELECT status, completed_at FROM potion_activations WHERE id = ?',
    ).get(activationId)).toEqual({
      status: 'completed',
      completed_at: now + durationMs,
    });
  });

  it('does not count a token event received before the first encounter exists', () => {
    const { player, activationId } = createGoldActivation(false);
    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?').run(now, player.id);
    const event = insertTokenEvent(player.id, 1_000, now);

    expect(applyGoldPotionWork(db, player.id, event, 1_000, now)).toMatchObject({
      activationId: null,
      eligibleTokens: 0,
      baseGold: 0,
      stretchGold: 0,
    });
    expect(activationTotals(activationId)).toEqual({
      eligible_tokens: 0,
      base_gold: 0,
      stretch_gold: 0,
    });
    expect(getPlayerById(db, player.id)?.gold).toBe(0);
  });
});

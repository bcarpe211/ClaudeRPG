import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { advanceCombatClock } from '../src/domain/gameclock';
import { applyGoldMutation } from '../src/domain/goldledger';
import { inventoryQuantity, purchaseConsumable } from '../src/domain/inventory';
import { officeDayKey } from '../src/domain/office-time';
import { createPlayer } from '../src/domain/players';
import {
  activatePotion,
  activePotionEffects,
  damagePotionMultiplier,
  visiblePotionTiersByPlayer,
  completeExpiredPotions,
  remainingDailyUses,
} from '../src/domain/potions';
import { seedSettings, setSetting } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
const timeZone = 'America/New_York';
const dayOne = Date.parse('2026-07-28T16:00:00Z');
const dayTwo = Date.parse('2026-07-29T16:00:00Z');
const dayBefore = Date.parse('2026-07-27T16:00:00Z');
const twoDaysBefore = Date.parse('2026-07-26T16:00:00Z');
const durationMs = 7_200_000;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

function playerWithGold(gold = 5_000_000) {
  const player = createPlayer(
    db,
    { name: 'Potion Tester', class_key: 'knight', gender: 'M' },
    twoDaysBefore,
  );
  applyGoldMutation(db, {
    playerId: player.id,
    amount: gold,
    reason: 'opening_balance',
    sourceTable: 'test_players',
    sourceId: `${player.id}`,
    now: twoDaysBefore,
  });
  return player;
}

function buy(
  playerId: number,
  skuId: 'potion_gold_t1' | 'potion_damage_t1',
  quantity: number,
  requestId: string,
  now = dayBefore,
) {
  const expectedUnitPrice = skuId === 'potion_gold_t1' ? 100_000 : 150_000;
  const result = purchaseConsumable(db, {
    playerId,
    skuId,
    quantity,
    expectedUnitPrice,
    requestId,
    now,
    timeZone,
  });
  expect(result).toMatchObject({ ok: true, duplicate: false });
  if (!result.ok) throw new Error(`purchase fixture failed: ${result.reason}`);
  return result;
}

function activate(
  playerId: number,
  skuId: 'potion_gold_t1' | 'potion_damage_t1',
  requestId: string,
  now = dayOne,
) {
  return activatePotion(db, {
    playerId,
    skuId,
    requestId,
    now,
    timeZone,
  });
}

function expectStackMatchesLots(playerId: number, sku: string): void {
  const lots = db.prepare(
    `SELECT COALESCE(SUM(remaining_quantity), 0) AS quantity
     FROM player_inventory_lots WHERE player_id = ? AND sku = ?`,
  ).get(playerId, sku) as { quantity: number };
  expect(inventoryQuantity(db, playerId, sku)).toBe(lots.quantity);
}

function activationWriteState(playerId: number) {
  return {
    totalChanges: (db.prepare(
      'SELECT total_changes() AS changes',
    ).get() as { changes: number }).changes,
    activations: db.prepare(
      'SELECT * FROM potion_activations WHERE player_id = ? ORDER BY id',
    ).all(playerId),
    inventory: db.prepare(
      'SELECT * FROM player_inventory WHERE player_id = ? ORDER BY sku',
    ).all(playerId),
    lots: db.prepare(
      'SELECT * FROM player_inventory_lots WHERE player_id = ? ORDER BY id',
    ).all(playerId),
  };
}

function seedActiveEncounter(playerId: number, now: number): void {
  db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?').run(now, playerId);
  const dungeon = db.prepare(
    `INSERT INTO dungeons
      (level, theme, seed, regular_count, created_at)
     VALUES (1, 'Ossuary Pale', 1, 2, ?)`,
  ).run(now);
  const encounter = db.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at)
     VALUES (?, 0, 'single', 1, 1, 1, 100, 100, 'active', ?)`,
  ).run(Number(dungeon.lastInsertRowid), now);
  db.prepare(
    `UPDATE game_state
     SET current_dungeon_id = ?, current_encounter_id = ?
     WHERE id = 1`,
  ).run(Number(dungeon.lastInsertRowid), Number(encounter.lastInsertRowid));
}

describe('manual potion activation', () => {
  it('atomically consumes one FIFO unit and snapshots Gold behavior and purchase price', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 1, 'older-lot', twoDaysBefore);
    setSetting(db, 'potion_gold_t1_price', '120000');
    const newer = purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      quantity: 1,
      expectedUnitPrice: 120_000,
      requestId: 'newer-lot',
      now: dayBefore,
      timeZone,
    });
    expect(newer).toMatchObject({ ok: true });

    expect(activate(player.id, 'potion_gold_t1', 'drink-1')).toMatchObject({
      ok: true,
      duplicate: false,
      potionType: 'gold',
      inventoryRemaining: 1,
      usesRemaining: 2,
      state: 'armed',
    });

    const row = db.prepare('SELECT * FROM potion_activations').get() as Record<string, unknown>;
    expect(row.purchase_unit_price).toBe(100_000);
    expect(JSON.parse(String(row.effect_snapshot))).toEqual({
      kind: 'gold',
      durationMs: 7_200_000,
      tokenUnit: 1_000,
      goldPerUnit: 50,
      baseCap: 125_000,
      stretchTokens: 2_500_000,
      stretchBonus: 25_000,
    });
    expect(Number(row.expires_game_ms) - Number(row.start_game_ms)).toBe(7_200_000);
    expect(db.prepare(
      `SELECT unit_price, remaining_quantity
       FROM player_inventory_lots ORDER BY purchased_at, id`,
    ).all()).toEqual([
      { unit_price: 100_000, remaining_quantity: 0 },
      { unit_price: 120_000, remaining_quantity: 1 },
    ]);
    expectStackMatchesLots(player.id, 'potion_gold_t1');
  });

  it('returns an exact retry without mutation and rejects changed-SKU request reuse first', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 1, 'retry-stock');
    const input = {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      requestId: 'drink-retry',
      now: dayOne,
      timeZone,
    };

    const original = activatePotion(db, input);
    const retry = activatePotion(db, input);

    expect(original).toMatchObject({ ok: true, duplicate: false, inventoryRemaining: 0, usesRemaining: 2 });
    expect(retry).toMatchObject({ ok: true, duplicate: true, inventoryRemaining: 0, usesRemaining: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_activations').get())
      .toEqual({ count: 1 });
    expect(activatePotion(db, { ...input, skuId: 'potion_damage_t1' }))
      .toEqual({ ok: false, reason: 'request_conflict' });
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(0);
    expectStackMatchesLots(player.id, 'potion_gold_t1');
  });

  it('replays an expired active response with zero writes before completion cleanup', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 1, 'uncompleted-retry-stock');
    const input = {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      requestId: 'uncompleted-retry',
      now: dayOne,
      timeZone,
    };
    const original = activatePotion(db, input);
    expect(original).toMatchObject({
      ok: true,
      duplicate: false,
      inventoryRemaining: 0,
      usesRemaining: 2,
      state: 'armed',
    });
    if (!original.ok) throw new Error(`activation fixture failed: ${original.reason}`);
    advanceCombatClock(db, durationMs + 1, dayOne + durationMs + 1, timeZone);
    const beforeRetry = activationWriteState(player.id);
    expect(db.prepare(
      'SELECT status, completed_at FROM potion_activations WHERE id = ?',
    ).get(original.activationId)).toEqual({
      status: 'active',
      completed_at: null,
    });

    expect(activatePotion(db, { ...input, now: dayOne + durationMs + 1 }))
      .toEqual({ ...original, duplicate: true });
    expect(activationWriteState(player.id)).toEqual(beforeRetry);
    expectStackMatchesLots(player.id, 'potion_gold_t1');
  });

  it('replays the original response after expiry, state, inventory, and daily-use changes', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 3, 'delayed-retry-stock', twoDaysBefore);
    seedActiveEncounter(player.id, dayOne);
    const input = {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      requestId: 'delayed-retry',
      now: dayOne,
      timeZone,
    };
    const original = activatePotion(db, input);
    expect(original).toMatchObject({
      ok: true,
      duplicate: false,
      inventoryRemaining: 2,
      usesRemaining: 2,
      state: 'active',
    });
    if (!original.ok) throw new Error(`activation fixture failed: ${original.reason}`);
    expect(db.prepare(
      `SELECT inventory_remaining_after, uses_remaining_after, initial_state
       FROM potion_activations WHERE id = ?`,
    ).get(original.activationId)).toEqual({
      inventory_remaining_after: 2,
      uses_remaining_after: 2,
      initial_state: 'active',
    });

    advanceCombatClock(db, durationMs, dayOne + durationMs, timeZone);
    expect(completeExpiredPotions(db, dayOne + durationMs)).toBe(1);
    expect(activate(
      player.id,
      'potion_gold_t1',
      'later-same-day',
      dayOne + durationMs,
    )).toMatchObject({ ok: true, usesRemaining: 1 });
    advanceCombatClock(db, durationMs, dayOne + durationMs * 2, timeZone);
    expect(completeExpiredPotions(db, dayOne + durationMs * 2)).toBe(1);
    buy(player.id, 'potion_gold_t1', 2, 'later-inventory', dayTwo);
    db.prepare("UPDATE encounters SET status = 'defeated'").run();

    const stateBeforeRetry = {
      activations: db.prepare(
        `SELECT id, request_id, status, completed_at
         FROM potion_activations ORDER BY id`,
      ).all(),
      inventory: inventoryQuantity(db, player.id, 'potion_gold_t1'),
      lots: db.prepare(
        `SELECT id, remaining_quantity
         FROM player_inventory_lots ORDER BY id`,
      ).all(),
    };
    expect(stateBeforeRetry.inventory).toBe(3);

    expect(activatePotion(db, { ...input, now: dayTwo }))
      .toEqual({ ...original, duplicate: true });
    expect({
      activations: db.prepare(
        `SELECT id, request_id, status, completed_at
         FROM potion_activations ORDER BY id`,
      ).all(),
      inventory: inventoryQuantity(db, player.id, 'potion_gold_t1'),
      lots: db.prepare(
        `SELECT id, remaining_quantity
         FROM player_inventory_lots ORDER BY id`,
      ).all(),
    }).toEqual(stateBeforeRetry);
    expectStackMatchesLots(player.id, 'potion_gold_t1');
  });

  it('rejects unknown products, missing players, empty inventory, and invalid effect settings', () => {
    const player = playerWithGold();

    expect(activatePotion(db, {
      playerId: player.id,
      skuId: 'potion_gold_t2',
      requestId: 'unknown',
      now: dayOne,
      timeZone,
    })).toEqual({ ok: false, reason: 'unknown_sku' });
    expect(activate(999_999, 'potion_gold_t1', 'missing-player'))
      .toEqual({ ok: false, reason: 'no_player' });
    expect(activate(player.id, 'potion_gold_t1', 'empty'))
      .toEqual({ ok: false, reason: 'no_inventory' });

    buy(player.id, 'potion_damage_t1', 1, 'invalid-config-stock');
    setSetting(db, 'potion_damage_t1_base_hit_pct', 'not-a-number');
    expect(activate(player.id, 'potion_damage_t1', 'invalid-config'))
      .toEqual({ ok: false, reason: 'invalid_config' });
    setSetting(db, 'potion_damage_t1_base_hit_pct', '-25');
    expect(activate(player.id, 'potion_damage_t1', 'negative-config'))
      .toEqual({ ok: false, reason: 'invalid_config' });
    expect(inventoryQuantity(db, player.id, 'potion_damage_t1')).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_activations').get())
      .toEqual({ count: 0 });
    expectStackMatchesLots(player.id, 'potion_damage_t1');
  });

  it('charges three uses to the activation day, rejects a fourth, and resets next local day', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 3, 'older-three', twoDaysBefore);
    buy(player.id, 'potion_gold_t1', 1, 'newer-one', dayBefore);
    const beforeMidnight = Date.parse('2026-07-29T03:59:00Z');
    const afterMidnight = Date.parse('2026-07-29T04:01:00Z');

    for (let use = 1; use <= 3; use += 1) {
      expect(activate(player.id, 'potion_gold_t1', `day-one-${use}`, beforeMidnight))
        .toMatchObject({ ok: true, duplicate: false, usesRemaining: 3 - use });
      expectStackMatchesLots(player.id, 'potion_gold_t1');
      advanceCombatClock(db, durationMs, afterMidnight, timeZone);
    }

    expect(activate(player.id, 'potion_gold_t1', 'day-one-fourth', beforeMidnight))
      .toEqual({ ok: false, reason: 'daily_limit' });
    expect(remainingDailyUses(
      db,
      player.id,
      'gold',
      officeDayKey(beforeMidnight, timeZone),
      3,
    )).toBe(0);
    expect(db.prepare(
      `SELECT DISTINCT activation_day
       FROM potion_activations WHERE request_id LIKE 'day-one-%'`,
    ).all()).toEqual([{ activation_day: '2026-07-28' }]);

    expect(activate(player.id, 'potion_gold_t1', 'day-two-first', afterMidnight))
      .toMatchObject({ ok: true, duplicate: false, usesRemaining: 2 });
    expectStackMatchesLots(player.id, 'potion_gold_t1');
  });

  it('counts limits by potion type across SKUs and keeps Gold and Damage independent', () => {
    const player = playerWithGold();
    const purchase = buy(player.id, 'potion_gold_t1', 1, 'fixture-purchase');
    const snapshot = JSON.stringify({
      kind: 'gold',
      durationMs,
      tokenUnit: 1_000,
      goldPerUnit: 50,
      baseCap: 125_000,
      stretchTokens: 2_500_000,
      stretchBonus: 25_000,
    });
    const insert = db.prepare(
      `INSERT INTO potion_activations
        (player_id, sku, potion_type, tier, purchase_id, purchase_unit_price,
         request_id, activation_day, activated_at, start_game_ms, expires_game_ms,
         status, completed_at, effect_snapshot)
       VALUES (?, ?, 'gold', ?, ?, 100000, ?, '2026-07-28', ?, 0, ?, 'completed', ?, ?)`,
    );
    insert.run(
      player.id, 'potion_gold_t1', 1, purchase.purchaseId, 'gold-t1',
      dayOne, durationMs, dayOne, snapshot,
    );
    insert.run(
      player.id, 'potion_gold_t2', 2, purchase.purchaseId, 'gold-t2',
      dayOne, durationMs, dayOne, snapshot,
    );

    expect(remainingDailyUses(db, player.id, 'gold', '2026-07-28', 3)).toBe(1);
    expect(remainingDailyUses(db, player.id, 'damage', '2026-07-28', 3)).toBe(3);
  });

  it('ignores malformed rows in reads and retires an invalid active row before activation', () => {
    const player = playerWithGold();
    const purchase = buy(player.id, 'potion_gold_t1', 1, 'malformed-row-stock');
    const malformed = db.prepare(
      `INSERT INTO potion_activations
        (player_id, sku, potion_type, tier, purchase_id, purchase_unit_price,
         request_id, activation_day, activated_at, start_game_ms, expires_game_ms,
         status, effect_snapshot, inventory_remaining_after,
         uses_remaining_after, initial_state)
       VALUES (?, 'potion_gold_t1', 'gold', 1, ?, 100000, 'malformed-active',
               '2026-07-28', ?, 0, ?, 'active', ?, 0, 2, 'active')`,
    ).run(
      player.id,
      purchase.purchaseId,
      dayOne,
      durationMs,
      '{"kind":"gold","durationMs":"broken"}',
    );

    expect(remainingDailyUses(db, player.id, 'gold', '2026-07-28', 3)).toBe(3);
    expect(activePotionEffects(db, player.id, dayOne)).toEqual([]);

    const malformedBeforeRetry = activationWriteState(player.id);
    expect(activate(player.id, 'potion_gold_t1', 'malformed-active')).toEqual({
      ok: true,
      activationId: Number(malformed.lastInsertRowid),
      duplicate: true,
      potionType: 'gold',
      inventoryRemaining: 0,
      usesRemaining: 2,
      state: 'active',
    });
    expect(activationWriteState(player.id)).toEqual(malformedBeforeRetry);
    expect(activate(player.id, 'potion_damage_t1', 'malformed-active'))
      .toEqual({ ok: false, reason: 'request_conflict' });
    expect(activationWriteState(player.id)).toEqual(malformedBeforeRetry);

    expect(activate(player.id, 'potion_gold_t1', 'valid-after-malformed')).toMatchObject({
      ok: true,
      duplicate: false,
      inventoryRemaining: 0,
      usesRemaining: 2,
    });
    expect(db.prepare(
      `SELECT request_id, status, completed_at
       FROM potion_activations ORDER BY id`,
    ).all()).toEqual([
      { request_id: 'malformed-active', status: 'completed', completed_at: dayOne },
      { request_id: 'valid-after-malformed', status: 'active', completed_at: null },
    ]);
    expect(remainingDailyUses(db, player.id, 'gold', '2026-07-28', 3)).toBe(2);
    expectStackMatchesLots(player.id, 'potion_gold_t1');
  });

  it('allows Gold and Damage to overlap but cannot stack, extend, replace, or queue one type', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 2, 'gold-stock');
    buy(player.id, 'potion_damage_t1', 1, 'damage-stock');

    expect(activate(player.id, 'potion_gold_t1', 'gold-first'))
      .toMatchObject({ ok: true, potionType: 'gold' });
    const goldBefore = db.prepare(
      `SELECT id, start_game_ms, expires_game_ms
       FROM potion_activations WHERE potion_type = 'gold'`,
    ).get();
    expect(activate(player.id, 'potion_damage_t1', 'damage-first'))
      .toMatchObject({ ok: true, potionType: 'damage' });
    expect(activate(player.id, 'potion_gold_t1', 'gold-second'))
      .toEqual({ ok: false, reason: 'type_active' });

    expect(db.prepare(
      `SELECT id, start_game_ms, expires_game_ms
       FROM potion_activations WHERE potion_type = 'gold'`,
    ).get()).toEqual(goldBefore);
    expect(db.prepare(
      `SELECT potion_type FROM potion_activations
       WHERE status = 'active' ORDER BY potion_type`,
    ).all()).toEqual([{ potion_type: 'damage' }, { potion_type: 'gold' }]);
    expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(1);
    expectStackMatchesLots(player.id, 'potion_gold_t1');
    expectStackMatchesLots(player.id, 'potion_damage_t1');
  });

  it('completes an expired same-type row before activating its replacement', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 2, 'expiry-stock');
    const first = activate(player.id, 'potion_gold_t1', 'expiring');
    expect(first).toMatchObject({ ok: true });
    advanceCombatClock(db, durationMs, dayOne + durationMs, timeZone);

    expect(activate(player.id, 'potion_gold_t1', 'after-expiry', dayOne + durationMs))
      .toMatchObject({ ok: true, duplicate: false, inventoryRemaining: 0 });
    expect(db.prepare(
      `SELECT request_id, status, completed_at
       FROM potion_activations ORDER BY id`,
    ).all()).toEqual([
      { request_id: 'expiring', status: 'completed', completed_at: dayOne + durationMs },
      { request_id: 'after-expiry', status: 'active', completed_at: null },
    ]);
    expectStackMatchesLots(player.id, 'potion_gold_t1');
  });

  it('reports armed, active, paused, and completed from persisted combat-active time', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_gold_t1', 1, 'state-stock');
    seedActiveEncounter(player.id, dayOne);

    expect(activate(player.id, 'potion_gold_t1', 'stateful'))
      .toMatchObject({ ok: true, state: 'active' });
    expect(activePotionEffects(db, player.id, dayOne)).toMatchObject([{
      potionType: 'gold',
      state: 'armed',
      remainingGameMs: durationMs,
      snapshot: {
        kind: 'gold',
        durationMs,
        tokenUnit: 1_000,
        goldPerUnit: 50,
        baseCap: 125_000,
        stretchTokens: 2_500_000,
        stretchBonus: 25_000,
      },
    }]);

    setSetting(db, 'potion_gold_t1_gold_per_1000', '999');
    setSetting(db, 'potion_gold_t1_duration_s', '60');
    advanceCombatClock(db, 1_000, dayOne + 1_000, timeZone);
    expect(activePotionEffects(db, player.id, dayOne + 1_000)).toMatchObject([{
      state: 'active',
      remainingGameMs: durationMs - 1_000,
      snapshot: { kind: 'gold', durationMs, goldPerUnit: 50 },
    }]);

    db.prepare("UPDATE encounters SET status = 'defeated'").run();
    expect(activePotionEffects(db, player.id, dayOne + 2_000)).toMatchObject([{
      state: 'paused',
      remainingGameMs: durationMs - 1_000,
    }]);

    advanceCombatClock(db, durationMs - 1_000, dayOne + durationMs, timeZone);
    expect(completeExpiredPotions(db, dayOne + durationMs)).toBe(1);
    expect(activePotionEffects(db, player.id, dayOne + durationMs)).toEqual([]);
    expect(db.prepare(
      'SELECT status, completed_at FROM potion_activations WHERE request_id = ?',
    ).get('stateful')).toEqual({
      status: 'completed',
      completed_at: dayOne + durationMs,
    });
  });

  it('loads visible potion tiers for every player in one bulk snapshot', () => {
    const gold = playerWithGold();
    const damage = playerWithGold();
    buy(gold.id, 'potion_gold_t1', 1, 'bulk-gold-stock');
    buy(damage.id, 'potion_damage_t1', 1, 'bulk-damage-stock');
    seedActiveEncounter(gold.id, dayOne);
    expect(activate(gold.id, 'potion_gold_t1', 'bulk-gold')).toMatchObject({ ok: true });
    expect(activate(damage.id, 'potion_damage_t1', 'bulk-damage')).toMatchObject({ ok: true });

    expect([...visiblePotionTiersByPlayer(db, dayOne)]).toEqual([]);

    db.prepare('UPDATE game_state SET combat_active_ms=combat_active_ms+1000 WHERE id=1').run();
    let combatClockReads = 0;
    const countedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SELECT combat_active_ms FROM game_state')) combatClockReads += 1;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect([...visiblePotionTiersByPlayer(countedDb, dayOne + 1_000)]).toEqual([
      [gold.id, { goldTier: 1, damageTier: null }],
      [damage.id, { goldTier: null, damageTier: 1 }],
    ]);
    expect(combatClockReads).toBe(1);

    db.prepare('UPDATE encounters SET status=\'defeated\'').run();
    expect([...visiblePotionTiersByPlayer(db, dayOne + 2_000)]).toHaveLength(2);
  });

  it('snapshots Damage settings and ignores malformed stored snapshots in active reads', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_damage_t1', 1, 'damage-snapshot-stock');

    expect(activate(player.id, 'potion_damage_t1', 'damage-snapshot'))
      .toMatchObject({ ok: true, potionType: 'damage' });
    const row = db.prepare(
      'SELECT id, effect_snapshot FROM potion_activations WHERE request_id = ?',
    ).get('damage-snapshot') as { id: number; effect_snapshot: string };
    expect(JSON.parse(row.effect_snapshot)).toEqual({
      kind: 'damage',
      durationMs,
      baseHitMultiplier: 1.25,
    });

    db.prepare('UPDATE potion_activations SET effect_snapshot = ? WHERE id = ?')
      .run('{"kind":"damage","durationMs":"broken","baseHitMultiplier":99}', row.id);
    expect(activePotionEffects(db, player.id, dayOne)).toEqual([]);
  });

  it('ignores an activated Damage snapshot above the 11x operational ceiling', () => {
    const player = playerWithGold();
    buy(player.id, 'potion_damage_t1', 1, 'extreme-damage-stock');
    expect(activate(player.id, 'potion_damage_t1', 'extreme-damage'))
      .toMatchObject({ ok: true, potionType: 'damage' });
    db.prepare(
      `UPDATE potion_activations
       SET effect_snapshot=?
       WHERE request_id='extreme-damage'`,
    ).run(JSON.stringify({
      kind: 'damage',
      durationMs,
      baseHitMultiplier: 11.000_001,
    }));

    expect(damagePotionMultiplier(db, player.id)).toBeNull();
    expect(activePotionEffects(db, player.id, dayOne)).toEqual([]);
  });
});

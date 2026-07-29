import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { activatePotion } from '../src/domain/potions';
import {
  buildPotionLabReport,
  podiumMovement,
} from '../src/domain/potionlab';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';

const timeZone = 'America/New_York';
const reportNow = 100_000;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

type Player = ReturnType<typeof createPlayer>;

type QueryObservation = {
  method: 'all' | 'get';
  sql: string;
  args: unknown[];
  rowCount: number;
};

function observeQueries(database: typeof db): {
  observedDb: typeof db;
  observations: QueryObservation[];
} {
  const observations: QueryObservation[] = [];
  const observedDb = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'all' || statementProperty === 'get') {
                return (...args: unknown[]) => {
                  const result = statementTarget[statementProperty](
                    ...args as [],
                  );
                  observations.push({
                    method: statementProperty,
                    sql,
                    args,
                    rowCount: Array.isArray(result) ? result.length : (result ? 1 : 0),
                  });
                  return result;
                };
              }
              const value = Reflect.get(statementTarget, statementProperty);
              return typeof value === 'function'
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { observedDb, observations };
}

function fund(player: Player, amount = 1_000_000): void {
  expect(applyGoldMutation(db, {
    playerId: player.id,
    amount,
    reason: 'opening_balance',
    sourceTable: 'test',
    sourceId: `opening-${player.id}`,
    now: 100,
  })).toMatchObject({ status: 'applied' });
}

function buyAndActivate(
  player: Player,
  sku: 'potion_gold_t1' | 'potion_damage_t1',
  purchaseAt: number,
  activatedAt: number,
  request: string,
): { activationId: number; purchaseId: number } {
  const price = sku === 'potion_gold_t1' ? 100_000 : 150_000;
  const purchase = purchaseConsumable(db, {
    playerId: player.id,
    skuId: sku,
    quantity: 1,
    expectedUnitPrice: price,
    requestId: `${request}-purchase`,
    now: purchaseAt,
    timeZone,
  });
  expect(purchase).toMatchObject({ ok: true });
  if (!purchase.ok) throw new Error(`purchase fixture failed: ${purchase.reason}`);
  expect(activatePotion(db, {
    playerId: player.id,
    skuId: sku,
    requestId: `${request}-activation`,
    now: activatedAt,
    timeZone,
  })).toMatchObject({ ok: true });
  const activation = db.prepare(
    'SELECT id, purchase_id FROM potion_activations WHERE request_id=?',
  ).get(`${request}-activation`) as { id: number; purchase_id: number };
  return { activationId: activation.id, purchaseId: activation.purchase_id };
}

function encounter(
  dungeonId: number,
  startedAt: number,
  endedAt: number,
): number {
  const result = db.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at, ended_at,
       reward_model_version, reward_work_pct, reward_damage_pct,
       reward_podium_first_pct, reward_podium_second_pct, reward_podium_third_pct)
     VALUES (?, 0, 'single', 1, 1, 1, 1000, 0, 'defeated', ?, ?,
       'hybrid-v1', 80, 10, 5, 3, 2)`,
  ).run(dungeonId, startedAt, endedAt);
  return Number(result.lastInsertRowid);
}

function award(
  encounterId: number,
  player: Player,
  values: {
    damage: number;
    potionBonus: number;
    rank: number;
    work: number;
    damageGold: number;
    podium: number;
  },
  awardedAt: number,
): void {
  const total = values.work + values.damageGold + values.podium;
  db.prepare(
    `INSERT INTO encounter_reward_awards
      (encounter_id, player_id, effective_tokens, damage_total,
       potion_bonus_damage, damage_rank, work_gold, damage_gold,
       podium_gold, total_gold, model_version, awarded_at)
     VALUES (?, ?, 100, ?, ?, ?, ?, ?, ?, ?, 'hybrid-v1', ?)`,
  ).run(
    encounterId,
    player.id,
    values.damage,
    values.potionBonus,
    values.rank,
    values.work,
    values.damageGold,
    values.podium,
    total,
    awardedAt,
  );
  expect(applyGoldMutation(db, {
    playerId: player.id,
    amount: total,
    reason: 'encounter_reward',
    sourceTable: 'encounter_reward_awards',
    sourceId: `${encounterId}`,
    now: awardedAt,
  })).toMatchObject({ status: 'applied' });
}

function seedCanonicalAuditRows() {
  const goldUser = createPlayer(db, { name: 'Gold User', class_key: 'wizard', gender: 'F' }, 1);
  const boosted = createPlayer(db, { name: 'Boosted', class_key: 'knight', gender: 'M' }, 2);
  const rival = createPlayer(db, { name: 'Rival', class_key: 'thief', gender: 'F' }, 3);
  const third = createPlayer(db, { name: 'Third', class_key: 'ranger', gender: 'M' }, 4);
  [goldUser, boosted, rival, third].forEach((player) => fund(player));

  const gold = buyAndActivate(goldUser, 'potion_gold_t1', 1_000, 2_000, 'gold-one');
  db.prepare(
    `UPDATE potion_activations
     SET status='completed', completed_at=9_000, start_game_ms=0,
         expires_game_ms=7200000, eligible_tokens=2500000,
         base_gold=125000, stretch_gold=25000
     WHERE id=?`,
  ).run(gold.activationId);
  const tokenEvent = db.prepare(
    `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
     VALUES (?, 3000, 2500000, 2500000)`,
  ).run(goldUser.id);
  const work = db.prepare(
    `INSERT INTO potion_work_events
      (activation_id, token_event_id, effective_delta, base_gold,
       stretch_gold, combat_active_ms, created_at)
     VALUES (?, ?, 2500000, 125000, 25000, 7200000, 4000)`,
  ).run(gold.activationId, Number(tokenEvent.lastInsertRowid));
  const workId = String(work.lastInsertRowid);
  expect(applyGoldMutation(db, {
    playerId: goldUser.id, amount: 125_000, reason: 'gold_potion_base',
    sourceTable: 'potion_work_events', sourceId: workId, now: 4_000,
  })).toMatchObject({ status: 'applied' });
  expect(applyGoldMutation(db, {
    playerId: goldUser.id, amount: 25_000, reason: 'gold_potion_stretch',
    sourceTable: 'potion_work_events', sourceId: workId, now: 4_001,
  })).toMatchObject({ status: 'applied' });

  const damage = buyAndActivate(boosted, 'potion_damage_t1', 1_100, 2_100, 'damage-one');
  db.prepare(
    `UPDATE potion_activations
     SET status='completed', completed_at=9_500, start_game_ms=0,
         expires_game_ms=7200000, potion_bonus_damage=250
     WHERE id=?`,
  ).run(damage.activationId);

  const dungeon = db.prepare(
    `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
     VALUES (1, 'Ossuary Pale', 17, 2, 500)`,
  ).run();
  const encounterId = encounter(Number(dungeon.lastInsertRowid), 3_000, 8_000);
  db.prepare(
    `INSERT INTO potion_activation_encounters (activation_id, encounter_id, bonus_damage)
     VALUES (?, ?, 250)`,
  ).run(damage.activationId, encounterId);
  award(encounterId, boosted, {
    damage: 1000, potionBonus: 250, rank: 1,
    work: 267, damageGold: 50, podium: 50,
  }, 8_000);
  award(encounterId, rival, {
    damage: 900, potionBonus: 0, rank: 2,
    work: 267, damageGold: 45, podium: 30,
  }, 8_000);
  award(encounterId, third, {
    damage: 100, potionBonus: 0, rank: 3,
    work: 266, damageGold: 5, podium: 20,
  }, 8_000);

  db.prepare(
    `INSERT INTO monster_attacks (encounter_id, player_id, kind, gold_delta, ts)
     VALUES (?, ?, 'gold', 50, 8500)`,
  ).run(encounterId, goldUser.id);
  expect(applyGoldMutation(db, {
    playerId: goldUser.id, amount: -50, reason: 'monster_steal',
    sourceTable: 'monster_attacks', sourceId: '1', now: 8_500,
  })).toMatchObject({ status: 'applied' });
  db.prepare(
    `INSERT INTO game_clock_days (office_day, active_ms)
     VALUES ('2026-07-28', 7200000)`,
  ).run();
  db.prepare('UPDATE game_state SET combat_active_ms=7200000 WHERE id=1').run();

  return { goldUser, boosted, rival, third, gold, damage, encounterId, dungeonId: Number(dungeon.lastInsertRowid) };
}

function report(
  filters: Parameters<typeof buildPotionLabReport>[1] = {},
) {
  return buildPotionLabReport(db, filters, reportNow);
}

describe('Potion Lab report', () => {
  it('uses ordinary zeroes for an empty economy report', () => {
    const empty = report();
    const economy = empty.economy;
    expect(economy.potionGoldSpent).toBe(0);
    expect(economy.monsterGoldStolen).toBe(0);
    expect(economy.ledgerOutflow).toBe(0);
    expect(empty.gold.breakEvenRate).toBe(0);
    expect(empty.gold.stretchRate).toBe(0);
  });

  it('reports canonical Gold yield, Damage counterfactuals, and reconciled economy flow', () => {
    const fixture = seedCanonicalAuditRows();

    const result = report();

    expect(result.gold).toMatchObject({
      purchases: 1,
      completed: 1,
      spent: 100_000,
      basePayout: 125_000,
      stretchPayout: 25_000,
      breakEvenCount: 1,
      stretchCount: 1,
      breakEvenRate: 1,
      stretchRate: 1,
    });
    expect(result.gold.activations).toEqual([expect.objectContaining({
      activationId: fixture.gold.activationId,
      playerId: fixture.goldUser.id,
      purchasedAt: 1_000,
      activatedAt: 2_000,
      completedAt: 9_000,
      wallElapsedMs: 7_000,
      activeElapsedMs: 7_200_000,
      eligibleTokens: 2_500_000,
      basePayout: 125_000,
      stretchPayout: 25_000,
      payout: 150_000,
      purchasePrice: 100_000,
      netGold: 50_000,
    })]);
    expect(result.gold.byPlayer).toEqual([{
      playerId: fixture.goldUser.id,
      activations: 1,
      medianNetGold: 50_000,
    }]);
    expect(result.gold.byOfficeHour).toEqual([{
      hour: 19,
      activations: 1,
      medianNetGold: 50_000,
    }]);
    expect(result.damage.activations[0]).toMatchObject({
      activationId: fixture.damage.activationId,
      playerId: fixture.boosted.id,
      purchasedAt: 1_100,
      activatedAt: 2_100,
      completedAt: 9_500,
      startGameMs: 0,
      expiresGameMs: 7_200_000,
      wallElapsedMs: 7_400,
      activeElapsedMs: 7_200_000,
      actualDamage: 1_000,
      counterfactualDamage: 750,
      bonusDamage: 250,
      actualRank: 1,
      counterfactualRank: 2,
      actualReward: 367,
      counterfactualReward: 340,
      podiumEntries: 0,
      podiumClimbs: 1,
      purchasePrice: 150_000,
      netGold: -149_973,
    });
    expect(result.damage.activations[0].encounters).toEqual([
      expect.objectContaining({
        encounterId: fixture.encounterId,
        actualDamage: 1_000,
        counterfactualDamage: 750,
        bonusDamage: 250,
        actualRank: 1,
        counterfactualRank: 2,
        actualReward: 367,
        counterfactualReward: 340,
        podiumEntry: false,
        podiumClimb: 1,
        rewardSplit: '80/10/5/3/2',
      }),
    ]);
    expect(result.economy).toEqual({
      potionGoldSpent: 250_000,
      goldPotionMinted: 150_000,
      encounterGoldAwarded: 1_000,
      monsterGoldStolen: 50,
      ledgerInflow: 4_151_000,
      ledgerOutflow: 250_050,
      ledgerReconciled: true,
      stockPurchased: 2,
      dosesUsed: 2,
    });
    expect(result.readiness).toEqual({
      distinctCombatDays: 1,
      completedGold: 1,
      completedDamage: 1,
      distinctPlayers: 2,
      enoughCombatDays: false,
      enoughGoldActivations: false,
      enoughDamageActivations: false,
      enoughPlayers: false,
      readyForTier2Review: false,
    });
  });

  it('filters by activation date, player, and launch SKU while retaining unfinished rows', () => {
    const fixture = seedCanonicalAuditRows();
    const unfinished = createPlayer(db, { name: 'Unfinished', class_key: 'priest', gender: 'F' }, 10_000);
    fund(unfinished);
    buyAndActivate(unfinished, 'potion_gold_t1', 20_000, 21_000, 'unfinished-gold');

    const goldOnly = report({ sku: 'potion_gold_t1' });
    expect(goldOnly.gold.purchases).toBe(2);
    expect(goldOnly.gold.completed).toBe(1);
    expect(goldOnly.gold.activations).toHaveLength(2);
    expect(goldOnly.damage.activations).toEqual([]);

    const unfinishedOnly = report({ from: 20_000, playerId: unfinished.id });
    expect(unfinishedOnly.gold.activations).toEqual([
      expect.objectContaining({ playerId: unfinished.id, completedAt: null }),
    ]);
    expect(unfinishedOnly.gold.completed).toBe(0);

    const beforeDamage = report({ to: 2_050 });
    expect(beforeDamage.gold.activations).toHaveLength(1);
    expect(beforeDamage.damage.activations).toHaveLength(0);
    expect(report({ playerId: fixture.boosted.id }).gold.activations)
      .toEqual([]);
  });

  it('isolates one activation across shared and multiple encounters and records no-rank-change damage', () => {
    const fixture = seedCanonicalAuditRows();
    const second = buyAndActivate(
      fixture.rival,
      'potion_damage_t1',
      6_000,
      7_000,
      'damage-two',
    );
    db.prepare(
      `UPDATE potion_activations
       SET status='completed', completed_at=15000, potion_bonus_damage=100
       WHERE id=?`,
    ).run(second.activationId);
    db.prepare(
      `INSERT INTO potion_activation_encounters (activation_id, encounter_id, bonus_damage)
       VALUES (?, ?, 100)`,
    ).run(second.activationId, fixture.encounterId);
    db.prepare(
      `UPDATE encounter_reward_awards SET potion_bonus_damage=100
       WHERE encounter_id=? AND player_id=?`,
    ).run(fixture.encounterId, fixture.rival.id);
    db.prepare(
      `UPDATE potion_activations SET completed_at=19000
       WHERE id=?`,
    ).run(fixture.damage.activationId);

    const secondEncounter = encounter(fixture.dungeonId, 16_000, 18_000);
    db.prepare(
      `INSERT INTO potion_activation_encounters (activation_id, encounter_id, bonus_damage)
       VALUES (?, ?, 50)`,
    ).run(fixture.damage.activationId, secondEncounter);
    award(secondEncounter, fixture.boosted, {
      damage: 500, potionBonus: 50, rank: 2,
      work: 400, damageGold: 45, podium: 30,
    }, 18_000);
    award(secondEncounter, fixture.rival, {
      damage: 600, potionBonus: 0, rank: 1,
      work: 400, damageGold: 55, podium: 50,
    }, 18_000);

    const rows = report({ sku: 'potion_damage_t1' }).damage.activations;
    const first = rows.find((row) => row.activationId === fixture.damage.activationId)!;
    const noRankChange = rows.find((row) => row.activationId === second.activationId)!;
    expect(first).toMatchObject({ bonusDamage: 300, actualRank: 1, counterfactualRank: 2, podiumClimbs: 1 });
    expect(first.actualReward).toBe(842);
    expect(noRankChange).toMatchObject({
      bonusDamage: 100,
      actualRank: 2,
      counterfactualRank: 2,
      podiumClimbs: 0,
    });
  });

  it('marks reconciliation false when a player balance diverges from the canonical ledger', () => {
    const fixture = seedCanonicalAuditRows();
    db.prepare('UPDATE players SET gold=gold+1 WHERE id=?').run(fixture.goldUser.id);

    expect(report().economy.ledgerReconciled).toBe(false);
  });

  it('uses immutable work-event audit rows for Gold payout totals', () => {
    const fixture = seedCanonicalAuditRows();
    db.prepare(
      'UPDATE potion_activations SET base_gold=1, stretch_gold=2 WHERE id=?',
    ).run(fixture.gold.activationId);

    const result = report();
    expect(result.gold).toMatchObject({ basePayout: 125_000, stretchPayout: 25_000 });
    expect(result.gold.activations[0]).toMatchObject({
      basePayout: 125_000,
      stretchPayout: 25_000,
      payout: 150_000,
      netGold: 50_000,
    });
  });

  it('bounds filtered evidence queries on production-scale history and uses filter indexes', () => {
    const historical = createPlayer(
      db,
      { name: 'Historical', class_key: 'knight', gender: 'M' },
      1,
    );
    const selected = createPlayer(
      db,
      { name: 'Selected', class_key: 'wizard', gender: 'F' },
      2,
    );
    fund(historical, 1_000_000);
    fund(selected, 1_000_000);
    const dungeonId = Number(db.prepare(
      `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
       VALUES (1, 'Ossuary Pale', 1, 2, 1)`,
    ).run().lastInsertRowid);

    const insertPurchase = db.prepare(
      `INSERT INTO shop_purchases
        (player_id, sku, quantity, unit_price, total_price, office_day,
         request_id, inventory_after, gold_after, created_at)
       VALUES (?, 'potion_damage_t1', 1, 150000, 150000, '1970-01-01',
               ?, 0, 0, ?)`,
    );
    const insertActivation = db.prepare(
      `INSERT INTO potion_activations
        (player_id, sku, potion_type, tier, purchase_id, purchase_unit_price,
         request_id, activation_day, activated_at, start_game_ms,
         expires_game_ms, status, completed_at, effect_snapshot)
       VALUES (?, 'potion_damage_t1', 'damage', 1, ?, 150000, ?,
               '1970-01-01', ?, 0, 1, 'completed', ?, '{}')`,
    );
    const insertTokenEvent = db.prepare(
      `INSERT INTO token_events
        (player_id, ts, effective_delta, total_delta)
       VALUES (?, ?, 1, 1)`,
    );
    const insertWork = db.prepare(
      `INSERT INTO potion_work_events
        (activation_id, token_event_id, effective_delta, base_gold,
         stretch_gold, combat_active_ms, created_at)
       VALUES (?, ?, 1, 0, 0, 0, ?)`,
    );
    const insertEncounter = db.prepare(
      `INSERT INTO encounters
        (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
         pack_count, max_hp, current_hp, status, started_at, ended_at,
         reward_model_version, reward_work_pct, reward_damage_pct,
         reward_podium_first_pct, reward_podium_second_pct,
         reward_podium_third_pct)
       VALUES (?, ?, 'single', 1, 1, 1, 1, 0, 'defeated', ?, ?,
               'hybrid-v1', 80, 10, 5, 3, 2)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO potion_activation_encounters
        (activation_id, encounter_id, bonus_damage)
       VALUES (?, ?, 1)`,
    );
    const insertAward = db.prepare(
      `INSERT INTO encounter_reward_awards
        (encounter_id, player_id, effective_tokens, damage_total,
         potion_bonus_damage, damage_rank, work_gold, damage_gold,
         podium_gold, total_gold, model_version, awarded_at)
       VALUES (?, ?, 1, 1, 1, 1, 0, 0, 0, 0, 'hybrid-v1', ?)`,
    );
    const insertLedger = db.prepare(
      `INSERT INTO gold_ledger
        (player_id, amount, balance_after, reason, created_at)
       VALUES (?, 0, 1000000, 'historical_noop', ?)`,
    );

    db.transaction(() => {
      for (let index = 1; index <= 2_000; index += 1) {
        const purchaseId = Number(insertPurchase.run(
          historical.id,
          `historical-purchase-${index}`,
          index,
        ).lastInsertRowid);
        const activationId = Number(insertActivation.run(
          historical.id,
          purchaseId,
          `historical-activation-${index}`,
          index,
          index,
        ).lastInsertRowid);
        const tokenEventId = Number(insertTokenEvent.run(
          historical.id,
          index,
        ).lastInsertRowid);
        insertWork.run(activationId, tokenEventId, index);
        const encounterId = Number(insertEncounter.run(
          dungeonId,
          index,
          index,
          index,
        ).lastInsertRowid);
        insertLink.run(activationId, encounterId);
        insertAward.run(encounterId, historical.id, index);
        insertLedger.run(historical.id, index);
      }
    })();

    const selectedAt = 1_000_000;
    const selectedActivation = buyAndActivate(
      selected,
      'potion_gold_t1',
      selectedAt,
      selectedAt,
      'selected-gold',
    );
    const { observedDb, observations } = observeQueries(db);
    const result = buildPotionLabReport(observedDb, {
      from: selectedAt,
      to: selectedAt,
      playerId: selected.id,
      sku: 'potion_gold_t1',
      timeZone,
    }, selectedAt + 1);

    expect(result.gold.activations).toEqual([
      expect.objectContaining({ activationId: selectedActivation.activationId }),
    ]);
    expect(result.damage.activations).toEqual([]);

    for (const table of [
      'potion_activations',
      'shop_purchases',
      'potion_work_events',
      'potion_activation_encounters',
      'encounter_reward_awards',
      'encounters',
      'gold_ledger',
    ]) {
      const materialized = observations
        .filter((query) => (
          query.method === 'all'
          && query.sql.includes(`FROM ${table}`)
        ))
        .reduce((max, query) => Math.max(max, query.rowCount), 0);
      expect(materialized, table).toBeLessThanOrEqual(1);
    }

    const planFor = (fragment: string): string => {
      const query = observations.find((entry) => entry.sql.includes(fragment));
      expect(query, fragment).toBeDefined();
      return (db.prepare(`EXPLAIN QUERY PLAN ${query!.sql}`).all(
        ...query!.args as [],
      ) as { detail: string }[]).map((row) => row.detail).join('\n');
    };
    expect(planFor('FROM potion_activations pa'))
      .toMatch(/idx_potion_lab_activations_(player|sku)_activated/);
    expect(planFor('FROM shop_purchases'))
      .toMatch(/idx_potion_lab_purchases_(player|sku)_created/);
    expect(planFor('FROM gold_ledger'))
      .toContain('idx_potion_lab_ledger_player_created');
  });

  it.each([
    ['off-podium improvement', 5, 8, { podiumEntries: 0, podiumClimbs: 0 }],
    ['podium entry', 3, 4, { podiumEntries: 1, podiumClimbs: 0 }],
    ['within-podium climb', 1, 3, { podiumEntries: 0, podiumClimbs: 2 }],
  ])('classifies %s using podium-only movement', (_label, actual, counterfactual, expected) => {
    expect(podiumMovement(actual, counterfactual)).toEqual(expected);
  });

  it('opens the evidence gate only at 14 days, 30 completed runs per type, and 5 players', () => {
    for (let day = 1; day <= 14; day += 1) {
      db.prepare(
        'INSERT INTO game_clock_days (office_day, active_ms) VALUES (?, 1)',
      ).run(`2026-07-${String(day).padStart(2, '0')}`);
    }
    for (let playerIndex = 0; playerIndex < 5; playerIndex += 1) {
      const player = createPlayer(db, {
        name: `Evidence ${playerIndex}`,
        class_key: 'knight',
        gender: playerIndex % 2 === 0 ? 'M' : 'F',
      }, 100 + playerIndex);
      fund(player, 2_000_000);
      for (const [sku, potionType, price] of [
        ['potion_gold_t1', 'gold', 100_000],
        ['potion_damage_t1', 'damage', 150_000],
      ] as const) {
        const purchase = purchaseConsumable(db, {
          playerId: player.id,
          skuId: sku,
          quantity: 1,
          expectedUnitPrice: price,
          requestId: `evidence-purchase-${player.id}-${potionType}`,
          now: 1_000 + player.id,
          timeZone,
        });
        expect(purchase).toMatchObject({ ok: true });
        if (!purchase.ok) throw new Error(`evidence purchase failed: ${purchase.reason}`);
        for (let run = 0; run < 6; run += 1) {
          db.prepare(
            `INSERT INTO potion_activations
              (player_id, sku, potion_type, tier, purchase_id,
               purchase_unit_price, request_id, activation_day, activated_at,
               start_game_ms, expires_game_ms, status, completed_at, effect_snapshot)
             VALUES (?, ?, ?, 1, ?, ?, ?, '2026-07-01', ?, 0, 1,
               'completed', ?, '{}')`,
          ).run(
            player.id,
            sku,
            potionType,
            purchase.purchaseId,
            price,
            `evidence-${player.id}-${potionType}-${run}`,
            2_000 + run,
            3_000 + run,
          );
        }
      }
    }

    expect(report().readiness).toEqual({
      distinctCombatDays: 14,
      completedGold: 30,
      completedDamage: 30,
      distinctPlayers: 5,
      enoughCombatDays: true,
      enoughGoldActivations: true,
      enoughDamageActivations: true,
      enoughPlayers: true,
      readyForTier2Review: true,
    });

    const rollback = Symbol('rollback readiness fixture');
    const belowThreshold = (mutate: () => void) => {
      let captured: ReturnType<typeof buildPotionLabReport>['readiness'] | undefined;
      try {
        db.transaction(() => {
          mutate();
          captured = report().readiness;
          throw rollback;
        })();
      } catch (error) {
        if (error !== rollback) throw error;
      }
      if (!captured) throw new Error('threshold transaction did not build a report');
      return captured;
    };
    expect(belowThreshold(() => {
      db.prepare("DELETE FROM game_clock_days WHERE office_day='2026-07-14'").run();
    })).toMatchObject({ distinctCombatDays: 13, enoughCombatDays: false, readyForTier2Review: false });
    expect(belowThreshold(() => {
      db.prepare("DELETE FROM potion_activations WHERE potion_type='gold' AND id=(SELECT MAX(id) FROM potion_activations WHERE potion_type='gold')").run();
    })).toMatchObject({ completedGold: 29, enoughGoldActivations: false, readyForTier2Review: false });
    expect(belowThreshold(() => {
      db.prepare("DELETE FROM potion_activations WHERE potion_type='damage' AND id=(SELECT MAX(id) FROM potion_activations WHERE potion_type='damage')").run();
    })).toMatchObject({ completedDamage: 29, enoughDamageActivations: false, readyForTier2Review: false });
    expect(belowThreshold(() => {
      const ids = db.prepare('SELECT MIN(id) AS first, MAX(id) AS last FROM players').get() as { first: number; last: number };
      db.prepare('UPDATE potion_activations SET player_id=? WHERE player_id=?').run(ids.first, ids.last);
    })).toMatchObject({ distinctPlayers: 4, enoughPlayers: false, readyForTier2Review: false });
  });
});

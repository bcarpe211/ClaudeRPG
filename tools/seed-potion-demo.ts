import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { advanceCombatClock } from '../src/domain/gameclock';
import { purchaseConsumable } from '../src/domain/inventory';
import { ingestTokenUsage } from '../src/domain/ingest';
import { officeDayKey } from '../src/domain/office-time';
import { activatePotion } from '../src/domain/potions';
import { seedSettings, setSetting } from '../src/domain/settings';

const TIME_ZONE = 'America/New_York';
const GOLD_SKU = 'potion_gold_t1';
const DAMAGE_SKU = 'potion_damage_t1';
const ARMED_REVIEW_MARKER_KEY = 'potion_demo_armed_review_marker';
const ARMED_REVIEW_MARKER_VALUE = 'timed-consumables-armed-review-v1';

export type PotionDemoState =
  | 'gold-only'
  | 'damage-only'
  | 'dual-potion'
  | 'debuff-only'
  | 'potion-plus-debuff'
  | 'control';

export interface PotionDemoResult {
  players: Array<{
    id: number;
    name: string;
    gender: 'M' | 'F';
    state: PotionDemoState;
    characterUrl: string;
  }>;
  tvUrl: string;
}

export interface PotionDemoSeedOptions {
  /** Keep the local encounter idle so a reviewer can drink an Armed potion. */
  startPaused?: boolean;
}

const CAST: Array<{
  name: string;
  classKey: string;
  gender: 'M' | 'F';
  state: PotionDemoState;
  potions: readonly (typeof GOLD_SKU | typeof DAMAGE_SKU)[];
  historicalPotions?: readonly (typeof GOLD_SKU | typeof DAMAGE_SKU)[];
  inventoryOnlyPotions?: readonly (typeof GOLD_SKU | typeof DAMAGE_SKU)[];
  debuffed?: boolean;
}> = [
  {
    name: 'Gilded Knight', classKey: 'knight', gender: 'M', state: 'gold-only',
    potions: [GOLD_SKU], historicalPotions: [GOLD_SKU],
  },
  {
    name: 'Scarlet Thief', classKey: 'thief', gender: 'M', state: 'damage-only',
    potions: [DAMAGE_SKU], historicalPotions: [DAMAGE_SKU],
  },
  { name: 'Twinbrew Ranger', classKey: 'ranger', gender: 'F', state: 'dual-potion', potions: [GOLD_SKU, DAMAGE_SKU] },
  { name: 'Hexed Wizard', classKey: 'wizard', gender: 'M', state: 'debuff-only', potions: [], debuffed: true },
  { name: 'Cursed Priest', classKey: 'priest', gender: 'F', state: 'potion-plus-debuff', potions: [DAMAGE_SKU], debuffed: true },
  { name: 'Golden Shaman', classKey: 'shaman', gender: 'F', state: 'gold-only', potions: [GOLD_SKU] },
  {
    name: 'Quiet Berserker', classKey: 'berserker', gender: 'M', state: 'control',
    potions: [], inventoryOnlyPotions: [GOLD_SKU],
  },
  { name: 'Quiet Paladin', classKey: 'paladin', gender: 'F', state: 'control', potions: [] },
];

function assertEmptyDemoDatabase(db: Database.Database): void {
  const row = db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM players)
      + (SELECT COUNT(*) FROM dungeons)
      + (SELECT COUNT(*) FROM shop_purchases) AS count`,
  ).get() as { count: number };
  if (row.count !== 0) throw new Error('Potion demo requires a fresh empty database');
}

function mustSucceed<T extends { ok: boolean }>(result: T, action: string): asserts result is T & { ok: true } {
  if (!result.ok) throw new Error(`Potion demo ${action} failed: ${JSON.stringify(result)}`);
}

function applyDemoGold(
  db: Database.Database,
  input: Parameters<typeof applyGoldMutation>[1],
  action: string,
): void {
  const result = applyGoldMutation(db, input);
  if (result.status !== 'applied') {
    throw new Error(`Potion demo ${action} failed: ${result.status}`);
  }
}

function demoTokenUsagePayload(token: string, input: number): unknown {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
      scopeMetrics: [{
        metrics: [{
          name: 'claude_code.token.usage',
          sum: {
            aggregationTemporality: 1,
            dataPoints: [{
              asInt: String(input),
              startTimeUnixNano: 'potion-demo-history',
              timeUnixNano: 'potion-demo-history-work',
              attributes: [{ key: 'type', value: { stringValue: 'input' } }],
            }],
          },
        }],
      }],
    }],
  };
}

export function seedPotionDemo(
  db: Database.Database,
  now: number,
  baseUrl = 'http://localhost:8115',
  options: PotionDemoSeedOptions = {},
): PotionDemoResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('now must be a non-negative safe integer');
  assertEmptyDemoDatabase(db);
  seedSettings(db);
  // Keep visual-review debuffs alive for the same two-hour active-time window as
  // the launch potions. This changes only the isolated demo database.
  setSetting(db, 'monster_debuff_seconds', '7200');

  const dungeon = db.prepare(
    `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
     VALUES (12, 'Ossuary Pale', 424242, 3, ?)`,
  ).run(now - 60_000);
  const encounter = db.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at,
       reward_model_version, reward_work_pct, reward_damage_pct,
       reward_podium_first_pct, reward_podium_second_pct, reward_podium_third_pct)
     VALUES (?, 1, 'boss', 35, 2, 1, 500000000, 499000000, 'active', ?,
       'hybrid-v1', 80, 10, 5, 3, 2)`,
  ).run(Number(dungeon.lastInsertRowid), now - 50_000);
  const dungeonId = Number(dungeon.lastInsertRowid);
  const encounterId = Number(encounter.lastInsertRowid);
  db.prepare(
    `UPDATE game_state
     SET current_dungeon_id=?, current_encounter_id=?, paused=0,
         last_activity_at=?, defeat_until=NULL, combat_active_ms=60000
     WHERE id=1`,
  ).run(dungeonId, encounterId, now);
  db.prepare(
    `INSERT INTO game_clock_days (office_day, active_ms)
     VALUES (?, 60000)`,
  ).run(officeDayKey(now, TIME_ZONE));

  const historical = new Map<typeof GOLD_SKU | typeof DAMAGE_SKU, {
    activationId: number;
    playerId: number;
  }>();
  const seeded = CAST.map((member, index) => {
    const authToken = `local-potion-demo-${index + 1}`;
    const inserted = db.prepare(
      `INSERT INTO players (name, class_key, gender, auth_token, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(member.name, member.classKey, member.gender, authToken, now - 40_000 + index);
    const player = { id: Number(inserted.lastInsertRowid) };
    const tokens = 500_000 - index * 35_000;
    db.prepare(
      `UPDATE players
       SET level=?, total_tokens=?, effective_tokens=?,
           peak_modifier=?, last_token_at=?
       WHERE id=?`,
    ).run(10 - Math.floor(index / 2), tokens, tokens, 2.5 - index * 0.15, now, player.id);
    db.prepare(
      `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
       VALUES (?, ?, ?, ?)`,
    ).run(player.id, now - 30_000 + index, tokens, tokens);
    if (index === 2) {
      db.prepare(
        `INSERT INTO player_cosmetics (player_id, wheel_tier, updated_at)
         VALUES (?, 3, ?)`,
      ).run(player.id, now - 25_000);
    }
    const opening = applyGoldMutation(db, {
      playerId: player.id,
      amount: 4_000_000,
      reason: 'opening_balance',
      sourceTable: 'potion_demo',
      sourceId: `${player.id}`,
      now: now - 35_000 + index,
    });
    if (opening.status !== 'applied') {
      throw new Error(`Potion demo opening balance for ${member.name} failed: ${opening.status}`);
    }

    const purchasablePotions = [...new Set([
      ...member.potions,
      ...(member.historicalPotions ?? []),
      ...(member.inventoryOnlyPotions ?? []),
    ])];
    for (const sku of purchasablePotions) {
      const price = sku === GOLD_SKU ? 100_000 : 150_000;
      const purchase = purchaseConsumable(db, {
        playerId: player.id,
        skuId: sku,
        quantity: member.potions.includes(sku) ? 3 : 1,
        expectedUnitPrice: price,
        requestId: `demo-buy-${player.id}-${sku}`,
        now: now - 20_000 + index,
        timeZone: TIME_ZONE,
      });
      mustSucceed(purchase, `purchase for ${member.name}`);
    }
    for (const sku of member.historicalPotions ?? []) {
      const activation = activatePotion(db, {
        playerId: player.id,
        skuId: sku,
        requestId: `demo-history-drink-${player.id}-${sku}`,
        now: now - 19_000 + index,
        timeZone: TIME_ZONE,
      });
      mustSucceed(activation, `historical activation for ${member.name}`);
      if (sku === GOLD_SKU) {
        const ingestion = ingestTokenUsage(
          db,
          demoTokenUsagePayload(authToken, 2_500_000),
          now - 18_000 + index,
          { cacheReadWeight: 0 },
        );
        if (ingestion.appliedPlayers !== 1 || ingestion.ignoredUnknownTokens !== 0) {
          throw new Error('Potion demo historical Gold work ingestion failed');
        }
      }
      historical.set(sku, { activationId: activation.activationId, playerId: player.id });
      db.prepare(
        `UPDATE potion_activations
         SET status='completed', completed_at=?
         WHERE id=?`,
      ).run(now - 17_000 + index * 500, activation.activationId);
    }
    for (const sku of member.potions) {
      const activation = activatePotion(db, {
        playerId: player.id,
        skuId: sku,
        requestId: `demo-drink-${player.id}-${sku}`,
        now: now - 10_000 + index,
        timeZone: TIME_ZONE,
      });
      mustSucceed(activation, `activation for ${member.name}`);
    }

    db.prepare(
      `INSERT INTO encounter_damage
        (encounter_id, player_id, damage_total, hits, max_hit, potion_bonus_damage)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      encounterId,
      player.id,
      130_000 - index * 11_000,
      30 - index,
      9_000 - index * 400,
      member.potions.includes(DAMAGE_SKU) ? 8_000 : 0,
    );
    if (member.debuffed) {
      db.prepare(
        `INSERT INTO monster_attacks (encounter_id, player_id, kind, gold_delta, ts)
         VALUES (?, ?, 'debuff', 0, ?)`,
      ).run(encounterId, player.id, now - 1_000 + index);
    }
    return { player, authToken };
  });

  const goldHistory = historical.get(GOLD_SKU);
  const damageHistory = historical.get(DAMAGE_SKU);
  if (!goldHistory || !damageHistory) {
    throw new Error('Potion demo historical audit activations are missing');
  }
  db.prepare(
    `UPDATE potion_activations
     SET start_game_ms=0, expires_game_ms=7200000, completed_at=?
     WHERE id=?`,
  ).run(now - 17_000, goldHistory.activationId);
  db.prepare(
    `UPDATE potion_activations
     SET start_game_ms=0, expires_game_ms=7200000, completed_at=?, potion_bonus_damage=250
     WHERE id=?`,
  ).run(now - 16_500, damageHistory.activationId);

  const historicalEncounter = db.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at, ended_at,
       reward_model_version, reward_work_pct, reward_damage_pct,
       reward_podium_first_pct, reward_podium_second_pct, reward_podium_third_pct)
     VALUES (?, 0, 'single', 1, 1, 1, 1000, 0, 'defeated', ?, ?,
       'hybrid-v1', 80, 10, 5, 3, 2)`,
  ).run(dungeonId, now - 18_500, now - 17_500);
  const historicalEncounterId = Number(historicalEncounter.lastInsertRowid);
  db.prepare(
    `INSERT INTO potion_activation_encounters (activation_id, encounter_id, bonus_damage)
     VALUES (?, ?, 250)`,
  ).run(damageHistory.activationId, historicalEncounterId);
  const insertAward = db.prepare(
    `INSERT INTO encounter_reward_awards
      (encounter_id, player_id, effective_tokens, damage_total,
       potion_bonus_damage, damage_rank, work_gold, damage_gold,
       podium_gold, total_gold, model_version, awarded_at)
     VALUES (?, ?, 100, ?, ?, ?, ?, ?, ?, ?, 'hybrid-v1', ?)`,
  );
  const historicalAwards = [
    { playerId: damageHistory.playerId, damage: 1_000, bonus: 250, rank: 1, work: 267, damageGold: 50, podium: 50 },
    { playerId: seeded[0].player.id, damage: 900, bonus: 0, rank: 2, work: 267, damageGold: 45, podium: 30 },
    { playerId: seeded[2].player.id, damage: 100, bonus: 0, rank: 3, work: 266, damageGold: 5, podium: 20 },
  ];
  for (const award of historicalAwards) {
    const total = award.work + award.damageGold + award.podium;
    insertAward.run(
      historicalEncounterId, award.playerId, award.damage, award.bonus, award.rank,
      award.work, award.damageGold, award.podium, total, now - 8_000,
    );
    applyDemoGold(db, {
      playerId: award.playerId,
      amount: total,
      reason: 'encounter_reward',
      sourceTable: 'encounter_reward_awards',
      sourceId: String(historicalEncounterId),
      now: now - 8_000,
    }, 'historical encounter reward');
  }

  // Move every armed potion into its visible active state without consuming any
  // wall-clock-only time. The running server advances from this deterministic point.
  if (options.startPaused) {
    const pausedAt = now - 60 * 60_000;
    db.prepare(
      'UPDATE game_state SET paused=1, last_activity_at=? WHERE id=1',
    ).run(pausedAt);
    db.prepare('UPDATE players SET last_token_at=?').run(pausedAt);
    setSetting(db, ARMED_REVIEW_MARKER_KEY, ARMED_REVIEW_MARKER_VALUE);
  } else {
    db.prepare('UPDATE game_state SET combat_active_ms=105000 WHERE id=1').run();
  }

  const normalizedBase = baseUrl.replace(/\/$/, '');
  return {
    players: seeded.map(({ player, authToken }, index) => ({
      id: player.id,
      name: CAST[index].name,
      gender: CAST[index].gender,
      state: CAST[index].state,
      characterUrl: `${normalizedBase}/character?token=${encodeURIComponent(authToken)}`,
    })),
    tvUrl: `${normalizedBase}/tv`,
  };
}

function assertArmedReviewMarker(db: Database.Database): void {
  const marker = db.prepare('SELECT value FROM settings WHERE key=?')
    .get(ARMED_REVIEW_MARKER_KEY) as { value: string } | undefined;
  if (marker?.value !== ARMED_REVIEW_MARKER_VALUE) {
    throw new Error('Refusing to resume a database without the Armed-review fixture marker');
  }
}

function assertPotionDemoCast(db: Database.Database): void {
  const names = (db.prepare('SELECT name FROM players ORDER BY name').all() as { name: string }[])
    .map((row) => row.name);
  const expected = CAST.map((member) => member.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error('Refusing to resume a database that is not the potion demo cast');
  }
}

/** Advance the isolated Armed-review fixture by one active millisecond. */
export function resumePotionDemoCombat(db: Database.Database, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('now must be a non-negative safe integer');
  assertArmedReviewMarker(db);
  assertPotionDemoCast(db);
  const reviewer = db.prepare('SELECT id FROM players WHERE name=?').get('Quiet Berserker') as { id: number } | undefined;
  if (!reviewer) throw new Error('Potion demo Armed-review player is missing');
  db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(now, reviewer.id);
  db.prepare('UPDATE game_state SET paused=0, last_activity_at=? WHERE id=1').run(now);
  advanceCombatClock(db, 1, now, TIME_ZONE);
}

export function validateDemoDbPath(target: string, productionPath: string): string {
  if (!target || target === ':memory:') throw new Error('Pass an explicit local database path');
  const resolved = path.resolve(target);
  if (resolved === path.resolve(productionPath)) {
    throw new Error('Refusing to seed the configured production database path');
  }
  for (const candidate of [resolved, `${resolved}-wal`, `${resolved}-shm`]) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) throw new Error('Potion demo database path must be a file');
    if (stat.size > 0) throw new Error('Potion demo database path must be new or empty');
  }
  return resolved;
}

function validateExistingDemoDbPath(target: string, productionPath: string): string {
  if (!target || target === ':memory:') throw new Error('Pass an explicit local database path');
  const resolved = path.resolve(target);
  if (resolved === path.resolve(productionPath)) {
    throw new Error('Refusing to resume the configured production database path');
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory() || fs.statSync(resolved).size === 0) {
    throw new Error('Potion demo resume requires an existing local database file');
  }
  return resolved;
}

function validateArmedReviewFixturePath(target: string, productionPath: string): string {
  const resolved = validateExistingDemoDbPath(target, productionPath);
  let db: Database.Database | undefined;
  try {
    db = new SqliteDatabase(resolved, { readonly: true, fileMustExist: true });
    assertArmedReviewMarker(db);
    assertPotionDemoCast(db);
  } catch {
    throw new Error('Potion demo resume requires a dedicated Armed-review fixture');
  } finally {
    db?.close();
  }
  return resolved;
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const config = loadConfig(process.env);
  const armedReview = argv[0] === '--armed-review';
  const resume = argv[0] === '--resume';
  const target = resume
    ? validateArmedReviewFixturePath(argv[1] ?? '', config.dbPath)
    : validateDemoDbPath(argv[armedReview ? 1 : 0] ?? '', config.dbPath);
  const db = openDb(target);
  try {
    if (resume) {
      resumePotionDemoCombat(db, Date.now());
      console.log('Local potion demo combat resumed. Refresh the Armed-review character page.');
      return;
    }
    const result = seedPotionDemo(db, Date.now(), config.publicUrl, { startPaused: armedReview });
    console.log('Character URLs:');
    for (const player of result.players) console.log(`${player.name}: ${player.characterUrl}`);
    console.log(`TV: ${result.tvUrl}`);
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

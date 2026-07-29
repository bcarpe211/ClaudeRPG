import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { officeDayKey } from '../src/domain/office-time';
import { activatePotion } from '../src/domain/potions';
import { seedSettings, setSetting } from '../src/domain/settings';

const TIME_ZONE = 'America/New_York';
const GOLD_SKU = 'potion_gold_t1';
const DAMAGE_SKU = 'potion_damage_t1';

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

const CAST: Array<{
  name: string;
  classKey: string;
  gender: 'M' | 'F';
  state: PotionDemoState;
  potions: readonly (typeof GOLD_SKU | typeof DAMAGE_SKU)[];
  debuffed?: boolean;
}> = [
  { name: 'Gilded Knight', classKey: 'knight', gender: 'M', state: 'gold-only', potions: [GOLD_SKU] },
  { name: 'Scarlet Thief', classKey: 'thief', gender: 'M', state: 'damage-only', potions: [DAMAGE_SKU] },
  { name: 'Twinbrew Ranger', classKey: 'ranger', gender: 'F', state: 'dual-potion', potions: [GOLD_SKU, DAMAGE_SKU] },
  { name: 'Hexed Wizard', classKey: 'wizard', gender: 'M', state: 'debuff-only', potions: [], debuffed: true },
  { name: 'Cursed Priest', classKey: 'priest', gender: 'F', state: 'potion-plus-debuff', potions: [DAMAGE_SKU], debuffed: true },
  { name: 'Golden Shaman', classKey: 'shaman', gender: 'F', state: 'gold-only', potions: [GOLD_SKU] },
  { name: 'Quiet Berserker', classKey: 'berserker', gender: 'M', state: 'control', potions: [] },
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

export function seedPotionDemo(
  db: Database.Database,
  now: number,
  baseUrl = 'http://localhost:8115',
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

    for (const sku of member.potions) {
      const price = sku === GOLD_SKU ? 100_000 : 150_000;
      const purchase = purchaseConsumable(db, {
        playerId: player.id,
        skuId: sku,
        quantity: 2,
        expectedUnitPrice: price,
        requestId: `demo-buy-${player.id}-${sku}`,
        now: now - 20_000 + index,
        timeZone: TIME_ZONE,
      });
      mustSucceed(purchase, `purchase for ${member.name}`);
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

  // Move every armed potion into its visible active state without consuming any
  // wall-clock-only time. The running server advances from this deterministic point.
  db.prepare('UPDATE game_state SET combat_active_ms=105000 WHERE id=1').run();

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

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const config = loadConfig(process.env);
  const target = validateDemoDbPath(argv[0] ?? '', config.dbPath);
  const db = openDb(target);
  try {
    const result = seedPotionDemo(db, Date.now(), config.publicUrl);
    console.log('Character URLs:');
    for (const player of result.players) console.log(`${player.name}: ${player.characterUrl}`);
    console.log(`TV: ${result.tvUrl}`);
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

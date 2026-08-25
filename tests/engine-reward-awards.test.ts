import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { buildDefeatSummary, GameEngine } from '../src/domain/engine';
import { applyGoldMutation } from '../src/domain/goldledger';
import { ingestTokenUsage } from '../src/domain/ingest';
import { purchaseConsumable } from '../src/domain/inventory';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { activatePotion } from '../src/domain/potions';
import { seedSettings, setSetting } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  setSetting(db, 'min_encounter_hp', '1');
  setSetting(db, 'baseline_battle_minutes', '0');
  setSetting(db, 'gold_factor', '101');
  setSetting(db, 'attack_interval_ms', '1000');
  setSetting(db, 'attack_jitter_ms', '0');
});

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

function killOnNextAttack(engine: GameEngine, encounterId: number, now: number): void {
  engine.tick(now + 1000);
  expect(db.prepare('SELECT status FROM encounters WHERE id=?').get(encounterId))
    .toEqual({ status: 'defeated' });
}

describe('versioned encounter reward awards', () => {
  it('stores the killed encounter Damage counterfactual without changing the gold pool', () => {
    const player = createPlayer(
      db,
      { name: 'Damage Award', class_key: 'knight', gender: 'M' },
      1,
    );
    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?').run(100_000, player.id);
    applyGoldMutation(db, {
      playerId: player.id,
      amount: 150_000,
      reason: 'opening_balance',
      sourceTable: 'test_players',
      sourceId: `${player.id}`,
      now: 99_000,
    });
    expect(purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_damage_t1',
      quantity: 1,
      expectedUnitPrice: 150_000,
      requestId: 'buy-damage-award',
      now: 99_000,
      timeZone: 'America/New_York',
    })).toMatchObject({ ok: true });
    const engine = new GameEngine(db, { rng: () => 0.5 });
    engine.tick(100_000);
    const active = db.prepare(
      "SELECT * FROM encounters WHERE status = 'active'",
    ).get() as any;
    expect(activatePotion(db, {
      playerId: player.id,
      skuId: 'potion_damage_t1',
      requestId: 'drink-damage-award',
      now: 100_000,
      timeZone: 'America/New_York',
    })).toMatchObject({ ok: true, potionType: 'damage' });

    killOnNextAttack(engine, active.id, 100_000);

    const damage = db.prepare(
      `SELECT damage_total, potion_bonus_damage
       FROM encounter_damage WHERE encounter_id = ? AND player_id = ?`,
    ).get(active.id, player.id) as { damage_total: number; potion_bonus_damage: number };
    const award = db.prepare(
      `SELECT damage_total, potion_bonus_damage, total_gold
       FROM encounter_reward_awards WHERE encounter_id = ? AND player_id = ?`,
    ).get(active.id, player.id) as {
      damage_total: number;
      potion_bonus_damage: number;
      total_gold: number;
    };
    expect(damage).toEqual({ damage_total: 125, potion_bonus_damage: 25 });
    expect(award.damage_total).toBe(damage.damage_total);
    expect(award.potion_bonus_damage).toBe(damage.potion_bonus_damage);
    expect(award.total_gold).toBe(Math.round(active.max_hp * 101));
  });

  it('snapshots hybrid-v1 settings and stores exact component awards through the ledger', () => {
    const first = createPlayer(db, { name: 'First', class_key: 'knight', gender: 'M' }, 1);
    const second = createPlayer(db, { name: 'Second', class_key: 'wizard', gender: 'F' }, 1);
    ingestTokenUsage(db, tokens(first.auth_token, 800), 100000, { cacheReadWeight: 0 });
    ingestTokenUsage(db, tokens(second.auth_token, 200), 100000, { cacheReadWeight: 0 });

    const engine = new GameEngine(db, { rng: () => 0.5 });
    engine.tick(100000);
    const active = db.prepare("SELECT * FROM encounters WHERE status='active'").get() as any;
    expect(active.reward_model_version).toBe('hybrid-v1');
    expect(active.reward_work_pct).toBe(80);
    expect(active.reward_podium_third_pct).toBe(2);
    expect(active.reward_gold_pool).toBe(Math.round(active.max_hp * 101));

    setSetting(db, 'reward_work_pct', '70');
    setSetting(db, 'reward_damage_pct', '20');
    setSetting(db, 'gold_factor', '9999');
    killOnNextAttack(engine, active.id, 100000);

    const goldPool = active.reward_gold_pool;
    const stored = db.prepare(
      'SELECT * FROM encounter_reward_awards WHERE encounter_id=? ORDER BY damage_rank',
    ).all(active.id) as any[];
    expect(stored.reduce((sum, row) => sum + row.total_gold, 0)).toBe(goldPool);
    expect(stored.every((row) => row.model_version === 'hybrid-v1')).toBe(true);
    expect(stored.every((row) =>
      row.work_gold + row.damage_gold + row.podium_gold === row.total_gold)).toBe(true);
    expect(stored.every((row) => row.potion_bonus_damage === 0)).toBe(true);

    const ledger = db.prepare(
      `SELECT source_table, source_id FROM gold_ledger
       WHERE reason='encounter_reward' ORDER BY player_id`,
    ).all() as { source_table: string; source_id: string }[];
    expect(ledger).toEqual([
      { source_table: 'encounter_reward_awards', source_id: String(active.id) },
      { source_table: 'encounter_reward_awards', source_id: String(active.id) },
    ]);
  });

  it('allocates the snapshotted pool across token-only and damage-only participants', () => {
    const tokenOnly = createPlayer(
      db,
      { name: 'Token Only', class_key: 'wizard', gender: 'F' },
      1,
    );
    const damageOnly = createPlayer(
      db,
      { name: 'Damage Only', class_key: 'knight', gender: 'M' },
      1,
    );
    ingestTokenUsage(db, tokens(tokenOnly.auth_token, 800), 100_000, {
      cacheReadWeight: 0,
    });
    db.prepare('UPDATE players SET disabled=1 WHERE id=?').run(tokenOnly.id);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?')
      .run(100_000, damageOnly.id);

    const engine = new GameEngine(db, { rng: () => 0.5 });
    engine.tick(100_000);
    const active = db.prepare(
      "SELECT * FROM encounters WHERE status='active'",
    ).get() as any;
    killOnNextAttack(engine, active.id, 100_000);

    const awards = db.prepare(
      `SELECT player_id, effective_tokens, damage_total, potion_bonus_damage,
              work_gold, total_gold
       FROM encounter_reward_awards
       WHERE encounter_id=?
       ORDER BY player_id`,
    ).all(active.id) as Array<{
      player_id: number;
      effective_tokens: number;
      damage_total: number;
      potion_bonus_damage: number;
      work_gold: number;
      total_gold: number;
    }>;
    expect(awards).toHaveLength(2);
    expect(awards.reduce((sum, award) => sum + award.total_gold, 0))
      .toBe(active.reward_gold_pool);
    expect(awards.find((award) => award.player_id === tokenOnly.id))
      .toMatchObject({
        effective_tokens: 800,
        damage_total: 0,
        potion_bonus_damage: 0,
      });
    expect(awards.find((award) => award.player_id === tokenOnly.id)?.work_gold)
      .toBeGreaterThan(0);
    expect(awards.find((award) => award.player_id === damageOnly.id))
      .toMatchObject({
        effective_tokens: 0,
        damage_total: 100,
        potion_bonus_damage: 0,
        work_gold: 0,
      });

    const summary = buildDefeatSummary(db, active.id);
    expect(summary.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        playerId: tokenOnly.id,
        damage: 0,
        hits: 0,
        maxHit: 0,
        tokensDuringFight: 800,
      }),
      expect.objectContaining({
        playerId: damageOnly.id,
        damage: 100,
        tokensDuringFight: 0,
      }),
    ]));
  });

  it('finishes legacy-v0 encounters through splitGold without hybrid award rows', () => {
    setSetting(db, 'gold_factor', '1');
    const first = createPlayer(db, { name: 'Legacy First', class_key: 'knight', gender: 'M' }, 1);
    const second = createPlayer(db, { name: 'Legacy Second', class_key: 'wizard', gender: 'F' }, 1);
    const dungeon = db.prepare(
      'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (1, ?, 1, 2, ?)',
    ).run('Ossuary Pale', 100000);
    const encounter = db.prepare(
      `INSERT INTO encounters
       (dungeon_id, index_in_dungeon, kind, creature_index, footprint, pack_count,
        max_hp, current_hp, status, started_at)
       VALUES (?, 0, 'single', 1, 1, 1, 100, 1, 'active', ?)`,
    ).run(Number(dungeon.lastInsertRowid), 100000);
    const encounterId = Number(encounter.lastInsertRowid);
    db.prepare(
      `UPDATE game_state
       SET current_dungeon_id=?, current_encounter_id=?, defeat_until=NULL WHERE id=1`,
    ).run(Number(dungeon.lastInsertRowid), encounterId);
    ingestTokenUsage(db, tokens(first.auth_token, 300), 100000, { cacheReadWeight: 0 });
    ingestTokenUsage(db, tokens(second.auth_token, 100), 100000, { cacheReadWeight: 0 });

    const engine = new GameEngine(db, { rng: () => 0.5 });
    engine.tick(100000);
    killOnNextAttack(engine, encounterId, 100000);

    expect(db.prepare(
      'SELECT reward_model_version FROM encounters WHERE id=?',
    ).get(encounterId)).toEqual({ reward_model_version: 'legacy-v0' });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM encounter_reward_awards WHERE encounter_id=?',
    ).get(encounterId)).toEqual({ count: 0 });
    expect(getPlayerById(db, first.id)?.gold).toBe(75);
    expect(getPlayerById(db, second.id)?.gold).toBe(25);
  });

  it('keeps token-only players out of legacy-v0 awards and summaries', () => {
    setSetting(db, 'gold_factor', '1');
    setSetting(db, 'gold_damage_weight', '0');
    const tokenOnly = createPlayer(
      db,
      { name: 'Legacy Token Only', class_key: 'wizard', gender: 'F' },
      1,
    );
    const damageOnly = createPlayer(
      db,
      { name: 'Legacy Damage Only', class_key: 'knight', gender: 'M' },
      1,
    );
    const dungeon = db.prepare(
      'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (1, ?, 1, 2, ?)',
    ).run('Ossuary Pale', 100_000);
    const encounter = db.prepare(
      `INSERT INTO encounters
       (dungeon_id, index_in_dungeon, kind, creature_index, footprint, pack_count,
        max_hp, current_hp, status, started_at)
       VALUES (?, 0, 'single', 1, 1, 1, 100, 1, 'active', ?)`,
    ).run(Number(dungeon.lastInsertRowid), 100_000);
    const encounterId = Number(encounter.lastInsertRowid);
    db.prepare(
      `UPDATE game_state
       SET current_dungeon_id=?, current_encounter_id=?, defeat_until=NULL WHERE id=1`,
    ).run(Number(dungeon.lastInsertRowid), encounterId);
    ingestTokenUsage(db, tokens(tokenOnly.auth_token, 300), 100_000, {
      cacheReadWeight: 0,
    });
    db.prepare('UPDATE players SET disabled=1 WHERE id=?').run(tokenOnly.id);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?')
      .run(100_000, damageOnly.id);

    const engine = new GameEngine(db, { rng: () => 0.5 });
    engine.tick(100_000);
    killOnNextAttack(engine, encounterId, 100_000);

    expect(getPlayerById(db, tokenOnly.id)?.gold).toBe(0);
    expect(getPlayerById(db, damageOnly.id)?.gold).toBe(100);
    const summary = buildDefeatSummary(db, encounterId);
    expect(summary.participants).toEqual([
      expect.objectContaining({
        playerId: damageOnly.id,
        damage: 100,
        gold: 100,
        tokensDuringFight: 0,
      }),
    ]);
  });
});

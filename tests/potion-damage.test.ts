import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { GameEngine } from '../src/domain/engine';
import { applyGoldMutation } from '../src/domain/goldledger';
import { ingestTokenUsage } from '../src/domain/ingest';
import { purchaseConsumable } from '../src/domain/inventory';
import { createPlayer } from '../src/domain/players';
import { activatePotion } from '../src/domain/potions';
import { getSetting, seedSettings, setSetting } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
const timeZone = 'Asia/Tokyo';
const now = Date.parse('2026-07-28T23:30:00Z');

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  setSetting(db, 'attack_interval_ms', '1000');
  setSetting(db, 'attack_jitter_ms', '0');
  setSetting(db, 'baseline_battle_minutes', '0');
  setSetting(db, 'min_encounter_hp', '1000000000');
  setSetting(db, 'gold_factor', '0');
  setSetting(db, 'monster_attacks_enabled', '0');
});

type Player = ReturnType<typeof createPlayer>;
type PotionSku = 'potion_gold_t1' | 'potion_damage_t1';

function fundedPlayer(name: string): Player {
  const player = createPlayer(
    db,
    { name, class_key: 'knight', gender: 'M' },
    now - 10_000,
  );
  applyGoldMutation(db, {
    playerId: player.id,
    amount: 1_000_000,
    reason: 'opening_balance',
    sourceTable: 'test_players',
    sourceId: `${player.id}`,
    now: now - 10_000,
  });
  return player;
}

function buy(player: Player, skuId: PotionSku, requestId: string): void {
  const result = purchaseConsumable(db, {
    playerId: player.id,
    skuId,
    quantity: 1,
    expectedUnitPrice: skuId === 'potion_gold_t1' ? 100_000 : 150_000,
    requestId,
    now: now - 2_000,
    timeZone,
  });
  expect(result).toMatchObject({ ok: true, duplicate: false });
}

function startEngine(players: Player[]): { engine: GameEngine; encounterId: number } {
  for (const player of players) {
    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?').run(now, player.id);
  }
  const engine = new GameEngine(db, { rng: () => 0.5, officeTimeZone: timeZone });
  engine.tick(now);
  const encounter = db.prepare(
    "SELECT id FROM encounters WHERE status = 'active'",
  ).get() as { id: number };
  return { engine, encounterId: encounter.id };
}

function drink(player: Player, skuId: PotionSku, requestId: string): number {
  const result = activatePotion(db, {
    playerId: player.id,
    skuId,
    requestId,
    now,
    timeZone,
  });
  expect(result).toMatchObject({ ok: true, duplicate: false });
  if (!result.ok) throw new Error(`activation fixture failed: ${result.reason}`);
  return result.activationId;
}

function damageRow(encounterId: number, playerId: number) {
  return db.prepare(
    `SELECT damage_total, hits, max_hit, potion_bonus_damage
     FROM encounter_damage WHERE encounter_id = ? AND player_id = ?`,
  ).get(encounterId, playerId) as {
    damage_total: number;
    hits: number;
    max_hit: number;
    potion_bonus_damage: number;
  };
}

function tokensPayload(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('Damage Potion combat', () => {
  it('boosts only the drinker and accumulates exact encounter, activation, and office-day audits', () => {
    const normal = fundedPlayer('Normal');
    const boosted = fundedPlayer('Boosted');
    buy(boosted, 'potion_damage_t1', 'buy-damage');
    const { engine, encounterId } = startEngine([normal, boosted]);
    const activationId = drink(boosted, 'potion_damage_t1', 'drink-damage');

    engine.tick(now + 1_000);
    const normalHit = damageRow(encounterId, normal.id).max_hit;
    const potionHit = damageRow(encounterId, boosted.id).max_hit;
    expect(normalHit).toBe(100);
    expect(potionHit).toBe(125);

    engine.tick(now + 2_000);
    engine.tick(now + 3_000);

    expect(getSetting(db, 'base_hit')).toBe('100');
    expect(damageRow(encounterId, normal.id)).toEqual({
      damage_total: 300,
      hits: 3,
      max_hit: 100,
      potion_bonus_damage: 0,
    });
    expect(damageRow(encounterId, boosted.id)).toEqual({
      damage_total: 375,
      hits: 3,
      max_hit: 125,
      potion_bonus_damage: 75,
    });
    expect(db.prepare(
      'SELECT potion_bonus_damage FROM potion_activations WHERE id = ?',
    ).get(activationId)).toEqual({ potion_bonus_damage: 75 });
    expect(db.prepare(
      `SELECT activation_id, encounter_id, bonus_damage
       FROM potion_activation_encounters`,
    ).get()).toEqual({ activation_id: activationId, encounter_id: encounterId, bonus_damage: 75 });
    expect(db.prepare(
      `SELECT office_day, damage, potion_bonus_damage
       FROM player_daily_combat WHERE player_id = ?`,
    ).get(boosted.id)).toEqual({
      office_day: '2026-07-29',
      damage: 375,
      potion_bonus_damage: 75,
    });
  });

  it('applies level, activity, and debuff modifiers to both rounded counterfactual paths', () => {
    setSetting(db, 'base_hit', '10');
    setSetting(db, 'token_modifier_k', '100');
    setSetting(db, 'monster_debuff_factor', '0.5');
    const player = fundedPlayer('Modified');
    db.prepare('UPDATE players SET level = 2 WHERE id = ?').run(player.id);
    buy(player, 'potion_damage_t1', 'buy-modified');
    const { engine, encounterId } = startEngine([player]);
    const activationId = drink(player, 'potion_damage_t1', 'drink-modified');
    db.prepare(
      `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
       VALUES (?, ?, 50, 50)`,
    ).run(player.id, now);
    db.prepare(
      `INSERT INTO monster_attacks (encounter_id, player_id, kind, ts)
       VALUES (?, ?, 'debuff', ?)`,
    ).run(encounterId, player.id, now + 1_000);

    engine.tick(now + 1_000);

    expect(damageRow(encounterId, player.id)).toEqual({
      damage_total: 13,
      hits: 1,
      max_hit: 13,
      potion_bonus_damage: 3,
    });
    expect(db.prepare(
      'SELECT potion_bonus_damage FROM potion_activations WHERE id = ?',
    ).get(activationId)).toEqual({ potion_bonus_damage: 3 });
  });

  it('lets Gold and Damage overlap without giving Gold damage or changing Gold work accounting', () => {
    const goldOnly = fundedPlayer('Gold Only');
    const overlap = fundedPlayer('Overlap');
    buy(goldOnly, 'potion_gold_t1', 'buy-gold-only');
    buy(overlap, 'potion_gold_t1', 'buy-overlap-gold');
    buy(overlap, 'potion_damage_t1', 'buy-overlap-damage');
    const { engine, encounterId } = startEngine([goldOnly, overlap]);
    const goldOnlyActivation = drink(goldOnly, 'potion_gold_t1', 'drink-gold-only');
    const overlapGoldActivation = drink(overlap, 'potion_gold_t1', 'drink-overlap-gold');
    drink(overlap, 'potion_damage_t1', 'drink-overlap-damage');

    engine.tick(now + 1_000);

    expect(damageRow(encounterId, goldOnly.id).max_hit).toBe(100);
    expect(damageRow(encounterId, overlap.id).max_hit).toBe(125);
    ingestTokenUsage(db, tokensPayload(goldOnly.auth_token, 1_000), now + 1_001, { cacheReadWeight: 0 });
    ingestTokenUsage(db, tokensPayload(overlap.auth_token, 1_000), now + 1_001, { cacheReadWeight: 0 });
    expect(db.prepare(
      `SELECT id, eligible_tokens, base_gold, stretch_gold
       FROM potion_activations WHERE id IN (?, ?) ORDER BY id`,
    ).all(goldOnlyActivation, overlapGoldActivation)).toEqual([
      { id: goldOnlyActivation, eligible_tokens: 1_000, base_gold: 50, stretch_gold: 0 },
      { id: overlapGoldActivation, eligible_tokens: 1_000, base_gold: 50, stretch_gold: 0 },
    ]);
    expect(db.prepare(
      `SELECT player_id, amount FROM gold_ledger
       WHERE reason = 'gold_potion_base' ORDER BY player_id`,
    ).all()).toEqual([
      { player_id: goldOnly.id, amount: 50 },
      { player_id: overlap.id, amount: 50 },
    ]);
  });

  it('completes clock-expired Damage before swings and ignores a strictly malformed active snapshot', () => {
    const expired = fundedPlayer('Expired');
    const malformed = fundedPlayer('Malformed');
    buy(expired, 'potion_damage_t1', 'buy-expired');
    buy(malformed, 'potion_damage_t1', 'buy-malformed');
    const { engine, encounterId } = startEngine([expired, malformed]);

    const malformedActivation = drink(malformed, 'potion_damage_t1', 'drink-malformed');
    db.prepare('UPDATE potion_activations SET effect_snapshot = ? WHERE id = ?').run(
      JSON.stringify({
        kind: 'damage',
        durationMs: 7_200_000,
        baseHitMultiplier: 1.25,
        unexpected: true,
      }),
      malformedActivation,
    );
    setSetting(db, 'potion_damage_t1_duration_s', '1');
    const expiredActivation = drink(expired, 'potion_damage_t1', 'drink-expired');

    engine.tick(now + 1_000);

    expect(damageRow(encounterId, expired.id)).toMatchObject({
      damage_total: 100,
      potion_bonus_damage: 0,
    });
    expect(damageRow(encounterId, malformed.id)).toMatchObject({
      damage_total: 100,
      potion_bonus_damage: 0,
    });
    expect(db.prepare(
      'SELECT status, completed_at FROM potion_activations WHERE id = ?',
    ).get(expiredActivation)).toEqual({ status: 'completed', completed_at: now + 1_000 });
    expect(db.prepare(
      'SELECT status, potion_bonus_damage FROM potion_activations WHERE id = ?',
    ).get(malformedActivation)).toEqual({ status: 'active', potion_bonus_damage: 0 });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM potion_activation_encounters',
    ).get()).toEqual({ count: 0 });
  });
});

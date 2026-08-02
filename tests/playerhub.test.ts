import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { officeDayKey, nextOfficeMidnight } from '../src/domain/office-time';
import { activatePotion } from '../src/domain/potions';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { buildPlayerHubState, buildPlayerHubViewModel } from '../src/domain/playerhub';
import { seedSettings, setSetting } from '../src/domain/settings';

const timeZone = 'America/New_York';
const now = Date.parse('2026-07-28T16:00:00Z');
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
});

function seedFight(playerId: number): number {
  const ahead = createPlayer(db, { name: 'Ahead', class_key: 'thief', gender: 'F' }, now - 2);
  const behind = createPlayer(db, { name: 'Behind', class_key: 'ranger', gender: 'M' }, now - 1);
  const dungeon = db.prepare(
    `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
     VALUES (1, 'Ossuary Pale', 7, 2, ?)`,
  ).run(now - 10_000);
  const encounter = db.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at)
     VALUES (?, 0, 'single', 1, 1, 1, 5000, 3000, 'active', ?)`,
  ).run(Number(dungeon.lastInsertRowid), now - 10_000);
  const encounterId = Number(encounter.lastInsertRowid);
  db.prepare(
    `UPDATE game_state SET current_dungeon_id=?, current_encounter_id=?,
       last_activity_at=?, paused=0 WHERE id=1`,
  ).run(Number(dungeon.lastInsertRowid), encounterId, now);
  const addDamage = db.prepare(
    `INSERT INTO encounter_damage
      (encounter_id, player_id, damage_total, hits, max_hit)
     VALUES (?, ?, ?, 1, ?)`,
  );
  addDamage.run(encounterId, ahead.id, 900, 900);
  addDamage.run(encounterId, playerId, 500, 500);
  addDamage.run(encounterId, behind.id, 100, 100);
  return encounterId;
}

function seedInventoryAndGoldPotion(playerId: number): void {
  for (const [sku, quantity, expectedUnitPrice, requestId] of [
    ['potion_gold_t1', 2, 100_000, 'purchase-gold'],
    ['potion_damage_t1', 1, 150_000, 'purchase-damage'],
  ] as const) {
    expect(purchaseConsumable(db, {
      playerId, skuId: sku, quantity, expectedUnitPrice, requestId,
      now: now - 60_000, timeZone,
    })).toMatchObject({ ok: true });
  }
  expect(activatePotion(db, {
    playerId, skuId: 'potion_gold_t1', requestId: 'activate-gold', now, timeZone,
  })).toMatchObject({ ok: true, potionType: 'gold' });
  db.prepare(
    `UPDATE potion_activations
     SET eligible_tokens=1234, base_gold=50 WHERE player_id=? AND potion_type='gold'`,
  ).run(playerId);
  db.prepare('UPDATE game_state SET combat_active_ms=combat_active_ms+1000 WHERE id=1').run();
}

function seedRun(playerId: number, input: {
  runKey: string;
  updatedAt: number;
  model: string | null;
  effort: string | null;
  raidPower: number;
}): void {
  db.prepare(
    `INSERT INTO runs
      (player_id, provider, surface, run_key, state, started_at_ms,
       terminal_at_ms, last_event_at_ms, last_observed_at_ms, usage_input,
       usage_output, usage_cache_read, usage_cache_write,
       usage_reasoning_output, latest_model, latest_effort, policy_version,
       raid_power, created_at, updated_at)
     VALUES (?, 'codex', 'codex_desktop', ?, 'open', ?, NULL, ?, ?,
       11, 22, 33, 44, 55, ?, ?, 'raid-power-v1', ?, ?, ?)`,
  ).run(
    playerId,
    input.runKey,
    input.updatedAt - 5_000,
    input.updatedAt - 1_000,
    input.updatedAt,
    input.model,
    input.effort,
    input.raidPower,
    input.updatedAt - 5_000,
    input.updatedAt,
  );
}

describe('player hub state', () => {
  it.each([
    {
      label: 'empty metadata',
      model: '',
      effort: '',
      expectedModel: 'Unknown',
      expectedEffort: 'Unknown',
    },
    {
      label: 'whitespace-only metadata',
      model: ' \t ',
      effort: ' \n ',
      expectedModel: 'Unknown',
      expectedEffort: 'Unknown',
    },
    {
      label: 'nonempty literal metadata',
      model: ' gpt-literal ',
      effort: ' high ',
      expectedModel: ' gpt-literal ',
      expectedEffort: ' high ',
    },
  ])('normalizes missing Run model and effort while preserving $label', ({
    model,
    effort,
    expectedModel,
    expectedEffort,
  }) => {
    const player = createPlayer(
      db,
      { name: 'Metadata Reader', class_key: 'wizard', gender: 'M' },
      now - 20_000,
    );
    db.prepare(
      'INSERT INTO raider_identities (player_id, dedupe_secret, created_at) VALUES (?, ?, ?)',
    ).run(player.id, 'e'.repeat(64), now - 20_000);
    seedRun(player.id, {
      runKey: 'f'.repeat(64),
      updatedAt: now - 1_000,
      model,
      effort,
      raidPower: 1,
    });

    const hub = buildPlayerHubViewModel(
      db,
      getPlayerById(db, player.id)!,
      now,
      timeZone,
      { spritesDir: '/sprites', slotmapsDir: '/slotmaps', publicUrl: 'https://example.test' },
    );

    expect(hub.latestRun?.model).toBe(expectedModel);
    expect(hub.latestRun?.effort).toBe(expectedEffort);
  });

  it('exposes parallel Runs, newest safe details, collector status, and Today Raid Power', () => {
    const player = createPlayer(
      db,
      { name: 'Run Reader', class_key: 'wizard', gender: 'M' },
      now - 20_000,
    );
    const olderRunKey = 'a'.repeat(64);
    const latestRunKey = 'b'.repeat(64);
    const deviceId = '00000000-0000-4000-8000-000000000004';
    const credentialHash = 'c'.repeat(64);
    db.prepare(
      'INSERT INTO raider_identities (player_id, dedupe_secret, created_at) VALUES (?, ?, ?)',
    ).run(player.id, 'd'.repeat(64), now - 20_000);
    db.prepare(
      'INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?, ?, 777, 777)',
    ).run(player.id, now - 500);
    db.prepare(
      `INSERT INTO raider_devices
        (device_id, player_id, token_hash, companion_version, created_at, last_seen_at)
       VALUES (?, ?, ?, '0.1.0', ?, ?)`,
    ).run(deviceId, player.id, credentialHash, now - 10_000, now - 100);
    seedRun(player.id, {
      runKey: olderRunKey,
      updatedAt: now - 2_000,
      model: 'older-model',
      effort: 'high',
      raidPower: 100,
    });
    seedRun(player.id, {
      runKey: latestRunKey,
      updatedAt: now - 1_000,
      model: null,
      effort: null,
      raidPower: 321,
    });

    const hub = buildPlayerHubViewModel(
      db,
      getPlayerById(db, player.id)!,
      now,
      timeZone,
      { spritesDir: '/sprites', slotmapsDir: '/slotmaps', publicUrl: 'https://example.test' },
    );

    expect(hub.activeRuns).toBe(2);
    expect(hub.latestRun).toEqual({
      provider: 'codex',
      surface: 'codex_desktop',
      model: 'Unknown',
      effort: 'Unknown',
      state: 'open',
      elapsedMs: 4_000,
      nativeUsage: {
        input: 11,
        output: 22,
        cacheRead: 33,
        cacheWrite: 44,
        reasoningOutput: 55,
      },
      raidPower: 321,
    });
    expect(hub.today.raidPower).toBe(777);
    expect(hub.collector).toEqual({ lastSeenAt: now - 100, devices: 1 });
    const output = JSON.stringify(hub);
    expect(output).not.toContain(olderRunKey);
    expect(output).not.toContain(latestRunKey);
    expect(output).not.toContain(deviceId);
    expect(output).not.toContain(credentialHash);
    expect(output).not.toContain('runKey');
    expect(output).not.toContain('deviceId');
    expect(output).not.toContain('path');
    expect(output).not.toContain('credential');
  });

  it('returns private player progress, public fight leaders, and office-local Today totals', () => {
    const player = createPlayer(db, { name: 'Hero', class_key: 'wizard', gender: 'M' }, now - 20_000);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(now, player.id);
    applyGoldMutation(db, {
      playerId: player.id, amount: 1_000_000, reason: 'opening_balance',
      sourceTable: 'test', sourceId: 'opening', now: now - 100_000,
    });
    const encounterId = seedFight(player.id);
    seedInventoryAndGoldPotion(player.id);

    const day = officeDayKey(now, timeZone);
    db.prepare(
      'INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?, ?, ?, ?)',
    ).run(player.id, now - 30_000, 1234, 1500);
    db.prepare(
      'INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?, ?, ?, ?)',
    ).run(player.id, Date.parse('2026-07-27T16:00:00Z'), 9999, 9999);
    db.prepare(
      `INSERT INTO player_daily_combat
        (player_id, office_day, damage, potion_bonus_damage) VALUES (?, ?, 500, 100)`,
    ).run(player.id, day);
    db.prepare(
      'INSERT INTO game_clock_days (office_day, active_ms) VALUES (?, ?)',
    ).run(day, 3_600_000);
    applyGoldMutation(db, {
      playerId: player.id, amount: 200, reason: 'encounter_reward',
      sourceTable: 'encounter_reward_awards', sourceId: `${encounterId}`, now: now - 20_000,
    });
    applyGoldMutation(db, {
      playerId: player.id, amount: 50, reason: 'gold_potion_base',
      sourceTable: 'potion_work_events', sourceId: '1', now: now - 10_000,
    });
    applyGoldMutation(db, {
      playerId: player.id, amount: -10, reason: 'monster_steal',
      sourceTable: 'monster_attacks', sourceId: '1', now: now - 5_000,
    });
    db.prepare(
      `INSERT INTO monster_attacks
        (encounter_id, player_id, kind, ts) VALUES (?, ?, 'debuff', ?)`,
    ).run(encounterId, player.id, now - 5_000);
    db.prepare(
      `INSERT INTO potion_activations
        (player_id, sku, potion_type, tier, purchase_id, purchase_unit_price,
         request_id, activation_day, activated_at, start_game_ms, expires_game_ms,
         status, effect_snapshot)
       SELECT ?, 'potion_damage_t1', 'damage', 1, id, unit_price,
         'invalid-activation', ?, ?, 0, 1000, 'completed', '{"kind":"damage"}'
       FROM shop_purchases WHERE player_id=? AND sku='potion_damage_t1' LIMIT 1`,
    ).run(player.id, day, now, player.id);

    const freshPlayer = getPlayerById(db, player.id)!;
    const hub = buildPlayerHubState(db, freshPlayer, now, timeZone);

    expect(hub.activationTiming).toBe('starts_now');
    expect(hub.today).toEqual({
      effectiveTokens: 1234,
      raidPower: 1234,
      damage: 500,
      fightRank: 2,
      goldEarned: 250,
      combatActiveMs: 3_600_000,
      potionsUsed: 1,
    });
    expect(hub.inventory.map((item) => item.sku)).toEqual([
      'potion_gold_t1', 'potion_damage_t1',
    ]);
    expect(hub.inventory[0]).toMatchObject({
      quantity: 1,
      potionType: 'gold',
      tier: 1,
      usesRemaining: 2,
      nextResetAt: nextOfficeMidnight(now, timeZone),
    });
    expect(hub.effects.map((effect) => effect.kind)).toEqual(
      expect.arrayContaining(['gold', 'debuff']),
    );
    expect(hub.effects.find((effect) => effect.kind === 'gold')).toMatchObject({
      state: 'active',
      progress: { value: 1234, max: 2_500_000 },
    });
    expect(hub.effects.find((effect) => effect.kind === 'debuff')).toMatchObject({
      remainingMs: 3_000,
    });
    expect(hub.currentFight.leaders.map((leader) => leader.name)).toEqual([
      'Ahead', 'Hero', 'Behind',
    ]);
    expect(JSON.stringify(hub)).not.toContain(player.auth_token);
    expect(JSON.stringify(hub)).not.toContain('auth_token');
  });

  it('returns every positive-damage current-fight participant in rank order', () => {
    const player = createPlayer(
      db,
      { name: 'Hero', class_key: 'wizard', gender: 'M' },
      now - 20_000,
    );
    const encounterId = seedFight(player.id);
    const addDamage = db.prepare(
      `INSERT INTO encounter_damage
        (encounter_id, player_id, damage_total, hits, max_hit)
       VALUES (?, ?, ?, 1, ?)`,
    );
    for (const [name, damage] of [
      ['Fourth', 400],
      ['Fifth', 300],
      ['Sixth', 200],
      ['Seventh', 100],
    ] as const) {
      const extra = createPlayer(
        db,
        { name, class_key: 'knight', gender: 'M' },
        now,
      );
      addDamage.run(encounterId, extra.id, damage, damage);
    }

    const hub = buildPlayerHubState(
      db,
      getPlayerById(db, player.id)!,
      now,
      timeZone,
    );

    expect(hub.currentFight.leaders.map(({ name, damage }) => [name, damage])).toEqual([
      ['Ahead', 900],
      ['Hero', 500],
      ['Fourth', 400],
      ['Fifth', 300],
      ['Sixth', 200],
      ['Behind', 100],
      ['Seventh', 100],
    ]);
  });

  it('omits zero inventory stacks and returns no fight rank without a current encounter', () => {
    const player = createPlayer(db, { name: 'Quiet', class_key: 'priest', gender: 'F' }, now);
    const hub = buildPlayerHubState(db, player, now, timeZone);

    expect(hub.activationTiming).toBe('waits_for_battle');
    expect(hub.inventory).toEqual([]);
    expect(hub.effects).toEqual([]);
    expect(hub.today.fightRank).toBeNull();
    expect(hub.currentFight.leaders).toEqual([]);
  });

  it('keeps owned inventory visible but unavailable when current tuning is invalid', () => {
    const player = createPlayer(
      db,
      { name: 'Closed Apothecary', class_key: 'wizard', gender: 'F' },
      now - 20_000,
    );
    applyGoldMutation(db, {
      playerId: player.id,
      amount: 500_000,
      reason: 'opening_balance',
      sourceTable: 'test',
      sourceId: 'closed-apothecary-opening',
      now: now - 100_000,
    });
    expect(purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      quantity: 2,
      expectedUnitPrice: 100_000,
      requestId: 'closed-apothecary-purchase',
      now: now - 60_000,
      timeZone,
    })).toMatchObject({ ok: true, inventory: 2 });
    expect(activatePotion(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      requestId: 'closed-apothecary-activation',
      now,
      timeZone,
    })).toMatchObject({ ok: true, inventoryRemaining: 1 });
    setSetting(db, 'potion_damage_t1_base_hit_pct', 'not-a-number');

    const hub = buildPlayerHubState(db, getPlayerById(db, player.id)!, now, timeZone);

    expect(hub.inventory).toEqual([
      expect.objectContaining({
        sku: 'potion_gold_t1',
        name: 'Beginner Gold Potion',
        quantity: 1,
        available: false,
        durationMs: null,
        effectCopy: 'Potion tuning is temporarily unavailable.',
        usesRemaining: null,
      }),
    ]);
    expect(hub.effects.find((effect) => effect.kind === 'gold')).toMatchObject({
      description: '50g per 1,000 Raid Power',
      state: 'armed',
    });
  });

  it('keeps an active potion effect after its consumed inventory stack reaches zero', () => {
    const player = createPlayer(db, { name: 'Last Bottle', class_key: 'knight', gender: 'M' }, now - 20_000);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(now, player.id);
    applyGoldMutation(db, {
      playerId: player.id, amount: 500_000, reason: 'opening_balance',
      sourceTable: 'test', sourceId: 'last-bottle-opening', now: now - 100_000,
    });
    seedFight(player.id);
    expect(purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      quantity: 1,
      expectedUnitPrice: 100_000,
      requestId: 'last-bottle-purchase',
      now: now - 60_000,
      timeZone,
    })).toMatchObject({ ok: true, inventory: 1 });
    expect(activatePotion(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      requestId: 'last-bottle-activation',
      now,
      timeZone,
    })).toMatchObject({ ok: true, inventoryRemaining: 0 });
    db.prepare('UPDATE game_state SET combat_active_ms=combat_active_ms+1 WHERE id=1').run();

    const hub = buildPlayerHubState(db, getPlayerById(db, player.id)!, now, timeZone);

    expect(hub.inventory.find((item) => item.sku === 'potion_gold_t1')).toBeUndefined();
    expect(hub.effects.find((effect) => effect.kind === 'gold')).toMatchObject({
      title: 'Beginner Gold Potion',
      state: 'active',
    });
  });

  it('ranks tied current-fight damage by lower player id', () => {
    const lower = createPlayer(db, { name: 'Lower ID', class_key: 'knight', gender: 'M' }, now - 2);
    const higher = createPlayer(db, { name: 'Higher ID', class_key: 'thief', gender: 'F' }, now - 1);
    const dungeon = db.prepare(
      `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
       VALUES (1, 'Ossuary Pale', 9, 2, ?)`,
    ).run(now - 10_000);
    const encounter = db.prepare(
      `INSERT INTO encounters
        (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
         pack_count, max_hp, current_hp, status, started_at)
       VALUES (?, 0, 'single', 1, 1, 1, 5000, 3000, 'active', ?)`,
    ).run(Number(dungeon.lastInsertRowid), now - 10_000);
    const encounterId = Number(encounter.lastInsertRowid);
    db.prepare(
      `UPDATE game_state SET current_dungeon_id=?, current_encounter_id=?,
         last_activity_at=?, paused=0 WHERE id=1`,
    ).run(Number(dungeon.lastInsertRowid), encounterId, now);
    const damage = db.prepare(
      `INSERT INTO encounter_damage
        (encounter_id, player_id, damage_total, hits, max_hit)
       VALUES (?, ?, 500, 1, 500)`,
    );
    damage.run(encounterId, higher.id);
    damage.run(encounterId, lower.id);

    const lowerHub = buildPlayerHubState(db, lower, now, timeZone);
    const higherHub = buildPlayerHubState(db, higher, now, timeZone);

    expect(lowerHub.today.fightRank).toBe(1);
    expect(higherHub.today.fightRank).toBe(2);
    expect(lowerHub.currentFight.leaders.map((leader) => leader.playerId)).toEqual([
      lower.id, higher.id,
    ]);
  });
});

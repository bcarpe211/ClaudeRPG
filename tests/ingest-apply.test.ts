import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { createPlayer, getPlayerById, updatePlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { activatePotion } from '../src/domain/potions';
import { seedSettings } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

function body(
  token: string,
  byType: Record<string, number>,
  temporality = 1,
  timeUnixNano = 't',
) {
  const dataPoints = Object.entries(byType).map(([type, v]) => ({
    asInt: String(v), startTimeUnixNano: 's', timeUnixNano,
    attributes: [{ key: 'type', value: { stringValue: type } }, { key: 'model', value: { stringValue: 'm' } }],
  }));
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
      scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: temporality, dataPoints } }] }],
    }],
  };
}

function goldPotionPlayer(at: number, withEncounter: boolean) {
  seedSettings(db);
  const player = createPlayer(
    db,
    { name: 'Potion Ingest', class_key: 'knight', gender: 'M' },
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
    requestId: `buy-${player.id}`,
    now: at - 2_000,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true, newGold: 0 });

  if (withEncounter) {
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

  expect(activatePotion(db, {
    playerId: player.id,
    skuId: 'potion_gold_t1',
    requestId: `drink-${player.id}`,
    now: at,
    timeZone: 'America/New_York',
  })).toMatchObject({ ok: true, potionType: 'gold' });
  return player;
}

describe('ingestTokenUsage', () => {
  it('adds effective (input+output+cacheCreation) and total; ignores cacheRead by default', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100, output: 40, cacheCreation: 10, cacheRead: 9999 }), 5000, { cacheReadWeight: 0 });
    const u = getPlayerById(db, p.id)!;
    expect(u.effective_tokens).toBe(150);
    expect(u.total_tokens).toBe(10149);
    expect(u.last_token_at).toBe(5000);
    const ev = db.prepare('SELECT * FROM token_events WHERE player_id = ?').all(p.id) as any[];
    expect(ev.length).toBe(1);
    expect(ev[0].effective_delta).toBe(150);
    expect(ev[0].total_delta).toBe(10149);
  });

  it('applies cache_read_weight when > 0', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 0, output: 0, cacheCreation: 0, cacheRead: 1000 }), 1, { cacheReadWeight: 0.05 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(50);
  });

  it('accumulates across multiple ingests', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }, 1, 't1'), 1, { cacheReadWeight: 0 });
    ingestTokenUsage(db, body(p.auth_token, { input: 50 }, 1, 't2'), 2, { cacheReadWeight: 0 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(150);
  });

  it('applies an exact delta delivery only once when the exporter replays it', () => {
    const p = createPlayer(
      db,
      { name: 'Replay', class_key: 'knight', gender: 'M' },
      1,
    );
    const replayed = body(p.auth_token, { input: 100 }, 1, 'delivery-100');

    ingestTokenUsage(db, replayed, 1_000, { cacheReadWeight: 0 });
    ingestTokenUsage(db, replayed, 2_000, { cacheReadWeight: 0 });

    expect(getPlayerById(db, p.id)).toMatchObject({
      effective_tokens: 100,
      total_tokens: 100,
      last_token_at: 1_000,
    });
    expect(db.prepare(
      'SELECT effective_delta, total_delta FROM token_events WHERE player_id=?',
    ).all(p.id)).toEqual([{ effective_delta: 100, total_delta: 100 }]);
    expect(db.prepare(
      'SELECT series_key, time_unix_nano FROM metric_deliveries',
    ).all()).toEqual([{
      series_key: `${p.auth_token}|input|m|s`,
      time_unix_nano: 'delivery-100',
    }]);
  });

  it('ignores unknown tokens', () => {
    const res = ingestTokenUsage(
      db,
      body('nobody', { input: 100 }, 2, 'unknown-token'),
      1,
      { cacheReadWeight: 0 },
    );
    expect(res.appliedPlayers).toBe(0);
    expect(res.ignoredUnknownTokens).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM token_events').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM metric_series').get())
      .toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM metric_deliveries').get())
      .toEqual({ c: 0 });
  });

  it('rejects unsupported metric types before checkpoint or delivery writes', () => {
    const p = createPlayer(
      db,
      { name: 'Supported Types', class_key: 'knight', gender: 'M' },
      1,
    );

    expect(ingestTokenUsage(
      db,
      body(p.auth_token, { arbitraryType: 100 }, 2, 'unsupported-type'),
      1,
      { cacheReadWeight: 0 },
    )).toEqual({ appliedPlayers: 0, ignoredUnknownTokens: 0 });

    expect(getPlayerById(db, p.id)).toMatchObject({
      effective_tokens: 0,
      total_tokens: 0,
      last_token_at: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS c FROM metric_series').get())
      .toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM metric_deliveries').get())
      .toEqual({ c: 0 });
  });

  it('ignores disabled players', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    updatePlayer(db, p.id, { disabled: 1 });
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }), 1, { cacheReadWeight: 0 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(0);
  });

  it('does not write a token_event when the net effective+total increment is zero', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, {}), 1, { cacheReadWeight: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM token_events').get()).toMatchObject({ c: 0 });
  });

  it('sumEffectiveSince totals only recent token_events', async () => {
    const { sumEffectiveSince } = await import('../src/domain/ingest');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(
      db,
      body(p.auth_token, { input: 100 }, 1, 'recent-1'),
      1000,
      { cacheReadWeight: 0 },
    );
    ingestTokenUsage(
      db,
      body(p.auth_token, { input: 50 }, 1, 'recent-2'),
      5000,
      { cacheReadWeight: 0 },
    );
    expect(sumEffectiveSince(db, p.id, 2000)).toBe(50);
    expect(sumEffectiveSince(db, p.id, 0)).toBe(150);
  });

  it('credits the first token that wakes an existing encounter inside ingestion', () => {
    const ingestNow = 2_000_000;
    const player = goldPotionPlayer(1_000, true);
    db.prepare('UPDATE players SET last_token_at = ? WHERE id = ?')
      .run(ingestNow - 15 * 60_000 - 1, player.id);

    expect(ingestTokenUsage(
      db,
      body(player.auth_token, { input: 1_000 }),
      ingestNow,
      { cacheReadWeight: 0 },
    )).toEqual({ appliedPlayers: 1, ignoredUnknownTokens: 0 });

    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 1_000,
      total_tokens: 1_000,
      last_token_at: ingestNow,
      gold: 50,
    });
    const tokenEvent = db.prepare(
      `SELECT id, player_id, ts, effective_delta, total_delta
       FROM token_events WHERE player_id = ?`,
    ).get(player.id) as {
      id: number;
      player_id: number;
      ts: number;
      effective_delta: number;
      total_delta: number;
    };
    expect(tokenEvent).toEqual({
      id: tokenEvent.id,
      player_id: player.id,
      ts: ingestNow,
      effective_delta: 1_000,
      total_delta: 1_000,
    });
    expect(db.prepare(
      `SELECT token_event_id, effective_delta, base_gold, stretch_gold
       FROM potion_work_events`,
    ).all()).toEqual([{
      token_event_id: tokenEvent.id,
      effective_delta: 1_000,
      base_gold: 50,
      stretch_gold: 0,
    }]);
  });

  it('does not credit Gold Potion work before the first encounter exists', () => {
    const ingestNow = 2_000_000;
    const player = goldPotionPlayer(1_000, false);

    ingestTokenUsage(
      db,
      body(player.auth_token, { input: 1_000 }),
      ingestNow,
      { cacheReadWeight: 0 },
    );

    expect(getPlayerById(db, player.id)).toMatchObject({
      effective_tokens: 1_000,
      gold: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM potion_work_events').get())
      .toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT eligible_tokens, base_gold, stretch_gold
       FROM potion_activations WHERE player_id = ?`,
    ).get(player.id)).toEqual({
      eligible_tokens: 0,
      base_gold: 0,
      stretch_gold: 0,
    });
  });
});

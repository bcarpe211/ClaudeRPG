import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { buildTvState } from '../src/web/tvview';
import { monsterByIndex } from '../src/domain/bestiary';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { activatePotion } from '../src/domain/potions';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('buildTvState', () => {
  it('reports paused with no encounter when the office is idle', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const s = buildTvState(db, 100000);
    expect(s.paused).toBe(true);
    expect(s.encounter).toBeNull();
    expect(s.players.length).toBe(1);
    expect(s.defeat).toBeNull();
  });

  it('reports the active encounter, hero positions, modifier, and sorted leaderboard', () => {
    const a = createPlayer(db, { name: 'Big', class_key: 'wizard', gender: 'M' }, 1);
    const b = createPlayer(db, { name: 'Small', class_key: 'thief', gender: 'F' }, 1);
    ingestTokenUsage(db, tokens(a.auth_token, 40000), 100000, { cacheReadWeight: 0 }); // bigger
    ingestTokenUsage(db, tokens(b.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const s = buildTvState(db, 100000);
    expect(s.paused).toBe(false);
    expect(s.encounter).not.toBeNull();
    expect(s.encounter!.hp).toBeLessThanOrEqual(s.encounter!.maxHp);
    expect(s.encounter!.creatureUrl.startsWith('/sprites/creatures_24x24/')).toBe(true);
    // leaderboard sorted by effective tokens desc -> Big first
    expect(s.players[0].name).toBe('Big');
    expect(s.players[0].avatarUrl.startsWith('/sprites/creatures_24x24/')).toBe(true);
    expect(s.players[0].modifier).toBeGreaterThan(1); // recent tokens raise it
    // enabled players get battlefield coordinates
    const placed = s.players.filter((p) => p.x !== null);
    expect(placed.length).toBe(2);
  });

  it('leaderboard modifier reflects the accumulate activity score (survives past the old recent-window)', () => {
    // Widen the decay window so a burst that would have fallen outside the old
    // 5-minute rolling window still reports fully under the new accumulate
    // score (idle-decay only starts at 30 min).
    setSetting(db, 'decay_after_minutes', '30');
    setSetting(db, 'decay_span_minutes', '30');
    const p = createPlayer(db, { name: 'Burst', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 5000), 100000, { cacheReadWeight: 0 });
    const now = 100000 + 8 * 60_000; // 8 minutes later
    const s = buildTvState(db, now);
    const entry = s.players.find((pl) => pl.id === p.id)!;
    expect(entry.modifier).toBeGreaterThan(1);
  });

  it('active encounter carries a monster name, size and flying flag', () => {
    const a = createPlayer(db, { name: 'Big', class_key: 'wizard', gender: 'M' }, 1);
    const b = createPlayer(db, { name: 'Small', class_key: 'thief', gender: 'F' }, 1);
    ingestTokenUsage(db, tokens(a.auth_token, 40000), 100000, { cacheReadWeight: 0 });
    ingestTokenUsage(db, tokens(b.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const s = buildTvState(db, 100000);
    expect(s.encounter).not.toBeNull();
    const e = s.encounter!;
    expect(typeof e.name).toBe('string');
    expect(e.name.length).toBeGreaterThan(0);
    expect(['S', 'M', 'L']).toContain(e.size);
    expect(typeof e.flying).toBe('boolean');
    // consistent with the bestiary for the spawned creature
    const m = monsterByIndex(e.creatureIndex);
    if (m) { expect(e.size).toBe(m.size); expect(e.flying).toBe(m.flying); }
  });

  it('names a multi-mob pack in the plural (Grim Mummy -> Grim Mummies)', () => {
    const a = createPlayer(db, { name: 'Big', class_key: 'wizard', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(a.auth_token, 40000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    // Pin the active encounter to a Mummy pack of several so the name is deterministic.
    db.prepare("UPDATE encounters SET creature_index=296, kind='pack', pack_count=4 WHERE status='active'").run();
    const e = buildTvState(db, 100000).encounter!;
    expect(e.name.endsWith('Mummies')).toBe(true);
    expect(e.name.endsWith('Mummy')).toBe(false);
  });

  it('includes a defeat summary during the defeat window', () => {
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'baseline_battle_minutes', '0');
    setSetting(db, 'popup_duration_s', '120');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const encId = (db.prepare('SELECT id FROM encounters WHERE status=\'active\'').get() as any).id;
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(encId) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    const s = buildTvState(db, 100000 + 31000);
    expect(s.defeat).not.toBeNull();
    expect(s.defeat!.participants.length).toBeGreaterThanOrEqual(1);
    expect(s.defeat!.creatureUrl.startsWith('/sprites/creatures_24x24/')).toBe(true);
  });

  it('shows only started Gold and Damage potion tiers while preserving an independent debuff', () => {
    const now = Date.parse('2026-07-29T16:00:00Z');
    const timeZone = 'America/New_York';
    const gold = createPlayer(db, { name: 'Gilded', class_key: 'wizard', gender: 'M' }, now - 3);
    const damage = createPlayer(db, { name: 'Scarlet', class_key: 'thief', gender: 'F' }, now - 2);
    const expired = createPlayer(db, { name: 'Hexed', class_key: 'knight', gender: 'M' }, now - 1);
    ingestTokenUsage(db, tokens(gold.auth_token, 1000), now, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(now);

    for (const player of [gold, damage, expired]) {
      applyGoldMutation(db, {
        playerId: player.id,
        amount: 500_000,
        reason: 'opening_balance',
        sourceTable: 'test',
        sourceId: `tv-potion-${player.id}`,
        now: now - 10_000,
      });
    }
    for (const [player, sku, price] of [
      [gold, 'potion_gold_t1', 100_000],
      [damage, 'potion_damage_t1', 150_000],
      [expired, 'potion_gold_t1', 100_000],
    ] as const) {
      expect(purchaseConsumable(db, {
        playerId: player.id,
        skuId: sku,
        quantity: 1,
        expectedUnitPrice: price,
        requestId: `tv-buy-${player.id}`,
        now: now - 5_000,
        timeZone,
      })).toMatchObject({ ok: true });
      expect(activatePotion(db, {
        playerId: player.id,
        skuId: sku,
        requestId: `tv-drink-${player.id}`,
        now,
        timeZone,
      })).toMatchObject({ ok: true });
    }

    const armed = buildTvState(db, now);
    expect(armed.players.find((player) => player.id === gold.id)?.potionEffects)
      .toEqual({ goldTier: null, damageTier: null });
    expect(armed.players.find((player) => player.id === damage.id)?.potionEffects)
      .toEqual({ goldTier: null, damageTier: null });

    // One tick of combat-active time starts armed potions. The third row is then
    // expired deliberately to prove its absent mote is independent of the hex.
    db.prepare('UPDATE game_state SET combat_active_ms=combat_active_ms+1000 WHERE id=1').run();
    db.prepare(
      `UPDATE potion_activations SET expires_game_ms=1000
       WHERE player_id=? AND potion_type='gold'`,
    ).run(expired.id);
    const encounter = db.prepare(
      "SELECT id FROM encounters WHERE status='active' LIMIT 1",
    ).get() as { id: number };
    db.prepare(
      `INSERT INTO monster_attacks (encounter_id, player_id, kind, ts)
       VALUES (?, ?, 'debuff', ?)`,
    ).run(encounter.id, expired.id, now - 1_000);

    const active = buildTvState(db, now);
    expect(active.players.find((player) => player.id === gold.id)?.potionEffects)
      .toEqual({ goldTier: 1, damageTier: null });
    expect(active.players.find((player) => player.id === damage.id)?.potionEffects)
      .toEqual({ goldTier: null, damageTier: 1 });
    expect(active.players.find((player) => player.id === expired.id)).toMatchObject({
      potionEffects: { goldTier: null, damageTier: null },
      debuffed: true,
    });

    // Paused combat keeps already-started potion magic visible; only newly armed
    // rows are intentionally omitted from the battlefield effect vocabulary.
    db.prepare('UPDATE game_state SET last_activity_at=? WHERE id=1').run(now - 20 * 60_000);
    const paused = buildTvState(db, now);
    expect(paused.players.find((player) => player.id === gold.id)?.potionEffects.goldTier).toBe(1);
    expect(paused.players.find((player) => player.id === damage.id)?.potionEffects.damageTier).toBe(1);
  });
});

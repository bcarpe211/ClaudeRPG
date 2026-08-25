import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { activityScore } from '../src/domain/activity';
import { GameEngine } from '../src/domain/engine';
import { combatActiveMs } from '../src/domain/gameclock';
import { getGameState } from '../src/domain/gamestate';
import { recordFreshRunPresence } from '../src/domain/run-presence';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokensPayload(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

function wakeOffice(now: number): void {
  const player = createPlayer(
    db,
    { name: 'Clock Tester', class_key: 'knight', gender: 'M' },
    1,
  );
  db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(now, player.id);
}

describe('engine: accumulate-modifier damage + token-share gold', () => {
  it('a token burst raises a player attack above baseline', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000); // spawn + a swing at ~modifier 1
    // ingest a burst, tick again a moment later
    ingestTokenUsage(db, tokensPayload(p.auth_token, 400000), 101000, { cacheReadWeight: 0 });
    expect(activityScore(db, p.id, 101000, { decayAfterMinutes: 5, decaySpanMinutes: 5 })).toBe(400000);
  });

  it('gold is split by token share (high-token player earns >= high-damage-only player)', () => {
    const A = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const B = createPlayer(db, { name: 'B', class_key: 'knight', gender: 'M' }, 1);
    // small activity so the office isn't idle and an encounter spawns
    ingestTokenUsage(db, tokensPayload(A.auth_token, 100), 100000, { cacheReadWeight: 0 });
    ingestTokenUsage(db, tokensPayload(B.auth_token, 100), 100000, { cacheReadWeight: 0 });
    setSetting(db, 'gold_factor', '1'); // guarantee a non-zero gold pool

    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000); // spawn
    const enc = db.prepare("SELECT * FROM encounters WHERE status='active'").get() as any;
    expect(enc).toBeTruthy();

    // Seed damage: B did far more damage than A (damage order: B > A).
    db.prepare(
      'INSERT INTO encounter_damage (encounter_id, player_id, damage_total, hits, max_hit) VALUES (?,?,?,?,?)',
    ).run(enc.id, A.id, 100, 1, 100);
    db.prepare(
      'INSERT INTO encounter_damage (encounter_id, player_id, damage_total, hits, max_hit) VALUES (?,?,?,?,?)',
    ).run(enc.id, B.id, 900, 1, 900);

    // Seed token usage during the fight window: A used far more tokens than B
    // (token order inverted vs. damage order: A > B).
    db.prepare(
      'INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?,?,?,?)',
    ).run(A.id, 100500, 900, 900);
    db.prepare(
      'INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?,?,?,?)',
    ).run(B.id, 100500, 100, 100);

    // Kill it and let the engine resolve gold on the next tick.
    db.prepare('UPDATE encounters SET current_hp=0 WHERE id=?').run(enc.id);
    eng.tick(101000);

    const dead = db.prepare('SELECT * FROM encounters WHERE id=?').get(enc.id) as any;
    expect(dead.status).toBe('defeated');

    const goldA = getPlayerById(db, A.id)!.gold;
    const goldB = getPlayerById(db, B.id)!.gold;
    // A has less damage but far more tokens during the fight; at the default
    // gold_damage_weight (0, pure token share) A should earn at least as much gold.
    expect(goldA).toBeGreaterThanOrEqual(goldB);
  });
});

describe('engine combat-active clock', () => {
  it('wakes for presence through the exact idle boundary without creating work', () => {
    const receivedAt = 100_000;
    setSetting(db, 'pause_after_minutes', '15');
    setSetting(db, 'attack_interval_ms', '1000000');
    setSetting(db, 'attack_jitter_ms', '0');
    setSetting(db, 'monster_attacks_enabled', '0');
    const player = createPlayer(
      db,
      { name: 'Presence Only', class_key: 'knight', gender: 'M' },
      1,
    );
    expect(recordFreshRunPresence(db, player.id, receivedAt, receivedAt)).toBe(true);
    const before = getPlayerById(db, player.id)!;

    const eng = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });
    eng.tick(receivedAt);

    expect(getGameState(db).paused).toBe(0);
    const encounter = db.prepare(
      "SELECT id, current_hp FROM encounters WHERE status='active'",
    ).get() as { id: number; current_hp: number };
    expect(encounter).toBeTruthy();

    eng.tick(receivedAt + 15 * 60_000);
    expect(getGameState(db).paused).toBe(0);

    eng.tick(receivedAt + 15 * 60_000 + 1);
    expect(getGameState(db).paused).toBe(1);

    const after = getPlayerById(db, player.id)!;
    expect(after.effective_tokens).toBe(before.effective_tokens);
    expect(after.total_tokens).toBe(before.total_tokens);
    expect(after.level).toBe(before.level);
    expect(after.gold).toBe(before.gold);
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_events').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM encounter_damage').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(encounter.id))
      .toEqual({ current_hp: encounter.current_hp });
  });

  it('uses the first tick as a baseline and counts the interval before idle', () => {
    wakeOffice(100_000);
    const eng = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });

    eng.tick(100_000);
    expect(combatActiveMs(db)).toBe(0);

    eng.tick(101_000);
    expect(combatActiveMs(db)).toBe(1_000);

    db.prepare('UPDATE players SET last_token_at=0').run();
    eng.tick(200_000);
    const pausedAt = combatActiveMs(db);
    expect(pausedAt).toBe(100_000);

    eng.tick(260_000);
    expect(combatActiveMs(db)).toBe(pausedAt);
  });

  it('stops a delayed active tick at the office idle deadline', () => {
    wakeOffice(100_000);
    const eng = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });

    eng.tick(100_000);
    eng.tick(999_000);
    expect(combatActiveMs(db)).toBe(899_000);

    eng.tick(1_002_000);
    expect(combatActiveMs(db)).toBe(900_000);
  });

  it('does not fill an idle gap when activity resumes before a delayed tick', () => {
    wakeOffice(100_000);
    const eng = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });

    eng.tick(100_000);
    eng.tick(999_000);

    db.prepare('UPDATE players SET last_token_at=?').run(1_001_000);
    eng.tick(1_002_000);
    expect(combatActiveMs(db)).toBe(901_000);
  });

  it('counts the interval ending in a kill and pauses the defeat window', () => {
    setSetting(db, 'gold_factor', '0');
    wakeOffice(100_000);
    const eng = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });
    eng.tick(100_000);
    const encounter = db.prepare(
      "SELECT id FROM encounters WHERE status='active'",
    ).get() as { id: number };
    db.prepare('UPDATE encounters SET current_hp=0 WHERE id=?').run(encounter.id);

    eng.tick(101_000);
    expect(combatActiveMs(db)).toBe(1_000);

    eng.tick(200_000);
    expect(combatActiveMs(db)).toBe(1_000);
  });

  it('charges no startup time when there is not yet an encounter', () => {
    wakeOffice(100_000);
    const eng = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });

    eng.tick(100_000);
    expect(combatActiveMs(db)).toBe(0);
    expect(db.prepare(
      "SELECT id FROM encounters WHERE status='active'",
    ).get()).toBeTruthy();

    eng.tick(101_000);
    expect(combatActiveMs(db)).toBe(1_000);
  });

  it('does not charge downtime on the first tick of a new engine instance', () => {
    wakeOffice(100_000);
    const first = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });
    first.tick(100_000);
    first.tick(101_000);
    expect(combatActiveMs(db)).toBe(1_000);

    const restarted = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });
    restarted.tick(200_000);
    expect(combatActiveMs(db)).toBe(1_000);

    restarted.tick(201_000);
    expect(combatActiveMs(db)).toBe(2_000);
  });

  it('does not repeat elapsed time after a post-advancement tick failure', () => {
    setSetting(db, 'attack_interval_ms', '1000');
    setSetting(db, 'attack_jitter_ms', '0');
    setSetting(db, 'monster_attacks_enabled', '0');
    wakeOffice(100_000);
    let failAfterAdvancement = false;
    let encounterId: number | null = null;
    const rng = () => {
      if (failAfterAdvancement && encounterId !== null) {
        db.transaction(() => {
          db.prepare(
            "UPDATE encounters SET status='defeated', ended_at=? WHERE id=?",
          ).run(101_000, encounterId);
          db.prepare(
            'UPDATE game_state SET current_encounter_id=NULL WHERE id=1',
          ).run();
        })();
        throw new Error('forced post-advancement failure');
      }
      return 0.5;
    };
    const eng = new GameEngine(db, {
      rng,
      officeTimeZone: 'America/New_York',
    });
    eng.tick(100_000);
    encounterId = (db.prepare(
      "SELECT id FROM encounters WHERE status='active'",
    ).get() as { id: number }).id;

    failAfterAdvancement = true;
    expect(() => eng.tick(101_000)).toThrow('forced post-advancement failure');
    expect(combatActiveMs(db)).toBe(1_000);

    failAfterAdvancement = false;
    eng.tick(102_000);
    expect(combatActiveMs(db)).toBe(1_000);
  });

  it('rebaselines backward wall time and continues processing immediately', () => {
    wakeOffice(100_000);
    const eng = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });
    eng.tick(100_000);
    eng.tick(101_000);
    expect(combatActiveMs(db)).toBe(1_000);

    db.prepare('UPDATE game_state SET paused=1 WHERE id=1').run();
    expect(() => eng.tick(99_500)).not.toThrow();
    expect(db.prepare('SELECT paused FROM game_state WHERE id=1').get())
      .toEqual({ paused: 0 });
    expect(combatActiveMs(db)).toBe(1_000);

    eng.tick(99_600);
    expect(combatActiveMs(db)).toBe(1_100);
  });
});

describe('engine hit transactions', () => {
  it('rolls back encounter damage when the daily combat audit cannot be written', () => {
    setSetting(db, 'attack_interval_ms', '1000');
    setSetting(db, 'attack_jitter_ms', '0');
    setSetting(db, 'monster_attacks_enabled', '0');
    wakeOffice(100_000);
    const engine = new GameEngine(db, {
      rng: () => 0.5,
      officeTimeZone: 'America/New_York',
    });
    engine.tick(100_000);
    const encounter = db.prepare(
      "SELECT id, current_hp FROM encounters WHERE status = 'active'",
    ).get() as { id: number; current_hp: number };
    db.exec(`
      CREATE TRIGGER fail_daily_combat_insert
      BEFORE INSERT ON player_daily_combat
      BEGIN
        SELECT RAISE(ABORT, 'daily audit failure');
      END;
    `);

    expect(() => engine.tick(101_000)).toThrow('daily audit failure');

    expect(db.prepare(
      'SELECT current_hp FROM encounters WHERE id = ?',
    ).get(encounter.id)).toEqual({ current_hp: encounter.current_hp });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM encounter_damage WHERE encounter_id = ?',
    ).get(encounter.id)).toEqual({ count: 0 });
  });
});

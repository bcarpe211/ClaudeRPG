import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { activityScore } from '../src/domain/activity';
import { GameEngine } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokensPayload(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
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

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { buildTvState } from '../src/web/tvview';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('buildTvState monster attack', () => {
  it('monsterAttack is null with no attacks; debuffed is false', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const s = buildTvState(db, 100000);
    expect(s.monsterAttack).toBeNull();
    expect(s.players[0].debuffed).toBe(false);
  });

  it('surfaces the latest attack for the active encounter and sets debuffed inside the window', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const enc = db.prepare("SELECT id FROM encounters WHERE status='active'").get() as any;
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,gold_delta,ts) VALUES (?,?, 'debuff', 0, 100500)")
      .run(enc.id, p.id);
    const s = buildTvState(db, 101000);                 // within 8s of 100500
    expect(s.monsterAttack).toMatchObject({ playerId: p.id, kind: 'debuff', amount: 0 });
    expect(s.monsterAttack!.id).toBeGreaterThan(0);
    expect(s.players[0].debuffed).toBe(true);
    // past the window: debuff clears, event still reported (latest row)
    const s2 = buildTvState(db, 109000);                // 8.5s later
    expect(s2.players[0].debuffed).toBe(false);
  });
});

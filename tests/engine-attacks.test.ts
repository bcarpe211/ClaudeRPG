import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('engine attacks', () => {
  it('stays paused with no activity and spawns nothing', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const eng = new GameEngine(db, { rng: () => 0 });
    eng.tick(100000);
    expect(db.prepare('SELECT COUNT(*) AS c FROM encounters').get()).toMatchObject({ c: 0 });
    expect((db.prepare('SELECT paused FROM game_state WHERE id=1').get() as any).paused).toBe(1);
  });

  it('on activity: unpauses, spawns an encounter, and players deal damage over ticks', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    // first tick: unpause + spawn (no attack yet because timers are scheduled into the future)
    eng.tick(100000);
    const enc = db.prepare("SELECT * FROM encounters WHERE status='active'").get() as any;
    expect(enc).toBeTruthy();
    const hp0 = enc.current_hp;
    // advance several ticks past the attack interval so a swing lands
    for (let t = 1; t <= 10; t++) eng.tick(100000 + t * 1000);
    const enc2 = db.prepare('SELECT * FROM encounters WHERE id=?').get(enc.id) as any;
    expect(enc2.current_hp).toBeLessThan(hp0);
    const dmg = db.prepare('SELECT * FROM encounter_damage WHERE encounter_id=?').all(enc.id) as any[];
    expect(dmg.length).toBe(1);
    expect(dmg[0].hits).toBeGreaterThan(0);
  });

  it('levels a player up from cumulative effective tokens and records it', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    // 60000 effective tokens -> level 2 (base_xp 50000)
    ingestTokenUsage(db, tokens(p.auth_token, 60000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    expect(getPlayerById(db, p.id)!.level).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM level_ups WHERE player_id=?').get(p.id) as any).c).toBe(1);
  });
});

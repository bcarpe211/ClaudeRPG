import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
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

describe('engine kill resolution', () => {
  it('marks defeated, awards gold by damage share, and opens a defeat window', () => {
    // tiny HP so a few swings kill it, gold_factor=1 so even 1hp yields gold
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'target_battle_minutes', '0'); // HP -> floor of 1
    setSetting(db, 'gold_factor', '1');
    setSetting(db, 'popup_duration_s', '120');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000); // spawn
    const enc = db.prepare("SELECT * FROM encounters WHERE status='active'").get() as any;
    // tick until the encounter dies
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(enc.id) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    const dead = db.prepare('SELECT * FROM encounters WHERE id=?').get(enc.id) as any;
    expect(dead.status).toBe('defeated');
    expect(dead.ended_at).toBeGreaterThan(0);
    expect(getPlayerById(db, p.id)!.gold).toBeGreaterThan(0);
    const gs = db.prepare('SELECT * FROM game_state WHERE id=1').get() as any;
    expect(gs.defeat_until).toBeGreaterThan(0);
    expect(gs.last_defeat_encounter_id).toBe(enc.id);
  });

  it('after the defeat window, the next encounter spawns', () => {
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'target_battle_minutes', '0');
    setSetting(db, 'popup_duration_s', '5');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const first = db.prepare("SELECT * FROM encounters WHERE status='active'").get() as any;
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(first.id) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    // keep activity fresh so the office isn't idle
    ingestTokenUsage(db, tokens(p.auth_token, 10), 200000, { cacheReadWeight: 0 });
    eng.tick(200000); // well past defeat_until (5s)
    const active = db.prepare("SELECT * FROM encounters WHERE status='active'").get() as any;
    expect(active).toBeTruthy();
    expect(active.id).not.toBe(first.id);
  });
});

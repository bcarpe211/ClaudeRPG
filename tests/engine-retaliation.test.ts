import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

// keep the office active + no accidental kills so we can observe retaliation
function activeGame() {
  setSetting(db, 'min_encounter_hp', '100000000'); // huge HP: never dies during the test
  const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
  ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
  return p;
}

describe('engine monster retaliation', () => {
  it('does not attack on the first active tick, then strikes after the interval', () => {
    const p = activeGame();
    // rng=0.5 => jitter 0; target index floor(0.5*1)=0 (the only player); consequence 0.5 => debuff
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);                       // spawn + arm monster timer (interval 15000 -> fires at 115000)
    expect(db.prepare('SELECT COUNT(*) c FROM monster_attacks').get()).toMatchObject({ c: 0 });
    // keep activity fresh so the office isn't idle, then tick past 115000
    ingestTokenUsage(db, tokens(p.auth_token, 10), 116000, { cacheReadWeight: 0 });
    eng.tick(116000);
    const rows = db.prepare('SELECT * FROM monster_attacks').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].player_id).toBe(p.id);
    expect(rows[0].kind).toBe('debuff');    // rng 0.5 -> debuff
  });

  it('a gold roll on a broke player re-rolls to debuff (a hit always lands)', () => {
    const p = activeGame();
    // Draw order across the two ticks: arm-schedule (tick1), fire-schedule, pickTarget,
    // rollConsequence (tick2). The 4th draw clamps to the last element (0.1 -> gold).
    // Player has 0 gold, so the gold roll re-rolls to debuff.
    const seq = [0, 0, 0.1]; let i = 0;
    const rng = () => seq[Math.min(i++, seq.length - 1)];
    const eng = new GameEngine(db, { rng });
    eng.tick(100000);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 116000, { cacheReadWeight: 0 });
    eng.tick(116000);
    const row = db.prepare('SELECT * FROM monster_attacks ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.kind).toBe('debuff');
    expect(row.gold_delta).toBe(0);
    expect(getPlayerById(db, p.id)!.gold).toBe(0);    // unchanged
  });

  it('a gold roll on a player with gold steals up to the cap and logs it', () => {
    const p = activeGame();
    db.prepare('UPDATE players SET gold=100 WHERE id=?').run(p.id);
    // Same draw order as above; 4th draw clamps to 0.1 -> gold. Player has gold -> steal.
    const seq = [0, 0, 0.1]; let i = 0;
    const eng = new GameEngine(db, { rng: () => seq[Math.min(i++, seq.length - 1)] });
    eng.tick(100000);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 116000, { cacheReadWeight: 0 });
    eng.tick(116000);
    const row = db.prepare('SELECT * FROM monster_attacks ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.kind).toBe('gold');
    expect(row.gold_delta).toBe(5);                   // monster_gold_steal default
    expect(getPlayerById(db, p.id)!.gold).toBe(95);
  });

  it('monster_attacks_enabled=0 suppresses all retaliation', () => {
    const p = activeGame();
    setSetting(db, 'monster_attacks_enabled', '0');
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 200000, { cacheReadWeight: 0 });
    eng.tick(200000);
    expect(db.prepare('SELECT COUNT(*) c FROM monster_attacks').get()).toMatchObject({ c: 0 });
  });

  it('a logged debuff reduces the debuffed player\'s next swing', () => {
    const p = activeGame();
    setSetting(db, 'attack_jitter_ms', '0');          // deterministic swing schedule
    // Insert a debuff covering the swing at t=104000 (first swing ~interval after spawn).
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);                                 // spawn; swing armed for ~104000
    const enc = db.prepare("SELECT id FROM encounters WHERE status='active'").get() as any;
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,ts) VALUES (?,?, 'debuff', 104000)")
      .run(enc.id, p.id);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 104000, { cacheReadWeight: 0 });
    eng.tick(104000);                                 // swing lands debuffed
    const dmg = (db.prepare('SELECT max_hit FROM encounter_damage WHERE player_id=?').get(p.id) as any).max_hit;
    // base_hit=100, level 1 (damageMultiplier=1), modifier≈1, debuff 0.85 -> ~85
    expect(dmg).toBeLessThan(100);
  });
});

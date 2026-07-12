import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { buildTvState } from '../src/web/tvview';
import { monsterByIndex } from '../src/domain/bestiary';

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
});

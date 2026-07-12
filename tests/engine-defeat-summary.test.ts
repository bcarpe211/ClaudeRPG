import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine, buildDefeatSummary } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('buildDefeatSummary', () => {
  it('summarizes per-player damage, gold, mvp, and creature for a defeated encounter', () => {
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'baseline_battle_minutes', '0');
    const p = createPlayer(db, { name: 'Aragorn', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const enc = db.prepare('SELECT * FROM encounters WHERE status=\'active\'').get() as any;
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(enc.id) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    const sum = buildDefeatSummary(db, enc.id);
    expect(sum.encounterId).toBe(enc.id);
    expect(sum.creatureIndex).toBe(enc.creature_index);
    expect(sum.totalDamage).toBeGreaterThan(0);
    expect(sum.participants.length).toBe(1);
    expect(sum.participants[0].name).toBe('Aragorn');
    expect(sum.participants[0].damage).toBeGreaterThan(0);
    expect(sum.participants[0].gold).toBeGreaterThanOrEqual(0);
    expect(sum.mvpPlayerId).toBe(p.id);
  });
});

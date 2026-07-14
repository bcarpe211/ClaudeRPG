import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
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

describe('engine peak_modifier', () => {
  it('rises to the activity modifier on a high-activity swing and never decreases', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    // token_modifier_k default 20000; 200000 effective -> modifier 1 + 200000/20000 = 11
    ingestTokenUsage(db, tokens(p.auth_token, 200000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);                 // spawn; first swing armed for ~104000
    eng.tick(104000);                 // swing lands at high activity
    const peak = getPlayerById(db, p.id)!.peak_modifier;
    expect(peak).toBeGreaterThan(5);  // ~11 at t=104000

    // Much later, activity has decayed to ~1; peak must not drop.
    const later = 100000 + 60 * 60_000; // +60 min, well past decay
    ingestTokenUsage(db, tokens(p.auth_token, 10), later, { cacheReadWeight: 0 });
    eng.tick(later);
    eng.tick(later + 4000);
    expect(getPlayerById(db, p.id)!.peak_modifier).toBeCloseTo(peak);
  });
});

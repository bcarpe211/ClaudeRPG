import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { currentLayout, generateDungeon } from '../src/domain/dungeon';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('currentLayout', () => {
  it('returns null when no dungeon is active', () => {
    expect(currentLayout(db)).toBeNull();
  });

  it('returns the deterministic layout for the active dungeon', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000); // spawns a dungeon
    const d = db.prepare('SELECT theme, seed FROM dungeons ORDER BY id DESC LIMIT 1').get() as any;
    const layout = currentLayout(db)!;
    expect(layout).not.toBeNull();
    expect(layout.theme).toBe(d.theme);
    expect(layout.seed).toBe(d.seed);
    expect(layout).toEqual(generateDungeon(d.theme, d.seed));
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { buildTvLayout, assignHeroSlots } from '../src/web/tvview';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('assignHeroSlots', () => {
  it('zips players to slots in order; extras get no slot', () => {
    const players = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const slots = [{ x: 5, y: 5 }, { x: 6, y: 6 }];
    const out = assignHeroSlots(players, slots);
    expect(out).toEqual([
      { id: 1, x: 5, y: 5 },
      { id: 2, x: 6, y: 6 },
      { id: 3, x: null, y: null },
    ]);
  });
});

describe('buildTvLayout', () => {
  it('returns null when no dungeon is active', () => {
    expect(buildTvLayout(db)).toBeNull();
  });

  it('maps the active dungeon to sprite URLs', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const layout = buildTvLayout(db)!;
    expect(layout).not.toBeNull();
    expect(layout.width).toBe(20);
    expect(layout.height).toBe(15);
    expect(layout.dungeonId).toBeGreaterThan(0);
    // every cell has a /sprites/world_24x24/ url and a type
    for (const row of layout.cells) for (const c of row) {
      expect(c.url.startsWith('/sprites/world_24x24/')).toBe(true);
      expect(['wall', 'floor', 'door']).toContain(c.type);
    }
    expect(layout.monster.x).toBeGreaterThan(0);
    for (const d of layout.decor) expect(d.url.startsWith('/sprites/world_24x24/')).toBe(true);
  });
});

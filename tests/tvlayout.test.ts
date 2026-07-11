import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { getDungeon, DUNGEONS } from '../src/domain/floorgroups';
import { currentTvLayout } from '../src/web/tvlayout';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}
function activeDungeon() {
  const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
  ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
  new GameEngine(db, { rng: () => 0.5 }).tick(100000);
}
function setTheme(name: string) {
  db.prepare('UPDATE dungeons SET theme=? WHERE id=(SELECT current_dungeon_id FROM game_state WHERE id=1)').run(name);
}

describe('currentTvLayout', () => {
  it('returns null when no dungeon is active', () => {
    expect(currentTvLayout(db)).toBeNull();
  });

  it('maps an active dungeon to sheet cells + monster zone + hero slots', () => {
    activeDungeon();
    setTheme('Greystone Keep');
    const L = currentTvLayout(db)!;
    expect(L).not.toBeNull();
    expect(L.theme).toBe('Greystone Keep');
    expect(L.width).toBe(20);
    expect(L.height).toBe(15);
    expect(L.dungeonId).toBeGreaterThan(0);
    expect(L.cells.length).toBe(15);
    expect(L.cells[0].length).toBe(20);
    for (const row of L.cells) for (const c of row) {
      expect(Number.isInteger(c.col)).toBe(true);
      expect(Number.isInteger(c.row)).toBe(true);
      expect(['wall', 'floor', 'door']).toContain(c.type);
    }
    // fixed 2x2 centre monster zone
    expect(L.monster).toEqual({ x: 9, y: 6, footprint: 2 });
    // hero slots: <=24, all interior floor, none in the monster zone or on a door
    const doorKey = new Set(L.doors.map((d) => `${d.x},${d.y}`));
    expect(L.heroSlots.length).toBeGreaterThan(0);
    expect(L.heroSlots.length).toBeLessThanOrEqual(24);
    for (const s of L.heroSlots) {
      expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(19);
      expect(s.y).toBeGreaterThan(0); expect(s.y).toBeLessThan(14);
      expect(L.cells[s.y][s.x].type).toBe('floor');
      const inMonster = s.x >= 9 && s.x <= 10 && s.y >= 6 && s.y <= 7;
      expect(inMonster).toBe(false);
      expect(doorKey.has(`${s.x},${s.y}`)).toBe(false);
    }
    // door cells carry a floor underlay
    for (const d of L.doors) expect(L.cells[d.y][d.x].under).toBeDefined();
    // deterministic
    expect(currentTvLayout(db)).toEqual(L);
  });

  it('falls back to a default dungeon on an unknown/legacy theme (no throw)', () => {
    activeDungeon();
    setTheme('stone_crypt'); // old theme, not a dungeon2 name
    expect(getDungeon('stone_crypt')).toBeUndefined();
    const L = currentTvLayout(db)!;
    expect(L).not.toBeNull();
    expect(L.theme).toBe('Greystone Keep');
    expect(L.cells.length).toBe(15);
  });

  it('never throws across the full dungeon roster (live adapter, never-throw guard)', () => {
    activeDungeon();
    for (const d of DUNGEONS) {
      setTheme(d.name);
      const L = currentTvLayout(db);
      expect(L).not.toBeNull();
      expect(L!.width).toBe(20);
      expect(L!.height).toBe(15);
      expect(L!.theme).toBe(d.name);
    }
  });
});

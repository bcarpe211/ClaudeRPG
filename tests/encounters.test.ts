import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import {
  estimateOfficeDamagePerMinute,
  calibrateHp,
  advanceToNextEncounter,
  loadEngineConfig,
} from '../src/domain/encounters';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

describe('calibrateHp', () => {
  it('is officeDpm * minutes * difficulty, floored at minHp', () => {
    expect(calibrateHp(1000, 30, 1, 2000)).toBe(30000);
    expect(calibrateHp(1, 1, 1, 2000)).toBe(2000); // floor
  });
});

describe('estimateOfficeDamagePerMinute', () => {
  it('sums per-player DPM for enabled players, modifier floored at 1', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    createPlayer(db, { name: 'B', class_key: 'thief', gender: 'F' }, 1);
    const cfg = loadEngineConfig(db);
    const dpm = estimateOfficeDamagePerMinute(db, cfg, 100000);
    // 2 players, level 1 mult 1.0, modifier 1.0, baseHit 100, interval 4000ms
    // swings/min = 60000/4000 = 15; dpm/player = 15*100 = 1500; office = 3000
    expect(dpm).toBeCloseTo(3000, 0);
  });
});

describe('advanceToNextEncounter', () => {
  // rng that always returns 0: selects minimum branches (regular_count = min = 2, 'single' kind, first creature)
  const rng = () => 0;

  it('spawns dungeon level 1 + encounter index 0 when none exists', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    advanceToNextEncounter(db, 1000, loadEngineConfig(db), rng);
    const d = db.prepare('SELECT * FROM dungeons').get() as any;
    const e = db.prepare('SELECT * FROM encounters').get() as any;
    expect(d.level).toBe(1);
    expect(e.index_in_dungeon).toBe(0);
    expect(e.current_hp).toBe(e.max_hp);
    expect(e.max_hp).toBeGreaterThan(0);
    const gs = db.prepare('SELECT * FROM game_state WHERE id=1').get() as any;
    expect(gs.current_encounter_id).toBe(e.id);
  });

  it('progresses through regulars then a boss, then a new dungeon', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const cfg = loadEngineConfig(db);
    // rng=0 => regular_count = min = 2 (floor(0*(3-2+1))+2 = 2), always 'single' kind
    advanceToNextEncounter(db, 1, cfg, rng); // dungeon1 enc0
    let encs = db.prepare('SELECT * FROM encounters ORDER BY id').all() as any[];
    const d1 = (db.prepare('SELECT * FROM dungeons ORDER BY id').get() as any);
    expect(d1.regular_count).toBe(2); // verify determinism: rng=0 => 2 regulars
    // mark enc0 defeated and advance
    db.prepare("UPDATE encounters SET status='defeated' WHERE id=?").run(encs[0].id);
    advanceToNextEncounter(db, 2, cfg, rng); // enc1 (last regular)
    encs = db.prepare('SELECT * FROM encounters ORDER BY id').all() as any[];
    // regular_count=2 so index1 is the last regular; defeat it, next is boss
    db.prepare("UPDATE encounters SET status='defeated' WHERE id=?").run(encs[1].id);
    advanceToNextEncounter(db, 3, cfg, rng);
    encs = db.prepare('SELECT * FROM encounters ORDER BY id').all() as any[];
    const boss = encs[encs.length - 1];
    expect(boss.kind).toBe('boss');
    expect(boss.footprint).toBe(2);
    // defeat boss -> new dungeon level 2
    db.prepare("UPDATE encounters SET status='defeated' WHERE id=?").run(boss.id);
    advanceToNextEncounter(db, 4, cfg, rng);
    const dungeons = db.prepare('SELECT * FROM dungeons ORDER BY id').all() as any[];
    expect(dungeons.length).toBe(2);
    expect(dungeons[1].level).toBe(2);
  });
});

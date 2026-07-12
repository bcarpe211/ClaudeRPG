import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import {
  estimateOfficeBaselineDpm,
  calibrateHp,
  advanceToNextEncounter,
  loadEngineConfig,
} from '../src/domain/encounters';
import { monsterByIndex } from '../src/domain/bestiary';
import { themeMonsters } from '../src/domain/dungeonthemes';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

describe('loadEngineConfig robustness', () => {
  it('falls back to defaults for unparseable or non-finite knob values', () => {
    setSetting(db, 'attack_interval_ms', 'abc'); // NaN -> should use default 4000
    setSetting(db, 'base_hit', '');              // Number('') = 0 (finite) -> 0 kept
    const cfg = loadEngineConfig(db);
    expect(Number.isFinite(cfg.attackIntervalMs)).toBe(true);
    expect(cfg.attackIntervalMs).toBe(4000); // default
    expect(Number.isFinite(cfg.baseHit)).toBe(true);
  });
});

describe('calibrateHp', () => {
  it('is officeDpm * minutes * difficulty, floored at minHp', () => {
    expect(calibrateHp(1000, 30, 1, 2000)).toBe(30000);
    expect(calibrateHp(1, 1, 1, 2000)).toBe(2000); // floor
  });
});

describe('estimateOfficeBaselineDpm', () => {
  it('sums per-player DPM at level baseline, ignoring token activity', () => {
    const a = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    createPlayer(db, { name: 'B', class_key: 'thief', gender: 'F' }, 1);
    const cfg = loadEngineConfig(db);
    const before = estimateOfficeBaselineDpm(db, cfg);
    // 2 players, level 1 mult 1.0, baseHit 100, interval 4000 -> 15*100*2 = 3000
    expect(before).toBeCloseTo(3000, 0);
    // adding recent tokens must NOT change baseline HP input (decoupled from activity)
    db.prepare('INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?,?,?,?)')
      .run(a.id, 100000, 1_000_000, 1_000_000);
    expect(estimateOfficeBaselineDpm(db, cfg)).toBeCloseTo(3000, 0);
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

describe('spawned encounter respects the dungeon theme', () => {
  it('creature_index is a bestiary monster in the theme categories', () => {
    advanceToNextEncounter(db, 100000, loadEngineConfig(db), () => 0.3);
    const gs = db.prepare('SELECT current_dungeon_id, current_encounter_id FROM game_state WHERE id=1').get() as any;
    const d = db.prepare('SELECT theme FROM dungeons WHERE id=?').get(gs.current_dungeon_id) as any;
    const e = db.prepare('SELECT creature_index, footprint FROM encounters WHERE id=?').get(gs.current_encounter_id) as any;
    const m = monsterByIndex(e.creature_index);
    expect(m).toBeDefined();
    const tm = themeMonsters(d.theme);
    const allowed = new Set([...(tm.bossCategories ?? []), ...tm.categories]);
    expect(allowed.has(m!.category)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('monster_attacks migration', () => {
  it('creates the monster_attacks table with the expected columns', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r: any) => r.name);
    expect(tables).toContain('monster_attacks');
    const cols = db.prepare("PRAGMA table_info(monster_attacks)").all().map((r: any) => r.name);
    expect(cols.sort()).toEqual(['encounter_id', 'gold_delta', 'id', 'kind', 'player_id', 'ts']);
  });

  it('accepts an insert and defaults gold_delta to 0', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
    db.prepare(`INSERT INTO encounters
      (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at)
      VALUES (1,0,'single',1,1,1,100,100,'active',0)`).run();
    db.prepare('INSERT INTO players (name,class_key,gender,auth_token,created_at) VALUES (?,?,?,?,0)')
      .run('A', 'knight', 'M', 'tok');
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,ts) VALUES (1,1,'debuff',500)").run();
    const row = db.prepare('SELECT * FROM monster_attacks WHERE id=1').get() as any;
    expect(row.gold_delta).toBe(0);
    expect(row.kind).toBe('debuff');
  });
});

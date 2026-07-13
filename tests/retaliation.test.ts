import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { pickTarget, rollConsequence, goldSteal, debuffFactor } from '../src/domain/retaliation';

const cfg = { monsterDebuffFactor: 0.85, monsterDebuffSeconds: 8 };

describe('retaliation helpers', () => {
  it('pickTarget returns null on empty, else an element chosen by rng', () => {
    expect(pickTarget([], () => 0)).toBeNull();
    const arr = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(pickTarget(arr, () => 0)!.id).toBe(1);
    expect(pickTarget(arr, () => 0.99)!.id).toBe(3);
  });

  it('rollConsequence: <0.5 gold, >=0.5 debuff', () => {
    expect(rollConsequence(() => 0.1)).toBe('gold');
    expect(rollConsequence(() => 0.5)).toBe('debuff');
    expect(rollConsequence(() => 0.9)).toBe('debuff');
  });

  it('goldSteal clamps to balance and never goes negative', () => {
    expect(goldSteal(100, 5)).toBe(5);
    expect(goldSteal(3, 5)).toBe(3);
    expect(goldSteal(0, 5)).toBe(0);
    expect(goldSteal(-10, 5)).toBe(0);
  });

  it('debuffFactor is <1 only while a debuff row is inside the window', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
    db.prepare(`INSERT INTO encounters
      (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at)
      VALUES (1,0,'single',1,1,1,100,100,'active',0)`).run();
    db.prepare('INSERT INTO players (name,class_key,gender,auth_token,created_at) VALUES (?,?,?,?,0)')
      .run('A', 'knight', 'M', 'tok');
    // no rows yet
    expect(debuffFactor(db, 1, 10_000, cfg)).toBe(1);
    // a debuff at t=10_000; window is 8s
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,ts) VALUES (1,1,'debuff',10000)").run();
    expect(debuffFactor(db, 1, 10_000, cfg)).toBeCloseTo(0.85);        // same instant
    expect(debuffFactor(db, 1, 17_999, cfg)).toBeCloseTo(0.85);        // inside 8s
    expect(debuffFactor(db, 1, 18_001, cfg)).toBe(1);                  // expired
    // a gold row must NOT trigger a debuff
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,gold_delta,ts) VALUES (1,1,'gold',5,30000)").run();
    expect(debuffFactor(db, 1, 30_000, cfg)).toBe(1);
  });
});

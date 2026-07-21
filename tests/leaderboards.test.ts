import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import { buildLeaderboards } from '../src/domain/leaderboards';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

const cfg = { decayAfterMinutes: 5, decaySpanMinutes: 5, tokenModifierK: 20000, modifierCap: 200 };

function mkPlayer(name: string, over: Partial<{ level: number; effective_tokens: number; gold: number; peak_modifier: number; disabled: number }> = {}) {
  const p = createPlayer(db, { name, class_key: 'knight', gender: 'M' }, 1);
  db.prepare('UPDATE players SET level=?, effective_tokens=?, gold=?, peak_modifier=?, disabled=? WHERE id=?')
    .run(over.level ?? 1, over.effective_tokens ?? 0, over.gold ?? 0, over.peak_modifier ?? 1, over.disabled ?? 0, p.id);
  return p.id;
}
function board(bs: ReturnType<typeof buildLeaderboards>, key: string) { return bs.find((b) => b.key === key)!; }
function ids(b: { entries: { playerId: number }[] }) { return b.entries.map((e) => e.playerId); }

// a defeated encounter with per-player damage; returns encounter id
function defeatedEncounter(dmg: { playerId: number; total: number; max: number }[]) {
  db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
  const dId = db.prepare('SELECT MAX(id) m FROM dungeons').get() as any;
  const info = db.prepare(`INSERT INTO encounters
    (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at,ended_at)
    VALUES (?,0,'single',1,1,1,100,0,'defeated',0,1)`).run(dId.m);
  const encId = Number(info.lastInsertRowid);
  for (const d of dmg) db.prepare('INSERT INTO encounter_damage (encounter_id,player_id,damage_total,hits,max_hit) VALUES (?,?,?,1,?)')
    .run(encId, d.playerId, d.total, d.max);
  return encId;
}

describe('buildLeaderboards', () => {
  it('overall tokens: sorted desc, disabled excluded, ties break by name', () => {
    const a = mkPlayer('Bob', { effective_tokens: 100 });
    const b = mkPlayer('Amy', { effective_tokens: 100 });
    const c = mkPlayer('Cara', { effective_tokens: 500 });
    mkPlayer('Dan', { effective_tokens: 999, disabled: 1 });
    const bs = buildLeaderboards(db, 1000, cfg);
    // Cara (500), then Amy/Bob tie at 100 -> name asc (Amy before Bob); Dan excluded
    expect(ids(board(bs, 'overall_tokens'))).toEqual([c, b, a]);
  });

  it('gold, level, peak_multiplier read player columns', () => {
    const a = mkPlayer('A', { gold: 50, level: 3, peak_modifier: 4.2 });
    const b = mkPlayer('B', { gold: 10, level: 9, peak_modifier: 1 });
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(ids(board(bs, 'gold'))).toEqual([a, b]);
    expect(ids(board(bs, 'level'))).toEqual([b, a]);
    expect(ids(board(bs, 'peak_multiplier'))).toEqual([a, b]);
    expect(board(bs, 'peak_multiplier').entries[0].value).toBeCloseTo(4.2);
    expect(board(bs, 'gold').format).toBe('gold');
  });

  it('damage boards: total, biggest hit, monsters slain, mvp count', () => {
    const a = mkPlayer('A');
    const b = mkPlayer('B');
    // enc1: A 30/30, B 70/70  -> B mvp; enc2: A 90/50, B 10/10 -> A mvp
    defeatedEncounter([{ playerId: a, total: 30, max: 30 }, { playerId: b, total: 70, max: 70 }]);
    defeatedEncounter([{ playerId: a, total: 90, max: 50 }, { playerId: b, total: 10, max: 10 }]);
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(board(bs, 'total_damage').entries.find((e) => e.playerId === a)!.value).toBe(120);
    expect(board(bs, 'total_damage').entries.find((e) => e.playerId === b)!.value).toBe(80);
    expect(board(bs, 'biggest_hit').entries.find((e) => e.playerId === b)!.value).toBe(70);
    expect(board(bs, 'monsters_slain').entries.find((e) => e.playerId === a)!.value).toBe(2);
    // each of A and B is MVP of exactly one encounter
    expect(board(bs, 'mvp_count').entries.find((e) => e.playerId === a)!.value).toBe(1);
    expect(board(bs, 'mvp_count').entries.find((e) => e.playerId === b)!.value).toBe(1);
  });

  it('monster_attacks flavor boards', () => {
    const a = mkPlayer('A');
    const b = mkPlayer('B');
    db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
    db.prepare(`INSERT INTO encounters (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at) VALUES (1,0,'single',1,1,1,100,100,'active',0)`).run();
    const ins = db.prepare('INSERT INTO monster_attacks (encounter_id,player_id,kind,gold_delta,ts) VALUES (1,?,?,?,0)');
    ins.run(a, 'gold', 5); ins.run(a, 'debuff', 0); ins.run(a, 'gold', 5); // A: 3 hits, 10 gold
    ins.run(b, 'debuff', 0);                                               // B: 1 hit, 0 gold
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(ids(board(bs, 'most_battered'))).toEqual([a, b]);
    expect(board(bs, 'most_battered').entries.find((e) => e.playerId === a)!.value).toBe(3);
    expect(board(bs, 'most_gold_stolen').entries.find((e) => e.playerId === a)!.value).toBe(10);
    expect(board(bs, 'most_gold_stolen').entries.find((e) => e.playerId === b)!.value).toBe(0);
  });

  it('today vs older tokens, and days-as-champion counts per day winner', () => {
    const a = mkPlayer('A');
    const b = mkPlayer('B');
    // Use a fixed "now" and craft events relative to local midnight.
    const now = new Date(2026, 6, 13, 15, 0, 0).getTime(); // Jul 13 2026 15:00 local
    const startToday = new Date(2026, 6, 13, 0, 0, 0).getTime();
    const yesterday = new Date(2026, 6, 12, 10, 0, 0).getTime();
    const ins = db.prepare('INSERT INTO token_events (player_id,ts,effective_delta,total_delta) VALUES (?,?,?,?)');
    // today: A 300, B 100 -> A champion today; today_tokens A>B
    ins.run(a, startToday + 3_600_000, 300, 300);
    ins.run(b, startToday + 3_600_000, 100, 100);
    // yesterday: B 500, A 50 -> B champion yesterday
    ins.run(a, yesterday, 50, 50);
    ins.run(b, yesterday, 500, 500);
    const bs = buildLeaderboards(db, now, cfg);
    expect(board(bs, 'today_tokens').entries.find((e) => e.playerId === a)!.value).toBe(300);
    expect(board(bs, 'today_tokens').entries.find((e) => e.playerId === b)!.value).toBe(100);
    // each won one day
    expect(board(bs, 'days_champion').entries.find((e) => e.playerId === a)!.value).toBe(1);
    expect(board(bs, 'days_champion').entries.find((e) => e.playerId === b)!.value).toBe(1);
  });

  it('returns all 14 boards in the fixed order', () => {
    mkPlayer('A');
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(bs.map((b) => b.key)).toEqual([
      'overall_tokens', 'total_damage', 'gold', 'level', 'monsters_slain', 'mvp_count',
      'biggest_hit', 'on_fire', 'peak_multiplier', 'today_tokens', 'week_tokens',
      'days_champion', 'most_battered', 'most_gold_stolen',
    ]);
    expect(bs.every((b) => b.entries.every((e) => e.avatarUrl.startsWith('/sprites/creatures_24x24/')))).toBe(true);
  });
});

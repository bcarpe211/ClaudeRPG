import type Database from 'better-sqlite3';
import { classSpriteUrl, type Gender } from './classes';
import { activityScore, type ActivityCfg } from './activity';
import { tokenModifier } from './combat';

export type BoardFormat = 'tokens' | 'gold' | 'count' | 'multiplier' | 'damage' | 'level';
export interface BoardEntry { playerId: number; name: string; avatarUrl: string; value: number; }
export interface Leaderboard { key: string; title: string; format: BoardFormat; entries: BoardEntry[]; }
export type Leaderboards = Leaderboard[];
export interface LeaderboardCfg extends ActivityCfg { tokenModifierK: number; modifierCap: number; }

interface PlayerRow {
  id: number; name: string; class_key: string; gender: string;
  level: number; effective_tokens: number; gold: number; peak_modifier: number;
}

const DAY_MS = 86_400_000;

function startOfLocalDay(now: number): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}
function startOfLocalWeek(now: number): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setDate(d.getDate() - dow); return d.getTime();
}
function dayKey(ts: number): string {
  const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function buildLeaderboards(
  db: Database.Database, now: number, cfg: LeaderboardCfg,
): Leaderboards {
  const players = db.prepare(
    'SELECT id, name, class_key, gender, level, effective_tokens, gold, peak_modifier FROM players WHERE disabled = 0',
  ).all() as PlayerRow[];

  const rank = (value: (p: PlayerRow) => number): BoardEntry[] =>
    players
      .map((p) => ({ playerId: p.id, name: p.name, avatarUrl: classSpriteUrl(p.class_key, p.gender as Gender), value: value(p) }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  // Damage aggregates.
  const dmgTotal = new Map<number, number>(), dmgMax = new Map<number, number>();
  for (const r of db.prepare('SELECT player_id, SUM(damage_total) s, MAX(max_hit) m FROM encounter_damage GROUP BY player_id').all() as any[]) {
    dmgTotal.set(r.player_id, r.s ?? 0); dmgMax.set(r.player_id, r.m ?? 0);
  }
  const slain = new Map<number, number>();
  for (const r of db.prepare(
    "SELECT ed.player_id p, COUNT(DISTINCT ed.encounter_id) c FROM encounter_damage ed JOIN encounters e ON e.id = ed.encounter_id WHERE e.status='defeated' GROUP BY ed.player_id",
  ).all() as any[]) slain.set(r.p, r.c);

  // MVP: top damage per defeated encounter (tie -> lowest player_id).
  const mvp = new Map<number, number>(); const seenEnc = new Set<number>();
  for (const r of db.prepare(
    "SELECT ed.encounter_id, ed.player_id FROM encounter_damage ed JOIN encounters e ON e.id = ed.encounter_id WHERE e.status='defeated' ORDER BY ed.encounter_id, ed.damage_total DESC, ed.player_id ASC",
  ).all() as { encounter_id: number; player_id: number }[]) {
    if (seenEnc.has(r.encounter_id)) continue;
    seenEnc.add(r.encounter_id);
    mvp.set(r.player_id, (mvp.get(r.player_id) ?? 0) + 1);
  }

  // Flavor from monster_attacks.
  const battered = new Map<number, number>(), robbed = new Map<number, number>();
  for (const r of db.prepare(
    "SELECT player_id, COUNT(*) c, COALESCE(SUM(CASE WHEN kind='gold' THEN gold_delta ELSE 0 END), 0) g FROM monster_attacks GROUP BY player_id",
  ).all() as any[]) { battered.set(r.player_id, r.c); robbed.set(r.player_id, r.g); }

  // Live: current activity modifier.
  const fire = new Map<number, number>();
  for (const p of players) fire.set(p.id, tokenModifier(activityScore(db, p.id, now, cfg), cfg.tokenModifierK, cfg.modifierCap));

  // Windowed: one 90-day scan, bucketed in JS by server-local day.
  const events = db.prepare(
    'SELECT player_id, ts, effective_delta FROM token_events WHERE ts >= ?',
  ).all(now - 90 * DAY_MS) as { player_id: number; ts: number; effective_delta: number }[];
  const startToday = startOfLocalDay(now), startWeek = startOfLocalWeek(now);
  const today = new Map<number, number>(), week = new Map<number, number>();
  const perDay = new Map<string, Map<number, number>>();
  for (const e of events) {
    if (e.ts >= startToday) today.set(e.player_id, (today.get(e.player_id) ?? 0) + e.effective_delta);
    if (e.ts >= startWeek) week.set(e.player_id, (week.get(e.player_id) ?? 0) + e.effective_delta);
    const k = dayKey(e.ts);
    let m = perDay.get(k); if (!m) { m = new Map(); perDay.set(k, m); }
    m.set(e.player_id, (m.get(e.player_id) ?? 0) + e.effective_delta);
  }
  const champ = new Map<number, number>();
  for (const [, m] of perDay) {
    let bestId = -1, bestVal = -Infinity;
    for (const [pid, v] of m) if (v > bestVal || (v === bestVal && pid < bestId)) { bestVal = v; bestId = pid; }
    if (bestId >= 0 && bestVal > 0) champ.set(bestId, (champ.get(bestId) ?? 0) + 1);
  }

  return [
    { key: 'overall_tokens', title: 'Overall Tokens', format: 'tokens', entries: rank((p) => p.effective_tokens) },
    { key: 'total_damage', title: 'Total Damage', format: 'damage', entries: rank((p) => dmgTotal.get(p.id) ?? 0) },
    { key: 'gold', title: 'Gold on Hand', format: 'gold', entries: rank((p) => p.gold) },
    { key: 'level', title: 'Level', format: 'level', entries: rank((p) => p.level) },
    { key: 'monsters_slain', title: 'Monsters Slain', format: 'count', entries: rank((p) => slain.get(p.id) ?? 0) },
    { key: 'mvp_count', title: 'MVP Count', format: 'count', entries: rank((p) => mvp.get(p.id) ?? 0) },
    { key: 'biggest_hit', title: 'Biggest Hit', format: 'damage', entries: rank((p) => dmgMax.get(p.id) ?? 0) },
    { key: 'on_fire', title: 'On Fire Now', format: 'multiplier', entries: rank((p) => fire.get(p.id) ?? 1) },
    { key: 'peak_multiplier', title: 'Highest Multiplier', format: 'multiplier', entries: rank((p) => p.peak_modifier) },
    { key: 'today_tokens', title: "Today's Tokens", format: 'tokens', entries: rank((p) => today.get(p.id) ?? 0) },
    { key: 'week_tokens', title: "This Week's Tokens", format: 'tokens', entries: rank((p) => week.get(p.id) ?? 0) },
    { key: 'days_champion', title: 'Days as Champion', format: 'count', entries: rank((p) => champ.get(p.id) ?? 0) },
    { key: 'most_battered', title: 'Most Battered', format: 'count', entries: rank((p) => battered.get(p.id) ?? 0) },
    { key: 'most_gold_stolen', title: 'Most Robbed', format: 'gold', entries: rank((p) => robbed.get(p.id) ?? 0) },
  ];
}

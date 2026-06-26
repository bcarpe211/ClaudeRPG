import type Database from 'better-sqlite3';
import { getAllSettings } from './settings';
import { damageMultiplier } from './leveling';
import { tokenModifier } from './combat';
import { sumEffectiveSince } from './ingest';
import { pickEncounterCreature, type EncounterKind } from './creatures';

export interface EngineConfig {
  baseXp: number; xpGrowth: number; levelMultSlope: number;
  baseHit: number; attackIntervalMs: number; attackJitterMs: number;
  tokenModifierK: number; recentWindowMinutes: number;
  targetBattleMinutes: number; bossHpMult: number; goldFactor: number;
  minEncounterHp: number; difficultyRampPerEncounter: number;
  difficultyRampPerDungeon: number; regularEncountersMin: number;
  regularEncountersMax: number; pauseAfterMinutes: number;
  popupDurationS: number; tickIntervalMs: number;
}

export function loadEngineConfig(db: Database.Database): EngineConfig {
  const s = getAllSettings(db);
  const n = (k: string, d: number) => (s[k] !== undefined ? Number(s[k]) : d);
  return {
    baseXp: n('base_xp', 50000), xpGrowth: n('xp_growth', 1.5),
    levelMultSlope: n('level_mult_slope', 0.1),
    baseHit: n('base_hit', 100), attackIntervalMs: n('attack_interval_ms', 4000),
    attackJitterMs: n('attack_jitter_ms', 1500),
    tokenModifierK: n('token_modifier_k', 20000),
    recentWindowMinutes: n('recent_window_minutes', 10),
    targetBattleMinutes: n('target_battle_minutes', 30),
    bossHpMult: n('boss_hp_mult', 3), goldFactor: n('gold_factor', 0.01),
    minEncounterHp: n('min_encounter_hp', 2000),
    difficultyRampPerEncounter: n('difficulty_ramp_per_encounter', 0.15),
    difficultyRampPerDungeon: n('difficulty_ramp_per_dungeon', 0.25),
    regularEncountersMin: n('regular_encounters_min', 2),
    regularEncountersMax: n('regular_encounters_max', 3),
    pauseAfterMinutes: n('pause_after_minutes', 15),
    popupDurationS: n('popup_duration_s', 120),
    tickIntervalMs: n('tick_interval_ms', 1000),
  };
}

interface EnabledPlayer { id: number; level: number; effective_tokens: number; }

function enabledPlayers(db: Database.Database): EnabledPlayer[] {
  return db.prepare(
    'SELECT id, level, effective_tokens FROM players WHERE disabled = 0',
  ).all() as EnabledPlayer[];
}

/** Estimate the office's current damage output per minute (drives HP). */
export function estimateOfficeDamagePerMinute(
  db: Database.Database,
  cfg: EngineConfig,
  now: number,
): number {
  const since = now - cfg.recentWindowMinutes * 60_000;
  const swingsPerMin = 60_000 / cfg.attackIntervalMs;
  let dpm = 0;
  for (const p of enabledPlayers(db)) {
    const recent = sumEffectiveSince(db, p.id, since);
    const mod = tokenModifier(recent, cfg.tokenModifierK);
    const perHit = cfg.baseHit * damageMultiplier(p.level, cfg.levelMultSlope) * mod;
    dpm += swingsPerMin * perHit;
  }
  return dpm;
}

export function calibrateHp(
  officeDpm: number,
  targetMinutes: number,
  difficultyFactor: number,
  minHp: number,
): number {
  return Math.max(minHp, Math.round(officeDpm * targetMinutes * difficultyFactor));
}

const THEMES = ['stone_crypt', 'cave', 'wood_fort'];

function spawnEncounter(
  db: Database.Database,
  dungeon: { id: number; level: number; regular_count: number },
  index: number,
  now: number,
  cfg: EngineConfig,
  rng: () => number,
): number {
  const isBoss = index >= dungeon.regular_count;
  const kind: EncounterKind = isBoss ? 'boss' : rng() < 0.5 ? 'single' : 'pack';
  const creature = pickEncounterCreature(dungeon.level, kind, rng);
  const packCount = kind === 'pack' ? 3 + Math.floor(rng() * 3) : 1;
  const difficulty =
    (1 + cfg.difficultyRampPerEncounter * index) *
    (1 + cfg.difficultyRampPerDungeon * (dungeon.level - 1)) *
    (isBoss ? cfg.bossHpMult : 1);
  const dpm = estimateOfficeDamagePerMinute(db, cfg, now);
  const hp = calibrateHp(dpm, cfg.targetBattleMinutes, difficulty, cfg.minEncounterHp);
  let encId = 0;
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO encounters
         (dungeon_id, index_in_dungeon, kind, creature_index, footprint, pack_count,
          max_hp, current_hp, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(dungeon.id, index, kind, creature.creatureIndex, creature.footprint,
          packCount, hp, hp, now);
    encId = Number(info.lastInsertRowid);
    db.prepare(
      'UPDATE game_state SET current_dungeon_id=?, current_encounter_id=?, defeat_until=NULL WHERE id=1',
    ).run(dungeon.id, encId);
  });
  tx();
  return encId;
}

function newDungeon(
  db: Database.Database, level: number, now: number, cfg: EngineConfig, rng: () => number,
): { id: number; level: number; regular_count: number } {
  const theme = THEMES[Math.min(THEMES.length - 1, Math.floor(rng() * THEMES.length))];
  const seed = Math.floor(rng() * 2_000_000_000);
  const span = Math.max(0, cfg.regularEncountersMax - cfg.regularEncountersMin);
  const regularCount = cfg.regularEncountersMin + Math.floor(rng() * (span + 1));
  const info = db.prepare(
    'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (?,?,?,?,?)',
  ).run(level, theme, seed, regularCount, now);
  return { id: Number(info.lastInsertRowid), level, regular_count: regularCount };
}

/**
 * Ensure a fresh active encounter exists, advancing the game:
 * - no dungeon yet -> dungeon level 1, encounter 0
 * - mid-dungeon -> next encounter index
 * - boss was the last encounter -> new dungeon (level + 1)
 */
export function advanceToNextEncounter(
  db: Database.Database, now: number, cfg: EngineConfig, rng: () => number,
): void {
  const gs = db.prepare('SELECT * FROM game_state WHERE id=1').get() as any;
  let dungeon = gs.current_dungeon_id
    ? (db.prepare('SELECT * FROM dungeons WHERE id=?').get(gs.current_dungeon_id) as any)
    : null;

  if (!dungeon) {
    dungeon = newDungeon(db, 1, now, cfg, rng);
    spawnEncounter(db, dungeon, 0, now, cfg, rng);
    return;
  }
  const lastIdx = (db.prepare(
    'SELECT MAX(index_in_dungeon) AS m FROM encounters WHERE dungeon_id=?',
  ).get(dungeon.id) as any).m ?? -1;

  if (lastIdx >= dungeon.regular_count) {
    const next = newDungeon(db, dungeon.level + 1, now, cfg, rng);
    spawnEncounter(db, next, 0, now, cfg, rng);
  } else {
    spawnEncounter(db, dungeon, lastIdx + 1, now, cfg, rng);
  }
}

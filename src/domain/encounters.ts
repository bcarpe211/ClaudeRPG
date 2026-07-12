import type Database from 'better-sqlite3';
import { getAllSettings } from './settings';
import { damageMultiplier } from './leveling';
import { pickEncounterCreature, type EncounterKind } from './creatures';
import { DUNGEONS } from './floorgroups';
import { pickWeighted } from './tilesheet';

export interface EngineConfig {
  baseXp: number; xpGrowth: number; levelMultSlope: number;
  baseHit: number; attackIntervalMs: number; attackJitterMs: number;
  tokenModifierK: number; recentWindowMinutes: number;
  targetBattleMinutes: number; bossHpMult: number; goldFactor: number;
  minEncounterHp: number; difficultyRampPerEncounter: number;
  difficultyRampPerDungeon: number; regularEncountersMin: number;
  regularEncountersMax: number; pauseAfterMinutes: number;
  popupDurationS: number; tickIntervalMs: number;
  baselineBattleMinutes: number; levelCurveSlope: number;
  decayAfterMinutes: number; decaySpanMinutes: number; goldDamageWeight: number;
}

export function loadEngineConfig(db: Database.Database): EngineConfig {
  const s = getAllSettings(db);
  const n = (k: string, d: number) => {
    const v = s[k] !== undefined ? Number(s[k]) : NaN;
    return Number.isFinite(v) ? v : d;
  };
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
    baselineBattleMinutes: n('baseline_battle_minutes', 45),
    levelCurveSlope: n('level_curve_slope', 0.5),
    decayAfterMinutes: n('decay_after_minutes', 5),
    decaySpanMinutes: n('decay_span_minutes', 5),
    goldDamageWeight: n('gold_damage_weight', 0),
  };
}

interface EnabledPlayer { id: number; level: number; effective_tokens: number; }

function enabledPlayers(db: Database.Database): EnabledPlayer[] {
  return db.prepare(
    'SELECT id, level, effective_tokens FROM players WHERE disabled = 0',
  ).all() as EnabledPlayer[];
}

/** Office steady damage/min at current levels, WITHOUT any activity bonus (HP input). */
export function estimateOfficeBaselineDpm(
  db: Database.Database, cfg: EngineConfig,
): number {
  const swingsPerMin = 60_000 / cfg.attackIntervalMs;
  let dpm = 0;
  for (const p of enabledPlayers(db)) {
    dpm += swingsPerMin * cfg.baseHit * damageMultiplier(p.level, cfg.levelCurveSlope);
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

// Per-theme spawn weight over the 22 dungeon names; unlisted default to BASE.
// Down-weight the visually loud / novelty wall themes. Curated from the roster
// render — tune on the real TV. (Weights the WALL theme; floors come from compat.)
const THEME_BASE = 10;
const THEME_WEIGHTS: Record<string, number> = {
  'Auric Deep': 3,    // bright gold walls — a rare treat
  'Crimson Court': 5, // stark heraldic checker
};
const THEME_POOL = DUNGEONS.map((d) => ({ name: d.name, weight: THEME_WEIGHTS[d.name] ?? THEME_BASE }));

/** Weighted pick of a dungeon theme (one rng() draw). Deterministic given rng. */
export function pickDungeonTheme(rng: () => number): string {
  return pickWeighted(THEME_POOL, rng).name;
}

function spawnEncounter(
  db: Database.Database,
  dungeon: { id: number; level: number; theme: string; regular_count: number },
  index: number,
  now: number,
  cfg: EngineConfig,
  rng: () => number,
): number {
  const isBoss = index >= dungeon.regular_count;
  const kind: EncounterKind = isBoss ? 'boss' : rng() < 0.5 ? 'single' : 'pack';
  const creature = pickEncounterCreature(dungeon.theme, kind, rng);
  const packCount = kind === 'pack' ? 3 + Math.floor(rng() * 3) : 1;
  const difficulty =
    (1 + cfg.difficultyRampPerEncounter * index) *
    (1 + cfg.difficultyRampPerDungeon * (dungeon.level - 1)) *
    (isBoss ? cfg.bossHpMult : 1);
  const dpm = estimateOfficeBaselineDpm(db, cfg);
  const hp = calibrateHp(dpm, cfg.baselineBattleMinutes, difficulty, cfg.minEncounterHp);
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
): { id: number; level: number; theme: string; regular_count: number } {
  const theme = pickDungeonTheme(rng);
  const seed = Math.floor(rng() * 2_000_000_000);
  const span = Math.max(0, cfg.regularEncountersMax - cfg.regularEncountersMin);
  const regularCount = cfg.regularEncountersMin + Math.floor(rng() * (span + 1));
  const info = db.prepare(
    'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (?,?,?,?,?)',
  ).run(level, theme, seed, regularCount, now);
  return { id: Number(info.lastInsertRowid), level, theme, regular_count: regularCount };
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

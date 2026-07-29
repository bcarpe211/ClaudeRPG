import type Database from 'better-sqlite3';

export interface DebuffCfg {
  monsterDebuffFactor: number;
  monsterDebuffSeconds: number;
}

export interface ActiveDebuff {
  factor: number;
  remainingMs: number;
}

/** Uniform random element, or null when the list is empty. One rng() draw. */
export function pickTarget<T>(players: T[], rng: () => number): T | null {
  if (players.length === 0) return null;
  return players[Math.floor(rng() * players.length)];
}

/** 50/50 gold vs debuff. One rng() draw. */
export function rollConsequence(rng: () => number): 'gold' | 'debuff' {
  return rng() < 0.5 ? 'gold' : 'debuff';
}

/**
 * Gold a strike steals: `pctOfHeld` percent of the target's CURRENT gold
 * (0.008 => 0.008%), floored at 1 when they hold any, never more than they have,
 * 0 when broke (the caller re-rolls a broke gold hit into a debuff). Percentage-
 * based so it scales with wealth and stays meaningful as the economy inflates,
 * unlike a flat amount that goes stale.
 */
export function goldSteal(currentGold: number, pctOfHeld: number): number {
  if (currentGold <= 0) return 0;
  return Math.min(currentGold, Math.max(1, Math.round((currentGold * pctOfHeld) / 100)));
}

/** Latest non-stacking monster debuff and its remaining wall-clock duration. */
export function activeDebuff(
  db: Database.Database, playerId: number, now: number, cfg: DebuffCfg,
): ActiveDebuff | null {
  const windowMs = cfg.monsterDebuffSeconds * 1000;
  const row = db.prepare(
    `SELECT ts FROM monster_attacks
     WHERE player_id=? AND kind='debuff' AND ts>? AND ts<=?
     ORDER BY ts DESC, id DESC LIMIT 1`,
  ).get(playerId, now - windowMs, now) as { ts: number } | undefined;
  if (!row) return null;
  const remainingMs = row.ts + windowMs - now;
  if (remainingMs <= 0) return null;
  return {
    factor: cfg.monsterDebuffFactor,
    remainingMs,
  };
}

/** Swing-damage multiplier from an active monster debuff, or 1 if none. */
export function debuffFactor(
  db: Database.Database, playerId: number, now: number, cfg: DebuffCfg,
): number {
  return activeDebuff(db, playerId, now, cfg)?.factor ?? 1;
}

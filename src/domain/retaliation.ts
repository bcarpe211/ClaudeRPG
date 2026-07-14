import type Database from 'better-sqlite3';

export interface DebuffCfg {
  monsterDebuffFactor: number;
  monsterDebuffSeconds: number;
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

/** Gold a strike steals: min(currentGold, max), never negative. */
export function goldSteal(currentGold: number, max: number): number {
  return Math.max(0, Math.min(currentGold, max));
}

/**
 * Swing-damage multiplier from an active monster debuff, or 1 if none.
 * Derived from the monster_attacks log (single source of truth): a debuff is
 * active if a kind='debuff' row for the player has ts within the window ending
 * at `now`. Non-stacking — any such row yields the same flat factor.
 */
export function debuffFactor(
  db: Database.Database, playerId: number, now: number, cfg: DebuffCfg,
): number {
  const windowMs = cfg.monsterDebuffSeconds * 1000;
  const row = db.prepare(
    "SELECT 1 FROM monster_attacks WHERE player_id=? AND kind='debuff' AND ts>=? AND ts<=? LIMIT 1",
  ).get(playerId, now - windowMs, now);
  return row ? cfg.monsterDebuffFactor : 1;
}

/** Cumulative effective tokens required to REACH level `level` (level 1 = 0). */
export function xpForLevelStart(level: number, baseXp: number, growth: number): number {
  if (level <= 1) return 0;
  if (growth === 1) return Math.round(baseXp * (level - 1));
  return Math.round((baseXp * (Math.pow(growth, level - 1) - 1)) / (growth - 1));
}

/** Highest level whose XP threshold is <= xp. */
export function levelForXp(xp: number, baseXp: number, growth: number): number {
  let level = 1;
  // Levels are bounded in practice; cap to avoid pathological loops.
  while (level < 1000 && xpForLevelStart(level + 1, baseXp, growth) <= xp) {
    level++;
  }
  return level;
}

/** Damage multiplier from level: diminishing. 1 + slope*ln(level). level>=1 => >=1. */
export function damageMultiplier(level: number, slope: number): number {
  return 1 + slope * Math.log(Math.max(1, level));
}

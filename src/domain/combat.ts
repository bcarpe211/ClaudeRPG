import { damageMultiplier } from './leveling';

/** Recent-activity multiplier: 1 + recentEffectiveTokens / k. Floors at 1.0. */
export function tokenModifier(recentEffectiveTokens: number, k: number): number {
  if (k <= 0) return 1;
  return 1 + Math.max(0, recentEffectiveTokens) / k;
}

/** Damage for one swing. At least 1. */
export function attackDamage(
  baseHit: number,
  level: number,
  slope: number,
  modifier: number,
): number {
  const raw = baseHit * damageMultiplier(level, slope) * modifier;
  return Math.max(1, Math.round(raw));
}

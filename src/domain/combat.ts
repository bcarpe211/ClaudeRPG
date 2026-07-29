import { damageMultiplier } from './leveling';

/**
 * Recent-activity multiplier: 1 + recentEffectiveTokens / k, floored at 1.0 and
 * capped at `cap` (default uncapped). The cap trims the extreme burst tail so one
 * enormous burst can't wholly trivialize a fight — whales still cook, just bounded.
 */
export function tokenModifier(recentEffectiveTokens: number, k: number, cap = Infinity): number {
  if (k <= 0) return 1;
  return Math.min(cap, 1 + Math.max(0, recentEffectiveTokens) / k);
}

/** Damage for one swing. At least 1. */
export function attackDamage(
  baseHit: number,
  level: number,
  slope: number,
  modifier: number,
): number {
  const raw = baseHit * damageMultiplier(level, slope) * modifier;
  const damage = Math.max(1, Math.round(raw));
  if (!Number.isSafeInteger(damage) || damage < 1) {
    throw new RangeError('damage must be a positive safe integer');
  }
  return damage;
}

export interface GoldParticipant { playerId: number; tokens: number; damage: number; }

/** Split goldPool by token share, blended with damage share by `damageWeight`. */
export function splitGold(
  participants: GoldParticipant[], goldPool: number, damageWeight: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (participants.length === 0 || goldPool <= 0) {
    for (const p of participants) out.set(p.playerId, 0);
    return out;
  }
  const T = participants.reduce((s, p) => s + p.tokens, 0);
  const D = participants.reduce((s, p) => s + p.damage, 0);
  const w = T > 0 ? Math.min(1, Math.max(0, damageWeight)) : 1;
  for (const p of participants) {
    const tokenShare = T > 0 ? p.tokens / T : 0;
    const dmgShare = D > 0 ? p.damage / D : 0;
    let share = (1 - w) * tokenShare + w * dmgShare;
    if (T === 0 && D === 0) share = 1 / participants.length;
    out.set(p.playerId, Math.round(goldPool * share));
  }
  return out;
}

export interface RewardConfig {
  workPct: number;
  damagePct: number;
  podiumPct: readonly [number, number, number];
}

export interface RewardParticipant {
  playerId: number;
  tokens: number;
  damage: number;
  potionBonusDamage: number;
}

export interface RewardAllocation extends RewardParticipant {
  damageRank: number;
  workGold: number;
  damageGold: number;
  podiumGold: number;
  totalGold: number;
}

export function validateRewardConfig(config: RewardConfig): void {
  const percentages = [config.workPct, config.damagePct, ...config.podiumPct];
  if (percentages.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('reward percentages must be finite and non-negative');
  }
  const total = percentages.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 100) > Number.EPSILON * 100) {
    throw new RangeError('reward percentages must total 100');
  }
}

interface WeightedShare {
  key: number;
  weight: number;
}

function allocateLargestRemainder(
  total: number,
  shares: readonly WeightedShare[],
): Map<number, number> {
  const allocations = new Map<number, number>();
  for (const share of shares) allocations.set(share.key, 0);
  if (total === 0 || shares.length === 0) return allocations;

  const weightTotal = shares.reduce((sum, share) => sum + share.weight, 0);
  const equalFallback = weightTotal === 0;
  const denominator = equalFallback ? shares.length : weightTotal;
  const portions = shares.map((share) => {
    const numerator = equalFallback ? 1 : share.weight;
    const exact = total * numerator / denominator;
    const floor = Math.floor(exact);
    allocations.set(share.key, floor);
    return { key: share.key, remainder: exact - floor };
  });

  let remaining = total - [...allocations.values()].reduce((sum, value) => sum + value, 0);
  portions.sort((a, b) => b.remainder - a.remainder || a.key - b.key);
  for (let i = 0; i < remaining; i += 1) {
    const key = portions[i % portions.length].key;
    allocations.set(key, (allocations.get(key) ?? 0) + 1);
  }
  return allocations;
}

function validateParticipant(participant: RewardParticipant): void {
  const values = [
    participant.playerId,
    participant.tokens,
    participant.damage,
    participant.potionBonusDamage,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('reward participant values must be non-negative safe integers');
  }
}

export function allocateEncounterGold(
  participants: RewardParticipant[],
  goldPool: number,
  config: RewardConfig,
): RewardAllocation[] {
  validateRewardConfig(config);
  if (!Number.isSafeInteger(goldPool) || goldPool < 0) {
    throw new RangeError('goldPool must be a non-negative safe integer');
  }
  participants.forEach(validateParticipant);
  if (new Set(participants.map((participant) => participant.playerId)).size !== participants.length) {
    throw new RangeError('reward participant player IDs must be unique');
  }
  if (participants.length === 0) {
    if (goldPool === 0) return [];
    throw new RangeError('cannot allocate a non-zero gold pool without participants');
  }

  const componentBudgets = allocateLargestRemainder(goldPool, [
    { key: 0, weight: config.workPct },
    { key: 1, weight: config.damagePct },
    { key: 2, weight: config.podiumPct[0] },
    { key: 3, weight: config.podiumPct[1] },
    { key: 4, weight: config.podiumPct[2] },
  ]);
  let workBudget = componentBudgets.get(0) ?? 0;
  let damageBudget = componentBudgets.get(1) ?? 0;
  const podiumBudgets = [
    componentBudgets.get(2) ?? 0,
    componentBudgets.get(3) ?? 0,
    componentBudgets.get(4) ?? 0,
  ];

  const ranked = [...participants].sort((a, b) =>
    b.damage - a.damage || b.tokens - a.tokens || a.playerId - b.playerId);
  for (let index = ranked.length; index < podiumBudgets.length; index += 1) {
    damageBudget += podiumBudgets[index];
    podiumBudgets[index] = 0;
  }

  const totalTokens = participants.reduce((sum, participant) => sum + participant.tokens, 0);
  if (totalTokens === 0) {
    damageBudget += workBudget;
    workBudget = 0;
  }

  const workByPlayer = allocateLargestRemainder(
    workBudget,
    participants.map((participant) => ({
      key: participant.playerId,
      weight: participant.tokens,
    })),
  );
  const damageByPlayer = allocateLargestRemainder(
    damageBudget,
    participants.map((participant) => ({
      key: participant.playerId,
      weight: participant.damage,
    })),
  );

  const awards = ranked.map((participant, index): RewardAllocation => {
    const workGold = workByPlayer.get(participant.playerId) ?? 0;
    const damageGold = damageByPlayer.get(participant.playerId) ?? 0;
    const podiumGold = podiumBudgets[index] ?? 0;
    return {
      ...participant,
      damageRank: index + 1,
      workGold,
      damageGold,
      podiumGold,
      totalGold: workGold + damageGold + podiumGold,
    };
  });

  const allocated = awards.reduce((sum, award) => sum + award.totalGold, 0);
  if (allocated !== goldPool) {
    throw new Error(`reward allocation mismatch: expected ${goldPool}, allocated ${allocated}`);
  }
  return awards;
}

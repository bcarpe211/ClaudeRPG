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

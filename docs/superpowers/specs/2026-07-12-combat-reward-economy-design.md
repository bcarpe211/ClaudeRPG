# Combat & Reward Economy Redesign — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending spec review
**Backlog:** #9 (modifier decay) — grew into a full combat/reward rework

## Goal

Make **current token usage** the thing that matters: a player claude-ing hard
*right now* deals big damage and earns fair gold regardless of tenure, while
long-term levels give a bounded edge. Decouple monster HP from wall-clock so
heavy activity visibly melts monsters (short fights) and a quiet office grinds
(long fights) — battle length becomes emergent, not a fixed target. Keep numbers
sane for effectively unbounded play, and keep the model explainable to the team.

## Motivation (what's wrong today)

- **Modifier decays during active play.** `tokenModifier = 1 + recent/k` uses a
  trailing sliding window (`recent_window_minutes`), so tokens continuously drop
  off the back of the window — the modifier sags even while you're still burning,
  and sustained sessions are never rewarded.
- **HP is pegged to a 30-min target** that *includes* the activity modifier, so
  bursts inflate HP and damage equally → pushing hard never visibly wins faster
  (rubber-banding).
- **Gold and level both favor tenure.** Gold is split by damage share, and damage
  scales with `levelMult` (linear in level, from lifetime cumulative tokens), so
  veterans out-earn newcomers per token burned.

## Design decisions (locked in brainstorming)

1. **Activity modifier**: accumulate across the current activity *session*,
   **uncapped**, with **linear** decay to 1 after an idle threshold. Derived
   purely from `token_events` — no new column, no migration.
2. **HP model "A"**: `HP = office BASELINE dpm (levels only, activity modifier
   = 1) × baseline_battle_minutes × depth-difficulty`. Quiet office = long grind;
   activity melts it; length emergent. Retires the 30-min target and the sliding
   window.
3. **Diminishing level curve**: `levelMult = 1 + slope·ln(level)` so tenure is a
   real but bounded edge; ties lean toward whoever burns now.
4. **Gold split by token-usage share** this fight (tunable damage blend; default
   pure token), damage-share fallback when zero tokens were burned.
5. **HP bar = bar only** (no number, no percent). Raw numbers live in the defeat
   overview, which already lists per-player damage/hits/biggest-hit/gold/tokens/
   level-ups + totals.
6. **Abbreviated numbers** (K/M/B/T) in the defeat overview, damage floaters, and
   leaderboard.
7. **Explicitly out / backlog**: newcomer catch-up XP, recency-weighted level,
   rolling daily/weekly leaderboards (#8), store XP potions, all-time damage board.

Everything stays deterministic (injected `now`/`rng`); no `Date.now()`/`Math.random()`
in `src/domain/**`.

---

## Architecture

| File | Change |
|------|--------|
| `src/domain/activity.ts` (new) | `activityScore(db, playerId, now, cfg)` — session accumulate + linear post-idle decay, uncapped. |
| `src/domain/rewards.ts` (new) | `splitGold(participants, goldPool, damageWeight)` — pure token/damage-blend gold split, used by BOTH the kill-award path and the defeat summary. |
| `src/domain/format.ts` (new) | `formatCompact(n)` — "12.4K"/"3.2M"/... Pure + tested; mirrored in `tv.js`. |
| `src/domain/leveling.ts` | `damageMultiplier` → diminishing `1 + slope·ln(level)`. |
| `src/domain/encounters.ts` | HP model A: baseline DPM (modifier = 1), `baseline_battle_minutes`; config knobs added/removed. |
| `src/domain/engine.ts` | Attack damage uses `activityScore`; gold award uses `splitGold` by token share. |
| `src/domain/settings.ts` | Retire 3 keys, add 5 keys (below). |
| `src/web/tvview.ts` | Leaderboard modifier from `activityScore`. |
| `src/web/public/tv/tv.js` | HP bar drops the number line; `fmt()` abbreviation for floaters/leaderboard/defeat popup. |

---

## Component 1 — `src/domain/activity.ts`

```ts
export interface ActivityCfg {
  decayAfterMinutes: number;   // idle before decay starts
  decaySpanMinutes: number;    // linear decay duration to reach 0
}

/**
 * Accumulated effective tokens for a player's CURRENT activity session,
 * with linear post-idle decay. Uncapped. Pure function of token_events + now.
 *
 * - A "session" is a run of token events with no gap >= decayAfterMinutes.
 * - While the latest event is within decayAfterMinutes of `now`, the score is
 *   the full session sum (holds/accumulates, no decay).
 * - Once idle longer than decayAfterMinutes, the score decays LINEARLY to 0
 *   over decaySpanMinutes, then stays 0.
 */
export function activityScore(
  db: Database.Database, playerId: number, now: number, cfg: ActivityCfg,
): number {
  const afterMs = cfg.decayAfterMinutes * 60_000;
  const spanMs  = Math.max(1, cfg.decaySpanMinutes * 60_000);
  // Bound the scan: a real session won't span more than a day of <threshold gaps.
  const LOOKBACK_MS = 24 * 60 * 60_000;
  const rows = db.prepare(
    'SELECT ts, effective_delta FROM token_events WHERE player_id=? AND ts>=? AND ts<=? ORDER BY ts DESC',
  ).all(playerId, now - LOOKBACK_MS, now) as { ts: number; effective_delta: number }[];
  if (rows.length === 0) return 0;

  const gap0 = now - rows[0].ts;
  // Walk newest -> older, summing the current/last session (stop at a gap >= afterMs).
  let sessionSum = 0;
  let prevTs = rows[0].ts;
  for (const r of rows) {
    if (prevTs - r.ts >= afterMs) break; // session boundary
    sessionSum += r.effective_delta;
    prevTs = r.ts;
  }

  if (gap0 <= afterMs) return sessionSum;                 // active -> hold
  const over = gap0 - afterMs;
  const factor = Math.max(0, 1 - over / spanMs);          // linear decay
  return sessionSum * factor;
}
```

Modifier = `tokenModifier(activityScore(...), tokenModifierK)` (existing
`combat.tokenModifier`, unchanged: `1 + max(0,score)/k`).

**Caveat (documented):** a single continuous session longer than the 24 h
`LOOKBACK_MS` under-counts its oldest part. Implausible in practice (overnight
gaps exceed the idle threshold); acceptable.

---

## Component 2 — `src/domain/rewards.ts`

```ts
export interface GoldParticipant { playerId: number; tokens: number; damage: number; }

/**
 * Split `goldPool` among participants. Weighted blend of token-share and
 * damage-share: share = (1-w)*tokenShare + w*damageShare, w = damageWeight
 * (default 0 => pure token). Falls back to damage-share when nobody burned
 * tokens this fight; equal split if neither tokens nor damage exist.
 */
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
  const w = T > 0 ? Math.min(1, Math.max(0, damageWeight)) : 1; // no tokens -> pure damage
  for (const p of participants) {
    const tokenShare = T > 0 ? p.tokens / T : 0;
    const dmgShare   = D > 0 ? p.damage / D : 0;
    let share = (1 - w) * tokenShare + w * dmgShare;
    if (T === 0 && D === 0) share = 1 / participants.length; // degenerate: equal
    out.set(p.playerId, Math.round(goldPool * share));
  }
  return out;
}
```

Used by the **kill-award path** in `engine.ts` AND `buildDefeatSummary` so the
popup shows exactly what was awarded.

---

## Component 3 — `src/domain/format.ts` (+ mirror in `tv.js`)

```ts
/** Compact number: 999, 1.2K, 12.4K, 124K, 3.2M, 1.1B, 4.5T. Non-negative-friendly. */
export function formatCompact(n: number): string {
  const sign = n < 0 ? '-' : '';
  let x = Math.abs(n);
  if (x < 1000) return sign + String(Math.round(x));
  const units = ['K', 'M', 'B', 'T'];
  let u = -1;
  while (x >= 1000 && u < units.length - 1) { x /= 1000; u++; }
  const digits = x < 100 ? 1 : 0;   // 1.2K / 12.4K / 124K
  return sign + x.toFixed(digits) + units[u];
}
```

`tv.js` carries a byte-equivalent `fmt()` local (it's a classic script, can't
import — same mirror pattern as `MSHADOW`/`ANIM_ROW`). `formatCompact` is the
tested source of truth.

---

## Component 4 — `src/domain/leveling.ts`

```ts
/** Damage multiplier from level: diminishing. 1 + slope*ln(level). level>=1 => >=1. */
export function damageMultiplier(level: number, slope: number): number {
  return 1 + slope * Math.log(Math.max(1, level));
}
```

`xpForLevelStart`/`levelForXp` unchanged (level still from lifetime
`effective_tokens`). Only the *reward per level* flattens.

---

## Component 5 — `src/domain/encounters.ts` (HP model A)

Rename + rework the office-power estimate to a **baseline** (activity-free):

```ts
/** Office steady damage/min at the current levels, WITHOUT any activity bonus. */
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
```

`spawnEncounter` HP:
```ts
const dpm = estimateOfficeBaselineDpm(db, cfg);           // no `now`, no tokens
const hp = calibrateHp(dpm, cfg.baselineBattleMinutes, difficulty, cfg.minEncounterHp);
```
`difficulty` (per-encounter × per-dungeon × bossHpMult) and `calibrateHp` are
**unchanged**. `estimateOfficeDamagePerMinute` is removed (callers/tests move to
`estimateOfficeBaselineDpm`). `sumEffectiveSince`/`tokenModifier` imports drop
from this file.

`EngineConfig` / `loadEngineConfig`:
- **Remove**: `recentWindowMinutes`, `targetBattleMinutes`, `levelMultSlope`.
- **Add**: `baselineBattleMinutes` (`baseline_battle_minutes`, default 45),
  `levelCurveSlope` (`level_curve_slope`, default 0.5),
  `decayAfterMinutes` (`decay_after_minutes`, 5),
  `decaySpanMinutes` (`decay_span_minutes`, 5),
  `goldDamageWeight` (`gold_damage_weight`, 0).
- **Keep**: `tokenModifierK` (now the activity-score scale).

---

## Component 6 — `src/domain/engine.ts`

**Attack damage** (in the tick attack loop, currently `sumEffectiveSince`+`tokenModifier`):
```ts
const score = activityScore(this.db, p.id, now, cfg);
const mod = tokenModifier(score, cfg.tokenModifierK);
const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelCurveSlope, mod);
```

**Gold award on kill** (replace the damage-share split): gather per-participant
`{tokens (effective_delta in [started_at, ended_at]), damage}`, then
`splitGold(participants, goldPool, cfg.goldDamageWeight)`; award each player's
gold. `buildDefeatSummary` uses the same `splitGold` for the displayed gold, so
popup == award.

`damageMultiplier` calls pass `cfg.levelCurveSlope`.

---

## Component 7 — `src/web/tvview.ts`

Leaderboard `modifier` now reflects the activity score:
```ts
modifier: tokenModifier(activityScore(db, p.id, now, cfg), cfg.tokenModifierK),
```
Remove the `recentWindowMinutes` `since` computation.

---

## Component 8 — `src/web/public/tv/tv.js`

- **HP bar**: delete the `shadowText(`${hp} / ${maxHp}`)` line in `drawHpBar` —
  keep the bar rects + the monster name label. Bar only.
- **Abbreviation** `fmt()` (mirror of `formatCompact`): apply to
  - damage floaters (`'-' + fmt(delta)`),
  - leaderboard row stats (tokens, gold),
  - the defeat popup per-player numbers + totals in `drawDefeat`.

---

## Settings changes (deploy note)

`seedSettings` uses `INSERT OR IGNORE`, so on the Pi the **5 new keys seed on next
startup** and the **3 retired keys linger unread** (harmless). Because the *model*
changed, retune on the real TV via the admin panel: `base_hit`, `token_modifier_k`,
`level_curve_slope`, `baseline_battle_minutes`.

| Key | Action | Default |
|-----|--------|---------|
| `recent_window_minutes` | **retire** (unused) | — |
| `target_battle_minutes` | **retire** → replaced | — |
| `level_mult_slope` | **retire** → replaced (linear→ln) | — |
| `baseline_battle_minutes` | **add** (quiet-office battle length) | `45` |
| `level_curve_slope` | **add** (ln-curve slope) | `0.5` |
| `decay_after_minutes` | **add** (idle before decay) | `5` |
| `decay_span_minutes` | **add** (linear decay duration) | `5` |
| `gold_damage_weight` | **add** (0 = pure token gold) | `0` |
| `token_modifier_k` | keep (activity scale) | `20000` |

---

## Testing

- **`tests/activity.test.ts`**: accumulates across events in one session; holds
  across a gap < `decay_after`; decays linearly after `decay_after` and reaches 0
  at `decay_after + decay_span`; a new event after a long idle starts a fresh
  session (old sum gone); uncapped (a huge session → huge score); no events → 0.
- **`tests/rewards.test.ts`**: pure-token split at weight 0; blended at weight>0;
  zero-token → damage-share fallback; both zero → equal split; awarded sum ≈ pool
  (±rounding); empty participants safe.
- **`tests/format.test.ts`**: 0, 999, 1000→"1.0K", 12400→"12.4K", 124000→"124K",
  3_200_000→"3.2M", 1.1e9→"1.1B", 4.5e12→"4.5T", negative sign.
- **`tests/leveling.test.ts`** (update): `damageMultiplier` is 1 at level 1,
  strictly increasing, and diminishing (mult(100)−mult(50) < mult(2)−mult(1)).
- **`tests/encounters.test.ts`** (update): `estimateOfficeBaselineDpm` is
  independent of token activity (same value whether or not the player has recent
  tokens); HP = baselineDpm × baselineBattleMinutes × difficulty (floored).
- **`tests/engine.test.ts`** (update): a mid-session burst raises a player's
  attack damage (activity modifier > 1); a high-token/low-damage player gets a
  gold share ≥ a low-token/high-damage player at weight 0.
- **`tests/tvview-state.test.ts`** (update): leaderboard `modifier` reflects the
  activity score (rises after a burst).
- Full suite + `tsc --noEmit` stay green (baseline 206).

No automated test for `tv.js` (canvas) — controller verifies the bar-only HP bar
and abbreviated numbers via headless-Chrome screenshots.

## Risks / notes

- **Pacing shifts.** HP now = baseline (no activity) × longish minutes, so an
  active office kills far faster than before and a quiet one slower. `base_hit`,
  `token_modifier_k`, `baseline_battle_minutes`, `level_curve_slope` all need a
  retune pass on the real TV; defaults here are starting points.
- **Level curve semantics changed** (`level_mult_slope` linear → `level_curve_slope`
  ln). New key avoids silently reinterpreting an admin-tuned value.
- **Determinism/perf**: `activityScore` walks a player's recent events per tick;
  bounded by 24 h lookback and the session-gap break. Fine for an office.
- **Office-idle pause** (`pause_after_minutes`) is unchanged and still stops the
  game when truly idle, so a quiet-but-not-dead office grinds while a dead one
  pauses.

# Combat & Reward Economy Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make current token usage the dominant power lever: accumulate/uncapped/idle-decaying activity modifier, HP pegged to office *baseline* power (not wall-clock or bursts), diminishing level curve, gold split by token share, bar-only HP, abbreviated numbers.

**Architecture:** Three new pure domain modules (`activity`, `rewards`, `format`) plus a diminishing `damageMultiplier`. The engine's attack damage switches to the accumulate modifier; HP calibration drops the activity term and the 30-min target; gold splits by tokens. The TV drops the HP number and abbreviates big numbers.

**Tech Stack:** TypeScript ESM via `tsx` (no build), vitest, better-sqlite3. `tv.js` is dependency-free browser JS.

Spec: `docs/superpowers/specs/2026-07-12-combat-reward-economy-design.md`.

## Global Constraints

- **No build step.** Typecheck `npm run typecheck` (`tsc --noEmit`); tests `npx vitest run <file>`.
- **Determinism:** no `Date.now()`/`Math.random()` in `src/domain/**`. `activityScore` and gold are pure functions of the DB + injected `now`/`cfg`.
- **`tv.js` is dependency-free** — mirror helpers as local consts (like `MSHADOW`), never `import`.
- **Suite stays green** at every task (baseline 206). Ordering below keeps every intermediate state compiling: new pure modules → diminishing curve → additive config + HP → engine → tvview → remove retired knobs → tv.js.
- **Formulas (verbatim):** modifier `1 + activityScore/k`; `damageMultiplier = 1 + slope·ln(max(1,level))`; HP `= estimateOfficeBaselineDpm × baselineBattleMinutes × difficulty` (difficulty & `calibrateHp` unchanged); gold share `= (1−w)·tokenShare + w·damageShare`, `w = gold_damage_weight` (default 0).

## File Structure

- Create: `src/domain/format.ts`, `tests/format.test.ts`
- Create: `src/domain/activity.ts`, `tests/activity.test.ts`
- Create: `src/domain/rewards.ts`, `tests/rewards.test.ts`
- Modify: `src/domain/leveling.ts`, `tests/leveling.test.ts`
- Modify: `src/domain/encounters.ts` (config + HP), `tests/encounters.test.ts`
- Modify: `src/domain/engine.ts` (damage + gold), `tests/engine.test.ts`
- Modify: `src/web/tvview.ts` (leaderboard modifier), `tests/tvview-state.test.ts`
- Modify: `src/domain/settings.ts` (settings keys)
- Modify: `src/web/public/tv/tv.js` (bar-only + abbreviation)

---

## Task 1: `format.ts` — compact number formatting

**Files:** Create `src/domain/format.ts`, Test `tests/format.test.ts`
**Interfaces:** Produces `formatCompact(n: number): string`.

- [ ] **Step 1: Write the failing test** — `tests/format.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { formatCompact } from '../src/domain/format';

describe('formatCompact', () => {
  it('leaves values under 1000 as integers', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(42)).toBe('42');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(999.6)).toBe('1000'); // rounds
  });
  it('abbreviates with K/M/B/T', () => {
    expect(formatCompact(1000)).toBe('1.0K');
    expect(formatCompact(12400)).toBe('12.4K');
    expect(formatCompact(124000)).toBe('124K');
    expect(formatCompact(3_200_000)).toBe('3.2M');
    expect(formatCompact(1_100_000_000)).toBe('1.1B');
    expect(formatCompact(4_500_000_000_000)).toBe('4.5T');
  });
  it('keeps a sign for negatives', () => {
    expect(formatCompact(-1500)).toBe('-1.5K');
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `npx vitest run tests/format.test.ts` — FAIL (module not found).

- [ ] **Step 3: Write `src/domain/format.ts`**

```ts
/** Compact number: 999, 1.2K, 12.4K, 124K, 3.2M, 1.1B, 4.5T. Sign-preserving. */
export function formatCompact(n: number): string {
  const sign = n < 0 ? '-' : '';
  let x = Math.abs(n);
  if (x < 1000) return sign + String(Math.round(x));
  const units = ['K', 'M', 'B', 'T'];
  let u = -1;
  while (x >= 1000 && u < units.length - 1) { x /= 1000; u++; }
  const digits = x < 100 ? 1 : 0;
  return sign + x.toFixed(digits) + units[u];
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/format.test.ts` PASS.
- [ ] **Step 5: Commit** — `git add src/domain/format.ts tests/format.test.ts && git commit -m "feat(format): compact K/M/B/T number formatting"`

---

## Task 2: `activity.ts` — accumulate modifier with idle decay

**Files:** Create `src/domain/activity.ts`, Test `tests/activity.test.ts`
**Interfaces:** Produces `ActivityCfg`, `activityScore(db, playerId, now, cfg): number`.

- [ ] **Step 1: Write the failing test** — `tests/activity.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { activityScore } from '../src/domain/activity';

let db: ReturnType<typeof openDb>;
let pid: number;
const CFG = { decayAfterMinutes: 5, decaySpanMinutes: 5 }; // 300000ms each
const NOW = 1_000_000;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  pid = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1).id;
});
function ev(ts: number, delta: number) {
  db.prepare('INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?,?,?,?)')
    .run(pid, ts, delta, delta);
}

describe('activityScore', () => {
  it('returns 0 with no events', () => {
    expect(activityScore(db, pid, NOW, CFG)).toBe(0);
  });
  it('accumulates the whole current session', () => {
    ev(NOW - 60_000, 100); ev(NOW - 30_000, 200); ev(NOW - 10_000, 300);
    expect(activityScore(db, pid, NOW, CFG)).toBe(600);
  });
  it('holds across a gap shorter than decayAfter (same session)', () => {
    ev(NOW - 250_000, 500); ev(NOW - 10_000, 300); // gap 240s < 300s
    expect(activityScore(db, pid, NOW, CFG)).toBe(800);
  });
  it('excludes events before a session boundary (gap >= decayAfter)', () => {
    ev(NOW - 400_000, 999); ev(NOW - 60_000, 200); ev(NOW - 10_000, 300); // 340s gap boundary
    expect(activityScore(db, pid, NOW, CFG)).toBe(500);
  });
  it('decays linearly once idle past decayAfter', () => {
    ev(NOW - 450_000, 1000); // gap0 450s; over 150s; factor 0.5
    expect(activityScore(db, pid, NOW, CFG)).toBeCloseTo(500, 5);
  });
  it('is fully decayed after decayAfter + decaySpan', () => {
    ev(NOW - 700_000, 1000); // over 400s > span 300s -> 0
    expect(activityScore(db, pid, NOW, CFG)).toBe(0);
  });
  it('is uncapped', () => {
    ev(NOW - 10_000, 5_000_000);
    expect(activityScore(db, pid, NOW, CFG)).toBe(5_000_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/activity.test.ts` FAIL (module not found).

- [ ] **Step 3: Write `src/domain/activity.ts`**

```ts
import type Database from 'better-sqlite3';

export interface ActivityCfg {
  decayAfterMinutes: number;
  decaySpanMinutes: number;
}

/**
 * Accumulated effective tokens for a player's CURRENT activity session, with
 * linear post-idle decay. Uncapped. Pure function of token_events + now.
 * Session = a run of events with no gap >= decayAfterMinutes.
 */
export function activityScore(
  db: Database.Database, playerId: number, now: number, cfg: ActivityCfg,
): number {
  const afterMs = cfg.decayAfterMinutes * 60_000;
  const spanMs = Math.max(1, cfg.decaySpanMinutes * 60_000);
  const LOOKBACK_MS = 24 * 60 * 60_000;
  const rows = db.prepare(
    'SELECT ts, effective_delta FROM token_events WHERE player_id=? AND ts>=? AND ts<=? ORDER BY ts DESC',
  ).all(playerId, now - LOOKBACK_MS, now) as { ts: number; effective_delta: number }[];
  if (rows.length === 0) return 0;

  let sessionSum = 0;
  let prevTs = rows[0].ts;
  for (const r of rows) {
    if (prevTs - r.ts >= afterMs) break;
    sessionSum += r.effective_delta;
    prevTs = r.ts;
  }

  const gap0 = now - rows[0].ts;
  if (gap0 <= afterMs) return sessionSum;
  const factor = Math.max(0, 1 - (gap0 - afterMs) / spanMs);
  return sessionSum * factor;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/activity.test.ts` PASS.
- [ ] **Step 5: Commit** — `git add src/domain/activity.ts tests/activity.test.ts && git commit -m "feat(activity): session-accumulate token modifier with linear idle decay"`

---

## Task 3: `rewards.ts` — token-share gold split

**Files:** Create `src/domain/rewards.ts`, Test `tests/rewards.test.ts`
**Interfaces:** Produces `GoldParticipant`, `splitGold(participants, goldPool, damageWeight): Map<number, number>`.

- [ ] **Step 1: Write the failing test** — `tests/rewards.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { splitGold } from '../src/domain/rewards';

const P = [
  { playerId: 1, tokens: 300, damage: 100 },
  { playerId: 2, tokens: 100, damage: 900 },
];

describe('splitGold', () => {
  it('splits by pure token share at weight 0', () => {
    const g = splitGold(P, 1000, 0);
    expect(g.get(1)).toBe(750); // 300/400
    expect(g.get(2)).toBe(250); // 100/400
  });
  it('blends damage share at weight > 0', () => {
    const g = splitGold(P, 1000, 0.5);
    // p1: .5*(300/400)+.5*(100/1000)=.375+.05=.425 -> 425
    expect(g.get(1)).toBe(425);
    expect(g.get(2)).toBe(575);
  });
  it('falls back to damage share when nobody burned tokens', () => {
    const q = [{ playerId: 1, tokens: 0, damage: 100 }, { playerId: 2, tokens: 0, damage: 300 }];
    const g = splitGold(q, 400, 0);
    expect(g.get(1)).toBe(100);
    expect(g.get(2)).toBe(300);
  });
  it('splits equally when neither tokens nor damage exist', () => {
    const q = [{ playerId: 1, tokens: 0, damage: 0 }, { playerId: 2, tokens: 0, damage: 0 }];
    const g = splitGold(q, 100, 0);
    expect(g.get(1)).toBe(50);
    expect(g.get(2)).toBe(50);
  });
  it('awards nothing from a zero/empty pool', () => {
    expect(splitGold(P, 0, 0).get(1)).toBe(0);
    expect(splitGold([], 100, 0).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/rewards.test.ts` FAIL.

- [ ] **Step 3: Write `src/domain/rewards.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/rewards.test.ts` PASS.
- [ ] **Step 5: Commit** — `git add src/domain/rewards.ts tests/rewards.test.ts && git commit -m "feat(rewards): token-share gold split with damage blend"`

---

## Task 4: Diminishing level curve

**Files:** Modify `src/domain/leveling.ts`, `tests/leveling.test.ts`
**Interfaces:** `damageMultiplier(level, slope)` unchanged signature, new formula.

- [ ] **Step 1: Update the test** — in `tests/leveling.test.ts` replace the `damageMultiplier` test:

```ts
  it('damageMultiplier diminishes with level (1 + slope*ln(level))', () => {
    expect(damageMultiplier(1, 0.5)).toBeCloseTo(1.0);
    expect(damageMultiplier(10, 0.5)).toBeCloseTo(1 + 0.5 * Math.log(10)); // ~2.15
    // strictly increasing but diminishing returns
    const d1 = damageMultiplier(2, 0.5) - damageMultiplier(1, 0.5);
    const d2 = damageMultiplier(100, 0.5) - damageMultiplier(99, 0.5);
    expect(d1).toBeGreaterThan(d2);
  });
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/leveling.test.ts` FAIL (still linear).

- [ ] **Step 3: Update `damageMultiplier` in `src/domain/leveling.ts`**

Replace:
```ts
export function damageMultiplier(level: number, slope: number): number {
  return 1 + slope * (level - 1);
}
```
with:
```ts
/** Damage multiplier from level: diminishing. 1 + slope*ln(level). level>=1 => >=1. */
export function damageMultiplier(level: number, slope: number): number {
  return 1 + slope * Math.log(Math.max(1, level));
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/leveling.test.ts` PASS, then `npx vitest run` (full) to catch magnitude fallout; fix any test that asserted a specific >level-1 damage/HP value by recomputing with the ln curve. (Level-1 multiplier is still exactly 1.0, so most fixtures are unaffected.)
- [ ] **Step 5: Commit** — `git add src/domain/leveling.ts tests/leveling.test.ts && git commit -m "feat(leveling): diminishing damage multiplier (1 + slope*ln(level))"`

---

## Task 5: HP Model A + additive config/settings

Adds the new settings/config fields (keeping the old ones so engine/tvview still compile) and reworks HP to office baseline power × baseline minutes.

**Files:** Modify `src/domain/settings.ts`, `src/domain/encounters.ts`, `tests/encounters.test.ts`
**Interfaces:**
- Consumes: `damageMultiplier` (leveling).
- Produces: `EngineConfig` gains `baselineBattleMinutes, levelCurveSlope, decayAfterMinutes, decaySpanMinutes, goldDamageWeight`; `estimateOfficeBaselineDpm(db, cfg): number` (replaces `estimateOfficeDamagePerMinute`).

- [ ] **Step 1: Add settings** — in `src/domain/settings.ts` `DEFAULT_SETTINGS`, keep existing keys and ADD:
```ts
  baseline_battle_minutes: '45', // quiet-office battle length (activity shortens it)
  level_curve_slope: '0.5',      // damage multiplier = 1 + slope*ln(level)
  decay_after_minutes: '5',      // idle before the activity modifier decays
  decay_span_minutes: '5',       // linear decay duration to reach modifier 1.0
  gold_damage_weight: '0',       // 0 = gold purely by token share
```
(Do NOT remove `recent_window_minutes`, `target_battle_minutes`, `level_mult_slope` yet — Task 8.)

- [ ] **Step 2: Update `EngineConfig` + `loadEngineConfig`** in `src/domain/encounters.ts`.
Add fields to the interface: `baselineBattleMinutes: number; levelCurveSlope: number; decayAfterMinutes: number; decaySpanMinutes: number; goldDamageWeight: number;` (keep the existing ones for now). In `loadEngineConfig` return, add:
```ts
    baselineBattleMinutes: n('baseline_battle_minutes', 45),
    levelCurveSlope: n('level_curve_slope', 0.5),
    decayAfterMinutes: n('decay_after_minutes', 5),
    decaySpanMinutes: n('decay_span_minutes', 5),
    goldDamageWeight: n('gold_damage_weight', 0),
```

- [ ] **Step 3: Write the failing test** — update `tests/encounters.test.ts` `estimateOfficeDamagePerMinute` describe block to the new baseline function:
```ts
import { estimateOfficeBaselineDpm } from '../src/domain/encounters';
// ...
describe('estimateOfficeBaselineDpm', () => {
  it('sums per-player DPM at level baseline, ignoring token activity', () => {
    const a = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    createPlayer(db, { name: 'B', class_key: 'thief', gender: 'F' }, 1);
    const cfg = loadEngineConfig(db);
    const before = estimateOfficeBaselineDpm(db, cfg);
    // 2 players, level 1 mult 1.0, baseHit 100, interval 4000 -> 15*100*2 = 3000
    expect(before).toBeCloseTo(3000, 0);
    // adding recent tokens must NOT change baseline HP input (decoupled from activity)
    db.prepare('INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?,?,?,?)')
      .run(a.id, 100000, 1_000_000, 1_000_000);
    expect(estimateOfficeBaselineDpm(db, cfg)).toBeCloseTo(3000, 0);
  });
});
```
Also update the import line (remove `estimateOfficeDamagePerMinute`, add `estimateOfficeBaselineDpm`).

- [ ] **Step 4: Run to verify it fails** — `npx vitest run tests/encounters.test.ts` FAIL (function not found).

- [ ] **Step 5: Rework `encounters.ts`**
Replace `estimateOfficeDamagePerMinute` with:
```ts
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
```
Add `import { damageMultiplier } from './leveling';` if not present; remove the now-unused `sumEffectiveSince`/`tokenModifier` imports and the `since`/`recent`/`mod` lines from the old function. In `spawnEncounter`, replace the HP calc:
```ts
  const dpm = estimateOfficeBaselineDpm(db, cfg);
  const hp = calibrateHp(dpm, cfg.baselineBattleMinutes, difficulty, cfg.minEncounterHp);
```
(The `difficulty` expression and `calibrateHp` are unchanged.)

- [ ] **Step 6: Run tests** — `npx vitest run tests/encounters.test.ts` PASS; `npm run typecheck` clean (engine/tvview still use the retained old fields).
- [ ] **Step 7: Commit** — `git add src/domain/settings.ts src/domain/encounters.ts tests/encounters.test.ts && git commit -m "feat(hp): office-baseline HP model + activity/gold/level-curve settings"`

---

## Task 6: Engine — accumulate-damage + token-share gold

**Files:** Modify `src/domain/engine.ts`, `tests/engine.test.ts`
**Interfaces:** Consumes `activityScore` (activity), `splitGold` (rewards), `damageMultiplier` via `attackDamage`.

- [ ] **Step 1: Write failing tests** — add to `tests/engine.test.ts` (reuse the file's existing harness: `openDb`/`seedSettings`/`createPlayer`/`ingestTokenUsage`/`GameEngine`):
```ts
import { activityScore } from '../src/domain/activity';
// (a) a mid-session burst raises attack damage
it('a token burst raises a player attack above baseline', () => {
  const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
  const eng = new GameEngine(db, { rng: () => 0.5 });
  eng.tick(100000); // spawn + a swing at ~modifier 1
  // ingest a burst, tick again a moment later
  ingestTokenUsage(db, tokensPayload(p.auth_token, 400000), 101000, { cacheReadWeight: 0 });
  expect(activityScore(db, p.id, 101000, { decayAfterMinutes: 5, decaySpanMinutes: 5 })).toBe(400000);
});
// (b) gold favors token share over raw damage at weight 0
it('gold is split by token share (high-token player earns >= high-damage-only player)', () => {
  // Build an encounter, record encounter_damage for two players, and token_events
  // that invert the damage order, then kill it and read players.gold. See plan notes.
});
```
Use the plan's kill-path change (below) to make (b) concrete: seed two enabled players, drive the engine to a kill, and assert the player with more `token_events` during the fight has `gold >=` the other even if their `encounter_damage` is lower. (Adapt to the file's existing setup helpers; keep assertions on relative gold, not exact values.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/engine.test.ts` FAIL.

- [ ] **Step 3: Attack-loop damage** — in `tick()` replace the `since`/`recent` lines (currently lines ~207, 213-215):
```ts
    // (remove: const since = now - cfg.recentWindowMinutes * 60_000;)
    for (const p of this.activePlayers()) {
      this.updateLevel(p, cfg, now);
      const next = this.nextAttackAt.get(p.id) ?? this.scheduleNext(now, cfg);
      if (now >= next) {
        const score = activityScore(this.db, p.id, now, cfg);
        const mod = tokenModifier(score, cfg.tokenModifierK);
        const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelCurveSlope, mod);
        this.applyHit(encId, p.id, dmg);
        this.nextAttackAt.set(p.id, this.scheduleNext(now, cfg));
      } else {
        this.nextAttackAt.set(p.id, next);
      }
    }
```
Update imports: add `import { activityScore } from './activity';` and `import { splitGold } from './rewards';`; drop `sumEffectiveSince` (no longer used here). Keep `tokenModifier`, `attackDamage`.

- [ ] **Step 4: Gold award** — rewrite the split in `resolveKillIfDead` (currently lines ~156-167). After setting `ended_at`, gather per-participant tokens in `[started_at, ended_at]` and split:
```ts
    const rows = this.db.prepare(
      'SELECT player_id, damage_total FROM encounter_damage WHERE encounter_id=?',
    ).all(encId) as { player_id: number; damage_total: number }[];
    const tokQ = this.db.prepare(
      'SELECT COALESCE(SUM(effective_delta),0) AS s FROM token_events WHERE player_id=? AND ts>=? AND ts<=?',
    );
    const participants = rows.map((r) => ({
      playerId: r.player_id,
      damage: r.damage_total,
      tokens: (tokQ.get(r.player_id, enc.started_at, now) as { s: number }).s,
    }));
    const goldByPlayer = splitGold(participants, goldPool, cfg.goldDamageWeight);
    const award = this.db.prepare('UPDATE players SET gold = gold + ? WHERE id=?');
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE encounters SET status='defeated', ended_at=? WHERE id=?").run(now, encId);
      for (const [playerId, gold] of goldByPlayer) if (gold > 0) award.run(gold, playerId);
      this.db.prepare(
        'UPDATE game_state SET defeat_until=?, last_defeat_encounter_id=?, current_encounter_id=NULL WHERE id=1',
      ).run(now + cfg.popupDurationS * 1000, encId);
    });
    tx();
```
(Delete the old `const total = ...` damage-sum and its `Math.round(goldPool * (r.damage_total/total))` loop.)

- [ ] **Step 5: Defeat summary uses the same split** — in `buildDefeatSummary` replace the per-participant `gold` computation (currently `totalDamage>0 ? round(goldPool*damage/totalDamage) : 0`) with `splitGold`. Build participants from `dmgRows` + each row's `tokensDuringFight` (already queried into `tok.s`), call `splitGold(participants, goldPool, goldDamageWeight)`, and read each player's gold from the map. Read `goldDamageWeight` from settings (the function already reads `settings`): `const goldDamageWeight = settings['gold_damage_weight'] !== undefined ? Number(settings['gold_damage_weight']) : 0;`. This guarantees popup == award.

- [ ] **Step 6: Run tests** — `npx vitest run tests/engine.test.ts tests/encounters.test.ts` PASS, then `npm run typecheck` clean.
- [ ] **Step 7: Commit** — `git add src/domain/engine.ts tests/engine.test.ts && git commit -m "feat(engine): accumulate-modifier damage + token-share gold"`

---

## Task 7: Leaderboard modifier from activity

**Files:** Modify `src/web/tvview.ts`, `tests/tvview-state.test.ts`
**Interfaces:** Consumes `activityScore`.

- [ ] **Step 1: Write the failing test** — in `tests/tvview-state.test.ts`, add: after ingesting a burst of tokens for a player, the built state's leaderboard entry for that player has `modifier > 1` (reflecting the accumulate score). Reuse the file's harness/clock.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/tvview-state.test.ts` FAIL.

- [ ] **Step 3: Update `tvview.ts`** — replace the leaderboard modifier (line ~91) and drop the `since` line (~58):
```ts
import { activityScore } from '../domain/activity';
// remove: const since = now - cfg.recentWindowMinutes * 60_000;
// in the players map:
    modifier: tokenModifier(activityScore(db, p.id, now, cfg), cfg.tokenModifierK),
```
Remove the now-unused `sumEffectiveSince` import if nothing else in the file uses it.

- [ ] **Step 4: Run tests** — `npx vitest run tests/tvview-state.test.ts` PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/web/tvview.ts tests/tvview-state.test.ts && git commit -m "feat(tv): leaderboard modifier reflects accumulate activity score"`

---

## Task 8: Remove retired knobs

Now that no consumer uses them, retire the old settings/config.

**Files:** Modify `src/domain/settings.ts`, `src/domain/encounters.ts`

- [ ] **Step 1: Remove from `EngineConfig` + `loadEngineConfig`** the fields `recentWindowMinutes`, `targetBattleMinutes`, `levelMultSlope` and their `n('...')` reads.
- [ ] **Step 2: Remove from `DEFAULT_SETTINGS`** the keys `recent_window_minutes`, `target_battle_minutes`, `level_mult_slope`.
- [ ] **Step 3: Verify no references remain** — `grep -rn "recentWindowMinutes\|targetBattleMinutes\|levelMultSlope\|recent_window_minutes\|target_battle_minutes\|level_mult_slope\|estimateOfficeDamagePerMinute" src/ tests/` returns nothing.
- [ ] **Step 4: Run full suite + typecheck** — `npx vitest run && npm run typecheck` green.
- [ ] **Step 5: Commit** — `git add src/domain/settings.ts src/domain/encounters.ts && git commit -m "chore: retire recent_window/target_battle/level_mult_slope knobs"`

---

## Task 9: TV — bar-only HP + abbreviated numbers

**Files:** Modify `src/web/public/tv/tv.js`
No automated test (Canvas) — controller verifies via headless-Chrome screenshots.

- [ ] **Step 1: Add `fmt()`** — near the top-of-file consts, mirror of `formatCompact`:
```js
function fmt(n) {
  const s = n < 0 ? '-' : ''; let x = Math.abs(n);
  if (x < 1000) return s + String(Math.round(x));
  const u = ['K', 'M', 'B', 'T']; let i = -1;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return s + x.toFixed(x < 100 ? 1 : 0) + u[i];
}
```

- [ ] **Step 2: HP bar — remove the number** — in `drawHpBar`, delete the HP `shadowText(`${e.hp.toLocaleString()} / ${e.maxHp.toLocaleString()}`, ...)` line (currently ~230-231). Keep the bar rects and the monster-name label.

- [ ] **Step 3: Abbreviate floaters** — in the SSE state handler where floaters are pushed (line ~126), change `text: '-' + (p.damage - before)` to `text: '-' + fmt(p.damage - before)`.

- [ ] **Step 4: Abbreviate leaderboard** — in `drawLeaderboard` (line ~265) change the stats line to:
```js
    shadowText(`L${p.level}  ${fmt(p.effectiveTokens)} tok  ${fmt(p.gold)}g  x${p.modifier.toFixed(2)}`,
      textX, y + rowH * 0.72, `${Math.round(rowH * 0.28)}px system-ui`, '#9a86b0', 'left');
```

- [ ] **Step 5: Abbreviate defeat popup** — in `drawDefeat`, change the total (line ~293) to `Total damage ${fmt(d.totalDamage)}` and the per-row line (line ~302) damage/gold to `fmt`:
```js
    ctx.fillText(`${mvp}${p.name}  ${fmt(p.damage)} (${pct}%)  ${fmt(p.tokensDuringFight)}tok  +${fmt(p.gold)}g` +
      (p.leveledTo ? `  ⬆L${p.leveledTo}` : ''), x + w * 0.1, ry);
```
(Adds the per-player fight tokens for the number-curious, abbreviated.)

- [ ] **Step 6: Verify** — `node --check src/web/public/tv/tv.js && npx vitest run && npm run typecheck` all green. Then the controller seeds a scratch DB, serves `/tv`, and confirms via headless-Chrome screenshot: HP bar shows no number (bar + name only); leaderboard/floaters/defeat numbers render abbreviated.
- [ ] **Step 7: Commit** — `git add src/web/public/tv/tv.js && git commit -m "feat(tv): bar-only HP + abbreviated K/M/B/T numbers"`

---

## Self-Review

- **Spec coverage:** activity modifier (T2), HP model A (T5), diminishing curve (T4), gold by tokens (T3+T6), bar-only HP (T9), abbreviated numbers (T1+T9), settings changes (T5 add / T8 remove). All spec §Testing items map to task tests.
- **Green at every step:** new pure modules (T1–T3) and the curve (T4) don't touch config; T5 adds config additively (old fields retained) so engine/tvview still compile; T6/T7 move consumers to new fields; T8 removes the now-unused old fields; T9 is display-only. No intermediate build is broken.
- **Type consistency:** `levelCurveSlope`/`baselineBattleMinutes`/`decayAfterMinutes`/`decaySpanMinutes`/`goldDamageWeight` added in T5 and consumed in T5/T6/T7; `estimateOfficeBaselineDpm` defined in T5, used in `spawnEncounter`; `splitGold`/`activityScore` signatures match across engine + tvview; `ActivityCfg` is structurally satisfied by `EngineConfig`.
- **No placeholders:** all module code is complete; wiring steps show exact before/after.

## Deploy note (carry into the merge message / roadmap)

On the Pi, `seedSettings` (`INSERT OR IGNORE`) adds the 5 new keys on next start; the 3 retired keys linger unread. Because the model changed, retune on the real TV: `base_hit`, `token_modifier_k`, `level_curve_slope`, `baseline_battle_minutes`.

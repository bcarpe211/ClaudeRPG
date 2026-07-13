# Combat Feel Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live `/tv` combat read as a real fight — heroes lunge *toward* the monster (#3), and the monster strikes back at a random player every ~15s with a minor gold-loss or damage-debuff consequence, shown with a monster lunge, hero flinch, impact FX, and a persistent debuff badge (#5).

**Architecture:** A new durable `monster_attacks` log table records each retaliation. The engine schedules a monster attack timer (like per-player swing timers), applies the consequence (gold `UPDATE` or a logged debuff), and inserts a log row. The debuff is *derived from the log* by a pure helper `debuffFactor`, read by both the engine's swing loop and the TV view-model — one source of truth. `tvview` surfaces the latest attack (one-shot animation) plus a per-hero `debuffed` flag (persistent badge). All visuals are in `tv.js`.

**Tech Stack:** Node + TypeScript (tsx/ESM), better-sqlite3, vitest, Express/EJS, HTML5 Canvas 2D + SSE for the TV. FX sprites from the oryx pack served via the existing `/sprites` static mount.

## Global Constraints

- Node 26 + better-sqlite3 v12; tsx/ESM; tests via `npx vitest run`.
- The engine takes an injected `rng` + `now` — never call `Date.now()`/`Math.random()` inside domain logic; keep everything deterministic.
- No new npm dependencies.
- Domain logic lives in `src/domain/*`; keep `engine.ts` lean by putting pure/derived helpers in `retaliation.ts`.
- `tv.js` is a classic script (no imports/build step) — mirror any shared constants by hand, as existing code does (`fmt`, `MSHADOW`, `ANIM_ROW`).
- Every `DEFAULT_SETTINGS` key MUST have a matching `SETTINGS_META` entry (a coverage test fails the build otherwise).
- Commit after each task's tests pass.

---

### Task 1: `monster_attacks` migration

**Files:**
- Modify: `src/db/migrations.ts` (append a migration to the `migrations` array)
- Test: `tests/db-monster-attacks-migration.test.ts` (create)

**Interfaces:**
- Produces: a `monster_attacks` table `(id, encounter_id, player_id, kind, gold_delta, ts)` with an index on `encounter_id`.

- [ ] **Step 1: Write the failing test**

Create `tests/db-monster-attacks-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('monster_attacks migration', () => {
  it('creates the monster_attacks table with the expected columns', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r: any) => r.name);
    expect(tables).toContain('monster_attacks');
    const cols = db.prepare("PRAGMA table_info(monster_attacks)").all().map((r: any) => r.name);
    expect(cols.sort()).toEqual(['encounter_id', 'gold_delta', 'id', 'kind', 'player_id', 'ts']);
  });

  it('accepts an insert and defaults gold_delta to 0', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
    db.prepare(`INSERT INTO encounters
      (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at)
      VALUES (1,0,'single',1,1,1,100,100,'active',0)`).run();
    db.prepare('INSERT INTO players (name,class_key,gender,auth_token,created_at) VALUES (?,?,?,?,0)')
      .run('A', 'knight', 'M', 'tok');
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,ts) VALUES (1,1,'debuff',500)").run();
    const row = db.prepare('SELECT * FROM monster_attacks WHERE id=1').get() as any;
    expect(row.gold_delta).toBe(0);
    expect(row.kind).toBe('debuff');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db-monster-attacks-migration.test.ts`
Expected: FAIL — `expect(tables).toContain('monster_attacks')` fails (no such table).

- [ ] **Step 3: Add the migration**

In `src/db/migrations.ts`, append this object to the `migrations` array (after `004_game_engine`):

```ts
  {
    id: '005_monster_attacks',
    sql: `
      CREATE TABLE monster_attacks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        encounter_id INTEGER NOT NULL,
        player_id    INTEGER NOT NULL,
        kind         TEXT NOT NULL,               -- 'gold' | 'debuff'
        gold_delta   INTEGER NOT NULL DEFAULT 0,  -- gold stolen (0 for debuff)
        ts           INTEGER NOT NULL,
        FOREIGN KEY (encounter_id) REFERENCES encounters(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_monster_attacks_encounter ON monster_attacks (encounter_id);
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db-monster-attacks-migration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts tests/db-monster-attacks-migration.test.ts
git commit -m "feat(db): monster_attacks log table (005 migration)"
```

---

### Task 2: Settings, metadata, and EngineConfig

**Files:**
- Modify: `src/domain/settings.ts` (add 6 keys to `DEFAULT_SETTINGS`)
- Modify: `src/domain/settings-meta.ts` (add group + 6 meta entries)
- Modify: `src/domain/encounters.ts` (`EngineConfig` + `loadEngineConfig`)
- Test: `tests/retaliation-config.test.ts` (create)

**Interfaces:**
- Produces: settings keys `monster_attacks_enabled`, `monster_attack_interval_ms`, `monster_attack_jitter_ms`, `monster_gold_steal`, `monster_debuff_factor`, `monster_debuff_seconds`.
- Produces: `EngineConfig` fields `monsterAttacksEnabled: number`, `monsterAttackIntervalMs: number`, `monsterAttackJitterMs: number`, `monsterGoldSteal: number`, `monsterDebuffFactor: number`, `monsterDebuffSeconds: number`.

- [ ] **Step 1: Write the failing test**

Create `tests/retaliation-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, DEFAULT_SETTINGS } from '../src/domain/settings';
import { loadEngineConfig } from '../src/domain/encounters';
import { SETTINGS_META } from '../src/domain/settings-meta';

const KEYS = ['monster_attacks_enabled', 'monster_attack_interval_ms', 'monster_attack_jitter_ms',
  'monster_gold_steal', 'monster_debuff_factor', 'monster_debuff_seconds'];

describe('monster-retaliation settings', () => {
  it('defines defaults + metadata for every new key', () => {
    for (const k of KEYS) {
      expect(DEFAULT_SETTINGS[k], k).toBeDefined();
      expect(SETTINGS_META[k], k).toBeDefined();
      expect(SETTINGS_META[k].group).toBe('Monster retaliation');
    }
  });

  it('loadEngineConfig reads the new knobs with defaults', () => {
    const db = openDb(':memory:'); seedSettings(db);
    const cfg = loadEngineConfig(db);
    expect(cfg.monsterAttacksEnabled).toBe(1);
    expect(cfg.monsterAttackIntervalMs).toBe(15000);
    expect(cfg.monsterAttackJitterMs).toBe(5000);
    expect(cfg.monsterGoldSteal).toBe(5);
    expect(cfg.monsterDebuffFactor).toBeCloseTo(0.85);
    expect(cfg.monsterDebuffSeconds).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/retaliation-config.test.ts`
Expected: FAIL — `DEFAULT_SETTINGS['monster_attacks_enabled']` is undefined.

- [ ] **Step 3a: Add defaults**

In `src/domain/settings.ts`, add to the `DEFAULT_SETTINGS` object (after `tick_interval_ms`):

```ts
  monster_attacks_enabled: '1',    // 1 = monster strikes back at players; 0 = off
  monster_attack_interval_ms: '15000', // base time between monster counter-attacks
  monster_attack_jitter_ms: '5000',    // +/- jitter on the strike interval
  monster_gold_steal: '5',         // max gold a strike steals (broke -> debuff instead)
  monster_debuff_factor: '0.85',   // swing-damage multiplier while debuffed
  monster_debuff_seconds: '8',     // debuff duration
```

- [ ] **Step 3b: Add the group + metadata**

In `src/domain/settings-meta.ts`, insert `'Monster retaliation'` into `GROUP_ORDER` after `'Monster HP & difficulty'`:

```ts
export const GROUP_ORDER = [
  'Progression', 'Combat', 'Activity modifier', 'Monster HP & difficulty',
  'Monster retaliation', 'Economy', 'Encounters & pacing', 'System',
] as const;
```

Then add these entries to `SETTINGS_META` (e.g. right after the `difficulty_ramp_per_dungeon` entry):

```ts
  // Monster retaliation
  monster_attacks_enabled: { group: 'Monster retaliation', label: 'Monster attacks back', unit: '0/1', min: 0, max: 1, step: 1,
    description: 'Master switch for the monster striking back at players. 1 = on, 0 = off (monsters never retaliate).' },
  monster_attack_interval_ms: { group: 'Monster retaliation', label: 'Monster strike interval', unit: 'ms', min: 1000, step: 500,
    description: 'Base milliseconds between monster counter-attacks during a fight. Lower = the monster hits players more often.' },
  monster_attack_jitter_ms: { group: 'Monster retaliation', label: 'Monster strike jitter', unit: 'ms', min: 0, step: 500,
    description: 'Random ± spread on the strike interval so counter-attacks are not perfectly regular. Higher = more variation in timing.' },
  monster_gold_steal: { group: 'Monster retaliation', label: 'Gold stolen per hit', unit: 'gold', min: 0, step: 1,
    description: 'Most gold a monster hit can steal from a player (never more than they have). Higher = a gold-loss hit stings more. A broke player is debuffed instead.' },
  monster_debuff_factor: { group: 'Monster retaliation', label: 'Debuff damage multiplier', unit: '×', min: 0, max: 1, step: 0.05,
    description: 'Swing-damage multiplier while a player is debuffed by a monster hit (0.85 = 15% weaker). Lower = a harsher debuff. 1.0 = the debuff does nothing.' },
  monster_debuff_seconds: { group: 'Monster retaliation', label: 'Debuff duration', unit: 's', min: 1, step: 1,
    description: 'How many seconds a monster debuff lasts before a player returns to full strength. Higher = the weakening lingers longer.' },
```

- [ ] **Step 3c: Add EngineConfig fields**

In `src/domain/encounters.ts`, add to the `EngineConfig` interface (after `goldDamageWeight`):

```ts
  monsterAttacksEnabled: number; monsterAttackIntervalMs: number;
  monsterAttackJitterMs: number; monsterGoldSteal: number;
  monsterDebuffFactor: number; monsterDebuffSeconds: number;
```

And in the object returned by `loadEngineConfig` (after `goldDamageWeight: ...`):

```ts
    monsterAttacksEnabled: n('monster_attacks_enabled', 1),
    monsterAttackIntervalMs: n('monster_attack_interval_ms', 15000),
    monsterAttackJitterMs: n('monster_attack_jitter_ms', 5000),
    monsterGoldSteal: n('monster_gold_steal', 5),
    monsterDebuffFactor: n('monster_debuff_factor', 0.85),
    monsterDebuffSeconds: n('monster_debuff_seconds', 8),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/retaliation-config.test.ts tests/settings-meta.test.ts`
Expected: PASS — new config test green AND the pre-existing `settings-meta` coverage test still green (proves every new key has metadata).

- [ ] **Step 5: Commit**

```bash
git add src/domain/settings.ts src/domain/settings-meta.ts src/domain/encounters.ts tests/retaliation-config.test.ts
git commit -m "feat(settings): monster-retaliation knobs + metadata group + EngineConfig"
```

---

### Task 3: `retaliation.ts` pure/derived helpers

**Files:**
- Create: `src/domain/retaliation.ts`
- Test: `tests/retaliation.test.ts` (create)

**Interfaces:**
- Consumes: the `monster_attacks` table (Task 1); `EngineConfig` is structurally compatible with `DebuffCfg`.
- Produces:
  - `pickTarget<T>(players: T[], rng: () => number): T | null`
  - `rollConsequence(rng: () => number): 'gold' | 'debuff'`
  - `goldSteal(currentGold: number, max: number): number`
  - `debuffFactor(db, playerId: number, now: number, cfg: DebuffCfg): number`
  - `interface DebuffCfg { monsterDebuffFactor: number; monsterDebuffSeconds: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/retaliation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { pickTarget, rollConsequence, goldSteal, debuffFactor } from '../src/domain/retaliation';

const cfg = { monsterDebuffFactor: 0.85, monsterDebuffSeconds: 8 };

describe('retaliation helpers', () => {
  it('pickTarget returns null on empty, else an element chosen by rng', () => {
    expect(pickTarget([], () => 0)).toBeNull();
    const arr = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(pickTarget(arr, () => 0)!.id).toBe(1);
    expect(pickTarget(arr, () => 0.99)!.id).toBe(3);
  });

  it('rollConsequence: <0.5 gold, >=0.5 debuff', () => {
    expect(rollConsequence(() => 0.1)).toBe('gold');
    expect(rollConsequence(() => 0.5)).toBe('debuff');
    expect(rollConsequence(() => 0.9)).toBe('debuff');
  });

  it('goldSteal clamps to balance and never goes negative', () => {
    expect(goldSteal(100, 5)).toBe(5);
    expect(goldSteal(3, 5)).toBe(3);
    expect(goldSteal(0, 5)).toBe(0);
    expect(goldSteal(-10, 5)).toBe(0);
  });

  it('debuffFactor is <1 only while a debuff row is inside the window', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
    db.prepare(`INSERT INTO encounters
      (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at)
      VALUES (1,0,'single',1,1,1,100,100,'active',0)`).run();
    db.prepare('INSERT INTO players (name,class_key,gender,auth_token,created_at) VALUES (?,?,?,?,0)')
      .run('A', 'knight', 'M', 'tok');
    // no rows yet
    expect(debuffFactor(db, 1, 10_000, cfg)).toBe(1);
    // a debuff at t=10_000; window is 8s
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,ts) VALUES (1,1,'debuff',10000)").run();
    expect(debuffFactor(db, 1, 10_000, cfg)).toBeCloseTo(0.85);        // same instant
    expect(debuffFactor(db, 1, 17_999, cfg)).toBeCloseTo(0.85);        // inside 8s
    expect(debuffFactor(db, 1, 18_001, cfg)).toBe(1);                  // expired
    // a gold row must NOT trigger a debuff
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,gold_delta,ts) VALUES (1,1,'gold',5,30000)").run();
    expect(debuffFactor(db, 1, 30_000, cfg)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/retaliation.test.ts`
Expected: FAIL — cannot import from `src/domain/retaliation` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `src/domain/retaliation.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/retaliation.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/retaliation.ts tests/retaliation.test.ts
git commit -m "feat(domain): retaliation helpers (target/consequence/gold/debuff)"
```

---

### Task 4: Engine — monster attack timer, consequences, debuffed swings

**Files:**
- Modify: `src/domain/engine.ts`
- Test: `tests/engine-retaliation.test.ts` (create)

**Interfaces:**
- Consumes: `pickTarget`, `rollConsequence`, `goldSteal`, `debuffFactor` (Task 3); `EngineConfig.monster*` (Task 2); `monster_attacks` table (Task 1).
- Produces: on a monster-attack tick, a `monster_attacks` row and (for gold) a `players.gold` decrement; debuffed players' swings are multiplied by `monsterDebuffFactor` within the window.

Note on rng ordering (for deterministic tests): a *firing* monster attack draws rng in this order — schedule-jitter, then `pickTarget`, then `rollConsequence`. The first active tick draws only the schedule-jitter and does not attack (the timer is armed to fire ~interval later).

- [ ] **Step 1: Write the failing test**

Create `tests/engine-retaliation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

// keep the office active + no accidental kills so we can observe retaliation
function activeGame() {
  setSetting(db, 'min_encounter_hp', '100000000'); // huge HP: never dies during the test
  const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
  ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
  return p;
}

describe('engine monster retaliation', () => {
  it('does not attack on the first active tick, then strikes after the interval', () => {
    const p = activeGame();
    // rng=0.5 => jitter 0; target index floor(0.5*1)=0 (the only player); consequence 0.5 => debuff
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);                       // spawn + arm monster timer (interval 15000 -> fires at 115000)
    expect(db.prepare('SELECT COUNT(*) c FROM monster_attacks').get()).toMatchObject({ c: 0 });
    // keep activity fresh so the office isn't idle, then tick past 115000
    ingestTokenUsage(db, tokens(p.auth_token, 10), 116000, { cacheReadWeight: 0 });
    eng.tick(116000);
    const rows = db.prepare('SELECT * FROM monster_attacks').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].player_id).toBe(p.id);
    expect(rows[0].kind).toBe('debuff');    // rng 0.5 -> debuff
  });

  it('a gold roll on a broke player re-rolls to debuff (a hit always lands)', () => {
    const p = activeGame();
    // Draw order across the two ticks: arm-schedule (tick1), fire-schedule, pickTarget,
    // rollConsequence (tick2). The 4th draw clamps to the last element (0.1 -> gold).
    // Player has 0 gold, so the gold roll re-rolls to debuff.
    const seq = [0, 0, 0.1]; let i = 0;
    const rng = () => seq[Math.min(i++, seq.length - 1)];
    const eng = new GameEngine(db, { rng });
    eng.tick(100000);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 116000, { cacheReadWeight: 0 });
    eng.tick(116000);
    const row = db.prepare('SELECT * FROM monster_attacks ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.kind).toBe('debuff');
    expect(row.gold_delta).toBe(0);
    expect(getPlayerById(db, p.id)!.gold).toBe(0);    // unchanged
  });

  it('a gold roll on a player with gold steals up to the cap and logs it', () => {
    const p = activeGame();
    db.prepare('UPDATE players SET gold=100 WHERE id=?').run(p.id);
    // Same draw order as above; 4th draw clamps to 0.1 -> gold. Player has gold -> steal.
    const seq = [0, 0, 0.1]; let i = 0;
    const eng = new GameEngine(db, { rng: () => seq[Math.min(i++, seq.length - 1)] });
    eng.tick(100000);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 116000, { cacheReadWeight: 0 });
    eng.tick(116000);
    const row = db.prepare('SELECT * FROM monster_attacks ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.kind).toBe('gold');
    expect(row.gold_delta).toBe(5);                   // monster_gold_steal default
    expect(getPlayerById(db, p.id)!.gold).toBe(95);
  });

  it('monster_attacks_enabled=0 suppresses all retaliation', () => {
    const p = activeGame();
    setSetting(db, 'monster_attacks_enabled', '0');
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 200000, { cacheReadWeight: 0 });
    eng.tick(200000);
    expect(db.prepare('SELECT COUNT(*) c FROM monster_attacks').get()).toMatchObject({ c: 0 });
  });

  it('a logged debuff reduces the debuffed player\'s next swing', () => {
    const p = activeGame();
    setSetting(db, 'attack_jitter_ms', '0');          // deterministic swing schedule
    // Insert a debuff covering the swing at t=104000 (first swing ~interval after spawn).
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);                                 // spawn; swing armed for ~104000
    const enc = db.prepare("SELECT id FROM encounters WHERE status='active'").get() as any;
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,ts) VALUES (?,?, 'debuff', 104000)")
      .run(enc.id, p.id);
    ingestTokenUsage(db, tokens(p.auth_token, 10), 104000, { cacheReadWeight: 0 });
    eng.tick(104000);                                 // swing lands debuffed
    const dmg = (db.prepare('SELECT max_hit FROM encounter_damage WHERE player_id=?').get(p.id) as any).max_hit;
    // base_hit=100, level 1 (damageMultiplier=1), modifier≈1, debuff 0.85 -> ~85
    expect(dmg).toBeLessThan(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-retaliation.test.ts`
Expected: FAIL — no monster_attacks rows are ever written (engine has no retaliation yet).

- [ ] **Step 3: Wire the engine**

In `src/domain/engine.ts`:

3a. Add the import (next to the existing `combat`/`activity` imports):

```ts
import { pickTarget, rollConsequence, goldSteal, debuffFactor } from './retaliation';
```

3b. Add a field to `GameEngine` (next to `nextAttackAt`):

```ts
  private nextMonsterAttackAt = 0; // 0 = unscheduled (armed on the next active tick)
```

3c. In `tick()`, extend the paused→active reset block to also disarm the monster timer. Change:

```ts
    if (this.wasPaused) {
      this.nextAttackAt.clear();
      this.wasPaused = false;
    }
```

to:

```ts
    if (this.wasPaused) {
      this.nextAttackAt.clear();
      this.nextMonsterAttackAt = 0;
      this.wasPaused = false;
    }
```

3d. In the per-player swing loop in `tick()`, apply the debuff to the modifier. Change:

```ts
        const score = activityScore(this.db, p.id, now, cfg);
        const mod = tokenModifier(score, cfg.tokenModifierK);
        const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelCurveSlope, mod);
```

to:

```ts
        const score = activityScore(this.db, p.id, now, cfg);
        const mod = tokenModifier(score, cfg.tokenModifierK) * debuffFactor(this.db, p.id, now, cfg);
        const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelCurveSlope, mod);
```

3e. In `tick()`, call the monster attack right before `resolveKillIfDead`. Change:

```ts
    this.resolveKillIfDead(encId, now, cfg);
```

to:

```ts
    this.maybeMonsterAttack(encId, now, cfg);
    this.resolveKillIfDead(encId, now, cfg);
```

3f. Add the two methods to `GameEngine` (e.g. after `resolveKillIfDead`):

```ts
  private scheduleMonsterAttack(now: number, cfg: EngineConfig): number {
    const jitter = (this.rng() * 2 - 1) * cfg.monsterAttackJitterMs;
    return now + cfg.monsterAttackIntervalMs + jitter;
  }

  private maybeMonsterAttack(encId: number, now: number, cfg: EngineConfig): void {
    if (cfg.monsterAttacksEnabled <= 0) return;
    if (this.nextMonsterAttackAt === 0) {
      this.nextMonsterAttackAt = this.scheduleMonsterAttack(now, cfg); // arm; don't strike yet
      return;
    }
    if (now < this.nextMonsterAttackAt) return;
    this.nextMonsterAttackAt = this.scheduleMonsterAttack(now, cfg);

    const target = pickTarget(this.activePlayers(), this.rng);
    if (!target) return;

    let kind = rollConsequence(this.rng);
    let amount = 0;
    if (kind === 'gold') {
      const cur = (this.db.prepare('SELECT gold FROM players WHERE id=?').get(target.id) as { gold: number }).gold;
      amount = goldSteal(cur, cfg.monsterGoldSteal);
      if (amount <= 0) kind = 'debuff'; // broke -> debuff so a hit always lands
    }

    this.db.transaction(() => {
      if (kind === 'gold' && amount > 0) {
        this.db.prepare('UPDATE players SET gold = gold - ? WHERE id=?').run(amount, target.id);
      }
      this.db.prepare(
        'INSERT INTO monster_attacks (encounter_id, player_id, kind, gold_delta, ts) VALUES (?, ?, ?, ?, ?)',
      ).run(encId, target.id, kind, amount, now);
    })();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/engine-retaliation.test.ts`
Expected: PASS (all five tests).

- [ ] **Step 5: Run the full suite (guard against regressions)**

Run: `npx vitest run`
Expected: PASS. Rationale: existing multi-tick tests are unaffected — early game has 0 gold so a gold roll re-rolls to debuff (no gold change), and the one 100s-gap test (`engine-kill`) kills the monster near t≈4s, before the 15s timer arms a strike. If any pre-existing test that ticks across >15s DOES break because it now sees a stray debuff/log row, fix it by adding `setSetting(db, 'monster_attacks_enabled', '0');` to that test's setup — do not weaken this feature's defaults.

- [ ] **Step 6: Commit**

```bash
git add src/domain/engine.ts tests/engine-retaliation.test.ts
git commit -m "feat(engine): monster retaliation (timer, gold/debuff consequence, debuffed swings)"
```

---

### Task 5: View-model — surface the attack event + debuffed flag

**Files:**
- Modify: `src/web/tvview.ts`
- Test: `tests/tvview-monster-attack.test.ts` (create)

**Interfaces:**
- Consumes: `debuffFactor` (Task 3); `monster_attacks` table (Task 1); `loadEngineConfig` (already imported in `tvview.ts`).
- Produces:
  - `interface TvMonsterAttack { id: number; playerId: number; kind: 'gold' | 'debuff'; amount: number }`
  - `TvState.monsterAttack: TvMonsterAttack | null`
  - `TvHero.debuffed: boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/tvview-monster-attack.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { buildTvState } from '../src/web/tvview';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('buildTvState monster attack', () => {
  it('monsterAttack is null with no attacks; debuffed is false', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const s = buildTvState(db, 100000);
    expect(s.monsterAttack).toBeNull();
    expect(s.players[0].debuffed).toBe(false);
  });

  it('surfaces the latest attack for the active encounter and sets debuffed inside the window', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const enc = db.prepare("SELECT id FROM encounters WHERE status='active'").get() as any;
    db.prepare("INSERT INTO monster_attacks (encounter_id,player_id,kind,gold_delta,ts) VALUES (?,?, 'debuff', 0, 100500)")
      .run(enc.id, p.id);
    const s = buildTvState(db, 101000);                 // within 8s of 100500
    expect(s.monsterAttack).toMatchObject({ playerId: p.id, kind: 'debuff', amount: 0 });
    expect(s.monsterAttack!.id).toBeGreaterThan(0);
    expect(s.players[0].debuffed).toBe(true);
    // past the window: debuff clears, event still reported (latest row)
    const s2 = buildTvState(db, 109000);                // 8.5s later
    expect(s2.players[0].debuffed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tvview-monster-attack.test.ts`
Expected: FAIL — `s.monsterAttack` is undefined (property does not exist).

- [ ] **Step 3: Extend the view-model**

In `src/web/tvview.ts`:

3a. Add the import (with the other `../domain/*` imports):

```ts
import { debuffFactor } from '../domain/retaliation';
```

3b. Add the event interface and extend `TvHero` + `TvState`:

```ts
export interface TvMonsterAttack {
  id: number; playerId: number; kind: 'gold' | 'debuff'; amount: number;
}
```

In `TvHero`, add after `damage`:

```ts
  debuffed: boolean;
```

In `TvState`, add after `players`:

```ts
  monsterAttack: TvMonsterAttack | null;
```

3c. In `buildTvState`, set `debuffed` in the players map. Change the mapped object's tail:

```ts
    damage: dmgByPlayer.get(p.id) ?? 0, x: null, y: null,
  }));
```

to:

```ts
    damage: dmgByPlayer.get(p.id) ?? 0, x: null, y: null,
    debuffed: debuffFactor(db, p.id, now, cfg) < 1,
  }));
```

3d. Compute `monsterAttack` after the `encounter` block (uses `encounter?.id`), just before the defeat block:

```ts
  // Latest monster counter-attack this encounter (drives the one-shot TV animation).
  let monsterAttack: TvMonsterAttack | null = null;
  if (encounter) {
    const row = db.prepare(
      'SELECT id, player_id, kind, gold_delta FROM monster_attacks WHERE encounter_id=? ORDER BY id DESC LIMIT 1',
    ).get(encounter.id) as { id: number; player_id: number; kind: 'gold' | 'debuff'; gold_delta: number } | undefined;
    if (row) monsterAttack = { id: row.id, playerId: row.player_id, kind: row.kind, amount: row.gold_delta };
  }
```

3e. Add `monsterAttack` to the returned object. Change:

```ts
  return { dungeonId: gs.current_dungeon_id, paused: !!gs.paused, encounter, players, defeat };
```

to:

```ts
  return { dungeonId: gs.current_dungeon_id, paused: !!gs.paused, encounter, players, defeat, monsterAttack };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tvview-monster-attack.test.ts tests/tvview-state.test.ts`
Expected: PASS — new test green AND the existing `tvview-state` test still green (adding fields doesn't break it).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/web/tvview.ts tests/tvview-monster-attack.test.ts
git commit -m "feat(tvview): surface monster attacks + per-hero debuffed flag"
```

---

### Task 6: TV renderer — lunge direction (#3) + retaliation visuals (#5)

**Files:**
- Modify: `src/web/public/tv/tv.js`

**Interfaces:**
- Consumes: `state.monsterAttack` (`{id, playerId, kind, amount}`) and `player.debuffed` from Task 5; `layout.monster` (`{x, y}`) and `state.encounter.footprint` (already in the payload).

`tv.js` is a classic script with no test harness; verification is visual (Step 6), consistent with prior TV builds. Make the edits precisely as below.

- [ ] **Step 1: Add FX constants + a direction helper**

Near the top of `tv.js`, after the `ANIM_ROW` constant (line ~13), add:

```js
// Retaliation FX (fx_32x32 impact frames; fx_24x24 persistent debuff badge)
const FX = {
  gold:   ['/sprites/fx_32x32/oryx_16bit_fantasy_fx_83.png', '/sprites/fx_32x32/oryx_16bit_fantasy_fx_84.png'],
  debuff: ['/sprites/fx_32x32/oryx_16bit_fantasy_fx_11.png', '/sprites/fx_32x32/oryx_16bit_fantasy_fx_12.png'],
};
const DEBUFF_BADGE = '/sprites/fx_24x24/oryx_16bit_fantasy_fx2_45.png';
```

After the `floaters` declaration (line ~61), add:

```js
let monsterHit = null;   // {playerId, kind, amount, born} — last monster counter-attack
```

Add this helper (e.g. just above `drawSprite`):

```js
// Unit vector from a hero tile toward the monster centre; {x:0,y:0} if none/coincident.
function dirToMonster(hx, hy) {
  const m = layout && layout.monster;
  if (!m) return { x: 0, y: 0 };
  const fp = (state && state.encounter && state.encounter.footprint) || 1;
  const dx = (m.x + fp / 2) - (hx + 0.5);
  const dy = (m.y + fp / 2) - (hy + 0.5);
  const len = Math.hypot(dx, dy);
  return len < 0.001 ? { x: 0, y: 0 } : { x: dx / len, y: dy / len };
}
```

- [ ] **Step 2: Detect the attack event in the `state` SSE handler**

In the `evt.addEventListener('state', ...)` handler, after the swing-detection `if` block and before `state = next;`, add:

```js
  // detect a new monster counter-attack -> trigger flinch/FX/floater (once per id)
  if (state && next.monsterAttack &&
      (!state.monsterAttack || next.monsterAttack.id !== state.monsterAttack.id)) {
    const ma = next.monsterAttack;
    monsterHit = { playerId: ma.playerId, kind: ma.kind, amount: ma.amount, born: performance.now() };
    const tp = next.players.find((p) => p.id === ma.playerId);
    if (tp && tp.x !== null) {
      const text = ma.kind === 'gold' ? (ma.amount > 0 ? '-' + fmt(ma.amount) + 'g' : '') : 'WEAKENED';
      floaters.push({ x: tp.x, y: tp.y, text, born: performance.now(),
        color: ma.kind === 'gold' ? '#ffd36a' : '#ff5a5a' });
    }
  }
```

- [ ] **Step 3: Point the hero swing lunge at the monster (#3) + add flinch/FX/badge (#5)**

Replace the whole `drawHeroes` function with:

```js
function drawHeroes(t) {
  for (const p of state.players) {
    if (p.x === null) continue;
    const a = anim.get(p.id);
    const swinging = a && a.until > performance.now();
    const { px, py } = tileToField(p.x + 0.5, p.y + 1); // py = bottom edge of the hero's tile
    const w = 26 * scale, h = 28 * scale;
    const groundY = footLine(py);

    // #3: lunge along the vector toward the monster (not just downward)
    const d = swinging ? dirToMonster(p.x, p.y) : { x: 0, y: 0 };
    const L = swinging ? 0.25 * tilePx : 0;

    // #5: flinch away from the monster while a fresh monster hit is on this hero
    const hit = monsterHit && monsterHit.playerId === p.id ? monsterHit : null;
    const hitAge = hit ? performance.now() - hit.born : Infinity;
    let fx = 0, fy = 0;
    if (hitAge < 350) {
      const dm = dirToMonster(p.x, p.y);
      const pulse = Math.sin((hitAge / 350) * Math.PI);
      fx = -dm.x * pulse * tilePx * 0.2;   // recoil away from monster
      fy = -dm.y * pulse * tilePx * 0.2;
    }

    const drawX = px + d.x * L + fx;
    const drawY = groundY + d.y * L + fy;

    groundShadow('M', px, groundY, Math.round(tilePx * 0.66));
    if (swinging) ctx.globalAlpha = 0.85;
    drawSprite(animImg(p.avatarUrl, p.id, t), drawX, drawY, w, h);
    ctx.globalAlpha = 1;

    // red flash over the hero on a fresh hit
    if (hitAge < 250) {
      ctx.globalAlpha = 0.5 * (1 - hitAge / 250);
      ctx.fillStyle = '#ff2a2a';
      ctx.fillRect(Math.round(drawX - w / 2), Math.round(drawY - h), w, h);
      ctx.globalAlpha = 1;
    }

    // impact FX sprite (2-frame) centred on the hero's body
    if (hit && hitAge < 400) {
      const frames = FX[hit.kind];
      const fim = img(frames[Math.floor(hitAge / 120) % 2]);
      const fs = tilePx * 1.4;
      ctx.drawImage(fim, Math.round(drawX - fs / 2), Math.round(drawY - h / 2 - fs / 2), fs, fs);
    }

    // persistent red "!" badge, top-right of the avatar, while debuffed
    if (p.debuffed) {
      const bs = w * 0.4;
      ctx.drawImage(img(DEBUFF_BADGE), Math.round(drawX + w / 2 - bs), Math.round(drawY - h), bs, bs);
    }
  }
}
```

- [ ] **Step 4: Make the monster lunge at the player it strikes**

In `drawMonster`, replace the single line:

```js
  drawSprite(animImg(e.creatureUrl, 100, t), px, cy, size, size);
```

with:

```js
  // lunge toward the player the monster just struck (recoil in and back out)
  let mlx = 0, mly = 0;
  if (monsterHit) {
    const age = performance.now() - monsterHit.born;
    const tp = state.players.find((p) => p.id === monsterHit.playerId);
    if (age < 450 && tp && tp.x !== null) {
      const ddx = (tp.x + 0.5) - (m.x + fp / 2);
      const ddy = (tp.y + 0.5) - (m.y + fp / 2);
      const len = Math.hypot(ddx, ddy) || 1;
      const pulse = Math.sin((age / 450) * Math.PI);
      mlx = (ddx / len) * pulse * tilePx * 0.4;
      mly = (ddy / len) * pulse * tilePx * 0.4;
    }
  }
  drawSprite(animImg(e.creatureUrl, 100, t), px + mlx, cy + mly, size, size);
```

- [ ] **Step 5: Honor floater color + skip empty text**

Replace the body of `drawFloaters` inner loop. Change:

```js
    if (age > 900) { floaters.splice(i, 1); continue; }
    const { px, py } = tileToField(f.x + 0.5, f.y);
    ctx.globalAlpha = 1 - age / 900;
    ctx.fillStyle = '#ffd36a'; ctx.font = `${Math.round(10 * scale)}px system-ui`;
```

to:

```js
    if (age > 900) { floaters.splice(i, 1); continue; }
    if (!f.text) continue;
    const { px, py } = tileToField(f.x + 0.5, f.y);
    ctx.globalAlpha = 1 - age / 900;
    ctx.fillStyle = f.color || '#ffd36a'; ctx.font = `${Math.round(10 * scale)}px system-ui`;
```

- [ ] **Step 6: Visual-verify in a real browser**

Because headless raf-under-virtual-time freezes the animation clock (documented for prior TV builds), verify in a live browser:

1. Start the app against a scratch DB with FX assets available:
   `ENABLE_DUNGEON_PREVIEW=0 npm run dev` (or `npm start`), open `/tv`.
2. Force a visible retaliation quickly: in another shell, set a fast interval and register a player + stream a little activity so an encounter spawns —
   or, simplest, open the DB and insert a row against the active encounter:
   ```sql
   INSERT INTO monster_attacks (encounter_id, player_id, kind, gold_delta, ts)
   VALUES ((SELECT current_encounter_id FROM game_state WHERE id=1),
           (SELECT id FROM players LIMIT 1), 'debuff', 0, <now_ms>);
   ```
   (or `'gold', 5, <now_ms>` for the gold variant).
3. Confirm on `/tv`: heroes lunge *toward* the monster when they swing; on the
   inserted attack the monster lunges at the target, the hero flashes red +
   recoils, the correct FX pops (gold star vs red X), the floater reads `-5g` /
   `WEAKENED`, and a red "!" badge sits on the target's top-right corner for ~8s
   then disappears.
4. Also let it run with `monster_attack_interval_ms` temporarily set to `3000`
   (admin settings) to watch natural retaliations fire.

- [ ] **Step 7: Commit**

```bash
git add src/web/public/tv/tv.js
git commit -m "feat(tv): lunge toward monster (#3) + retaliation visuals — flinch, FX, badge (#5)"
```

---

## Final verification

- [ ] Run the full suite: `npx vitest run` — expected PASS.
- [ ] Typecheck: `npx tsc --noEmit` — expected no errors.
- [ ] Confirm the admin settings page shows the new "Monster retaliation" group with all six knobs and plain-language descriptions (GET `/admin/settings`).
- [ ] Update `docs/BACKLOG.md`: tick #3 done; tick #5 done (note the durable `monster_attacks` log enables a future "most-battered" leaderboard under #8).
</content>

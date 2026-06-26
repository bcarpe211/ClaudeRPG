# Plan C: Game Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn ingested tokens into a living game: a tick loop where each player swings on a timer dealing `BASE_HIT × levelMultiplier × tokenModifier` damage to a shared encounter; encounters form dungeons (2-3 regular + 1 boss) that regenerate; monster HP auto-calibrates to the office's current damage output to target a battle length; gold drops on kill split by damage; players level up from cumulative effective tokens; the dungeon pauses when the office is idle and resumes on the next token. All state persists for power-loss recovery.

**Architecture:** Builds on Plans A+B. Pure logic modules (`leveling`, `combat`, `creatures`) are unit-tested in isolation. DB-touching modules (`encounters` for spawn/HP/progression, `gamestate` for the singleton) sit above them. A `GameEngine` class orchestrates `tick(now)`: it determines pause, ensures a current encounter exists, resolves per-player attacks, applies level-ups, and on kill distributes gold and opens a defeat-popup window. The engine is **driven by an injected clock (`now` passed in) and RNG** so tests are deterministic; production wires a `setInterval` in `index.ts`. Rendering and WebSocket push are NOT here — they are Plan E. This plan produces and persists all game state plus a `buildDefeatSummary` data function that Plan E will render.

**Tech Stack:** Same as A/B. No new dependencies.

**Key design decisions:**
- **HP targets a battle *duration*** by calibrating to the office's estimated *damage per minute* (DPM) at spawn time — `HP = max(minHp, officeDPM × targetMinutes × difficultyFactor)` — a faithful realization of spec §5's "activeTokenRate × targetMinutes" using real combat output (which already incorporates the token modifier).
- **Pause = office-wide idle.** `paused` when no player has sent a token within `pause_after_minutes` (or never). While paused: no attacks, no spawns, timers frozen; on resume, per-player attack timers are re-staggered to avoid a thundering herd. Individual idle players still chip at modifier 1.0 *during* active periods (spec §2).
- **One swing per player per tick** when due (tick interval ≪ attack interval), keeping the loop simple and naturally staggered.
- **Damage is aggregated** in `encounter_damage` (per player per encounter), not per-swing rows.
- **Attack timers live in engine memory**, re-derived on boot (at most one interval lost) — durable game state (HP, gold, levels, dungeon/encounter, pause) is all in SQLite.

---

## File Structure

```
src/
  db/migrations.ts        (modify: add migration 004_game_engine)
  domain/
    settings.ts           (modify: add engine knobs to DEFAULT_SETTINGS)
    leveling.ts           (new: levelForXp, xpForLevelStart, damageMultiplier)
    combat.ts             (new: tokenModifier, attackDamage)
    creatures.ts          (new: monster ladder + pickEncounterCreature)
    gamestate.ts          (new: game_state singleton + pause helpers)
    encounters.ts         (new: DPM estimate, calibrateHp, spawn/progression)
    engine.ts             (new: GameEngine.tick + kill resolution + defeat summary)
  index.ts                (modify: start the engine tick interval)
tests/
  db-engine-migration.test.ts
  leveling.test.ts
  combat.test.ts
  creatures.test.ts
  gamestate.test.ts
  encounters.test.ts
  engine-attacks.test.ts
  engine-kill.test.ts
  engine-defeat-summary.test.ts
```

**Conventions:** ESM, extensionless imports, `import type Database from 'better-sqlite3'`, core functions take explicit `now`; the engine takes an injectable `rng`. Tests use `openDb(':memory:')`, `seedSettings(db)`, and the Plan A/B helpers (`createPlayer`, `ingestTokenUsage`, etc.).

---

## Task 1: Migration + engine settings knobs

**Files:**
- Modify: `src/db/migrations.ts`, `src/domain/settings.ts`
- Test: `tests/db-engine-migration.test.ts`

- [ ] **Step 1: Write the failing test** `tests/db-engine-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { DEFAULT_SETTINGS } from '../src/domain/settings';

describe('game engine migration + settings', () => {
  it('creates the engine tables', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r: any) => r.name);
    for (const t of ['dungeons', 'encounters', 'encounter_damage', 'level_ups', 'game_state']) {
      expect(tables).toContain(t);
    }
  });

  it('seeds the singleton game_state row', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT * FROM game_state WHERE id = 1').get() as any;
    expect(row).toBeTruthy();
    expect(row.paused).toBe(1); // starts paused/idle
  });

  it('adds engine knobs to DEFAULT_SETTINGS', () => {
    for (const k of ['min_encounter_hp', 'difficulty_ramp_per_encounter',
      'difficulty_ramp_per_dungeon', 'regular_encounters_min',
      'regular_encounters_max', 'tick_interval_ms']) {
      expect(DEFAULT_SETTINGS[k]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db-engine-migration.test.ts`
Expected: FAIL — tables/keys missing.

- [ ] **Step 3: Append migration `004_game_engine` to `src/db/migrations.ts`** (after `003_token_ingestion`):

```ts
  {
    id: '004_game_engine',
    sql: `
      CREATE TABLE dungeons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level INTEGER NOT NULL,
        theme TEXT NOT NULL,
        seed INTEGER NOT NULL,
        regular_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE encounters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dungeon_id INTEGER NOT NULL,
        index_in_dungeon INTEGER NOT NULL,
        kind TEXT NOT NULL,            -- single | pack | boss
        creature_index INTEGER NOT NULL,
        footprint INTEGER NOT NULL,    -- 1 (1x1) or 2 (2x2)
        pack_count INTEGER NOT NULL DEFAULT 1,
        max_hp INTEGER NOT NULL,
        current_hp INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',  -- active | defeated
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        FOREIGN KEY (dungeon_id) REFERENCES dungeons(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_encounters_dungeon ON encounters (dungeon_id, index_in_dungeon);
      CREATE TABLE encounter_damage (
        encounter_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        damage_total INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        max_hit INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (encounter_id, player_id),
        FOREIGN KEY (encounter_id) REFERENCES encounters(id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE TABLE level_ups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        new_level INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE TABLE game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_dungeon_id INTEGER,
        current_encounter_id INTEGER,
        paused INTEGER NOT NULL DEFAULT 1,
        last_activity_at INTEGER,
        defeat_until INTEGER,
        last_defeat_encounter_id INTEGER
      );
      INSERT INTO game_state (id, paused) VALUES (1, 1);
    `,
  },
```

- [ ] **Step 4: Add engine knobs to `DEFAULT_SETTINGS` in `src/domain/settings.ts`**

Add these entries to the `DEFAULT_SETTINGS` object (after the existing `pause_after_minutes` line):

```ts
  min_encounter_hp: '2000',              // floor so battles are never trivial
  difficulty_ramp_per_encounter: '0.15', // +15% HP per encounter within a dungeon
  difficulty_ramp_per_dungeon: '0.25',   // +25% HP per dungeon level
  regular_encounters_min: '2',           // regular encounters before the boss
  regular_encounters_max: '3',
  tick_interval_ms: '1000',              // engine tick cadence (production loop)
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/db-engine-migration.test.ts && npx vitest run tests/settings.test.ts`
Expected: PASS (migration tests + the existing settings tests still green — `getAllSettings` count is derived from `DEFAULT_SETTINGS`, so adding keys is safe).

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/domain/settings.ts tests/db-engine-migration.test.ts
git commit -m "feat: game engine schema + tunable knobs"
```

---

## Task 2: Leveling math (`src/domain/leveling.ts`)

**Files:**
- Create: `src/domain/leveling.ts`
- Test: `tests/leveling.test.ts`

Cumulative XP to *reach* level L (starting at level 1, xp 0) is `baseXp × (growth^(L-1) − 1)/(growth − 1)`. `levelForXp` returns the highest L whose threshold ≤ xp.

- [ ] **Step 1: Write the failing test** `tests/leveling.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { levelForXp, xpForLevelStart, damageMultiplier } from '../src/domain/leveling';

const BASE = 50000, GROWTH = 1.5;

describe('leveling', () => {
  it('starts at level 1 with 0 xp', () => {
    expect(levelForXp(0, BASE, GROWTH)).toBe(1);
    expect(levelForXp(49999, BASE, GROWTH)).toBe(1);
  });

  it('reaches level 2 at base_xp', () => {
    expect(levelForXp(50000, BASE, GROWTH)).toBe(2);
  });

  it('level 3 needs base + base*growth', () => {
    // reach L3 = 50000 + 75000 = 125000
    expect(xpForLevelStart(3, BASE, GROWTH)).toBe(125000);
    expect(levelForXp(124999, BASE, GROWTH)).toBe(2);
    expect(levelForXp(125000, BASE, GROWTH)).toBe(3);
  });

  it('is monotonic and handed large xp', () => {
    expect(levelForXp(10_000_000, BASE, GROWTH)).toBeGreaterThan(5);
  });

  it('damageMultiplier grows linearly with level', () => {
    expect(damageMultiplier(1, 0.1)).toBeCloseTo(1.0);
    expect(damageMultiplier(10, 0.1)).toBeCloseTo(1.9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/leveling.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/leveling.ts`**

```ts
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

/** Damage multiplier from level: 1 + slope*(level-1). */
export function damageMultiplier(level: number, slope: number): number {
  return 1 + slope * (level - 1);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/leveling.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/leveling.ts tests/leveling.test.ts
git commit -m "feat: leveling curve and damage multiplier"
```

---

## Task 3: Combat math (`src/domain/combat.ts`)

**Files:**
- Create: `src/domain/combat.ts`
- Test: `tests/combat.test.ts`

- [ ] **Step 1: Write the failing test** `tests/combat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tokenModifier, attackDamage } from '../src/domain/combat';

describe('combat', () => {
  it('tokenModifier floors at 1.0 when idle', () => {
    expect(tokenModifier(0, 20000)).toBe(1);
  });

  it('tokenModifier rises with recent tokens', () => {
    expect(tokenModifier(20000, 20000)).toBeCloseTo(2); // 1 + 20000/20000
    expect(tokenModifier(10000, 20000)).toBeCloseTo(1.5);
  });

  it('attackDamage = round(baseHit * levelMult * modifier), min 1', () => {
    // baseHit 100, level 1 (mult 1.0, slope .1), modifier 1 -> 100
    expect(attackDamage(100, 1, 0.1, 1)).toBe(100);
    // level 10 (mult 1.9), modifier 2 -> 100*1.9*2 = 380
    expect(attackDamage(100, 10, 0.1, 2)).toBe(380);
  });

  it('never deals less than 1', () => {
    expect(attackDamage(0, 1, 0.1, 1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/combat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/combat.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/combat.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/combat.ts tests/combat.test.ts
git commit -m "feat: token modifier and per-swing attack damage"
```

---

## Task 4: Creature ladder (`src/domain/creatures.ts`)

**Files:**
- Create: `src/domain/creatures.ts`
- Test: `tests/creatures.test.ts`

Monster `creature_index` values are from `creature_key.doc` (indices 19+; 1-18 are heroes). Regular tiers are 1×1; bosses are big 2×2 creatures. Difficulty advances by dungeon level.

- [ ] **Step 1: Write the failing test** `tests/creatures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickEncounterCreature, MONSTER_TIERS, BOSSES } from '../src/domain/creatures';

// deterministic rng: always returns 0 (picks first element)
const rng0 = () => 0;

describe('creatures', () => {
  it('has ordered tiers and bosses', () => {
    expect(MONSTER_TIERS.length).toBeGreaterThan(3);
    expect(BOSSES.length).toBeGreaterThan(2);
    expect(MONSTER_TIERS[0].length).toBeGreaterThan(0);
  });

  it('regular encounter picks a 1x1 creature from the dungeon-level tier', () => {
    const c = pickEncounterCreature(1, 'single', rng0);
    expect(c.footprint).toBe(1);
    expect(c.creatureIndex).toBe(MONSTER_TIERS[0][0]);
  });

  it('boss encounter picks a 2x2 boss creature', () => {
    const c = pickEncounterCreature(1, 'boss', rng0);
    expect(c.footprint).toBe(2);
    expect(c.creatureIndex).toBe(BOSSES[0]);
  });

  it('higher dungeon levels select tougher tiers (clamped at the top)', () => {
    const lowTier = pickEncounterCreature(1, 'single', rng0).creatureIndex;
    const highTier = pickEncounterCreature(99, 'single', rng0).creatureIndex;
    expect(highTier).toBe(MONSTER_TIERS[MONSTER_TIERS.length - 1][0]);
    expect(highTier).not.toBe(lowTier);
  });

  it('pack kind is still a 1x1 creature', () => {
    expect(pickEncounterCreature(2, 'pack', rng0).footprint).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/creatures.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/creatures.ts`**

```ts
export type EncounterKind = 'single' | 'pack' | 'boss';

export interface PickedCreature {
  creatureIndex: number;
  footprint: number; // 1 = 1x1, 2 = 2x2
}

// creature_key.doc indices. Ordered easiest -> hardest. All 1x1 regulars.
export const MONSTER_TIERS: number[][] = [
  [121, 122, 116, 117, 114, 115, 124], // rats, bats, slimes, beetle
  [20, 132, 133, 123, 119, 126],       // bandit, goblins, cobra, spider, wolf
  [137, 134, 153, 155, 151],           // orc, goblin captain, skeletons, zombie
  [140, 138, 85, 95, 158],             // troll, orc captain, lizardman, gnoll, mummy
  [144, 160, 163, 99, 156],            // death knight, necromancer, vampire, minotaur, shadow
  [105, 142, 184, 103, 147],           // stone golem, cyclops, ettin, fire demon, earth elemental
  [170, 172, 102, 162, 173],           // red/gold dragon, elder demon, Death, green dragon
];

// 2x2 bosses, ordered easiest -> hardest.
export const BOSSES: number[] = [
  99,  // Minotaur Axe
  140, // Troll
  105, // Stone Golem
  142, // Cyclops
  184, // Ettin
  103, // Fire Demon
  102, // Elder Demon
  170, // Red Dragon
  172, // Gold Dragon
  162, // Death
];

function pick<T>(arr: T[], rng: () => number): T {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}

/** Choose a creature for an encounter. dungeonLevel is 1-based. */
export function pickEncounterCreature(
  dungeonLevel: number,
  kind: EncounterKind,
  rng: () => number,
): PickedCreature {
  if (kind === 'boss') {
    const i = Math.min(dungeonLevel - 1, BOSSES.length - 1);
    return { creatureIndex: BOSSES[i], footprint: 2 };
  }
  const tierIndex = Math.min(dungeonLevel - 1, MONSTER_TIERS.length - 1);
  return { creatureIndex: pick(MONSTER_TIERS[tierIndex], rng), footprint: 1 };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/creatures.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/creatures.ts tests/creatures.test.ts
git commit -m "feat: monster difficulty ladder and boss roster"
```

---

## Task 5: Encounter spawning, HP calibration & progression (`src/domain/encounters.ts`)

**Files:**
- Create: `src/domain/encounters.ts`
- Test: `tests/encounters.test.ts`

- [ ] **Step 1: Write the failing test** `tests/encounters.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import {
  estimateOfficeDamagePerMinute,
  calibrateHp,
  advanceToNextEncounter,
  loadEngineConfig,
} from '../src/domain/encounters';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

describe('calibrateHp', () => {
  it('is officeDpm * minutes * difficulty, floored at minHp', () => {
    expect(calibrateHp(1000, 30, 1, 2000)).toBe(30000);
    expect(calibrateHp(1, 1, 1, 2000)).toBe(2000); // floor
  });
});

describe('estimateOfficeDamagePerMinute', () => {
  it('sums per-player DPM for enabled players, modifier floored at 1', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    createPlayer(db, { name: 'B', class_key: 'thief', gender: 'F' }, 1);
    const cfg = loadEngineConfig(db);
    const dpm = estimateOfficeDamagePerMinute(db, cfg, 100000);
    // 2 players, level 1 mult 1.0, modifier 1.0, baseHit 100, interval 4000ms
    // swings/min = 60000/4000 = 15; dpm/player = 15*100 = 1500; office = 3000
    expect(dpm).toBeCloseTo(3000, 0);
  });
});

describe('advanceToNextEncounter', () => {
  const rngHalf = () => 0.5;
  it('spawns dungeon level 1 + encounter index 0 when none exists', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    advanceToNextEncounter(db, 1000, loadEngineConfig(db), rngHalf);
    const d = db.prepare('SELECT * FROM dungeons').get() as any;
    const e = db.prepare('SELECT * FROM encounters').get() as any;
    expect(d.level).toBe(1);
    expect(e.index_in_dungeon).toBe(0);
    expect(e.current_hp).toBe(e.max_hp);
    expect(e.max_hp).toBeGreaterThan(0);
    const gs = db.prepare('SELECT * FROM game_state WHERE id=1').get() as any;
    expect(gs.current_encounter_id).toBe(e.id);
  });

  it('progresses through regulars then a boss, then a new dungeon', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const cfg = loadEngineConfig(db);
    // force regular_count = 2 by stubbing rng so floor(rng*(max-min+1))+min = 2
    const rng = () => 0; // min regulars (2), 'single' kind, first creature
    advanceToNextEncounter(db, 1, cfg, rng); // dungeon1 enc0
    let encs = db.prepare('SELECT * FROM encounters ORDER BY id').all() as any[];
    const d1 = (db.prepare('SELECT * FROM dungeons ORDER BY id').get() as any);
    // mark enc0 defeated and advance
    db.prepare("UPDATE encounters SET status='defeated' WHERE id=?").run(encs[0].id);
    advanceToNextEncounter(db, 2, cfg, rng); // enc1 (regular)
    advanceToNextEncounter; // no-op reference
    encs = db.prepare('SELECT * FROM encounters ORDER BY id').all() as any[];
    // depending on regular_count=2, index1 is the last regular; defeat it, next is boss
    db.prepare("UPDATE encounters SET status='defeated' WHERE id=?").run(encs[1].id);
    advanceToNextEncounter(db, 3, cfg, rng);
    encs = db.prepare('SELECT * FROM encounters ORDER BY id').all() as any[];
    const boss = encs[encs.length - 1];
    expect(boss.kind).toBe('boss');
    expect(boss.footprint).toBe(2);
    // defeat boss -> new dungeon level 2
    db.prepare("UPDATE encounters SET status='defeated' WHERE id=?").run(boss.id);
    advanceToNextEncounter(db, 4, cfg, rng);
    const dungeons = db.prepare('SELECT * FROM dungeons ORDER BY id').all() as any[];
    expect(dungeons.length).toBe(2);
    expect(dungeons[1].level).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/encounters.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/encounters.ts`**

```ts
import type Database from 'better-sqlite3';
import { getAllSettings } from './settings';
import { damageMultiplier } from './leveling';
import { tokenModifier } from './combat';
import { sumEffectiveSince } from './ingest';
import { pickEncounterCreature, type EncounterKind } from './creatures';

export interface EngineConfig {
  baseXp: number; xpGrowth: number; levelMultSlope: number;
  baseHit: number; attackIntervalMs: number; attackJitterMs: number;
  tokenModifierK: number; recentWindowMinutes: number;
  targetBattleMinutes: number; bossHpMult: number; goldFactor: number;
  minEncounterHp: number; difficultyRampPerEncounter: number;
  difficultyRampPerDungeon: number; regularEncountersMin: number;
  regularEncountersMax: number; pauseAfterMinutes: number;
  popupDurationS: number; tickIntervalMs: number;
}

export function loadEngineConfig(db: Database.Database): EngineConfig {
  const s = getAllSettings(db);
  const n = (k: string, d: number) => (s[k] !== undefined ? Number(s[k]) : d);
  return {
    baseXp: n('base_xp', 50000), xpGrowth: n('xp_growth', 1.5),
    levelMultSlope: n('level_mult_slope', 0.1),
    baseHit: n('base_hit', 100), attackIntervalMs: n('attack_interval_ms', 4000),
    attackJitterMs: n('attack_jitter_ms', 1500),
    tokenModifierK: n('token_modifier_k', 20000),
    recentWindowMinutes: n('recent_window_minutes', 10),
    targetBattleMinutes: n('target_battle_minutes', 30),
    bossHpMult: n('boss_hp_mult', 3), goldFactor: n('gold_factor', 0.01),
    minEncounterHp: n('min_encounter_hp', 2000),
    difficultyRampPerEncounter: n('difficulty_ramp_per_encounter', 0.15),
    difficultyRampPerDungeon: n('difficulty_ramp_per_dungeon', 0.25),
    regularEncountersMin: n('regular_encounters_min', 2),
    regularEncountersMax: n('regular_encounters_max', 3),
    pauseAfterMinutes: n('pause_after_minutes', 15),
    popupDurationS: n('popup_duration_s', 120),
    tickIntervalMs: n('tick_interval_ms', 1000),
  };
}

interface EnabledPlayer { id: number; level: number; effective_tokens: number; }

function enabledPlayers(db: Database.Database): EnabledPlayer[] {
  return db.prepare(
    'SELECT id, level, effective_tokens FROM players WHERE disabled = 0',
  ).all() as EnabledPlayer[];
}

/** Estimate the office's current damage output per minute (drives HP). */
export function estimateOfficeDamagePerMinute(
  db: Database.Database,
  cfg: EngineConfig,
  now: number,
): number {
  const since = now - cfg.recentWindowMinutes * 60_000;
  const swingsPerMin = 60_000 / cfg.attackIntervalMs;
  let dpm = 0;
  for (const p of enabledPlayers(db)) {
    const recent = sumEffectiveSince(db, p.id, since);
    const mod = tokenModifier(recent, cfg.tokenModifierK);
    const perHit = cfg.baseHit * damageMultiplier(p.level, cfg.levelMultSlope) * mod;
    dpm += swingsPerMin * perHit;
  }
  return dpm;
}

export function calibrateHp(
  officeDpm: number,
  targetMinutes: number,
  difficultyFactor: number,
  minHp: number,
): number {
  return Math.max(minHp, Math.round(officeDpm * targetMinutes * difficultyFactor));
}

const THEMES = ['stone_crypt', 'cave', 'wood_fort'];

function spawnEncounter(
  db: Database.Database,
  dungeon: { id: number; level: number; regular_count: number },
  index: number,
  now: number,
  cfg: EngineConfig,
  rng: () => number,
): number {
  const isBoss = index >= dungeon.regular_count;
  const kind: EncounterKind = isBoss ? 'boss' : rng() < 0.5 ? 'single' : 'pack';
  const creature = pickEncounterCreature(dungeon.level, kind, rng);
  const packCount = kind === 'pack' ? 3 + Math.floor(rng() * 3) : 1;
  const difficulty =
    (1 + cfg.difficultyRampPerEncounter * index) *
    (1 + cfg.difficultyRampPerDungeon * (dungeon.level - 1)) *
    (isBoss ? cfg.bossHpMult : 1);
  const dpm = estimateOfficeDamagePerMinute(db, cfg, now);
  const hp = calibrateHp(dpm, cfg.targetBattleMinutes, difficulty, cfg.minEncounterHp);
  const info = db.prepare(
    `INSERT INTO encounters
       (dungeon_id, index_in_dungeon, kind, creature_index, footprint, pack_count,
        max_hp, current_hp, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(dungeon.id, index, kind, creature.creatureIndex, creature.footprint,
        packCount, hp, hp, now);
  const encId = Number(info.lastInsertRowid);
  db.prepare(
    'UPDATE game_state SET current_dungeon_id=?, current_encounter_id=?, defeat_until=NULL WHERE id=1',
  ).run(dungeon.id, encId);
  return encId;
}

function newDungeon(
  db: Database.Database, level: number, now: number, cfg: EngineConfig, rng: () => number,
): { id: number; level: number; regular_count: number } {
  const theme = THEMES[Math.min(THEMES.length - 1, Math.floor(rng() * THEMES.length))];
  const seed = Math.floor(rng() * 2_000_000_000);
  const span = Math.max(0, cfg.regularEncountersMax - cfg.regularEncountersMin);
  const regularCount = cfg.regularEncountersMin + Math.floor(rng() * (span + 1));
  const info = db.prepare(
    'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (?,?,?,?,?)',
  ).run(level, theme, seed, regularCount, now);
  return { id: Number(info.lastInsertRowid), level, regular_count: regularCount };
}

/**
 * Ensure a fresh active encounter exists, advancing the game:
 * - no dungeon yet -> dungeon level 1, encounter 0
 * - mid-dungeon -> next encounter index
 * - boss was the last encounter -> new dungeon (level + 1)
 */
export function advanceToNextEncounter(
  db: Database.Database, now: number, cfg: EngineConfig, rng: () => number,
): void {
  const gs = db.prepare('SELECT * FROM game_state WHERE id=1').get() as any;
  let dungeon = gs.current_dungeon_id
    ? (db.prepare('SELECT * FROM dungeons WHERE id=?').get(gs.current_dungeon_id) as any)
    : null;

  if (!dungeon) {
    dungeon = newDungeon(db, 1, now, cfg, rng);
    spawnEncounter(db, dungeon, 0, now, cfg, rng);
    return;
  }
  const lastIdx = (db.prepare(
    'SELECT MAX(index_in_dungeon) AS m FROM encounters WHERE dungeon_id=?',
  ).get(dungeon.id) as any).m ?? -1;

  if (lastIdx >= dungeon.regular_count) {
    const next = newDungeon(db, dungeon.level + 1, now, cfg, rng);
    spawnEncounter(db, next, 0, now, cfg, rng);
  } else {
    spawnEncounter(db, dungeon, lastIdx + 1, now, cfg, rng);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/encounters.test.ts`
Expected: PASS. (If the multi-step progression test is brittle on `regular_count`, the implementer may make the rng explicit per call so `regular_count` is deterministically 2; keep the assertions about boss kind/footprint and the level-2 dungeon.)

- [ ] **Step 5: Commit**

```bash
git add src/domain/encounters.ts tests/encounters.test.ts
git commit -m "feat: encounter spawning, HP calibration, dungeon progression"
```

---

## Task 6: Game-state & pause helpers (`src/domain/gamestate.ts`)

**Files:**
- Create: `src/domain/gamestate.ts`
- Test: `tests/gamestate.test.ts`

- [ ] **Step 1: Write the failing test** `tests/gamestate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, updatePlayer } from '../src/domain/players';
import { getGameState, setPaused, lastActivityAt, isIdle } from '../src/domain/gamestate';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

describe('gamestate', () => {
  it('reads the singleton and starts paused', () => {
    expect(getGameState(db).paused).toBe(1);
  });

  it('setPaused toggles and stamps last_activity', () => {
    setPaused(db, false, 1234);
    const gs = getGameState(db);
    expect(gs.paused).toBe(0);
    expect(gs.last_activity_at).toBe(1234);
  });

  it('lastActivityAt is the max player last_token_at', () => {
    const a = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const b = createPlayer(db, { name: 'B', class_key: 'thief', gender: 'F' }, 1);
    updatePlayer(db, a.id, {}); // no-op
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(5000, a.id);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(9000, b.id);
    expect(lastActivityAt(db)).toBe(9000);
  });

  it('isIdle true when no activity or activity older than pause window', () => {
    expect(isIdle(db, 100000, 15)).toBe(true); // no tokens ever
    const a = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    db.prepare('UPDATE players SET last_token_at=? WHERE id=?').run(100000, a.id);
    expect(isIdle(db, 100000 + 14 * 60000, 15)).toBe(false); // within 15 min
    expect(isIdle(db, 100000 + 16 * 60000, 15)).toBe(true);  // beyond 15 min
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/gamestate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/gamestate.ts`**

```ts
import type Database from 'better-sqlite3';

export interface GameState {
  id: number;
  current_dungeon_id: number | null;
  current_encounter_id: number | null;
  paused: number;
  last_activity_at: number | null;
  defeat_until: number | null;
  last_defeat_encounter_id: number | null;
}

export function getGameState(db: Database.Database): GameState {
  return db.prepare('SELECT * FROM game_state WHERE id=1').get() as GameState;
}

export function setPaused(db: Database.Database, paused: boolean, now: number): void {
  db.prepare(
    'UPDATE game_state SET paused=?, last_activity_at=? WHERE id=1',
  ).run(paused ? 1 : 0, now);
}

/** Max last_token_at across all players (0 if none). */
export function lastActivityAt(db: Database.Database): number {
  const row = db.prepare(
    'SELECT COALESCE(MAX(last_token_at), 0) AS m FROM players',
  ).get() as { m: number };
  return row.m;
}

/** Office is idle if no tokens ever, or last activity is older than the window. */
export function isIdle(db: Database.Database, now: number, pauseAfterMinutes: number): boolean {
  const last = lastActivityAt(db);
  if (last === 0) return true;
  return now - last > pauseAfterMinutes * 60_000;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/gamestate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/gamestate.ts tests/gamestate.test.ts
git commit -m "feat: game_state singleton and pause/idle helpers"
```

---

## Task 7: Engine tick — pause, attacks, level-ups (`src/domain/engine.ts`)

**Files:**
- Create: `src/domain/engine.ts`
- Test: `tests/engine-attacks.test.ts`

- [ ] **Step 1: Write the failing test** `tests/engine-attacks.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('engine attacks', () => {
  it('stays paused with no activity and spawns nothing', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const eng = new GameEngine(db, { rng: () => 0 });
    eng.tick(100000);
    expect(db.prepare('SELECT COUNT(*) AS c FROM encounters').get()).toMatchObject({ c: 0 });
    expect((db.prepare('SELECT paused FROM game_state WHERE id=1').get() as any).paused).toBe(1);
  });

  it('on activity: unpauses, spawns an encounter, and players deal damage over ticks', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    // first tick: unpause + spawn (no attack yet because timers are scheduled into the future)
    eng.tick(100000);
    const enc = db.prepare('SELECT * FROM encounters WHERE status="active"').get() as any;
    expect(enc).toBeTruthy();
    const hp0 = enc.current_hp;
    // advance several ticks past the attack interval so a swing lands
    for (let t = 1; t <= 10; t++) eng.tick(100000 + t * 1000);
    const enc2 = db.prepare('SELECT * FROM encounters WHERE id=?').get(enc.id) as any;
    expect(enc2.current_hp).toBeLessThan(hp0);
    const dmg = db.prepare('SELECT * FROM encounter_damage WHERE encounter_id=?').all(enc.id) as any[];
    expect(dmg.length).toBe(1);
    expect(dmg[0].hits).toBeGreaterThan(0);
  });

  it('levels a player up from cumulative effective tokens and records it', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    // 60000 effective tokens -> level 2 (base_xp 50000)
    ingestTokenUsage(db, tokens(p.auth_token, 60000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    expect(getPlayerById(db, p.id)!.level).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM level_ups WHERE player_id=?').get(p.id) as any).c).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/engine-attacks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/engine.ts`**

```ts
import type Database from 'better-sqlite3';
import { loadEngineConfig, advanceToNextEncounter, type EngineConfig } from './encounters';
import { isIdle, setPaused, getGameState } from './gamestate';
import { levelForXp } from './leveling';
import { tokenModifier, attackDamage } from './combat';
import { sumEffectiveSince } from './ingest';

export interface EngineDeps {
  rng?: () => number;
}

interface ActivePlayer {
  id: number;
  level: number;
  effective_tokens: number;
}

export class GameEngine {
  private rng: () => number;
  private nextAttackAt = new Map<number, number>();
  private wasPaused = true;

  constructor(private db: Database.Database, deps: EngineDeps = {}) {
    this.rng = deps.rng ?? Math.random;
  }

  private scheduleNext(now: number, cfg: EngineConfig): number {
    const jitter = (this.rng() * 2 - 1) * cfg.attackJitterMs;
    return now + cfg.attackIntervalMs + jitter;
  }

  private activePlayers(): ActivePlayer[] {
    return this.db.prepare(
      'SELECT id, level, effective_tokens FROM players WHERE disabled = 0',
    ).all() as ActivePlayer[];
  }

  private updateLevel(p: ActivePlayer, cfg: EngineConfig, now: number): void {
    const newLevel = levelForXp(p.effective_tokens, cfg.baseXp, cfg.xpGrowth);
    if (newLevel > p.level) {
      this.db.prepare('UPDATE players SET level=? WHERE id=?').run(newLevel, p.id);
      this.db.prepare(
        'INSERT INTO level_ups (player_id, new_level, ts) VALUES (?, ?, ?)',
      ).run(p.id, newLevel, now);
      p.level = newLevel;
    }
  }

  private applyHit(encId: number, playerId: number, dmg: number): void {
    this.db.prepare('UPDATE encounters SET current_hp = MAX(0, current_hp - ?) WHERE id=?')
      .run(dmg, encId);
    this.db.prepare(
      `INSERT INTO encounter_damage (encounter_id, player_id, damage_total, hits, max_hit)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(encounter_id, player_id) DO UPDATE SET
         damage_total = damage_total + excluded.damage_total,
         hits = hits + 1,
         max_hit = MAX(max_hit, excluded.max_hit)`,
    ).run(encId, playerId, dmg, dmg);
  }

  /** Advance the game by one tick. `now` is epoch ms. */
  tick(now: number): void {
    const cfg = loadEngineConfig(this.db);
    const idle = isIdle(this.db, now, cfg.pauseAfterMinutes);

    if (idle) {
      setPaused(this.db, true, now);
      this.wasPaused = true;
      return;
    }

    // Active. Unpause; re-stagger attack timers on the paused->active transition.
    setPaused(this.db, false, now);
    if (this.wasPaused) {
      this.nextAttackAt.clear();
      this.wasPaused = false;
    }

    let gs = getGameState(this.db);
    // Respect the defeat-popup window before spawning the next encounter.
    if (gs.defeat_until && now < gs.defeat_until) return;

    const hasActive = gs.current_encounter_id &&
      (this.db.prepare("SELECT status FROM encounters WHERE id=?")
        .get(gs.current_encounter_id) as any)?.status === 'active';
    if (!hasActive) {
      advanceToNextEncounter(this.db, now, cfg, this.rng);
      gs = getGameState(this.db);
    }

    const encId = gs.current_encounter_id!;
    const since = now - cfg.recentWindowMinutes * 60_000;

    for (const p of this.activePlayers()) {
      this.updateLevel(p, cfg, now);
      const next = this.nextAttackAt.get(p.id) ?? this.scheduleNext(now, cfg);
      if (now >= next) {
        const recent = sumEffectiveSince(this.db, p.id, since);
        const mod = tokenModifier(recent, cfg.tokenModifierK);
        const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelMultSlope, mod);
        this.applyHit(encId, p.id, dmg);
        this.nextAttackAt.set(p.id, this.scheduleNext(now, cfg));
      } else {
        this.nextAttackAt.set(p.id, next);
      }
    }
    // Kill resolution is added in Task 8.
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/engine-attacks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/engine.ts tests/engine-attacks.test.ts
git commit -m "feat: engine tick with pause, timed attacks, and level-ups"
```

---

## Task 8: Kill resolution, gold split & progression

**Files:**
- Modify: `src/domain/engine.ts`
- Test: `tests/engine-kill.test.ts`

- [ ] **Step 1: Write the failing test** `tests/engine-kill.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('engine kill resolution', () => {
  it('marks defeated, awards gold by damage share, and opens a defeat window', () => {
    // tiny HP so a few swings kill it
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'target_battle_minutes', '0'); // HP -> floor of 1
    setSetting(db, 'popup_duration_s', '120');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000); // spawn
    const enc = db.prepare('SELECT * FROM encounters WHERE status="active"').get() as any;
    // tick until the encounter dies
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(enc.id) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    const dead = db.prepare('SELECT * FROM encounters WHERE id=?').get(enc.id) as any;
    expect(dead.status).toBe('defeated');
    expect(dead.ended_at).toBeGreaterThan(0);
    expect(getPlayerById(db, p.id)!.gold).toBeGreaterThan(0);
    const gs = db.prepare('SELECT * FROM game_state WHERE id=1').get() as any;
    expect(gs.defeat_until).toBeGreaterThan(0);
    expect(gs.last_defeat_encounter_id).toBe(enc.id);
  });

  it('after the defeat window, the next encounter spawns', () => {
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'target_battle_minutes', '0');
    setSetting(db, 'popup_duration_s', '5');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const first = db.prepare('SELECT * FROM encounters WHERE status="active"').get() as any;
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(first.id) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    // keep activity fresh so the office isn't idle
    ingestTokenUsage(db, tokens(p.auth_token, 10), 200000, { cacheReadWeight: 0 });
    eng.tick(200000); // well past defeat_until (5s)
    const active = db.prepare('SELECT * FROM encounters WHERE status="active"').get() as any;
    expect(active).toBeTruthy();
    expect(active.id).not.toBe(first.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/engine-kill.test.ts`
Expected: FAIL — encounter never becomes 'defeated' (no kill logic yet).

- [ ] **Step 3: Add kill resolution to `src/domain/engine.ts`**

Add this private method to the `GameEngine` class:

```ts
  private resolveKillIfDead(encId: number, now: number, cfg: EngineConfig): void {
    const enc = this.db.prepare('SELECT * FROM encounters WHERE id=?').get(encId) as any;
    if (!enc || enc.status !== 'active' || enc.current_hp > 0) return;

    const dungeon = this.db.prepare('SELECT * FROM dungeons WHERE id=?').get(enc.dungeon_id) as any;
    const goldPool = Math.round(enc.max_hp * dungeon.level * cfg.goldFactor);
    const rows = this.db.prepare(
      'SELECT player_id, damage_total FROM encounter_damage WHERE encounter_id=?',
    ).all(encId) as { player_id: number; damage_total: number }[];
    const total = rows.reduce((s, r) => s + r.damage_total, 0) || 1;
    const award = this.db.prepare('UPDATE players SET gold = gold + ? WHERE id=?');
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE encounters SET status='defeated', ended_at=? WHERE id=?")
        .run(now, encId);
      for (const r of rows) {
        const gold = Math.round(goldPool * (r.damage_total / total));
        if (gold > 0) award.run(gold, r.player_id);
      }
      this.db.prepare(
        'UPDATE game_state SET defeat_until=?, last_defeat_encounter_id=?, current_encounter_id=NULL WHERE id=1',
      ).run(now + cfg.popupDurationS * 1000, encId);
    });
    tx();
  }
```

Then, in `tick`, call it right after the attack loop (replace the `// Kill resolution is added in Task 8.` comment):

```ts
    this.resolveKillIfDead(encId, now, cfg);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/engine-kill.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green; zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/domain/engine.ts tests/engine-kill.test.ts
git commit -m "feat: kill resolution, gold split, and defeat window"
```

---

## Task 9: Defeat summary data (`buildDefeatSummary`)

**Files:**
- Modify: `src/domain/engine.ts` (add exported function)
- Test: `tests/engine-defeat-summary.test.ts`

This produces the DATA for the popup Plan E will render. Pure query over a finished encounter.

- [ ] **Step 1: Write the failing test** `tests/engine-defeat-summary.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine, buildDefeatSummary } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, input: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(input), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('buildDefeatSummary', () => {
  it('summarizes per-player damage, gold, mvp, and creature for a defeated encounter', () => {
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'target_battle_minutes', '0');
    const p = createPlayer(db, { name: 'Aragorn', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const enc = db.prepare('SELECT * FROM encounters WHERE status="active"').get() as any;
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(enc.id) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    const sum = buildDefeatSummary(db, enc.id);
    expect(sum.encounterId).toBe(enc.id);
    expect(sum.creatureIndex).toBe(enc.creature_index);
    expect(sum.totalDamage).toBeGreaterThan(0);
    expect(sum.participants.length).toBe(1);
    expect(sum.participants[0].name).toBe('Aragorn');
    expect(sum.participants[0].damage).toBeGreaterThan(0);
    expect(sum.participants[0].gold).toBeGreaterThanOrEqual(0);
    expect(sum.mvpPlayerId).toBe(p.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/engine-defeat-summary.test.ts`
Expected: FAIL — `buildDefeatSummary` not exported.

- [ ] **Step 3: Add `buildDefeatSummary` to `src/domain/engine.ts`** (top-level export, not a method):

```ts
export interface DefeatParticipant {
  playerId: number;
  name: string;
  damage: number;
  hits: number;
  maxHit: number;
  gold: number;
  tokensDuringFight: number;
  leveledTo: number | null;
}

export interface DefeatSummary {
  encounterId: number;
  creatureIndex: number;
  kind: string;
  footprint: number;
  maxHp: number;
  totalDamage: number;
  durationMs: number;
  mvpPlayerId: number | null;
  biggestStrike: { playerId: number; amount: number } | null;
  participants: DefeatParticipant[];
}

export function buildDefeatSummary(
  db: Database.Database,
  encounterId: number,
): DefeatSummary {
  const enc = db.prepare('SELECT * FROM encounters WHERE id=?').get(encounterId) as any;
  const dungeon = db.prepare('SELECT * FROM dungeons WHERE id=?').get(enc.dungeon_id) as any;
  const goldPool = Math.round(enc.max_hp * dungeon.level *
    Number(db.prepare("SELECT value FROM settings WHERE key='gold_factor'").get() as any ?
      (db.prepare("SELECT value FROM settings WHERE key='gold_factor'").get() as any).value : 0.01));

  const dmgRows = db.prepare(
    'SELECT * FROM encounter_damage WHERE encounter_id=? ORDER BY damage_total DESC',
  ).all(encounterId) as any[];
  const totalDamage = dmgRows.reduce((s, r) => s + r.damage_total, 0);

  const start = enc.started_at;
  const end = enc.ended_at ?? start;

  const participants: DefeatParticipant[] = dmgRows.map((r) => {
    const player = db.prepare('SELECT name FROM players WHERE id=?').get(r.player_id) as any;
    const tok = db.prepare(
      'SELECT COALESCE(SUM(effective_delta),0) AS s FROM token_events WHERE player_id=? AND ts>=? AND ts<=?',
    ).get(r.player_id, start, end) as any;
    const lvl = db.prepare(
      'SELECT MAX(new_level) AS m FROM level_ups WHERE player_id=? AND ts>=? AND ts<=?',
    ).get(r.player_id, start, end) as any;
    const gold = totalDamage > 0 ? Math.round(goldPool * (r.damage_total / totalDamage)) : 0;
    return {
      playerId: r.player_id,
      name: player?.name ?? `#${r.player_id}`,
      damage: r.damage_total,
      hits: r.hits,
      maxHit: r.max_hit,
      gold,
      tokensDuringFight: tok.s,
      leveledTo: lvl.m ?? null,
    };
  });

  let mvpPlayerId: number | null = null;
  let biggest: { playerId: number; amount: number } | null = null;
  for (const r of dmgRows) {
    if (mvpPlayerId === null) mvpPlayerId = r.player_id; // rows are damage-desc
    if (!biggest || r.max_hit > biggest.amount) biggest = { playerId: r.player_id, amount: r.max_hit };
  }

  return {
    encounterId,
    creatureIndex: enc.creature_index,
    kind: enc.kind,
    footprint: enc.footprint,
    maxHp: enc.max_hp,
    totalDamage,
    durationMs: end - start,
    mvpPlayerId,
    biggestStrike: biggest,
    participants,
  };
}
```

(Note: the `gold_factor` lookup above is intentionally defensive; if you prefer, read it via `getAllSettings(db)` at the top of the function — use whichever is cleaner, but do not change the returned shape.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/engine-defeat-summary.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: green; zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/domain/engine.ts tests/engine-defeat-summary.test.ts
git commit -m "feat: defeat summary data for the popup"
```

---

## Task 10: Wire the engine loop into the server + smoke test

**Files:**
- Modify: `src/index.ts`
- Verification only (no new unit test; the loop is a thin wrapper)

- [ ] **Step 1: Start the engine tick interval in `src/index.ts`**

After `const app = createApp({ db, config });` and before/after `app.listen(...)`, add:

```ts
import { GameEngine } from './domain/engine';
import { loadEngineConfig } from './domain/encounters';
// ...
const engine = new GameEngine(db);
const tickMs = loadEngineConfig(db).tickIntervalMs;
setInterval(() => {
  try {
    engine.tick(Date.now());
  } catch (err) {
    console.error('[ClaudeRPG] engine tick error:', err);
  }
}, tickMs);
console.log(`[ClaudeRPG] game engine ticking every ${tickMs}ms`);
```

(Place the two `import` lines with the other imports at the top of the file.)

- [ ] **Step 2: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green; zero type errors.

- [ ] **Step 3: End-to-end smoke test**

```bash
rm -f ./data/smokec.db ./data/smokec.db-wal ./data/smokec.db-shm
ADMIN_PASSWORD=test123 PORT=8096 DB_PATH=./data/smokec.db npm start &
SMOKE_PID=$!
sleep 3
TOKEN=$(curl -s -X POST http://localhost:8096/register -d "name=Hero&class_key=knight&gender=M" \
  | grep -oE 'claude_rpg_token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
echo "token=$TOKEN"
# Send tokens to wake the engine:
curl -s -o /dev/null -X POST http://localhost:8096/v1/metrics -H 'Content-Type: application/json' \
  -d "{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"claude_rpg_token\",\"value\":{\"stringValue\":\"$TOKEN\"}}]},\"scopeMetrics\":[{\"metrics\":[{\"name\":\"claude_code.token.usage\",\"sum\":{\"aggregationTemporality\":1,\"dataPoints\":[{\"asInt\":\"500000\",\"startTimeUnixNano\":\"1\",\"timeUnixNano\":\"2\",\"attributes\":[{\"key\":\"type\",\"value\":{\"stringValue\":\"input\"}}]}]}}]}]}]}"
sleep 8   # let several engine ticks run
echo "--- game_state ---"
ADMIN_PASSWORD=test123 DB_PATH=./data/smokec.db node -e "
const Database=require('better-sqlite3');const db=new Database('./data/smokec.db');
console.log('game_state:', db.prepare('SELECT paused,current_encounter_id FROM game_state WHERE id=1').get());
console.log('encounters:', db.prepare('SELECT id,kind,creature_index,max_hp,current_hp,status FROM encounters').all());
console.log('player:', db.prepare('SELECT name,level,gold,effective_tokens FROM players').all());
"
kill $SMOKE_PID 2>/dev/null
rm -f ./data/smokec.db ./data/smokec.db-wal ./data/smokec.db-shm
```

Expected: `game_state.paused = 0`, a `current_encounter_id` set, at least one encounter row with `current_hp < max_hp` (damage landed), and the player at level ≥ 1 with `effective_tokens = 500000`. If the engine never unpauses or no encounter spawns, STOP and report BLOCKED with the observed output.

- [ ] **Step 4: Report** the observed `game_state`, encounters, and player rows. No commit beyond Step 1's wiring (commit that):

```bash
git add src/index.ts
git commit -m "feat: run the game engine tick loop in the server"
```

---

## Self-Review

**Spec coverage (§2, §4, §5, §6, §9):**
- Timed per-player attacks, damage = BASE_HIT × levelMult × tokenModifier → Tasks 3, 7. ✅
- tokenModifier = 1 + recentEffective/K, floor 1.0, from `sumEffectiveSince` → Tasks 3, 7. ✅
- Levels from cumulative effective tokens; level-ups recorded → Tasks 2, 7. ✅
- Encounters: single / pack / 2×2 boss; 2-3 regulars + boss; regenerate dungeon (level+1) after boss → Tasks 4, 5. ✅
- HP auto-calibrates to office damage output × target minutes × difficulty ramp (+ boss mult), floored → Task 5. ✅
- Gold on kill = maxHp × dungeonLevel × goldFactor, split by damage share → Task 8. ✅
- Defeat popup window (popup_duration_s) before next spawn → Task 8. ✅
- Defeat summary data (per-player damage/gold, tokens during fight, MVP, biggest strike, level-ups, duration) → Task 9. ✅
- Pause when office idle (pause_after_minutes), resume on activity, timers re-staggered → Tasks 6, 7. ✅
- Durable state (HP, gold, level, dungeon/encounter, pause) in SQLite; map seed stored for Plan D/E → Tasks 1, 5. ✅
- Engine loop wired into the server → Task 10. ✅

**Out of scope (correctly deferred):** tile-layout generation + hero/monster positions (Plan D); rendering, leaderboard, WebSocket push, popup rendering (Plan E). Plan C stores `theme` + `seed` so Plan D can generate the layout deterministically.

**Placeholder scan:** No TBD/"add error handling"/"similar to". Every step has full code. The progression test in Task 5 is noted as potentially rng-sensitive with guidance to make rng explicit; assertions target stable facts (boss kind/footprint, new dungeon level).

**Type consistency:** `EngineConfig`/`loadEngineConfig`, `estimateOfficeDamagePerMinute`, `calibrateHp`, `advanceToNextEncounter`, `GameEngine`/`tick`, `buildDefeatSummary`/`DefeatSummary`/`DefeatParticipant`, `levelForXp`/`xpForLevelStart`/`damageMultiplier`, `tokenModifier`/`attackDamage`, `getGameState`/`setPaused`/`isIdle`/`lastActivityAt`, `pickEncounterCreature`/`MONSTER_TIERS`/`BOSSES` are each defined once and used consistently. The engine reads recent tokens via Plan B's `sumEffectiveSince`.

**Determinism:** All game logic takes explicit `now` and an injectable `rng`; production passes `Date.now()` and `Math.random` only at the `index.ts` wiring layer. This keeps every engine test deterministic.

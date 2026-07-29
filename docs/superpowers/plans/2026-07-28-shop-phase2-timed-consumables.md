# Shop Phase 2 Timed Consumables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two approved beginner potions with auditable economics, combat-active duration, manual inventory activation, battlefield effects, a scalable player hub, and an admin-only Potion Lab.

**Architecture:** Build the feature in four ordered milestones: Economy Foundation, Potion Engine, Player Experience, and Reporting/Release. SQLite remains authoritative for inventory, activation progress, encounter awards, and every gold mutation; the existing engine and OTLP ingestion call small domain services inside their current transactions. The Bazaar and character page remain server-rendered EJS enhanced by plain browser JavaScript, while the compact dungeon reuses the existing TV renderer through an embed mode and the same SSE state.

**Tech Stack:** Node 26, TypeScript, tsx/ESM, Express 4, EJS, better-sqlite3, Zod, Canvas 2D, plain browser JavaScript, CSS, Vitest, Supertest.

**Approved design:** `docs/superpowers/specs/2026-07-28-timed-consumables-and-player-hub-design.md`

## Global Constraints

- Work on the existing `feat/player-shop-cosmetics` branch; do not create another phase-numbered branch or plan.
- Do not push, deploy, restart the Pi, SSH to production, or mutate production data while executing this plan.
- Add no runtime or development dependencies.
- Keep tsx/ESM conventions: relative TypeScript imports have no file extensions and there is no build step.
- Every new time-dependent domain entry receives `now: number`; add no `Date.now()` or `Math.random()` calls to domain logic.
- Every asynchronous Express handler uses `asyncHandler`; all purchase and activation inputs are validated with Zod.
- Keep personalized Bazaar and character responses `Cache-Control: private, no-store`; keep immutable skin URLs unchanged.
- Raw effective tokens remain work-only: input + output + cache creation + `round(cache read × cache_read_weight)`.
- Do not add a token/XP potion or alter XP/effective-token totals for any potion.
- Beginner Gold Potion: 100,000g, 7,200 combat-active seconds, 50g per whole 1,000 eligible effective tokens, 125,000g base cap, 25,000g stretch bonus at 2.5M eligible tokens.
- Beginner Damage Potion: 150,000g, 7,200 combat-active seconds, personal base hit +25% before level/activity/debuff multipliers.
- Personal stock resets to three per SKU at local midnight; use resets to three per potion type at local midnight; purchased inventory persists.
- Gold and Damage may overlap; the same potion type cannot stack, extend, replace, or queue.
- Combat-active time pauses during office idle, server downtime, no encounter, and the full defeat/results window.
- New encounters use the approved 80% work, 10% proportional damage, 5/3/2 podium split; the pool does not grow.
- Existing encounters finish under their stored legacy reward model; settings changes affect only future purchases, activations, or encounters.
- Preserve current cosmetic entitlements, slot maps, atomic batch save, revision conflict handling, Tone/presets/default behavior, and dirty-navigation protection exactly.
- Keep the existing red monster-debuff badge and render it alongside potion motes.
- All persistent potion state is database-derived and restart-safe; browser state is never authoritative.
- All motion respects `prefers-reduced-motion: reduce`.
- Do not implement automatic activation, queued refills, Tier 2/3 potions, Traveling Merchant, loot boxes, crafting, gems, pets, equipment behavior, a player-facing Potion Lab/newsletter, or encounter-HP pacing changes.

---

## Milestone A — Economy Foundation

This milestone is deployable with potion products still hidden. It establishes the schema, ledger, versioned rewards, and combat clock that later milestones consume.

## File Structure

- Modify `src/db/migrations.ts` — migration `012_timed_consumables` and opening gold balances.
- Modify `src/config.ts` — validated `OFFICE_TIME_ZONE` configuration.
- Modify `src/domain/settings.ts` and `src/domain/settings-meta.ts` — launch balance controls and admin metadata.
- Create `src/domain/goldledger.ts` — idempotent signed gold mutations and absolute admin adjustments.
- Modify `src/domain/players.ts`, `src/domain/shop.ts`, `src/domain/engine.ts`, and `src/web/routes/admin.ts` — route every runtime gold mutation through the ledger.
- Replace `src/domain/rewards.ts` — deterministic hybrid allocation and counterfactual support.
- Modify `src/domain/encounters.ts` — snapshot reward settings when an encounter spawns.
- Create `src/domain/office-time.ts` — DST-safe local-day, day-start, and next-midnight helpers.
- Create `src/domain/gameclock.ts` — persisted combat-active clock helpers.
- Add focused migration, ledger, reward, and clock tests named in each task.

### Task 1: Add the durable schema, launch settings, and office time zone

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/config.ts`
- Modify: `src/domain/settings.ts`
- Modify: `src/domain/settings-meta.ts`
- Create: `tests/db-timed-consumables-migration.test.ts`
- Create: `tests/db-timed-consumables-upgrade.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/settings-meta.test.ts`

**Interfaces:**
- Produces `Config.officeTimeZone: string`, defaulting to `America/New_York`.
- Produces migration `012_timed_consumables` with inventory, purchase, activation, work-event, reward-award, and gold-ledger persistence.
- Produces the exact setting keys listed in section 3.1 of the approved design.

- [ ] **Step 1: Write failing migration, configuration, and settings-parity tests**

Create `tests/db-timed-consumables-migration.test.ts` and assert exact table responsibilities rather than only table existence:

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';

const columns = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

describe('012_timed_consumables migration', () => {
  it('creates durable inventory, potion, reward, and ledger records', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'player_inventory')).toEqual([
      'player_id', 'sku', 'quantity', 'updated_at',
    ]);
    expect(columns(db, 'shop_purchases')).toEqual([
      'id', 'player_id', 'sku', 'quantity', 'unit_price', 'total_price',
      'office_day', 'request_id', 'inventory_after', 'gold_after', 'created_at',
    ]);
    expect(columns(db, 'player_inventory_lots')).toEqual([
      'id', 'purchase_id', 'player_id', 'sku', 'remaining_quantity',
      'unit_price', 'purchased_at',
    ]);
    expect(columns(db, 'potion_activations')).toContain('effect_snapshot');
    expect(columns(db, 'potion_activations')).toContain('potion_bonus_damage');
    expect(columns(db, 'potion_activations')).toContain('purchase_unit_price');
    expect(columns(db, 'potion_work_events')).toContain('token_event_id');
    expect(columns(db, 'potion_activation_encounters')).toEqual([
      'activation_id', 'encounter_id', 'bonus_damage',
    ]);
    expect(columns(db, 'encounter_reward_awards')).toContain('podium_gold');
    expect(columns(db, 'gold_ledger')).toContain('balance_after');
    expect(columns(db, 'game_clock_days')).toEqual(['office_day', 'active_ms']);
    expect(columns(db, 'player_daily_combat')).toEqual([
      'player_id', 'office_day', 'damage', 'potion_bonus_damage',
    ]);
  });

  it('adds clock, potion-damage, and reward-snapshot columns', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'game_state')).toContain('combat_active_ms');
    expect(columns(db, 'encounter_damage')).toContain('potion_bonus_damage');
    expect(columns(db, 'encounters')).toEqual(expect.arrayContaining([
      'reward_model_version', 'reward_work_pct', 'reward_damage_pct',
      'reward_podium_first_pct', 'reward_podium_second_pct', 'reward_podium_third_pct',
    ]));
  });

  it('enforces one active potion per type and idempotent source records', () => {
    const db = openDb(':memory:');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      'idx_potion_active_type', 'idx_potion_work_source', 'idx_gold_ledger_source',
    ]));
  });
});
```

Extend `tests/config.test.ts`:

```ts
expect(loadConfig({}).officeTimeZone).toBe('America/New_York');
expect(loadConfig({ OFFICE_TIME_ZONE: 'Europe/London' }).officeTimeZone).toBe('Europe/London');
expect(() => loadConfig({ OFFICE_TIME_ZONE: 'Dungeon/Nowhere' })).toThrow(/OFFICE_TIME_ZONE/);
```

Extend the existing metadata coverage test so every new default still has metadata and its group exists in `GROUP_ORDER`.

Create `tests/db-timed-consumables-upgrade.test.ts` using the existing pre-cosmetics upgrade-test pattern: create a temporary file database, apply and record `migrations.slice(0, 11)`, insert a player with 7,654,321 gold plus one active encounter, close it, and reopen with `openDb`. Assert the player/encounter data is preserved, the encounter has `reward_model_version='legacy-v0'`, and exactly one opening ledger row has `{ amount: 7654321, balance_after: 7654321, reason: 'opening_balance' }`. This is the migration safety proof for the production-shaped path; the fresh in-memory test is not a substitute.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm test -- tests/db-timed-consumables-migration.test.ts tests/db-timed-consumables-upgrade.test.ts tests/config.test.ts tests/settings-meta.test.ts
```

Expected: FAIL because migration 012, `officeTimeZone`, and potion/reward settings do not exist.

- [ ] **Step 3: Add migration `012_timed_consumables`**

Append one migration in `src/db/migrations.ts`. Use these exact columns and constraints:

```sql
ALTER TABLE game_state ADD COLUMN combat_active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE encounter_damage ADD COLUMN potion_bonus_damage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE encounters ADD COLUMN reward_model_version TEXT NOT NULL DEFAULT 'legacy-v0';
ALTER TABLE encounters ADD COLUMN reward_work_pct REAL;
ALTER TABLE encounters ADD COLUMN reward_damage_pct REAL;
ALTER TABLE encounters ADD COLUMN reward_podium_first_pct REAL;
ALTER TABLE encounters ADD COLUMN reward_podium_second_pct REAL;
ALTER TABLE encounters ADD COLUMN reward_podium_third_pct REAL;

CREATE TABLE player_inventory (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, sku)
);

CREATE TABLE shop_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  total_price INTEGER NOT NULL CHECK (total_price >= 0),
  office_day TEXT NOT NULL,
  request_id TEXT NOT NULL,
  inventory_after INTEGER NOT NULL CHECK (inventory_after >= 0),
  gold_after INTEGER NOT NULL CHECK (gold_after >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (player_id, request_id)
);
CREATE INDEX idx_shop_purchases_day ON shop_purchases (player_id, sku, office_day);

CREATE TABLE player_inventory_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL UNIQUE REFERENCES shop_purchases(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  purchased_at INTEGER NOT NULL
);
CREATE INDEX idx_inventory_lots_fifo
  ON player_inventory_lots (player_id, sku, remaining_quantity, purchased_at, id);

CREATE TABLE potion_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  potion_type TEXT NOT NULL CHECK (potion_type IN ('gold','damage')),
  tier INTEGER NOT NULL CHECK (tier >= 1),
  purchase_id INTEGER NOT NULL REFERENCES shop_purchases(id),
  purchase_unit_price INTEGER NOT NULL CHECK (purchase_unit_price >= 0),
  request_id TEXT NOT NULL,
  activation_day TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  start_game_ms INTEGER NOT NULL,
  expires_game_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','completed')),
  completed_at INTEGER,
  effect_snapshot TEXT NOT NULL,
  eligible_tokens INTEGER NOT NULL DEFAULT 0,
  base_gold INTEGER NOT NULL DEFAULT 0,
  stretch_gold INTEGER NOT NULL DEFAULT 0,
  potion_bonus_damage INTEGER NOT NULL DEFAULT 0,
  UNIQUE (player_id, request_id)
);
CREATE UNIQUE INDEX idx_potion_active_type
  ON potion_activations (player_id, potion_type) WHERE status = 'active';
CREATE INDEX idx_potion_activation_day
  ON potion_activations (player_id, potion_type, activation_day);

CREATE TABLE potion_work_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activation_id INTEGER NOT NULL REFERENCES potion_activations(id) ON DELETE CASCADE,
  token_event_id INTEGER NOT NULL REFERENCES token_events(id) ON DELETE CASCADE,
  effective_delta INTEGER NOT NULL CHECK (effective_delta >= 0),
  base_gold INTEGER NOT NULL DEFAULT 0,
  stretch_gold INTEGER NOT NULL DEFAULT 0,
  combat_active_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_potion_work_source
  ON potion_work_events (activation_id, token_event_id);

CREATE TABLE potion_activation_encounters (
  activation_id INTEGER NOT NULL REFERENCES potion_activations(id) ON DELETE CASCADE,
  encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  bonus_damage INTEGER NOT NULL DEFAULT 0 CHECK (bonus_damage >= 0),
  PRIMARY KEY (activation_id, encounter_id)
);

CREATE TABLE encounter_reward_awards (
  encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  effective_tokens INTEGER NOT NULL,
  damage_total INTEGER NOT NULL,
  potion_bonus_damage INTEGER NOT NULL DEFAULT 0,
  damage_rank INTEGER NOT NULL,
  work_gold INTEGER NOT NULL,
  damage_gold INTEGER NOT NULL,
  podium_gold INTEGER NOT NULL,
  total_gold INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (encounter_id, player_id)
);

CREATE TABLE gold_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL,
  source_table TEXT,
  source_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_gold_ledger_source
  ON gold_ledger (player_id, reason, source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
INSERT INTO gold_ledger
  (player_id, amount, balance_after, reason, source_table, source_id, created_at)
SELECT id, gold, gold, 'opening_balance', 'migration_012', CAST(id AS TEXT), created_at
FROM players;

CREATE TABLE game_clock_days (
  office_day TEXT PRIMARY KEY,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0)
);

CREATE TABLE player_daily_combat (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  office_day TEXT NOT NULL,
  damage INTEGER NOT NULL DEFAULT 0 CHECK (damage >= 0),
  potion_bonus_damage INTEGER NOT NULL DEFAULT 0 CHECK (potion_bonus_damage >= 0),
  PRIMARY KEY (player_id, office_day)
);
```

- [ ] **Step 4: Add validated office-time-zone configuration and launch settings**

Add `officeTimeZone: string` to `Config`. In `loadConfig`, validate the configured value without a dependency:

```ts
function officeTimeZone(env: NodeJS.ProcessEnv): string {
  const value = env.OFFICE_TIME_ZONE ?? 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch {
    throw new Error(`Invalid OFFICE_TIME_ZONE: ${value}`);
  }
  return value;
}
```

Add the 16 numeric keys from design section 3.1 to `DEFAULT_SETTINGS`. Add matching `SETTINGS_META` entries under new groups `Potions` and `Reward allocation`, and insert those names into `GROUP_ORDER`. Use the approved values verbatim and constrain reward percentages to `0..100`.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/db-timed-consumables-migration.test.ts tests/db-timed-consumables-upgrade.test.ts tests/config.test.ts tests/settings.test.ts tests/settings-meta.test.ts tests/web-admin-settings.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 6: Commit the foundation schema**

```bash
git add src/db/migrations.ts src/config.ts src/domain/settings.ts src/domain/settings-meta.ts tests/db-timed-consumables-migration.test.ts tests/db-timed-consumables-upgrade.test.ts tests/config.test.ts tests/settings-meta.test.ts
git commit -m "feat(potions): add durable consumable economy schema"
```

---

### Task 2: Route every runtime gold mutation through one idempotent ledger

**Files:**
- Create: `src/domain/goldledger.ts`
- Modify: `src/domain/players.ts`
- Modify: `src/domain/shop.ts`
- Modify: `src/domain/engine.ts`
- Modify: `src/web/routes/admin.ts`
- Create: `tests/goldledger.test.ts`
- Modify: `tests/shop.test.ts`
- Modify: `tests/engine-kill.test.ts`
- Modify: `tests/engine-retaliation.test.ts`
- Modify: `tests/web-admin-players.test.ts`

**Interfaces:**
- Produces `GoldReason`, `applyGoldMutation`, and `setGoldBalance`.
- `applyGoldMutation` is idempotent for a non-null `(playerId, reason, sourceTable, sourceId)` and never allows a negative balance.
- Removes `gold` from `PlayerPatch`; admin gold edits call `setGoldBalance` explicitly.

- [ ] **Step 1: Write failing ledger-domain tests**

Create `tests/goldledger.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { applyGoldMutation, setGoldBalance } from '../src/domain/goldledger';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

describe('gold ledger', () => {
  it('applies a signed mutation and stores the resulting balance', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    expect(applyGoldMutation(db, {
      playerId: p.id, amount: 500, reason: 'encounter_reward',
      sourceTable: 'encounters', sourceId: '7', now: 10,
    })).toEqual({ status: 'applied', balance: 500 });
    expect(db.prepare('SELECT amount, balance_after FROM gold_ledger WHERE player_id=?').get(p.id))
      .toMatchObject({ amount: 500, balance_after: 500 });
  });

  it('returns the original balance for an exact source retry', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const input = { playerId: p.id, amount: 500, reason: 'encounter_reward' as const,
      sourceTable: 'encounters', sourceId: '7', now: 10 };
    expect(applyGoldMutation(db, input).status).toBe('applied');
    expect(applyGoldMutation(db, { ...input, now: 20 })).toEqual({ status: 'duplicate', balance: 500 });
    expect(getPlayerById(db, p.id)?.gold).toBe(500);
  });

  it('rejects reuse of one source with a different amount', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const source = { playerId: p.id, reason: 'encounter_reward' as const,
      sourceTable: 'encounters', sourceId: '7', now: 10 };
    applyGoldMutation(db, { ...source, amount: 500 });
    expect(() => applyGoldMutation(db, { ...source, amount: 501, now: 20 }))
      .toThrow(/source/i);
    expect(getPlayerById(db, p.id)?.gold).toBe(500);
  });

  it('rejects a debit that would make the player negative', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    expect(applyGoldMutation(db, {
      playerId: p.id, amount: -1, reason: 'shop_purchase',
      sourceTable: 'shop_purchases', sourceId: 'x', now: 10,
    })).toEqual({ status: 'insufficient_gold', balance: 0 });
  });

  it('records an absolute admin adjustment as one signed difference', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    expect(setGoldBalance(db, p.id, 250, 'admin-request-1', 20)).toEqual({ status: 'applied', balance: 250 });
    expect(db.prepare("SELECT amount FROM gold_ledger WHERE reason='admin_adjustment'").get())
      .toEqual({ amount: 250 });
  });
});
```

- [ ] **Step 2: Run the ledger test and verify the missing-module failure**

Run:

```bash
npm test -- tests/goldledger.test.ts
```

Expected: FAIL because `src/domain/goldledger.ts` does not exist.

- [ ] **Step 3: Implement the atomic ledger API**

Create `src/domain/goldledger.ts` with this public contract:

```ts
export type GoldReason =
  | 'opening_balance' | 'encounter_reward' | 'shop_purchase'
  | 'gold_potion_base' | 'gold_potion_stretch'
  | 'monster_steal' | 'admin_adjustment';

export interface GoldMutationInput {
  playerId: number;
  amount: number;
  reason: GoldReason;
  sourceTable: string;
  sourceId: string;
  now: number;
}

export type GoldMutationResult =
  | { status: 'applied' | 'duplicate'; balance: number }
  | { status: 'no_player' | 'insufficient_gold'; balance?: number };

export function applyGoldMutation(
  db: Database.Database,
  input: GoldMutationInput,
): GoldMutationResult;

export function setGoldBalance(
  db: Database.Database,
  playerId: number,
  target: number,
  requestId: string,
  now: number,
): GoldMutationResult;
```

Inside one `db.transaction`, look up the unique ledger source first. Return its stored `balance_after` only when the stored amount exactly matches the retry; throw an invariant error when the same source is reused with a different amount. Then read the current player balance, reject a negative result, update `players.gold`, and insert the ledger row. Validate all numeric inputs with `Number.isSafeInteger` and throw `RangeError` for invalid programmer input.

- [ ] **Step 4: Write failing integration assertions for existing gold paths**

Extend the focused tests so each successful runtime mutation has a matching ledger reason and `balance_after` equal to `players.gold`:

```ts
expect(db.prepare("SELECT amount, reason FROM gold_ledger WHERE reason='shop_purchase'").get())
  .toMatchObject({ amount: -1_500_000, reason: 'shop_purchase' });
expect(db.prepare("SELECT reason FROM gold_ledger WHERE reason='encounter_reward'").get())
  .toEqual({ reason: 'encounter_reward' });
expect(db.prepare("SELECT amount FROM gold_ledger WHERE reason='monster_steal'").get())
  .toEqual({ amount: -80 });
expect(db.prepare("SELECT reason FROM gold_ledger WHERE reason='admin_adjustment'").get())
  .toEqual({ reason: 'admin_adjustment' });
```

- [ ] **Step 5: Replace direct runtime gold writes**

- In `shop.purchase`, charge with source table `player_cosmetics` and source ID equal to the SKU ID before granting the tier inside the existing transaction.
- In legacy encounter resolution, credit each player with source table `encounters` and source ID equal to the encounter ID.
- In retaliation, insert `monster_attacks` first, then debit with source table `monster_attacks` and its inserted row ID inside the same transaction.
- Remove `gold` from `PlayerPatch` and `PLAYER_PATCH_COLUMNS`. In the admin route, generate `randomUUID()` in the web layer and call `setGoldBalance` separately from `updatePlayer`.

Do not replace direct SQL balance setup inside tests; those are fixtures created outside runtime workflows.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/goldledger.test.ts tests/shop.test.ts tests/engine-kill.test.ts tests/engine-retaliation.test.ts tests/players.test.ts tests/web-admin-players.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the gold ledger conversion**

```bash
git add src/domain/goldledger.ts src/domain/players.ts src/domain/shop.ts src/domain/engine.ts src/web/routes/admin.ts tests/goldledger.test.ts tests/shop.test.ts tests/engine-kill.test.ts tests/engine-retaliation.test.ts tests/players.test.ts tests/web-admin-players.test.ts
git commit -m "feat(economy): audit every runtime gold mutation"
```

---

### Task 3: Version and store the approved hybrid encounter reward

**Files:**
- Rewrite: `src/domain/rewards.ts`
- Modify: `src/domain/encounters.ts`
- Modify: `src/domain/settings-meta.ts`
- Modify: `src/domain/engine.ts`
- Modify: `src/web/routes/admin.ts`
- Modify: `tests/rewards.test.ts`
- Create: `tests/engine-reward-awards.test.ts`
- Modify: `tests/engine-defeat-summary.test.ts`
- Modify: `tests/web-admin-settings.test.ts`

**Interfaces:**
- Produces `RewardConfig`, `RewardParticipant`, `RewardAllocation`, `validateRewardConfig`, and `allocateEncounterGold`.
- New encounters snapshot `hybrid-v1` and all five percentages.
- Defeat summaries read stored `encounter_reward_awards`; legacy encounters continue through the previous `splitGold` compatibility function.

- [ ] **Step 1: Replace proportional-only tests with failing hybrid-allocation tests**

Keep `splitGold` exported only for `legacy-v0` compatibility, and add:

```ts
const cfg = { workPct: 80, damagePct: 10, podiumPct: [5, 3, 2] as const };

it('allocates work, damage, and 5/3/2 podium without changing the pool', () => {
  const awards = allocateEncounterGold([
    { playerId: 1, tokens: 800, damage: 100, potionBonusDamage: 0 },
    { playerId: 2, tokens: 200, damage: 900, potionBonusDamage: 200 },
  ], 1000, cfg);
  expect(awards.reduce((sum, award) => sum + award.totalGold, 0)).toBe(1000);
  expect(awards.find((award) => award.playerId === 2)?.damageRank).toBe(1);
  expect(awards.find((award) => award.playerId === 2)?.podiumGold).toBeGreaterThan(0);
});

it('returns missing podium shares to proportional damage', () => {
  const [award] = allocateEncounterGold([
    { playerId: 1, tokens: 100, damage: 100, potionBonusDamage: 0 },
  ], 101, cfg);
  expect(award.totalGold).toBe(101);
});

it('falls work back to damage when no eligible tokens exist', () => {
  const awards = allocateEncounterGold([
    { playerId: 1, tokens: 0, damage: 100, potionBonusDamage: 0 },
    { playerId: 2, tokens: 0, damage: 300, potionBonusDamage: 0 },
  ], 1000, cfg);
  expect(awards.find((award) => award.playerId === 2)?.totalGold)
    .toBeGreaterThan(awards.find((award) => award.playerId === 1)?.totalGold ?? 0);
});

it('breaks damage ties by tokens then player ID', () => {
  const awards = allocateEncounterGold([
    { playerId: 9, tokens: 50, damage: 100, potionBonusDamage: 0 },
    { playerId: 3, tokens: 100, damage: 100, potionBonusDamage: 0 },
  ], 100, cfg);
  expect(awards.find((award) => award.playerId === 3)?.damageRank).toBe(1);
});

it('rejects percentages that do not total 100', () => {
  expect(() => validateRewardConfig({ ...cfg, workPct: 79 })).toThrow(/100/);
});
```

- [ ] **Step 2: Run the reward test and verify failure**

Run:

```bash
npm test -- tests/rewards.test.ts
```

Expected: FAIL because the hybrid interfaces and allocator do not exist.

- [ ] **Step 3: Implement deterministic component allocation**

Use these exact types:

```ts
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
```

Allocate integer component budgets with largest remainder, then allocate each proportional component with the same helper. Rank by damage descending, tokens descending, player ID ascending. Move unclaimed podium budgets into damage before distributing. When total tokens are zero, move the work budget into damage. Assert the final sum equals `goldPool` before returning.

- [ ] **Step 4: Add failing engine storage and legacy-version tests**

Create `tests/engine-reward-awards.test.ts` covering:

```ts
expect(active.reward_model_version).toBe('hybrid-v1');
expect(active.reward_work_pct).toBe(80);
expect(active.reward_podium_third_pct).toBe(2);

const stored = db.prepare(
  'SELECT * FROM encounter_reward_awards WHERE encounter_id=? ORDER BY damage_rank',
).all(encounterId) as any[];
expect(stored.reduce((sum, row) => sum + row.total_gold, 0)).toBe(goldPool);
expect(stored.every((row) => row.model_version === 'hybrid-v1')).toBe(true);
expect(stored.every((row) => row.work_gold + row.damage_gold + row.podium_gold === row.total_gold)).toBe(true);
```

Create a `legacy-v0` encounter before the kill and assert it finishes through `splitGold` without hybrid award rows. Extend the defeat-summary test to alter live settings after the kill and verify the displayed gold remains the stored award.

- [ ] **Step 5: Snapshot reward settings and store awards atomically**

Extend `EngineConfig` with the five reward percentages. In `spawnEncounter`, validate and insert `hybrid-v1` plus the percentages. In kill resolution:

1. read the snapshot from the encounter;
2. gather effective-token, total-damage, and potion-bonus-damage inputs;
3. call `allocateEncounterGold`;
4. mark the encounter defeated;
5. insert every `encounter_reward_awards` row;
6. credit each award through `applyGoldMutation` using source table `encounter_reward_awards` and source ID equal to the encounter ID;
7. open the defeat window.

Update `buildDefeatSummary` to prefer stored awards and only recompute for `legacy-v0`. In the admin settings POST, parse the five submitted reward values together and return `400` without saving any of them unless `validateRewardConfig` succeeds. Rename the existing `gold_damage_weight` metadata label to `Legacy gold: tokens vs damage` and state that it applies only to encounters already marked `legacy-v0`; new encounters ignore it.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/rewards.test.ts tests/engine-reward-awards.test.ts tests/engine-kill.test.ts tests/engine-defeat-summary.test.ts tests/web-admin-settings.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit versioned encounter rewards**

```bash
git add src/domain/rewards.ts src/domain/encounters.ts src/domain/engine.ts src/domain/settings-meta.ts src/web/routes/admin.ts tests/rewards.test.ts tests/engine-reward-awards.test.ts tests/engine-defeat-summary.test.ts tests/web-admin-settings.test.ts
git commit -m "feat(rewards): store the hybrid work and podium split"
```

---

### Task 4: Persist a restart-safe combat-active clock

**Files:**
- Create: `src/domain/office-time.ts`
- Create: `src/domain/gameclock.ts`
- Modify: `src/domain/gamestate.ts`
- Modify: `src/domain/engine.ts`
- Modify: `src/index.ts`
- Create: `tests/office-time.test.ts`
- Create: `tests/gameclock.test.ts`
- Modify: `tests/engine.test.ts`

**Interfaces:**
- Produces `combatActiveMs`, `advanceCombatClock`, `combatActiveMsForDay`, and `isCombatAcceptingWork`.
- Produces `officeDayKey(now, timeZone)`, `officeDayStart(now, timeZone)`, and `nextOfficeMidnight(now, timeZone)`.
- `GameEngine` owns only the previous wall tick and previous running state in memory; persisted elapsed time lives in `game_state.combat_active_ms`.
- `GameEngine` receives `officeTimeZone` in `EngineDeps`, defaulting to `America/New_York` in tests; `src/index.ts` passes `config.officeTimeZone`.

- [ ] **Step 1: Write failing office-time and clock-domain tests**

Create `tests/office-time.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextOfficeMidnight, officeDayKey, officeDayStart } from '../src/domain/office-time';

describe('office day', () => {
  it('uses the configured local calendar day', () => {
    const now = Date.parse('2026-07-28T03:30:00Z');
    expect(officeDayKey(now, 'America/New_York')).toBe('2026-07-27');
    expect(officeDayKey(now, 'Europe/London')).toBe('2026-07-28');
  });

  it('finds the current day start and spring-forward midnight', () => {
    const now = Date.parse('2026-03-08T06:30:00Z');
    expect(new Date(officeDayStart(now, 'America/New_York')).toISOString())
      .toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(nextOfficeMidnight(now, 'America/New_York')).toISOString())
      .toBe('2026-03-09T04:00:00.000Z');
  });

  it('finds fall-back midnight without assuming a 24-hour day', () => {
    const now = Date.parse('2026-11-01T05:30:00Z');
    expect(new Date(nextOfficeMidnight(now, 'America/New_York')).toISOString())
      .toBe('2026-11-02T05:00:00.000Z');
  });
});
```

Create `tests/gameclock.test.ts`:

```ts
it('advances only by a non-negative integer delta', () => {
  expect(combatActiveMs(db)).toBe(0);
  advanceCombatClock(db, 1000, 1000, 'America/New_York');
  expect(combatActiveMs(db)).toBe(1000);
  expect(combatActiveMsForDay(db, '1969-12-31')).toBe(1000);
  expect(() => advanceCombatClock(db, -1, 1000, 'America/New_York')).toThrow(RangeError);
});

it('accepts work only for a live encounter outside idle and defeat state', () => {
  expect(isCombatAcceptingWork(db, 1000, 15)).toBe(false);
  // Create a live encounter and fresh last_token_at fixture.
  seedActiveEncounter(db, 1000);
  expect(isCombatAcceptingWork(db, 1000, 15)).toBe(true);
  db.prepare('UPDATE game_state SET defeat_until=? WHERE id=1').run(2000);
  expect(isCombatAcceptingWork(db, 1500, 15)).toBe(false);
});
```

The local `seedActiveEncounter` test helper inserts one dungeon/encounter and points `game_state.current_encounter_id` to it; it must not invoke the engine.

- [ ] **Step 2: Run both focused tests and verify failure**

Run:

```bash
npm test -- tests/office-time.test.ts tests/gameclock.test.ts
```

Expected: FAIL because neither domain module exists.

- [ ] **Step 3: Implement DST-safe office-day helpers and persisted clock helpers**

Use one cached `Intl.DateTimeFormat` per IANA zone with `year`, `month`, and `day` parts. `officeDayKey` returns `YYYY-MM-DD`. `officeDayStart` binary-searches backward for the first millisecond with the current key; `nextOfficeMidnight` binary-searches `(now, now + 27 hours]` for the first changed key. Throw when bounds fail rather than silently assuming 24 hours.

Create:

```ts
export function combatActiveMs(db: Database.Database): number;
export function advanceCombatClock(
  db: Database.Database, deltaMs: number, intervalEnd: number, timeZone: string,
): number;
export function combatActiveMsForDay(db: Database.Database, dayKey: string): number;
export function isCombatAcceptingWork(
  db: Database.Database,
  now: number,
  pauseAfterMinutes: number,
): boolean;
```

`isCombatAcceptingWork` returns true only when `isIdle` is false, `defeat_until` is null or expired, and `current_encounter_id` points to an `active` encounter. It does not trust `game_state.paused`, which can lag the token event that wakes the office. `advanceCombatClock` increments both the lifetime clock and `game_clock_days`; when one tick crosses local midnight, split its delta at `nextOfficeMidnight(intervalEnd - deltaMs, timeZone)`.

- [ ] **Step 4: Add failing engine timing tests**

Add deterministic tests that call `tick` at explicit times:

```ts
eng.tick(100_000); // startup baseline: no elapsed time
eng.tick(101_000); // active from previous tick
expect(combatActiveMs(db)).toBe(1_000);

db.prepare('UPDATE players SET last_token_at=?').run(0);
eng.tick(200_000); // transition to idle; only the prior active interval was counted
const pausedAt = combatActiveMs(db);
eng.tick(260_000);
expect(combatActiveMs(db)).toBe(pausedAt);
```

Create separate cases for defeat-window pause, no encounter, and a new `GameEngine` instance whose first tick adds zero even when an old persisted encounter is active.

- [ ] **Step 5: Advance from the previous tick's state**

Add private fields to `GameEngine`:

```ts
private previousTickAt: number | null = null;
private previousClockRunning = false;
```

At the start of every tick, add `now - previousTickAt` only when `previousClockRunning` is true, passing `now` and `officeTimeZone` to `advanceCombatClock`. Never add time on the first tick of an engine instance. Before every return and at the normal end of the tick, set `previousTickAt = now` and recompute `previousClockRunning` from the final database state with `isCombatAcceptingWork`. This ordering counts the active interval ending in a kill, pauses the full defeat interval, and never charges restart downtime. Update `src/index.ts` to construct `new GameEngine(db, { officeTimeZone: config.officeTimeZone })`; preserve optional deterministic `rng` in the same deps object.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/office-time.test.ts tests/gameclock.test.ts tests/gamestate.test.ts tests/engine.test.ts tests/engine-kill.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the combat-active clock**

```bash
git add src/domain/office-time.ts src/domain/gameclock.ts src/domain/gamestate.ts src/domain/engine.ts src/index.ts tests/office-time.test.ts tests/gameclock.test.ts tests/engine.test.ts
git commit -m "feat(potions): persist combat-active game time"
```

---

## Milestone B — Potion Engine

This milestone makes both products purchasable and mechanically complete through domain APIs, while the player-facing presentation remains hidden until Milestone C.

## File Structure

- Create `src/domain/shop-products.ts` — typed potion catalog and immutable effect snapshots.
- Create `src/domain/inventory.ts` — stack reads and atomic daily-stock purchases.
- Create `src/domain/potions.ts` — activation, limits, active effects, expiry, Gold progress, and Damage multiplier.
- Modify `src/domain/ingest.ts` — attach eligible work to an active Gold Potion in the token transaction.
- Modify `src/domain/engine.ts` — expire activations, apply personal Damage Potion base hit, and record exact bonus damage.
- Add focused catalog, inventory, activation, Gold, and Damage tests.

### Task 5: Add the typed product catalog and atomic personal-stock purchases

**Files:**
- Create: `src/domain/shop-products.ts`
- Create: `src/domain/inventory.ts`
- Create: `tests/shop-products.test.ts`
- Create: `tests/inventory.test.ts`

**Interfaces:**
- Consumes Task 4's `officeDayKey(now, timeZone)` and `nextOfficeMidnight(now, timeZone)`.
- Produces a typed `CONSUMABLE_SKUS` catalog for `potion_gold_t1` and `potion_damage_t1` only.
- Produces `inventoryQuantity`, `remainingDailyStock`, and `purchaseConsumable`.

- [ ] **Step 1: Write failing catalog and inventory-purchase tests**

Create `tests/shop-products.test.ts`:

```ts
expect(consumableProduct(db, 'potion_gold_t1')).toMatchObject({
  id: 'potion_gold_t1', potionType: 'gold', tier: 1, price: 100_000, durationMs: 7_200_000,
});
expect(consumableProduct(db, 'potion_damage_t1')).toMatchObject({
  id: 'potion_damage_t1', potionType: 'damage', tier: 1, price: 150_000, durationMs: 7_200_000,
});
expect(consumableProduct(db, 'potion_gold_t2')).toBeUndefined();
```

Create `tests/inventory.test.ts` and cover:

```ts
expect(purchaseConsumable(db, {
  playerId: player.id, skuId: 'potion_gold_t1', quantity: 2,
  expectedUnitPrice: 100_000, requestId: 'purchase-1',
  now, timeZone: 'America/New_York',
})).toMatchObject({ ok: true, inventory: 2, stockRemaining: 1 });
expect(getPlayerById(db, player.id)?.gold).toBe(800_000);
expect(inventoryQuantity(db, player.id, 'potion_gold_t1')).toBe(2);
```

Also assert: quantity defaults are not accepted in the domain; zero/four are invalid; same-day stock cannot exceed three; Gold and Damage stock are independent; next-day stock returns to three; unpurchased stock does not roll over; an exact repeated `requestId` returns the original purchase without a second charge; reuse of that request ID with another SKU/quantity/price returns `request_conflict`; a changed displayed price fails without mutation; insufficient gold fails without inventory, lot, or purchase rows; stack quantity always equals the sum of remaining FIFO lots.

- [ ] **Step 2: Implement the typed catalog**

Create `src/domain/shop-products.ts`:

```ts
export type PotionType = 'gold' | 'damage';

export interface ConsumableProduct {
  id: 'potion_gold_t1' | 'potion_damage_t1';
  name: string;
  potionType: PotionType;
  tier: 1;
  price: number;
  durationMs: number;
  iconClass: 'potion-gold' | 'potion-damage';
}

export const CONSUMABLE_SKUS = {
  potion_gold_t1: {
    id: 'potion_gold_t1', name: 'Beginner Gold Potion', potionType: 'gold', tier: 1,
    priceSetting: 'potion_gold_t1_price', durationSetting: 'potion_gold_t1_duration_s',
    priceDefault: 100_000, durationDefaultS: 7_200, iconClass: 'potion-gold',
  },
  potion_damage_t1: {
    id: 'potion_damage_t1', name: 'Beginner Damage Potion', potionType: 'damage', tier: 1,
    priceSetting: 'potion_damage_t1_price', durationSetting: 'potion_damage_t1_duration_s',
    priceDefault: 150_000, durationDefaultS: 7_200, iconClass: 'potion-damage',
  },
} as const;

export function consumableProduct(
  db: Database.Database,
  skuId: string,
): ConsumableProduct | undefined;
```

Read settings with finite, non-negative fallbacks. Reject duration below one second as invalid configuration rather than creating an immediately expired item.

- [ ] **Step 3: Implement atomic personal-stock purchase**

Create `src/domain/inventory.ts` with:

```ts
export function inventoryQuantity(db: Database.Database, playerId: number, sku: string): number;
export function listInventory(db: Database.Database, playerId: number): { sku: string; quantity: number }[];
export function remainingDailyStock(
  db: Database.Database, playerId: number, sku: string, dayKey: string, dailyStock: number,
): number;

export type ConsumablePurchaseResult =
  | { ok: true; purchaseId: number; inventory: number; stockRemaining: number; newGold: number; duplicate: boolean }
  | { ok: false; reason: 'unknown_sku' | 'invalid_quantity' | 'price_changed' | 'sold_out' | 'insufficient_gold' | 'no_player' | 'request_conflict' };

export function purchaseConsumable(
  db: Database.Database,
  input: {
    playerId: number; skuId: string; quantity: number; expectedUnitPrice: number;
    requestId: string; now: number; timeZone: string;
  },
): ConsumablePurchaseResult;
```

Inside one transaction: return an existing `shop_purchases` row for the same request; validate product/quantity/price/player; derive the local day; read `potion_daily_stock_per_sku`; sum today's purchased quantity; compute inventory and gold after; insert the purchase; insert one `player_inventory_lots` row carrying that purchase's quantity and unit price; debit through `applyGoldMutation` with source table `shop_purchases`; upsert `player_inventory`; return canonical balances. Never derive authorization from browser-provided totals.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/office-time.test.ts tests/shop-products.test.ts tests/inventory.test.ts tests/goldledger.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 5: Commit product catalog and purchases**

```bash
git add src/domain/shop-products.ts src/domain/inventory.ts tests/shop-products.test.ts tests/inventory.test.ts
git commit -m "feat(shop): add personal daily potion stock"
```

---

### Task 6: Activate inventory manually with per-type limits and immutable snapshots

**Files:**
- Create: `src/domain/potions.ts`
- Create: `tests/potions.test.ts`

**Interfaces:**
- Produces discriminated `GoldPotionSnapshot` and `DamagePotionSnapshot` JSON.
- Produces `activatePotion`, `completeExpiredPotions`, `activePotionEffects`, and `remainingDailyUses`.
- Activation consumes one inventory item and one local-day use in one transaction.

- [ ] **Step 1: Write failing activation tests**

Create `tests/potions.test.ts` with fixture helpers that grant inventory through `purchaseConsumable`, so stack and FIFO lot records stay consistent. Cover:

```ts
expect(activatePotion(db, {
  playerId: player.id, skuId: 'potion_gold_t1', requestId: 'drink-1',
  now, timeZone: 'America/New_York',
})).toMatchObject({ ok: true, duplicate: false, potionType: 'gold', inventoryRemaining: 1, usesRemaining: 2 });

const row = db.prepare('SELECT * FROM potion_activations').get() as any;
expect(row.purchase_unit_price).toBe(100_000);
expect(JSON.parse(row.effect_snapshot)).toEqual({
  kind: 'gold', durationMs: 7_200_000, tokenUnit: 1_000,
  goldPerUnit: 50, baseCap: 125_000, stretchTokens: 2_500_000, stretchBonus: 25_000,
});
expect(row.expires_game_ms - row.start_game_ms).toBe(7_200_000);
```

Also assert: an exact repeated request is idempotent; request-ID reuse for another SKU returns `request_conflict`; no inventory fails; fourth same-day activation fails; next local day allows activation; Gold and Damage limits are independent; direct activation-row fixtures for two different Gold SKUs are counted together by `remainingDailyUses`, proving the limit is potion-type based before a future tier is added to the catalog; Gold and Damage can overlap; same type fails while active; same type cannot queue/extend/replace; an expired row is completed before a new same-type activation; crossing midnight remains charged to the original day; after every successful activation, stack quantity still equals the sum of remaining FIFO lots.

- [ ] **Step 2: Run the potion test and verify the missing-module failure**

Run:

```bash
npm test -- tests/potions.test.ts
```

Expected: FAIL because `src/domain/potions.ts` does not exist.

- [ ] **Step 3: Define immutable effect snapshots and active-effect output**

Use these public types:

```ts
export interface GoldPotionSnapshot {
  kind: 'gold'; durationMs: number; tokenUnit: 1_000; goldPerUnit: number;
  baseCap: number; stretchTokens: number; stretchBonus: number;
}
export interface DamagePotionSnapshot {
  kind: 'damage'; durationMs: number; baseHitMultiplier: number;
}
export type PotionEffectSnapshot = GoldPotionSnapshot | DamagePotionSnapshot;

export interface ActivePotionEffect {
  activationId: number;
  sku: string;
  potionType: PotionType;
  tier: number;
  state: 'armed' | 'active' | 'paused';
  remainingGameMs: number;
  snapshot: PotionEffectSnapshot;
  eligibleTokens: number;
  baseGold: number;
  stretchGold: number;
}
```

Build a Gold snapshot from the six Gold settings and a Damage snapshot from `potion_damage_t1_base_hit_pct`, converted from 25 to `1.25`. Parse stored snapshots through a Zod discriminated union before use; an invalid row must be ignored by read APIs and must never affect combat.

- [ ] **Step 4: Implement activation, completion, and daily-use queries**

```ts
export type ActivatePotionResult =
  | { ok: true; activationId: number; duplicate: boolean; potionType: PotionType;
      inventoryRemaining: number; usesRemaining: number; state: 'armed' | 'active' }
  | { ok: false; reason: 'unknown_sku' | 'no_player' | 'no_inventory' | 'daily_limit' | 'type_active' | 'invalid_config' | 'request_conflict' };

export function activatePotion(db: Database.Database, input: {
  playerId: number; skuId: string; requestId: string; now: number; timeZone: string;
}): ActivatePotionResult;
export function completeExpiredPotions(db: Database.Database, now: number): number;
export function activePotionEffects(
  db: Database.Database, playerId: number, now: number,
): ActivePotionEffect[];
export function remainingDailyUses(
  db: Database.Database, playerId: number, potionType: PotionType,
  dayKey: string, dailyLimit: number,
): number;
```

At the start of activation, mark rows with `expires_game_ms <= combatActiveMs(db)` completed. Check the request ID before inventory or limits. Inside one transaction, select the oldest `player_inventory_lots` row with remaining quantity, conditionally decrement both that lot and the stack (`quantity > 0`), and store its `purchase_id` and `unit_price` on the activation. This FIFO cost basis makes every activation's purchase date and net yield exact even after later repricing. Insert the active row at the current game clock and return `armed` unless `isCombatAcceptingWork` is true. For later reads, report `armed` when the game clock has never advanced beyond `start_game_ms`, `active` while combat accepts work, and `paused` when a previously started potion is waiting through idle/defeat/no encounter. Use the partial unique index as the final concurrency guard and translate its constraint failure to `type_active`.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/potions.test.ts tests/gameclock.test.ts tests/inventory.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 6: Commit potion activation**

```bash
git add src/domain/potions.ts tests/potions.test.ts
git commit -m "feat(potions): activate one potion per effect type"
```

---

### Task 7: Credit Gold Potion work incrementally and idempotently

**Files:**
- Modify: `src/domain/potions.ts`
- Modify: `src/domain/ingest.ts`
- Create: `tests/potion-gold.test.ts`
- Modify: `tests/ingest-apply.test.ts`
- Modify: `tests/ingest-increment.test.ts`

**Interfaces:**
- Produces `applyGoldPotionWork(db, playerId, tokenEventId, effectiveDelta, now)`.
- The canonical `token_events` row remains unchanged; `potion_work_events` references it exactly once.

- [ ] **Step 1: Write failing Gold payout tests**

Create `tests/potion-gold.test.ts` with an active encounter and Gold activation. Assert:

```ts
const event1 = insertTokenEvent(db, player.id, 999, now);
const event2 = insertTokenEvent(db, player.id, 1, now + 1);
expect(applyGoldPotionWork(db, player.id, event1, 999, now)).toMatchObject({ baseGold: 0, stretchGold: 0 });
expect(applyGoldPotionWork(db, player.id, event2, 1, now + 1)).toMatchObject({ baseGold: 50, stretchGold: 0 });
expect(getPlayerById(db, player.id)?.gold).toBe(50);
```

The local `insertTokenEvent` helper inserts the canonical `token_events` row and returns `lastInsertRowid`, so the foreign-key path matches ingestion.

Then cover: cumulative partial units; a single event crossing many units; exact break-even at 2M; base cap 125,000; one 25,000 stretch award at 2.5M; no second stretch award; maximum payout 150,000; retrying the same token event changes nothing; no payout while idle; no payout in the defeat window; no payout after expiry; first token that refreshes `last_token_at` on an existing encounter is eligible; token events before the first encounter are not eligible.

- [ ] **Step 2: Run the Gold test and verify failure**

Run:

```bash
npm test -- tests/potion-gold.test.ts
```

Expected: FAIL because `applyGoldPotionWork` does not exist.

- [ ] **Step 3: Implement exact incremental accounting**

Add:

```ts
export interface GoldPotionWorkResult {
  activationId: number | null;
  eligibleTokens: number;
  baseGold: number;
  stretchGold: number;
  duplicate: boolean;
}

export function applyGoldPotionWork(
  db: Database.Database,
  playerId: number,
  tokenEventId: number,
  effectiveDelta: number,
  now: number,
): GoldPotionWorkResult;
```

Return a zero result unless effective delta is positive, combat accepts work, and an unexpired Gold activation exists. Inside one transaction: return the existing `potion_work_events` amounts on duplicate; compute `nextTokens`; calculate `nextBase = min(floor(nextTokens / tokenUnit) × goldPerUnit, baseCap)`; award only `nextBase - priorBase`; award the full stretch bonus only when crossing `stretchTokens` and prior stretch is zero; insert the work event; update activation totals; create separate ledger rows with reasons `gold_potion_base` and `gold_potion_stretch` keyed to the work-event row ID.

- [ ] **Step 4: Attach Gold accounting to token ingestion**

Capture the insert result:

```ts
const tokenEvent = db.prepare(
  `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
   VALUES (?, ?, ?, ?)`,
).run(player.id, now, effective, total);

applyGoldPotionWork(db, player.id, Number(tokenEvent.lastInsertRowid), effective, now);
```

Keep this call inside the existing outer ingestion transaction and after `players.last_token_at` is updated. This ordering makes the first waking token eligible when a live encounter already exists. Extend `IngestResult` only if a useful aggregate is needed for tests; do not expose potion earnings to OTLP clients.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/potion-gold.test.ts tests/ingest-apply.test.ts tests/ingest-increment.test.ts tests/goldledger.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 6: Commit Gold Potion accounting**

```bash
git add src/domain/potions.ts src/domain/ingest.ts tests/potion-gold.test.ts tests/ingest-apply.test.ts tests/ingest-increment.test.ts
git commit -m "feat(potions): reward active Gold Potion work"
```

---

### Task 8: Apply the Damage Potion to personal base hit and record its counterfactual

**Files:**
- Modify: `src/domain/potions.ts`
- Modify: `src/domain/engine.ts`
- Create: `tests/potion-damage.test.ts`
- Modify: `tests/engine.test.ts`
- Modify: `tests/engine-reward-awards.test.ts`

**Interfaces:**
- Produces `damagePotionMultiplier(db, playerId): { activationId: number; multiplier: number } | null`.
- `encounter_damage.damage_total` remains actual damage; `potion_bonus_damage` stores only `actual - no-potion counterfactual`.
- Every hit also increments one compact `player_daily_combat` aggregate for the engine's configured office day.

- [ ] **Step 1: Write failing Damage Potion engine tests**

Create `tests/potion-damage.test.ts` with deterministic attack timing and a huge monster. For the same player/activity/debuff state, assert:

```ts
expect(normalHit).toBe(100);
expect(potionHit).toBe(125);
expect(row.damage_total).toBe(125);
expect(row.potion_bonus_damage).toBe(25);
expect(activation.potion_bonus_damage).toBe(25);
```

Also cover: the global `base_hit` setting remains `100`; level/activity/debuff apply after the base factor; only the drinking player is boosted; Gold Potion has no damage effect; an expired Damage Potion has no effect; Gold and Damage overlap without changing Gold accounting; multiple hits accumulate exact rounded counterfactual differences.

- [ ] **Step 2: Run the Damage test and verify failure**

Run:

```bash
npm test -- tests/potion-damage.test.ts
```

Expected: FAIL because the engine ignores potion activation and does not record bonus damage.

- [ ] **Step 3: Expose the active Damage multiplier**

Add:

```ts
export function damagePotionMultiplier(
  db: Database.Database,
  playerId: number,
): { activationId: number; multiplier: number } | null;
```

Read only an `active` unexpired Damage activation, parse its stored `DamagePotionSnapshot`, and return null for malformed snapshots. Expiry compares against the persisted combat clock, not wall time.

- [ ] **Step 4: Compute baseline and actual hit from the same modifiers**

In the swing path:

```ts
const damagePotion = damagePotionMultiplier(this.db, p.id);
const baseWithoutPotion = cfg.baseHit;
const baseWithPotion = cfg.baseHit * (damagePotion?.multiplier ?? 1);
const baseline = attackDamage(baseWithoutPotion, p.level, cfg.levelCurveSlope, mod);
const damage = attackDamage(baseWithPotion, p.level, cfg.levelCurveSlope, mod);
const potionBonus = Math.max(0, damage - baseline);
this.applyHit(encId, p.id, damage, potionBonus, damagePotion?.activationId ?? null, now);
```

Extend `applyHit(encId, playerId, damage, potionBonus, activationId, now)` to increment `encounter_damage.potion_bonus_damage` and `potion_activations.potion_bonus_damage`, upsert `(activation_id, encounter_id)` in `potion_activation_encounters`, and upsert `player_daily_combat` using `officeDayKey(now, this.officeTimeZone)` in the same transaction. Call `completeExpiredPotions` after advancing the combat clock and before calculating swings.

- [ ] **Step 5: Verify stored reward inputs include bonus damage**

Extend `tests/engine-reward-awards.test.ts` so the killed encounter's `encounter_reward_awards.potion_bonus_damage` exactly equals `encounter_damage.potion_bonus_damage`; the total gold pool must remain unchanged.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/potion-damage.test.ts tests/potion-gold.test.ts tests/engine.test.ts tests/engine-reward-awards.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit Damage Potion combat behavior**

```bash
git add src/domain/potions.ts src/domain/engine.ts tests/potion-damage.test.ts tests/engine.test.ts tests/engine-reward-awards.test.ts
git commit -m "feat(potions): boost and audit personal base damage"
```

---

## Milestone C — Player Experience

This milestone exposes the finished mechanics through the approved Gilded Mimic Bazaar, scalable player hub, compact live dungeon, inventory activation, Active Effects popover, and battlefield motes.

## File Structure

- Modify `src/domain/shopview.ts`, `src/web/routes/shop.ts`, `src/web/views/shop.ejs`, `src/web/public/shop.js`, and `src/web/public/dungeon.css` — consumable product cards, quantities, personal stock, and persistent inventory ledger.
- Modify `src/web/public/tv/tv.js`, `src/web/public/tv/index.html`, and `src/web/routes/tv.ts`; create `src/web/public/tv/embed.html` — shared compact TV mode.
- Create `src/domain/playerhub.ts` — authenticated inventory/effects/Today view model and live state.
- Modify `src/domain/retaliation.ts` — remaining monster-debuff state for the player UI.
- Refactor `src/web/views/character-sheet.ejs`; create `character-live.ejs`, `character-inventory.ejs`, and `character-wardrobe.ejs` — mounted tabs without losing Wardrobe drafts.
- Create `src/web/public/player-hub.js` and `src/web/public/player-hub.css` — tabs, inventory selection, activation confirmation, polling, popover, responsive layout.
- Create `src/web/public/potion-fx.js`; modify `src/web/tvview.ts` and TV drawing — one shared deterministic potion-mote vocabulary.

### Task 9: Sell both daily potion products in the Gilded Mimic Bazaar

**Files:**
- Modify: `src/domain/shopview.ts`
- Modify: `src/web/routes/shop.ts`
- Modify: `src/web/views/shop.ejs`
- Modify: `src/web/public/shop.js`
- Modify: `src/web/public/dungeon.css`
- Modify: `tests/shopview.test.ts`
- Modify: `tests/web-shop.test.ts`
- Modify: `tests/shop-client-behavior.test.ts`
- Modify: `tests/shop-css.test.ts`

**Interfaces:**
- `ShopViewModel` gains `consumables: ConsumableOffer[]` and inventory quantities while retaining the current permanent Wardrobe offer.
- Produces `POST /shop/consumables/purchase` using form fields `token`, `sku`, `quantity`, `expected_unit_price`, and `request_id`.
- The existing Wardrobe mastery transition remains; the Bazaar closes only when there are no permanent or consumable products.

- [ ] **Step 1: Write failing Bazaar view-model and render tests**

Add to `tests/shopview.test.ts`:

```ts
const view = buildShopViewModel(db, player.id, undefined, undefined, now, 'America/New_York')!;
expect(view.consumables.map((offer) => offer.sku)).toEqual([
  'potion_gold_t1', 'potion_damage_t1',
]);
expect(view.consumables[0]).toMatchObject({
  unitPrice: 100_000, inventory: 0, stockRemaining: 3, maxQuantity: 3,
});
expect(view.nextRestockAt).toBe(nextOfficeMidnight(now, 'America/New_York'));
```

Add to `tests/web-shop.test.ts`:

```ts
expect(res.text).toContain('Beginner Gold Potion');
expect(res.text).toContain('Beginner Damage Potion');
expect(res.text).toContain('50g per 1,000 effective tokens');
expect(res.text).toContain('+25% personal base hit');
expect(res.text.match(/action="\/shop\/consumables\/purchase"/g)).toHaveLength(2);
expect(res.text).toContain('name="quantity" min="1" max="3" value="1"');
expect(res.text).toContain('Restocks at midnight');
```

For a mastered Wardrobe, assert potion cards keep the Bazaar open rather than showing the closed mimic scene. For a sold-out SKU, assert its card remains visible with `Back at midnight` and no enabled buy action.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- tests/shopview.test.ts tests/web-shop.test.ts
```

Expected: FAIL because `ShopViewModel` and the Bazaar have no consumable offers.

- [ ] **Step 3: Extend the Bazaar view model without mixing purchase logic into EJS**

Add:

```ts
export interface ConsumableOffer {
  sku: ConsumableProduct['id'];
  name: string;
  potionType: PotionType;
  tier: 1;
  unitPrice: number;
  durationMs: number;
  inventory: number;
  stockRemaining: number;
  maxQuantity: number;
  missingGoldForOne: number;
  iconClass: ConsumableProduct['iconClass'];
  effectCopy: string;
}
```

Extend `buildShopViewModel` with `now: number` and `timeZone: string`. Build the two offers from `consumableProduct`, `inventoryQuantity`, `remainingDailyStock`, and `officeDayKey`; expose one shared `nextRestockAt`. Keep permanent Wardrobe preview behavior unchanged.

Update the Bazaar GET call and every test call to pass explicit time:

```ts
const shop = buildShopViewModel(
  db, player.id, slotmapsDir, config.spritesDir, Date.now(), config.officeTimeZone,
);
```

- [ ] **Step 4: Add and test the purchase route**

Define:

```ts
const ConsumablePurchaseInput = z.object({
  token: z.string().min(1),
  sku: z.enum(['potion_gold_t1', 'potion_damage_t1']),
  quantity: z.coerce.number().int().min(1).max(3),
  expected_unit_price: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  request_id: z.string().uuid(),
});
```

Add route tests for success, quantity two, forged quantity, changed price, sold out, insufficient gold, unknown token, and duplicate request ID. On success redirect to `/shop?token=...&result=potion_success`; map failures to allow-listed result codes without echoing arbitrary input. Generate one `randomUUID()` per rendered consumable card in the web handler and pass those request IDs separately to EJS; randomness stays out of the domain.

- [ ] **Step 5: Render compact reusable cards and live quantity totals**

Keep the Gilded Mimic header and purple card language. Render the permanent offer, when present, through one `.bazaar-product` card followed by a two-column `.bazaar-product-grid` of consumables. Each potion card includes icon, Beginner badge, effect, two-hour active duration, inventory, daily stock, quantity input, and a button whose label is `Buy 1 · 100,000g` or `Buy 1 · 150,000g`.

Extend `shop.js` so each `[data-consumable-offer]` listens to its quantity input and computes button text only from its embedded unit-price data. Compare the selected total with the fresh gold balance embedded on the card, disable an unaffordable selection, and state the missing amount without changing the server contract. Server authorization still ignores every browser-computed total. Reuse the existing purchase-forging animation on enabled consumable forms.

Use the existing red potion asset for Damage. Render Gold with the same pixel asset and a scoped CSS filter under `.potion-gold`; do not recolor global landing art.

- [ ] **Step 6: Add browser and CSS contract tests**

In the existing VM harness, change quantity `1 → 3` and assert the button becomes `Buy 3 · 300,000g` for Gold without submitting. Assert the CSS has a responsive two-column product grid, safe-area boundaries, pixelated icons, sold-out state, and no card crossing the moss walls.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/shopview.test.ts tests/web-shop.test.ts tests/shop-client-behavior.test.ts tests/shop-css.test.ts tests/inventory.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 8: Commit Bazaar consumables**

```bash
git add src/domain/shopview.ts src/web/routes/shop.ts src/web/views/shop.ejs src/web/public/shop.js src/web/public/dungeon.css tests/shopview.test.ts tests/web-shop.test.ts tests/shop-client-behavior.test.ts tests/shop-css.test.ts
git commit -m "feat(shop): sell beginner potions from the Bazaar"
```

---

### Task 10: Add a compact mode to the existing TV renderer

**Files:**
- Create: `src/web/public/tv/embed.html`
- Modify: `src/web/public/tv/index.html`
- Modify: `src/web/public/tv/tv.js`
- Modify: `src/web/routes/tv.ts`
- Modify: `tests/web-tv.test.ts`
- Modify: `tests/anim.test.ts`

**Interfaces:**
- Produces public `GET /tv/embed`, using the same `tv.js`, `/tv/stream`, `TvHub`, layout, sprite URLs, and draw functions as full TV.
- `document.body.dataset.tvMode` is either `full` or `compact`; compact mode removes the 30% sidebar and suppresses only the full-TV leaderboard.

- [ ] **Step 1: Write failing embed-route and bootstrap tests**

Add:

```ts
const embed = await request(app).get('/tv/embed');
expect(embed.status).toBe(200);
expect(embed.text).toContain('<body data-tv-mode="compact">');
expect(embed.text).toContain('<canvas id="stage"></canvas>');
expect(embed.text).toContain('/static/tv/tv.js');
expect(embed.text).not.toContain('cursor: none');
```

Keep `/tv` assertions and require `<body data-tv-mode="full">`. In the public-JS source test, assert `tv.js` reads `document.body.dataset.tvMode` and does not open a second endpoint.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- tests/web-tv.test.ts tests/anim.test.ts
```

Expected: FAIL because `/tv/embed` and mode-aware rendering do not exist.

- [ ] **Step 3: Add the shared compact document and route**

Create `embed.html` with the same canvas/script as `index.html`, responsive `width:100%; height:100%`, no kiosk cursor rule, and `data-tv-mode="compact"`. Add:

```ts
app.get('/tv/embed', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'tv', 'embed.html'));
});
```

Set `data-tv-mode="full"` on the current TV body.

- [ ] **Step 4: Parameterize scale and sidebar behavior in place**

At the top of `tv.js`:

```js
const TV_MODE = document.body.dataset.tvMode === 'compact' ? 'compact' : 'full';
const IS_COMPACT = TV_MODE === 'compact';
const SIDEBAR_FRAC = IS_COMPACT ? 0 : 0.30;
```

Use the unchanged layout and actor code. In compact mode, fit the full 20×15 dungeon into the whole canvas, keep monster name/HP, pause and defeat overlays, and skip only `drawLeaderboard(t)`. Do not fork `drawHeroes`, `drawMonster`, positioning, collisions, sprite animation, or SSE handling.

- [ ] **Step 5: Run focused tests and syntax check**

Run:

```bash
npm test -- tests/web-tv.test.ts tests/anim.test.ts tests/tvhub.test.ts tests/tvview-layout.test.ts
node --check src/web/public/tv/tv.js
npm run typecheck
```

Expected: all selected tests pass, syntax check exits 0, and typecheck exits 0.

- [ ] **Step 6: Commit compact TV mode**

```bash
git add src/web/public/tv/embed.html src/web/public/tv/index.html src/web/public/tv/tv.js src/web/routes/tv.ts tests/web-tv.test.ts tests/anim.test.ts
git commit -m "feat(tv): add a shared compact dungeon mode"
```

---

### Task 11: Reshape the character page into the mounted three-tab player hub

**Files:**
- Modify: `src/domain/retaliation.ts`
- Create: `src/domain/playerhub.ts`
- Modify: `src/web/routes/character.ts`
- Rewrite: `src/web/views/character-sheet.ejs`
- Create: `src/web/views/character-live.ejs`
- Create: `src/web/views/character-inventory.ejs`
- Create: `src/web/views/character-wardrobe.ejs`
- Create: `src/web/public/player-hub.css`
- Create: `src/web/public/player-hub.js`
- Create: `tests/playerhub.test.ts`
- Modify: `tests/web-character.test.ts`
- Create: `tests/player-hub-client.test.ts`
- Create: `tests/player-hub-css.test.ts`

**Interfaces:**
- Produces `buildPlayerHubViewModel(db, player, now, timeZone, context)` and `buildPlayerHubState(db, player, now, timeZone)`.
- Produces mounted tab panels `hub-live`, `hub-inventory`, and `hub-wardrobe`; Live Dungeon is selected by default.
- The Wardrobe partial preserves every existing DOM ID and script bootstrap used by `dye.js`.

- [ ] **Step 1: Add a failing remaining-debuff test**

Extend `tests/retaliation.test.ts`:

```ts
expect(activeDebuff(db, player.id, 105_000, { monsterDebuffFactor: 0.85, monsterDebuffSeconds: 8 }))
  .toEqual({ factor: 0.85, remainingMs: 3_000 });
```

Implement `activeDebuff` from the latest eligible debuff row; make `debuffFactor` delegate to it. Consume Task 4's `officeDayStart` for Today queries.

- [ ] **Step 2: Write failing player-hub view-model tests**

Create `tests/playerhub.test.ts` with current encounter, inventory, active potions, token events, daily combat aggregate, ledger rows, and debuff fixtures. Assert:

```ts
const hub = buildPlayerHubState(db, player, now, 'America/New_York');
expect(hub.today).toEqual({
  effectiveTokens: 1234,
  damage: 500,
  fightRank: 2,
  goldEarned: 250,
  combatActiveMs: 3_600_000,
  potionsUsed: 1,
});
expect(hub.inventory.map((item) => item.sku)).toEqual([
  'potion_gold_t1', 'potion_damage_t1',
]);
expect(hub.effects.map((effect) => effect.kind)).toEqual(expect.arrayContaining(['gold', 'debuff']));
```

`goldEarned` includes positive `encounter_reward`, `gold_potion_base`, and `gold_potion_stretch` rows only. It excludes opening/admin balance, purchases, and monster steals. `fightRank` is current-encounter damage rank or null.

- [ ] **Step 3: Implement the player-hub domain model**

Use stable JSON-ready types:

```ts
export interface PlayerHubToday {
  effectiveTokens: number; damage: number; fightRank: number | null;
  goldEarned: number; combatActiveMs: number; potionsUsed: number;
}
export interface PlayerHubInventoryItem {
  sku: ConsumableProduct['id']; name: string; potionType: PotionType; tier: 1;
  quantity: number; durationMs: number; iconClass: string; effectCopy: string;
  usesRemaining: number; nextResetAt: number;
}
export interface PlayerHubEffect {
  kind: 'gold' | 'damage' | 'debuff'; iconClass: string; title: string;
  description: string; remainingMs: number;
  tier?: number; state?: 'armed' | 'active' | 'paused';
  progress?: { value: number; max: number };
}
export interface PlayerHubState {
  gold: number; inventory: PlayerHubInventoryItem[];
  effects: PlayerHubEffect[]; today: PlayerHubToday;
  currentFight: { leaders: { playerId: number; name: string; damage: number }[] };
}

export function buildPlayerHubState(
  db: Database.Database, player: Player, now: number, timeZone: string,
): PlayerHubState;

export function buildPlayerHubViewModel(
  db: Database.Database, player: Player, now: number, timeZone: string,
  context: SkinAssetContext & { publicUrl: string },
): PlayerHubState & {
  avatarA: string; avatarB: string; className: string; connected: boolean;
  dye: ReturnType<typeof dyeViewModel>; snippet: string;
};
```

`buildPlayerHubViewModel` adds identity/avatar/dye data needed for initial EJS; `buildPlayerHubState` returns only refreshable values. Query only the authenticated player plus public fight leaders—never include auth tokens in the state payload.

Return inventory entries only for positive owned stacks, sorted Gold before Damage for launch. The Inventory partial renders a compact empty-satchel state when the list is empty; active effects remain visible even when the consumed potion left no inventory behind.

- [ ] **Step 4: Write failing tab-shell and Wardrobe-preservation tests**

In `tests/web-character.test.ts`, assert:

```ts
expect(res.text).toContain('role="tablist" aria-label="Character sections"');
expect(res.text).toContain('id="hub-tab-live" role="tab" aria-selected="true"');
expect(res.text).toContain('id="hub-live" role="tabpanel"');
expect(res.text).toContain('<iframe class="hub-dungeon-frame" src="/tv/embed"');
expect(res.text).toContain('id="hub-inventory" role="tabpanel" hidden');
expect(res.text).toContain('id="hub-wardrobe" role="tabpanel" hidden');
expect(res.text.match(/<canvas id="dye-preview"/g)).toHaveLength(1);
expect(res.text).toContain('window.__DYE__ =');
expect(res.text).toContain('/static/player-hub.css');
expect(res.text).toContain('/static/player-hub.js');
```

The existing Wardrobe route, markup, action, and navigation-toast tests remain unchanged.

- [ ] **Step 5: Extract Wardrobe markup and render the approved hub shell**

- Keep the compact animated hero, identity, Level/XP/tokens/Gold, and existing token-preserving Store button in the header.
- Add a focusable avatar trigger with an initially hidden Active Effects surface; Task 12 fills its interaction.
- Add accessible tabs in the order Live Dungeon, Inventory, Wardrobe.
- `character-live.ejs` renders the `/tv/embed` iframe, a compact Fight Leaders list, and Today stat cards.
- `character-inventory.ejs` renders **All**, **Potions**, **Materials**, and **Quest** filters, a slot grid, and one reusable details panel from initial hub inventory; no second Store link. All and Potions are enabled at launch; empty future filters remain disabled or hidden.
- `character-wardrobe.ejs` contains the entire current Dye Workbench branch and unchanged scripts.
- Keep setup snippet, rename, and delete controls in a compact `<details class="hub-character-settings">Character settings</details>` below the tabs.

Pass `styles: ['player-hub.css']` from the character route. Add `window.__PLAYER_HUB__` containing token, initial state, and endpoint URLs with `<` escaped as `\u003c`.

Build the route model with:

```ts
const hub = buildPlayerHubViewModel(db, player, Date.now(), config.officeTimeZone, {
  spritesDir: config.spritesDir,
  slotmapsDir,
  publicUrl: config.publicUrl,
});
```

- [ ] **Step 6: Implement keyboard-safe mounted tabs**

In `player-hub.js`, use `aria-selected`, `tabIndex`, `hidden`, ArrowLeft/ArrowRight/Home/End, and click activation. Do not remove panels from the DOM and do not recreate the Wardrobe. Dispatch no synthetic navigation events on a local tab change.

Add a VM browser test that creates a dirty dye draft, switches Live → Wardrobe → Inventory → Wardrobe, and asserts the same `#dye-preview` node and draft object remain.

- [ ] **Step 7: Style the approved responsive player hub**

Keep all panels inside `calc(var(--wall) + var(--shell-gap))`. Use a compact hero card, gold tab rail, two-column Live layout, inventory grid/detail split, and existing purple panel language. At narrow width: stack dungeon/leaderboard/Today, stack inventory/detail, keep tabs sticky below the header, and reanchor effects below the avatar. Do not copy Wardrobe styles into the new file.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/office-time.test.ts tests/retaliation.test.ts tests/playerhub.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts tests/web-dye.test.ts tests/dye-client-behavior.test.ts
node --check src/web/public/player-hub.js
npm run typecheck
```

Expected: all selected tests pass, syntax check exits 0, and typecheck exits 0.

- [ ] **Step 9: Commit the mounted player hub**

```bash
git add src/domain/retaliation.ts src/domain/playerhub.ts src/web/routes/character.ts src/web/views/character-sheet.ejs src/web/views/character-live.ejs src/web/views/character-inventory.ejs src/web/views/character-wardrobe.ejs src/web/public/player-hub.css src/web/public/player-hub.js tests/retaliation.test.ts tests/playerhub.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts
git commit -m "feat(character): add the scalable player hub"
```

---

### Task 12: Activate potions from Inventory and keep live effects compact

**Files:**
- Modify: `src/web/routes/character.ts`
- Modify: `src/web/views/character-inventory.ejs`
- Modify: `src/web/views/character-sheet.ejs`
- Modify: `src/web/public/player-hub.js`
- Modify: `src/web/public/player-hub.css`
- Create: `tests/web-potions.test.ts`
- Modify: `tests/player-hub-client.test.ts`
- Modify: `tests/player-hub-css.test.ts`

**Interfaces:**
- Produces `GET /character/state?token=...` with `private, no-store` JSON.
- Produces `POST /character/potions/activate` with form fields `token`, `sku`, and UUID `request_id`.
- The inventory confirmation offers **Drink Potion** and **Keep Corked**; activation is irreversible.

- [ ] **Step 1: Write failing route tests**

Create `tests/web-potions.test.ts` covering:

```ts
const state = await request(app).get('/character/state').query({ token: player.auth_token });
expect(state.status).toBe(200);
expect(state.headers['cache-control']).toBe('private, no-store');
expect(state.body).toMatchObject({ inventory: expect.any(Array), effects: expect.any(Array), today: expect.any(Object) });

const drink = await request(app).post('/character/potions/activate').type('form').send({
  token: player.auth_token, sku: 'potion_gold_t1', request_id: crypto.randomUUID(),
});
expect(drink.status).toBe(200);
expect(drink.body).toMatchObject({ ok: true, inventoryRemaining: 0, usesRemaining: 2, state: 'armed' });
```

Also assert malformed UUID/SKU is 400, unknown token is 404, no inventory/daily limit/type-active are 409 with stable reason codes, exact retry is 200 with `duplicate: true`, and the state endpoint never returns `auth_token`.

- [ ] **Step 2: Run route tests and verify failure**

Run:

```bash
npm test -- tests/web-potions.test.ts
```

Expected: FAIL because neither character endpoint exists.

- [ ] **Step 3: Add validated character state and activation routes**

```ts
const PotionActivationInput = z.object({
  token: z.string().min(1),
  sku: z.enum(['potion_gold_t1', 'potion_damage_t1']),
  request_id: z.string().uuid(),
});
```

The state route authenticates by token, returns `buildPlayerHubState(db, player, Date.now(), config.officeTimeZone)`, and sets `private, no-store`. The activation route calls `activatePotion` and returns canonical inventory/use/state data; use 409 for valid-but-unavailable actions and never decrement inventory on failure.

- [ ] **Step 4: Write failing inventory-selection and confirmation tests**

Extend the VM harness to assert:

- only one item-detail panel exists while selecting different slots;
- selecting Gold shows owned quantity, effect, 2 active hours, daily doses, reset time, and progress when active or paused;
- selecting Damage shows +25% personal base hit;
- Drink opens a confirmation with post-activation inventory/doses and `Starts now` or `Waits for battle`;
- Keep Corked closes without a request;
- confirmation sends one form-encoded request with a fresh UUID;
- success updates inventory/effects without reload and shows the short bottle burst;
- rejected activation restores the enabled action and renders thematic feedback;
- state polling every five seconds refreshes Gold, inventory, effects, Today, and Fight Leaders without touching Wardrobe nodes.

- [ ] **Step 5: Implement scalable inventory interaction**

Use event delegation under `#hub-inventory-grid`. Keep the selected SKU in browser state, render only the existing detail panel, and preserve focus when quantities refresh. Use a native `<dialog id="potion-confirm">` with a non-dialog fallback class for tests. Display the exact irreversible copy and never activate on item selection alone.

Poll `/character/state` every 5,000 wall milliseconds while the document is visible and immediately on `visibilitychange` back to visible. Remaining potion time is always replaced from server state; the browser may animate a countdown between polls but cannot mark an effect completed authoritatively.

- [ ] **Step 6: Implement the avatar Active Effects popover**

The avatar trigger opens on pointer hover and focus; click/tap pins; Escape and close dismiss; leaving hover closes only an unpinned surface. Render one row per state effect with icon, remaining combat-active time, and description. Gold includes a 0..2.5M progress bar; Damage states +25%; monster debuff shows its remaining wall time and penalty. Label potion state as Armed, Active, or Paused without consuming timer time while paused. Bound the list height and scroll overflow.

No persistent potion icon appears on a player tile. The profile avatar may show the short one-shot bottle burst only immediately after confirmed activation.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/web-potions.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts tests/playerhub.test.ts tests/web-character.test.ts
node --check src/web/public/player-hub.js
npm run typecheck
```

Expected: all selected tests pass, syntax check exits 0, and typecheck exits 0.

- [ ] **Step 8: Commit manual Inventory activation**

```bash
git add src/web/routes/character.ts src/web/views/character-inventory.ejs src/web/views/character-sheet.ejs src/web/public/player-hub.js src/web/public/player-hub.css tests/web-potions.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts
git commit -m "feat(character): activate potions from Inventory"
```

---

### Task 13: Render shared gold/red potion motes on TV and the player avatar

**Files:**
- Create: `src/web/public/potion-fx.js`
- Modify: `src/web/public/tv/index.html`
- Modify: `src/web/public/tv/embed.html`
- Modify: `src/web/public/tv/tv.js`
- Modify: `src/web/tvview.ts`
- Modify: `src/web/views/character-sheet.ejs`
- Modify: `src/web/public/player-hub.js`
- Modify: `src/web/public/player-hub.css`
- Create: `tests/potion-fx.test.ts`
- Modify: `tests/tvview-state.test.ts`
- Modify: `tests/anim.test.ts`
- Modify: `tests/player-hub-client.test.ts`

**Interfaces:**
- `TvHero` gains `potionEffects: { goldTier: number | null; damageTier: number | null }`.
- Produces browser global `window.ClaudeRpgPotionFx.frame(input)` used by both TV canvas and profile-avatar canvas.
- One beginner type produces four motes; dual type produces six interleaved motes total.

- [ ] **Step 1: Write failing pure mote-vocabulary tests**

Create a Node VM test for `potion-fx.js`:

```ts
const gold = api.frame({ playerId: 7, goldTier: 1, damageTier: null, timeMs: 1000 });
expect(gold).toHaveLength(4);
expect(new Set(gold.map((m: any) => m.color))).toEqual(new Set(['#f1c75b']));
expect(gold.every((m: any) => [1, 2, 3].includes(m.size))).toBe(true);
expect(gold.every((m: any) => Number.isInteger(m.dx) && Number.isInteger(m.dy))).toBe(true);

const dual = api.frame({ playerId: 7, goldTier: 1, damageTier: 1, timeMs: 1000 });
expect(dual).toHaveLength(6);
expect(new Set(dual.map((m: any) => m.type)).size).toBe(2);
expect(Math.max(...dual.map((m: any) => -m.dy))).toBeLessThanOrEqual(28);
```

Call twice with the same input and assert exact equality. Call at a later stepped time and assert horizontal jitter changes only in integer source pixels.

- [ ] **Step 2: Run the FX test and verify failure**

Run:

```bash
npm test -- tests/potion-fx.test.ts
```

Expected: FAIL because the shared browser helper does not exist.

- [ ] **Step 3: Implement deterministic source-pixel motes**

Expose:

```js
window.ClaudeRpgPotionFx = Object.freeze({ frame });
```

`frame` returns `{ type, color, dx, dy, size, alpha }[]`. Derive phase from player ID, mote index, type, and integer time buckets—never `Math.random()`. Use solid 1/2/3 source-pixel squares, upward loops beginning below feet, stepped left/right jitter, and alpha only near the top. Gold and red phases differ. Future tier values may increase cadence, but visible output is capped at eight motes per player.

- [ ] **Step 4: Add failing TV-state and renderer-source tests**

Activate Gold for one player and Damage for another, then assert their `TvHero.potionEffects`. Assert an expired row is absent while `debuffed` remains independent. In `tests/anim.test.ts`, assert both TV documents load `potion-fx.js` before `tv.js`, and `drawHeroes` calls the shared frame helper after drawing the sprite but before drawing `DEBUFF_BADGE`.

- [ ] **Step 5: Emit potion state and draw motes in front of heroes**

Use `activePotionEffects` in `buildTvState` and map tier numbers for `active` or `paused` effects into `TvHero`; omit newly `armed` effects until their combat clock has started. In `tv.js`, add `drawPotionMotes(p, drawX, drawY, w, h, t)`: convert source-pixel offsets and sizes through the hero scale, draw a crisp one-pixel dark offset shadow, then a restrained color bloom and solid square. Call it after `drawSprite`/hit overlays and before the existing red debuff badge.

Do not add potion bottle badges to the TV tile. Preserve the player-level six-mote dual budget.

- [ ] **Step 6: Reuse the same helper on the profile avatar**

Add a transparent 48×48 canvas over the animated profile sprite. `player-hub.js` draws the same frame descriptors while an effect is present and stops its animation frame loop when none are active or `prefers-reduced-motion` matches. Keep the effect popover as static reduced-motion evidence.

- [ ] **Step 7: Run focused tests and syntax checks**

Run:

```bash
npm test -- tests/potion-fx.test.ts tests/tvview-state.test.ts tests/anim.test.ts tests/player-hub-client.test.ts tests/tvhub.test.ts
node --check src/web/public/potion-fx.js
node --check src/web/public/tv/tv.js
node --check src/web/public/player-hub.js
npm run typecheck
```

Expected: all selected tests pass, all syntax checks exit 0, and typecheck exits 0.

- [ ] **Step 8: Commit shared potion effects**

```bash
git add src/web/public/potion-fx.js src/web/public/tv/index.html src/web/public/tv/embed.html src/web/public/tv/tv.js src/web/tvview.ts src/web/views/character-sheet.ejs src/web/public/player-hub.js src/web/public/player-hub.css tests/potion-fx.test.ts tests/tvview-state.test.ts tests/anim.test.ts tests/player-hub-client.test.ts
git commit -m "feat(tv): show active potion motes on heroes"
```

---

## Milestone D — Reporting and Release Readiness

This milestone proves real yields, exposes no player report yet, and prepares a reproducible local animated review while keeping production and Pi testing gated.

## File Structure

- Create `src/domain/potionlab.ts` — activation, counterfactual, economy, and evidence-threshold reports.
- Modify `src/web/routes/admin.ts`; create `src/web/views/admin-potions.ejs` — authenticated Potion Lab.
- Modify `src/web/views/admin-players.ejs` — admin navigation link.
- Create `tools/seed-potion-demo.ts` — deterministic local inventory/effect/crowded-fight fixtures.
- Create `docs/testing/timed-consumables-local.md` — browser review and later Pi release checklist.
- Add report, route-auth, and demo-seed tests.

### Task 14: Build the admin-only Potion Lab from canonical audit rows

**Files:**
- Create: `src/domain/potionlab.ts`
- Modify: `src/web/routes/admin.ts`
- Create: `src/web/views/admin-potions.ejs`
- Modify: `src/web/views/admin-players.ejs`
- Create: `tests/potionlab.test.ts`
- Create: `tests/web-admin-potions.test.ts`

**Interfaces:**
- Produces `buildPotionLabReport(db, filters)`.
- Produces authenticated `GET /admin/potions` with optional `from`, `to`, `player`, and `sku` query filters.
- Counterfactual Damage results subtract only the selected activation's `potion_activation_encounters.bonus_damage`, then rerun the stored encounter allocation.

- [ ] **Step 1: Write failing report-domain tests**

Create fixtures for completed Gold and Damage activations, purchase rows, Gold work events, reward awards, activation/encounter bonus aggregates, ledger mutations, and monster steals. Assert:

```ts
const report = buildPotionLabReport(db, {});
expect(report.gold).toMatchObject({
  purchases: 1, completed: 1, spent: 100_000,
  basePayout: 125_000, stretchPayout: 25_000,
  breakEvenCount: 1, stretchCount: 1,
});
expect(report.damage.activations[0]).toMatchObject({
  bonusDamage: 250,
  actualRank: 1,
  counterfactualRank: 2,
  podiumClimbs: 1,
});
expect(report.economy).toMatchObject({
  potionGoldSpent: 250_000,
  goldPotionMinted: 150_000,
  monsterGoldStolen: expect.any(Number),
  ledgerReconciled: true,
});
```

Also cover date/player/SKU filters, an unfinished activation, multiple encounters touched by one activation, two activations touching the same encounter, an activation that changes damage but not rank, and a deliberately corrupted player balance producing `ledgerReconciled: false`.

- [ ] **Step 2: Run the report test and verify the missing-module failure**

Run:

```bash
npm test -- tests/potionlab.test.ts
```

Expected: FAIL because `src/domain/potionlab.ts` does not exist.

- [ ] **Step 3: Implement exact activation and economy reports**

Use:

```ts
export interface PotionLabFilters {
  from?: number;
  to?: number;
  playerId?: number;
  sku?: 'potion_gold_t1' | 'potion_damage_t1';
}

export interface PotionLabReport {
  gold: {
    purchases: number; completed: number; spent: number; basePayout: number;
    stretchPayout: number; breakEvenCount: number; stretchCount: number;
    byPlayer: { playerId: number; activations: number; medianNetGold: number }[];
    byOfficeHour: { hour: number; activations: number; medianNetGold: number }[];
    activations: { activationId: number; playerId: number; purchasedAt: number;
      activatedAt: number; completedAt: number | null; activeElapsedMs: number;
      eligibleTokens: number; payout: number; purchasePrice: number; netGold: number }[];
  };
  damage: {
    activations: { activationId: number; playerId: number; purchasedAt: number;
      bonusDamage: number; actualRank: number; counterfactualRank: number;
      actualReward: number; counterfactualReward: number; podiumClimbs: number;
      purchasePrice: number; netGold: number }[];
  };
  economy: {
    potionGoldSpent: number; goldPotionMinted: number; encounterGoldAwarded: number;
    monsterGoldStolen: number; ledgerInflow: number; ledgerOutflow: number;
    ledgerReconciled: boolean; stockPurchased: number; dosesUsed: number;
  };
  readiness: {
    distinctCombatDays: number; completedGold: number; completedDamage: number;
    distinctPlayers: number; enoughCombatDays: boolean; enoughGoldActivations: boolean;
    enoughDamageActivations: boolean; enoughPlayers: boolean; readyForTier2Review: boolean;
  };
}

export function buildPotionLabReport(
  db: Database.Database,
  filters: PotionLabFilters,
): PotionLabReport;
```

Gold rows derive eligible tokens/base/stretch from `potion_activations` and `potion_work_events`, with net result equal to payout minus the activation's stored FIFO purchase unit price. Damage rows find every encounter through `potion_activation_encounters`, clone the stored participant inputs, subtract only that activation's bonus from its player, rerun `allocateEncounterGold` with the encounter's stored percentages, and compare actual/counterfactual rank and award; activation net is the summed incremental encounter award minus its stored purchase unit price. Economy totals come from reason- and source-grouped ledger rows: potion spend includes `shop_purchase` only when `source_table='shop_purchases'`, so permanent Wardrobe purchases are not misclassified. Reconciliation compares each player's latest ledger `balance_after` to `players.gold` and verifies the signed ledger sum from opening balance.

Count combat days from `game_clock_days` rows with `active_ms > 0`. Readiness is:

```ts
{
  enoughCombatDays: distinctCombatDays >= 14,
  enoughGoldActivations: completedGold >= 30,
  enoughDamageActivations: completedDamage >= 30,
  enoughPlayers: distinctPlayers >= 5,
  readyForTier2Review:
    distinctCombatDays >= 14 && completedGold >= 30
    && completedDamage >= 30 && distinctPlayers >= 5,
}
```

It is evidence status only and never enables Tier 2 products.

- [ ] **Step 4: Write failing admin route/auth tests**

Assert unauthenticated `/admin/potions` redirects to login. After login, assert headings and values for Gold yield/net, Damage counterfactual rank/reward, economy inflow/outflow, reconciliation, daily stock/use, and Tier 2 evidence thresholds. Assert invalid date/player/SKU filters return 400 and the page contains no player auth tokens.

- [ ] **Step 5: Add the authenticated Potion Lab page**

Parse query filters with Zod. Render one compact filter form and four sections:

1. Gold Potion outcomes and distributions;
2. Damage Potion actual vs counterfactual table;
3. economy flow and ledger reconciliation;
4. Tier 2 evidence checklist.

Use existing lite-frame admin styles, add a link from the admin dashboard, and state clearly that encounter gold is redistributed rather than minted. Do not add any player-facing report route or newsletter.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/potionlab.test.ts tests/web-admin-potions.test.ts tests/web-admin-auth.test.ts tests/web-admin-settings.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit the Potion Lab**

```bash
git add src/domain/potionlab.ts src/web/routes/admin.ts src/web/views/admin-potions.ejs src/web/views/admin-players.ejs tests/potionlab.test.ts tests/web-admin-potions.test.ts
git commit -m "feat(admin): add potion economy and yield reports"
```

---

### Task 15: Create the local animated review fixture and run the full release gate

**Files:**
- Create: `tools/seed-potion-demo.ts`
- Create: `docs/testing/timed-consumables-local.md`
- Create: `tests/potion-demo.test.ts`

**Interfaces:**
- `npm exec tsx tools/seed-potion-demo.ts -- <db-path>` creates deterministic local review data only at the explicit path.
- The fixture includes male/female variants and every combined potion/debuff state needed for visual approval.

- [ ] **Step 1: Write a failing deterministic demo-seed test**

Create `tests/potion-demo.test.ts` that runs the exported `seedPotionDemo(db, now)` against an in-memory database and asserts:

```ts
expect(db.prepare('SELECT COUNT(*) AS n FROM players').get()).toEqual({ n: 8 });
expect(db.prepare("SELECT COUNT(*) AS n FROM potion_activations WHERE status='active'").get())
  .toEqual({ n: 6 });
expect(db.prepare("SELECT COUNT(*) AS n FROM monster_attacks WHERE kind='debuff'").get())
  .toEqual({ n: 2 });
expect(db.prepare("SELECT COUNT(*) AS n FROM encounters WHERE status='active'").get())
  .toEqual({ n: 1 });
```

The eight players must include at least four classes and both genders. Their states must include Gold-only, Damage-only, dual-potion, debuff-only, potion-plus-debuff, and no-effect control.

- [ ] **Step 2: Run the seed test and verify failure**

Run:

```bash
npm test -- tests/potion-demo.test.ts
```

Expected: FAIL because the demo seed does not exist.

- [ ] **Step 3: Implement an explicit-path-only demo seed**

Export `seedPotionDemo(db, now)` for tests. The CLI must reject a missing path, `:memory:`, the configured production path, a directory, or any existing non-empty database. It has no replacement or deletion flag; reruns use a fresh temporary path. Seed settings, eight named demo players, enough gold/inventory lots, one large active encounter, deterministic damage standings, active Gold/Damage combinations, and recent debuffs. Print only character URLs and the local TV URL; never print auth tokens separately from their local URLs.

- [ ] **Step 4: Write the local and deferred-Pi review runbook**

Document exact local commands using `/private/tmp/clauderpg-potion-demo.db`, a non-production port, explicit `SPRITES_DIR`, and `OFFICE_TIME_ZONE=America/New_York`. The checklist must verify:

- Bazaar quantity 1–3, totals, stock, restock, purchase animation, and ledger quantities;
- manual confirmation, armed/active state, daily doses, and no same-type stacking;
- Live Dungeon default tab, compact leaderboard, Today stats, Inventory, and preserved Wardrobe draft;
- Active Effects hover/focus/click/tap/Escape and bounded overflow;
- fully animated male/female Gold-only, Damage-only, dual, debuff-only, and combined states;
- square sizes, stepped jitter, front-layer placement, dark offset shadow, restrained bloom, and short height;
- crowded-fight readability, responsive widths, moss-wall safety, keyboard tabs, and reduced motion;
- admin Gold/Damage/economy/reconciliation reports;
- full TV remains visually unchanged except approved potion motes.

Add a separate deferred Pi gate: copy no database, preserve external assets, test only when Pi access returns, deploy only while `game_state.paused=1`, and verify SSE version reload plus crowded-scene performance before release.

- [ ] **Step 5: Run focused seed verification and commit the review harness**

Run:

```bash
npm test -- tests/potion-demo.test.ts
npm run typecheck
```

Expected: seed test passes and typecheck exits 0.

Commit:

```bash
git add tools/seed-potion-demo.ts docs/testing/timed-consumables-local.md tests/potion-demo.test.ts
git commit -m "test(potions): add the animated local review fixture"
```

- [ ] **Step 6: Run the complete automated gate from a clean process**

Run:

```bash
npm test
npm run typecheck
node --check src/web/public/shop.js
node --check src/web/public/player-hub.js
node --check src/web/public/potion-fx.js
node --check src/web/public/tv/tv.js
git diff --check
```

Expected: every test passes with zero failures, typecheck exits 0, all four public scripts parse, and `git diff --check` produces no output.

- [ ] **Step 7: Run local animated browser review**

Follow `docs/testing/timed-consumables-local.md` with the fresh demo database. Review desktop and narrow widths in the in-app browser. Exercise a real purchase, activation, five-second state refresh, tab changes with a dirty Wardrobe draft, full TV, compact TV, and admin Potion Lab. Record every observed visual or functional correction as a failing automated test before changing implementation.

- [ ] **Step 8: Stop at the production boundary**

Report local test counts, typecheck/syntax results, Gold/Damage mechanics observed, and the male/female animated visual review. Explicitly list Pi visual/performance verification and idle-only production deployment as pending. Do not push or deploy until the user separately authorizes those actions and Pi access is available.

---

## Final Completion Checklist

- [ ] Both Tier 1 products purchase atomically from personal daily stock and persist in inventory.
- [ ] Manual activation enforces three daily uses per type, one active per type, and Gold/Damage overlap.
- [ ] Combat-active duration pauses for idle, defeat, downtime, and no encounter.
- [ ] Gold earnings are incremental, capped, stretched, idempotent, and independent of fight completion.
- [ ] Damage boost changes only personal base hit and records exact activation/encounter bonus damage.
- [ ] Hybrid encounter awards exactly equal the unchanged gold pool and current fights preserve legacy behavior.
- [ ] Every runtime gold mutation reconciles through the ledger.
- [ ] Bazaar, Live Dungeon, Inventory, Wardrobe, effects popover, Today stats, and potion confirmation match the approved flow.
- [ ] Gold/red square motes and monster debuffs coexist on full TV, compact TV, and player avatar.
- [ ] Potion Lab proves actual and counterfactual yields without exposing a player report.
- [ ] `npm test`, `npm run typecheck`, public-script syntax checks, and `git diff --check` pass.
- [ ] Local animated male/female visual review is approved.
- [ ] Pi performance verification and production deployment remain separately gated.

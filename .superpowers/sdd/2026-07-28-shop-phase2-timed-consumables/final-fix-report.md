# Timed Consumables Final-Review Fix Report

Date: 2026-07-29
Branch: `feat/player-shop-cosmetics`
Implementation commit: `f488eeaec69a7654a562871a5744d0ddc5825406`

## Status

All Important and Minor items in `final-review-findings.md` were addressed as one integrated wave. No deferred or accepted item was implemented. In particular, Potion Lab SQL pagination/indexing was not added. No dependency, approved launch constant, push, deploy, SSH operation, service restart, or production-data mutation was involved.

## Changed files

### Reward pool, participant union, and upgrade compatibility

- `src/db/migrations.ts`
- `src/domain/encounters.ts`
- `src/domain/engine.ts`
- `tests/db-timed-consumables-migration.test.ts`
- `tests/db-timed-consumables-upgrade.test.ts`
- `tests/engine-reward-awards.test.ts`

### Potion configuration, purchase/activation safety, and Bazaar availability

- `src/domain/inventory.ts`
- `src/domain/potions.ts`
- `src/domain/shop-products.ts`
- `src/domain/shopview.ts`
- `src/web/routes/admin.ts`
- `src/web/routes/shop.ts`
- `src/web/views/shop.ejs`
- `tests/inventory.test.ts`
- `tests/shop-products.test.ts`
- `tests/web-admin-settings.test.ts`
- `tests/web-shop.test.ts`

### Potion Lab audit contract and podium definitions

- `src/domain/potionlab.ts`
- `src/web/routes/admin.ts`
- `src/web/views/admin-potions.ejs`
- `tests/potion-demo.test.ts`
- `tests/potionlab.test.ts`
- `tests/web-admin-potions.test.ts`

### Player-hub focus behavior and stale-paused regression

- `src/web/public/player-hub.js`
- `tests/player-hub-client.test.ts`
- `tests/gameclock.test.ts`

## RED/GREEN evidence by finding group

### Findings 1-2: participant union and immutable encounter pool

RED command:

```text
npm test -- tests/db-timed-consumables-migration.test.ts tests/db-timed-consumables-upgrade.test.ts tests/engine-reward-awards.test.ts
```

RED result: exit 1 with five expected failures. The failures demonstrated the absent `reward_gold_pool` column/backfill, the live `gold_factor` changing an already-spawned encounter's award, and token-only contributors being absent from hybrid and legacy participant sets/summaries.

GREEN command:

```text
npm test -- tests/db-timed-consumables-migration.test.ts tests/db-timed-consumables-upgrade.test.ts tests/engine-reward-awards.test.ts tests/engine-defeat-summary.test.ts tests/rewards.test.ts
```

GREEN output:

```text
Test Files  5 passed (5)
Tests       29 passed (29)
```

The wider final reward run is recorded under Final scoped verification.

### Finding 3: all-or-nothing potion configuration and mutation safety

RED command:

```text
npm test -- tests/shop-products.test.ts tests/inventory.test.ts tests/web-admin-settings.test.ts tests/web-shop.test.ts tests/potions.test.ts
```

RED result: exit 1 with 23 expected failures covering whole-configuration invalidation, partial/invalid admin payloads, stale-form purchase under invalid effect tuning, unsafe price multiplication, and unavailable Bazaar behavior.

GREEN command:

```text
npm test -- tests/shop-products.test.ts tests/inventory.test.ts tests/web-admin-settings.test.ts tests/web-shop.test.ts tests/potions.test.ts tests/shopview.test.ts tests/playerhub.test.ts
```

GREEN output:

```text
Test Files  7 passed (7)
Tests       103 passed (103)
```

### Findings 4-5 and 7: Potion Lab audit fields, podium rules, and reward-split copy

RED command:

```text
npm test -- tests/potionlab.test.ts tests/web-admin-potions.test.ts tests/potion-demo.test.ts
```

RED result: exit 1 with seven expected failures for missing Gold timing/payout/rate data, missing Damage window/counterfactual/podium evidence, off-podium improvements being counted as climbs, and stale `80/20` presentation.

GREEN command:

```text
npm test -- tests/potionlab.test.ts tests/web-admin-potions.test.ts tests/potion-demo.test.ts
```

GREEN output:

```text
Test Files  3 passed (3)
Tests       25 passed (25)
```

Route assertions were subsequently strengthened to prove rendered timestamps, wall/combat spans, base/stretch/total values, rates, actual/counterfactual damage and rewards, and per-encounter podium evidence. The final Potion Lab run below includes those assertions.

### Finding 6: mixed pointer/keyboard focus behavior

RED command:

```text
npm test -- tests/player-hub-client.test.ts tests/gameclock.test.ts
```

RED output:

```text
Test Files  1 failed | 1 passed (2)
Tests       1 failed | 16 passed (17)
```

The new mixed-input test showed that `pointerleave` closed the unpinned Active Effects popover while focus remained inside `avatarWrap`.

GREEN command and output:

```text
npm test -- tests/player-hub-client.test.ts tests/gameclock.test.ts

Test Files  2 passed (2)
Tests       17 passed (17)
```

### Finding 8: stale `game_state.paused=1` regression

The requested regression was added before changing production code. It passed on its first run: all four `tests/gameclock.test.ts` cases were green while the new finding-6 test was RED. This is intentionally recorded as characterization evidence, not as a fabricated RED: `isCombatAcceptingWork` already derives eligibility from idle time, defeat state, and the live encounter rather than the stale persisted `paused` flag.

## Migration and backfill rationale

Migration `015_encounter_reward_gold_pool` is forward-only. It adds nullable, non-negative integer `encounters.reward_gold_pool` without rewriting or reclassifying legacy encounters.

Backfill rules for existing `hybrid-v1` rows are deterministic and reflect the best evidence that existed before the pool was snapshotted:

1. If immutable `encounter_reward_awards` exist, the pool is their exact `SUM(total_gold)`. This preserves the pool actually distributed by a completed encounter, even if settings changed later.
2. Otherwise, the row is backfilled once as `ROUND(max_hp * dungeon.level * upgrade-time gold_factor)`. The setting must be valid JSON numeric and non-negative; malformed/missing values use the already-approved `0.01` default. Older active hybrid rows have no historical factor snapshot, so upgrade-time validated configuration is the honest reproducible value available.
3. `legacy-v0` rows remain `NULL`. Their kill/summary path continues to use the legacy live formula and `gold_damage_weight`, preserving compatibility.
4. Every newly spawned hybrid encounter calculates and stores a safe integer pool. Kill uses only that stored value, while the existing deterministic largest-remainder allocation still proves exact conservation.

The production-shaped 014-to-015 upgrade fixture proves an active hybrid formula backfill (`152`), a defeated hybrid award-derived backfill (`77`), an untouched legacy `NULL`, and migration registration.

## Self-review against every adjudicated finding

1. **Participant union:** `encounterParticipants` uses a SQL `UNION` of encounter damage players and token-event players in the inclusive encounter window. Missing damage, hit, max-hit, potion bonus, and effective-token values become zero. Hybrid kill, legacy kill, and defeat-summary recomputation share this function. Regressions include token-only and damage-only players, prove the token-only work share is nonzero, and prove awarded totals equal the pool.
2. **Immutable pool:** hybrid spawn snapshots `reward_gold_pool`; hybrid kill rejects absent/invalid snapshots and never rereads `gold_factor`. A setting-change regression proves the spawn-time pool survives a later `gold_factor=9999` edit. The forward migration/backfill and legacy behavior are covered as described above.
3. **Usable potion configuration:** all 11 related settings are parsed together. Durations must produce positive safe-integer milliseconds; prices, payouts, caps, thresholds, stock, and use limits must be non-negative safe integers; the damage effect must produce a finite positive multiplier. Any submitted potion field makes the full admin group mandatory, and validation occurs before the settings transaction, so unrelated fields are not partially saved. Purchase validates the whole configuration and activation snapshot before inserting purchases/lots, debiting gold, or changing inventory; `unitPrice * quantity` must also be safe. Invalid tuning returns stable `invalid_config`/unavailable behavior, and stale-form tests prove zero mutation.
4. **Potion Lab contract:** Gold domain/page rows now include purchase, activation and completion timestamps/state, wall and combat-active elapsed time, eligible tokens, per-run base/stretch/total payout, purchase price, net, and completed-run break-even/stretch rates. Damage rows include purchase price, activation window and spans, actual/counterfactual/bonus damage, actual/counterfactual rank and reward, net, and nested per-encounter split/podium evidence. Domain and authenticated route tests assert labels and rendered evidence values; cache remains `private, no-store` and auth-token non-disclosure remains covered.
5. **Podium definitions:** `podiumEntries` increments only when actual rank is 1-3 and counterfactual rank is greater than 3. `podiumClimbs` increments by positions only when both ranks are 1-3 and actual rank is better. Explicit tests cover 8-to-5 off-podium movement (zero), 4-to-3 entry (one entry, zero climbs), and 3-to-1 movement (two climbs, zero entries).
6. **Focus-within:** unpinned pointer leave closes only when `avatarWrap` does not match `:focus-within`. The regression mixes keyboard focus with pointer leave, then proves a real focus exit closes the popover.
7. **Reward-split terminology:** the stale `80/20` sentence is gone. The page describes the stored hybrid work/damage/podium allocation and each encounter evidence row renders its stored split; launch data displays `80/10/5/3/2`.
8. **Stale paused state:** the new regression explicitly writes `game_state.paused=1` while combat is otherwise live and proves eligibility remains true. No production change was necessary.

Global review: approved values were not changed; Wardrobe/cosmetic state code was not modified; focused Wardrobe, cosmetic, player-hub, TV-state, auth, and no-store route tests are green. There is no new index, pagination, dependency, Tier 2 product, or out-of-scope feature.

## Final scoped verification

The package-wide suite was intentionally not run, per the controller instruction. The final tree was verified with these exact focused commands.

### Reward, migration, legacy, and exact-pool coverage

```text
npm test -- tests/db-timed-consumables-migration.test.ts tests/db-timed-consumables-upgrade.test.ts tests/encounters.test.ts tests/rewards.test.ts tests/engine-reward-awards.test.ts tests/engine-defeat-summary.test.ts tests/engine-kill.test.ts tests/engine.test.ts

Test Files  8 passed (8)
Tests       46 passed (46)
```

### Configuration, purchase/activation, Bazaar/admin, and ledger coverage

```text
npm test -- tests/shop-products.test.ts tests/inventory.test.ts tests/potions.test.ts tests/shopview.test.ts tests/playerhub.test.ts tests/web-shop.test.ts tests/web-admin-settings.test.ts tests/web-potions.test.ts tests/goldledger.test.ts

Test Files  9 passed (9)
Tests       115 passed (115)
```

### Potion Lab, report route/auth, demo, and layout coverage

```text
npm test -- tests/potionlab.test.ts tests/web-admin-potions.test.ts tests/potion-demo.test.ts tests/web-admin-auth.test.ts tests/admin-potions-css.test.ts

Test Files  5 passed (5)
Tests       29 passed (29)
```

### Player hub, combat clock, potion lifecycle, Wardrobe/cosmetics, TV state, and auth coverage

```text
npm test -- tests/player-hub-client.test.ts tests/player-hub-css.test.ts tests/web-character.test.ts tests/web-dye.test.ts tests/dye-client-behavior.test.ts tests/cosmetic-entitlements.test.ts tests/slotcosmetics.test.ts tests/gameclock.test.ts tests/potion-gold.test.ts tests/potion-damage.test.ts tests/potion-fx.test.ts tests/tvview-state.test.ts tests/tvview-cosmetics.test.ts tests/auth.test.ts

Test Files  14 passed (14)
Tests       146 passed (146)
```

The expected corrupt-`class_key` request-error diagnostic was printed by its existing `web-character` 500-response regression; that test and the entire command passed.

Focused total: **36 test files, 336 tests, zero failures**.

### Typecheck

```text
npm run typecheck

> claude-rpg@0.1.0 typecheck
> tsc --noEmit
```

Exit 0.

### Browser-script syntax

```text
node --check src/web/public/shop.js
node --check src/web/public/player-hub.js
node --check src/web/public/potion-fx.js
node --check src/web/public/tv/tv.js
```

All four exited 0 with no output.

### Whitespace/error-marker check

```text
git diff --check
```

Exit 0 with no output before the implementation commit.

## Concerns and remaining gates

- No known scoped implementation concern remains.
- The package-wide 1,325-test controller run remains pending by explicit instruction; it was not duplicated here.
- Raspberry Pi visual/performance verification, idle-only deployment, and all production operations remain separately gated and were not attempted.
- The branch was not pushed or merged.

# Runtime Raiders Scoring-Independent Presence Clock Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let fresh accepted Run activity wake and sustain the dungeon for the configured idle window even when the event awards zero Raid Power.

**Architecture:** Add an empty, player-keyed presence table rather than changing accounts or manufacturing token events. Record server receipt time only for newly accepted, authenticated, enabled-Raider events observed within 120 seconds; then make dungeon sleep and public `activeRaiders` use a single union of legacy credited activity and Run presence. Keep Momentum, Raid Power, heartbeat contact, and historical `connected` display independent.

**Tech Stack:** TypeScript, Node.js 20+, better-sqlite3 migrations/transactions, Express, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-runtime-raiders-scoring-and-presence-correction-design.md`

## Global Constraints

- Presence never awards Raid Power, creates a `token_events` row, advances a Run counter, consumes a potion, deals damage, or changes a level by itself.
- Record presence only for a newly accepted authenticated Run event from an enabled Raider.
- The event is fresh only when `observed_at_ms <= received_at_ms` and `received_at_ms - observed_at_ms <= 120000`.
- Store server receipt time as presence so the 15-minute window begins when the server accepts proof of current work.
- Duplicates, heartbeat-only contact, disabled Raiders, ignored pre-cutover events, future observations, stale backlog, and rejected/rolled-back batches cannot extend presence.
- A newly accepted lower sequence is still current presence when it passes freshness checks, even though it awards zero additional Raid Power.
- Dungeon sleep and public `activeRaiders` must use the same activity source and the configured `pause_after_minutes` boundary.
- Legacy credited activity through `players.last_token_at` remains valid input to the office clock.
- `activityScore` and Momentum remain based on credited `token_events`; do not inflate combat modifiers from presence.
- Keep historical TV/player `connected` semantics unchanged in this work.
- Do not modify, delete, merge, or retarget accounts, Raiders, devices, enrollments, Runs, or beta history.
- Do not enable collection or deploy. Production backup, paused-state proof, restart, and canary require separate explicit authorization.

---

## File map

- `src/db/migrations.ts`: migration `020_raider_presence`, adding one empty projection table.
- `src/domain/run-presence.ts`: freshness validation, monotonic recording, and unified activity queries.
- `src/domain/run-ingest.ts`: record presence after a successful event claim inside the existing transaction.
- `src/domain/gamestate.ts`: delegate office last-activity/idle decisions to the unified clock.
- `src/web/tvview.ts`: derive `activeRaiders` from the same clock while retaining token-based Momentum.
- `tests/run-presence.test.ts`: domain-level freshness, monotonicity, and query tests.
- `tests/run-ingest.test.ts`, `tests/web-runs.test.ts`: accepted/duplicate/stale/disabled/heartbeat integration tests.
- `tests/gamestate.test.ts`, `tests/tvview-state.test.ts`, `tests/engine.test.ts`, `tests/runtime-raiders-e2e.test.ts`: sleep, public count, and end-to-end wake behavior.
- `docs/RUNTIME_RAIDERS_CUTOVER.md`, `docs/BACKLOG.md`: release evidence and remaining canary gate.

### Task 1: Add the empty presence projection and unified clock API

**Files:**
- Modify: `src/db/migrations.ts`
- Create: `src/domain/run-presence.ts`
- Create: `tests/run-presence.test.ts`
- Modify: `tests/db.test.ts`

**Interfaces:**
- Produces table `raider_presence(player_id INTEGER PRIMARY KEY, last_run_activity_at INTEGER NOT NULL)` with `ON DELETE CASCADE` to `players(id)`.
- Produces `RUN_PRESENCE_MAX_EVENT_AGE_MS = 120_000`.
- Produces `recordFreshRunPresence(db, playerId, observedAtMs, receivedAtMs): boolean`.
- Produces `lastRaiderActivityAt(db, playerId?: number): number` and `activeRaiderIds(db, now, windowMs): ReadonlySet<number>`.

- [ ] **Step 1: Write the failing migration and empty-state tests**

Open an in-memory DB and assert `raider_presence` exists after migration 020, contains zero rows after players are created, and has the foreign-key/primary-key shape. Reopen a temporary file DB twice to prove migration idempotence.

- [ ] **Step 2: Write failing freshness and monotonicity tests**

Use an enabled player and assert:

```ts
expect(recordFreshRunPresence(db, id, NOW - 120_000, NOW)).toBe(true);
expect(lastRaiderActivityAt(db, id)).toBe(NOW);
expect(recordFreshRunPresence(db, id, NOW - 120_001, NOW + 1)).toBe(false);
expect(recordFreshRunPresence(db, id, NOW + 1, NOW)).toBe(false);
```

Prove a later accepted receipt advances the stored value, an older receipt cannot roll it back, a disabled player returns false, and invalid/unsafe integer arguments throw before SQL.

- [ ] **Step 3: Write failing unified-activity query tests**

Create one legacy player with `last_token_at`, one presence-only player, one disabled player with both values, and one idle player. Assert office max excludes disabled activity, per-player max chooses the later legacy/presence timestamp, and `activeRaiderIds` includes activity exactly at `now - windowMs` but excludes activity one millisecond older.

- [ ] **Step 4: Run the new tests and verify RED**

Run: `npm test -- tests/run-presence.test.ts tests/db.test.ts`

Expected: FAIL because migration 020 and the domain module do not exist.

- [ ] **Step 5: Add migration `020_raider_presence`**

Use this checked shape:

```sql
CREATE TABLE raider_presence (
  player_id INTEGER PRIMARY KEY
    REFERENCES players(id) ON DELETE CASCADE,
  last_run_activity_at INTEGER NOT NULL
    CHECK (
      typeof(last_run_activity_at) = 'integer'
      AND last_run_activity_at BETWEEN 0 AND 9007199254740991
    )
);
```

Do not backfill it from Runs, events, devices, or token history.

- [ ] **Step 6: Implement freshness recording**

Validate safe non-negative integers, confirm `players.disabled = 0`, return false for future/stale observations, and use:

```sql
INSERT INTO raider_presence (player_id, last_run_activity_at)
VALUES (?, ?)
ON CONFLICT(player_id) DO UPDATE SET
  last_run_activity_at = MAX(last_run_activity_at, excluded.last_run_activity_at)
```

Return true only after the enabled/fresh checks pass; repeated direct calls remain monotonic, while event idempotency is enforced by ingestion in Task 2.

- [ ] **Step 7: Implement one source of truth for activity queries**

Union enabled players' non-null `last_token_at` with their `raider_presence.last_run_activity_at`. The optional player filter must use bound parameters. `activeRaiderIds` uses `activity_at >= now - windowMs`, matching the existing idle rule that becomes idle only when age is strictly greater than the window.

- [ ] **Step 8: Run focused tests and type checking**

Run: `npm test -- tests/run-presence.test.ts tests/db.test.ts && npm run typecheck`

Expected: PASS with no migration changes to existing player rows.

- [ ] **Step 9: Commit the presence storage unit**

```bash
git add src/db/migrations.ts src/domain/run-presence.ts tests/run-presence.test.ts tests/db.test.ts
git commit -m "feat(raiders): add scoring-independent presence clock"
```

### Task 2: Record presence only after a newly accepted Run event claim

**Files:**
- Modify: `src/domain/run-ingest.ts`
- Modify: `tests/run-ingest.test.ts`

**Interfaces:**
- Consumes: `recordFreshRunPresence(...)` from Task 1.
- Placement contract: call it after `claimRunEvent(...)` returns true and before the lower-sequence early return, inside the existing batch transaction.
- Preserves: `RunIngestResult`; presence does not add a response counter.

- [ ] **Step 1: Write failing accepted-zero-credit test**

Ingest a fresh open event with all five usage counters at zero. Assert `{ accepted: 1, duplicate: 0, ignored: 0 }`, one Run/event row, zero `token_events`, unchanged player totals/`last_token_at`, and `lastRaiderActivityAt(player.id) === NOW`.

- [ ] **Step 2: Write failing exclusion tests**

Independently prove no presence extension for:

- the exact duplicate identity;
- an event observed 120,001 ms before receipt;
- an event observed one millisecond in the future;
- an authenticated disabled Raider;
- an event ignored because its Run starts before the original Run cutover; and
- a batch that rolls back because scoring overflows or v2 nested counters are invalid.

Also prove a newly claimed, fresh lower sequence extends presence even when `awarded_delta = 0`.

- [ ] **Step 3: Run ingest tests and verify RED**

Run: `npm test -- tests/run-ingest.test.ts`

Expected: FAIL because accepted Run events do not write the presence projection.

- [ ] **Step 4: Add the presence call at the claim boundary**

After the duplicate/claim checks and before `priorSequence`, call:

```ts
if (!player.disabled) {
  recordFreshRunPresence(db, device.playerId, event.observed_at_ms, now);
}
```

The domain function repeats the enabled check so direct callers cannot bypass it. Do not call from the pre-cutover ignore path, exact-identity duplicate path, or failed claim path. Keep it inside the transaction so any later scoring failure rolls it back.

- [ ] **Step 5: Run focused tests and type checking**

Run: `npm test -- tests/run-ingest.test.ts tests/run-presence.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the ingest integration**

```bash
git add src/domain/run-ingest.ts tests/run-ingest.test.ts
git commit -m "fix(raiders): record presence from accepted run events"
```

### Task 3: Prove heartbeat and HTTP rejection cannot create presence

**Files:**
- Modify: `tests/web-runs.test.ts`

**Interfaces:**
- Verifies existing `/api/runs/heartbeat` behavior remains device-health-only.
- Verifies HTTP parse, surface, authentication, and semantic scoring failures leave presence empty.

- [ ] **Step 1: Add failing route-level presence assertions**

Enroll/authenticate a test device, POST a valid heartbeat, and assert 204 plus an updated device contact/version but no `raider_presence` row. Then send unauthenticated, disabled-surface, malformed JSON, stale valid, and invalid-nested-usage event requests and assert no presence.

- [ ] **Step 2: Add the positive route assertion**

POST one fresh authenticated zero-usage Run event and assert HTTP 200/accepted plus presence at a bounded server receipt timestamp. Stub or bracket `Date.now()` using Vitest fake timers so the expected value is exact.

- [ ] **Step 3: Run the route suite**

Run: `npm test -- tests/web-runs.test.ts`

Expected: PASS after Task 2; if any negative path creates presence, fix the ingest call placement rather than adding route-specific cleanup.

- [ ] **Step 4: Commit the HTTP boundary proof**

```bash
git add tests/web-runs.test.ts
git commit -m "test(raiders): keep heartbeat separate from presence"
```

### Task 4: Move dungeon sleep to the unified activity clock

**Files:**
- Modify: `src/domain/gamestate.ts`
- Modify: `tests/gamestate.test.ts`
- Modify: `tests/engine.test.ts`
- Modify: `tests/gameclock.test.ts`

**Interfaces:**
- Consumes: `lastRaiderActivityAt(db)` from Task 1.
- Preserves public functions: `lastActivityAt(db): number` and `isIdle(db, now, pauseAfterMinutes): boolean`.
- Boundary remains: idle only when `now - lastActivityAt > pauseAfterMinutes * 60_000`.

- [ ] **Step 1: Write failing gamestate union tests**

Replace the token-only assertion with cases proving `lastActivityAt` returns the maximum of enabled legacy token activity and enabled Run presence. Prove disabled rows cannot hold the office awake and that no activity returns zero.

- [ ] **Step 2: Write failing engine wake/sleep tests**

With `pause_after_minutes = 15`, create an enabled presence-only Raider and assert an engine tick at receipt time wakes/spawns without any token event. Tick at exactly `receipt + 15 minutes` and assert still awake; tick at `receipt + 15 minutes + 1 ms` and assert paused. Verify player Raid Power, level, token rows, encounter damage, and gold do not change solely because presence exists.

- [ ] **Step 3: Write the game-clock regression**

Prove combat clock accepts work during presence-only activity and stops beyond the same 15-minute boundary, without manufacturing player work events.

- [ ] **Step 4: Run the clock suites and verify RED**

Run: `npm test -- tests/gamestate.test.ts tests/engine.test.ts tests/gameclock.test.ts`

Expected: FAIL because `lastActivityAt` still queries only `players.last_token_at`.

- [ ] **Step 5: Delegate gamestate activity to the unified query**

Implement `lastActivityAt` as a thin wrapper around `lastRaiderActivityAt(db)`. Keep `isIdle` arithmetic unchanged so engine, game clock, potion timing, and existing callers share the new source automatically.

- [ ] **Step 6: Run focused tests and type checking**

Run: `npm test -- tests/gamestate.test.ts tests/engine.test.ts tests/gameclock.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the dungeon-clock integration**

```bash
git add src/domain/gamestate.ts tests/gamestate.test.ts tests/engine.test.ts tests/gameclock.test.ts
git commit -m "fix(dungeon): wake from fresh run presence"
```

### Task 5: Make public `activeRaiders` use the same clock without changing Momentum

**Files:**
- Modify: `src/web/tvview.ts`
- Modify: `tests/tvview-state.test.ts`

**Interfaces:**
- Consumes: `activeRaiderIds(db, now, cfg.pauseAfterMinutes * 60_000)` from Task 1.
- Preserves: `activityScore(...)` for each player's Momentum modifier.
- Changes only: the source of `TvState.activeRaiders`; `TvHero.connected` remains `last_token_at != null` historical state.

- [ ] **Step 1: Write failing public-state boundary tests**

Create a presence-only active player, a legacy-token active player, an expired player, and a disabled player with recent presence. Assert `activeRaiders === 2`, then move `now` one millisecond beyond the window for both active players and assert zero. Assert the presence-only player's modifier remains exactly 1 because there are no credited token events.

- [ ] **Step 2: Update the query-count regression**

Rename the test that says activity score powers both Momentum and active status. Continue asserting one `activityScore` query per player for Momentum, and separately assert `activeRaiderIds` determines only the public count.

- [ ] **Step 3: Run TV tests and verify RED**

Run: `npm test -- tests/tvview-state.test.ts`

Expected: FAIL because `activeRaiders` currently depends on positive token-derived `activityScore`.

- [ ] **Step 4: Separate public presence from Momentum in `buildTvState`**

Compute the active ID set once before mapping players. Continue computing/caching `activityScore` once per player for `tokenModifier`. Set `activeRaiders` to the enabled IDs in the active set; do not serialize timestamps, Run metadata, model, or effort to the TV payload.

- [ ] **Step 5: Run TV tests and type checking**

Run: `npm test -- tests/tvview-state.test.ts && npm run typecheck`

Expected: PASS, including the privacy assertion that the TV payload contains no provider/model/effort data.

- [ ] **Step 6: Commit the public-state integration**

```bash
git add src/web/tvview.ts tests/tvview-state.test.ts
git commit -m "fix(tv): align active raiders with dungeon presence"
```

### Task 6: Add end-to-end zero-credit wake coverage

**Files:**
- Modify: `tests/runtime-raiders-e2e.test.ts`

**Interfaces:**
- Exercises enrollment/device authentication, `/api/runs/events`, SQLite projections, `GameEngine.tick`, and `buildTvState` together.
- Acceptance path uses a newly started Run with all usage counters zero.

- [ ] **Step 1: Write the full positive scenario**

Under fake time, POST a fresh authenticated open event with zero usage. Assert accepted=1; capture player totals, Run award, token count, gold, and level; tick the engine; assert `paused:false` and `activeRaiders:1`; then assert every captured scoring/economy value is unchanged.

- [ ] **Step 2: Add expiry and duplicate assertions**

Retry the exact event near the end of the window and assert duplicate=1 without extending the stored presence timestamp. Tick at original receipt + 15 minutes + 1 ms and assert `paused:true` and `activeRaiders:0`.

- [ ] **Step 3: Add stale-backlog assertion**

POST a newly identified event whose observation is older than 120 seconds. It may be accepted/scored according to normal Run rules, but assert it does not wake the dungeon or update presence. This explicitly separates event ingestion from current-presence proof.

- [ ] **Step 4: Run the end-to-end suite**

Run: `npm test -- tests/runtime-raiders-e2e.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the end-to-end proof**

```bash
git add tests/runtime-raiders-e2e.test.ts
git commit -m "test(raiders): prove zero-credit dungeon presence"
```

### Task 7: Document and verify the separately gated presence release

**Files:**
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md`
- Modify: `docs/BACKLOG.md`

**Interfaces:**
- Produces a release checklist; performs no production mutation.
- Requires the scoring-v2 candidate to be independently reviewed and a fresh explicit deployment authorization.

- [ ] **Step 1: Document migration and rollback facts**

Record that migration 020 creates one empty table and does not backfill or edit account/history tables. Document rollback as application-code rollback while leaving the inert table in place; do not drop it from production during an incident.

- [ ] **Step 2: Add bounded canary acceptance steps with a hard STOP**

Document this authorized-only sequence: prove public `paused:true`; back up DB; deploy reviewed SHA; verify migration/health/version; with separate approval enable one canary just long enough for one fresh zero-credit event; verify immediate wake, `activeRaiders`, unchanged Raid Power, duplicate non-extension, and sleep after 15 minutes; turn collection off again. Put `STOP — collection remains off without separate approval` before the canary instructions.

- [ ] **Step 3: Update backlog state**

Mark presence #35 as approved/planned until production evidence exists. Keep re-enrollment and pretty `raiders status` as separate backlog work.

- [ ] **Step 4: Run the full verification suite**

Run: `npm test && npm run typecheck && npm run check:player-copy`

Expected: all tests pass, zero type errors, and no UI-copy drift.

- [ ] **Step 5: Inspect immutable-state boundaries**

Run `git status --short` and review the commits. Expected: no database, account, enrollment, device, signed artifact, collection configuration, or `companion/.build/` changes are staged.

- [ ] **Step 6: Commit documentation and stop before production**

```bash
git add docs/RUNTIME_RAIDERS_CUTOVER.md docs/BACKLOG.md
git commit -m "docs(raiders): gate presence-clock rollout"
```

Report the candidate SHA and test evidence. Do not SSH, back up the live DB, restart production, enable collection, or run the canary until the user separately authorizes that operational boundary.

## Acceptance checklist

- [ ] A fresh accepted zero-credit event records server receipt presence and wakes the dungeon.
- [ ] Presence alone leaves Raid Power, tokens, level, gold, damage, and potion work unchanged.
- [ ] Exact duplicates and heartbeats cannot extend presence.
- [ ] Disabled, ignored, future-observed, stale, and rolled-back events cannot extend presence.
- [ ] A fresh newly accepted lower sequence can extend presence without awarding credit.
- [ ] Dungeon sleep and `activeRaiders` share the same enabled-player activity union and exact idle boundary.
- [ ] Momentum remains based only on credited token events.
- [ ] Migration 020 starts empty and does not rewrite beta history or accounts.
- [ ] Collection and production remain untouched until separate approval.

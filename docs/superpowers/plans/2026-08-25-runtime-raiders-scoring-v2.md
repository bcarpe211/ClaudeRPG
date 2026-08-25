# Runtime Raiders Forward-Only Scoring v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a forward-only Raid Power v2 that scores Codex nested usage counters once, preserves every v1 award, and explains native usage honestly on the player page.

**Architecture:** Keep the checked-in v1 policy and every existing Run immutable. Load a second strict policy document and select v1 or v2 from each event's `started_at_ms`; the existing `runs.policy_version` column pins that choice for the life of the Run. Keep raw native counters in SQLite, derive v2 usage as `(input - cache_read) + output`, reject malformed subset relationships atomically, and expose a read-only audit command before any production cutover.

**Tech Stack:** TypeScript, Node.js 20+, Zod, better-sqlite3, Express, EJS, browser JavaScript, Vitest, Bash.

**Spec:** `docs/superpowers/specs/2026-08-25-runtime-raiders-scoring-and-presence-correction-design.md`

## Global Constraints

- Do not modify, delete, merge, or retarget accounts, Raiders, devices, or enrollments.
- Do not reset or recompute existing Runs, Raid Power, levels, gold, damage, rewards, purchases, cosmetics, or leaderboard history.
- Runs with `started_at_ms < RAID_POWER_V2_CUTOVER_AT` remain `raid-power-v1`, including late and reconciled events.
- Runs with `started_at_ms >= RAID_POWER_V2_CUTOVER_AT` use `raid-power-v2`; a stored Run's policy never changes.
- V2 usage is exactly `(input - cache_read) + output`; cache writes and reasoning output are retained as raw audit counters but are not added again.
- Reject v2 counters when `cache_read > input` or `reasoning_output > output`; never clamp malformed scoring input.
- Model and effort remain display-only metadata.
- Keep `completion_credit` and the duration curve unchanged from the approved v1 policy.
- Do not change `token_modifier_k`, `modifier_cap`, or any other game setting in this work.
- Do not modify or publish the signed companion; version 0.4.8 remains wire-compatible.
- Do not enable collection on any Raider. Canary collection requires separate explicit approval.
- Do not deploy from an implementation task. Production backup, paused-state proof, restart, and canary are separate authorization gates.

---

## File map

- `src/domain/raid-power-policy.ts`: strict v1/v2 schemas and version-specific scoring math.
- `src/domain/raid-power-policy-schedule.ts`: immutable Run-start-time policy selection.
- `config/raid-power-policy-v2.json`: reviewed v2 policy constants; no model or effort multipliers.
- `src/config.ts`: v2 policy path and cutover configuration.
- `src/domain/run-ingest.ts`: per-event policy selection and atomic malformed-counter rejection.
- `src/web/routes/runs.ts`: load the schedule once and translate semantic counter failures to HTTP 422.
- `src/domain/playerhub.ts`, `src/web/views/character-live.ejs`, `src/web/public/player-hub.js`: containment-aware native usage presentation.
- `tools/runtime-raiders/audit-scoring-v2.ts`: read-only production-data comparison.
- `deploy/claude-rpg.env.example`, `scripts/pi/validate-runtime-raiders-env.sh`, `docs/RUNTIME_RAIDERS_CUTOVER.md`: fail-closed operational configuration.

### Task 1: Add the strict v2 policy and nested-counter math

**Files:**
- Modify: `src/domain/raid-power-policy.ts`
- Create: `config/raid-power-policy-v2.json`
- Modify: `tests/raid-power-policy.test.ts`

**Interfaces:**
- Consumes: `UsageCountersV1` from `src/domain/run-events.ts`.
- Produces: `RaidPowerPolicy = RaidPowerPolicyV1 | RaidPowerPolicyV2`, `loadRaidPowerPolicyV2(path: string): RaidPowerPolicyV2`, and `InvalidNestedUsageError`.
- Preserves: `loadRaidPowerPolicy(path: string): RaidPowerPolicyV1`, `usageCredit(...)`, and `durationCredit(...)` for current callers.

- [ ] **Step 1: Write failing v2 schema and arithmetic tests**

Add a `policyV2Document()` fixture with this exact shape:

```ts
{
  policy_version: 2,
  enabled_providers: ['codex'],
  usage_model: 'codex-nested-counters',
  provider_multipliers: { codex: 1 },
  completion_credit: 854,
  duration: { scale: 1064.369016907896, cap: 3928 },
}
```

Add tests proving:

```ts
const policy = loadV2Document(policyV2Document());
expect(usageCredit(policy, 'codex', {
  input: 74_226,
  output: 486,
  cache_read: 71_424,
  cache_write: 0,
  reasoning_output: 284,
})).toBe(3_288);

expect(() => usageCredit(policy, 'codex', {
  input: 9,
  output: 4,
  cache_read: 10,
  cache_write: 0,
  reasoning_output: 1,
})).toThrow(InvalidNestedUsageError);

expect(() => usageCredit(policy, 'codex', {
  input: 10,
  output: 4,
  cache_read: 9,
  cache_write: 0,
  reasoning_output: 5,
})).toThrow(InvalidNestedUsageError);
```

Also prove cache writes and reasoning do not change v2 credit, model/effort fields are rejected by the strict schema, v1 still returns its historical additive result, and both loaded policies are deeply frozen.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/raid-power-policy.test.ts`

Expected: FAIL because `loadRaidPowerPolicyV2`, `RaidPowerPolicyV2`, and `InvalidNestedUsageError` do not exist.

- [ ] **Step 3: Implement the discriminated policy union**

Keep the existing v1 schema unchanged. Add a strict v2 schema with the exact literal `usage_model`, then implement:

```ts
export class InvalidNestedUsageError extends RangeError {}

export interface RaidPowerPolicyV2 extends RaidPowerPolicyBase {
  readonly policy_version: 2;
  readonly enabled_providers: readonly ['codex'];
  readonly usage_model: 'codex-nested-counters';
  readonly provider_multipliers: Readonly<{ codex: 1 }>;
}

export type RaidPowerPolicy = RaidPowerPolicyV1 | RaidPowerPolicyV2;

export function loadRaidPowerPolicyV2(path: string): RaidPowerPolicyV2 {
  const document: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return deepFreeze(raidPowerPolicyV2Schema.parse(document));
}
```

In `usageCredit`, keep the v1 weighted loop byte-for-byte equivalent. For v2, validate every raw counter as a non-negative safe integer, throw `InvalidNestedUsageError` for either subset violation, compute `input - cache_read + output`, and retain the existing safe-integer and provider checks.

- [ ] **Step 4: Add the reviewed v2 policy document**

Create `config/raid-power-policy-v2.json` using the exact document from Step 1. Confirm `completion_credit` and `duration` match `config/raid-power-policy-v1.json`; only the policy version and usage semantics may differ.

- [ ] **Step 5: Run focused policy tests and type checking**

Run: `npm test -- tests/raid-power-policy.test.ts && npm run typecheck`

Expected: PASS; the v1 calibration tests remain unchanged and v2 returns 3,288 for the acceptance fixture.

- [ ] **Step 6: Commit the policy unit**

```bash
git add src/domain/raid-power-policy.ts config/raid-power-policy-v2.json tests/raid-power-policy.test.ts
git commit -m "feat(raiders): add nested-counter scoring policy v2"
```

### Task 2: Select policies by immutable Run start time

**Files:**
- Create: `src/domain/raid-power-policy-schedule.ts`
- Create: `tests/raid-power-policy-schedule.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: `RaidPowerPolicyV1` and `RaidPowerPolicyV2` from Task 1.
- Produces: `RaidPowerPolicySchedule`, `createRaidPowerPolicySchedule(v1, v2, runCutoverAt, v2CutoverAt)`, and `policyForRunStart(schedule, startedAtMs)`.
- Adds config fields: `raidPowerPolicyV2Path: string` and `raidPowerV2CutoverAt: number`.

- [ ] **Step 1: Write failing schedule boundary tests**

Test these exact boundaries:

```ts
expect(policyForRunStart(schedule, RUN_CUTOVER - 1)).toBeNull();
expect(policyForRunStart(schedule, RUN_CUTOVER)).toBe(v1);
expect(policyForRunStart(schedule, V2_CUTOVER - 1)).toBe(v1);
expect(policyForRunStart(schedule, V2_CUTOVER)).toBe(v2);
```

Also assert `createRaidPowerPolicySchedule` rejects non-safe epochs and `v2CutoverAt < runCutoverAt`.

- [ ] **Step 2: Write failing config tests**

In runtime-raiders mode, require:

```text
RAID_POWER_POLICY_V2_PATH=/absolute/or/repo-relative/config/raid-power-policy-v2.json
RAID_POWER_V2_CUTOVER_AT=<non-negative safe integer epoch>
```

Test missing keys, nonexistent/malformed v2 policy, a v2 cutoff earlier than `RUN_SCORING_CUTOVER_AT`, and an enabled surface whose provider is absent from either policy. In disabled and legacy modes, retain startup without requiring v2 values.

- [ ] **Step 3: Run schedule and config tests and verify RED**

Run: `npm test -- tests/raid-power-policy-schedule.test.ts tests/config.test.ts`

Expected: FAIL because the schedule and v2 config fields do not exist.

- [ ] **Step 4: Implement the focused schedule module**

Use a frozen object and this return contract:

```ts
export interface RaidPowerPolicySchedule {
  readonly runCutoverAt: number;
  readonly v2CutoverAt: number;
  readonly v1: RaidPowerPolicyV1;
  readonly v2: RaidPowerPolicyV2;
}

export function policyForRunStart(
  schedule: RaidPowerPolicySchedule,
  startedAtMs: number,
): RaidPowerPolicy | null {
  if (startedAtMs < schedule.runCutoverAt) return null;
  return startedAtMs < schedule.v2CutoverAt ? schedule.v1 : schedule.v2;
}
```

- [ ] **Step 5: Load and validate both policies in `loadConfig`**

Add defaults for the checked-in v2 path, parse `RAID_POWER_V2_CUTOVER_AT` with the same safe-epoch rules as the original cutoff, and build the schedule during runtime-mode validation. Do not rename or reinterpret `RUN_SCORING_CUTOVER_AT`; it remains the earliest Run accepted by the server.

- [ ] **Step 6: Run focused tests and type checking**

Run: `npm test -- tests/raid-power-policy-schedule.test.ts tests/config.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the schedule and configuration unit**

```bash
git add src/domain/raid-power-policy-schedule.ts tests/raid-power-policy-schedule.test.ts src/config.ts tests/config.test.ts
git commit -m "feat(raiders): select scoring policy by run start"
```

### Task 3: Make Run ingestion preserve v1 and apply v2 atomically

**Files:**
- Modify: `src/domain/run-ingest.ts`
- Modify: `tests/run-ingest.test.ts`
- Modify: `src/web/routes/runs.ts`
- Modify: `tests/web-runs.test.ts`
- Modify: `tests/runtime-raiders-e2e.test.ts`
- Modify: `tests/web-metrics.test.ts`

**Interfaces:**
- Consumes: `RaidPowerPolicySchedule` and `policyForRunStart(...)` from Task 2.
- Changes: `ingestRunEvents(db, device, events, schedule, now): RunIngestResult`; remove the separate `policy` and `cutoverAt` parameters.
- HTTP contract: malformed nested v2 counters return `422 { "reason": "invalid_usage_counters" }`; syntactically malformed payloads remain HTTP 400.

- [ ] **Step 1: Write failing dual-policy ingest tests**

Cover all of these in `tests/run-ingest.test.ts`:

```ts
// Started one millisecond before v2: historical v1 additive award.
expect(row.policy_version).toBe('raid-power-v1');

// Started exactly at v2: nested arithmetic.
expect(row).toMatchObject({
  policy_version: 'raid-power-v2',
  awarded_usage_credit: 3_288,
  usage_input: 74_226,
  usage_cache_read: 71_424,
  usage_output: 486,
  usage_reasoning_output: 284,
});
```

Then prove a late event for a pre-v2 Run stays v1, duplicate events award nothing, a forged same `run_key` crossing the cutoff rolls back, and a batch containing one malformed v2 event leaves `runs`, `run_events`, `token_events`, and player totals unchanged.

- [ ] **Step 2: Write failing route tests for semantic rejection**

POST a validly shaped v2 batch where `cache_read > input`; expect 422 and `invalid_usage_counters`. Repeat with `reasoning_output > output`. Query the in-memory DB to prove neither request persists a Run or event.

- [ ] **Step 3: Run ingest and route tests and verify RED**

Run: `npm test -- tests/run-ingest.test.ts tests/web-runs.test.ts tests/runtime-raiders-e2e.test.ts tests/web-metrics.test.ts`

Expected: FAIL because ingestion still receives one policy and semantic errors currently become HTTP 500.

- [ ] **Step 4: Select the policy inside the transaction**

For each event, call `policyForRunStart(schedule, event.started_at_ms)`. Count a null result as `ignored`. Use `raid-power-v1` or `raid-power-v2` when creating the Run, and keep the existing mismatch exception before claiming/scoring an event against an existing Run. Call `usageCredit` with the selected policy only after the event identity is claimed; transaction rollback must remove that claim on any error.

- [ ] **Step 5: Load one immutable schedule when routes register**

In `registerRunRoutes`, load v1 and v2 from their configured paths, construct the schedule, and pass it to ingestion. Catch only `InvalidNestedUsageError` around `ingestRunEvents` and return the 422 JSON contract; let unexpected errors continue to the private route error handler.

- [ ] **Step 6: Update test configs and run focused tests**

Add `RAID_POWER_POLICY_V2_PATH` and `RAID_POWER_V2_CUTOVER_AT` to each runtime-raiders test environment. Run:

`npm test -- tests/run-ingest.test.ts tests/web-runs.test.ts tests/runtime-raiders-e2e.test.ts tests/web-metrics.test.ts`

Expected: PASS, including the existing retry, disabled-Raider, completion, duration, overflow, and pre-original-cutover tests.

- [ ] **Step 7: Commit the ingestion cutover unit**

```bash
git add src/domain/run-ingest.ts tests/run-ingest.test.ts src/web/routes/runs.ts tests/web-runs.test.ts tests/runtime-raiders-e2e.test.ts tests/web-metrics.test.ts
git commit -m "fix(raiders): apply scoring v2 forward only"
```

### Task 4: Present native usage as parent totals and subsets

**Files:**
- Modify: `src/domain/playerhub.ts`
- Modify: `src/web/views/character-live.ejs`
- Modify: `src/web/public/player-hub.js`
- Modify: `tests/playerhub.test.ts`
- Modify: `tests/web-character.test.ts`
- Modify: `tests/player-hub-client.test.ts`

**Interfaces:**
- Extends `PlayerHubLatestRun.nativeUsage` with `uncachedInput: number | null` and `nestedShapeValid: boolean`.
- Preserves all five raw counters in the JSON response.
- Render contract for valid nested counters: `N total input (C cached, U uncached) · O total output (R reasoning) · W cache writes reported`.

- [ ] **Step 1: Write failing server view-model tests**

For the acceptance fixture, assert:

```ts
nativeUsage: {
  input: 74_226,
  output: 486,
  cacheRead: 71_424,
  cacheWrite: 0,
  reasoningOutput: 284,
  uncachedInput: 2_802,
  nestedShapeValid: true,
}
```

For a retained historical v1 row whose cache read exceeds input, assert `uncachedInput: null` and `nestedShapeValid: false`; the page must not show a negative value or rewrite the raw totals.

- [ ] **Step 2: Write failing initial-HTML and live-client tests**

Assert both EJS and `renderRaiderAndLatestRun()` produce:

```text
74,226 total input (71,424 cached, 2,802 uncached) · 486 total output (284 reasoning) · 0 cache writes reported
```

For invalid historical shape, assert copy containing `cache relationship unavailable` while still showing total input, total output, cache read, cache write, and reasoning values.

- [ ] **Step 3: Run the three focused suites and verify RED**

Run: `npm test -- tests/playerhub.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts`

Expected: FAIL because the containment fields and copy do not exist.

- [ ] **Step 4: Derive presentation-only containment fields**

In `buildPlayerHubState`, set `nestedShapeValid` only when both subset inequalities hold. Set `uncachedInput` to `input - cacheRead` only when valid. This is display derivation, not scoring validation; do not mutate stored counters and do not hide retained v1 history.

- [ ] **Step 5: Update EJS and browser rendering with the same copy**

Keep the already-approved left alignment and row packing. Change only the native usage text in initial HTML and live refresh. Use `Intl.NumberFormat`/`toLocaleString('en-US')` as currently established.

- [ ] **Step 6: Run focused UI suites and the copy checker**

Run: `npm test -- tests/playerhub.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts && npm run check:player-copy`

Expected: PASS.

- [ ] **Step 7: Commit the usage-presentation unit**

```bash
git add src/domain/playerhub.ts src/web/views/character-live.ejs src/web/public/player-hub.js tests/playerhub.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts
git commit -m "fix(player): explain nested native usage"
```

### Task 5: Add a read-only v1-versus-v2 audit command

**Files:**
- Create: `tools/runtime-raiders/audit-scoring-v2.ts`
- Create: `tests/audit-scoring-v2.test.ts`
- Modify: `package.json`

**Interfaces:**
- CLI: `npm run audit:scoring-v2 -- --db /absolute/path/to/claude-rpg.db --v2-cutover <epoch-ms>`.
- Opens SQLite with `{ readonly: true, fileMustExist: true }` and immediately sets `PRAGMA query_only=ON`.
- Emits JSON containing only Run IDs, policy versions, raw numeric counters, stored usage awards, hypothetical v2 usage, validity, and aggregate counts/sums; never names, tokens, device secrets, paths, prompts, responses, model, or effort.

- [ ] **Step 1: Write failing read-only audit tests**

Create a temporary migrated DB with one valid and one invalid nested-counter Run. Assert the valid row reports hypothetical usage, the invalid row reports `invalid_nested_usage`, and aggregate stored rows remain byte-for-byte equal before and after the command. Assert missing/relative DB paths and unsafe cutoffs exit nonzero.

- [ ] **Step 2: Run the audit test and verify RED**

Run: `npm test -- tests/audit-scoring-v2.test.ts`

Expected: FAIL because the audit module and script do not exist.

- [ ] **Step 3: Implement a pure report builder and thin CLI**

Export `buildScoringV2Audit(db, v2CutoverAt)` for direct tests. Query `runs` only, order by `id`, call the Task 1 v2 arithmetic, and aggregate with safe-integer checks. The CLI must reject a non-absolute path before opening SQLite and print exactly one JSON document to stdout.

- [ ] **Step 4: Add the package script and run the focused test**

Add:

```json
"audit:scoring-v2": "tsx tools/runtime-raiders/audit-scoring-v2.ts"
```

Run: `npm test -- tests/audit-scoring-v2.test.ts`

Expected: PASS and no DB file timestamp/content changes.

- [ ] **Step 5: Commit the audit unit**

```bash
git add tools/runtime-raiders/audit-scoring-v2.ts tests/audit-scoring-v2.test.ts package.json
git commit -m "feat(raiders): add read-only scoring v2 audit"
```

### Task 6: Make deployment configuration fail closed for v2

**Files:**
- Modify: `deploy/claude-rpg.env.example`
- Modify: `scripts/pi/validate-runtime-raiders-env.sh`
- Modify: `tests/deploy-runtime-raiders.test.ts`
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md`
- Modify: `docs/BACKLOG.md`

**Interfaces:**
- Requires exact production v2 policy path: `$REPO_DIR/config/raid-power-policy-v2.json`.
- Requires one 13-digit `RAID_POWER_V2_CUTOVER_AT` in runtime-raiders mode.
- Forbids the checked-in placeholder `1800000000000` and any v2 cutoff earlier than `RUN_SCORING_CUTOVER_AT`.

- [ ] **Step 1: Write failing deployment-validator tests**

Extend the accepted env fixture and assert rejection for missing/duplicate v2 keys, wrong policy path, symlink/missing policy, placeholder cutoff, non-13-digit cutoff, and v2 cutoff before the original Run cutoff.

- [ ] **Step 2: Run the validator suite and verify RED**

Run: `npm test -- tests/deploy-runtime-raiders.test.ts`

Expected: FAIL because the validator does not know the v2 keys.

- [ ] **Step 3: Update the example and validator**

Add the v2 path and placeholder cutoff to the disabled-by-default example. In Bash, validate both fields without sourcing the env file, following the existing `required_value` pattern. Keep exact-path and non-symlink checks.

- [ ] **Step 4: Document the separate release gate**

Update the cutover runbook with this order: choose and record the v2 cutoff, run the read-only audit, run all tests/typecheck, prove public `paused:true`, make a timestamped DB backup, install reviewed source, update only the two new env keys, validate the env, restart, and verify `/health` plus the deployed revision. Add an explicit STOP before any collection or canary command. Mark backlog scoring #34 planned/approved, not deployed.

- [ ] **Step 5: Run validator tests, shell syntax checks, and type checking**

Run:

```bash
npm test -- tests/deploy-runtime-raiders.test.ts
/bin/bash -n scripts/pi/validate-runtime-raiders-env.sh
/bin/sh -n scripts/pi/setup.sh
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the fail-closed release documentation**

```bash
git add deploy/claude-rpg.env.example scripts/pi/validate-runtime-raiders-env.sh tests/deploy-runtime-raiders.test.ts docs/RUNTIME_RAIDERS_CUTOVER.md docs/BACKLOG.md
git commit -m "docs(raiders): gate scoring v2 cutover"
```

### Task 7: Full verification and immutable-history proof

**Files:**
- Verify only; do not edit production data, local account state, or collection state.

**Interfaces:**
- Produces a review receipt with commit SHA, test counts, audit summary, and an explicit statement that no deployment or collection activation occurred.

- [ ] **Step 1: Run every server test and type checking**

Run: `npm test && npm run typecheck && npm run check:player-copy`

Expected: all tests pass with zero TypeScript errors and no player-copy drift.

- [ ] **Step 2: Run the audit against a disposable snapshot**

Copying the production DB and choosing the actual cutoff require the later bounded operational authorization. When that authorization exists, run the audit against the explicit snapshot path, never the live DB, and retain its JSON receipt beside the release evidence. The audit itself must not open a network connection.

- [ ] **Step 3: Prove no historical mutation in the implementation checkout**

Run: `git status --short` and inspect the diff/commits. Expected: only source, tests, checked-in config, tools, and docs from this plan; no SQLite, account, enrollment, device, artifact, or `companion/.build/` changes are staged.

- [ ] **Step 4: Stop at the production boundary**

Report the candidate commit and verification evidence. Do not SSH, back up, update the live env, restart the service, publish an agent, enable collection, or create a canary Run without the user's next explicit authorization.

## Acceptance checklist

- [ ] 74,226 input, 71,424 cache read, 486 output, and 284 reasoning yield exactly 3,288 v2 usage credit.
- [ ] Cache writes and reasoning remain visible but are not double-counted.
- [ ] Malformed nested counters reject the entire HTTP batch without persistence.
- [ ] Pre-v2 and already-stored v1 Runs retain v1 policy and awards.
- [ ] The player page states total/subset relationships and preserves raw values.
- [ ] The audit is content-free and demonstrably read-only.
- [ ] Production configuration cannot enter runtime-raiders mode with an absent, placeholder, or inverted v2 cutoff.
- [ ] No account, historical score, collection, companion, or production state changes occur during implementation.

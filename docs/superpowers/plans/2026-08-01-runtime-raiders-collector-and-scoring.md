# Runtime Raiders Collector and Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a passive macOS companion and a provider-neutral server ingestion path that convert safe local Codex, Claude Code, and Omp Run facts into idempotent Raid Power without enabling provider telemetry or disturbing AI work.

**Architecture:** A dependency-free Swift companion observes verified append-only provider records, normalizes only allowlisted facts, and delivers cumulative Run events through a durable outbox. The existing TypeScript server authenticates enrolled devices, computes versioned Raid Power, stores provider-neutral Runs, and projects each positive delta into the existing `token_events`/`effective_tokens` path so combat and progression remain compatible.

**Tech Stack:** Swift 6 / Swift Package Manager (`Foundation`, `CryptoKit`, `CoreServices` only), TypeScript, Express, Zod, SQLite through `better-sqlite3`, Vitest, XCTest, `launchd`, POSIX shell, macOS `codesign`/`notarytool`

## Global Constraints

- Do not enable OTel or any provider analytics and do not change provider configuration.
- Never send prompts, responses, commands, tool arguments/results, files, paths, workspace names, repository data, or shell history.
- The companion is read-only, outside every provider execution path, and must fail without affecting the provider.
- The only supported launch surfaces are Codex Desktop/CLI, Claude Code, and Omp; Composer and Claude desktop/web remain unsupported.
- Model and effort are display-only and must never enter a scoring calculation.
- `raiders off` excludes all activity created during the off interval.
- Distinct concurrent Runs score additively; duplicate observations of the same Run score once.
- Existing progression is preserved; new Raid Power increments `players.effective_tokens` and writes `token_events.effective_delta`, while `players.total_tokens` and `token_events.total_delta` receive no new provider-neutral usage.
- The production scoring mode is mutually exclusive: legacy OTLP or Runtime Raiders, never both.
- No production deployment, push, provider configuration edit, or Pi mutation belongs in this plan.
- The source design is `docs/superpowers/specs/2026-07-31-runtime-raiders-rebrand-and-provider-neutral-scoring-design.md`.

## File map

### Shared contract and server

- `src/domain/run-events.ts`: strict v1 inbound event types and validation.
- `src/domain/raider-enrollment.ts`: one-time enrollment and device authentication.
- `src/domain/raid-power-policy.ts`: immutable policy loader and pure score functions.
- `src/domain/run-ingest.ts`: idempotent Run state transition and compatibility projection.
- `src/domain/runs.ts`: recent/active Run queries for later UI consumers.
- `src/web/routes/runs.ts`: enrollment exchange, Run ingestion, and device heartbeat routes.
- `src/web/run-rate-limit.ts`: bounded per-device/IP ingestion limiter.
- `config/raid-power-policy-v1.json`: generated and reviewed launch policy.
- `tools/runtime-raiders/provider-shape-audit.ts`: structure-only local record examiner.
- `tools/runtime-raiders/calibrate-scoring.ts`: deterministic policy generator from content-free samples.

### macOS companion

- `companion/Package.swift`: dependency-free Swift package and macOS 13 floor.
- `companion/Sources/RuntimeRaidersCore/`: models, record reader, privacy encoder, adapters, state, outbox, uploader, watcher, and controller.
- `companion/Sources/RuntimeRaidersCLI/main.swift`: `raiders` CLI and daemon entry point.
- `companion/Tests/RuntimeRaidersCoreTests/`: unit, privacy, adapter, retry, and control tests.
- `companion/Fixtures/`: synthetic records only; no real office transcript is committed.
- `companion/packaging/`: LaunchAgent template and installer.
- `scripts/release/build-runtime-raiders-agent.sh`: universal, signed release build.

---

### Task 1: Prove the three provider record contracts without collecting content

**Files:**
- Create: `tools/runtime-raiders/provider-shape-audit.ts`
- Create: `tests/provider-shape-audit.test.ts`
- Create: `docs/runtime-raiders/provider-record-evidence.md`
- Create: `companion/Fixtures/{codex,claude,omp}/`

**Interfaces:**
- Produces: `auditJsonlShape(lines: Iterable<string>): Record<string, string[]>`
- Produces: a checked-in evidence matrix fixing the supported provider versions, roots, Run identity, usage fields, lifecycle fields, and unsupported fallbacks.
- Consumes: actual local records only during an explicit controlled canary; it writes keys and types, never values.

- [ ] **Step 1: Write the privacy-first audit test**

```ts
it('reports structure without returning record values', () => {
  const shape = auditJsonlShape([
    JSON.stringify({ type: 'message', cwd: '/DO_NOT_EXPORT', message: { role: 'user', content: 'DO_NOT_EXPORT' } }),
  ]);
  const rendered = JSON.stringify(shape);
  expect(rendered).toContain('message');
  expect(rendered).toContain('content');
  expect(rendered).not.toContain('DO_NOT_EXPORT');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- tests/provider-shape-audit.test.ts`

Expected: FAIL because `auditJsonlShape` does not exist.

- [ ] **Step 3: Implement a keys-and-types-only walker**

The implementation accepts already-read JSONL lines, parses one line at a time,
emits sorted dotted field names with JSON types, and never stores or returns
scalar values. Malformed lines add the literal key `$malformed` only.

```ts
export function auditJsonlShape(lines: Iterable<string>): Record<string, string[]> {
  const shapes = new Map<string, Set<string>>();
  // Walk object keys recursively; record `path:type`; never copy a scalar value.
  return Object.fromEntries([...shapes].map(([k, v]) => [k, [...v].sort()]));
}
```

- [ ] **Step 4: Run one controlled, non-sensitive canary in each tool**

Use a temporary empty directory and the prompt `Reply with the word ready.`.
Record the installed version and run the audit against only the newly written
record. Do not copy the original record into the repository.

Verify these minimum facts:

- Codex: `session_meta`, `turn_context`, `event_msg.task_started`,
  `event_msg.token_count`, and `event_msg.task_complete`; `turn_id` is the Run
  identity and `last_token_usage` is the per-Run cumulative usage.
- Claude Code: a real user entry starts the Run, assistant entries contribute
  `message.usage`, and `system/turn_duration` closes the Run; the top-level user
  UUID/prompt identity is stable across tool churn.
- Omp: `~/.omp/agent/sessions/**/*.jsonl` contains a `session` header and
  append-only `message` entries whose assistant messages include usage and a
  terminal stop reason. Ignore parent `task` tool-result aggregate usage when
  child session files are counted.

For Omp, compare the canary shape to the official `SessionManager` and
`SessionEntry` sources:

- <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-manager.ts>
- <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts>

If any minimum fact is absent, stop this plan and report that launch is blocked.
Do not substitute history databases, shell history, process watching, window
focus, or provider hooks.

- [ ] **Step 5: Hand-author minimal synthetic fixtures**

Each fixture contains only fake IDs/timestamps/counts plus content traps such as
`DO_NOT_EXPORT_PROMPT`, `DO_NOT_EXPORT_PATH`, and `DO_NOT_EXPORT_TOOL_ARGUMENT`.
Include completed, failed/cancelled, partial-line, duplicated, reordered, and
parallel Run cases. Document the exact canary version and fields in
`provider-record-evidence.md`.

- [ ] **Step 6: Verify and commit the evidence gate**

Run: `npm test -- tests/provider-shape-audit.test.ts`

Expected: PASS; `rg -n 'Reply with the word ready' companion/Fixtures docs/runtime-raiders` returns no matches.

```bash
git add tools/runtime-raiders/provider-shape-audit.ts tests/provider-shape-audit.test.ts docs/runtime-raiders/provider-record-evidence.md companion/Fixtures
git commit -m "test(raiders): prove provider record contracts"
```

### Task 2: Define the strict provider-neutral Run event

**Files:**
- Create: `src/domain/run-events.ts`
- Create: `tests/run-events.test.ts`

**Interfaces:**
- Produces: `RunEventV1`, `UsageCountersV1`, `parseRunEventBatch(input, now)`.
- Consumes: no provider-native object; adapters must construct this allowlisted shape.

- [ ] **Step 1: Write schema tests for allowed and forbidden fields**

```ts
const event = {
  schema_version: 1, companion_version: '0.1.0', device_id: crypto.randomUUID(),
  provider: 'codex', surface: 'codex_desktop', run_key: 'a'.repeat(64), sequence: 1,
  event_time_ms: 1_800_000_000_000, observed_at_ms: 1_800_000_000_001,
  started_at_ms: 1_800_000_000_000, state: 'open',
  usage: { input: 10, output: 2, cache_read: 0, cache_write: 0, reasoning_output: 0 },
  model: 'gpt-test', effort: 'high', idempotency_key: 'b'.repeat(64),
};
expect(parseRunEventBatch({ events: [event] }, event.observed_at_ms)).toHaveLength(1);
expect(() => parseRunEventBatch({ events: [{ ...event, prompt: 'DO_NOT_EXPORT' }] }, event.observed_at_ms)).toThrow();
```

- [ ] **Step 2: Verify the test fails**

Run: `npm test -- tests/run-events.test.ts`

Expected: FAIL because the schema module is missing.

- [ ] **Step 3: Implement the strict Zod schema**

Use `.strict()` at the batch, event, and usage levels. Enforce a maximum of 100
events, 64-character lowercase hex keys, safe non-negative counters, the four
states `open|completed|failed|cancelled`, providers `codex|claude|omp`, surfaces
`codex_desktop|codex_cli|claude_code|omp`, nullable model/effort strings of at
most 100 characters, duration of at most seven days, and timestamps within seven
days of server receipt. `sequence` is the provider record's stable ordinal within
the Run, never a local upload or observation counter.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/run-events.test.ts`

Expected: PASS for valid events and rejection of extra/content-bearing fields.

```bash
git add src/domain/run-events.ts tests/run-events.test.ts
git commit -m "feat(raiders): define strict run event contract"
```

### Task 3: Add enrollment, device, Run, and event persistence

**Files:**
- Modify: `src/db/migrations.ts`
- Create: `tests/db-runtime-raiders-migration.test.ts`

**Interfaces:**
- Produces: migration `019_runtime_raiders_runs`.
- Produces tables: `raider_identities`, `raider_enrollments`, `raider_devices`, `runs`, `run_events`.

- [ ] **Step 1: Write the migration test**

Assert all five tables, foreign keys, CHECK constraints, and these identities:

```text
raider_identities: PRIMARY KEY(player_id)
raider_devices: UNIQUE(token_hash)
runs: UNIQUE(player_id, provider, run_key)
run_events: PRIMARY KEY(event_key), UNIQUE(run_id, sequence)
```

Also migrate a legacy database containing a player, `token_events`, inventory,
gold, and cosmetics and assert every value is unchanged.

- [ ] **Step 2: Verify the migration test fails**

Run: `npm test -- tests/db-runtime-raiders-migration.test.ts`

Expected: FAIL because migration 019 and its tables are absent.

- [ ] **Step 3: Add the additive migration**

`runs` stores cumulative counters, terminal state/times, latest model/effort,
policy version, separate awarded usage/completion/duration credits, and total
Raid Power. `run_events` stores every allowlisted fact and awarded delta. All
usage and score columns are non-negative safe integers. No existing table or
column is renamed or rebuilt.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/db-runtime-raiders-migration.test.ts tests/db-*.test.ts`

Expected: PASS with retained legacy state.

```bash
git add src/db/migrations.ts tests/db-runtime-raiders-migration.test.ts
git commit -m "feat(raiders): add run and device persistence"
```

### Task 4: Implement one-time enrollment and device authentication

**Files:**
- Create: `src/domain/raider-enrollment.ts`
- Create: `tests/raider-enrollment.test.ts`

**Interfaces:**
- Produces: `createEnrollment(db, playerId, now): { code: string; expiresAt: number }`.
- Produces: `exchangeEnrollment(db, code, deviceId, companionVersion, now): EnrollmentResult`.
- Produces: `authenticateDevice(db, bearerToken, now): AuthenticatedDevice | null`.

- [ ] **Step 1: Write tests for expiry, one-time use, hashing, and shared dedupe identity**

Create two enrollments for the same Raider and assert their returned device
credentials differ while their returned `dedupeSecret` matches. Assert the raw
enrollment code and device token never appear in the database, an expired or
reused code fails, and a revoked device cannot authenticate.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/raider-enrollment.test.ts`

Expected: FAIL because the enrollment module is absent.

- [ ] **Step 3: Implement the domain module**

Use 32 random bytes for enrollment codes, device tokens, and the per-Raider
dedupe secret. Store SHA-256 hashes of enrollment/device tokens. Enrollment codes
expire after 10 minutes and are consumed in the same transaction that creates
the device. Return the dedupe secret only during successful exchange.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/raider-enrollment.test.ts`

```bash
git add src/domain/raider-enrollment.ts tests/raider-enrollment.test.ts
git commit -m "feat(raiders): add one-time companion enrollment"
```

### Task 5: Generate and load the immutable Raid Power v1 policy

**Files:**
- Create: `src/domain/raid-power-policy.ts`
- Create: `tools/runtime-raiders/calibrate-scoring.ts`
- Create: `tests/raid-power-policy.test.ts`
- Create: `docs/runtime-raiders/scoring-calibration-v1.json`
- Create: `docs/runtime-raiders/scoring-calibration-v1.md`
- Create: `config/raid-power-policy-v1.json`

**Interfaces:**
- Produces: `loadRaidPowerPolicy(path): RaidPowerPolicy`.
- Produces: `usageCredit(policy, provider, cumulative): number`.
- Produces: `durationCredit(policy, durationMs): number`.

- [ ] **Step 1: Write pure scoring tests**

Tests prove cumulative scoring is monotonic, cache-read is excluded, provider
multipliers apply, duration uses a square-root curve with a hard cap, completion
is fixed, and changing model/effort cannot affect any function signature or
result.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/raid-power-policy.test.ts`

- [ ] **Step 3: Implement the policy schema and pure functions**

The versioned file contains non-overlapping category weights (`input`, `output`,
`cache_write`, and `reasoning_output` weight 1; `cache_read` weights 0), one
positive multiplier per provider, a non-negative completion credit, and duration
`scale`/`cap`. Scoring uses cumulative target credit so fractional provider
multipliers cannot drift across event boundaries.

```ts
export function durationCredit(p: RaidPowerPolicy, durationMs: number): number {
  const minutes = Math.max(0, durationMs) / 60_000;
  return Math.min(p.duration.cap, Math.round(p.duration.scale * Math.sqrt(minutes)));
}
```

- [ ] **Step 4: Collect content-free calibration samples**

Run at least three samples per provider for the same four canary workloads:
short explanation, small code edit, medium repository task, and long-running
reverse-engineering analysis. Store only provider, workload key, counters, and
duration—never prompt, response, file, or project metadata.

- [ ] **Step 5: Generate the policy deterministically**

For each workload, compute the median weighted usage per provider and the median
of those provider medians as its target. Each provider multiplier is the median
of `target/providerMedian` across workloads, rounded to six decimals. Let the
overall baseline be the median workload target; generate completion credit as
`max(1, round(baseline * 0.02))`, duration scale as
`completionCredit / sqrt(10)`, and duration cap as `completionCredit * 4`.
The tool writes both JSON policy and a Markdown table of inputs/results.

- [ ] **Step 6: Review the generated policy before continuing**

Confirm no provider's median Raid Power for a matched workload differs from the
cross-provider median by more than 25%. If it does, add more matched samples and
regenerate; never add a model- or effort-specific multiplier. Obtain user
approval of the generated report before treating v1 as launchable.

- [ ] **Step 7: Verify and commit**

Run: `npm test -- tests/raid-power-policy.test.ts`

```bash
git add src/domain/raid-power-policy.ts tools/runtime-raiders/calibrate-scoring.ts tests/raid-power-policy.test.ts docs/runtime-raiders/scoring-calibration-v1.json docs/runtime-raiders/scoring-calibration-v1.md config/raid-power-policy-v1.json
git commit -m "feat(raiders): lock Raid Power policy v1"
```

### Task 6: Apply Run events idempotently and project Raid Power into the game

**Files:**
- Create: `src/domain/run-ingest.ts`
- Create: `tests/run-ingest.test.ts`
- Modify: `src/domain/ingest.ts`

**Interfaces:**
- Produces: `ingestRunEvents(db, device, events, policy, cutoverAt, now): RunIngestResult`.
- Produces: `applyActivityCredit(db, playerId, effectiveDelta, totalDelta, now)` shared by legacy and new ingestion.

- [ ] **Step 1: Write state-machine and compatibility tests**

Cover positive cumulative deltas, duplicate/reordered delivery, counter rollback,
open/stalled usage-only behavior, completed/failed/cancelled states, completion
exactly once, late completion, conflicting terminal states, long duration cap,
parallel Run keys, duplicate surfaces, safe-integer overflow, disabled Raiders,
and a Run started before cutover.

Assert every positive Raid Power delta atomically:

```text
increments players.effective_tokens
updates players.last_token_at
inserts token_events(effective_delta = delta, total_delta = 0)
invokes applyGoldPotionWork with that token_event id
does not change players.total_tokens
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/run-ingest.test.ts`

- [ ] **Step 3: Extract the existing compatibility credit helper**

Move the existing player update, `token_events` insert, and potion attribution
into `applyActivityCredit`. Legacy OTLP passes its existing total/effective
deltas; Runtime Raiders always passes `totalDelta = 0`.

- [ ] **Step 4: Implement the Run transaction**

Authenticate before entry. Claim `event_key`; upsert the unique Run; compute the
target cumulative usage credit and only its positive difference; make the first
terminal state immutable; award completion only for `completed` plus positive
usage; award duration only for completed; persist `run_events`; project the
combined positive delta; then commit. A lower reordered sequence is retained
with zero delta and cannot reduce Run totals.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/run-ingest.test.ts tests/ingest-*.test.ts tests/potion-*.test.ts tests/engine*.test.ts`

```bash
git add src/domain/run-ingest.ts src/domain/ingest.ts tests/run-ingest.test.ts
git commit -m "feat(raiders): score runs through compatibility activity"
```

### Task 7: Expose enrollment and Run ingestion with mutually exclusive scoring modes

**Files:**
- Modify: `src/config.ts`
- Modify: `src/web/app.ts`
- Modify: `src/web/routes/metrics.ts`
- Create: `src/web/routes/runs.ts`
- Create: `src/web/run-rate-limit.ts`
- Create: `tests/web-runs.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/web-metrics.test.ts`

**Interfaces:**
- Produces configuration: `scoringMode: 'legacy-otlp'|'runtime-raiders'|'disabled'`, `runCutoverAt`, `raidPowerPolicyPath`.
- Produces routes: `POST /api/raiders/enrollments`, `POST /api/raiders/enroll`, `POST /api/runs/events`, `POST /api/runs/heartbeat`.

- [ ] **Step 1: Write route and scoring-mode tests**

Assert strict JSON, 256 KiB compressed/body limits, 100 events per request,
Bearer authentication, rate limiting, one-time enrollment, idempotent retry
responses, and no secrets in logs/responses. In `runtime-raiders` mode the old
`/v1/metrics` returns `200 {}` without changing data. In `legacy-otlp` mode the
new event endpoint returns `503 { reason: 'scoring_disabled' }`.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/web-runs.test.ts tests/config.test.ts tests/web-metrics.test.ts`

- [ ] **Step 3: Implement configuration and routes**

`SCORING_MODE` defaults to `legacy-otlp`. Runtime mode requires a valid
`RUN_SCORING_CUTOVER_AT` epoch and a loadable immutable policy at startup.
Register scoped `express.json({ limit: '256kb' })` only on the new JSON routes.
Never register both scoring handlers as active.

Use these exact JSON/auth contracts:

```text
POST /api/raiders/enrollments
  body: { raider_key }
  201:  { install_command, expires_at }

POST /api/raiders/enroll
  body: { code, device_id, companion_version }
  201:  { device_token, dedupe_secret, server_url, cutover_at }

POST /api/runs/events
  Authorization: Bearer <device_token>
  body: { events: RunEventV1[] }
  200:  { accepted, duplicate, ignored }

POST /api/runs/heartbeat
  Authorization: Bearer <device_token>
  body: { companion_version }
  204 with no body
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/web-runs.test.ts tests/config.test.ts tests/web-metrics.test.ts`

```bash
git add src/config.ts src/web/app.ts src/web/routes/metrics.ts src/web/routes/runs.ts src/web/run-rate-limit.ts tests/web-runs.test.ts tests/config.test.ts tests/web-metrics.test.ts
git commit -m "feat(raiders): expose private run ingestion API"
```

### Task 8: Add server Run queries for status and later UI use

**Files:**
- Create: `src/domain/runs.ts`
- Create: `tests/runs.test.ts`

**Interfaces:**
- Produces: `recentRuns(db, playerId, limit): RunSummary[]`.
- Produces: `activeRunCount(db, playerId, now, staleAfterMs): number`.
- Produces: `collectorStatus(db, playerId): { lastSeenAt: number|null; devices: number }`.

- [ ] **Step 1: Write query tests**

Assert newest-first stable ordering, a hard limit of 20, no cross-player data,
stalled derivation after 15 minutes without observation, model/effort preserved
only for display, revoked devices excluded from connected count, and parallel
Runs counted separately.

- [ ] **Step 2: Implement, verify, and commit**

Run: `npm test -- tests/runs.test.ts`

```bash
git add src/domain/runs.ts tests/runs.test.ts
git commit -m "feat(raiders): query recent and active runs"
```

### Task 9: Create the dependency-free Swift companion core

**Files:**
- Create: `companion/Package.swift`
- Create: `companion/Sources/RuntimeRaidersCore/{RunEvent,AgentPaths,AtomicStore,JSONLReader,RunIdentity,PrivacyEncoder}.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/{RunEventTests,AtomicStoreTests,JSONLReaderTests,PrivacyEncoderTests}.swift`

**Interfaces:**
- Produces Swift mirrors of `RunEventV1` and `UsageCountersV1`.
- Produces: `JSONLReader.readAppended(file:cursor:maxBytes:)`.
- Produces: `RunIdentity.key(provider:nativeID:dedupeSecret:)` and `eventKey(runKey:sequence:)`.
- Produces: `PrivacyEncoder.encode(_ event: RunEventV1) throws -> Data`.

- [ ] **Step 1: Add the Swift package and failing tests**

Use `// swift-tools-version: 6.0`, macOS 13, one library target, one executable
target, and XCTest. Tests cover partial lines, file truncation/replacement,
atomic state writes, HMAC stability, distinct Run identities, strict outbound
JSON keys, and `DO_NOT_EXPORT` traps.

- [ ] **Step 2: Verify the tests fail**

Run: `cd companion && swift test`

- [ ] **Step 3: Implement the minimal core**

Use Foundation `FileHandle` for bounded read-only chunks, temp-file + rename for
state, and CryptoKit HMAC-SHA256 for opaque Run/event keys. Never encode a raw
native ID or local path.

- [ ] **Step 4: Verify and commit**

Run: `cd companion && swift test`

```bash
git add companion/Package.swift companion/Sources/RuntimeRaidersCore companion/Tests/RuntimeRaidersCoreTests
git commit -m "feat(agent): add private run event core"
```

### Task 10: Implement and verify each provider adapter

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/{ProviderAdapter,CodexAdapter,ClaudeCodeAdapter,OmpAdapter}.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/{CodexAdapterTests,ClaudeCodeAdapterTests,OmpAdapterTests}.swift`

**Interfaces:**
- Consumes: `ProviderAdapter.consume(line:source:observedAt:) -> [NativeRunObservation]`.
- Produces: normalized cumulative observations with a stable provider-record
  ordinal; the registry assigns only privacy-safe Run/event keys.

- [ ] **Step 1: Write Codex fixture tests**

Group by `turn_id`; start on `task_started`; use `last_token_usage` rather than
thread totals; take model/effort from matching turn context; close on
`task_complete`; distinguish Desktop/CLI from session metadata; ignore every
message/tool field. Test duplicated and reordered token snapshots.

- [ ] **Step 2: Implement Codex and verify**

Run: `cd companion && swift test --filter CodexAdapterTests`

- [ ] **Step 3: Write Claude Code fixture tests**

Start only on a non-meta top-level user entry; group its assistant/tool churn by
the stable top-level prompt identity; sum non-overlapping assistant usage; close
on `system` subtype `turn_duration`; include nested subagent session files as
distinct Runs; ignore message content, cwd, git branch, and tool payloads.

- [ ] **Step 4: Implement Claude Code and verify**

Run: `cd companion && swift test --filter ClaudeCodeAdapterTests`

- [ ] **Step 5: Write Omp fixture tests**

Use the v3 `session` header and user-entry ID as the turn identity. Accumulate
assistant usage until the terminal assistant stop reason. Follow
`thinking_level_change` and `model_change` only for display. Count child session
files as distinct Runs and exclude parent task-result aggregate usage so it
cannot double-count. Reject unknown session versions.

- [ ] **Step 6: Implement Omp and verify**

Run: `cd companion && swift test --filter OmpAdapterTests`

- [ ] **Step 7: Run the privacy corpus and commit**

Run: `cd companion && swift test`

Expected: all fixtures normalize to events containing no `DO_NOT_EXPORT` value.

```bash
git add companion/Sources/RuntimeRaidersCore companion/Tests/RuntimeRaidersCoreTests
git commit -m "feat(agent): observe Codex Claude and Omp runs"
```

### Task 11: Add watching, durable outbox, upload, and control commands

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/{FileWatcher,RunRegistry,Outbox,Uploader,AgentController,ControlSocket}.swift`
- Create: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/{OutboxTests,UploaderTests,AgentControllerTests}.swift`

**Interfaces:**
- Produces commands: `raiders daemon|on|off|status|doctor|uninstall`.
- Produces an owner-only Unix control socket under the Runtime Raiders support directory.
- Consumes the adapter/event interfaces from Tasks 9–10 and `/api/runs/*` from Task 7.

- [ ] **Step 1: Write control and failure tests**

Use temporary provider roots and a fake URL protocol. Assert first install seeds
EOF, `off` stops reads/uploads, `on` advances every existing/new file to EOF
before observing, queued pre-off events survive, server failure backs off,
duplicates remain idempotent, restarts preserve state, and the outbox drops its
oldest record after 50 MiB or seven days.

- [ ] **Step 2: Verify tests fail**

Run: `cd companion && swift test --filter AgentControllerTests`

- [ ] **Step 3: Implement watcher and bounded registry**

Use FSEvents for the three verified record roots. Re-open changed files read-only
and consume no more than 1 MiB per callback. The registry holds at most 256 open
Runs and derives stalled status locally after 15 minutes without awarding score.

- [ ] **Step 4: Implement outbox and uploader**

Persist one atomically written JSON event per outbox file. Upload batches of at
most 100 with a 2-second request timeout and exponential retry from 5 seconds to
5 minutes plus jitter. Only the configured `https://raiders.redlattice.com`
origin is accepted outside tests.

- [ ] **Step 5: Implement commands and diagnostics**

`status` reports enabled/off, daemon state, provider adapter health, queued event
count, last successful upload, and active Run count. `doctor` checks permissions,
record roots, server health, signing, and whether the invoking environment still
sets known Claude OTel variables; it does not read shell history or edit config.

- [ ] **Step 6: Verify and commit**

Run: `cd companion && swift test`

```bash
git add companion/Sources companion/Tests
git commit -m "feat(agent): add safe background delivery and controls"
```

### Task 12: Package a signed one-line installer

**Files:**
- Create: `companion/packaging/com.redlattice.runtime-raiders-agent.plist.template`
- Create: `companion/packaging/install.sh`
- Create: `tests/companion-installer.test.ts`
- Create: `scripts/release/build-runtime-raiders-agent.sh`
- Create: `docs/runtime-raiders/companion-operations.md`

**Interfaces:**
- Produces universal artifact `runtime-raiders-agent`, checksum, and signature.
- Produces one-line install contract: `curl -fsSL https://raiders.redlattice.com/install.sh | sh -s -- --code <one-time-code>`.

- [ ] **Step 1: Write installer tests against a temporary HOME**

Assert no `sudo`, provider directory write, provider config edit, or package
manager call; idempotent reinstall; exact LaunchAgent labels/paths; checksum and
signature failure aborts; a marked PATH line is added only when needed and is
removed without touching neighboring shell content.

- [ ] **Step 2: Implement installer and LaunchAgent**

Install under `~/Library/Application Support/Runtime Raiders`, place a command
link in the first writable existing PATH directory (otherwise create
`~/.local/bin` and add one announced marked line to `~/.zprofile`), install
`~/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist`, exchange the
one-time code, and bootstrap the agent with `launchctl`.

- [ ] **Step 3: Implement the release build**

Build arm64 and x86_64 release binaries, combine with `lipo`, require
`RUNTIME_RAIDERS_CODESIGN_IDENTITY`, run `codesign --verify --strict`, submit
with `xcrun notarytool`, staple, and generate SHA-256. The script exits before
publishing if any credential or verification is absent.

- [ ] **Step 4: Verify and commit**

Run: `bash -n companion/packaging/install.sh scripts/release/build-runtime-raiders-agent.sh`

Run: `npm test -- tests/companion-installer.test.ts`

Run: `cd companion && swift test`

```bash
git add companion/packaging tests/companion-installer.test.ts scripts/release/build-runtime-raiders-agent.sh docs/runtime-raiders/companion-operations.md
git commit -m "feat(agent): package signed companion installer"
```

### Task 13: Complete local integration, privacy, and performance gates

**Files:**
- Create: `tests/runtime-raiders-e2e.test.ts`
- Create: `docs/runtime-raiders/canary-checklist.md`
- Modify: `README.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces a locally verified, undeployed collector/scoring candidate.

- [ ] **Step 1: Add an end-to-end test**

Start the app against a temporary database in Runtime Raiders mode, enroll a
test Raider/device, post synthetic Codex/Claude/Omp events including parallel
and duplicate cases, and assert Runs, event audit, Raid Power, `total_delta=0`,
potions, wake behavior, and recent Run queries.

- [ ] **Step 2: Run all automated checks**

Run: `npm test`

Run: `npm run typecheck`

Run: `cd companion && swift test`

Run: `git diff --check`

Expected: all pass.

- [ ] **Step 3: Perform network and privacy inspection**

Run the companion against a local fake server while all three synthetic fixtures
contain content traps. Capture outbound requests and prove the only destination
is the configured server and no trap value appears. Then deny the server and
confirm all three AI tools continue normally while the outbox banks events.

- [ ] **Step 4: Measure resource budgets**

Over ten minutes, record idle average CPU below 0.25%, active average CPU below
2%, resident memory below 64 MiB, no provider-file writes/locks, outbox at or
below 50 MiB, and upload timeout/retry bounds. A miss blocks release and must be
fixed without weakening provider isolation.

- [ ] **Step 5: Run controlled provider canaries**

On a test Raider, verify short, long, failed/cancelled, parallel, duplicate-
surface, collector restart, server outage, `off`, and `on` behavior for Codex,
Claude Code, and Omp. Record only counts/status/timestamps in the checklist.

- [ ] **Step 6: Commit the verified candidate**

```bash
git add tests/runtime-raiders-e2e.test.ts docs/runtime-raiders/canary-checklist.md README.md
git commit -m "test(raiders): verify private multi-provider scoring"
```

Stop here. Do not push, publish the installer, enable office companions, change
provider configuration, or deploy to the Pi. The product-rebrand plan may begin
after Tasks 1–8 establish the server contract; production remains gated on all
three plans and explicit user approval.

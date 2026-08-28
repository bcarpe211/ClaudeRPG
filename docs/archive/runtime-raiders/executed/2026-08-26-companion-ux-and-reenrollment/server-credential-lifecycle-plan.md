# Runtime Raiders Server Credential Lifecycle Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add atomic device replacement, authenticated configuration recovery, and idempotent current-device revocation without changing any Raider or game history.

**Architecture:** Add one append-only migration for replacement-operation identity. Keep token hashing and enrollment transactions in `raider-enrollment.ts`; routes perform strict schema/rate-limit mapping and add public collector configuration. Normal telemetry authentication continues to accept only active devices, while exact replacement replay and revocation use narrowly scoped credential lookups.

**Tech Stack:** TypeScript, Node.js 20+, Zod, better-sqlite3, Express, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-08-26-runtime-raiders-companion-ux-and-reenrollment-design.md`

## Global Constraints

- Replacement code consumption, old-device revocation, replacement insertion, and operation recording are one SQLite transaction.
- The replacement device token is client-generated; the server stores only its SHA-256 hash and never echoes it.
- A one-time code alone selects the target Raider; browser login cannot retarget a device.
- Exact replay is the only replacement operation allowed to authenticate with the revoked old token.
- Revoked credentials remain invalid for events, heartbeat, configuration recovery, and every different replacement request.
- Configuration recovery returns only the active device ID, dedupe secret, server URL, cutover, and enabled surfaces.
- Current-device revocation is idempotent for the same token hash.
- Do not mutate, merge, delete, transfer, or recompute players, Raiders, Runs, events, presence, scores, levels, gold, rewards, inventory, cosmetics, or beta history.
- Do not deploy, restart production, modify collection state, create a companion artifact, or bump a version.

---

## File map

- `src/db/migrations.ts`: migration `021_raider_device_replacements`.
- `tests/db-runtime-raiders-migration.test.ts`: schema, constraint, upgrade, and history-preservation tests.
- `src/domain/raider-enrollment.ts`: replacement, replay, configuration lookup, and revocation domain functions.
- `tests/raider-enrollment.test.ts`: transaction, credential, replay, and immutability tests.
- `src/web/run-rate-limit.ts`: separate endpoint scopes.
- `src/web/routes/runs.ts`: strict request schemas and three lifecycle routes.
- `tests/web-runs.test.ts`: route, body, auth, rate-limit, response, and redaction tests.
- `docs/runtime-raiders/companion-operations.md`: content-free API/operator behavior.

### Task 1: Add durable replacement-operation identity

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `tests/db-runtime-raiders-migration.test.ts`

**Interfaces:**
- Produces table `raider_device_replacements` keyed by `operation_id` and linking one old device to one replacement device and one consumed enrollment code.
- Preserves every existing table and row; migration 019 is not edited.

- [ ] **Step 1: Write failing migration-shape tests**

Extend `TABLES` and add exact assertions:

```ts
expect(columns(db, 'raider_device_replacements')).toEqual([
  'operation_id',
  'old_device_id',
  'replacement_device_id',
  'code_hash',
  'created_at',
]);
expect(primaryKey(db, 'raider_device_replacements')).toEqual(['operation_id']);
expect(uniqueIndexes(db, 'raider_device_replacements')).toEqual(expect.arrayContaining([
  ['old_device_id'],
  ['replacement_device_id'],
]));
expect(foreignKeys(db, 'raider_device_replacements')).toEqual([
  'code_hash->raider_enrollments.code_hash:CASCADE',
  'old_device_id->raider_devices.device_id:CASCADE',
  'replacement_device_id->raider_devices.device_id:CASCADE',
]);
expect(db.prepare('SELECT id FROM _migrations WHERE id = ?').get(
  '021_raider_device_replacements',
)).toEqual({ id: '021_raider_device_replacements' });
```

Add constraint cases for malformed UUID operation IDs, same old device twice, same replacement twice, missing devices, missing enrollment, non-integer timestamps, and timestamps outside `0...9007199254740991`.

- [ ] **Step 2: Write a failing upgrade-preservation test**

Apply migrations through index 20 to a file-backed database, insert two players, identities, an enrollment, devices, one Run, one Run event, presence, and representative game rows. Serialize all pre-existing tables in stable primary-key order, apply migration 021, and assert every snapshot is byte-identical and the new table is empty.

- [ ] **Step 3: Run migration tests and verify RED**

Run: `npm test -- tests/db-runtime-raiders-migration.test.ts`

Expected: FAIL because migration 021 and the table do not exist.

- [ ] **Step 4: Add migration 021**

Append, without editing older migrations:

```ts
{
  id: '021_raider_device_replacements',
  sql: `
    CREATE TABLE raider_device_replacements (
      operation_id TEXT NOT NULL PRIMARY KEY
        CHECK (
          typeof(operation_id) = 'text'
          AND length(operation_id) = 36
        ),
      old_device_id TEXT NOT NULL UNIQUE
        REFERENCES raider_devices(device_id) ON DELETE CASCADE,
      replacement_device_id TEXT NOT NULL UNIQUE
        REFERENCES raider_devices(device_id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE
        REFERENCES raider_enrollments(code_hash) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
        CHECK (
          typeof(created_at) = 'integer'
          AND created_at BETWEEN 0 AND 9007199254740991
        ),
      CHECK (old_device_id <> replacement_device_id)
    );
  `,
},
```

UUID syntax is also validated before persistence; the SQL length check is defense in depth.

- [ ] **Step 5: Run migration tests and type checking**

Run: `npm test -- tests/db-runtime-raiders-migration.test.ts && npm run typecheck`

Expected: PASS and no existing schema assertion changes beyond adding the new table.

- [ ] **Step 6: Commit the migration unit**

```bash
git add src/db/migrations.ts tests/db-runtime-raiders-migration.test.ts
git commit -m "feat(raiders): persist device replacement identity"
```

### Task 2: Implement atomic replacement and exact replay

**Files:**
- Modify: `src/domain/raider-enrollment.ts`
- Modify: `tests/raider-enrollment.test.ts`

**Interfaces:**
- Consumes: migration 021 from Task 1.
- Produces: `replaceDeviceEnrollment`, `ReplacementRequest`, and `DeviceEnrollmentConfiguration`.
- Preserves: `authenticateDevice` as active-device-only authentication.

- [ ] **Step 1: Write failing same-Raider and different-Raider replacement tests**

Create a second player and use the current `createEnrollment`/`exchangeEnrollment` helpers to obtain an old device. Call:

```ts
const result = replaceDeviceEnrollment(db, {
  bearerToken: old.deviceToken,
  code: targetEnrollment.code,
  operationId: randomUUID(),
  replacementDeviceId: randomUUID(),
  replacementDeviceToken: 'R'.repeat(43),
  companionVersion: '0.4.9',
}, NOW + 10);
```

Assert result is:

```ts
{
  kind: 'created',
  deviceId: replacementDeviceId,
  dedupeSecret: targetDedupeSecret,
}
```

Assert old authentication returns `null`, replacement authentication maps to the code-selected player, the enrollment is consumed once, only token hashes appear in SQLite, and all pre-existing Runs/scores/history snapshots are unchanged. Run the test once targeting the old player and once targeting player 2.

- [ ] **Step 2: Write failing rollback and replay tests**

Cover invalid, expired, consumed, malformed, duplicate-device, and conflicting operation inputs. For each failure, assert old token remains active, target code remains unconsumed where applicable, no replacement row exists, and no new device exists.

Then repeat the exact successful request with the revoked old bearer and assert:

```ts
expect(replay).toEqual({
  kind: 'replayed',
  deviceId: replacementDeviceId,
  dedupeSecret: targetDedupeSecret,
});
```

Change each of operation ID, code, replacement ID, token, and companion version independently and assert `kind: 'conflict'` or `kind: 'unauthorized'` without mutation. Prove the old token still fails `authenticateDevice`.

- [ ] **Step 3: Run domain tests and verify RED**

Run: `npm test -- tests/raider-enrollment.test.ts`

Expected: FAIL because replacement types and function do not exist.

- [ ] **Step 4: Add strict replacement types and validation**

Add:

```ts
export interface ReplacementRequest {
  bearerToken: string;
  code: string;
  operationId: string;
  replacementDeviceId: string;
  replacementDeviceToken: string;
  companionVersion: string;
}

export interface DeviceEnrollmentConfiguration {
  deviceId: string;
  dedupeSecret: string;
}

export type ReplacementResult =
  | ({ kind: 'created' | 'replayed' } & DeviceEnrollmentConfiguration)
  | { kind: 'invalid_enrollment' | 'unauthorized' | 'conflict' };
```

Validate both tokens with `CREDENTIAL_PATTERN`, both UUIDs with `deviceIdSchema`, companion version with `validBoundedText`, and `now` with `requireTimestamp` before opening the transaction.

- [ ] **Step 5: Implement the one-transaction state change**

Use `sha256` for bearer, code, and replacement token. In the transaction:

```ts
const old = db.prepare(`
  SELECT device_id, revoked_at
  FROM raider_devices
  WHERE token_hash = ?
`).get(oldTokenHash);
```

If `revoked_at` is non-null, join `raider_device_replacements`, `raider_devices AS replacement`, `raider_enrollments`, and `raider_identities`; return `replayed` only when every request field hash/value matches. Otherwise return `conflict` for the recorded operation and `unauthorized` for unrelated revoked credentials.

For an active old device: select the unconsumed/unexpired code and target dedupe secret; consume it with a guarded update; insert the replacement device using the client token hash; set the old device's `revoked_at` with `WHERE revoked_at IS NULL`; insert the operation record; return `created`. Any guarded row count other than one throws inside the transaction so SQLite rolls back every preceding write.

- [ ] **Step 6: Run domain, migration, and type checks**

Run: `npm test -- tests/raider-enrollment.test.ts tests/db-runtime-raiders-migration.test.ts && npm run typecheck`

Expected: PASS; exact replay is read-only and old telemetry authentication remains rejected.

- [ ] **Step 7: Commit atomic replacement**

```bash
git add src/domain/raider-enrollment.ts tests/raider-enrollment.test.ts
git commit -m "feat(raiders): replace device enrollment atomically"
```

### Task 3: Add active configuration lookup and idempotent revocation

**Files:**
- Modify: `src/domain/raider-enrollment.ts`
- Modify: `tests/raider-enrollment.test.ts`

**Interfaces:**
- Produces: `getDeviceEnrollmentConfiguration` and `revokeDeviceCredential`.
- Preserves: no contact timestamp mutation from either function.

- [ ] **Step 1: Write failing configuration and revocation tests**

Assert:

```ts
expect(getDeviceEnrollmentConfiguration(db, activeToken, NOW)).toEqual({
  deviceId,
  dedupeSecret,
});
expect(getDeviceEnrollmentConfiguration(db, revokedToken, NOW)).toBeNull();
expect(revokeDeviceCredential(db, activeToken, NOW + 1)).toBe('revoked');
expect(revokeDeviceCredential(db, activeToken, NOW + 2)).toBe('already_revoked');
expect(revokeDeviceCredential(db, malformedToken, NOW + 3)).toBeNull();
```

Assert `last_seen_at` remains unchanged, revocation time is not overwritten by a retry, and the revoked token fails event authentication/configuration lookup.

- [ ] **Step 2: Run domain tests and verify RED**

Run: `npm test -- tests/raider-enrollment.test.ts`

Expected: FAIL because both functions do not exist.

- [ ] **Step 3: Implement read-only configuration and monotonic revocation**

Use these signatures:

```ts
export function getDeviceEnrollmentConfiguration(
  db: Database.Database,
  bearerToken: string,
  now: number,
): DeviceEnrollmentConfiguration | null

export function revokeDeviceCredential(
  db: Database.Database,
  bearerToken: string,
  now: number,
): 'revoked' | 'already_revoked' | null
```

Configuration joins active `raider_devices` to `raider_identities` by player ID. Revocation selects by token hash regardless of current `revoked_at`, returns `already_revoked` without an update, otherwise uses `UPDATE ... WHERE revoked_at IS NULL` and requires one changed row.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- tests/raider-enrollment.test.ts && npm run typecheck`

```bash
git add src/domain/raider-enrollment.ts tests/raider-enrollment.test.ts
git commit -m "feat(raiders): recover and revoke device credentials"
```

### Task 4: Expose strict, rate-limited lifecycle routes

**Files:**
- Modify: `src/web/run-rate-limit.ts`
- Modify: `src/web/routes/runs.ts`
- Modify: `tests/web-runs.test.ts`

**Interfaces:**
- Consumes: domain functions from Tasks 2-3 and runtime configuration already loaded by `registerRunRoutes`.
- Produces: `POST /api/raiders/re-enroll`, `GET /api/raiders/enrollment-config`, and `POST /api/raiders/devices/revoke-current`.

- [ ] **Step 1: Write failing successful-route tests**

Enroll an old device, create a target code, and post the exact replacement body. Assert HTTP 201 and:

```ts
expect(response.body).toEqual({
  device_id: replacementDeviceId,
  dedupe_secret: targetDedupeSecret,
  server_url: 'https://raiders.test',
  cutover_at: CUTOVER,
  enabled_surfaces: ['codex_desktop', 'codex_cli'],
});
expect(response.text).not.toContain(oldToken);
expect(response.text).not.toContain(replacementToken);
expect(response.text).not.toContain(code);
```

Exact replay returns HTTP 200 and the same body. GET configuration with the replacement token returns HTTP 200 and the same configuration. POST revocation returns `{ revoked: true }` on first call and retry; GET configuration and `/runs/events` return 401 afterward.

- [ ] **Step 2: Write failing schema, redaction, and rate-limit tests**

Reject extra keys, missing keys, malformed UUIDs/tokens, empty/101-byte version, wrong content type, unsupported encoding, oversized/chunked bodies, absent/malformed bearer, expired/consumed code, conflicting replay, and a token for an unrelated revoked device. Assert responses never echo submitted credentials and `console.error` is not called with them.

Add rate-limit scopes:

```ts
| 'unauthenticated-re-enroll'
| 'device-re-enroll'
| 'unauthenticated-config'
| 'device-config'
| 'unauthenticated-revoke'
| 'device-revoke'
```

Assert per-IP limiting occurs before JSON/credential work and authenticated-device limiting is isolated by device ID.

- [ ] **Step 3: Run route tests and verify RED**

Run: `npm test -- tests/web-runs.test.ts`

Expected: FAIL because the three endpoints and rate-limit scopes do not exist.

- [ ] **Step 4: Add strict schemas and route mapping**

Add the exact strict Zod schema:

```ts
const reEnrollmentBody = z.object({
  code: z.string().regex(CREDENTIAL_PATTERN),
  operation_id: z.string().uuid(),
  replacement_device_id: z.string().uuid(),
  replacement_device_token: z.string().regex(CREDENTIAL_PATTERN),
  companion_version: z.string().min(1).max(100),
}).strict();
```

Use `limitClientIp` before `parseJson` for POST routes. For replacement, pass the raw bearer into the domain function because exact replay intentionally has a narrower rule than `authenticateDevice`. Apply the device scope using the returned/current device ID after successful credential lookup. Map results exactly:

```text
created -> 201 configuration
replayed -> 200 configuration
invalid_enrollment -> 401 {"reason":"invalid_enrollment"}
unauthorized -> 401 {"reason":"unauthorized"}
conflict -> 409 {"reason":"replacement_conflict"}
```

GET configuration accepts no body and active bearer only. Revocation uses
`...parseJson` with `z.object({}).strict()`, so the client must send exactly an
empty JSON object with `Content-Type: application/json`. Return HTTP 200
`{ "revoked": true }` for both `revoked` and `already_revoked`.

- [ ] **Step 5: Run route/domain/type tests**

Run: `npm test -- tests/web-runs.test.ts tests/raider-enrollment.test.ts tests/db-runtime-raiders-migration.test.ts && npm run typecheck`

Expected: PASS with existing enrollment/event routes unchanged.

- [ ] **Step 6: Commit lifecycle routes**

```bash
git add src/web/run-rate-limit.ts src/web/routes/runs.ts tests/web-runs.test.ts
git commit -m "feat(raiders): expose device lifecycle endpoints"
```

### Task 5: Prove history immutability and document the server boundary

**Files:**
- Modify: `tests/runtime-raiders-e2e.test.ts`
- Modify: `docs/runtime-raiders/companion-operations.md`
- Modify: `docs/BACKLOG.md`

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: end-to-end proof that credential lifecycle and game lifecycle are independent.

- [ ] **Step 1: Add an end-to-end history-preservation test**

Create two Raiders with distinct history: Runs, run events, scores, inventory/rewards, and player totals. Replace Raider A's device onto Raider B, recover configuration, and revoke the replacement. Before and after, snapshot every account/game table except enrollment/device/replacement tables using stable order. Assert byte-identical snapshots. Assert old queued work is not present in the server request and no Run ownership changes.

- [ ] **Step 2: Run the E2E test and verify GREEN**

Run: `npm test -- tests/runtime-raiders-e2e.test.ts tests/web-runs.test.ts tests/raider-enrollment.test.ts`

Expected: PASS. A failure is a domain-boundary defect, not a fixture to loosen.

- [ ] **Step 3: Document endpoints without secrets**

Document request purpose, response categories, retry/recovery order, rate limits, and the invariant that no account/history row changes. Do not include real-looking tokens, Raider keys, production database commands, or a manual mutation runbook.

Mark only the server lifecycle subtasks of backlog item 33 complete; local re-enrollment/removal remain open until their plan passes.

- [ ] **Step 4: Run full server verification**

Run: `npm run typecheck`

Run: `npm test`

Expected: all baseline 149 test files plus new coverage pass.

Run: `git diff --name-only HEAD~5..HEAD | rg '(^dist/|companion/packaging/.*version|Info.plist)'`

Expected: no release artifact or version change.

- [ ] **Step 5: Commit the server checkpoint**

```bash
git add tests/runtime-raiders-e2e.test.ts docs/runtime-raiders/companion-operations.md docs/BACKLOG.md
git commit -m "test(raiders): prove credential lifecycle preserves history"
```

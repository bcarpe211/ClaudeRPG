# Runtime Raiders Stable Launchd Reload Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the one-time sequence-8 migrator finish with launchd actually registered to the stable launcher, not merely with a stable plist on disk.

**Architecture:** Extend the installer test's fake launchd boundary so each bootstrap captures the plist's effective `ProgramArguments`. Then, after the migration commit and stable-plist durability point, replace the temporary prepared registration with the stable job while the prepared lease remains held, re-attest prepared health and protected state, and only then resume. Existing `committed-pending-resume` recovery remains the sole post-commit recovery mechanism.

**Tech Stack:** Bash migration transaction, TypeScript/Vitest process-boundary tests, macOS `launchctl` semantics, existing Runtime Raiders Gate 1.

## Global Constraints

- Keep accepted sequence-12 source and artifacts at `188b8936bbaa6fb60f1787e0cffe380b8bb35253` immutable.
- Work only on `codex/fix-migrator-stable-launchd-reload` in the isolated worktree.
- Do not change general path, ownership, symlink, application-mode, signing, or release-identity validation.
- Do not change the public updater, stable launcher, collector, server, Caddy, release metadata, or public installer.
- Do not sign, notarize, publish, deploy, modify the Pi, install or migrate a companion, enable collection, or activate the office.
- Tests must use fake launchd and fake network boundaries; they must never touch the installed canary.
- Preserve enrollment, collector-state, queued-event bytes, enabled/disabled intent, and diagnostic evidence exactly.
- Start every behavior change with a test that fails for the observed stale-registration reason.
- Finish with no Swift scratch, dependency link, release artifact, or other test residue in the worktree.

---

### Task 1: Model the loaded launchd registration and close the success-path defect

**Files:**
- Modify: `tests/companion-installer.test.ts:400-440`
- Modify: `tests/companion-installer.test.ts:805-910`
- Modify: `tests/companion-installer.test.ts:1010-1050`
- Modify: `companion/legacy-sequence8/migrate.sh:1200-1220`

**Interfaces:**
- Consumes: the existing fake launchctl files `.runtime-raiders-test-job`, `.runtime-raiders-test-running`, and the actual plist path passed as argument 3 to `launchctl bootstrap`.
- Produces: `.runtime-raiders-test-loaded-job`, a test-only JSON array containing the exact `ProgramArguments` captured at the latest successful or start-then-fail bootstrap.
- Produces: a successful migration whose loaded registration is `[stableLauncherExecutable, "daemon"]` before candidate resume.

- [ ] **Step 1: Add loaded-job capture to the fake launchctl boundary**

Add a test-only loaded-record path beside the existing fake job state:

```ts
'loaded="$HOME/.runtime-raiders-test-loaded-job"',
```

For a normal bootstrap, capture the effective plist arguments before marking the job running:

```ts
'  /usr/bin/plutil -extract ProgramArguments json -o - "$3" > "$loaded" || exit 64',
'  : > "$job"; : > "$running"; rm -f "$polls"',
```

Every bootout that actually stops the fake job must also remove `"$loaded"`. The existing `FAKE_BOOTOUT_STOPS_THEN_FAIL` branch must remove it because that branch models a mutation followed by an error. The existing `FAKE_BOOTSTRAP_STARTS_THEN_FAIL` branch must capture `ProgramArguments` before returning its injected error because that branch models a registered job despite the nonzero result.

Initialize the sequence-8 fixture's loaded record from its real legacy plist:

```ts
writeFileSync(
  join(home, '.runtime-raiders-test-loaded-job'),
  JSON.stringify([executablePath, 'daemon']) + '\n',
);
```

- [ ] **Step 2: Write the failing successful-migration assertion**

Add this helper near `releaseStatePath()`:

```ts
function loadedLaunchdArguments(home: string): string[] {
  return JSON.parse(readFileSync(join(home, '.runtime-raiders-test-loaded-job'), 'utf8'));
}
```

In `sequence eight migration preserves legacy bytes and intent enabled=%s`, assert the registration, not only the plist:

```ts
expect(loadedLaunchdArguments(fixture.home)).toEqual([
  join(
    fixture.support,
    'launcher/Runtime Raiders Launcher.app/Contents/MacOS/runtime-raiders-launcher',
  ),
  'daemon',
]);
```

Keep the existing enrollment, collector-state, evidence, command-link, release-state, plist, shim, and intent assertions unchanged.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx --no-install vitest run --no-file-parallelism \
  tests/companion-installer.test.ts \
  -t 'sequence eight migration preserves legacy bytes and intent'
```

Expected: both parameterized cases fail because the loaded JSON still points directly to the sequence-9 test candidate and includes `__runtime-raiders-installer-migration-generation`, while the plist assertion continues to pass.

- [ ] **Step 4: Reload and re-attest the stable job before resume**

Immediately after `install_launchd_plist stable` and `durable_checkpoint stable-plist`, add the minimal committed-only reload:

```bash
  launchctl bootout "gui/$(id -u)/$LABEL"
  job_absent || {
    echo "Runtime Raiders could not prove the migration job stopped" >&2
    exit 1
  }
  durable_checkpoint stable-job-stopped
  failure_checkpoint stable-job-stopped
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  durable_checkpoint stable-job-bootstrapped
  failure_checkpoint stable-job-bootstrapped
  wait_for_candidate_status candidate-prepared "$prior_intent" "$prior_queued_event_count" || {
    echo "Runtime Raiders stable job did not reach prepared health" >&2
    exit 1
  }
  assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
    echo "Runtime Raiders protected local state changed during stable job reload" >&2
    exit 1
  }
  durable_checkpoint stable-job-prepared
  failure_checkpoint stable-job-prepared
```

Keep the lease open. Do not create a new journal phase. The next existing command remains `__runtime-raiders-installer-resume 1`.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Step 3 command again.

Expected: two passed cases; final loaded arguments are the stable launcher plus `daemon`, and all pre-existing byte-preservation assertions remain green.

- [ ] **Step 6: Commit the success-path repair**

```bash
git add tests/companion-installer.test.ts companion/legacy-sequence8/migrate.sh
git commit -m "fix: reload stable launchd job after migration"
```

---

### Task 2: Prove post-commit failures remain recoverable

**Files:**
- Modify: `tests/companion-installer.test.ts:400-515`
- Modify: `tests/companion-installer.test.ts:1140-1360`

**Interfaces:**
- Consumes: `stable-job-stopped`, `stable-job-bootstrapped`, and `stable-job-prepared` test checkpoints from Task 1.
- Produces: `FAKE_POSTCOMMIT_BOOTOUT_STOPS_THEN_FAIL` and `FAKE_POSTCOMMIT_BOOTSTRAP_STARTS_THEN_FAIL`, scoped only to launchctl operations after committed release state exists.
- Produces: retry tests proving convergence to the committed candidate with stable loaded arguments and no legacy resume.

- [ ] **Step 1: Add post-commit-specific launchctl fault controls**

Add defaults to `env()`:

```ts
FAKE_POSTCOMMIT_BOOTOUT_STOPS_THEN_FAIL: '0',
FAKE_POSTCOMMIT_BOOTSTRAP_STARTS_THEN_FAIL: '0',
```

In the fake launchctl script, define:

```ts
'release_state="$HOME/Library/Application Support/Runtime Raiders/installation/release-state.json"',
```

Before the general bootout handling, model an ambiguous post-commit stop:

```ts
'if [ "$1" = bootout ] && [ "$FAKE_POSTCOMMIT_BOOTOUT_STOPS_THEN_FAIL" = 1 ] && [ -f "$release_state" ]; then rm -f "$job" "$running" "$polls" "$loaded"; printf "postcommit bootout stopped then failed\n" >&2; exit 77; fi',
```

Before the general bootstrap handling, model a post-commit registration followed by an error:

```ts
'if [ "$1" = bootstrap ] && [ "$FAKE_POSTCOMMIT_BOOTSTRAP_STARTS_THEN_FAIL" = 1 ] && [ -f "$release_state" ]; then /usr/bin/plutil -extract ProgramArguments json -o - "$3" > "$loaded" || exit 64; : > "$job"; : > "$running"; printf "postcommit bootstrap started then failed\n" >&2; exit 77; fi',
```

- [ ] **Step 2: Write failing post-commit recovery tests**

Add a table-driven test with the two environment keys:

```ts
it.each([
  ['bootout stops then fails', 'FAKE_POSTCOMMIT_BOOTOUT_STOPS_THEN_FAIL'],
  ['bootstrap starts then fails', 'FAKE_POSTCOMMIT_BOOTSTRAP_STARTS_THEN_FAIL'],
] as const)('recovers a committed migration when stable-job %s', (_, key) => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-stable-reload-failure-'));
  try {
    const fixture = legacySequenceEightFixture(root, true, 3);
    const enrollmentBefore = readFileSync(fixture.enrollment);
    const collectorBefore = readFileSync(fixture.collectorState);
    const outboxBefore = buildCacheIdentity(join(fixture.support, 'outbox'));
    const failed = invoke(renderedProtocolTwoInstaller(root), [], {
      ...fixture.environment,
      [key]: '1',
    });
    expect(failed.status).not.toBe(0);
    expect(JSON.parse(readFileSync(releaseStatePath(fixture.support), 'utf8')).active.release_sequence)
      .toBe(9);
    expect(readFileSync(join(fixture.home, 'binary.log'), 'utf8'))
      .not.toContain('__runtime-raiders-legacy-resume');

    const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
    expect(retry.status, retry.stderr + retry.stdout).toBe(0);
    expect(loadedLaunchdArguments(fixture.home)).toEqual([
      join(
        fixture.support,
        'launcher/Runtime Raiders Launcher.app/Contents/MacOS/runtime-raiders-launcher',
      ),
      'daemon',
    ]);
    expect(readFileSync(fixture.enrollment)).toEqual(enrollmentBefore);
    expect(readFileSync(fixture.collectorState)).toEqual(collectorBefore);
    expect(buildCacheIdentity(join(fixture.support, 'outbox'))).toEqual(outboxBefore);
    expect(readFileSync(join(fixture.home, 'commands.log'), 'utf8'))
      .not.toContain('endpoint /api/');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
```

- [ ] **Step 3: Verify RED for the fault-specific tests**

Run:

```bash
npx --no-install vitest run --no-file-parallelism \
  tests/companion-installer.test.ts \
  -t 'recovers a committed migration when stable-job'
```

Expected before the fake boundary understands the new controls: the first invocation unexpectedly succeeds, so `expect(failed.status).not.toBe(0)` fails.

- [ ] **Step 4: Implement only the fake post-commit fault behavior**

Add the Step 1 fake launchctl branches and environment defaults. Do not change production code in this step; Task 1's production reload already provides the recovery boundary being exercised.

- [ ] **Step 5: Extend SIGKILL coverage over every new durable boundary**

Add these strings to both post-commit SIGKILL boundary matrices:

```ts
'stable-job-stopped',
'stable-job-bootstrapped',
'stable-job-prepared',
```

For every retry, retain the existing protected-state and no-legacy-resume assertions and add the same stable loaded-arguments assertion used in Task 1.

- [ ] **Step 6: Run focused recovery coverage and verify GREEN**

Run:

```bash
npx --no-install vitest run --no-file-parallelism \
  tests/companion-installer.test.ts \
  -t 'stable-job|re-enters safely after SIGKILL|recovers and retries after actual SIGKILL'
```

Expected: all selected tests pass; every completed retry ends with stable loaded arguments, preserved state, and no upload endpoint use.

- [ ] **Step 7: Commit the recovery matrix**

```bash
git add tests/companion-installer.test.ts
git commit -m "test: cover stable launchd migration recovery"
```

---

### Task 3: Run bounded and broad verification

**Files:**
- Verify: `companion/legacy-sequence8/migrate.sh`
- Verify: `tests/companion-installer.test.ts`
- Verify: repository status and generated-residue boundaries

**Interfaces:**
- Consumes: the complete Task 1 and Task 2 behavior.
- Produces: fresh focused, full-installer, and Gate-1 evidence suitable for review before merge or release work.

- [ ] **Step 1: Check shell syntax and focused success/recovery behavior**

```bash
/bin/bash -n companion/legacy-sequence8/migrate.sh
npx --no-install vitest run --no-file-parallelism \
  tests/companion-installer.test.ts \
  -t 'sequence eight migration preserves legacy bytes and intent|stable-job'
```

Expected: Bash syntax exit 0 and every selected Vitest case passes.

- [ ] **Step 2: Run the complete installer suite**

```bash
npx --no-install vitest run --no-file-parallelism tests/companion-installer.test.ts
```

Expected: zero failed tests and no timeout or network-boundary output.

- [ ] **Step 3: Run Runtime Raiders Gate 1**

```bash
/bin/bash scripts/test/runtime-raiders-lifecycle.sh
```

Expected: Swift tests and scoped Vitest tests pass; fake boundary commands prevent network, real launchd, SSH, or Pi access.

- [ ] **Step 4: Audit scope and residue**

```bash
git diff --check
git status --short
git diff 188b8936bbaa6fb60f1787e0cffe380b8bb35253...HEAD -- \
  companion/legacy-sequence8/migrate.sh \
  tests/companion-installer.test.ts \
  docs/superpowers/specs/2026-08-15-runtime-raiders-stable-launchd-reload-design.md \
  docs/superpowers/plans/2026-08-15-runtime-raiders-stable-launchd-reload.md
find companion -maxdepth 1 -name '.build' -print
find . -maxdepth 1 -type l -print
```

Expected: no whitespace errors, no unexpected tracked files, no `companion/.build`, and no dependency or test-asset symlink. The complete branch diff is limited to the approved spec, plan, migrator, and installer tests.

- [ ] **Step 5: Record final verification without release action**

If the plan document is still uncommitted, commit it alone:

```bash
git add docs/superpowers/plans/2026-08-15-runtime-raiders-stable-launchd-reload.md
git commit -m "docs: plan stable launchd migration repair"
```

Report exact test counts and commit SHAs. Stop before merge, push, Gate 2, signing, notarization, artifact generation, publication, deployment, canary changes, collection, or office activation.

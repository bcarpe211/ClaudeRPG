# Runtime Raiders Fast Canary Loop Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch and correct already-disabled installer state rewrites locally, then expose the complete isolated installer check through one command.

**Architecture:** Extend the existing Vitest installer integration harness with the exact failed sequence-4 topology: a live prior daemon, valid nonempty disabled state, and an existing enrollment. Change only the installer quiescence branch so an exact live-disabled status skips destructive `off`, while enabled and recovery paths keep their current behavior; then make the full installer suite available as one package script.

**Tech Stack:** POSIX shell, Node.js 20, TypeScript, Vitest, Git

## Global Constraints

- Do not change `companion/RELEASE` or create, sign, notarize, publish, install, or activate a release.
- Do not access the Pi, Caddy, public artifacts, provider records, real enrollment, or the installed companion.
- Do not invoke `raiders update`, `raiders on`, launchd, or any collection path.
- Keep all integration effects inside temporary fixture directories with fake network, launchd, signing, and application binaries.
- Preserve valid collector state byte-for-byte when a live prior daemon already reports `enabled:false` and `persistedState:"disabled"`.
- Preserve current enabled-daemon, fresh-install, missing-state, invalid-state, failure, and rollback behavior.
- Use test-first development and observe the new regression failing for the expected reason before changing `install.sh`.

---

## File and responsibility map

| File | Responsibility |
| --- | --- |
| `tests/companion-installer.test.ts` | Reproduce the live already-disabled upgrade and assert byte preservation, privacy, and no destructive `off` |
| `companion/packaging/install.sh` | Classify one prior status response and skip `off` only for the exact live-disabled state |
| `package.json` | Expose the isolated installer syntax and integration suite as `npm run canary:upgrade-test` |

### Task 1: Preserve an already-disabled live collector

**Files:**
- Modify: `tests/companion-installer.test.ts:429-498`
- Modify: `companion/packaging/install.sh:410-445`

**Interfaces:**
- Consumes: the existing rendered-installer fixture, stateful fake application, fake launchd job, and owner-only enrollment fixture.
- Produces: an installer branch that invokes `off` only for a live prior daemon that is not already exactly disabled.

- [ ] **Step 1: Add the failing integration test**

Insert this test after the existing enabled-collector upgrade test:

```ts
it('preserves a live already-disabled collector byte-for-byte without invoking off', () => {
  // Catches quiescence that destructively turns off an already-disabled installation.
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-disabled-upgrade-'));
  try {
    const home = join(root, 'home');
    const commandDir = join(home, 'bin');
    mkdirSync(commandDir, { recursive: true });
    const base = env(home, fakes(root), artifact(root, 'installed', true), commandDir);
    expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
    const state = join(
      home,
      'Library/Application Support/Runtime Raiders/state/collector-state.json',
    );
    const preserved = '{"enabled":false,"files":{"synthetic.jsonl":{"adapterSnapshots":{"codex_cli":"Y2xp","codex_desktop":"ZGVza3RvcA=="},"cursor":{"offset":17,"partialLine":""},"nextOrdinal":4,"seeding":true}},"version":1}\n';
    writeFileSync(state, preserved);
    writeFileSync(join(home, 'commands.log'), '');
    writeFileSync(join(home, 'binary.log'), '');
    const replacement = artifact(root, 'replacement', true);

    const result = invoke(renderedInstaller(root), installerArgs(root), {
      ...base,
      ...env(home, join(root, 'fakes'), replacement, commandDir),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(state, 'utf8')).toBe(preserved);
    const binaryLog = readFileSync(join(home, 'binary.log'), 'utf8');
    expect(binaryLog).toContain('installed:status\n');
    expect(binaryLog).not.toContain('installed:off\n');
    const commands = readFileSync(join(home, 'commands.log'), 'utf8');
    expect(commands).not.toContain('/api/raiders/enroll');
    expect(commands).not.toContain('endpoint /api/runs/events');
    expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
npx vitest run tests/companion-installer.test.ts -t 'preserves a live already-disabled collector byte-for-byte without invoking off'
```

Expected: FAIL because the current installer invokes the prior binary's `off` command and rewrites `collector-state.json` to the fresh disabled object.

- [ ] **Step 3: Implement the minimal status branch**

Replace the unconditional live-daemon `off` block with one status read and an exact case split:

```sh
prior_live_disabled=0
if status_from "$CONTROL_EXECUTABLE"; then
  case "$status_output" in
    *'"daemonRunning":true'*'"enabled":false'*'"persistedState":"disabled"'*)
      prior_live_disabled=1
      ;;
    *'"daemonRunning":true'*)
      "$CONTROL_EXECUTABLE" off >/dev/null 2>&1 || true
      ;;
  esac
fi
```

After stopped-state proof, prevent recovery normalization from changing a state that the prior live daemon had already validated as disabled:

```sh
if ! status_is_offline_disabled "$CANDIDATE_EXECUTABLE"; then
  [ "$prior_live_disabled" -eq 0 ] || {
    echo "Runtime Raiders could not preserve the existing disabled collector state" >&2
    exit 1
  }
  persist_fresh_off_state
fi
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command again.

Expected: PASS; the state bytes match exactly and the prior binary log contains no `off` command.

- [ ] **Step 5: Run the complete installer integration file**

Run:

```sh
npx vitest run tests/companion-installer.test.ts
```

Expected: PASS with the enabled upgrade still invoking `off`, recovery tests still normalizing only missing/invalid state, and every failure/rollback test remaining green.

### Task 2: Add the one-command fast lane

**Files:**
- Modify: `package.json:6-13`

**Interfaces:**
- Consumes: `companion/packaging/install.sh` and `tests/companion-installer.test.ts`.
- Produces: package script `canary:upgrade-test` with no external or persistent side effects.

- [ ] **Step 1: Verify the command is absent**

Run:

```sh
npm run canary:upgrade-test
```

Expected: nonzero exit with npm's missing-script message.

- [ ] **Step 2: Add the package script**

Add this entry to `scripts`:

```json
"canary:upgrade-test": "sh -n companion/packaging/install.sh && vitest run tests/companion-installer.test.ts"
```

- [ ] **Step 3: Run the new command**

Run:

```sh
npm run canary:upgrade-test
```

Expected: shell syntax validation and the complete isolated installer integration file both pass.

### Task 3: Verify and record the implementation

**Files:**
- Verify: `companion/packaging/install.sh`
- Verify: `tests/companion-installer.test.ts`
- Verify: `package.json`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: one reviewable implementation commit with no release or operational changes.

- [ ] **Step 1: Run the full repository suite**

Run:

```sh
npm test
```

Expected: every Vitest file and test passes.

- [ ] **Step 2: Run TypeScript validation**

Run:

```sh
npm run typecheck
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Inspect scope and formatting**

Run:

```sh
git diff --check
git status --short
git diff -- companion/packaging/install.sh tests/companion-installer.test.ts package.json
```

Expected: no whitespace errors; implementation changes are limited to the installer branch, one regression test, and one package script. `companion/RELEASE`, Pi, Caddy, public artifacts, and installed state are unchanged.

- [ ] **Step 4: Commit the implementation**

```sh
git add companion/packaging/install.sh tests/companion-installer.test.ts package.json
git commit -m "fix: preserve disabled canary state during install"
```

# Runtime Raiders Stable Cutover Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two unstable human-copied systemd cutover assertions with release-pinned, regression-tested executable guards and produce a new reviewed Runtime Raiders release SHA.

**Architecture:** Extend `runtime-raiders-cutover-guards.sh` with one ERR-safe systemctl observation primitive and two narrow assertions for updater hold and game-service identity. The runbook and authorization packet consume only those helpers, advance new rollback records to version 2, and record a stable executable path instead of mutable process state.

**Tech Stack:** Bash 3.2-compatible shell, systemd `systemctl`, Vitest/TypeScript fixtures, Markdown operational documentation, Git, existing macOS signing/notarization release script.

## Global Constraints

- Work only in the isolated `codex/runtime-raiders-cutover-guards` worktree until the reviewed merge gate.
- Keep production paused and healthy on prior SHA `4caebd4f8f0ab655919cc209c67ae93a12984074`; do not access or mutate production during implementation tests.
- Do not publish companion artifacts, install a companion, enable collection, or activate scoring.
- Preserve both aborted version-1 rollback sets as evidence; never reuse them for another attempt.
- Do not compare full systemd `ExecStart` output or record PID, timestamps, exit code, or process status as unit identity.
- Treat every empty, unknown, failed, ambiguous, or malformed systemd observation as a NO-GO.
- New rollback records use `ROLLBACK_RECORD_VERSION=2` and `GAME_EXEC_PATH=/home/rluser/ClaudeRPG/scripts/pi/run-server.sh`.
- Use test-first red-green cycles for every behavior change and commit only green, independently reviewable tasks.
- A new production cutover requires a fresh candidate/preflight record, rollback set, exact backup target, and explicit authorization after the new release SHA exists.

---

### Task 1: ERR-safe systemctl observation and updater hold

**Files:**
- Modify: `tests/runtime-raiders-cutover-guards.test.ts`
- Modify: `scripts/pi/runtime-raiders-cutover-guards.sh`

**Interfaces:**
- Consumes: the existing sourceable Bash helper and test fixture's fake-bin pattern.
- Produces: `rr_observe_systemctl OUTPUT_VARIABLE COMMAND...` and `rr_assert_updater_held TIMER_UNIT SERVICE_UNIT`.

- [ ] **Step 1: Extend the fake systemctl fixture and write failing updater tests**

Add a fake `systemctl` executable to `fixture()`:

```ts
  executable(join(bin, 'systemctl'), [
    'case "${1:-}" in',
    '  is-enabled)',
    '    printf "%s\\n" "${FAKE_TIMER_ENABLED_VALUE-disabled}"',
    '    exit "${FAKE_TIMER_ENABLED_STATUS:-1}"',
    '    ;;',
    '  is-active)',
    '    case "${2:-}" in',
    '      runtime-raiders.timer)',
    '        printf "%s\\n" "${FAKE_TIMER_ACTIVE_VALUE-inactive}"',
    '        exit "${FAKE_TIMER_ACTIVE_STATUS:-3}"',
    '        ;;',
    '      runtime-raiders.service)',
    '        printf "%s\\n" "${FAKE_UPDATER_ACTIVE_VALUE-inactive}"',
    '        exit "${FAKE_UPDATER_ACTIVE_STATUS:-3}"',
    '        ;;',
    '      *) exit 4 ;;',
    '    esac',
    '    ;;',
    '  *) exit 64 ;;',
    'esac',
  ]);
```

Add a runner whose inherited `ERR` trap makes premature trap invocation visible:

```ts
function runSystemdGuard(
  repo: string,
  body: string,
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync('bash', ['-c', [
    'set -Eeuo pipefail',
    `trap 'printf "unexpected-err:%s\\n" "$BASH_COMMAND" >&2; exit 97' ERR`,
    'source "$1"',
    body,
    'trap - ERR',
    'printf "reached\\n"',
  ].join('\n'), 'bash', helper, repo], {
    env: environment,
    encoding: 'utf8',
  });
}
```

Add focused tests:

```ts
it('accepts disabled and inactive updater states without invoking inherited ERR', () => {
  const { root, repo, environment } = fixture();
  try {
    const result = runSystemdGuard(
      repo,
      'rr_assert_updater_held runtime-raiders.timer runtime-raiders.service',
      environment,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('reached\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ['enabled timer', { FAKE_TIMER_ENABLED_VALUE: 'enabled', FAKE_TIMER_ENABLED_STATUS: '0' }],
  ['active timer', { FAKE_TIMER_ACTIVE_VALUE: 'active', FAKE_TIMER_ACTIVE_STATUS: '0' }],
  ['failed updater', { FAKE_UPDATER_ACTIVE_VALUE: 'failed', FAKE_UPDATER_ACTIVE_STATUS: '3' }],
  ['unknown updater', { FAKE_UPDATER_ACTIVE_VALUE: 'unknown', FAKE_UPDATER_ACTIVE_STATUS: '4' }],
  ['empty observation', { FAKE_UPDATER_ACTIVE_VALUE: '', FAKE_UPDATER_ACTIVE_STATUS: '3' }],
  ['unexpected systemctl failure', { FAKE_UPDATER_ACTIVE_VALUE: 'inactive', FAKE_UPDATER_ACTIVE_STATUS: '5' }],
])('rejects %s', (_label, overrides) => {
  const { root, repo, environment } = fixture();
  try {
    const result = runSystemdGuard(
      repo,
      'rr_assert_updater_held runtime-raiders.timer runtime-raiders.service',
      { ...environment, ...overrides },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('reached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/runtime-raiders-cutover-guards.test.ts
```

Expected: FAIL because `rr_assert_updater_held` is not defined. The positive test must not reach `reached`.

- [ ] **Step 3: Implement the minimal ERR-safe observation and updater assertion**

Append to `scripts/pi/runtime-raiders-cutover-guards.sh`:

```bash
rr_observe_systemctl() {
  local destination="${1:-}"
  shift || return 64
  [[ "$destination" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 64
  test "$#" -ge 2 || return 64

  local action="$1"
  local observed=''
  local status=0
  if observed="$(systemctl "$@" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi

  case "$action" in
    is-active)
      case "$status" in 0|3|4) ;; *) return "$status" ;; esac
      ;;
    is-enabled)
      case "$status" in 0|1) ;; *) return "$status" ;; esac
      ;;
    show)
      test "$status" -eq 0 || return "$status"
      ;;
    *) return 64 ;;
  esac
  test -n "$observed" || return 1
  printf -v "$destination" '%s' "$observed"
}

rr_assert_updater_held() {
  local timer="${1:-}"
  local service="${2:-}"
  test -n "$timer" && test -n "$service" || return 64

  local timer_enabled timer_active updater_active
  rr_observe_systemctl timer_enabled is-enabled "$timer"
  rr_observe_systemctl timer_active is-active "$timer"
  rr_observe_systemctl updater_active is-active "$service"
  test "$timer_enabled" = disabled
  test "$timer_active" = inactive
  test "$updater_active" = inactive
}
```

- [ ] **Step 4: Run focused tests and shell syntax to verify GREEN**

Run:

```bash
bash -n scripts/pi/runtime-raiders-cutover-guards.sh
npm test -- tests/runtime-raiders-cutover-guards.test.ts
```

Expected: shell syntax exits 0; all existing and new guard tests pass with no `unexpected-err` output.

- [ ] **Step 5: Commit the green updater guard**

```bash
git add scripts/pi/runtime-raiders-cutover-guards.sh tests/runtime-raiders-cutover-guards.test.ts
git commit -m "fix(raiders): make updater hold ERR-safe"
```

### Task 2: Stable manager-loaded game-service contract

**Files:**
- Modify: `tests/runtime-raiders-cutover-guards.test.ts`
- Modify: `scripts/pi/runtime-raiders-cutover-guards.sh`

**Interfaces:**
- Consumes: `rr_observe_systemctl OUTPUT_VARIABLE COMMAND...` from Task 1.
- Produces: `rr_assert_game_unit SERVICE REPO ENV_FILE EXEC_PATH`.

- [ ] **Step 1: Extend fake systemctl `show` support and write failing contract tests**

Add these `show` cases to the fake systemctl script before its default branch:

```ts
    '  show)',
    '    case "$*" in',
    '      *"--property=User --value"*) printf "%s\\n" "${FAKE_UNIT_USER:-rluser}" ;;',
    '      *"--property=WorkingDirectory --value"*) printf "%s\\n" "${FAKE_UNIT_WORKING_DIRECTORY:-$FAKE_REPO}" ;;',
    '      *"--property=EnvironmentFiles --value"*) printf "%s\\n" "${FAKE_UNIT_ENVIRONMENT_FILES:-$FAKE_ENV_FILE (ignore_errors=no)}" ;;',
    '      *"--property=ExecStart --value"*) printf "%s\\n" "${FAKE_UNIT_EXEC_START-$FAKE_RUNNING_EXEC}" ;;',
    '      *) exit 64 ;;',
    '    esac',
    '    exit "${FAKE_SHOW_STATUS:-0}"',
    '    ;;',
```

Add stable fixture values:

```ts
const service = 'claude-rpg.service';
const envFile = '/etc/claude-rpg.env';
const execPath = '/srv/runtime-raiders/scripts/pi/run-server.sh';

function gameUnitEnvironment(base: NodeJS.ProcessEnv, repo: string) {
  return {
    ...base,
    FAKE_REPO: repo,
    FAKE_ENV_FILE: envFile,
    FAKE_RUNNING_EXEC: `{ path=${execPath} ; argv[]=${execPath} ; ignore_errors=no ; start_time=[Tue 2026-08-04 10:15:47 EDT] ; stop_time=[n/a] ; pid=71893 ; code=(null) ; status=0/0 }`,
  };
}
```

Add tests that use the real shell helper:

```ts
it.each([
  ['running', `{ path=${execPath} ; argv[]=${execPath} ; ignore_errors=no ; start_time=[Tue 2026-08-04 10:15:47 EDT] ; stop_time=[n/a] ; pid=71893 ; code=(null) ; status=0/0 }`],
  ['stopped', `{ path=${execPath} ; argv[]=${execPath} ; ignore_errors=no ; start_time=[Tue 2026-08-04 11:42:09 EDT] ; stop_time=[Tue 2026-08-04 12:03:51 EDT] ; pid=93217 ; code=killed ; status=15/TERM }`],
])('accepts the stable game unit while %s', (_state, execStart) => {
  const { root, repo, environment } = fixture();
  try {
    const result = runSystemdGuard(
      repo,
      `rr_assert_game_unit ${service} "$2" ${envFile} ${execPath}`,
      { ...gameUnitEnvironment(environment, repo), FAKE_UNIT_EXEC_START: execStart },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('reached\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ['wrong user', { FAKE_UNIT_USER: 'root' }],
  ['wrong working directory', { FAKE_UNIT_WORKING_DIRECTORY: '/srv/wrong' }],
  ['wrong environment', { FAKE_UNIT_ENVIRONMENT_FILES: '/etc/wrong.env (ignore_errors=no)' }],
  ['wrong path', { FAKE_UNIT_EXEC_START: '{ path=/bin/false ; argv[]=/bin/false ; status=0/0 }' }],
  ['missing argv', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; status=0/0 }` }],
  ['duplicate path', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; path=${execPath} ; argv[]=${execPath} ; status=0/0 }` }],
  ['duplicate argv', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; argv[]=${execPath} ; argv[]=${execPath} ; status=0/0 }` }],
  ['extra command', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; argv[]=${execPath} ; } { path=/bin/true ; argv[]=/bin/true ; }` }],
  ['empty show result', { FAKE_UNIT_EXEC_START: '' }],
  ['failed show', { FAKE_SHOW_STATUS: '5' }],
])('rejects a game unit with %s', (_label, overrides) => {
  const { root, repo, environment } = fixture();
  try {
    const result = runSystemdGuard(
      repo,
      `rr_assert_game_unit ${service} "$2" ${envFile} ${execPath}`,
      { ...gameUnitEnvironment(environment, repo), ...overrides },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('reached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

The runner passes the repository as positional argument `$2`, matching the
existing test runner pattern.

- [ ] **Step 2: Run the focused suite and verify RED**

Run:

```bash
npm test -- tests/runtime-raiders-cutover-guards.test.ts
```

Expected: FAIL because `rr_assert_game_unit` is not defined. Existing Task 1 tests remain green.

- [ ] **Step 3: Implement stable loaded-unit validation**

Append to `scripts/pi/runtime-raiders-cutover-guards.sh`:

```bash
rr_assert_game_unit() {
  local service="${1:-}"
  local repo="${2:-}"
  local env_file="${3:-}"
  local exec_path="${4:-}"
  test -n "$service" && test -n "$repo" &&
    test -n "$env_file" && test -n "$exec_path" || return 64

  local unit_user unit_working unit_environment loaded_exec
  rr_observe_systemctl unit_user show "$service" --property=User --value
  rr_observe_systemctl unit_working show "$service" --property=WorkingDirectory --value
  rr_observe_systemctl unit_environment show "$service" --property=EnvironmentFiles --value
  rr_observe_systemctl loaded_exec show "$service" --property=ExecStart --value

  test "$unit_user" = rluser
  test "$unit_working" = "$repo"
  test "$unit_environment" = "$env_file (ignore_errors=no)"
  [[ "$loaded_exec" != *$'\n'* ]]

  local path_count=0
  local argv_count=0
  local token
  local -a tokens=()
  read -r -a tokens <<<"$loaded_exec"
  for token in "${tokens[@]}"; do
    case "$token" in
      path=*)
        path_count=$((path_count + 1))
        test "$token" = "path=$exec_path"
        ;;
      'argv[]='*)
        argv_count=$((argv_count + 1))
        test "$token" = "argv[]=$exec_path"
        ;;
    esac
  done
  test "$path_count" -eq 1
  test "$argv_count" -eq 1
}
```

- [ ] **Step 4: Verify the stable contract is GREEN**

Run:

```bash
bash -n scripts/pi/runtime-raiders-cutover-guards.sh
npm test -- tests/runtime-raiders-cutover-guards.test.ts
```

Expected: running and stopped records pass; every malformed identity case fails; all prior guard tests pass.

- [ ] **Step 5: Commit the stable unit contract**

```bash
git add scripts/pi/runtime-raiders-cutover-guards.sh tests/runtime-raiders-cutover-guards.test.ts
git commit -m "fix(raiders): stabilize game unit cutover checks"
```

### Task 3: Version-2 rollback records and executable-helper runbook

**Files:**
- Create: `tests/runtime-raiders-cutover-docs.test.ts`
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md`
- Modify: `docs/runtime-raiders/cutover-authorization-packet.md`

**Interfaces:**
- Consumes: `rr_assert_updater_held` and `rr_assert_game_unit` from Tasks 1-2.
- Produces: version-2 rollback-record procedure using `GAME_EXEC_PATH` and no mutable `ExecStart` literal.

- [ ] **Step 1: Write failing documentation-contract tests**

Create `tests/runtime-raiders-cutover-docs.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(
  join(process.cwd(), 'docs/RUNTIME_RAIDERS_CUTOVER.md'),
  'utf8',
);
const packet = readFileSync(
  join(process.cwd(), 'docs/runtime-raiders/cutover-authorization-packet.md'),
  'utf8',
);

describe('Runtime Raiders stable cutover documentation contract', () => {
  it('uses version-2 rollback records with a stable executable path', () => {
    expect(runbook).toContain('ROLLBACK_RECORD_VERSION=2');
    expect(runbook).toContain('test "$ROLLBACK_RECORD_VERSION" = 2');
    expect(runbook).not.toContain('test "$ROLLBACK_RECORD_VERSION" = 1');
    expect(runbook).toContain('GAME_EXEC_PATH');
    expect(runbook).not.toContain('GAME_EXEC_EXPECTED');
    expect(packet).toContain('rollback record version `2`');
    expect(packet).toContain('GAME_EXEC_PATH');
  });

  it('delegates updater and game-unit gates to the executable helper', () => {
    expect(runbook).toContain(
      'rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"',
    );
    expect(runbook).toContain(
      'rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"',
    );
    expect(runbook).not.toMatch(
      /test "\$\(systemctl is-active "\$UPDATER_(?:TIMER|SERVICE)"\)" = inactive/,
    );
    expect(runbook).not.toMatch(/test "\$GAME_EXEC" =/);
  });

  it('keeps fail-closed cleanup non-recursive', () => {
    expect(runbook).toContain(
      'sudo systemctl stop "$SERVICE" >/dev/null 2>&1 || true',
    );
    expect(runbook).toContain(
      'sudo systemctl stop "$UPDATER_SERVICE" >/dev/null 2>&1 || true',
    );
  });
});
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
npm test -- tests/runtime-raiders-cutover-docs.test.ts
```

Expected: FAIL because the runbook still uses record version 1, `GAME_EXEC_EXPECTED`, copied assertions, and recursive cleanup commands.

- [ ] **Step 3: Update the record of truth and preparation contract**

In `docs/RUNTIME_RAIDERS_CUTOVER.md`:

- replace the rollback-record unit field `GAME_EXEC_EXPECTED` with `GAME_EXEC_PATH`;
- set the fixed operator value:

```bash
GAME_EXEC_PATH=/home/rluser/ClaudeRPG/scripts/pi/run-server.sh
```

- replace the preparation-time complete `ExecStart` equality check with:

```bash
rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"
```

- explicitly state that mutable `start_time`, `stop_time`, `pid`, `code`, and
  `status` are observations, not identity fields.

- [ ] **Step 4: Update coordinated cutover snippets**

After sourcing the release-pinned helper, remove the copied `assert_updater_held`
and `assert_game_unit` functions. Replace every call with:

```bash
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"
```

Make fail-closed cleanup idempotent and non-recursive:

```bash
sudo systemctl disable --now "$UPDATER_TIMER" >/dev/null 2>&1 || true
sudo systemctl stop "$UPDATER_SERVICE" >/dev/null 2>&1 || true
sudo systemctl stop "$SERVICE" >/dev/null 2>&1 || true
```

Observe expected stopped service state through the helper:

```bash
rr_observe_systemctl service_state is-active "$SERVICE"
test "$service_state" = inactive
```

Set `ROLLBACK_RECORD_VERSION=2`, add `GAME_EXEC_PATH` to `ROLLBACK_FIELDS`, and
remove `GAME_EXEC_EXPECTED` from every record construction and validation list.

- [ ] **Step 5: Update rollback and authorization packet**

In the rollback procedure:

```bash
test "$ROLLBACK_RECORD_VERSION" = 2
test "$GAME_EXEC_PATH" = "$REPO/scripts/pi/run-server.sh"
rr_assert_updater_held "$UPDATER_TIMER" "$UPDATER_SERVICE"
rr_assert_game_unit "$SERVICE" "$REPO" "$CURRENT_ENV" "$GAME_EXEC_PATH"
```

Use `rr_observe_systemctl` for every expected inactive service observation and
make rollback fail-closed cleanup use `|| true` exactly as in the cutover path.

In `docs/runtime-raiders/cutover-authorization-packet.md`, record:

```markdown
| Rollback record contract | version `2`; `GAME_EXEC_PATH=/home/rluser/ClaudeRPG/scripts/pi/run-server.sh` |
```

State that both aborted version-1 rollback sets are evidence only and cannot be
used for the next cutover.

- [ ] **Step 6: Verify documentation and related release contracts are GREEN**

Run:

```bash
npm test -- tests/runtime-raiders-cutover-docs.test.ts
npm test -- tests/runtime-raiders-cutover-guards.test.ts tests/runtime-raiders-preflight.test.ts tests/runtime-raiders-publication-docs.test.ts tests/deploy-runtime-raiders.test.ts
bash -n scripts/pi/runtime-raiders-cutover-guards.sh
rg -n 'GAME_EXEC_EXPECTED|test "\$GAME_EXEC" =|systemctl is-active "\$UPDATER_(TIMER|SERVICE)"\)" = inactive' docs/RUNTIME_RAIDERS_CUTOVER.md docs/runtime-raiders/cutover-authorization-packet.md
```

Expected: both test commands pass; shell syntax exits 0; `rg` returns no matches.

- [ ] **Step 7: Commit the version-2 operational contract**

```bash
git add docs/RUNTIME_RAIDERS_CUTOVER.md docs/runtime-raiders/cutover-authorization-packet.md tests/runtime-raiders-cutover-docs.test.ts
git commit -m "docs(raiders): use stable executable cutover guards"
```

### Task 4: Release-candidate verification and review

**Files:**
- Verify only: all files changed in Tasks 1-3
- Restricted, untracked evidence: `dist/runtime-raiders-release-${CANDIDATE_SHORT}.txt`

**Interfaces:**
- Consumes: the complete version-2 guard implementation and documentation.
- Produces: a reviewed candidate commit suitable for merge and signed artifact rebuild; it does not deploy or publish.

- [ ] **Step 1: Run static and focused verification**

```bash
bash -n scripts/pi/runtime-raiders-cutover-guards.sh
npm run typecheck
npm run check:player-copy
npm test -- tests/runtime-raiders-cutover-guards.test.ts tests/runtime-raiders-cutover-docs.test.ts tests/runtime-raiders-preflight.test.ts tests/runtime-raiders-publication-docs.test.ts tests/deploy-runtime-raiders.test.ts
git diff --check 72ba19fe4c01b6975b7e61e0ee83c68fcf11f8af...HEAD
```

Expected: every command exits 0.

- [ ] **Step 2: Run the complete Node suite with localhost access**

```bash
npm test
```

Expected: every test file and test passes. The ignored sprite-asset link remains
untracked and is not included in the release commit.

- [ ] **Step 3: Review the complete change set**

```bash
git status --short --branch
git log --oneline 72ba19fe4c01b6975b7e61e0ee83c68fcf11f8af..HEAD
git diff --stat 72ba19fe4c01b6975b7e61e0ee83c68fcf11f8af...HEAD
git diff 72ba19fe4c01b6975b7e61e0ee83c68fcf11f8af...HEAD -- scripts/pi/runtime-raiders-cutover-guards.sh tests/runtime-raiders-cutover-guards.test.ts tests/runtime-raiders-cutover-docs.test.ts docs/RUNTIME_RAIDERS_CUTOVER.md docs/runtime-raiders/cutover-authorization-packet.md
```

Expected: only the approved guard, test, runbook, packet, design, and plan scope
appears. No application, scoring, database, Caddy, or companion source changes.

- [ ] **Step 4: Request code review and resolve findings test-first**

Invoke `superpowers:requesting-code-review`. Any behavioral finding requires a
new failing regression test before implementation. Re-run Steps 1-3 after each
accepted correction.

- [ ] **Step 5: Record candidate evidence without secrets**

Create an owner-only ignored record named from the final candidate short SHA:

```bash
CANDIDATE_SHA=$(git rev-parse HEAD)
CANDIDATE_SHORT=$(git rev-parse --short HEAD)
RECORD="dist/runtime-raiders-release-${CANDIDATE_SHORT}.txt"
umask 077
{
  printf 'base_release_sha=72ba19fe4c01b6975b7e61e0ee83c68fcf11f8af\n'
  printf 'candidate_sha=%s\n' "$CANDIDATE_SHA"
  printf 'cutover_guard_tests=passed\n'
  printf 'cutover_docs_tests=passed\n'
  printf 'typecheck=passed\n'
  printf 'player_copy_check=passed\n'
  printf 'node_tests=passed\n'
  printf 'production_status=prior_release_paused\n'
  printf 'artifact_publication_status=unpublished\n'
  printf 'collector_activation_status=off\n'
} >"$RECORD"
chmod 0600 "$RECORD"
```

Set its mode to `0600`. Do not record environment contents, credentials,
provider paths, enrollment data, or production payloads.

### Task 5: Merge, produce the new release SHA, and rebuild the signed triplet

**Files:**
- Merge the reviewed branch into `main` after user approval.
- Generated ignored outputs: `dist/install.sh`, `dist/runtime-raiders-agent.zip`, `dist/runtime-raiders-agent.zip.sha256`
- Update restricted, ignored release evidence only.

**Interfaces:**
- Consumes: the reviewed candidate from Task 4 and established Apple signing environment.
- Produces: the new full release SHA and freshly validated signed/notarized companion triplet; production remains on the prior SHA.

- [ ] **Step 1: Obtain the merge/release checkpoint**

Present the reviewed candidate SHA, commits, complete test evidence, production
pause status, and statement that merging creates a new release SHA and requires
a complete companion rebuild. Obtain explicit approval before merging or
pushing.

- [ ] **Step 2: Merge without rewriting history**

From the clean production checkout:

```bash
git switch main
git merge --ff-only codex/runtime-raiders-cutover-guards
RELEASE_SHA=$(git rev-parse HEAD)
test "$RELEASE_SHA" != 72ba19fe4c01b6975b7e61e0ee83c68fcf11f8af
```

Expected: fast-forward succeeds and `RELEASE_SHA` is one new 40-character SHA.

- [ ] **Step 3: Re-run release verification at the exact merged SHA**

```bash
npm run typecheck
npm run check:player-copy
npm test
bash -n scripts/pi/runtime-raiders-cutover-guards.sh
test "$(git status --porcelain | wc -l | tr -d ' ')" = 0
```

Expected: every command exits 0 and tracked `main` is clean.

- [ ] **Step 4: Build, sign, notarize, staple, and validate the new triplet**

```bash
test -n "${RUNTIME_RAIDERS_CODESIGN_IDENTITY:-}"
test -n "${RUNTIME_RAIDERS_NOTARY_PROFILE:-}"
test -n "${RUNTIME_RAIDERS_TEAM_ID:-}"
scripts/release/build-runtime-raiders-agent.sh
```

Expected: the script reports successful universal build, strict code-signature
verification, accepted notarization, stapling validation, transactional ZIP and
installer replacement, and final checksum validation.

- [ ] **Step 5: Record exact artifact digests and verify publication remains off**

```bash
shasum -a 256 dist/install.sh
shasum -a 256 dist/runtime-raiders-agent.zip
shasum -a 256 dist/runtime-raiders-agent.zip.sha256
```

Write the three distinct digests, sizes, release SHA, notarization submission
ID/status, architecture result, and UTC timestamp to the owner-only release
record. Confirm production still runs the prior SHA, the updater remains held,
the game remains paused, `/var/lib/runtime-raiders/current` remains absent, and
all three artifact URLs remain `404` before requesting push/fetch or cutover
authorization.

- [ ] **Step 6: Publish only the reviewed Git SHA to tracked `main` after approval**

```bash
git push origin main
test "$(git rev-parse origin/main)" = "$RELEASE_SHA"
```

This Git publication does not authorize Pi checkout, candidate installation,
service restart, artifact publication, companion installation, or scoring
activation. Those return to the fresh preflight and cutover authorization gates.

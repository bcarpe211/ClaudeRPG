# Runtime Raiders stable cutover guards design

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

## Context

The first Runtime Raiders production cutover remained fail-closed, but two
pre-deployment attempts exposed defects in the human-copied systemd assertions:

1. `systemctl is-active` returns a nonzero status for the expected `inactive`
   state. Under `set -E` that status invoked the inherited `ERR` trap from a
   command substitution before the surrounding string comparison ran.
2. `systemctl show ... --property=ExecStart --value` includes mutable runtime
   fields such as start time, stop time, PID, exit code, and status. Comparing
   its complete output with a recorded literal failed after an otherwise clean
   restart of the unchanged prior service.

Both failures happened before release checkout or candidate-environment
installation. The prior service was authenticated and recovered after each
abort. A third attempt is forbidden until these gates are executable, stable,
and regression-tested.

## Goals

- Make expected inactive systemd states safe under `set -Eeuo pipefail` and an
  inherited `ERR` trap.
- Verify the manager-loaded game-service contract without comparing mutable
  process state.
- Put safety-critical systemd behavior in the release-pinned executable guard
  helper instead of duplicating shell logic in the runbook.
- Use the same helper functions during cutover and rollback.
- Preserve fail-closed behavior for missing output, command failure, wrong
  unit state, wrong service identity, or ambiguous `ExecStart` data.
- Produce a new release SHA, signed companion triplet, candidate/preflight
  record, rollback set, and explicit cutover authorization.

## Non-goals

- Automating the complete production cutover in this revision.
- Changing application, database, scoring, policy, Caddy, DNS, or companion
  collection behavior.
- Reusing either aborted attempt's rollback set.
- Enabling collectors, publishing artifacts, or starting office scoring.
- Hashing systemd unit-file text or drop-in formatting when the loaded stable
  properties already express the required contract.

## Executable guard API

`scripts/pi/runtime-raiders-cutover-guards.sh` will add three public helpers.
They remain sourceable from the exact approved Git object and from the sealed
rollback directory.

### `rr_observe_systemctl VALUE_NAME COMMAND...`

The helper executes one read-only `systemctl` observation in a conditional
context, so expected nonzero statuses do not invoke `ERR`. It writes the
nonempty stdout value into the caller variable named by `VALUE_NAME`.

The helper fails when:

- the destination variable name is invalid;
- `systemctl` produces no value;
- the command cannot execute or reports an unusable observation; or
- the caller cannot receive the value.

For state queries, the returned text remains authoritative. An `inactive`
value is accepted only by a caller explicitly expecting `inactive`; values
such as `active`, `failed`, `unknown`, or `not-found` fail that assertion.

### `rr_assert_updater_held TIMER SERVICE`

This helper observes:

- `systemctl is-enabled TIMER` equals `disabled`;
- `systemctl is-active TIMER` equals `inactive`; and
- `systemctl is-active SERVICE` equals `inactive`.

Each observation uses `rr_observe_systemctl`. The function must work under an
active inherited `ERR` trap even though inactive/disabled systemd queries may
exit nonzero. It returns nonzero for every other value or missing observation.

### `rr_assert_game_unit SERVICE REPO ENV_FILE EXEC_PATH`

This helper verifies stable manager-loaded properties:

- `User` is exactly `rluser`;
- `WorkingDirectory` is exactly `REPO`;
- `EnvironmentFiles` is exactly `ENV_FILE (ignore_errors=no)`;
- `ExecStart` contains exactly one `path=EXEC_PATH` token; and
- `ExecStart` contains exactly one `argv[]=EXEC_PATH` token.

The helper deliberately ignores `start_time`, `stop_time`, `pid`, `code`, and
`status`. Those fields describe the current or previous process, not the unit
contract. It rejects missing output, extra commands, duplicate expected path or
argv tokens, or any other executable path.

`EXEC_PATH` is fixed to
`/home/rluser/ClaudeRPG/scripts/pi/run-server.sh` for this deployment. The
existing User, working-directory, and environment-file compatibility names do
not change.

## Rollback record version 2

The rollback record advances from version `1` to version `2` for new attempts.
The stable field `GAME_EXEC_PATH` replaces `GAME_EXEC_EXPECTED`. The record
continues to include the exact prior/release SHAs, cutover ID, database and
environment backups, checksums, retained query paths, unit names, fixed paths,
and copied guard helper.

Rollback authentication remains unchanged:

1. validate paths, ownership, mode, and detached seal;
2. compare the independently recorded expected record SHA-256;
3. source the release-pinned guard helper;
4. authenticate the record before sourcing it;
5. validate every required version-2 field; and
6. use `rr_assert_updater_held` and `rr_assert_game_unit` before the rollback
   start.

Version-1 records from the aborted attempts remain preserved as evidence, but
are not valid inputs for a new cutover attempt.

## Runbook integration

`docs/RUNTIME_RAIDERS_CUTOVER.md` will:

- replace copied updater and game-unit functions with calls to the executable
  helpers;
- remove all full `ExecStart` equality checks and `GAME_EXEC_EXPECTED` fields;
- record `GAME_EXEC_PATH` and rollback-record version `2`;
- use ERR-safe state observations in fail-closed cleanup, hold, cutover, and
  rollback examples;
- require a fresh candidate/preflight record, rollback set, and authorization
  for the new release SHA; and
- record both aborted attempts and their causes without reusing their backup
  paths.

`docs/runtime-raiders/cutover-authorization-packet.md` will use the same stable
unit-contract and version-2 rollback terminology.

## Test design

`tests/runtime-raiders-cutover-guards.test.ts` will drive the real shell helper
through fake `systemctl`, `sudo`, `git`, and `find` executables.

Regression tests must first demonstrate the old failures, then prove the new
behavior:

- expected disabled/inactive values pass with `set -E` and an inherited `ERR`
  trap even when fake systemd returns its normal nonzero state codes;
- `active`, `failed`, unknown, empty, and command-failure observations fail;
- both running and stopped `ExecStart` records pass when their stable path and
  argv contract is identical;
- changed timestamps, PID, exit code, and status do not affect acceptance;
- wrong User, working directory, environment file, executable path, missing
  argv, duplicate path/argv tokens, and extra commands fail;
- existing Git ownership and rollback-record authentication tests remain
  green; and
- a version-1 rollback record is rejected by the revised version-2 runbook
  validation.

Verification includes shell syntax, the focused cutover-guard suite, related
deployment/preflight/publication documentation suites, typecheck, and the full
Node test suite with the existing ignored sprite assets available. The final
release process repeats the complete signed/notarized companion validation.

## Failure handling

Every unknown result remains a NO-GO. The executable helpers return nonzero and
allow the already-installed fail-closed trap to stop the game and reassert the
updater hold. Cleanup commands explicitly tolerate the known terminal state
they are enforcing, preventing recursive `ERR` traps while still verifying the
final state afterward.

No production retry occurs during implementation or testing. After the new SHA
is reviewed, merged, rebuilt, signed, published to tracked `main`, and fetched
with the updater held, production requires a fresh read-only preflight and a
new explicit authorization naming the release SHA, cutoff, backup target, and
window.

## Acceptance criteria

- The focused regression suite fails before the helper change and passes after
  it for the two observed production defects.
- No full `ExecStart` runtime literal is recorded or compared anywhere in the
  active cutover or rollback procedure.
- No expected inactive/disabled systemd query can invoke the inherited `ERR`
  trap before its value is checked.
- The new helper rejects ambiguous or changed manager-loaded service identity.
- The full test suite and release validation pass from a clean isolated
  worktree.
- Production remains paused on the prior release with artifacts and collectors
  off until a separately authorized new-SHA cutover.

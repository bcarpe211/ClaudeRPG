# Runtime Raiders zsh-compatible onboarding design

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

Status: approved for next-release implementation on 2026-08-15. This design
does not authorize a release-number change, signing, notarization, publication,
Pi changes, canary migration, collection, fresh onboarding, or office
activation.

## Release boundary

The accepted sequence-10 release at
`c04214c6ead5d6bcffc06ab6bbbbf4af407360ae` and its quartet remain immutable.
The accepted sequence-11 source at
`142302746462aa4da03d04af23fa468631f4a9c3` and its local public and private
records also remain immutable. This repair is implemented only in a later
commit and release.

Sequence 10 may still be published solely for an installed-off canary
migration. Neither that migration nor any other canary result permits routine
fresh onboarding or office activation before this repair is released and
independently verified.

## Confirmed defect

The website-generated onboarding command is intended to be pasted directly
into a player's interactive shell. `src/web/companion-install.ts` currently
stores curl's HTTP result in a variable named `status`. zsh defines `status` as
a read-only special parameter, so the real command fails before it can validate
or run a correctly downloaded installer. The UI renders the command directly
and does not select Bash. Existing complete-command tests run only through
`/bin/sh -c`, so they cannot detect the failure.

The same shell-assumption class exists in operational documentation:
`docs/runtime-raiders-companion-release-gates.md` contains substantial pasted
blocks whose cleanup behavior assumes Bash-compatible variable semantics. A
Markdown language fence changes highlighting only; it does not choose the
reader's execution shell.

## Goals

1. Keep the player-facing onboarding command portable across clean zsh and
   POSIX sh without requiring the player to type a Bash wrapper.
2. Exercise the complete generated command, rather than fragments or snapshots,
   under both real shells for success and fail-closed behavior.
3. Replace large Bash-dependent operational snippets with reviewed, checked-in
   Bash entry points.
4. Bind website output, canonical documentation, and runbook invocations with
   automated drift checks.
5. Audit directly pasted commands without mechanically rewriting variables in
   scripts whose interpreter is already explicit.

## Non-goals

- No installer transaction, updater, migration, scoring, or collection change.
- No weakening of the installer-size, HTTPS, redirect, ownership, mode,
  hard-link, symlink, nonempty-file, syntax, or HTTP-status checks.
- No broad conversion of shell scripts to Bash or zsh.
- No release metadata bump and no Apple or production operation.
- No change solely because an internal script uses a variable named `status`
  when its `#!/bin/bash`, `#!/bin/sh`, `/bin/bash`, or `/bin/sh` boundary is
  already unambiguous.

## Player-facing command

`buildCompanionInstallCommand()` remains the single generator used by
registration and Player Hub. Its HTTP-result variable changes from `status` to
`download_http_code`; the rest of the command retains its existing security
contract and continues to execute the downloaded installer with `/bin/sh`.

The outer generated command must execute successfully with either:

- `/bin/sh -c <command>`; or
- `/bin/zsh -f -c <command>`.

Using `zsh -f` excludes user startup files so the test proves the command's own
portability. The command must not depend on shell aliases, functions, options,
or profile variables.

## Generated-command test matrix

`tests/runtime-raiders-onboarding.test.ts` defines one explicit shell matrix:

```ts
const commandShells = [
  { name: 'sh', executable: '/bin/sh', args: (command: string) => ['-c', command] },
  { name: 'zsh', executable: '/bin/zsh', args: (command: string) => ['-f', '-c', command] },
] as const;
```

Every complete-command case runs under both entries. Tests execute the real
string returned by `buildCompanionInstallCommand()` with a controlled curl
executable and a real temporary installer file.

Required cases for each shell:

1. A builder-permitted installer larger than 1 MiB but no larger than the shared
   8 MiB contract downloads, passes local validation, and executes once.
2. Curl exits nonzero: the command exits nonzero, never executes the installer,
   and removes the owner-only temporary download.
3. Curl exits zero but reports a non-200 HTTP code: the command fails closed,
   never executes the installer, and removes the temporary download.
4. A completed download exceeds the shared size limit: the command fails closed,
   never executes the installer, and removes the temporary download.
5. The downloaded leaf is replaced by a symlink: the command fails closed,
   never executes the target, and removes only the temporary leaf.

The fake curl records the exact `--output` path in a test-owned file. Each case
uses that record to prove cleanup rather than merely assuming the EXIT trap ran.

Route tests in `tests/web-registration.test.ts` and `tests/web-runs.test.ts`
must assert the portable variable name and reject the old command fragment.

## Checked-in Bash operator entry points

Two focused scripts replace the large pasted release-gate blocks:

1. `scripts/release/run-runtime-raiders-gate2.sh`
   - starts with `#!/bin/bash` and `set -euo pipefail`;
   - requires the three existing signing/notary environment variables;
   - requires a clean Git worktree and derives the exact release identity from
     `HEAD` and `companion/RELEASE`;
   - requires an absent immutable `dist/sequence-<n>-<sha>` destination;
   - invokes the existing builder and independent signed-release reviewer; and
   - prints the four reviewed SHA-256 values without publishing anything.

2. `scripts/release/prepare-runtime-raiders-sequence8-private-record.sh`
   - starts with `#!/bin/bash` and `set -euo pipefail`;
   - requires the Team ID, a clean Git worktree, the exact local public quartet,
     and an absent immutable private destination;
   - owns and removes an owner-only temporary work directory on success,
     failure, and signals;
   - builds the deterministic validator outside the final private record and
     proves its SHA-256 equals the validator embedded in `install.sh`;
   - renders and syntax-checks the migration script;
   - atomically installs exactly the validator and migrator into the private
     record; and
   - prints the two private SHA-256 values without executing the migrator.

The scripts may use Bash-local implementation details because their interpreter
is explicit. Cleanup variables use descriptive names such as `cleanup_result`
for clarity, but the audit does not require renaming unrelated, explicitly
interpreted scripts.

`docs/runtime-raiders-companion-release-gates.md` replaces each large block with
its exact checked-in invocation:

```sh
/bin/bash scripts/release/run-runtime-raiders-gate2.sh
/bin/bash scripts/release/prepare-runtime-raiders-sequence8-private-record.sh
```

Passing either script preserves all existing authorization boundaries. In
particular, neither invocation publishes artifacts, executes the private
migrator, changes the Pi, installs a companion, or enables collection.

## Documentation and pasted-command audit

`docs/runtime-raiders/companion-operations.md` remains the canonical documented
player command. A documentation test extracts that one-line command and
requires exact equality with `buildCompanionInstallCommand()` using its default
curl path. The test also rejects the old `status` assignment.

Release-gate documentation tests require the two exact `/bin/bash` script
invocations and reject the former inline function bodies. Gate 1 shell syntax
checks include both new scripts.

The implementation audit covers command text intended for direct user or
operator paste in Runtime Raiders onboarding and release-operation documents.
Any discovered use of a zsh read-only/special variable or implicit
Bash-specific syntax is either made portable or moved behind an explicit
interpreter. Occurrences inside already explicit script boundaries are recorded
as out of scope unless they are independently incorrect.

## Error handling and safety

- Player download failures remain nonzero and content-free.
- No failure path executes a partially downloaded, oversized, empty, symlinked,
  multiply linked, incorrectly owned, incorrectly permissioned, or
  syntax-invalid installer.
- The player's temporary installer remains owner-only and is removed by the
  command's EXIT trap under both supported shells.
- Operator scripts refuse dirty source trees, pre-existing immutable outputs,
  malformed release metadata, unsafe scratch/output topology, and mismatched
  validator bytes.
- Operator-script cleanup is restricted to the exact validated temporary path;
  immutable public or private records are never treated as cleanup targets.

## Verification and acceptance

The repair is acceptable only when:

1. The new zsh success test fails against the old generator with the expected
   read-only-parameter error, then passes after the portable rename.
2. Every generated-command success and fail-closed case passes under both clean
   shells and proves temporary-file cleanup.
3. Route, website, canonical command documentation, and release-runbook drift
   tests pass.
4. Both new Bash scripts pass syntax and bounded fake-boundary tests; no test
   signs, notarizes, publishes, contacts the Pi, or executes the real migrator.
5. Focused onboarding, registration, run, release-gate, publication-doc, and
   installer suites pass, followed by typecheck and the complete repository
   suite.
6. The worktree ends clean with no `companion/.build`, scratch, test asset link,
   dependency link, or release artifact created by verification.

Even after implementation acceptance, fresh onboarding and office activation
remain blocked until a later release containing the repair passes Apple trust
review and the appropriate canary gates.

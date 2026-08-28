# Runtime Raiders employee beta

**Status:** Active procedure
**Audience:** Employees and authorized companion-release operators
**Applies to:** Current Runtime Raiders companion onboarding, lifecycle, and release work
**Last verified:** 2026-08-28

The installer starts every employee with collection off. Publishing a release
never turns collection on for anyone. For lifecycle and credential recovery, use
[companion operations](companion-operations.md). Historical release results are
archived and are not operating instructions.

## Employee companion basics

Install or reinstall:

```sh
curl -fsSL https://raiders.redlattice.com/install.sh | sh
```

Turn collection on only when the employee chooses to opt in:

```sh
raiders on
```

Check the human-readable status, an update, or turn collection off:

```sh
raiders status
raiders update
raiders off
```

## Change or remove a local companion

Change Raider: `raiders off`, then `raiders re-enroll`.

Remove the app but keep recovery state: `raiders uninstall`.

Revoke and remove every local Runtime Raiders artifact: `raiders uninstall --everything`.

Browser login alone never changes an installed enrollment.

Neither removal mode deletes a Raider, account, Run, score, reward, or beta history.

If an interrupted re-enrollment leaves recovery state in place, reinstall the
official companion if needed, keep collection off, then run `raiders re-enroll`.
Do not delete support files by hand.

Before a first install, a new player opens
`https://raiders.redlattice.com/register` and creates a Raider. An existing
player opens `https://raiders.redlattice.com/character`, signs in with their
Raider Key, then opens **Raider settings → Companion Setup** and generates a
fresh installer and code. The installer asks privately for that one-time code;
it expires after 10 minutes and is not the persistent Raider Key. A reinstall
with valid existing enrollment does not require another code.

## Run the one-shot live acceptance gate

This is an operator check for a newly installed beta, not an employee install
step. Quit Codex completely so it stops changing the provider-history files.
From the clean reviewed checkout, run:

```sh
/bin/bash scripts/test/run-runtime-raiders-live-activation-gate.sh
```

The script waits for 60 seconds of quiet provider-file metadata, requires at
least 816 existing records, checks the installed Apple signature and Gatekeeper
result, checks that the game is paused and its database is healthy, and records
aggregate Run and score baselines. It then turns collection on, proves that
history created no server changes, creates one content-free synthetic Codex
Desktop completion, and requires exactly one matching scored Run.

On success, failure, or interruption, the script removes only its uniquely
named synthetic fixture and always runs `raiders off` before returning. It
writes a secret-free, owner-only report at
`/private/tmp/runtime-raiders-activation-gate-<timestamp>.<random>`. Reopen
Codex after the command finishes and use that report for the gate record. If
the script reports a failure, do not continue to a release decision.

## Release a beta

Use a clean, reviewed Git commit on a Mac with Apple release access. Set these
three signing environment variables in the operator's shell; do not put their
values in the repository or this document:

- `RUNTIME_RAIDERS_CODESIGN_IDENTITY`
- `RUNTIME_RAIDERS_NOTARY_PROFILE`
- `RUNTIME_RAIDERS_TEAM_ID`

The release account is `rluser@raiders.redlattice.com` unless an approved
environment explicitly selects another existing account. Do not start or stop a
VPN automatically. Before any publication, prove the exact candidate locally:

```sh
/bin/bash scripts/release/install-runtime-raiders-local-canary.sh
```

This local canary installs only the exact prepared ZIP and requires a running
managed daemon, disabled collection, zero active Runs, and zero queued events.
It does not publish or validate public server paths. Do not run `publish` until
it passes.

### One-time publication bootstrap

The root Caddy bootstrap is separately authorized and is never combined with a
normal publication decision. It must use an existing release account, validate
its preconditions before changing anything, and restore the prior files and
Caddy configuration on failure. Normal publication uses only the fixed
publisher and does not install code or configuration, validate, reload, or
restart Caddy.

### Prepare and publish

First build, sign, notarize, staple, and verify locally:

```sh
/bin/bash scripts/release/release-runtime-raiders-beta.sh prepare
```

Expected result: the command identifies the prepared candidate and explicitly
states that nothing was published or installed. It names the next separately
approved publication command without embedding a version-specific transcript.

After publication is separately approved, run:

```sh
/bin/bash scripts/release/release-runtime-raiders-beta.sh publish
```

`publish` repeats local verification, transmits only its bounded approved
release, publishes `version` last, and performs public checks. It does not
install on a Mac, enable collection, reload Caddy, restart Node, deploy the
game, change scoring or pause state, or touch the database.

## If publication fails

The public `version` file is replaced last, so a failure before that point
leaves the prior version visible. Preserve the failed evidence, correct the
local or SSH error, and restart from the appropriate separately approved step.
For rollback, use the exact prior clean commit and retained verified release
evidence. Rollback never enables collection.

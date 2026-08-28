# Runtime Raiders fast canary loop design

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

**Date:** 2026-08-07

**Status:** Approved

**Scope:** A fast, isolated companion-installer regression loop and the narrow
already-disabled upgrade correction. This work does not create or publish a
release.

## 1. Context

The sequence-4 canary upgraded successfully and remained healthy and disabled,
but `collector-state.json` was not preserved byte-for-byte. The installer asks
every live prior daemon to run `off`. `off` is intentionally destructive to
active collection state: it clears Run lifecycle state and prepares provider
files to seed from a fresh boundary. Calling it on an already-disabled daemon
therefore rewrites state that did not need to change.

The existing installer suite covers fresh installs, enabled upgrades,
missing/corrupt state, readiness failures, and rollback. It does not cover the
exact failed case: a live, already-disabled installation with valid, nonempty
collector state. Production signing, notarization, artifact publication, Pi
cutover, and manual live verification made this missing test expensive to
discover.

## 2. Goals

- Reproduce the sequence-4 preservation failure in the isolated installer
  harness before changing production code.
- Preserve valid collector state byte-for-byte when upgrading a live daemon
  that already reports collection disabled.
- Retain the existing behavior for an enabled daemon: run `off`, prove it is
  stopped and disabled, and only then replace the application.
- Retain safe recovery for fresh, missing, or invalid offline state.
- Provide one local command, `npm run canary:upgrade-test`, that syntax-checks
  the installer and runs its complete isolated integration suite.
- Keep the fast command free of real enrollment, provider data, network access,
  launchd changes, installed-app changes, signing, notarization, publication,
  Pi access, Caddy access, collection, and activation.

## 3. Non-goals

- Publishing companion sequence 5 or changing `companion/RELEASE`.
- Installing another candidate on the real Mac canary.
- Changing `raiders off`, `raiders update`, the collector-state schema, scoring,
  server APIs, or provider adapters.
- Automating production deployment or office activation.
- Adding a second daemon or persistent test process.

## 4. Approaches considered

### A. Full signed release for every iteration

This exercises the most production surface, but repeats signing, notarization,
publication, Pi, and live-canary gates before basic integration behavior is
known. It remains appropriate only for a release candidate.

### B. Unit-test only

This is fast but would not exercise the shell installer's status parsing,
launchd ordering, filesystem transaction, or fake prior binary. It would not
have caught the sequence-4 failure.

### C. Isolated installer integration loop — selected

Use the existing Vitest installer harness with fake artifacts, launchd, network,
and binaries. Add a realistic nonempty disabled state fixture, then assert its
bytes are unchanged and that the prior binary never receives `off`. This keeps
the loop fast while exercising the real installer script and its transaction.
A real signed canary remains a later single gate after the isolated loop passes.

## 5. Installer behavior

The installer will classify one status response from the prior executable:

1. If the daemon is live and reports `enabled:false` plus
   `persistedState:"disabled"`, do not invoke `off`; proceed directly to the
   existing launchd bootout and stopped-state proof.
2. If the daemon is live but does not report that exact disabled state, invoke
   `off` exactly as today before bootout.
3. If the daemon is not live, do not invoke `off`.

After bootout, the candidate executable must still report an offline disabled
state before replacement. Fresh/missing/corrupt offline recovery remains
unchanged. The healthy already-disabled path may not rewrite collector state as
part of quiescence or replacement.

## 6. Regression test

The new test will:

- install the existing fake application and leave its fake launchd job live;
- write valid, nonempty, disabled collector-state bytes containing a synthetic
  file entry and adapter snapshot placeholders;
- capture the exact bytes before upgrade;
- run the rendered installer with an existing enrollment;
- assert successful replacement and a live disabled replacement daemon;
- assert the exact collector-state bytes are unchanged;
- assert the prior binary log contains `status` but not `off`;
- assert enrollment is not requested again; and
- assert no Run-event or heartbeat endpoint is used.

The test must fail against the current installer specifically because `off`
rewrites the collector state.

## 7. Fast command

`package.json` will expose:

```sh
npm run canary:upgrade-test
```

The command will run `sh -n companion/packaging/install.sh` followed by the full
`tests/companion-installer.test.ts` Vitest file. It uses only temporary fixture
directories and exits nonzero on any syntax, preservation, privacy, rollback,
or installer regression.

## 8. Acceptance

- The new test is observed failing for the expected byte-preservation reason
  before the installer changes.
- The narrow installer change makes the new test pass.
- The entire installer integration file passes through the new one-command
  entry point.
- The full repository test suite and TypeScript typecheck pass.
- Git diff contains only the spec, implementation plan, installer, installer
  test, and package-script changes.
- No release metadata, public artifact, Pi, Caddy, installed companion, or
  collection state is changed.

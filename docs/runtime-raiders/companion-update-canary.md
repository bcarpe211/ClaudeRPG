# Runtime Raiders two-sequence update canary

Status: **pending — this record authorizes nothing.** Record aggregate status/timestamps only. Never record prompts, responses, record paths, native IDs, tokens, credentials, or provider fragments.

## Required order

1. build/sign/notarize/staple sequence 1 from its exact clean SHA;
2. separately approve Caddy route preparation and sequence-1 publication;
3. install sequence 1 with collection persistently off;
4. commit `companion/RELEASE` version `0.2.1`, sequence `2`, producing a new SHA;
5. rebuild/review/sign and separately approve sequence-2 publication;
6. observe one notification and matching `raiders status` availability;
7. run `raiders update` manually and verify signing, version, sequence, daemon health, disabled state, enrollment, cursors, and outbox;
8. confirm no second notification for sequence 2;
9. separately authorize a bounded `raiders on` canary;
10. complete one official Codex Desktop root Run and one Codex CLI root Run;
11. verify `codex_desktop` and `codex_cli`, content-free storage, Raid Power, model, and effort; and
12. run `raiders off` before seeking separate office activation.

No step implies the next. Model and effort are display-only; Raid Power is the
score. The manifest and ZIP are never piped or executed.

## Exact clean build and publication prerequisites

On the authorized release host only, first review a clean `HEAD` and tracked
four-line `companion/RELEASE`; set the notarization/signing environment outside
Git, then use this fail-fast block. It is pending evidence, not a command to run
without approval.

```sh
(
  set -eu
  git diff --quiet
  git diff --cached --quiet
  RELEASE_SHA="$(git rev-parse HEAD)"
  scripts/release/build-runtime-raiders-agent.sh --release-sha "$RELEASE_SHA"
  shasum -a 256 dist/install.sh dist/runtime-raiders-agent.zip \
    dist/runtime-raiders-agent.zip.sha256 dist/runtime-raiders-agent.update.json
)
```

Record the clean SHA, sequence, companion version, protocol, four digests, and
sign/notary/staple validation status. Sequence 2 must be a new clean SHA and a
strictly higher sequence. A withdrawal removes only `current`; its immutable
diagnostic directory remains, its v2 sequence is consumed, and recovery needs a
new clean SHA with a strictly higher sequence—not reselection of the withdrawn
v2 release.

## Deterministic off-state notification proof

Publication does not trigger discovery. The daemon checks only at startup when
the persisted last attempt is at least 24 hours old. After sequence-2
publication, keep collection off and record the last-attempt timestamp. At the
recorded 24-hour due boundary, restart exactly the installed launchd job:

```sh
(
  set -eu
  launchctl kickstart -k "gui/$(id -u)/com.redlattice.runtime-raiders-agent"
  raiders status
  raiders doctor
)
```

Accept only one notification and cached sequence-2 availability with disabled
intent. Record restart UTC, due UTC, notification count, and status/doctor
aggregate fields. If the cadence cannot be waited or a test clock is not
separately authorized, stop: do not claim notification evidence, alter state,
or publish again.

## Manual update proof and recovery

Before and after `raiders update`, run `raiders status` and `raiders doctor`.
Record only release identity/update availability, disabled intent, enrollment
present/absent, compatibility reason, cursors/surfaces aggregate, active Run
count, and outbox/queue count. Require the sequence/version/SHA/protocol to
advance, daemon health to be live, and disabled intent plus those preserved
aggregate values to match the pre-update record. The updater automatically
rolls back a failed transaction.

If `raiders update` emits terminal recovery output, stop, preserve only its
aggregate output, and run exactly the emitted stable command—do not improvise
or delete bundles. Its fixed form is:

```sh
"$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.rollback.app/Contents/MacOS/runtime-raiders-agent" __recover-update
```

Only after successful manual proof may a separately approved bounded
`raiders on` produce one official Desktop and one official CLI root Run. Then
run `raiders off`, prove disabled status/doctor, and only then request separate
office activation and routine onboarding.

# Runtime Raiders two-sequence update canary

Status: **pending — this record authorizes nothing.** Record aggregate status/timestamps only. Never record prompts, responses, record paths, native IDs, tokens, credentials, or provider fragments.

Sequence 1 is withdrawn and consumed. Preserve it as immutable evidence; never
reuse, reselect, modify, delete, or repackage it. The authoritative procedure is
[`companion-operations.md`](companion-operations.md); this record applies its
sequence-2 installed-off and sequence-3 manual-update lifecycle.

## Required order

1. preserve withdrawn sequence 1 as immutable evidence;
2. build/sign/notarize/staple sequence 2 from its exact clean SHA;
3. separately approve Caddy route preparation and sequence-2 publication;
4. install sequence 2 with collection persistently off;
5. commit `companion/RELEASE` version `0.2.1`, sequence `3`, producing a new SHA;
6. rebuild/review/sign and separately approve sequence-3 publication;
7. observe one notification and matching `raiders status` availability;
8. run `raiders update` manually and verify signing, version, sequence, daemon health, disabled state, enrollment, cursors, and outbox;
9. confirm no second notification for sequence 3;
10. separately authorize a bounded `raiders on` canary;
11. complete one official Codex Desktop root Run and one Codex CLI root Run;
12. verify `codex_desktop` and `codex_cli`, content-free storage, Raid Power, model, and effort; and
13. run `raiders off` before seeking separate office activation.

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
  RELEASE_SEQUENCE="$(sed -n 's/^release_sequence=//p' companion/RELEASE)"
  RELEASE_OUTPUT="dist/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"
  mkdir -p dist
  test ! -e "$RELEASE_OUTPUT"
  scripts/release/build-runtime-raiders-agent.sh \
    --release-sha "$RELEASE_SHA" --output "$RELEASE_OUTPUT"
  shasum -a 256 "$RELEASE_OUTPUT/install.sh" \
    "$RELEASE_OUTPUT/runtime-raiders-agent.zip" \
    "$RELEASE_OUTPUT/runtime-raiders-agent.zip.sha256" \
    "$RELEASE_OUTPUT/runtime-raiders-agent.update.json"
)
```

Record the clean SHA, sequence, companion version, protocol, four digests, and
sign/notary/staple validation status. Sequence 2 must be a new clean SHA and a
strictly higher sequence than withdrawn sequence 1. Sequence 3 must also use a
new clean SHA and strictly higher sequence. A withdrawal removes only `current`;
its immutable diagnostic directory remains and its sequence is consumed, so
recovery always needs a new clean SHA with a strictly higher sequence—not
reselection of a withdrawn release.

## Deterministic off-state notification proof

Publication does not trigger discovery. The daemon checks only at startup when
the persisted last attempt is at least 24 hours old. After sequence-3
publication, keep collection off. The timestamp is not in status/doctor; read
only the owner-only state file below and print only the derived UTC due time.
At or after that 24-hour due boundary, restart exactly the installed launchd job:

```sh
(
  set -eu
  UPDATE_STATE="$HOME/Library/Application Support/Runtime Raiders/state/update-state.json"
  test -f "$UPDATE_STATE"
  test ! -L "$UPDATE_STATE"
  test "$(stat -f '%u:%Lp' "$UPDATE_STATE")" = "$(id -u):600"
  LAST_ATTEMPT_MS="$(plutil -extract lastCheckAttemptMS raw -o - "$UPDATE_STATE")"
  case "$LAST_ATTEMPT_MS" in ''|*[!0-9]*) exit 1 ;; esac
  test "${#LAST_ATTEMPT_MS}" -le 16
  test "$LAST_ATTEMPT_MS" -le 9007199168340991
  DUE_MS=$((LAST_ATTEMPT_MS + 86400000))
  NOW_MS=$(( $(date +%s) * 1000 ))
  printf 'Runtime Raiders update check due UTC: '
  date -u -r $((DUE_MS / 1000)) '+%Y-%m-%dT%H:%M:%SZ'
  test "$NOW_MS" -ge "$DUE_MS" || {
    printf '%s\n' 'Runtime Raiders update check is not due; refusing restart.' >&2
    exit 1
  }
  launchctl kickstart -k "gui/$(id -u)/com.redlattice.runtime-raiders-agent"
  raiders status
  raiders doctor
)
```

Accept only one notification and cached sequence-3 availability with disabled
intent. Record restart UTC, due UTC, notification count, and status/doctor
aggregate fields. If the cadence cannot be waited or a test clock is not
separately authorized, stop: do not claim notification evidence, alter state,
or publish again.

## Manual update proof and recovery

Before and after the sequence-2-to-sequence-3 `raiders update`, run
`raiders status` and `raiders doctor`.
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

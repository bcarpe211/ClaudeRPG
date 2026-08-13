# Runtime Raiders companion operations

This is the companion-release procedure. Every mutable action is pending until
its separately named approval. It does not authorize signing, publication,
Caddy reload, installation, collection, or office rollout.

## Release contract and approval order

The signed release is a **quartet**: `install.sh`,
`runtime-raiders-agent.zip`, `runtime-raiders-agent.zip.sha256`, and
`runtime-raiders-agent.update.json`. The last is static data, not executable
code. The exact public URLs are `/install.sh`, the ZIP, its checksum, and
`/downloads/runtime-raiders-agent.update.json` under
`https://raiders.redlattice.com`.

Sequence 1 is withdrawn and consumed. Its immutable release directory is
evidence; never reuse, reselect, modify, delete, or repackage it. This recovery
uses a new clean `RELEASE_SHA` with exactly this tracked identity:

```text
version=1
companion_version=0.2.0
release_sequence=2
update_protocol_version=1
```

Version strings do not authorize a downgrade or sequence reuse. The build
signs, notarizes, staples, validates, and transactionally emits all four files.
Record these four separate values only in the restricted operator record:
`INSTALLER_SHA256`, `ZIP_SHA256`, `CHECKSUM_SHA256`, and
`UPDATE_MANIFEST_SHA256`, plus `RELEASE_SEQUENCE`, `COMPANION_VERSION`, and
`UPDATE_PROTOCOL_VERSION`.

Approval order is: Caddy route preparation; recovery sequence-2
build/review/publication; sequence-2 installed-off canary; separately reviewed
and published sequence 3; manual update proof; bounded live provider canary;
then office activation. Passing one gate never implies the next. Caddy
preparation leaves `/var/lib/runtime-raiders/current` absent and all four URLs
return `404`.

## Publish one reviewed quartet

After deployed-server acceptance and a publication approval, put exactly the
four reviewed files in one root-controlled, nonsymlink `SOURCE_DIR` beneath
`/var/lib/runtime-raiders`. From the exact deployed checkout:

```sh
(
  set -eu
  cd "$REPO"
  sudo scripts/pi/runtime-raiders-artifacts.sh publish \
  --source "$SOURCE_DIR" \
  --release-sha "$RELEASE_SHA" \
  --release-sequence "$RELEASE_SEQUENCE" \
  --companion-version "$COMPANION_VERSION" \
  --update-protocol-version "$UPDATE_PROTOCOL_VERSION" \
  --installer-sha256 "$INSTALLER_SHA256" \
  --zip-sha256 "$ZIP_SHA256" \
  --checksum-sha256 "$CHECKSUM_SHA256" \
  --update-manifest-sha256 "$UPDATE_MANIFEST_SHA256"
  sudo scripts/pi/runtime-raiders-artifacts.sh status
)
```

The publisher verifies all four exact HTTPS objects before returning success:

- `/install.sh`, at most 1 MiB;
- `/downloads/runtime-raiders-agent.zip`, at most 128 MiB;
- `/downloads/runtime-raiders-agent.zip.sha256`, at most 4 KiB; and
- `/downloads/runtime-raiders-agent.update.json`, at most 64 KiB.

Each object must return HTTP `200`, match its separately approved SHA-256, and
carry exact `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`
headers. The update manifest must also pass the canonical manifest validator.
The publisher then requires both
`https://raiders.redlattice.com/health` and
`http://127.0.0.1:8080/health` without retaining either body.

Public availability uses bounded retries: at most five attempts, a three-second
connect timeout and 15-second total timeout per attempt, with one second between
failures. Only transport failures and non-`200` status are retried. Size,
digest, header, and canonical-manifest failures after HTTP `200` fail
immediately. Local health has one five-second attempt. Content-free stderr
checkpoints report only fixed labels, attempts, results, and categories; stable
publication status remains on stdout. Never record bodies, raw header blocks,
paths, native IDs, prompts, responses, tokens, credentials, provider fragments,
or environment data.

A publisher verification failure automatically restores the prior selector or,
for a first publication, removes the new first selector. It returns failure
after preserving the failed immutable release and cleaning temporary
verification files. Independent checking is secondary acceptance only: it
cannot override publisher failure or turn a failed publication into success.

After publisher success, independently check the same four objects, approved
digests, required headers, canonical manifest, and both health paths. If this
secondary acceptance fails, first inspect publication status. Withdraw only if
status still selects the exact approved `$RELEASE_SHA`; never withdraw an
unknown selection or a selector that changed out of band.

The artifact command accepts existing v1 releases for recovery/status, but a
new updater-capable publication is v2 and has the quartet metadata. It rejects
duplicate/non-monotonic v2 sequences. A withdrawn v2 release remains immutable
for diagnosis, but its sequence is consumed: recovery requires a new clean SHA
and strictly higher sequence, never reselection of the withdrawn v2 release.
For the secondary-failure case where status still selects the approved SHA, use
only this exact-SHA withdrawal:

```sh
(
  set -eu
  sudo scripts/pi/runtime-raiders-artifacts.sh withdraw --release-sha "$RELEASE_SHA"
  sudo scripts/pi/runtime-raiders-artifacts.sh status
)
```

After a first-selector removal or approved-SHA withdrawal, recovery acceptance
is `unpublished`, all four URLs return `404`, and both health URLs remain `200`.
If the publisher restored a prior selector, require status and all public
verification to match that exact prior release instead. Rollback and withdrawal
change neither Caddy nor Node and do not delete an immutable release directory.

## Install the sequence-2 canary locally and persistently off

Sequence 2 becomes the initial installed-off canary. This controlled canary is
not routine onboarding. After sequence-2 publisher and secondary acceptance and
a distinct installation approval, use a locally downloaded installer: verify
its recorded SHA-256 before execution and execute that local file. Never pipe
the canary installer, ZIP, or manifest to a shell.

```sh
(
  set -eu
  umask 077
  CANARY_INSTALLER="$(mktemp)"
CANARY_CODE_FILE="$(mktemp)"
cleanup_canary_files() { rm -f "$CANARY_INSTALLER" "$CANARY_CODE_FILE"; }
trap cleanup_canary_files EXIT
chmod 0600 "$CANARY_INSTALLER" "$CANARY_CODE_FILE"
CANARY_STATUS="$(curl --fail --silent --show-error --proto '=https' \
  --proto-redir '=https' --max-redirs 0 --connect-timeout 10 --max-time 30 \
  --max-filesize 1048576 --output "$CANARY_INSTALLER" \
  --write-out '%{http_code}' 'https://raiders.redlattice.com/install.sh')"
test "$CANARY_STATUS" = 200
test "$(shasum -a 256 "$CANARY_INSTALLER" | awk '{print $1}')" = "$INSTALLER_SHA256"
/usr/bin/vi "$CANARY_CODE_FILE"
sh "$CANARY_INSTALLER" --code-file "$CANARY_CODE_FILE"
)
```

Require `daemonRunning=true`, `enabled=false`, and `persistedState=disabled`
in `raiders status` and `raiders doctor`. Collection remains persistently off
until the later bounded `raiders on` authorization. The installer validates the
ZIP checksum and signed app before enrollment/replacement; it preserves the
owner-only enrollment, cursors, and outbox across an upgrade or automatic
rollback.

## Already-installed player: manual update only

Sequence 2 is installed locally, digest-verified, and persistently off; it is not
the update target. The manual `raiders update` proof moves to reviewed and
published sequence 3 under separately named build, publication, and proof
approvals.

For an already-installed player, use only `raiders update`.
Do not run or pipe an installer, ZIP, or manifest. The foreground command
fetches the exact manifest and ZIP, verifies the fixed HTTPS origin, digest,
safe ZIP, notarized signed identity, embedded version/sequence/SHA/protocol,
and offline health before atomic replacement. It refuses an active Run or an
unsafe/incompatible/stale/non-newer manifest; collection state, enrollment,
cursors, and outbox survive update and rollback.

Release discovery makes only an anonymous static GET while collection is off to
the trusted game server's fixed update-manifest URL—no query,
cookies, token, device/player/provider/usage data, redirects, or additional
provider telemetry. Local update state and the privacy record hold aggregate
status/timestamps and validated public release fields only. `raiders status`
shows availability and the exact `raiders update` instruction; model and effort
are display-only metadata, while Raid Power is the score.

## Routine office installation after every prior gate passes

Routine new-office-player onboarding is deliberately a different contract. Only
after all rollout gates and a separate office-activation approval, use this
one-line fixed-origin command:

```sh
curl --fail --silent --show-error https://raiders.redlattice.com/install.sh | /bin/sh
```

The installer prompts privately for its enrollment code. It does not authorize
collection; office activation remains separate. Codex Desktop and Codex CLI are
the only official supported roots. Do not claim provider support or fairness
from model/effort display fields; Claude Code and Omp remain unsupported.

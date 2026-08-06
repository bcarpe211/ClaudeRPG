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

Build from the exact clean `RELEASE_SHA`. `companion/RELEASE` is tracked and
has four exact lines: its format version, companion version, monotonic release
sequence, and update protocol version. Sequence 1 and sequence 2 have distinct
reviewed commits and immutable release directories; version strings do not
authorize a downgrade. The build signs, notarizes, staples, validates, and
transactionally emits all four files. Record these four separate values only in
the restricted operator record: `INSTALLER_SHA256`, `ZIP_SHA256`,
`CHECKSUM_SHA256`, and `UPDATE_MANIFEST_SHA256`, plus `RELEASE_SEQUENCE` and
`COMPANION_VERSION`.

Approval order is: Caddy route preparation; sequence-1 publication;
sequence-1 installed-off canary; sequence-2 build/review/publication; manual
update proof; bounded live provider canary; then office activation. Passing one
gate never implies the next. Caddy preparation leaves
`/var/lib/runtime-raiders/current` absent and all four URLs return `404`.

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
  --installer-sha256 "$INSTALLER_SHA256" \
  --zip-sha256 "$ZIP_SHA256" \
  --checksum-sha256 "$CHECKSUM_SHA256" \
  --update-manifest-sha256 "$UPDATE_MANIFEST_SHA256"
  sudo scripts/pi/runtime-raiders-artifacts.sh status
)
```

Independently download the four URLs and require each recorded digest, HTTP
`200`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`; also
require `/health` to be `200`. Record aggregate statuses, headers, digests, and
UTC time only—not contents, source paths, native IDs, prompts, responses,
tokens, credentials, provider fragments, or environment data.

The artifact command accepts existing v1 releases for recovery/status, but a
new updater-capable publication is v2 and has the quartet metadata. It rejects
duplicate/non-monotonic v2 sequences. A withdrawn v2 release remains immutable
for diagnosis, but its sequence is consumed: recovery requires a new clean SHA
and strictly higher sequence, never reselection of the withdrawn v2 release. On a
publication, digest, header, or health failure, withdraw only the exact active
release:

```sh
(
  set -eu
  sudo scripts/pi/runtime-raiders-artifacts.sh withdraw --release-sha "$RELEASE_SHA"
  sudo scripts/pi/runtime-raiders-artifacts.sh status
)
```

Recovery acceptance is `unpublished`, all four URLs return `404`, and both
internal health URLs remain `200`. Withdrawal changes neither Caddy nor Node
and does not delete an immutable release directory.

## Install the sequence-1 canary locally and persistently off

This controlled installed-off canary is not routine onboarding. After
sequence-1 publication acceptance and a distinct installation approval, use a
locally downloaded installer: verify its recorded SHA-256 before execution and
execute that local file. Never pipe the canary installer, ZIP, or manifest to a shell.

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

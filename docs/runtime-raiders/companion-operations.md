# Runtime Raiders companion operations

The release sequence is fail-closed: build and validate the signed triplet;
prepare the empty Caddy store at `/var/lib/runtime-raiders`; complete production
cutover and deployed-server acceptance; separately publish and verify the
triplet; separately install one persistently-off canary; separately activate
that canary; and only then authorize routine office installation and activation.
Preparation leaves `/var/lib/runtime-raiders/current` absent and requires all
three exact artifact URLs to return HTTP `404`.

## Build and validate the signed triplet

For a release host, require `RUNTIME_RAIDERS_CODESIGN_IDENTITY`,
`RUNTIME_RAIDERS_NOTARY_PROFILE`, and the validated
`RUNTIME_RAIDERS_TEAM_ID`, then run
`scripts/release/build-runtime-raiders-agent.sh`. The build creates arm64 and
x86_64 binaries, combines a universal executable in a minimal app, signs with
hardened runtime and secure timestamp, strictly verifies, notarizes with
`notarytool --wait`, staples and validates the app, then repeats the same
designated-requirement verification before recreating the ZIP and SHA-256.

Its ZIP, checksum, and installer replacement is transactional, restoring any
prior complete pair and any prior standalone installer if replacement fails.
Standalone binaries cannot be stapled. The checked-in installer is fail-closed
until the release build renders its literal Team ID; installed artifacts verify
the exact bundle identifier, Apple Developer ID chain, Developer ID Application
extensions, and leaf certificate Team ID.

The build script does not publish. Record separate SHA-256 values for the
rendered installer, ZIP, and checksum file in the restricted operator record.
Keep every companion absent while the server is changed and accepted.

## Publish only after deployed-server acceptance

After server acceptance and exact artifact-publication approval, copy the
validated triplet to one root-controlled, nonsymlink `SOURCE_DIR` beneath
`/var/lib/runtime-raiders` on the Pi. It contains exactly `install.sh`,
`runtime-raiders-agent.zip`, and `runtime-raiders-agent.zip.sha256`. From the
exact deployed checkout, bind publication to the full release SHA and all three
recorded digests:

```sh
cd "$REPO"
sudo scripts/pi/runtime-raiders-artifacts.sh publish \
  --source "$SOURCE_DIR" \
  --release-sha "$RELEASE_SHA" \
  --installer-sha256 "$INSTALLER_SHA256" \
  --zip-sha256 "$ZIP_SHA256" \
  --checksum-sha256 "$CHECKSUM_SHA256"
sudo scripts/pi/runtime-raiders-artifacts.sh status
```

Download `https://raiders.redlattice.com/install.sh`,
`https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip`, and
`https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256`
independently. Require each response digest to equal its separate recorded
value. Require `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff` on all three responses and HTTP `200` from
`https://raiders.redlattice.com/health`. Record only digests, response statuses,
headers, and UTC time—never contents, source paths, environment contents,
tokens, or enrollment codes. Publication does not authorize installation.

On any publication, digest, header, or health failure, withdraw only the exact
active release:

```sh
sudo scripts/pi/runtime-raiders-artifacts.sh withdraw \
  --release-sha "$RELEASE_SHA"
sudo scripts/pi/runtime-raiders-artifacts.sh status
```

Withdrawal acceptance requires `status` to report `unpublished`, all three
artifact URLs to return HTTP `404`, and both internal health routes to remain
HTTP `200`. Publication and withdrawal do not reload Caddy or restart Node.
They do not alter scoring, the database, or immutable release directories.

## Install the first canary locally and persistently off

After publication acceptance and a separate installation approval, the canary
owner obtains a fresh one-time code. The locally downloaded installer must be
stored in an owner-only temporary file; verify its SHA-256 against
`INSTALLER_SHA256` before execution, then execute only that verified local
installer. Do not use the routine pipe-to-shell command for the first canary.

```sh
CANARY_INSTALLER="$(mktemp)"
chmod 0600 "$CANARY_INSTALLER"
curl -fsS https://raiders.redlattice.com/install.sh -o "$CANARY_INSTALLER"
test "$(shasum -a 256 "$CANARY_INSTALLER" | awk '{print $1}')" = \
  "$INSTALLER_SHA256"
sh "$CANARY_INSTALLER" --code "$ONE_TIME_CODE"
```

The installer downloads only
`https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip` and its
adjacent `.sha256`. It validates both SHA-256 and the strict code signature
before it exchanges a previously unused code or replaces the installed app.
Installation must finish with `daemonRunning=true`, `enabled=false`, and
`persistedState=disabled`; verify with `raiders status` and `raiders doctor`.
Do not run `raiders on` until a later canary-activation approval.

The stapled app is installed at
`~/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app`.
The private enrollment JSON, cursors, and outbox are owner-only under the same
support directory. The per-user LaunchAgent is exactly
`com.redlattice.runtime-raiders-agent`, and calls the app's inner
`runtime-raiders-agent` executable without placing credentials in launchd.

The installer reuses its recorded, owner-owned command symlink across upgrades;
if a user has replaced that link, it leaves the replacement alone and chooses
the first writable, owner-owned existing PATH directory instead. If none exists,
it creates `~/.local/bin` and appends exactly
`export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path` to
`~/.zprofile`. Upgrades preserve enrollment, cursors, and queued events. Any
post-backup install failure restores the prior app, launch agent, shim, command
state, and owned profile marker; a newly issued private enrollment is retained
so a retry does not consume a second one-time code.

Run `raiders uninstall` to remove the companion. Its owner-only shim asks a
live daemon to persist off and stop; only a genuinely absent socket permits
fallback bootout. It removes its own plist, app, support state, command symlink,
and exact PATH marker without affecting neighboring profile content or a
user-replaced command link. It never uses sudo, package managers, provider
directories, provider configuration, telemetry, or environment edits.

## Routine office installation after every prior gate passes

The following convenience form is allowed only after Caddy preparation,
production cutover, deployed-server acceptance, three-digest publication,
installed-off acceptance, live-canary acceptance, and separate office
activation approval have all passed:

```sh
curl -fsSL https://raiders.redlattice.com/install.sh | \
  sh -s -- --code "$ONE_TIME_CODE"
```

Office activation remains independent: installation alone does not authorize
`raiders on`. Claude Code and Omp remain disabled and unsupported.

# Runtime Raiders companion operations

Install the private companion with a one-time code:

    curl -fsSL https://raiders.redlattice.com/install.sh | sh -s -- --code <one-time-code>

The installer downloads only
`https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip` and its
adjacent `.sha256`. It validates both the SHA-256 and strict code signature
before it exchanges a previously unused code or replaces the installed app.

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

For a release host, require `RUNTIME_RAIDERS_CODESIGN_IDENTITY`,
`RUNTIME_RAIDERS_NOTARY_PROFILE`, and the validated
`RUNTIME_RAIDERS_TEAM_ID`, then run
`scripts/release/build-runtime-raiders-agent.sh`. The build creates arm64 and
x86_64 binaries, combines a universal executable in a minimal app, signs with
hardened runtime and secure timestamp, strictly verifies, notarizes with
`notarytool --wait`, staples and validates the app, then repeats the same
designated-requirement verification before recreating the ZIP and SHA-256.
Its ZIP, checksum, and installer replacement is transactional, restoring any
prior complete pair (and any prior standalone installer) if replacement fails.
Standalone binaries cannot be stapled. The script does not
publish; a separate approved operation may later place the ZIP and checksum at
the documented downloads URL. The checked-in installer is fail-closed until the
release build renders its literal Team ID; installed artifacts verify the exact
bundle identifier, Apple Developer ID chain, Developer ID Application
extensions, and leaf certificate Team ID.

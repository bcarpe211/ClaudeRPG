Install or reinstall:
curl -fsSL https://raiders.redlattice.com/install.sh | sh

Turn collection on:
raiders on

Check it:
raiders status

Check for an update:
raiders update

Turn collection off:
raiders off

# Runtime Raiders employee beta

The installer starts a new employee with collection off. A reinstall keeps that
employee's enrollment, queued metrics, cursors, and previous on/off choice.
Publishing a release never turns collection on for anyone.

## Run the one-shot live acceptance gate

This is an operator check for a newly installed beta, not an employee install
step. Quit Codex completely so it stops changing the provider-history files.
From the clean reviewed checkout, run:

```sh
/bin/bash scripts/test/run-runtime-raiders-live-activation-gate.sh
```

The script waits for 60 seconds of quiet provider-file metadata, requires at
least 816 existing records, checks the installed Apple signature and
Gatekeeper result, checks that the game is paused and its database is healthy,
and records aggregate Run and score baselines. It then turns collection on,
proves that history created no server changes, creates one content-free
synthetic Codex Desktop completion, and requires exactly one matching scored
Run.

On success, failure, or interruption, the script removes only its uniquely
named synthetic fixture and always runs `raiders off` before returning. It
writes a secret-free, owner-only report at
`/private/tmp/runtime-raiders-activation-gate-<timestamp>.<random>`. Reopen
Codex after the command finishes and use that report for the gate record. If
the script reports a failure, do not continue to the reinstall or publication
gate.

## Release a beta

Use a clean, reviewed Git commit on a Mac with Apple release access. Set these
three signing environment variables in the operator's shell; do not put their
values in the repository or this document:

- `RUNTIME_RAIDERS_CODESIGN_IDENTITY`
- `RUNTIME_RAIDERS_NOTARY_PROFILE`
- `RUNTIME_RAIDERS_TEAM_ID`

The release account defaults to `rluser`. Set `RUNTIME_RAIDERS_RELEASE_USER` if
the Pi uses a different existing POSIX account. The Pi target defaults to that
user at `raiders.local`. If necessary, set `RUNTIME_RAIDERS_RELEASE_HOST` to a
different `user@host`; its user must exactly match
`RUNTIME_RAIDERS_RELEASE_USER`. Use the same release-user setting for the
one-time bootstrap and every later `prepare` or `publish` command.

If the selected release host requires the corporate network, stop and ask the
operator to connect the corporate VPN. Do not start or stop a VPN automatically.

Before every publication, prove the exact candidate locally without SSH, Caddy,
or a public download:

```sh
/bin/bash scripts/release/install-runtime-raiders-local-canary.sh
```

This command runs the normal local `prepare`, installs its exact ZIP through the
production installer, and requires the expected version, enabled managed
service, running daemon, disabled collection, zero active Runs, and zero queued
events. It requires valid existing enrollment so it cannot enroll or contact the
enrollment endpoint, and collection remains off so it cannot upload telemetry.
It never publishes or validates the public server paths. The installed service
retains its normal informational once-daily `/version` check. Do not run
`publish` until this command passes.

### One-time Pi bootstrap

Before the first 0.4.0 publication, Task 7 requires a separate authorization to
run this once on the Pi checkout:

```sh
/usr/bin/sudo -n /usr/bin/env RUNTIME_RAIDERS_RELEASE_USER=rluser /bin/bash scripts/pi/setup-caddy.sh runtime-raiders-beta-bootstrap
```

Run that one-time command from the Pi checkout. The bootstrap itself runs as
root because it must inspect the protected sudoers directory; `rluser` remains
the unprivileged account authorized for later releases. The named account must
already exist on the Pi. Caddy with its Cloudflare DNS
module must already be installed. Its manager-loaded unit must start and reload
using exactly `/etc/caddy/Caddyfile` and load exactly
`/etc/caddy/cloudflare.env`. That environment file must be a single-link,
root-owned, root-group regular file with mode `0600`. The command checks those
preconditions before any change and again after reload. It then transactionally
validates and installs the new Caddy configuration and installs the reviewed
publisher as the root-owned fixed program
`/usr/local/sbin/runtime-raiders-publish`, validates and installs this narrow
sudo rule for the named account, validates the installed Caddy file, reloads
Caddy, requires the service to be active, and checks both public health
hostnames. A failed replacement, validation, reload, or health check restores
the prior files and reloads the prior Caddy configuration:

```text
RELEASE_USER ALL=(root) NOPASSWD: /usr/local/sbin/runtime-raiders-publish /var/lib/runtime-raiders/staging/release-*
```

`RELEASE_USER` above means the exact validated value of
`RUNTIME_RAIDERS_RELEASE_USER`; it is rendered into the root-owned sudoers file.

This is a separately approved one-time migration; do not combine it with normal
publication authorization. If it has not happened, `publish` fails closed when
the fixed program or `sudo -n` permission is unavailable. The SSH account uses
key authentication. After bootstrap, every repeat release uses one SSH session
and one non-interactive invocation of only that fixed publisher. Normal
`publish` never installs code or configuration and never validates, reloads, or
restarts Caddy.

First build, sign, notarize, staple, and verify locally:

```sh
/bin/bash scripts/release/release-runtime-raiders-beta.sh prepare
```

Success ends with:

```text
Prepared Runtime Raiders 0.4.0 locally.
Nothing was published or installed.
To publish after approval, run:
/bin/bash scripts/release/release-runtime-raiders-beta.sh publish
```

After publication is separately approved, run:

```sh
/bin/bash scripts/release/release-runtime-raiders-beta.sh publish
```

`publish` repeats local verification, builds if the matching local output is
missing, seals one bounded transmission with embedded expected hashes, opens
one SSH session to the fixed publisher, publishes the ZIP and installer,
publishes `version` last, and reads the four public endpoints. Its final summary shows
the version, Git SHA, three public release URLs, and `Employee collection
remains off.` It does not install on a Mac, enable collection, reload Caddy,
restart Node, deploy the game, change scoring, change the pause state, or touch
the database.

## If publication fails

The public `version` file is replaced last. A failure before that point leaves
the previous version visible, so employee clients are not told that the failed
release is ready. Fix the local or SSH error and run `publish` again; every
attempt uses a new owner-only remote staging directory.

Keep each verified `dist/runtime-raiders-beta-VERSION` directory with the Git
commit that produced it. To roll back, check out that prior clean commit in a
separate worktree, restore its retained release directory at the matching
deterministic `dist` path, and run `publish`. The verifier must accept the prior
directory before it can be republished. Rollback still does not enable anyone's
collector.

## Employee beta result — GO (2026-08-20)

- Version `0.4.0` was built from Git SHA
  `932bfbc210beeffe550c02be23cb6c759695a55d` as one signed app. Apple
  notarization, stapling, designated-requirement validation, and Gatekeeper
  acceptance passed.
- The public installer, ZIP, and `/version` bytes matched the verified local
  release. Required no-store and content-type headers passed, and `/health`
  returned the expected response.
- The exact employee command completed a flat reinstall at the stable app path.
  Enrollment and collector state were preserved, the outbox remained empty,
  and no installer residue remained.
- The live acceptance gate scanned 858 existing provider-history records,
  uploaded no history, scored exactly one synthetic completion as one Run, and
  turned collection off. This exceeds the 816-record acceptance requirement.
- Installed `status`, `doctor`, `update`, and `off` passed. With the server path
  unavailable, `doctor` returned a valid report with `serverHealthy=false`
  instead of timing out. Final state was disabled with zero active Runs and
  zero queued events.
- Employee installation is **GO**. Publishing and installation did not enable
  collection or mutate the game database. Background-item branding and Apple
  developer-identity presentation remain separate follow-up work before a
  wider polished rollout.

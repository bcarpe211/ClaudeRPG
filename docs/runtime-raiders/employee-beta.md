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

### One-time Pi bootstrap

Before the first 0.4.0 publication, Task 7 requires a separate authorization to
run this once on the Pi checkout:

```sh
RUNTIME_RAIDERS_RELEASE_USER=rluser /bin/bash scripts/pi/setup-caddy.sh runtime-raiders-beta-bootstrap
```

The named account must already exist on the Pi. Caddy with its Cloudflare DNS
module and the protected Cloudflare environment file must also already exist.
That command transactionally validates and installs the new Caddy configuration,
installs the reviewed publisher as the root-owned fixed program
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

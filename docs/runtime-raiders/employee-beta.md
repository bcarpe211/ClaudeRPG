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
three environment variables in the operator's shell; do not put their values in
the repository or this document:

- `RUNTIME_RAIDERS_CODESIGN_IDENTITY`
- `RUNTIME_RAIDERS_NOTARY_PROFILE`
- `RUNTIME_RAIDERS_TEAM_ID`

The Pi target defaults to `rluser@raiders.local`. If necessary, set
`RUNTIME_RAIDERS_RELEASE_HOST` to another `user@host` value. The SSH account
must use key authentication and be allowed to run the root publisher with
non-interactive sudo. This keeps publication to one SSH/sudo authorization and
one session.

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
missing, opens one SSH session, publishes the ZIP and installer, publishes
`version` last, and reads the four public endpoints. Its final summary shows
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

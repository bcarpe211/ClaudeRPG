# Runtime Raiders Caddy Artifact Publication Design

**Date:** 2026-08-03

**Status:** Approved design; implementation pending

**Scope:** Fail-closed hosting and atomic publication of the signed Runtime
Raiders macOS companion triplet on the existing internal Caddy service

## Goal

Provide the three companion release files at their documented internal HTTPS
URLs without coupling downloads to the Node game process or exposing a partial,
unreviewed, or mismatched release.

The serving mechanism is installed before the final cutover preflight while no
release is selected. It must return `404` for all three paths in that state.
After deployed-server acceptance and separate publication authorization, one
root-only operation verifies and atomically selects the exact approved triplet.

## Published files

The release contains exactly these files and public paths:

| File in the release store | HTTPS path |
| --- | --- |
| `install.sh` | `/install.sh` |
| `downloads/runtime-raiders-agent.zip` | `/downloads/runtime-raiders-agent.zip` |
| `downloads/runtime-raiders-agent.zip.sha256` | `/downloads/runtime-raiders-agent.zip.sha256` |

No directory index, wildcard download route, arbitrary filename, or repository
directory is published.

## Release-store layout

Caddy reads from this fixed root-owned layout:

```text
/var/lib/runtime-raiders/
├── current -> releases/<40-character release SHA>
└── releases/
    └── <40-character release SHA>/
        ├── .release-manifest
        ├── install.sh
        └── downloads/
            ├── runtime-raiders-agent.zip
            └── runtime-raiders-agent.zip.sha256
```

`/var/lib/runtime-raiders`, `releases`, each release directory, and `downloads`
are nonsymlink directories owned by `root:root` with mode `0755`. The three
published files are nonsymlink regular files owned by `root:root` with mode
`0644`.
Each release also contains a nonsymlink, root-only `.release-manifest` with mode
`0600`. It records only:

```text
version=1
release_sha=<40 lowercase hexadecimal characters>
installer_sha256=<64 lowercase hexadecimal characters>
zip_sha256=<64 lowercase hexadecimal characters>
checksum_sha256=<64 lowercase hexadecimal characters>
```

The manifest is not matched by any Caddy handler and cannot be read by Caddy's
service user.
`current` is a root-owned relative symlink created only by the publication
command. Caddy's existing unprivileged service user can traverse and read the
selected release but cannot modify the store.

Release directories are immutable after creation. An existing release SHA may
be selected again only when all three stored files still match the approved
digests; it is never overwritten in place.

## Caddy routing

The existing two-host Caddy site remains the only site. It gains exact path
handlers for the three release URLs before the fallback reverse proxy.

Each release handler:

- uses `/var/lib/runtime-raiders/current` as its file root;
- serves only its literal request path;
- sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`;
- sends `text/x-shellscript; charset=utf-8` for the installer,
  `application/zip` for the archive, and `text/plain; charset=utf-8` for the
  checksum file;
- does not enable Caddy directory browsing; and
- returns `404` when `current` or the selected file is absent.

All other requests continue through the single existing
`reverse_proxy localhost:8080`. The hostnames, Cloudflare DNS-01 configuration,
public-resolver override, certificate behavior, and internal-only network
boundary remain unchanged.

The Caddy configuration is installed and reloaded under its own recorded
authorization after the exact release SHA is available but before final
preflight. At that time `current` must be absent. The preparation gate requires:

1. manager-context Caddy validation;
2. successful reload with Caddy remaining active;
3. HTTP `200` health through both internal hostnames;
4. HTTP `404` from all three release URLs; and
5. an unchanged, healthy Node game service.

Any preparation failure restores the previously recorded Caddy configuration,
reloads it, and leaves the artifact store unpublished.

## Root-only release command

`scripts/pi/runtime-raiders-artifacts.sh` owns the release-store state. It has
three commands:

```text
runtime-raiders-artifacts.sh publish \
  --source DIR \
  --release-sha SHA \
  --installer-sha256 SHA256 \
  --zip-sha256 SHA256 \
  --checksum-sha256 SHA256

runtime-raiders-artifacts.sh status

runtime-raiders-artifacts.sh withdraw --release-sha SHA
```

The production root is fixed at `/var/lib/runtime-raiders`. Tests may substitute
a temporary root only when `RUNTIME_RAIDERS_TEST_MODE=1`, using
`RUNTIME_RAIDERS_ARTIFACT_ROOT` for the temporary path. The script is not setuid
and a non-root process gains no privilege from those values.

Every command requires effective UID `0` and refuses to operate unless its
managed root and state have the expected type and ownership. The script never
reads the Caddy token, game environment, database, enrollment code, provider
data, or user content.

### Publish validation

Before changing `current`, `publish` requires:

- one lowercase 40-character Git release SHA;
- three lowercase 64-character expected SHA-256 values;
- the three exact source filenames and no source symlink at any component;
- regular, nonempty source files;
- an installer with its signing Team ID placeholder removed and the documented
  Runtime Raiders artifact and checksum URLs intact;
- a checksum file containing exactly one line in the form
  `<approved ZIP digest>  runtime-raiders-agent.zip`, terminated by one newline;
  and
- calculated source digests matching all three approved values.

macOS signing, notarization, stapling, Gatekeeper, and universal-architecture
checks remain required pre-publication evidence. The Linux publication command
does not attempt to reproduce macOS trust validation; it binds the copied bytes
to the already accepted digests.

### Atomic publication

For a new release SHA, `publish` performs these steps on the release-store
filesystem:

1. Create a root-only temporary staging directory beneath the managed root.
2. Create the final nested layout inside staging.
3. Copy each source to its exact destination with the final owner and mode.
4. Recalculate every staged digest and revalidate the checksum-file contract.
5. Write and re-read the root-only version-1 release manifest.
6. Atomically rename the complete staged directory to
   `releases/<release SHA>`.
7. Create a temporary relative selector symlink to that immutable directory.
8. Atomically rename the selector over `current`.
9. Print only the active release SHA and the three content digests.

Until step 8, the previous release remains selected or all download paths remain
unpublished. A validation, copy, permission, rename, or selector failure removes
only the incomplete staging state and never changes `current`.

If `releases/<release SHA>` already exists, `publish` verifies its exact types,
ownership, modes, checksum contract, and three digests. A complete match may be
selected atomically; any mismatch fails without modification.

### Status and withdrawal

`status` is read-only and reports either `unpublished` or the selected full
release SHA plus the three current digests. It validates those bytes against the
root-only manifest and fails on an unexpected selector, unsafe filesystem type,
ownership mismatch, incomplete triplet, malformed manifest, or digest mismatch.

`withdraw --release-sha SHA` succeeds only when `current` is a managed relative
symlink selecting that exact SHA. It deliberately remains available when the
selected files or manifest are damaged, because withdrawal is the fail-closed
recovery action. It atomically removes only the selector. All three URLs return
`404`; the immutable release directory remains available for inspection or a
separately authorized reselection.

## Release sequence

1. Implement and test the Caddy handlers, artifact command, preflight checks,
   and documentation.
2. Freeze the final repository SHA and rebuild, sign, notarize, staple, and
   validate the companion triplet from that SHA.
3. Record the rendered installer, ZIP, and checksum-file SHA-256 values.
4. Hold the updater and publish the exact repository SHA under their existing
   separate approvals.
5. Separately authorize the fail-closed Caddy preparation, with no `current`
   selector and all three URLs verified `404`.
6. Run the final read-only preflight, which verifies the reviewed Caddy file,
   safe artifact-store root, absent selector, and the three external `404`
   responses.
7. Separately authorize and execute the production server cutover while every
   companion remains absent.
8. Complete deployed-server acceptance.
9. Separately authorize `publish` for the exact release and three digests.
10. Verify each HTTPS response against its separately recorded digest and
    confirm the game health route remains `200`.
11. Separately authorize the installed-off canary, live canary, and office
    activation in their existing order.

Copying the triplet to an operator-controlled temporary source directory on the
Pi is part of the artifact-publication authorization. It does not select or
serve any file until the single successful `publish` operation completes.

## Preflight and acceptance changes

The read-only Runtime Raiders preflight gains an explicit artifact-root input.
Before production cutover it verifies:

- the managed root and `releases` directory are root-owned nonsymlink
  directories with mode `0755`;
- `current` is absent;
- the active Caddy configuration exactly matches the reviewed release object;
- all three download paths return `404` through the intended internal host; and
- existing health, DNS, TLS, game, database, policy, updater, and Git gates
  remain unchanged.

Post-publication acceptance records only the active release SHA, three digests,
HTTP statuses, headers, and UTC timestamps. It never records artifact contents,
tokens, enrollment codes, source paths, or Caddy environment contents.

## Test strategy

### Caddy contract tests

- Assert the two existing hostnames remain in one site.
- Assert the three literal path matchers and fixed release root.
- Reject wildcard download matchers, directory browsing, extra sites, extra
  upstreams, or a second reverse proxy.
- Assert `no-store`, `nosniff`, and the fallback to `localhost:8080`.

### Artifact-command tests

Run the real shell script against isolated temporary release roots and real test
files. Cover:

- successful first publication and exact store layout;
- calculated digest and canonical checksum-file verification;
- root-only manifest creation and subsequent status verification;
- incomplete, empty, malformed, symlinked, and digest-mismatched inputs;
- root, directory, file, mode, and selector safety checks;
- failure preserving an absent selector or the previously active release;
- immutable existing-release acceptance and mismatch rejection;
- content-free `status` for published and unpublished states; and
- exact-SHA withdrawal leaving immutable files intact, including withdrawal of
  a selected release whose stored files have become invalid.

Every behavior change follows a failing-test-first cycle.

### Preflight and documentation tests

- Require the safe empty store and three `404` responses before cutover.
- Reject a preselected, unsafe, missing, or permission-widened artifact root.
- Preserve the preflight's read-only command contract.
- Keep cutover documentation, the authorization packet, canary checklist, and
  companion operations aligned with the separate Caddy preparation,
  publication, installation, canary, and office approvals.

## Failure and rollback behavior

- Caddy preparation failure restores the prior config and never creates
  `current`.
- Publication failure leaves the prior selector unchanged.
- A bad HTTPS digest blocks installation and triggers `withdraw` for the exact
  active SHA.
- Withdrawal affects downloads only; it does not restart Caddy or Node, change
  scoring, alter the database, or delete a release.
- Caddy or game-health regression after publication triggers withdrawal first,
  followed by the separately authorized server/Caddy rollback procedure when
  needed.

## Deferred custom 404 page

A branded Runtime Raiders 404 page is useful for humans following an invalid or
not-yet-published link, but it is not part of this release. The first
publication mechanism deliberately keeps plain status-only `404` responses so
fail-closed tests remain unambiguous and do not add another asset dependency to
the cutover. A later design may add a custom page while preserving the same
status code, exact route boundary, and no-cache behavior.

## Non-goals

- No public ingress, Cloudflare Tunnel, object storage, CDN, package manager,
  Homebrew formula, `.pkg`, or `.dmg` work.
- No artifact serving from Node, Git, or the web application's static directory.
- No automatic publication during build, push, pull, service start, Caddy
  reload, or production cutover.
- No companion installation or activation as part of publication.
- No deletion or retention automation for old immutable releases in this first
  version.

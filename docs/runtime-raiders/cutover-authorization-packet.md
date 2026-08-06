# Runtime Raiders cutover authorization packet

Status: **NO-GO — preparation only**

Evidence status: **pending fresh verification against the final release SHA**

This packet is the content-free decision surface for the first Runtime Raiders
release. It does not authorize updater, repository, Caddy, Pi, database,
service, artifact-publication, companion, canary, or office changes. Keep
secrets, internal addresses, enrollment codes, tokens, environment contents,
provider paths, and user content in neither this file nor Git.

Approved design and local test evidence dated 2026-08-03 or earlier may support
preparation. It does not prove mutable production, network, final-build, or Mac
state. Every operational fact below must be freshly recorded outside Git at its
named boundary.

## Approved release sequence

1. Implement and test the publication mechanism, freeze the final release SHA,
   rebuild its signed quartet, and finish pre-cutover validation with no Runtime
   Raiders companion installed.
2. Separately authorize and verify the updater hold.
3. Separately authorize publication and fetching of the exact release SHA.
4. Separately authorize fail-closed Caddy preparation with only the empty
   `/var/lib/runtime-raiders` store and no `current` selector.
5. Run the final read-only preflight and require all four artifact URLs to
   remain `404`.
6. Separately authorize the recorded production cutover while all collectors
   remain absent.
7. Accept the deployed server through sections 5.1 and 5.2 of the runbook.
8. Separately authorize sequence-1 quartet publication and independently verify
   all four HTTPS digests.
9. Separately authorize sequence-1 installation on one canary and prove its
   daemon is live but collection is persistently off.
10. Separately approve the reviewed sequence-2 quartet publication.
11. Separately authorize the manual `raiders update` proof while still off.
12. Separately authorize the bounded live provider canary, then require
   `raiders off` before seeking office activation.
13. Separately authorize office activation only after canary acceptance.

## Recorded candidate and prior state

Fill every value with fresh evidence in the restricted operator record. Do not
copy secrets, environment contents, internal addresses, or enrollment codes
into this packet.

| Item | Recorded value/status |
| --- | --- |
| Prior production SHA / short version | `________________ / ________________` |
| Final release SHA / short version | `________________ / ________________` |
| Production checkout and tracked `origin/main` | `pending fresh verification` |
| Production database integrity / pause | `pending fresh verification` |
| Updater timer / oneshot | `pending separate updater-hold approval` |
| Candidate environment path / SHA-256 | `________________ / ________________` |
| Persisted scoring policy | `raid-power-v1`; JSON document version `1` |
| Enabled Run surfaces | `codex_desktop,codex_cli` only |
| Final rendered installer SHA-256 | `________________________________________________________________` |
| Final signed ZIP SHA-256 | `________________________________________________________________` |
| Final checksum-file SHA-256 | `________________________________________________________________` |
| Final update-manifest SHA-256 | `________________________________________________________________` |
| Release sequence / companion version | `________________ / ________________` |
| Final signed artifact validation | `pending final build and host validation` |
| Final server / companion tests | `pending final release SHA` |
| Internal FQDN/TLS and office-path mDNS/SSH/HTTP | `pending fresh verification` |
| Caddy loaded config / environment paths | `________________ / ________________` |
| Prior Caddy config backup path / SHA-256 | `________________ / ________________` |
| Caddy file protection | `pending fresh verification` |
| Artifact root / selector | `/var/lib/runtime-raiders` / `current must be absent before cutover` |
| Game service contract | `pending fresh manager-loaded verification` |
| Rollback record contract | version `2`; `GAME_EXEC_PATH=/home/rluser/ClaudeRPG/scripts/pi/run-server.sh` |
| Runtime Raiders installation before cutover | `pending fresh absence check` |
| Legacy ClaudeRPG OTel variables | `pending fresh absence check` |
| Visual review | `pending final review; branded 404 explicitly deferred` |

The branded Runtime Raiders 404 page is not an asset dependency for this
release. The required unpublished state is the plain HTTP `404` behavior of the
four exact artifact routes, including
`https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json`.

Both aborted version-1 rollback sets are evidence only and cannot be used for
the next cutover. Create and authenticate a new rollback record version `2` for
the newly authorized cutover window.

## Current blockers before cutover authorization

- [ ] Create the root-owned `0600` candidate environment with the exact approved
      timestamp, policy, allowlist, secrets, and compatibility values; record
      only its SHA-256 and metadata.
- [ ] Freeze the final release SHA, rebuild/re-notarize its companion quartet,
      and record all four final digest values plus `companion/RELEASE` sequence.
- [ ] Complete fresh final-release automated, signing, privacy, visual, network,
      database, service, and companion-absence evidence.
- [ ] Authorize and complete the updater hold before publishing the exact SHA to
      tracked `origin/main`.
- [ ] Separately authorize Caddy preparation; record the prior Caddy config
      backup and checksum outside Git, install the reviewed Caddyfile, validate
      with the manager-loaded environment, reload, verify two health `200`
      responses and four artifact `404` responses, and leave `current` absent.
- [ ] Run the exact release object's read-only Pi preflight with
      `--artifact-root /var/lib/runtime-raiders` after Caddy preparation.
- [ ] Choose and record one 13-digit `CUTOVER_AT`, UTC window, backup target,
      rollback-record paths, and independently copied seal checksum.
- [ ] Obtain explicit production-cutover authorization for the exact SHA,
      timestamp, backup target, and window.

## Current blockers after server acceptance but before companion installation

- [ ] Separately authorize publication of only the recorded signed quartet.
- [ ] Run `scripts/pi/runtime-raiders-artifacts.sh publish` with the exact release
      SHA, release sequence, companion version, installer, ZIP, checksum-file,
      and update-manifest digests, then run
      `scripts/pi/runtime-raiders-artifacts.sh status`.
- [ ] Independently download and verify all four HTTPS responses, require
      `no-store` and `nosniff`, and confirm `/health` remains `200`.
- [ ] Generate a fresh one-time enrollment command without recording its code.
- [ ] Separately authorize sequence-1 installation on one canary; use only the locally
      downloaded, SHA-256-verified installer and prove `daemonRunning=true`,
      `enabled=false`, and `persistedState=disabled` before activation.

If publication acceptance fails, run
`scripts/pi/runtime-raiders-artifacts.sh withdraw --release-sha "$RELEASE_SHA"`.
Require `status` to report `unpublished`, all four artifact URLs to return
`404`, and both health routes to remain `200`. Publication and withdrawal do
not reload Caddy or restart Node.

## Fresh values required in the restricted operator record

Do not fill these in Git:

- operator and exact UTC window;
- `CUTOVER_AT` and its UTC rendering;
- prior and final full release SHAs and short SSE versions;
- candidate-environment SHA-256;
- final rendered-installer, signed-ZIP, checksum-file, and update-manifest SHA-256 values;
- production DB ownership/mode, backup path, and backup SHA-256;
- prior-environment backup path and SHA-256;
- manager-loaded Caddy config and environment paths;
- prior Caddy config backup path and SHA-256;
- retained-query and aggregate paths;
- cutover ID, root-only backup directory, rollback record, detached seal, and
  independently copied expected seal checksum;
- fresh preflight, Caddy preparation, publication, header, health, canary, and
  manager-context evidence;
- exact authorization wording and UTC timestamp at each boundary; and
- final accepted, aborted, or rolled-back outcome and updater state.

## Separate approval statements

Each statement authorizes only its named boundary. Replace every blank with a
literal recorded value; do not approve a placeholder.

### A. Updater hold

> I authorize holding `claude-rpg-autoupdate.timer` and
> `claude-rpg-autoupdate.service` for Runtime Raiders release preparation. This
> does not authorize publishing, fetching, Caddy preparation, or deploying a
> release.

### B. Exact release publication

> With the updater hold freshly verified, I authorize publishing only release
> SHA `________________________________________` to tracked `origin/main` and
> fetching that exact object. This does not authorize Caddy preparation,
> preflight, checkout, or service change.

### C. Fail-closed Caddy preparation

> With the updater hold and exact release publication freshly verified, I
> authorize backing up the prior Caddy config outside Git, creating only the
> empty `/var/lib/runtime-raiders` and `/var/lib/runtime-raiders/releases`
> directories, installing the reviewed Caddyfile, validating it with the
> manager-loaded environment, and reloading Caddy. The `current` selector must
> remain absent; both internal health URLs must return `200`; and all four artifact URLs must return `404`:
> `https://raiders.redlattice.com/install.sh`,
> `https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip`, and
> `https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256`, and
> `https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json`.
> This does not authorize artifact publication, production cutover, companion
> installation, or activation. Failure restores and reloads the recorded prior
> Caddy config.

### D. Production cutover

> After fail-closed Caddy preparation and final read-only preflight pass, I
> authorize the Runtime Raiders production cutover from prior SHA
> `________________________________________` to release SHA
> `________________________________________`, with `CUTOVER_AT`
> `_____________`, backup target `________________________________`, during UTC
> window `____________________________`. I accept the recorded rollback order
> and post-rollback loss semantics. This does not authorize companion artifact
> publication or installation, canary activation, or office activation.

### E. Signed companion publication

> After deployed-server acceptance, I authorize publishing only the signed
> companion quartet for release SHA `________________________________________`
> with recorded release sequence, companion version, installer, ZIP,
> checksum-file, and update-manifest SHA-256 values
> `________________________________________________________________`,
> `________________________________________________________________`, and
> `________________________________________________________________`. This does not authorize downloading an
> installer for execution, installing any companion, or activation.

### F. Installed-off canary

> After four-digest sequence-1 publication acceptance, I authorize independently
> downloading and installing the recorded quartet on one approved canary. The
> locally downloaded installer must match its recorded SHA-256 before execution,
> and the daemon must be live with collection persistently off. This does not
> authorize `raiders on`.

### G. Sequence-2 build, review, and publication

> With the sequence-1 canary still persistently off, I authorize review and
> publication only of the new clean-SHA sequence-2 quartet, including
> `runtime-raiders-agent.update.json`. This does not authorize update execution
> or collection.

### H. Manual update proof

> After sequence-2 publication acceptance, I authorize only the installed
> canary to run `raiders update` and prove its signed version/sequence, daemon
> health, disabled state, enrollment, cursors, and outbox. This does not
> authorize `raiders on`.

### I. Bounded live provider canary

> After manual update proof, I authorize bounded `raiders on` only for the
> single recorded canary and content-free official Codex Desktop/CLI root-Run
> checks. It must run `raiders off` before any office request. This does not
> authorize office installation or activation.

### J. Office activation

> After the bounded canary is off and accepted, I authorize participating office users to
> install and enable Runtime Raiders. Claude Code and Omp remain disabled and
> unsupported for this release.

Use the full operational procedure and rollback in
`docs/RUNTIME_RAIDERS_CUTOVER.md`; this packet does not replace it.

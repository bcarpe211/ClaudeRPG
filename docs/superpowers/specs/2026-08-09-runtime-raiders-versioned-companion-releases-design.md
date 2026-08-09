# Runtime Raiders Versioned Companion Releases Design

**Date:** 2026-08-09

**Status:** Approved in conversation on 2026-08-09; written specification pending user review.

**Scope:** Replace fixed installed, rollback, and failed-candidate application slots with immutable versioned releases selected by a stable signed launcher. Add a one-time protocol-1-to-protocol-2 installer migration and move lifecycle failures ahead of signing and publication. This design does not build, sign, publish, install, activate, or delete a release.

**Supersedes:** `2026-08-08-runtime-raiders-fail-fast-update-lifecycle-design.md`. The read-only residue classifier and automatic diagnostic-preservation approach must not be completed or merged into this architecture.

## 1. Context and root cause

The protocol-1 updater installs one live bundle at `Runtime Raiders Agent.app`, moves the prior bundle to `Runtime Raiders Agent.rollback.app`, and deletes the rollback bundle after a successful health check. Cleanup is intentionally best-effort. If a safely retained rollback bundle still occupies that fixed name, the next update refuses before it creates a transaction.

The superseded fail-fast design kept those fixed slots. It added a read-only classifier and attempted to authenticate and move stale bundles before reusing the rollback name. That would diagnose the failure earlier, but it would preserve the underlying dependency: successful future updates would still require a reserved slot to be empty or safely normalized. It also required a path-based Security.framework verification to remain bound to descriptor-relative filesystem evidence across a concurrent rename boundary, which the available macOS API does not provide.

The new design removes the dependency. Every agent release has a unique directory, the prior release remains in place, and activation changes one small atomic record. Cleanup never determines whether the next release can be installed.

## 2. Goals

- Preserve the player-facing `raiders update` command for routine protocol-2 updates.
- Keep launchd bound to one stable signed launcher that never changes during a routine agent update.
- Store each agent release in a unique immutable directory derived from its sequence and Git SHA.
- Keep the committed active release unchanged while a candidate runs a prepared health trial.
- Make fallback a selector change rather than an application-bundle rename.
- Recover deterministically when the updater exits at any durable transaction boundary.
- Preserve enrollment, collection intent, provider cursors, adapter snapshots, active-Run rules, aggregate state, and outbox data outside release directories.
- Allow N to N+1 to N+2 even when old releases, transaction workspaces, or diagnostic records remain.
- Migrate the single installed sequence-8 canary without another enrollment and with collection persistently off.
- Retain the single-line first-install experience.
- Catch launcher, lifecycle, migration, and packaging failures locally before signing, publication, or installed-canary work.

## 3. Non-goals

- Automatic companion updates. Players continue to run `raiders update` explicitly.
- A second daemon, updater timer, watchdog, or persistent launcher process.
- Automatic deletion or movement of protocol-1 rollback, failed-candidate, diagnostic, or workspace evidence.
- Automatic deletion of old protocol-2 release directories.
- Office activation, collection activation, scoring changes, provider-adapter changes, server changes, Pi changes, Caddy changes, or DNS changes.
- A compatibility bridge that lets the sequence-8 protocol-1 updater consume a protocol-2 archive.
- A new player-facing repair command in the first implementation.
- Protection against a malicious process already running as the same macOS user and concurrently rewriting that user's application-support tree. The implementation still rejects symlinks, unsafe ownership and modes, signature mismatches, identity mismatches, path substitution observed at validation boundaries, and accidental or cross-user corruption.

## 4. Approaches considered

### A. Fixed A/B directories

Alternate between two fixed application directories. This reduces normal bundle movement but eventually reuses an occupied slot. Cleanup or normalization can therefore become a correctness requirement again.

### B. Versioned directories with per-update launchd rewrites

Install unique releases and rewrite the LaunchAgent to the selected release. This removes release-slot reuse but adds the LaunchAgent plist to every update and rollback transaction.

### C. Versioned directories with a stable signed launcher — selected

Install immutable agent releases under unique sequence-and-SHA names. Keep launchd and the user command shim pointed at a small signed launcher. The launcher validates one owner-only release-state record, resolves an exact release identity, and uses `exec` to become that agent. Routine updates never rewrite launchd or the launcher.

## 5. Filesystem layout

The per-user support directory remains:

```text
~/Library/Application Support/Runtime Raiders/
```

The protocol-2 layout is:

```text
Runtime Raiders/
├── Runtime Raiders Agent.app/       # preserved protocol-1 migration evidence only
├── launcher/
│   └── Runtime Raiders Launcher.app/
│       └── Contents/MacOS/runtime-raiders-launcher
├── releases/
│   ├── sequence-9-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/
│   │   └── Runtime Raiders Agent.app/
│   └── sequence-10-cccccccccccccccccccccccccccccccccccccccc/
│       └── Runtime Raiders Agent.app/
├── installation/
│   ├── release-state.json
│   └── update-journal.json
├── state/
├── outbox/
└── raiders
```

The support, launcher, releases, installation, state, and outbox directories are real directories owned by the current user with mode `0700`. Release roots and application roots have no group or other write bits. The release-state and journal files are regular, single-link, current-user-owned files with mode `0600`. Filesystem operations use descriptor-relative, no-follow APIs where available.

A release directory name is reconstructed from validated identity fields:

```text
sequence-<positive-safe-integer>-<exactly-40-lowercase-hex-SHA>
```

No state file, manifest, command-line argument, or server response may supply an arbitrary local path.

## 6. Release-state contract

`installation/release-state.json` is the only durable selector authority. It has an exact schema with no unknown keys:

```json
{
  "schema_version": 1,
  "generation": 12,
  "active": {
    "release_sequence": 10,
    "release_sha": "cccccccccccccccccccccccccccccccccccccccc",
    "companion_version": "0.3.1",
    "update_protocol_version": 2
  },
  "fallback": {
    "release_sequence": 9,
    "release_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "companion_version": "0.3.0",
    "update_protocol_version": 2
  },
  "trial": null
}
```

Rules:

- `schema_version` is exactly `1`.
- `generation` is a positive integer no greater than JavaScript's maximum safe integer and increases by exactly one for every committed record replacement.
- `active` is required and must match the identity embedded in the selected signed bundle.
- `fallback` is either `null` or an existing verified protocol-2 release strictly older than `active`.
- `trial` is either `null` or an existing verified protocol-2 release strictly newer than `active` and different from both active and fallback.
- Normal protocol-2 updates require active and candidate to use update protocol 2.
- A missing, malformed, oversized, symlinked, unowned, or unsafely permissioned record fails closed.

Record replacement uses an owner-only temporary regular file created in the pinned installation directory, bounded write, file synchronization, descriptor-relative atomic rename, and parent-directory synchronization. At every interruption the visible record is either the complete prior generation or the complete next generation.

`update-journal.json` is bounded, content-free diagnostic information only. It may record transaction identity, release identities, and an enumerated phase. It never supplies an executable path or changes launcher selection. A missing, stale, malformed, or unsafe journal is ignored and cannot block a future update. Journal cleanup is best-effort.

## 7. Stable signed launcher

The stable launcher is a separate hardened-runtime application bundle with bundle identifier:

```text
com.redlattice.runtime-raiders-launcher
```

It is signed by the same Apple Team ID as the agent. Its embedded launcher protocol is exactly `1`. Updating the launcher or launcher protocol requires the full verified installer; routine agent updates do not replace it.

Launchd uses the stable executable and the literal `daemon` argument. The `raiders` shim also executes the launcher and forwards the player's arguments literally without a shell evaluation step.

For each invocation, the launcher:

1. Opens and validates the owner-only support, installation, and releases directories without following symlinks.
2. Loads and strictly validates `release-state.json`.
3. Selects a release according to the rules below.
4. Reconstructs its exact versioned directory name from the selected identity.
5. Verifies ownership, modes, expected bundle identifier, Apple Team ID, hardened-runtime signature, update protocol, and embedded release identity. Notarization is proven before installation and is not rechecked through a potentially networked assessment on every launch.
6. Rechecks the selected tree and record generation at the final validation boundary.
7. Uses `exec` to replace the launcher process with the selected agent executable and forwards only validated literal arguments.

Selection rules:

- `daemon`: select `trial` only when a trial exists and the prepared-startup lease is currently held. Append the private trial generation argument generated from the validated record. Otherwise select `active`.
- `on`, `off`, `status`, `doctor`, `update`, and `uninstall`: always select `active`.
- Private self-check and recovery routes are never accepted from ordinary launcher input.

The trial agent independently verifies that its own embedded identity equals the recorded trial, the supplied generation equals the current record generation, its executable is inside the reconstructed trial release, and the prepared lease is held. Failure exits before collection, upload, migration persistence, or control readiness.

The launcher performs no network request, update check, collection, upload, state migration, notification, or cleanup. It does not fork a persistent helper; successful launch uses `exec`, so the launcher becomes the selected agent process.

Security.framework provides path-based static-code validation rather than a descriptor-bound validation API. The launcher therefore validates from a pinned, owner-only release root and rechecks the tree at the execution boundary, but it does not claim protection from a malicious same-user process racing that boundary. This limitation is explicit rather than hidden behind an unimplementable guarantee.

## 8. Normal protocol-2 update

`raiders update` executes from the committed active release and performs this ordered transaction:

1. Acquire the existing exclusive update lock.
2. Validate release state, launcher, active bundle, daemon health, enrollment, collector state, outbox, and zero active Runs.
3. Fetch and validate a strictly newer protocol-2 manifest.
4. Create a unique owner-only transaction directory.
5. Download, hash, validate, extract, and self-check the candidate.
6. Verify the candidate signature, notarization, Team ID, bundle identity, release identity, archive identity, and state-schema compatibility.
7. Move the verified candidate into its final unique release directory and synchronize it. The directory must not already exist.
8. Atomically write the next release-state generation with the candidate in `trial` while leaving `active` and `fallback` unchanged.
9. Acquire the prepared-startup lease and send a generation-bound prepare request to the active daemon. The daemon pauses Run acceptance, provider watching, uploads, heartbeat, and state persistence without changing collection intent.
10. Use `launchctl kickstart -k` on the already loaded stable-launcher job. Do not unload the job or rewrite its plist.
11. The launcher selects the trial because the matching lease is held. The candidate starts in prepared trial mode.
12. Verify candidate control readiness, exact release identity, signature, enrollment, in-memory state compatibility, collection intent, zero active Runs, and unchanged protected-state and outbox boundaries.
13. Atomically commit a new generation with candidate as `active`, prior active as `fallback`, and `trial` cleared.
14. Send the explicit resume command. Only now may deferred migrations persist and prior collection intent resume.
15. Release the prepared lease and update lock.
16. Remove the transaction workspace only as best-effort cleanup. Do not delete old release directories in this transaction.

## 9. Failure and crash behavior

The active release remains committed throughout trial health verification. A candidate cannot become active merely because it was downloaded or started.

| Interruption or failure | Required result |
| --- | --- |
| Before the trial record | Active daemon and selector remain unchanged |
| Trial recorded before lease acquisition | Active daemon continues; launcher ignores trial without the lease |
| Active daemon prepared, updater exits before restart | Lease closes; active daemon observes abandonment and resumes because it remains committed active |
| Trial candidate starts, updater exits before commit | Lease closes; candidate sees it is not committed active and exits without collecting; launchd restarts the committed active release |
| Candidate validation or health fails | Clear trial atomically, kickstart the committed active release under the lease, verify health, resume prior intent |
| Candidate passes health and commits, updater exits before resume | Lease closes; candidate sees that it is committed active with no trial and resumes prior intent |
| Resume fails after commit while updater remains alive | Recommit prior active, restore the prior fallback relationship, kickstart and verify prior active, then release the lease |
| Release-state replacement fails | The previous complete record remains authoritative |
| Journal or cleanup fails | Preserve evidence; do not change the committed result and do not block the next update |
| Old release or legacy residue remains | Ignore it unless directly selected by the validated record |

Both an already-running daemon prepared for update and a newly started trial daemon observe lease abandonment:

- If the observing release is still the committed active release, it resumes the preserved collection intent.
- If it is an uncommitted trial, it exits without collection so launchd restarts the active release.
- If it is the newly committed active release and trial is cleared, it resumes.
- Any malformed or contradictory state fails closed with collection disabled.

No recovery path deletes the last verified active or fallback release.

## 10. Shared state

The following remain outside release directories and are never copied into an application bundle:

- enrollment and device credentials;
- persisted collection intent;
- provider cursors and bounded adapter snapshots;
- active-Run registry and aggregate status;
- update-notification state;
- prepared-startup and update locks; and
- durable outbox events.

Trial startup may load an older supported schema and migrate it in memory, but it cannot persist the migration. The updater continues to require exact protected-state preservation through prepared health verification. Deferred migrations may persist only after the candidate is committed active and explicitly resumed.

A candidate that cannot read the current schema in prepared mode fails its trial. A future release that requires an irreversible state migration must introduce a separately designed state protocol; it cannot weaken this transaction implicitly.

## 11. Protocol-1 canary migration

Update protocol 2 intentionally prevents the sequence-8 protocol-1 updater from attempting to consume the new archive. Sequence 8 discards the incompatible update manifest rather than advertising a broken `raiders update` path.

The new signed installer performs the one-time migration for the single current canary:

1. Detect the existing flat installation and validate its sequence-8 application, LaunchAgent, shim, enrollment, daemon state, collection intent, and zero active Runs.
2. Reuse the valid existing enrollment without prompting for or spending another enrollment code.
3. Download and fully verify the protocol-2 release artifact in an owner-only temporary directory.
4. Capture exact rollback copies or seals for the flat application, LaunchAgent, shim, and release-independent state.
5. Prepare and stop the existing daemon without changing persisted collection intent.
6. Create the protocol-2 directories.
7. Leave the existing sequence-8 application unchanged at its original flat path so its path-bound protocol-1 daemon remains runnable during installer rollback. It is not placed in protocol-2 release state.
8. Install the candidate agent in its exact versioned release directory and install the stable signed launcher.
9. Write release state with candidate active, fallback `null`, no trial, and generation 1.
10. Rewrite the LaunchAgent and shim once to use the stable launcher.
11. Bootstrap the candidate under the prepared lease, verify health and exact shared-state preservation, then resume the prior collection intent.

Any failure before final acceptance restores the exact flat application, LaunchAgent, shim, and daemon arrangement. Newly issued enrollment is retained under the existing safe-retry rule; an existing enrollment is never rewritten.

After successful migration, the flat sequence-8 application remains untouched as legacy evidence but is not selected by the launcher. The first normal sequence-9-to-sequence-10 protocol-2 update establishes sequence 9 as the first versioned fallback. Protocol-1 rollback, failed-candidate, diagnostic, and workspace entries also remain untouched. None are referenced by protocol-2 selection, so they cannot block migration or later updates. Their deletion requires a separate explicit cleanup design and authorization.

## 12. Fresh installation and packaging

New office installations go directly to the protocol-2 layout through the existing public command:

```sh
curl -fsS https://raiders.redlattice.com/downloads/install.sh | sh
```

The public signed quartet remains:

- `install.sh`;
- `runtime-raiders-agent.zip`;
- `runtime-raiders-agent.zip.sha256`; and
- `runtime-raiders-agent.update.json`.

The ZIP has one exact top-level release container holding two independently signed, hardened, notarized application bundles:

```text
Runtime Raiders Release/
├── Runtime Raiders Agent.app/
└── Runtime Raiders Launcher.app/
```

The release build, ZIP validator, installer, and candidate verifier reject extra roots, missing bundles, links, special files, unsafe modes, identifier mismatch, Team ID mismatch, architecture mismatch, invalid nested signatures, missing notarization, release-identity mismatch, launcher-protocol mismatch, or update-protocol mismatch.

The public manifest remains bounded and content-free but declares `update_protocol_version: 2`. Protocol-2 agents accept only protocol-2 candidates. The archive digest binds both signed bundles; neither a remote filename nor remotely supplied local path participates in installation.

## 13. Fail-fast test gates

### Gate 1: isolated local lifecycle

Expose one command, `npm run canary:lifecycle-test`, that runs the focused Swift launcher, release-state, updater, prepared-startup, migration, command-routing, and ZIP-validation suites plus the Vitest installer integration suite and shell syntax checks.

The command uses only temporary directories, fake launchd, fake networking, injected signature facts, and synthetic content-free state. It performs no real network request, launchd change, installed-app change, provider-record read, signing, notarization, publication, Pi access, Caddy access, collection, or activation.

Required cases include:

- strict state decoding and atomic replacement;
- active selection and trial selection only with the matching held lease;
- symlink, ownership, mode, arbitrary-path, signature, Team ID, protocol, identity, and generation rejection;
- N to N+1 to N+2 with all prior releases retained;
- forced workspace, journal, and old-release cleanup failures;
- every candidate validation, prepare, restart, health, commit, resume, and rollback failure;
- simulated updater exit at every durable boundary;
- exact protected-state and outbox preservation;
- successful flat-to-versioned migration;
- injected migration failure at every replacement boundary with exact flat-layout restoration;
- existing enrollment reuse without an enrollment request; and
- no content or telemetry leakage from launcher, updater, migration, status, or diagnostics.

### Gate 2: real signed artifact while unpublished

After Gate 1, the complete Swift suite, repository tests, typecheck, shell syntax, and diff checks pass, build the actual universal release artifact. Before publication, an isolated temporary-home harness must:

- verify both Developer ID signatures, hardened runtime, notarization, and staples;
- extract and copy the launcher to its installed-style path and verify it again;
- exercise the real launcher against temporary active, fallback, trial, and malformed records;
- run the real installer with the real signed archive behind fake network and launchd boundaries; and
- prove exact rollback after injected migration failures.

### Gate 3: installed-off migration canary

Only after Gates 1 and 2 pass may a separately reviewed release be published and the current Mac canary migrate. Collection remains persistently off. Record pre/post fingerprints for enrollment and protected local state, then verify launcher and agent signatures, active identity, `fallback: null`, preserved flat sequence-8 evidence, daemon health, zero active Runs, and zero unexpected queued events.

### Gate 4: real protocol-2 update

Publish one subsequent reviewed release and use normal `raiders update` to prove versioned sequence 9 to versioned sequence 10. Verify prepared trial startup, atomic commit, fallback identity, state preservation, daemon health, and collection intent. Office activation remains a separate decision.

## 14. Development and authorization boundaries

Read-only inspection, local implementation, unit tests, temporary integration tests, fake crash injection, and temporary-home lifecycle tests require no per-command ceremony once implementation begins. They remain inside the isolated worktree and cannot affect the installed companion.

Meaningful external boundaries remain separate:

1. real signing and notarization;
2. publication or withdrawal;
3. installed-canary migration;
4. a real protocol-2 update canary;
5. `raiders on` or collection; and
6. office activation.

No design, plan, commit, merge, or local test implicitly authorizes any later boundary.

## 15. Acceptance criteria

- The fixed rollback and failed-candidate paths are absent from protocol-2 update correctness.
- Launchd and the command shim use the stable signed launcher.
- The launcher performs no network or persistent background work and becomes the selected agent through `exec`.
- Active remains unchanged until candidate health succeeds.
- Lease abandonment deterministically resumes committed active or exits an uncommitted trial.
- N to N+1 to N+2 passes while old releases and cleanup residue remain.
- Forced cleanup failure cannot block another update.
- Every unsafe selector, path, bundle, protocol, signature, or generation fails closed.
- The protocol-1 canary migrates without another enrollment, preserves the runnable flat sequence-8 binary during the installer transaction, and can roll back to its exact flat layout on injected failure.
- Trial startup preserves protected state byte-for-byte and defers migration persistence until commit and resume.
- Gate 1 runs with one local command and no external effects.
- The real signed artifact is exercised in an isolated temporary home before publication.
- A real installed-off migration and one normal protocol-2 update succeed before office activation.
- The superseded residue-classifier branch remains unmerged and its evidence is preserved.

## 16. Future considerations

After office activation, a separately designed maintenance command may delete unselected protocol-2 releases according to a bounded retention policy. It must never delete active or fallback and must not be required for future updates.

Launcher protocol changes, irreversible state-schema migrations, automatic updates, and additional provider adapters each require separate designs. None should expand the stable launcher beyond release selection, validation, and `exec`.

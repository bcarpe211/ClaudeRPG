# Runtime Raiders Employee Beta Simplification

**Status:** Proposed for review

**Purpose:** Get the Runtime Raiders companion ready for a small office beta
without carrying the experimental release machinery that delayed the first
rollout.

This document authorizes no tagging, branching, code changes, signing,
publication, installation, collection, or office rollout.

## Decision

Keep the current game server and collector work. Simplify the companion forward
from current `main`; do not delete the repository and do not revert the whole
project to an older companion.

Before implementation, preserve the current sequence-16 source boundary
`b0eaa7be15f69c87a55ea3ad7a21e8c6b7e6d0d2` with an archival tag. Implement the
employee-beta path on a new branch from current `main`. The current sequence-16
Mac installation is disposable beta state and will be uninstalled before the
first signed verification of the simplified companion.

The employee experience is intentionally small:

```text
new installation: curl -fsSL https://raiders.redlattice.com/install.sh | sh
check for update: raiders update
start collection: raiders on
stop collection:  raiders off
inspect health:   raiders status
```

## Goals

- Collect content-free Codex Desktop and Codex CLI Run metrics and report them
  to the existing game server.
- Install one Apple-signed and notarized companion with the existing website
  enrollment flow.
- Support fresh installation and manual reinstallation through the same
  `curl | sh` command.
- Check for a newer version once per day and notify the user once per version.
- Make `raiders update` report availability and print the installer command;
  it must not replace its own running executable.
- Give the release operator one straightforward, documented command for local
  verification, signing, and publication.
- Reach office beta quickly without weakening content-privacy tests or shipping
  the known activation-readiness defect.

## Non-goals

- Automatic or in-process updates.
- Multiple active release generations, N/N+1/N+2 canary sequences, prepared
  trials, or a stable versioned launcher.
- Migration of the existing sequence-16 installation.
- A generalized publication state machine, immutable release selector,
  withdrawal workflow, or resumable authorization engine.
- Automatic office activation. A fresh installation remains off until the user
  runs `raiders on`.
- Supporting Claude Code or Omp. The beta supports Codex Desktop and Codex CLI.

## What stays

The following current code is product work and remains the foundation:

- server enrollment, authentication, Run ingestion, Raid Power scoring, and
  player/game integration;
- `AdapterRegistry`, `CodexAdapter`, `FileWatcher`, `JSONLReader`,
  `AgentController`, `PrivacyEncoder`, `Outbox`, and `Uploader`;
- the content-free event contract and existing server/collector tests;
- `raiders on`, `off`, `status`, `doctor`, and `uninstall`;
- the website-generated enrollment code and zsh/POSIX-sh-compatible installer
  command;
- Apple Developer ID signing, notarization, stapling, and signature checks.

## What changes now

### 1. Repair activation readiness

The collector exposes three simple activation states: `disabled`, `preparing`,
and `ready`.

`raiders on` records enabled intent, starts discovery and historical-boundary
preparation in the background, and returns without holding the control socket
for the entire scan. `raiders status` and `raiders off` remain responsive while
the state is `preparing`. Collection begins only after the captured boundary is
ready.

The repair must preserve the rule that historical provider content is not
uploaded. A local integration fixture containing at least 816 existing JSONL
files must prove:

- `on`, `status`, and `off` remain responsive;
- historical files establish boundaries without producing Runs;
- interrupted or failed preparation returns to a safe disabled state;
- exactly one synthetic post-ready Desktop completion produces exactly one Run;
- no duplicate Raid Power or legacy-token change occurs.

This suite runs before Apple signing or any real provider test.

### 2. Use a static `/version` response

The release host serves a small, uncached response at
`https://raiders.redlattice.com/version`:

```json
{"version":"0.4.0"}
```

The companion performs an anonymous `GET` at startup when the prior attempt is
at least 24 hours old. It sends no enrollment, player, device, provider, usage,
cookie, or query data. When the returned semantic version is newer, it displays
one macOS notification for that version:

```text
Runtime Raiders update available. Run raiders update.
```

### 3. Make `raiders update` informational

`raiders update` performs the same anonymous version check and exits. If the
installation is current, it prints that fact. If an update exists, it prints:

```text
Runtime Raiders 0.4.0 is available.
Installed version: 0.3.7

Run:
curl -fsSL https://raiders.redlattice.com/install.sh | sh
```

It does not download an application, stop the daemon, or modify local state.
The separately launched installer avoids trying to overwrite its own running
binary.

### 4. Return to one flat installed application

Install one application at:

```text
$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app
```

The LaunchAgent points directly to that application. The `raiders` command
continues to resolve through the owned shim in `$HOME/.local/bin`.

The installer downloads the candidate into an owner-only temporary directory
and verifies the archive shape, Apple Developer ID identity, Team ID, bundle
identifier, notarization, and embedded version before stopping the existing
LaunchAgent.

For a reinstall, it then:

1. records the existing enabled/disabled preference;
2. stops the LaunchAgent;
3. moves the existing application to one temporary backup;
4. moves the verified candidate into the fixed application path;
5. starts the LaunchAgent and verifies `raiders status`;
6. preserves enrollment, collector state, cursors, and queued metrics; and
7. removes the temporary backup after success.

If the new application cannot start, the installer restores the temporary
backup and the prior enabled/disabled preference. This is one local replacement
rollback, not a multi-generation release system.

### 5. Simplify build and publication

The employee beta publishes three stable resources:

- `/install.sh`;
- `/downloads/runtime-raiders-agent.zip`; and
- `/version`.

The ZIP contains the one signed/notarized agent application. The installer
performs the trust verification; users do not handle artifact hashes or release
sequences.

A checked-in release entry point provides the operator workflow:

```sh
/bin/bash scripts/release/release-runtime-raiders-beta.sh
```

It requires a clean reviewed commit and explicit signing credentials, runs the
approved local suites, builds and validates the signed application, prepares
the installer and version response, prints a short release summary, and stops
before remote publication unless publication was included in the operator's
explicit approval. Publication uploads to temporary names and renames all three
resources only after the complete set is present.

The operator runbook documents prerequisites, the one release command, the
expected summary, publication approval wording, signed verification, failure
handling, and the employee install command.

## What is retired after the beta works

Do not begin by deleting the old machinery. First prove the replacement locally
and with one signed installation. After that proof, remove the unused:

- foreground self-updater and prepared-update control commands;
- `CompanionUpdater`, versioned release transactions, release-state generations,
  candidate archive updater, and update manifest;
- separate Runtime Raiders launcher application;
- sequence-8 migration and private migration record;
- versioned artifact selector, withdrawal workflow, and two-sequence canary
  documentation; and
- tests that exist only for those retired paths.

Archive the historical runbooks rather than leaving them as active operator
instructions. Preserve the archival Git tag and existing ignored `dist`
artifacts as historical evidence until the beta has been accepted.

## Implementation order

1. **Archive and isolate:** create the sequence-16 archival tag and a
   simplification branch from current `main`; preserve the user's current
   `docs/BACKLOG.md` change.
2. **Repair activation:** implement `disabled`/`preparing`/`ready` and the
   816-file integration suite.
3. **Simplify update discovery:** add static `/version`, reduce the daily checker,
   and make `raiders update` informational.
4. **Simplify installation:** package one app and implement safe flat fresh
   install/reinstall while preserving enrollment and local metrics state.
5. **Simplify release operations:** add the single beta release entry point and
   its short operator runbook.
6. **Verify locally:** run Swift tests, server tests, privacy/transport tests,
   816-file activation tests, fresh-install tests, enabled and disabled reinstall
   tests, interruption rollback tests, and the exact generated command under
   `/bin/zsh -f -c` and `/bin/sh -c`.
7. **Verify one signed release:** sign/notarize, publish the approved build,
   uninstall the disposable sequence-16 Mac installation, install fresh, prove
   `status` and `doctor`, run one Codex Desktop Run and one Codex CLI Run, verify
   scoring and zero legacy-token change, then run `raiders off`.
8. **Open the employee beta:** keep the game paused until the server and signed
   companion checks pass, then provide the existing website-generated enrollment
   command to employees. Office activation is a separate deliberate decision.
9. **Remove retired machinery:** delete and archive the unused release/update
   stack only after the simplified signed release has passed.

## Acceptance criteria

- A new employee can enroll and install using the single website command.
- The signed companion starts off, reports healthy status, and can be enabled
  without blocking its control commands.
- Existing JSONL history produces no historical Runs; one post-ready Desktop Run
  and one post-ready CLI Run each produce one correctly scored server Run.
- No prompt, response, command, tool payload, project path, credential, or other
  content is transmitted.
- `raiders update` only compares versions and prints the installer command.
- Running the installer again replaces the stopped app and preserves enrollment,
  queued metrics, cursors, and the prior on/off preference.
- A failed replacement restores the prior application.
- The release operator can follow one short runbook without reconstructing prior
  chat context.
- No N/N+1/N+2 release pairing, automatic update, office auto-activation, or
  sequence-16 migration remains in the employee-beta path.

## Stop conditions

Do not publish or invite employees if the activation fixture fails, signing or
notarization fails, the installed version differs from `/version`, status or
doctor is unhealthy, historical files emit a Run, either official Codex surface
does not score exactly once, legacy token totals change, or the installer cannot
prove a successful replacement or restoration.

# Runtime Raiders Codex contract and manual updates design

**Date:** 2026-08-05

**Status:** Approved in discussion; awaiting written-spec review

**Scope:** Codex Desktop and CLI surface classification, compatibility policy,
release discovery, and an explicit signed companion update command

## 1. Context

The first live Codex canary proved the end-to-end privacy, scoring, and timeout
path, but it also exposed two compatibility defects:

1. an official Codex Desktop Run used the string source marker `vscode`, which
   the companion incorrectly classified as `codex_cli`; and
2. a Codex CLI Run used a newer `cli_version` than the companion's exact pinned
   build, so the companion rejected an otherwise recognized record.

The accepted Run stored only the approved content-free facts and generated Raid
Power. It remains in production as audit evidence; this work does not edit or
delete it. Collection was turned back off immediately after the canary, and
office activation remains a separate gate.

Codex updates too frequently for exact build allowlisting to be a workable
compatibility policy. Automatically installing companion updates would also be
too surprising for an idle work game. Runtime Raiders therefore needs two
related changes:

- classify a Codex surface from a strict local record contract rather than one
  exact Codex build number; and
- discover signed companion releases quietly, notify once, and let the player
  explicitly run `raiders update`.

## 2. Goals

- Correctly distinguish official Codex Desktop and Codex CLI root Runs from the
  locally observed source contract.
- Continue accepting recognized records across routine Codex build updates
  without downloading provider schemas or changing provider settings.
- Remain fail-closed when provenance, lifecycle, usage, or timestamps do not
  satisfy the locally compiled contract.
- Check for Runtime Raiders releases without running a second persistent
  process or sending player, device, enrollment, or usage data.
- Notify a player only once for each newly available release and expose the same
  state through `raiders status`.
- Install an update only after the player runs `raiders update`, with complete
  signed-artifact verification and automatic rollback on failure.
- Preserve collection state, enrollment, cursors, open-Run safety, and the
  durable outbox through a successful update or rollback.

## 3. Non-goals

- Automatically downloading or installing companion releases.
- Adding another LaunchAgent, daemon, scheduler, or long-running updater.
- Fetching or executing remote schemas, parser rules, scripts, or scoring logic.
- Enabling OTel or modifying Codex, Claude, Omp, shell, editor, or provider
  configuration.
- Reading or reporting prompts, responses, commands, tool calls, file contents,
  paths, repository names, window titles, or other work content.
- Changing the server event schema, database, Raid Power formula, leaderboard,
  or display-only model and effort policy.
- Repairing the one misclassified canary Run already stored in production.
- Activating collection for the office.

## 4. Codex record compatibility

### 4.1 Surface classification

The Codex adapter will classify only exact, recognized source forms:

| Local source form | Runtime Raiders surface |
| --- | --- |
| string exactly `vscode` | `codex_desktop` |
| string exactly `exec` | `codex_cli` |
| the currently verified strict Codex subagent object | `codex_desktop` |

`codex_desktop` means the official Codex application. The provider's internal
`vscode` marker is not presented to the player as Visual Studio Code support.
Other strings, loose object matches, missing source values, and new source
shapes are unsupported until inspected and added to a signed companion release.

The verified subagent object remains mapped to Desktop for this release. Parent
surface inheritance for CLI-spawned subagents has not been proven, so this
mapping is a documented display-only limitation; it does not change scoring.

### 4.2 Structural contract

`cli_version` is retained as bounded diagnostic metadata, not used as an exact
compatibility gate. A version value must still be a nonempty, bounded string of
the expected primitive type. It is never uploaded as a substitute for the
existing model, effort, usage, and lifecycle facts.

A record may emit an observation only when the locally compiled adapter can
prove all facts needed for that observation:

- its source has one of the exact recognized forms above;
- required identifiers have the expected type and bounded length;
- lifecycle records arrive in a recognized shape and state transition;
- timestamps are valid, bounded, and ordered where ordering is required;
- usage counters are finite, nonnegative integers within existing limits;
- cumulative counters do not move backward for one Run; and
- the outbound privacy encoder can construct the existing allowlisted event.

Unknown record kinds are ignored. A changed or malformed lifecycle record that
cannot supply every required fact emits nothing. Rejection must not block,
modify, lock, truncate, or rewrite the provider record.

This policy intentionally tolerates build-number drift, not arbitrary schema
drift. A same-shaped provider change could still alter semantics without a
syntactic signal. Strict counter invariants, existing server limits, content-
free diagnostics, controlled canaries, and signed companion releases bound that
residual risk.

### 4.3 Diagnostics and privacy

`raiders doctor` may report aggregate compatibility reason codes such as
`unsupported_source` or `unsupported_contract`. Diagnostics must not contain
record paths, native Run identifiers, prompts, responses, commands, or copied
record fragments. An unsupported record never enters the durable outbox.

This change does not alter server ingestion, persistence, scoring, or the
privacy encoder. Provider, model, and effort remain display-only metadata.

## 5. Release discovery architecture

### 5.1 Single-process check

The existing Runtime Raiders daemon may perform one asynchronous release check
at startup only when its last attempt is at least 24 hours old. The check is
outside collection and upload paths: timeout, DNS, TLS, HTTP, parsing, state
write, or notification failures never delay or fail Run observation.

The request is an unauthenticated static `GET` to exactly
`https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json`.
It has:

- no query string, request body, cookies, enrollment token, player ID, device
  ID, current version, provider information, or usage facts;
- a bounded response size and short timeout;
- no redirects; and
- no fallback host.

Because this is the already approved Runtime Raiders trust destination, the
check creates no new reporting path to OpenAI, Anthropic, Omp, or another AI
provider. It may run while collection is off.

### 5.2 Manifest contract

Publication atomically writes a static JSON manifest with this versioned,
allowlisted shape:

```json
{
  "manifest_version": 1,
  "update_protocol_version": 1,
  "release_sequence": 2,
  "release_sha": "40 lowercase hexadecimal characters",
  "companion_version": "bounded display string",
  "zip_sha256": "64 lowercase hexadecimal characters",
  "zip_url": "https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"
}
```

Unknown keys are rejected rather than interpreted. Integers must be positive
safe integers, strings must satisfy exact length and character constraints,
and `zip_url` must equal the compiled origin and path. The manifest contains no
executable code, parsing rules, player data, or secrets.

`release_sequence` is the monotonic update authority. The signed application
also embeds its release sequence, release SHA, companion version, and supported
update protocol. A manifest is available only when its sequence is greater than
the installed sequence. Sequence, SHA, version, protocol, URL, and digest must
agree with the downloaded signed application before replacement. This prevents
downgrade and mismatched-publication attacks without treating a sortable
version string as authority.

If a future release needs to change the stable launcher or update protocol, the
old updater refuses it and tells the player to rerun the verified installer.
Protocol version 1 updates only the application bundle; the existing shim and
LaunchAgent continue pointing to their stable installed paths.

### 5.3 Local update state

Owner-only local state records only:

- time of the last manifest check attempt;
- last successfully observed release sequence;
- last release sequence for which a notification was attempted; and
- the validated, bounded public manifest fields needed by status and update.

It contains no enrollment credential, provider content, path, or Run data. A
malformed state file is ignored and safely replaced. Manifest state is not put
in the event outbox or uploaded to the server.

### 5.4 Notification and status

For each higher release sequence, the daemon attempts exactly one native macOS
notification:

> Runtime Raiders update available. Run `raiders update`.

The implementation invokes `/usr/bin/osascript` directly with a fixed script
argument and no shell or dynamic user-controlled text. This is a brief one-shot
child used only to deliver the notification, not a second persistent process.
Tests use an injected notifier rather than displaying real notifications.

The sequence is recorded before or with the attempt so notification failures do
not create a daily notification loop. `raiders status` remains the reliable
fallback and shows the installed version, the available version, and the exact
`raiders update` instruction whenever a validated higher sequence is cached.

## 6. Explicit foreground update

`raiders update` is handled by the already installed, signed Runtime Raiders
executable in the player's foreground terminal. It never pipes network data to
a shell and downloads only the fixed application ZIP named by a validated
manifest.

Each invocation performs a fresh synchronous manifest fetch rather than trusting
only the daily cached result. This explicit check uses the same content-free,
fixed-request contract and is not subject to the background 24-hour throttle.

### 6.1 Preconditions

The command refuses to proceed when:

- any Run is active;
- another update is in progress;
- the manifest is missing, stale, malformed, incompatible, or not newer;
- the installed application identity cannot be verified; or
- required owner-only staging and rollback space cannot be created safely.

The user can end or wait for active Runs and invoke the command again. The
updater does not interrupt a provider process or synthesize a Run ending.

### 6.2 Verification

The foreground updater enforces:

- strict HTTPS to the exact compiled origin and ZIP path;
- no redirects and bounded timeout and artifact size;
- the exact manifest SHA-256 before extraction;
- safe ZIP entries with no traversal, links, unexpected top-level items, or
  special files;
- the expected bundle identifier, Developer ID application identity, Apple
  team identifier, hardened-runtime signature, and notarization staple;
- the embedded release sequence, release SHA, version, and update protocol
  matching the manifest; and
- a candidate executable that passes its offline self-check before installation.

No trust decision depends on a remotely supplied command, filename, schema, or
certificate identity.

### 6.3 Transaction and rollback

The update performs this ordered transaction:

1. capture collection enabled/disabled state and verify no active Run;
2. create an owner-only staging directory and download the ZIP;
3. verify, extract, and self-check the candidate away from the live path;
4. stop the existing daemon without changing persisted collection intent;
5. move the current signed application to an owner-only rollback path;
6. move the fully verified candidate onto the stable application path;
7. start the daemon and wait for bounded health, signing, version, state, and
   local-store validation; and
8. remove staging and the rollback copy only after all checks succeed.

Any failure after the daemon stops restores the old signed bundle, restarts it,
verifies the restored version and health, restores the prior on/off state, and
reports a nonzero result. Enrollment, provider cursors, update state, active-Run
registry, and durable outbox live outside the replaceable application bundle and
are neither cleared nor migrated implicitly. A failed update never enables a
previously disabled collector.

If automatic rollback also fails, the command preserves both bundles and the
diagnostic record, leaves collection disabled, and prints the exact recovery
command. It never deletes the last verified application.

## 7. Publication and hosting

The existing immutable release-directory and atomic `current` selector remain
authoritative. Publication will:

1. build, sign, notarize, staple, and independently verify the ZIP;
2. assign a new positive `release_sequence` greater than every published and
   embedded sequence;
3. generate the exact public JSON manifest from verified artifact facts and
   extend the root-only release manifest with the same bounded facts;
4. stage the installer, ZIP, checksum, and public manifest inside one complete
   root-controlled release directory;
5. atomically rename that immutable directory into `releases/<release SHA>` and
   atomically move the temporary relative selector over `current`; and
6. re-fetch the public ZIP and manifest and compare their digests and fields.

Caddy serves only the fixed installer, ZIP, checksum, and manifest paths needed
by the release workflow. Directory browsing, arbitrary filenames, redirects,
and write methods remain unavailable. Publishing a manifest does not activate
collection or change game state.

The first updater-capable release must still be installed through the existing
verified installer because the current release has no `raiders update` command.
All later protocol-1 releases can use the explicit foreground command.

## 8. Failure behavior

- Release discovery failure is a local diagnostic only; collection continues.
- An invalid manifest is discarded and cannot trigger notification or update.
- Failure to display the one-time notification falls back to `raiders status`.
- An unrecognized Codex source or record shape emits no event and cannot alter
  a provider record.
- Network or server unavailability continues to use the existing bounded,
  content-free outbox behavior.
- Update verification failure occurs before the live bundle is changed.
- Post-swap failure restores the old signed bundle and prior collection state.
- No failure path enables collection, starts office scoring, or mutates the
  production Run retained from the first canary.

## 9. Test design

### 9.1 Codex compatibility

Fixture tests use synthetic, content-free records shaped like the locally
observed contracts:

- `vscode` classifies as `codex_desktop` across multiple bounded version values;
- `exec` classifies as `codex_cli` across multiple bounded version values;
- the exact verified subagent object classifies as `codex_desktop`;
- malformed versions, unknown sources, loose subagent objects, invalid
  lifecycle transitions, timestamps, and counters emit nothing;
- counters cannot regress or exceed the existing limits; and
- rejected records and diagnostics expose no paths, native IDs, or content.

The existing privacy encoder, event contract, scoring, outbox, server, and full
Swift suites remain green.

### 9.2 Release discovery

Tests cover strict manifest parsing, extra/missing keys, value bounds, exact
origin and path, redirect refusal, timeout and size limits, monotonic sequences,
24-hour throttling, malformed local state, one notification attempt per
sequence, disabled collection, and status fallback. The notification test uses
a fake one-shot notifier and proves no dynamic manifest value reaches the
script argument.

### 9.3 Foreground update

Tests cover active-Run refusal, concurrent-update locking, download and digest
failure, unsafe ZIP entries, wrong bundle/team/signature/staple, manifest-to-app
mismatch, unsupported protocol, downgrade refusal, failed self-check, failed
restart, successful rollback, rollback failure preservation, and prior on/off
state restoration. They also prove enrollment, cursors, update state, and
outbox survive a successful update and rollback.

Publication and Caddy tests verify the fixed public route, atomic manifest
generation, sequence/SHA/version/digest agreement, public re-fetch, and absence
of directory listing or arbitrary artifact access.

## 10. Acceptance and rollout gates

Implementation proceeds in an isolated worktree with test-first changes and an
independent code review. Before any production action:

- focused compatibility, update, publication, and Caddy tests pass;
- the full Node and Swift suites pass from a clean worktree;
- a new release is merged, signed, notarized, stapled, and recorded;
- server/Caddy changes, if needed, are deployed only under the existing paused
  and rollback-protected production procedure; and
- public manifest and artifact verification pass from outside the host.

The real update canary requires two signed sequences:

1. install the first updater-capable release with collection persistently off;
2. publish a higher compatible sequence;
3. observe exactly one notification and the matching `raiders status` result;
4. run `raiders update` manually;
5. verify version transition, health, signing, preserved disabled state,
   enrollment, cursors, and empty/unchanged outbox; and
6. separately enable a bounded live canary and prove one fresh official Codex
   Desktop Run and one fresh Codex CLI Run classify and score correctly with no
   content stored.

Office activation remains a separate explicit authorization after that canary.
Neither merging, publication, installation, notification, nor a successful
manual update authorizes `raiders on` for other players.

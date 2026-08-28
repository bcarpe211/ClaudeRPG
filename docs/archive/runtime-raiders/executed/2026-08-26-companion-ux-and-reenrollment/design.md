# Runtime Raiders companion UX, re-enrollment, and removal design

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**

**Status:** Approved product direction; implementation, release creation, and
production deployment remain separately gated.

## Goal

Give employees a clear, content-free view of companion health and replace the
current operator-only recovery procedure with supported commands for changing a
device enrollment or removing Runtime Raiders.

The design must make these facts unambiguous:

- browser login does not retarget an enrolled companion;
- queued events belong to the Raider whose credential collected them;
- re-enrollment replaces a device credential without moving game history; and
- ordinary uninstall preserves recoverable state, while `--everything`
  deliberately removes every local Runtime Raiders artifact.

## Non-goals and release boundary

- Do not merge, delete, rename, or otherwise mutate Raiders or accounts.
- Do not move or recompute Runs, scores, levels, gold, damage, rewards,
  purchases, cosmetics, or leaderboard history.
- Do not transfer queued events or awarded work between Raiders.
- Do not change scoring, presence, activation readiness, provider parsing, or
  the fifteen-minute dungeon activity window.
- Do not mask or reclassify the separate control-socket contention defect that
  can currently surface as POSIX error 35. Human-readable status still fails
  honestly when it cannot obtain a coherent status snapshot.
- Do not re-enable collection on any existing installation.
- Do not bump the companion version, build or publish a release artifact,
  notarize, deploy server changes, or change production state as part of this
  implementation branch. A possible 0.4.9 release is a later decision after
  the production trial and release gates are reviewed.

## Existing contracts to preserve

The daemon already owns the live status snapshot, while the CLI can construct a
reduced local snapshot when the daemon is unavailable. `AgentStatus` is the
common structured model. Existing automation receives its stable, sorted JSON
serialization.

Enrollment is currently device-token-bound. A one-time code selects a Raider;
the exchange creates a row in `raider_devices`, stores only a token hash on the
server, and returns the Raider's stable dedupe secret plus collector
configuration. This design extends those boundaries rather than making website
session state authoritative.

The existing owner-only application support layout and no-follow file handling
remain the security foundation. New recovery and deletion logic must use
descriptor-relative, type-, owner-, mode-, device-, and inode-checked
operations; path strings and `FileManager.removeItem` alone are insufficient.

## Command surface

The supported employee-facing commands become:

```text
raiders on
raiders off
raiders status [--json]
raiders doctor
raiders update
raiders re-enroll
raiders uninstall [--everything]
raiders help
```

No secret is accepted in an argument, environment variable, URL, or pipeable
flag. Enrollment codes and destructive confirmations are read only from an
interactive terminal. `re-enroll` and `uninstall --everything` refuse to run
without a TTY.

Unknown arguments return the concise usage text and a nonzero exit status.
Hidden managed-agent and verification routes retain their exact executable-path
guards and do not appear in employee help.

## Human-readable status

`raiders status` renders deterministic, left-aligned text by default. It reports
only content-free aggregates already present in `AgentStatus`:

```text
Runtime Raiders
Collection: ON
Status: Ready
Background agent: Running
Surfaces: Codex CLI, Codex Desktop
Active runs: 0
Queued events: 0
Installed version: 0.4.8
Available version: None
Last successful upload: 4 minutes ago
```

Collection is `ON` whenever collection is persistently enabled, including while
activation is preparing. The status line distinguishes `Preparing safely in
the background`, `Ready`, `Off`, and `Needs attention`. A daemon that is absent
while collection is off is not itself an alarming state; a daemon that should
be serving an enabled collector is.

The renderer uses fixed field order and stable labels. Surfaces use employee
names and sort alphabetically. Counts are base-10 integers. A missing upload is
`Never`; a present timestamp uses a bounded relative description with no
subsecond precision. Installed and available versions use their exact semantic
version strings, and absent availability is `None`.

A healthy or intentionally off status does not print an unnecessary next step.
Exactly one `Next:` line may appear when the snapshot identifies a bounded
action, such as `raiders update` for an available release or `raiders doctor`
for a health problem. Pretty output never claims that `enabled=true` means
`Ready`.

Interactive stdout may color only the value `ON` green and `OFF` red. ANSI is
disabled when stdout is not a TTY, when `NO_COLOR` is present, and for every
JSON path. Meaning never depends on color.

`raiders status --json` prints the current `AgentStatus.description` bytes plus
the normal trailing newline. Its fields, values, ordering, daemon-live path, and
daemon-unavailable local fallback remain automation-compatible. Pretty output
is explicitly not an automation contract.

The CLI obtains live status as JSON from the existing control response, decodes
it into `AgentStatus`, and passes the value to a dedicated renderer. The local
fallback feeds that same renderer directly. Rendering is therefore separate
from status acquisition and cannot hide a socket or decoding error.

## `on` and `off` responses

Successful commands use plain language rather than daemon-oriented messages:

```text
Runtime Raiders collection is ON
Status: Preparing safely in the background.
```

or:

```text
Runtime Raiders collection is ON
Status: Ready.
```

and:

```text
Runtime Raiders collection is OFF
```

The `ON` and `OFF` words follow the same TTY/`NO_COLOR` policy as status.
Repeated `on` or `off` commands are idempotent and report the resulting state.
Turning on remains responsive while provider preparation continues in the
background. Turning off must remain responsive during preparation.

## Re-enrollment prerequisites and summary

`raiders re-enroll` replaces only the installed device enrollment. It begins by
acquiring a single owner-only recovery lock that excludes activation, updates,
uninstall, and another re-enrollment. It then requires collection to be
persistently off. If collection is on, the command exits without changing
state and instructs the user to run `raiders off` first.

The command stops and unregisters the managed background agent before credential
replacement, then verifies that it is no longer running. It does not delete the
installed app, launcher, or shim. It prints a content-free summary containing:

- collection state;
- background-agent state;
- queued-event count;
- installed version; and
- the warning that Runs, scores, and rewards remain with their original Raider.

It never prints the current or target Raider key, player ID, device ID, device
token, dedupe secret, native Run ID, cursor, local path, prompt, response, or
provider-record content.

## Queued-event disposition

Queued events must be resolved before the enrollment transaction because they
were signed for the current Raider and cannot be relabeled.

When the queue is nonempty, the user must choose one of:

1. **Deliver to current Raider.** Start a bounded one-shot uploader with the
   existing device credential while collection, file watching, and heartbeat
   remain off. Continue until the canonical outbox is empty or an upload fails.
   Any failure leaves enrollment unchanged, the agent unregistered, collection
   off, and the remaining queue intact for a later retry.
2. **Discard.** Require the user to type `DISCARD` after the displayed count.
   Delete only validated Runtime Raiders outbox records through a dedicated
   descriptor-relative outbox API. No arbitrary directory deletion is allowed.
3. **Cancel.** Make no enrollment or queue change. Collection remains off; the
   coordinator may safely register the managed agent again before exiting.

When the queue is empty, the disposition prompt is omitted. Successful delivery
or discard is journaled before proceeding. No code path copies queued records
into a replacement identity.

## Replacement credential protocol

After queue resolution, the command asks for the one-time code created from the
intended Raider's **Raider settings -> Companion Setup** page. Input is private
and is never echoed. The code remains in memory only for the request and is not
written to the recovery journal.

Before the request, the companion generates:

- a replacement device UUID;
- a cryptographically random 32-byte base64url replacement device token; and
- a recovery operation UUID.

It writes those values and the current recovery phase to an owner-only journal
inside the verified state directory. The token is a secret: the journal is a
no-follow regular file owned by the effective user with mode `0600`, written
atomically and durably. The directory remains mode `0700`. Logs, diagnostics,
errors, and tests must redact it.

The client calls an authenticated replacement endpoint:

```http
POST /api/raiders/re-enroll
Authorization: Bearer <current device token>
Content-Type: application/json

{
  "code": "<one-time code>",
  "operation_id": "<uuid>",
  "replacement_device_id": "<uuid>",
  "replacement_device_token": "<43-character base64url token>",
  "companion_version": "<installed version>"
}
```

Inside one SQLite transaction, the server:

1. validates the active current device;
2. validates and consumes the unexpired one-time code;
3. revokes the current device with `revoked_at`;
4. inserts the replacement device for the Raider selected by the code, storing
   only `sha256(replacement_device_token)`; and
5. records enough operation identity to reject conflicting reuse while making
   an exact retry deterministic.

If any step fails, none of the code consumption, old-device revocation, or new
device creation commits. Reusing an operation ID with different replacement
material is rejected. Invalid, expired, or consumed codes return a stable
content-free failure reason. The endpoint never mutates players, Runs, scores,
rewards, inventory, or other game history.

The endpoint normally requires an active old device. Its sole post-revocation
exception is an exact replay of the already-committed operation: the bearer
hash must identify that operation's old device and the operation ID, code hash,
replacement device ID, and replacement token hash must all match the recorded
transaction. That replay returns the same configuration without mutating state.
The revoked credential remains invalid for events, heartbeat, configuration
recovery, revocation, or any different replacement request.

On success, the response returns the replacement enrollment configuration:

```json
{
  "device_id": "<replacement uuid>",
  "dedupe_secret": "<target Raider secret>",
  "server_url": "https://raiders.redlattice.com",
  "cutover_at": 0,
  "enabled_surfaces": ["codex_cli", "codex_desktop"]
}
```

The device token is not echoed because the companion generated and journaled
it. Existing create-and-exchange enrollment remains compatible for fresh
installs.

## Lost-response recovery

The companion cannot assume that a failed HTTP response means the transaction
did not commit. After any ambiguous replacement result, it first tries the
replacement token against a content-free recovery endpoint:

```http
GET /api/raiders/enrollment-config
Authorization: Bearer <replacement device token>
```

An active device receives its current dedupe secret and collector configuration
in the same shape as a successful replacement. The endpoint does not return a
Raider key, display name, account data, history, or any other device token.

Recovery uses bounded backoff before deciding the replacement token is not yet
active. If it becomes active, the command completes locally without using the
old credential again. If the replacement token remains unauthorized and the
old token still authenticates, the transaction did not commit; the user is
asked for a fresh one-time code and may resume. If neither credential can
establish a coherent state, the command fails closed, preserves the journal and
both local credential materials, keeps collection off, and directs the user to
resume `raiders re-enroll` or seek assisted recovery.

The recovery endpoint also makes a crash after server commit but before local
configuration replacement resumable. The coordinator reads only a validated
journal, probes replacement configuration, and advances the state machine. It
never guesses which credential is active.

## Local commit and cursor boundary

After the server proves the replacement token active, the companion atomically
replaces `enrollment.json` with a versioned configuration containing the new
device ID/token, target dedupe secret, server URL, cutover, and enabled surfaces.
The same owner/type/mode/durability rules used by the current enrollment loader
apply to writes.

Provider cursors, active-Run facts, activation preparation, upload timestamps,
and other collector-derived state are removed through exact allowlisted state
entries and recreated at a safe historical boundary. The next `raiders on`
performs normal bounded historical discovery under the replacement identity;
it cannot reuse an old Raider's event identities or append to an old active Run.
The outbox is already empty at this point.

The managed agent is registered again only after the new configuration and safe
state boundary are durable. Collection remains persistently off after success.
The final output says re-enrollment succeeded, history was not transferred, and
the user may run `raiders status` before deliberately running `raiders on`.

The recovery journal is deleted only after configuration replacement, state
reset, agent registration, and final verification all succeed. Every phase is
idempotent.

## Ordinary uninstall

`raiders uninstall` is the recoverable removal mode. It:

1. persists collection off and stops the daemon;
2. unregisters and removes the Runtime Raiders LaunchAgent registration;
3. removes the Runtime Raiders app, launcher, installed-release/update
   machinery, and command shim; and
4. preserves the verified state directory and outbox, including enrollment,
   cursors, disabled collector state, queued events, and recovery material.

It does not revoke the device. A later official reinstall can discover and
validate the preserved enrollment and queue, install fresh executable
artifacts, and remain off until the user opts in. Output explicitly lists the
content-free categories preserved and states that browser login does not change
the preserved enrollment.

Ordinary uninstall is idempotent: an already absent app, launcher, plist, or
shim is success, provided no conflicting object occupies the owned path.

## `uninstall --everything`

`raiders uninstall --everything` is the destructive local removal mode. It
requires an interactive terminal, persists collection off, stops and
unregisters the agent, prints exact content-free categories to be deleted, and
requires the user to type:

```text
UNINSTALL EVERYTHING
```

If queued events exist, the user must first separately type `DISCARD` after the
queue count. This authorizes later deletion but does not delete a record before
server revocation is proven. `--everything` does not offer delivery because its
stated action is complete removal; a user who wants delivery must cancel, use
`re-enroll`'s delivery path or normal collection, and rerun removal with an
empty queue.

Before deleting credential state, the companion calls:

```http
POST /api/raiders/devices/revoke-current
Authorization: Bearer <current device token>
```

The server atomically sets `revoked_at` if needed. A response proving the device
is now revoked is idempotent success. An authentication, network, or ambiguous
failure triggers bounded verification and then fails closed: local deletion
does not begin until revocation is confirmed. A corrupt present enrollment also
fails closed for assisted recovery. If no enrollment file exists, there is no
local credential to revoke; the command may remove the remaining verified
artifacts after confirmation.

Only after revocation proof does the coordinator discard the authorized queue
and remove this allowlist:

- the Runtime Raiders managed plist;
- the Runtime Raiders command shim;
- the Runtime Raiders application support tree, including app, launcher,
  installation metadata, state, enrollment, journals, cursors, and outbox.

Every path component is verified as the expected owner and object type without
following symlinks. The coordinator retains open parent descriptors and rejects
path swaps, hard-link surprises for regular secret files, mounts/device changes,
unexpected entries, and any target outside the allowlist. It never walks or
deletes `.codex`, Codex sessions, another application's support directory, or
unrelated files in `~/.local/bin` or `~/Library/LaunchAgents`.

Server-side Raider/account rows and all game history remain. Complete removal
does not delete the Level 1 character or any other character; account deletion
is a separate website/admin action.

## Component boundaries

The implementation introduces narrowly testable components:

- `StatusRenderer` converts `AgentStatus` to deterministic plain text and owns
  the optional ANSI policy.
- `ReEnrollmentCoordinator` owns the local phase machine, queue disposition,
  private prompts, credential replacement, recovery, cursor reset, and final
  verification.
- `RemovalCoordinator` owns recoverable uninstall and `--everything`, including
  revocation proof and allowlisted deletion.
- `RecoveryJournalStore` performs versioned owner-only atomic journal I/O.
- `EnrollmentClient` performs replacement, configuration recovery, credential
  probes, and current-device revocation with injectable transport.
- `Outbox` gains explicit validated drain/discard operations; callers never
  delete outbox filenames directly.
- Server domain functions own the atomic replacement, idempotency, active-device
  configuration lookup, and current-device revocation. Routes only validate,
  rate-limit, authenticate, and map domain results to stable HTTP responses.

Prompts, filesystem operations, managed-agent operations, randomness, clocks,
and HTTP transport are injected for deterministic tests. Coordinators do not
depend on global stdin/stdout in unit tests.

## Error and privacy rules

- Secrets never appear in argv, process listings, stdout, stderr, logs, crash
  diagnostics, control-socket messages, snapshots, or release evidence.
- All user-visible failures are content-free and identify the safe next action.
- Invalid journals, enrollment files, symlinks, ownership, permissions, or
  unexpected filesystem objects fail closed before mutation.
- Server responses distinguish actionable categories without confirming whether
  an arbitrary Raider or credential exists.
- Endpoints use existing JSON size/content-encoding restrictions and separate
  per-IP and authenticated-device rate limits.
- Re-enrollment and removal do not run concurrently with updates or activation.
- Interruption at any phase leaves either the old enrollment valid or the new
  enrollment recoverable; collection never turns itself on.

## Test strategy

Implementation follows test-driven slices and adds coverage at four levels.

### Swift unit and integration tests

- exact pretty snapshots for off, preparing, ready, needs-attention, update
  available, never-uploaded, and daemon-unavailable states;
- unchanged sorted JSON for `status --json` through live and local paths;
- ANSI only for interactive output and never with `NO_COLOR`, redirection, or
  JSON;
- exact `on`/`off` language and idempotent outcomes;
- command routing, usage, help, TTY requirements, and private input;
- queue deliver, discard, cancel, partial delivery failure, and empty queue;
- re-enrollment to the same Raider and a different intended Raider;
- invalid, expired, consumed, and revoked credentials;
- crash/interruption before request, during ambiguous response, after server
  commit, during local config replacement, during cursor reset, during agent
  registration, and before journal cleanup;
- proof that old tokens fail and replacement tokens succeed after commit;
- recoverable uninstall preservation and reinstall discovery;
- `--everything` confirmation, queued discard, revocation failure, retry, and
  idempotent completion;
- symlink, hard-link, path-swap, ownership, mode, unexpected-entry, and
  cross-device rejection; and
- proof that Codex sessions and unrelated files cannot be selected or removed.

### Server domain and route tests

- replacement is one transaction and exact retries are deterministic;
- conflicting operation reuse is rejected;
- code consumption, old revocation, and replacement insertion all roll back on
  every failure branch;
- configuration recovery accepts only active replacement credentials;
- revocation is idempotent and immediately blocks events and heartbeat;
- replacement may target the same or a different Raider selected only by the
  one-time code;
- raw account and game-history tables are unchanged; and
- schemas, body limits, encoding rejection, authentication, and rate limits
  match existing endpoint policy.

### Installer and shell tests

- fresh install, preserved-state reinstall, re-enrollment recovery, ordinary
  uninstall, and complete removal under both `/bin/sh` and `/bin/zsh`;
- exact managed plist/app/launcher/shim ownership and cleanup;
- no Bash-only syntax in copy-paste or installer paths; and
- successful install handoff states that Runtime Raiders is installed,
  collection starts off, `raiders status` checks setup, and `raiders on` opts in.

### Release-gate regression

Run the full Node suite, TypeScript checking, Swift tests, installer tests,
shell safety tests, signing-layout preflight, and local fresh/reinstall/recovery
matrices. No public artifact or production endpoint is changed by these tests.

## Acceptance criteria

- An employee can tell whether collection is off, preparing, or ready without
  reading JSON or exposing content.
- Automation receives the exact existing structured status through
  `raiders status --json`.
- `on` and `off` state plainly that Runtime Raiders collection is `ON` or `OFF`.
- Re-enrollment cannot begin while collection is on and cannot silently move
  queued work.
- A successful replacement revokes the old device, activates only the intended
  replacement credential, resets collector state safely, and remains off.
- A lost server response or process interruption is resumable without guessing
  which device is active.
- Ordinary uninstall removes executable/background artifacts while preserving
  enrollment, cursors, and queue for reinstall.
- `uninstall --everything` confirms queue discard, proves server revocation,
  and removes only Runtime Raiders-owned local artifacts.
- Raiders, accounts, Runs, scores, rewards, and inflated beta history remain
  unchanged.
- No secret, provider content, local path, or native Run identity appears in
  user output, logs, diagnostics, or test snapshots.
- The implementation branch creates no 0.4.9 artifact and performs no
  publication, deployment, or production mutation.

# Runtime Raiders Employee Beta Simplification Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a signed Runtime Raiders beta that fifteen employees can install or reinstall with one `curl | sh` command, while `raiders update` only reports whether that command should be run.

**Architecture:** Keep the existing content-free Codex collector, enrollment, upload, scoring, and server controls. Repair activation by moving the initial history boundary scan off the control-request path. Replace the self-updater with an anonymous daily `GET /version`. Install one signed app at one stable path, and publish only `install.sh`, one ZIP, and `version` through one repeatable release command.

**Tech Stack:** Swift 6 / Foundation / FSEvents / launchd on macOS 13+, XCTest, POSIX shell plus Bash for operator scripts, Node.js 20, TypeScript, Vitest, Caddy, Apple codesign/notarization.

**Spec:** `docs/superpowers/specs/2026-08-18-runtime-raiders-beta-simplification-design.md`

## Global Constraints

- Do not revert or replace the repository. Simplify forward from the current `main` branch.
- Preserve the sequence-16 source boundary at commit `b0eaa7be15f69c87a55ea3ad7a21e8c6b7e6d0d2` with an archival tag before implementation.
- Do not delete or rewrite existing ignored `dist/sequence-*` evidence.
- Preserve the existing enrollment, content-free event schema, outbox, deduplication, upload, scoring, server pause, and server enable/disable behavior.
- Fresh installs start with collection off. Reinstalls preserve enrollment, state, queued events, and the prior on/off preference.
- No implementation step publishes, deploys, installs, enables collection, changes Caddy, or contacts the Pi unless that step explicitly says it is the separately approved signed-release boundary.
- Run shell-facing tests under both `/bin/sh` and `/bin/zsh`. Invoke `/bin/bash` explicitly for Bash-only operator scripts.
- Never print enrollment codes, device tokens, signing identities, notary credentials, artifact contents, or telemetry source records.
- Keep `docs/BACKLOG.md` out of implementation commits unless the user separately asks to update it; it contains pre-existing user changes.
- Employee beta readiness is reached at the end of Task 7. Task 8 is post-verification deletion of obsolete machinery and is not allowed to delay the employee beta.

## File and Responsibility Map

| Area | Files | Responsibility after simplification |
|---|---|---|
| Collector activation | `companion/Sources/RuntimeRaidersCore/AgentController.swift`, new `ActivationCoordinator.swift`, `FileWatcher.swift`, `companion/Sources/RuntimeRaidersCLI/main.swift` | Return from `on` immediately in `preparing`, seed historical files in bounded background work, become `ready`, keep `status` and `off` responsive |
| Status/control | `AgentController.swift`, `ControlSocket.swift`, `main.swift` | Expose only `disabled`, `preparing`, and `ready`; remove prepared-update controls |
| Version check | new `VersionDocument.swift`, simplified `ReleaseChecker.swift`, `main.swift` | Anonymous daily `GET /version`; notification and informational `raiders update` only |
| Stable install layout | `AgentPaths.swift`, `ControlSocket.swift`, `companion/Package.swift`, launchd template | One app, one executable, one LaunchAgent, one shim; no launcher or release generations |
| Installer | `companion/packaging/install.sh`, `tests/companion-installer.test.ts` | Verify candidate, preserve state, stop old job, atomic replace with rollback, restart |
| Build/release | `companion/RELEASE`, `scripts/release/build-runtime-raiders-agent.sh`, new `release-runtime-raiders-beta.sh` | Build/sign/notarize one app archive and optionally publish/test it through one entry point |
| Public files | `deploy/Caddyfile`, new `scripts/pi/publish-runtime-raiders-beta.sh`, related Vitest files | Serve exactly `/install.sh`, `/downloads/runtime-raiders-agent.zip`, `/version`; publish `version` last |
| Operations docs | new `docs/runtime-raiders/employee-beta.md`, `docs/PI_SETUP.md`, `README.md` | Employee install/use and one repeatable operator release procedure |
| Retired code | updater, launcher, migration, release-generation files and their tests | Delete only after Task 7 produces signed fresh-install evidence |

---

### Task 0: Preserve the current boundary and establish a clean implementation start

**Files:**

- Verify: `docs/superpowers/specs/2026-08-18-runtime-raiders-beta-simplification-design.md`
- Verify: `docs/BACKLOG.md`
- Git object: archival tag `runtime-raiders-sequence-16`

- [ ] **Step 1: Confirm the exact preserved commit and working tree**

Run:

```bash
git rev-parse b0eaa7be15f69c87a55ea3ad7a21e8c6b7e6d0d2^{commit}
git status --short --branch
```

Expected: the first command prints the same 40-character SHA. Record all existing working-tree changes and preserve them. In particular, do not stage `docs/BACKLOG.md`.

- [ ] **Step 2: Create the archival tag without moving a branch**

Run:

```bash
git tag -a runtime-raiders-sequence-16 b0eaa7be15f69c87a55ea3ad7a21e8c6b7e6d0d2 -m "Archive Runtime Raiders sequence 16 before employee beta simplification"
git rev-list -n 1 runtime-raiders-sequence-16
```

Expected: the second command prints `b0eaa7be15f69c87a55ea3ad7a21e8c6b7e6d0d2`. Do not push the tag in this task.

- [ ] **Step 3: Create the implementation branch from current `main`**

Run:

```bash
git switch -c codex/runtime-raiders-employee-beta
```

If that branch already exists, inspect it and continue only when it points at the approved design commit. Do not reset either branch.

---

### Task 1: Make activation asynchronous, bounded, and observable

**Files:**

- Create: `companion/Sources/RuntimeRaidersCore/ActivationCoordinator.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ActivationCoordinatorTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentController.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/FileWatcher.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`

**Interfaces:**

```swift
public enum CollectorActivationState: String, Codable, Equatable, Sendable {
    case disabled
    case preparing
    case ready
}

public struct ActivationOperations: @unchecked Sendable {
    public let startWatching: @Sendable () throws -> Void
    public let stopWatching: @Sendable () -> Void
    public let discoverProviderFiles: @Sendable () throws -> [URL]
    public let becameReady: @Sendable () -> Void
    public let becameDisabled: @Sendable () -> Void
}

public final class ActivationCoordinator: @unchecked Sendable {
    public func turnOn() throws -> CollectorActivationState
    public func turnOff() throws
    public func processChangedFiles(_ files: [URL])
}
```

`CollectorActivationState` is derived from existing state and is not added to `collector-state.json`:

```swift
public var activationState: CollectorActivationState {
    guard enabled else { return .disabled }
    return isAcceptingCollection ? .ready : .preparing
}
```

- [ ] **Step 1: Write failing controller state-transition tests**

Add tests proving:

1. a missing or disabled state reports `disabled`;
2. `beginTurnOn()` persists `enabled=true` and reports `preparing` without reading historical content;
3. boundary seeding produces no Run and no uploadable event;
4. completion reports `ready`;
5. `turnOff()` from `preparing` returns to `disabled` and leaves queued data intact;
6. restart while preparing derives `preparing` from the existing `enabled` plus seeding fields.

Run:

```bash
cd companion && swift test --filter AgentControllerTests
```

Expected: FAIL because `CollectorActivationState` and `beginTurnOn()` do not exist and current `turnOn(existingFiles:)` drains synchronously.

- [ ] **Step 2: Split fast activation intent from background preparation**

Add `beginTurnOn()` to `AgentController`. It must set `enabled`, reset the run registry, mark known files for seeding, persist, and return without discovery or a read loop:

```swift
public func beginTurnOn() throws {
    pauseCollection()
    try lock.withLock {
        guard !state.enabled else { return }
        state.enabled = true
        runRegistry = RunRegistry()
        pendingPaths.removeAll()
        for path in state.files.keys {
            guard var file = state.files[path] else { continue }
            file.seeding = true
            file.adapterSnapshots = try snapshotsPreparedForSeeding(from: file.adapterSnapshots)
            file.cursor = JSONLCursor()
            file.nextOrdinal = 0
            file.seedTargetOffset = nil
            file.seedFileIdentity = nil
            file.seedTargetCheckpoint = nil
            state.files[path] = file
        }
        try persist()
    }
}
```

Keep `install(existingFiles:)` as the inventory reconciliation and boundary-capture operation. Remove the synchronous `while hasPendingSeedWork` loop from the command path. Historical parsing continues only through existing bounded `continuePendingWork()` calls.

- [ ] **Step 3: Write failing 816-file coordinator tests**

In `ActivationCoordinatorTests.swift`, create 816 valid JSONL files under a temporary Codex root. Use a discovery closure blocked by an XCTest expectation so the test can prove:

```swift
let state = try coordinator.turnOn()
XCTAssertEqual(state, .preparing)
XCTAssertLessThan(turnOnElapsed, 0.25)
XCTAssertEqual(controller.activationState, .preparing)
```

While discovery is blocked, call `turnOff()` and require it to finish in under 250 ms. A second test releases discovery, waits for `ready`, appends one synthetic post-boundary Codex Desktop completion, and requires exactly one Run and no historical Runs.

Run:

```bash
cd companion && swift test --filter ActivationCoordinatorTests
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 4: Implement `ActivationCoordinator` with cancellation generations**

`turnOn()` must:

1. call `controller.beginTurnOn()`;
2. start FSEvents without its redundant automatic full scan;
3. enqueue discovery, `controller.install(existingFiles:)`, and bounded continuations on the worker queue;
4. call `becameReady` once when the same activation generation reaches `ready`.

`turnOff()` must increment the generation before stopping the watcher and persisting off, so stale discovery cannot re-enable upload or heartbeat. Add `FileWatcher.start(scanExistingFiles: Bool = true)` and call it with `false` from this coordinator; existing callers retain the default until Task 3 simplifies startup.

Do not cancel by deleting state or abandoning a half-written state file. Each worker iteration checks its captured generation and `controller.enabled` before continuing.

- [ ] **Step 5: Make the daemon control path use the coordinator**

Replace the `.on` and `.off` `workQueue.sync` blocks in `DaemonRuntime.handle`:

```swift
case .on:
    do {
        let state = try activation.turnOn()
        return ControlResponse(ok: true, message: state.rawValue)
    } catch {
        return ControlResponse(ok: false, message: "unable to enable")
    }
case .off:
    do {
        try activation.turnOff()
        return ControlResponse(ok: true, message: "disabled")
    } catch {
        return ControlResponse(ok: false, message: "unable to turn off")
    }
```

Only `becameReady` enables the uploader and heartbeat. `becameDisabled` disables both immediately. `status` reads `controller.activationState` and never waits for discovery.

- [ ] **Step 6: Add `activationState` to `AgentStatus` and update status assertions**

Keep `enabled` for backward-readable output during this task, but add:

```swift
public let activationState: CollectorActivationState
```

Require JSON to contain `"activationState":"disabled"`, `"preparing"`, or `"ready"`. Update old tests that assumed `turnOn(existingFiles:)` returned only after readiness to drive continuations explicitly.

- [ ] **Step 7: Run focused and full Swift tests**

Run:

```bash
cd companion && swift test --filter ActivationCoordinatorTests
cd companion && swift test --filter AgentControllerTests
cd companion && swift test --filter ControlProtocolTests
cd companion && swift test
```

Expected: PASS. The 816-file test proves prompt `on`, `status`, and `off`, historical suppression, and one post-ready Run.

- [ ] **Step 8: Commit the activation repair**

```bash
git add companion/Sources/RuntimeRaidersCore/ActivationCoordinator.swift companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Sources/RuntimeRaidersCore/FileWatcher.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/ActivationCoordinatorTests.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift
git commit -m "fix(raiders): make collector activation responsive"
```

---

### Task 2: Replace release manifests and self-update with `/version`

**Files:**

- Create: `companion/Sources/RuntimeRaidersCore/VersionDocument.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/VersionDocumentTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ReleaseChecker.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ReleaseCheckerTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentController.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`

**Wire contract:**

```json
{"version":"0.4.0"}
```

**Interfaces:**

```swift
public struct SemanticVersion: Comparable, Equatable, Sendable {
    public init(_ rawValue: String) throws
}

public struct VersionDocument: Equatable, Sendable {
    public static let url = URL(string: "https://raiders.redlattice.com/version")!
    public let version: String
    public static func decode(_ data: Data) throws -> VersionDocument
}

public enum VersionCheckResult: Equatable, Sendable {
    case notDue
    case checked(availableVersion: String?)
    case failed
}
```

- [ ] **Step 1: Write failing strict version-document tests**

Require exactly one JSON key named `version`. Accept stable three-part numeric versions such as `0.4.0` and `12.3.45`. Reject extra keys, missing keys, strings with whitespace, leading `v`, prerelease/build suffixes, negative values, and numeric overflow. Comparison is numeric, not lexical.

Run:

```bash
cd companion && swift test --filter VersionDocumentTests
```

Expected: FAIL because the new types do not exist.

- [ ] **Step 2: Implement the version parser and document decoder**

Parse three base-10 integer components separated by exactly two dots. Store the original canonical string for display. Do not accept or fetch an archive URL, digest, release sequence, release SHA, protocol generation, or publisher identity.

- [ ] **Step 3: Replace `ReleaseChecker` state with version-only state**

Retain the useful 24-hour cadence and one-notification-per-version behavior. The persisted update state becomes:

```swift
struct UpdateStateV1: Codable, Equatable {
    var version = 1
    var lastCheckAttemptMS: Int64?
    var lastNotifiedVersion: String?
    var availableVersion: String?
}
```

The live request must be an anonymous `GET` to `VersionDocument.url` with no body, cookies, authorization, device token, custom user identifier, or telemetry fields. Keep the 64 KiB response cap and HTTPS-only redirect rejection. The notifier text remains exactly `Run raiders update.`

- [ ] **Step 4: Replace the foreground updater with an informational command**

Delete the `CompanionUpdater` construction from `runForegroundUpdate`. Rename the function to `runUpdateCheck` and make it perform one fresh version fetch.

When newer:

```text
Runtime Raiders 0.4.0 is available.
Run:
curl -fsSL https://raiders.redlattice.com/install.sh | sh
```

When current:

```text
Runtime Raiders 0.4.0 is current.
```

A network or invalid-response error prints `Unable to check for a Runtime Raiders update.` to stderr and exits nonzero. It must not stop launchd, download an app, acquire an update lock, mutate release state, or alter the installed app.

- [ ] **Step 5: Update status to version-only availability**

Remove `availableReleaseSequence`, `preparedForUpdate`, and `preparedReleaseStateGeneration` from `AgentStatus`. Preserve:

```swift
public let installedCompanionVersion: String
public let availableCompanionVersion: String?
public let updateCommand: String?
```

When an update is known, `updateCommand` is `raiders update` because that is the safe discovery command; its output gives the reinstall command.

- [ ] **Step 6: Prove daily and manual checks are anonymous and non-mutating**

Update `ReleaseCheckerTests` to verify:

- the daemon attempts at most once per 24 hours;
- clock rollback cannot create a rapid retry loop;
- the same available version notifies once;
- a higher version notifies once;
- `raiders update` always fetches immediately;
- the request has only method and URL;
- update state is the only local file changed by a check;
- no archive-download or install operation is reachable.

Run:

```bash
cd companion && swift test --filter VersionDocumentTests
cd companion && swift test --filter ReleaseCheckerTests
cd companion && swift test --filter ControlProtocolTests
cd companion && swift test
```

Expected: PASS.

- [ ] **Step 7: Commit the version-only updater**

```bash
git add companion/Sources/RuntimeRaidersCore/VersionDocument.swift companion/Sources/RuntimeRaidersCore/ReleaseChecker.swift companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/VersionDocumentTests.swift companion/Tests/RuntimeRaidersCoreTests/ReleaseCheckerTests.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift
git commit -m "feat(raiders): make updates informational"
```

---

### Task 3: Flatten runtime command routing and installed paths

**Files:**

- Modify: `companion/Sources/RuntimeRaidersCore/AgentPaths.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Modify: `companion/Package.swift`
- Modify: `companion/packaging/com.redlattice.runtime-raiders-agent.plist.template`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift`

**Stable paths:**

```text
$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app
$HOME/Library/Application Support/Runtime Raiders/state
$HOME/Library/Application Support/Runtime Raiders/outbox
$HOME/Library/Application Support/Runtime Raiders/agent.sock
$HOME/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist
$HOME/.local/bin/raiders
```

- [ ] **Step 1: Write failing flat-layout route tests**

Require `AgentPaths` to expose `agentApplication` and `agentExecutable` at the stable app path. Require `raiders`, `raiders daemon`, `on`, `off`, `status`, `doctor`, `update`, and `uninstall` to route without a release-state file, launcher, trial generation, migration generation, or prepared lease.

Require all hidden updater/migration routes to return `nil`.

Run:

```bash
cd companion && swift test --filter ControlProtocolTests
```

Expected: FAIL because routing currently requires `release-state.json` and includes installer/update commands.

- [ ] **Step 2: Simplify `AgentPaths`**

Keep only support/state/outbox/socket/update-check paths plus:

```swift
public let agentApplication: URL
public let agentExecutable: URL
```

Remove launcher, release-directory, release-state, update-journal, and generation path helpers from this public interface. Keep state and outbox paths byte-for-byte compatible.

- [ ] **Step 3: Reduce command and control enums**

`ControlCommand` becomes:

```swift
public enum ControlCommand: String, CaseIterable, Codable, Sendable {
    case daemon
    case on
    case off
    case status
    case doctor
    case uninstall
}
```

`CompanionCommandRoute` becomes:

```swift
public enum CompanionCommandRoute: Equatable, Sendable {
    case daemon
    case control(ControlCommand)
    case updateCheck
}
```

The daemon route verifies that `Bundle.main.executableURL` resolves to `paths.agentExecutable`. Remove prepared-update gating and abandonment handling from `DaemonRuntime`.

- [ ] **Step 4: Make startup use the normal collector state**

Delete `PreparedDaemonStartupCoordinator` use in `main.swift`. Normal daemon startup must:

1. load enrollment;
2. create core collector objects;
3. start the control socket immediately;
4. if persisted state is enabled, call the Task 1 activation coordinator;
5. otherwise remain disabled;
6. schedule the daily version check.

No startup path reads release generations or resumes a prepared update.

- [ ] **Step 5: Reduce SwiftPM products to the core library and one executable**

`companion/Package.swift` products must be exactly:

```swift
.library(name: "RuntimeRaidersCore", targets: ["RuntimeRaidersCore"]),
.executable(name: "raiders", targets: ["RuntimeRaidersCLI"]),
```

Remove the launcher and release-validator targets. Their source files are deleted in Task 8 after signed verification; until then they are simply no longer products.

- [ ] **Step 6: Point launchd directly at the signed app executable**

The plist `ProgramArguments` must contain the stable `Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent` followed by the literal `daemon` argument. It must not reference `launcher`, `release-state`, a sequence, or a trial generation.

- [ ] **Step 7: Run routing, package, and full Swift tests**

```bash
cd companion && swift package dump-package
cd companion && swift test --filter ControlProtocolTests
cd companion && swift test
```

Expected: PASS; `dump-package` lists one executable product and no launcher or validator product.

- [ ] **Step 8: Commit the flat runtime**

```bash
git add companion/Package.swift companion/Sources/RuntimeRaidersCore/AgentPaths.swift companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/packaging/com.redlattice.runtime-raiders-agent.plist.template companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift
git commit -m "refactor(raiders): use one stable installed app"
```

---

### Task 4: Replace the installer with a small reinstall-safe transaction

**Files:**

- Replace: `companion/packaging/install.sh`
- Replace: `tests/companion-installer.test.ts`
- Modify: `src/web/companion-install.ts`
- Modify: `tests/runtime-raiders-e2e.test.ts`
- Modify: `package.json`

**Installer transaction:** verify candidate, preserve state, stop job, backup old app, replace app and support files, restart, verify health, delete backup. On failure after stop, restore the old app and restart it.

- [ ] **Step 1: Replace the installer test suite with the approved beta contract**

Use a fake HOME plus mocked `curl`, `ditto`, `codesign`, `spctl`, `launchctl`, and enrollment endpoint. Cover these exact cases:

1. fresh install starts off and enrolls once;
2. reinstall never asks for an enrollment code;
3. reinstall preserves `state/`, `outbox/`, and collector enabled preference byte-for-byte;
4. candidate signature, bundle ID, version, archive shape, and executable are verified before `launchctl bootout`;
5. a bad candidate never stops the current daemon;
6. success replaces the app, plist, and shim and restarts once;
7. failure after stop restores the old app and restarts it;
8. `$HOME/.local/bin/raiders` targets the flat app executable;
9. symlinked support/state/outbox/app/plist/shim paths are rejected;
10. no launcher, releases directory, release state, update journal, sequence, or prepared command is created;
11. the current sequence-16 versioned layout is refused with a clear fresh-canary cleanup message rather than migrated;
12. `/bin/sh` and `/bin/zsh` both parse and execute the rendered test installer;
13. the enrollment code never appears in argv, logs, or generated files;
14. a network failure leaves the existing install running;
15. repeated execution is idempotent.

Run:

```bash
npx vitest run tests/companion-installer.test.ts
```

Expected: FAIL against the versioned installer.

- [ ] **Step 2: Implement a POSIX installer with one archive URL**

The permanent public template contains only these release substitutions:

```sh
COMPANION_VERSION='__RUNTIME_RAIDERS_COMPANION_VERSION__'
TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'
ARCHIVE_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'
```

Download into a private `mktemp -d` directory. Extract there and require exactly one top-level `Runtime Raiders Agent.app`, no symlinks, no `__MACOSX`, the expected bundle ID and version, and a regular executable.

Verify before stopping:

```sh
/usr/bin/codesign --verify --deep --strict --verbose=2 "$CANDIDATE_APP"
/usr/bin/codesign --verify --strict -R "$AGENT_REQUIREMENT" "$CANDIDATE_APP"
/usr/sbin/spctl --assess --type execute --verbose=2 "$CANDIDATE_APP"
```

The Apple signature is the archive-integrity and publisher check. Do not fetch a hash manifest or publisher record.

- [ ] **Step 3: Preserve enrollment and collection state**

If `state/enrollment.json` exists and passes current owner/mode/schema checks, reuse it before any prompt or enrollment network request. Otherwise read the enrollment code from `/dev/tty`, call the existing enrollment endpoint once, and write the returned content-free configuration owner-only.

Never run `raiders off` during reinstall because that would change the employee's preference. Stop only the LaunchAgent process:

```sh
/bin/launchctl bootout "gui/$(/usr/bin/id -u)/com.redlattice.runtime-raiders-agent" 2>/dev/null || true
```

Move the old app to a private same-filesystem backup, move the candidate into the stable path, install the plist atomically, update the shim atomically, bootstrap, and require `raiders status` to return. Restore and re-bootstrap the backup if any post-stop step fails.

- [ ] **Step 4: Keep the website command simple**

The rendered employee command remains exactly:

```text
curl -fsSL https://raiders.redlattice.com/install.sh | sh
```

Keep the existing safe copy/download wrapper used by the web page if it is transparent to the displayed command, but remove text that tells an existing user to run an automatic updater.

- [ ] **Step 5: Run shell, installer, web, and full app tests**

```bash
/bin/sh -n companion/packaging/install.sh
/bin/zsh -n companion/packaging/install.sh
npx vitest run tests/companion-installer.test.ts tests/runtime-raiders-e2e.test.ts
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the simple installer**

```bash
git add companion/packaging/install.sh tests/companion-installer.test.ts src/web/companion-install.ts tests/runtime-raiders-e2e.test.ts package.json
git commit -m "feat(raiders): add reinstall-safe curl installer"
```

---

### Task 5: Build, sign, and validate one app archive

**Files:**

- Modify: `companion/RELEASE`
- Replace: `scripts/release/build-runtime-raiders-agent.sh`
- Delete: `scripts/release/render-runtime-raiders-installer.sh`
- Delete: `scripts/release/build-runtime-raiders-release-validator.sh`
- Replace: `scripts/test/verify-runtime-raiders-signed-release.sh`
- Modify: `tests/companion-installer.test.ts`

**Local release output:**

```text
dist/runtime-raiders-beta-0.4.0/
  install.sh
  runtime-raiders-agent.zip
  version
  release-summary.txt
```

Only the first three files are public. `release-summary.txt` is local operator evidence and contains Git SHA, version, app signing facts, notarization result, file sizes, and SHA-256 values for diagnosis; clients never fetch or interpret it.

- [ ] **Step 1: Write failing one-app build-contract tests**

Require the build script to:

- refuse a dirty tracked worktree;
- require `RUNTIME_RAIDERS_CODESIGN_IDENTITY`, `RUNTIME_RAIDERS_NOTARY_PROFILE`, and `RUNTIME_RAIDERS_TEAM_ID`;
- build universal arm64 and x86_64 `raiders` binaries;
- package exactly one app;
- sign, notarize, staple, and assess it;
- emit the three public files and one local summary;
- render `version` as exactly `{"version":"0.4.0"}` plus a newline;
- contain no launcher, validator, release sequence, generation, public checksum, or update manifest.

Run:

```bash
npx vitest run tests/companion-installer.test.ts -t "release build"
```

Expected: FAIL against the current quartet builder.

- [ ] **Step 2: Reduce `companion/RELEASE` to a version source**

Use exactly:

```text
format=1
companion_version=0.4.0
```

The version must equal `CFBundleShortVersionString`, `CFBundleVersion`, the rendered installer version, and `/version`.

- [ ] **Step 3: Rewrite the build script around one executable and one app**

Build `raiders` for both architectures, combine with `lipo`, create the app bundle, codesign with hardened runtime and timestamp, submit the notarization ZIP, staple, and run:

```bash
codesign --verify --deep --strict --verbose=2 "$AGENT_APP"
spctl --assess --type execute --verbose=2 "$AGENT_APP"
xcrun stapler validate "$AGENT_APP"
```

Create the distribution ZIP with `ditto -c -k --keepParent`. Validate its one-app shape locally. Render `install.sh` directly from the template using only version and Team ID.

- [ ] **Step 4: Replace the signed-release verifier**

The verifier accepts one release directory, validates the three public files plus local summary, rechecks archive shape and Apple trust, runs the installer in a disposable fake HOME, confirms fresh state is off, then runs the informational update check against an injected local `/version` response.

It must not contact production, install into the real HOME, use real launchd, enroll, publish, or enable collection.

- [ ] **Step 5: Run unsigned structural tests**

```bash
/bin/bash -n scripts/release/build-runtime-raiders-agent.sh
/bin/bash -n scripts/test/verify-runtime-raiders-signed-release.sh
npx vitest run tests/companion-installer.test.ts
cd companion && swift test
npm test
```

Expected: PASS without signing or network access. The actual signed build remains Task 7.

- [ ] **Step 6: Commit the one-app builder**

```bash
git add companion/RELEASE scripts/release/build-runtime-raiders-agent.sh scripts/test/verify-runtime-raiders-signed-release.sh tests/companion-installer.test.ts
git rm scripts/release/render-runtime-raiders-installer.sh scripts/release/build-runtime-raiders-release-validator.sh
git commit -m "build(raiders): produce one signed beta archive"
```

---

### Task 6: Add one repeatable release-and-publication command

**Files:**

- Create: `scripts/release/release-runtime-raiders-beta.sh`
- Create: `scripts/pi/publish-runtime-raiders-beta.sh`
- Create: `tests/runtime-raiders-beta-release.test.ts`
- Modify: `deploy/Caddyfile`
- Modify: `tests/deploy-runtime-raiders.test.ts`
- Modify: `scripts/pi/setup-caddy.sh`
- Create: `docs/runtime-raiders/employee-beta.md`
- Modify: `docs/PI_SETUP.md`
- Modify: `README.md`

**Operator commands:**

```bash
/bin/bash scripts/release/release-runtime-raiders-beta.sh prepare
/bin/bash scripts/release/release-runtime-raiders-beta.sh publish
```

`prepare` is local only. `publish` repeats all local checks, builds if no matching verified output exists, asks for the normal SSH/sudo authorization once, uploads, publishes, and runs public read-only tests. It never runs `raiders on` and never unpauses or deploys the game server.

- [ ] **Step 1: Write failing release-script tests with fake signing and remote commands**

Require:

- only `prepare` and `publish` modes;
- clean Git HEAD and exact version checks;
- one call into the Task 5 builder;
- publication refuses missing or failed local verification;
- remote staging is private and initially absent;
- `version` is renamed into place last;
- a failure before `version` leaves the prior public version unchanged;
- public verification fetches exactly `/install.sh`, the ZIP, `/version`, `/health`, and no manifest/checksum paths;
- the script prints a short final summary with version, Git SHA, public URLs, and `collection remains off`;
- no command changes Node, the database, scoring, pause state, or employee collection.

Run:

```bash
npx vitest run tests/runtime-raiders-beta-release.test.ts
```

Expected: FAIL because the scripts do not exist.

- [ ] **Step 2: Implement the small root-side publisher**

`scripts/pi/publish-runtime-raiders-beta.sh` accepts one owner-only staging directory beneath `/var/lib/runtime-raiders/staging`, validates that it contains only the three public files, rechecks JSON and shell syntax, then installs into `/var/lib/runtime-raiders/public` using same-directory temporary files.

Commit order is:

1. `runtime-raiders-agent.zip`;
2. `install.sh`;
3. `version` last.

Each target is replaced with `mv` on the same filesystem. A failure before step 3 leaves the previously visible `version`, so installed clients are not told that a new release is ready. The script does not reload Caddy or restart Node.

- [ ] **Step 3: Implement the local one-entry-point release script**

The script reads the version from `companion/RELEASE`, uses a deterministic `dist/runtime-raiders-beta-$VERSION` output, runs the complete local verifier, and stops after `prepare` with:

```text
Prepared Runtime Raiders 0.4.0 locally.
Nothing was published or installed.
To publish after approval, run:
/bin/bash scripts/release/release-runtime-raiders-beta.sh publish
```

`publish` uploads to a unique private remote staging directory and invokes the checked-in publisher through one SSH session. Keep host and remote user configurable with `RUNTIME_RAIDERS_RELEASE_HOST`, defaulting to the documented Pi SSH target; do not put passwords or tokens in the repository.

- [ ] **Step 4: Simplify Caddy to three literal paths**

Point the three handlers at `/var/lib/runtime-raiders/public`. Delete checksum and update-manifest handlers. Add:

```caddyfile
handle /version {
	header Cache-Control "no-store"
	header X-Content-Type-Options "nosniff"
	header Content-Type "application/json; charset=utf-8"
	root * /var/lib/runtime-raiders/public
	file_server
}
```

Keep the existing fallback proxy, TLS, DNS resolver, compression, and hostnames unchanged.

- [ ] **Step 5: Document the employee and operator experience in plain language**

`docs/runtime-raiders/employee-beta.md` must lead with:

```text
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
```

Then document the two release modes, required signing environment variable names, one SSH/sudo authorization, expected success output, rollback by republishing a previously retained local release directory, and the rule that publishing does not enable anyone's collector.

Keep detailed historical sequence/canary documents for Task 8 cleanup, but make this page the only active beta runbook linked by README and PI setup.

- [ ] **Step 6: Run release, Caddy, shell, and documentation contract tests**

```bash
/bin/bash -n scripts/release/release-runtime-raiders-beta.sh
/bin/bash -n scripts/pi/publish-runtime-raiders-beta.sh
npx vitest run tests/runtime-raiders-beta-release.test.ts tests/deploy-runtime-raiders.test.ts
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the repeatable release path**

```bash
git add scripts/release/release-runtime-raiders-beta.sh scripts/pi/publish-runtime-raiders-beta.sh tests/runtime-raiders-beta-release.test.ts deploy/Caddyfile tests/deploy-runtime-raiders.test.ts scripts/pi/setup-caddy.sh docs/runtime-raiders/employee-beta.md docs/PI_SETUP.md README.md
git commit -m "feat(raiders): add one-command beta release path"
```

---

### Task 7: Build and verify the signed employee beta at the separate approval boundary

**Files/evidence:**

- Produce locally: `dist/runtime-raiders-beta-0.4.0/`
- Verify: signed app, installer, ZIP, `/version`, real fresh install, activation behavior
- Do not commit: signing output, credentials, enrollment code, device token, real telemetry source files

- [ ] **Step 1: Run the complete pre-signing suite**

```bash
cd companion && swift test
npm test
npm run typecheck
/bin/sh -n companion/packaging/install.sh
/bin/zsh -n companion/packaging/install.sh
/bin/bash -n scripts/release/release-runtime-raiders-beta.sh
git status --short
```

Expected: all tests pass and tracked source is clean. Existing unrelated user changes remain explicitly excluded.

- [ ] **Step 2: Request one authorization for the complete signed local preparation**

Run only after the user approves signing/notary network access:

```bash
/bin/bash scripts/release/release-runtime-raiders-beta.sh prepare
```

Expected: one locally verified signed release directory, no publication, no real installation, and no collection change.

- [ ] **Step 3: Dispose of the current sequence-16 canary install**

First record read-only `raiders status` and confirm any desired local beta data is disposable. Use the existing sequence-16 uninstall path, then verify the launcher, versioned release directories, release-state files, LaunchAgent, and shim are gone while unrelated user files remain untouched.

This is the only supported transition from the private sequence-16 canary. The public installer intentionally contains no sequence migration logic.

- [ ] **Step 4: Fresh-install the locally verified signed beta while the game remains paused**

Execute the recorded local `install.sh`, not the public URL. Verify Apple trust again at the installed path. Confirm:

- flat app path exists;
- LaunchAgent points directly at it;
- shim resolves to it;
- state starts `disabled`;
- enrollment is present once;
- `raiders status`, `doctor`, `update`, and `off` return promptly.

- [ ] **Step 5: Run the real 816-file activation acceptance test**

Quit Codex completely so the watched history is quiet, then run from the
reviewed checkout:

```bash
/bin/bash scripts/test/run-runtime-raiders-live-activation-gate.sh
```

With the known 816-file Codex corpus present, the runner must:

1. record game Run/score/token baselines;
2. run `raiders on` and require an immediate `preparing` response;
3. repeatedly run `raiders status` and require prompt responses;
4. require transition to `ready` without historical upload;
5. create one synthetic post-ready Codex Desktop completion;
6. require exactly one Run and the expected single scoring effect;
7. require no duplicate, legacy, or historical token effects;
8. run `raiders off` and require a prompt `disabled` result.

Stop immediately if the game is not paused, the baseline changes before the synthetic event, status/off blocks, history uploads, or Apple trust fails.

- [ ] **Step 6: Reinstall locally and prove state preservation**

Turn the collector to a known preference, retain a known queued-state checksum, rerun the local installer, then require the same enrollment, preference, state, and outbox after restart. Confirm no update performed itself; `raiders update` only reports version information.

- [ ] **Step 7: Request one authorization for publication and public read-only tests**

Only after Steps 1-6 pass, run:

```bash
/bin/bash scripts/release/release-runtime-raiders-beta.sh publish
```

Expected: the three public resources return 200 with correct types; `/version` is `0.4.0`; `/health` remains healthy; old checksum and manifest paths return 404; collection remains off.

- [ ] **Step 8: Test the exact employee command on the disposable canary Mac**

```bash
curl -fsSL https://raiders.redlattice.com/install.sh | sh
```

Verify reinstall preservation, Apple trust, status, update output, and off state. Do not run office-wide `raiders on`; employees choose that separately.

- [ ] **Step 9: Record the release result without secrets**

Add a concise dated result section to `docs/runtime-raiders/employee-beta.md` containing version, Git SHA, signed/notarized verification outcome, public URL checks, flat-install outcome, 816-file acceptance outcome, and whether employee installation is GO or NO-GO.

Commit only that documentation result:

```bash
git add docs/runtime-raiders/employee-beta.md
git commit -m "docs(raiders): record employee beta verification"
```

At this point the beta is ready for employees if and only if the recorded result is GO.

---

### Task 8: Delete the obsolete release machinery after signed verification

**Gate:** Do not start this task until Task 7 is recorded GO and the archival tag resolves correctly.

**Files:**

- Delete obsolete core sources:
  - `companion/Sources/RuntimeRaidersCore/ArtifactDownloader.swift`
  - `companion/Sources/RuntimeRaidersCore/CandidateVerifier.swift`
  - `companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift`
  - `companion/Sources/RuntimeRaidersCore/InstallerMigrationValidation.swift`
  - `companion/Sources/RuntimeRaidersCore/LauncherSelection.swift`
  - `companion/Sources/RuntimeRaidersCore/LegacyMigrationControl.swift`
  - `companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift`
  - `companion/Sources/RuntimeRaidersCore/ReleaseArchiveVerifier.swift`
  - `companion/Sources/RuntimeRaidersCore/ReleaseFilesystem.swift`
  - `companion/Sources/RuntimeRaidersCore/ReleaseManifest.swift`
  - `companion/Sources/RuntimeRaidersCore/ReleaseState.swift`
  - `companion/Sources/RuntimeRaidersCore/SequenceEightCanaryCommandLink.swift`
  - `companion/Sources/RuntimeRaidersCore/SystemCommandRunner.swift`
  - `companion/Sources/RuntimeRaidersCore/VersionedReleaseTransaction.swift`
  - `companion/Sources/RuntimeRaidersCore/ZipArchiveValidator.swift`
- Delete obsolete executable directories:
  - `companion/Sources/RuntimeRaidersLauncher/`
  - `companion/Sources/RuntimeRaidersReleaseValidator/`
- Delete tests that exist only for those components and old sequence migration.
- Delete obsolete release scripts:
  - `scripts/release/run-runtime-raiders-gate2.sh`
  - `scripts/release/prepare-runtime-raiders-sequence8-private-record.sh`
  - superseded sequence/canary-only scripts under `scripts/test/`
  - `scripts/pi/runtime-raiders-artifacts.sh`
- Replace obsolete operational docs with pointers to Git history and `docs/runtime-raiders/employee-beta.md`.

- [ ] **Step 1: Prove each candidate file has no live reference**

For every file above, use `rg` on its public types, command names, and paths. If a type is still referenced by the collector, installer, release script, current tests, or current beta runbook, remove that dependency first; do not delete through a compile error and guess afterward.

- [ ] **Step 2: Delete updater/launcher/migration code and tests as one mechanical change**

Use `git rm` only on the verified obsolete files. Preserve `CompanionRelease.swift` if bundle-version or Apple trust parsing still uses it; otherwise reduce it in a separate test-backed edit rather than deleting it implicitly.

- [ ] **Step 3: Add a negative architecture test**

In `tests/runtime-raiders-beta-release.test.ts`, scan active source, package products, installer, Caddy, and current runbook and fail on these retired concepts:

```text
runtime-raiders-launcher
runtime-raiders-release-validator
prepare_update
resume_update
release-state.json
update-journal.json
runtime-raiders-agent.update.json
runtime-raiders-agent.zip.sha256
release_sequence
trialGeneration
CompanionUpdater
```

Exclude `docs/superpowers/specs/`, `docs/superpowers/plans/`, Git history, and ignored `dist/` evidence from this negative scan.

- [ ] **Step 4: Retire old active runbooks without destroying history**

Remove sequence/canary/update procedures from README and PI setup links. For historical documents still useful as evidence, add a top banner saying they describe the retired pre-0.4.0 system and link to the employee beta runbook. Delete only documents that are redundant generated checklists; Git and the archival tag preserve their content.

- [ ] **Step 5: Run every local verification again**

```bash
cd companion && swift package dump-package
cd companion && swift test
/bin/sh -n companion/packaging/install.sh
/bin/zsh -n companion/packaging/install.sh
/bin/bash -n scripts/release/release-runtime-raiders-beta.sh
/bin/bash -n scripts/pi/publish-runtime-raiders-beta.sh
npm test
npm run typecheck
rg -n "runtime-raiders-launcher|runtime-raiders-release-validator|prepare_update|resume_update|release-state.json|update-journal.json|runtime-raiders-agent.update.json|runtime-raiders-agent.zip.sha256|CompanionUpdater" companion scripts deploy README.md docs/PI_SETUP.md docs/runtime-raiders/employee-beta.md
```

Expected: tests pass; the final `rg` returns no active-system match.

- [ ] **Step 6: Commit the post-verification cleanup**

Stage only the verified deletions, adjusted tests, and active documentation. Keep `docs/BACKLOG.md` and ignored `dist/` evidence out of the commit.

```bash
git commit -m "refactor(raiders): retire versioned updater machinery"
```

---

## Final Acceptance Checklist

- [ ] The sequence-16 archival tag resolves to `b0eaa7be15f69c87a55ea3ad7a21e8c6b7e6d0d2`.
- [ ] Fresh employee install and later reinstall use the same one-line command.
- [ ] One signed Apple-notarized app is installed at one stable path.
- [ ] Fresh install starts off; reinstall preserves enrollment, state, outbox, and on/off preference.
- [ ] `raiders on` returns promptly as `preparing` with 816 history files.
- [ ] `raiders status` and `raiders off` stay prompt during preparation.
- [ ] Historical content produces no Run; one post-ready completion produces exactly one Run.
- [ ] `raiders update` only fetches `/version` and prints the reinstall command when newer.
- [ ] Daily checks are anonymous, once per 24 hours, and notify once per version.
- [ ] Public surface is exactly `install.sh`, one ZIP, and `/version`.
- [ ] One repeatable operator script prepares locally or publishes after one explicit authorization.
- [ ] Publication does not enable collection, unpause the game, change scoring, or deploy Node.
- [ ] Employee beta readiness is documented as GO or NO-GO with signed/runtime evidence.
- [ ] Obsolete updater/launcher/migration code is deleted only after the signed beta is GO.

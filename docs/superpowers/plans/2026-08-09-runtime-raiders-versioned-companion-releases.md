# Runtime Raiders Versioned Companion Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace protocol-1 fixed live/rollback application swaps with protocol-2 immutable versioned releases selected by a stable signed launcher, while preserving a one-line fresh install and safely migrating the installed-off sequence-8 canary.

**Architecture:** Add a strict owner-only release-state store and a signed launcher that resolves only sequence-and-SHA-derived release paths, validates the selected application, and replaces itself with the agent through `exec`. Routine updates stage a candidate in a unique release directory, run it as an uncommitted prepared trial under the existing lease, atomically commit the selector only after health succeeds, and retain old releases without making cleanup part of correctness. The signed installer owns the one-time flat-sequence-8-to-versioned migration and can restore the exact old launch arrangement at every injected failure boundary.

**Tech Stack:** Swift 6, Foundation, Darwin, Security.framework, Swift Package Manager, XCTest, POSIX shell, Bash, Node.js 20, TypeScript, Vitest, macOS launchd, Developer ID signing, Apple notarization.

## Global Constraints

- The approved specification at `docs/superpowers/specs/2026-08-09-runtime-raiders-versioned-companion-releases-design.md` is authoritative. Stop and amend the specification before implementing a contradictory behavior.
- Work only in the isolated `codex/versioned-companion-releases` worktree. Preserve the dirty `codex/fail-fast-update-lifecycle` worktree and do not merge or copy its residue-classifier implementation.
- Use red-green TDD for each behavioral change. A new test must fail for the intended reason before production code is changed.
- Do not change `companion/RELEASE` until Task 7, and then change it only to the separately selected migration-release version, sequence, SHA-bearing build input, and update protocol 2.
- Local implementation and temporary-fixture tests may proceed without release ceremony. Real signing/notarization, publication, installed-canary migration, a real protocol-2 update, `raiders on`, collection, and office activation remain separate authorization boundaries.
- Gate 1 must perform no real network request, launchd mutation, installed-companion mutation, provider-record read, signing, notarization, publication, Pi access, collection, or activation.
- The launcher performs no network request, update check, state write, cleanup, collection, upload, notification, forked helper, or persistent background work. A successful invocation ends in `exec` of one validated agent.
- No remotely supplied value or on-disk JSON field may provide a local executable path. Release paths are reconstructed only from validated sequence and lowercase Git SHA fields.
- `installation/release-state.json` is the only durable selector authority. `update-journal.json`, workspaces, legacy flat bundles, old versioned releases, and diagnostics must never be consulted to choose executable code or block a later higher-sequence release.
- Active, fallback, trial, and generation transitions must use a single owner-only atomic record replacement. A visible record is always the complete old generation or complete next generation.
- Existing enrollment, collection intent, provider cursors, adapter snapshots, aggregate state, active-Run registry, update notification state, and outbox bytes remain outside release directories and are exact through prepared health verification.
- Trial startup cannot collect, upload, notify, persist a state migration, or accept provider work. It may persist only after it is committed active and explicitly resumed, or after lease abandonment proves it is now committed active.
- Keep the flat sequence-8 application and every legacy rollback, failed, diagnostic, and workspace entry unchanged after successful migration. Deletion is outside this plan.
- Never claim protection against a malicious concurrent process running as the same macOS user. Continue to reject symlinks, unsafe ownership/modes, hard links where forbidden, signature or Team ID mismatch, identity mismatch, and substitution observed at validation boundaries.

---

## File and responsibility map

| File | Responsibility after this plan |
| --- | --- |
| `companion/Sources/RuntimeRaidersCore/AgentPaths.swift` | Stable launcher, versioned-release, installation, state, lock, and preserved legacy-flat paths |
| `companion/Sources/RuntimeRaidersCore/CompanionRelease.swift` | Exact protocol-1/2 release identity parsing and path-safe identity validation |
| `companion/Sources/RuntimeRaidersCore/ReleaseState.swift` | Strict release-state schema, invariants, bounded no-follow reads, and generation-CAS atomic replacement |
| `companion/Sources/RuntimeRaidersCore/ReleaseFilesystem.swift` | Owner-only directory validation, release path reconstruction, immutable tree sealing, and safe promotion helpers |
| `companion/Sources/RuntimeRaidersCore/LauncherSelection.swift` | Pure invocation parsing, active/trial selection, selected-bundle validation boundaries, and execution request construction |
| `companion/Sources/RuntimeRaidersLauncher/main.swift` | Live Security.framework validation and `exec` adapter only |
| `companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift` | Prepared lease observation plus active-resume/trial-exit abandonment decisions |
| `companion/Sources/RuntimeRaidersCore/ControlSocket.swift` | Generation-bound prepare/resume protocol and stable-job kickstart; protocol-1 stable-recovery code removed |
| `companion/Sources/RuntimeRaidersCore/AgentController.swift` | Status reports the exact prepared generation without weakening persisted-state rules |
| `companion/Sources/RuntimeRaidersCore/ReleaseArchiveVerifier.swift` | Verify both signed bundles, agent identity, Team ID, notarization facts, and launcher protocol |
| `companion/Sources/RuntimeRaidersCore/ZipArchiveValidator.swift` | Accept only the exact `Runtime Raiders Release/` two-application archive tree |
| `companion/Sources/RuntimeRaidersCore/VersionedReleaseTransaction.swift` | Unique candidate promotion, trial/commit/revert state transitions, journaling, and noncritical cleanup |
| `companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift` | Ordered protocol-2 lifecycle orchestration with active unchanged through trial health |
| `companion/Sources/RuntimeRaidersCLI/main.swift` | Versioned runtime validation, private trial startup, active CLI routing, updater wiring, and lease abandonment behavior |
| `companion/packaging/install.sh` | Fresh protocol-2 installation and transactional flat sequence-8 migration |
| `companion/packaging/com.redlattice.runtime-raiders-agent.plist.template` | Stable launcher program path and literal `daemon` argument |
| `scripts/release/build-runtime-raiders-agent.sh` | Build, sign, notarize, staple, validate, and stage the two-app quartet |
| `scripts/test/runtime-raiders-lifecycle.sh` | One external-effect-free Gate 1 command |
| `scripts/test/verify-runtime-raiders-signed-release.sh` | Gate 2 temporary-home validation of an unpublished real signed quartet |
| `tests/companion-installer.test.ts` | Fresh install, sequence-8 migration, rollback injection, enrollment reuse, and packaging integration |

---

### Task 1: Add exact protocol-2 paths and release-state authority

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/AgentPaths.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/CompanionRelease.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ReleaseManifest.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ReleaseChecker.swift`
- Create: `companion/Sources/RuntimeRaidersCore/ReleaseState.swift`
- Create: `companion/Sources/RuntimeRaidersCore/ReleaseFilesystem.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ReleaseStateTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ReleaseManifestTests.swift`

**Interfaces:**
- Produce `ReleaseReference`, `ReleaseStateV1`, `ReleaseStateStore.load()`, `ReleaseStateStore.createInitial(_:)`, `ReleaseStateStore.replace(expectedGeneration:with:)`, and `AgentPaths.releaseDirectory(for:)`.
- Keep `CompanionReleaseIdentity` as the signed-bundle identity. Convert to and from `ReleaseReference` only after exact field validation.
- Allow the new binary to decode a cached protocol-1 manifest without rewriting it, but require matching protocol 2 before advertising or installing an update. The already-published sequence-8 binary remains unchanged and therefore rejects a protocol-2 public manifest.

- [ ] **Step 1: Write strict schema and path tests**

Add tests that construct JSON manually and require exactly this public model:

```swift
public struct ReleaseReference: Codable, Equatable, Sendable {
    public let releaseSequence: Int64
    public let releaseSHA: String
    public let companionVersion: String
    public let updateProtocolVersion: Int
}

public struct ReleaseStateV1: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let generation: Int64
    public let active: ReleaseReference
    public let fallback: ReleaseReference?
    public let trial: ReleaseReference?
}
```

The tests must cover exact snake-case keys, no unknown keys, maximum 16 KiB, generation in `1...9_007_199_254_740_991`, protocol 2 references only, fallback older than active, trial newer than active, no duplicate identity, no arbitrary path field, and exact release directory names. Add filesystem cases for missing, symlinked, unowned where injectable, wrong-mode, multi-link, oversized, partial, and concurrently replaced records.

- [ ] **Step 2: Run the new tests and verify RED**

```bash
swift test --disable-sandbox --package-path companion --filter ReleaseStateTests
```

Expected: compilation fails because the release-state types and paths do not exist.

- [ ] **Step 3: Expand `AgentPaths` without retaining protocol-1 slot authority**

Replace `installedApplication`, `rollbackApplication`, and `failedApplication` with these named surfaces:

```swift
public let legacyFlatApplication: URL
public let launcherDirectory: URL
public let launcherApplication: URL
public let launcherExecutable: URL
public let releasesDirectory: URL
public let installationDirectory: URL
public let releaseState: URL
public let updateJournal: URL

public func releaseDirectory(for release: ReleaseReference) throws -> URL
public func application(for release: ReleaseReference) throws -> URL
public func executable(for release: ReleaseReference) throws -> URL
```

`releaseDirectory(for:)` must validate the fields and build `sequence-<sequence>-<sha>` itself. It must never accept a relative or absolute path string.

- [ ] **Step 4: Implement strict load and generation-CAS replacement**

`ReleaseStateStore.load()` must use bounded descriptor-relative `openat(..., O_NOFOLLOW)`, validate owner/mode/link count, decode exact keys, and fail closed without repairing the file. `replace(expectedGeneration:with:)` must:

1. reopen and validate the current record;
2. require its generation equals `expectedGeneration`;
3. require the proposed generation equals `expectedGeneration + 1` without overflow;
4. encode sorted exact JSON no larger than 16 KiB;
5. write and `fsync` an owner-only temporary regular file in the pinned installation directory;
6. `renameat` over the record; and
7. `fsync` the installation directory.

Use a test-only injected write/rename hook to prove every interrupted write leaves either the complete old or complete new state.

`createInitial(_:)` is installer-only. It requires generation 1, active protocol 2, fallback/trial null, and an absent destination created with no-follow exclusive semantics. It must never replace an existing record.

- [ ] **Step 5: Make release metadata transition-readable but protocol-gated**

Change identity and manifest structural parsing to accept only update protocol 1 or 2, while `ReleaseManifestV1.availability(from:)` continues to require equality with the installed identity. Add an explicit protocol-2 guard in candidate/update code later; do not let a protocol-1 active release consume protocol 2.

Change `UpdateStateStore` validation so a structurally valid cached protocol-1 manifest remains readable and ignored by a protocol-2 installed identity. Do not rewrite update-state merely because its cached manifest is from protocol 1.

- [ ] **Step 6: Run focused and neighboring tests GREEN**

```bash
swift test --disable-sandbox --package-path companion --filter 'ReleaseStateTests|CompanionReleaseTests|ReleaseManifestTests|ReleaseCheckerTests'
```

Expected: all selected tests pass, including atomic generation replacement and cached protocol-1 preservation.

- [ ] **Step 7: Commit the contract layer**

```bash
git add companion/Sources/RuntimeRaidersCore/AgentPaths.swift companion/Sources/RuntimeRaidersCore/CompanionRelease.swift companion/Sources/RuntimeRaidersCore/ReleaseManifest.swift companion/Sources/RuntimeRaidersCore/ReleaseChecker.swift companion/Sources/RuntimeRaidersCore/ReleaseState.swift companion/Sources/RuntimeRaidersCore/ReleaseFilesystem.swift companion/Tests/RuntimeRaidersCoreTests/ReleaseStateTests.swift companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift companion/Tests/RuntimeRaidersCoreTests/ReleaseManifestTests.swift
git commit -m "feat: add versioned release state authority"
```

---

### Task 2: Build the stable signed launcher and exact command routing

**Files:**
- Modify: `companion/Package.swift`
- Create: `companion/Sources/RuntimeRaidersCore/LauncherSelection.swift`
- Create: `companion/Sources/RuntimeRaidersLauncher/main.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/LauncherSelectionTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`

**Interfaces:**
- Add executable product `runtime-raiders-launcher` backed by target `RuntimeRaidersLauncher` and `RuntimeRaidersCore`.
- Produce `LauncherInvocation`, `LauncherSelection`, `LauncherSelectionOperations`, and `LauncherSelector.select(invocation:)`.
- Change agent routing to `CompanionCommandRoute.daemon(trialGeneration: Int64?)`; ordinary active daemon has `nil`, while a trial receives the exact validated generation.

- [ ] **Step 1: Add launcher selection tests first**

Cover exact zero/one-argument behavior and use injected record, lease, signature, and `exec` facts. Required cases:

- active selection for `on`, `off`, `status`, `doctor`, `update`, and `uninstall`;
- active selection for `daemon` with no trial or no held lease;
- trial selection for `daemon` only when the record has a trial and the lease is held;
- trial execution arguments exactly `["daemon", "__runtime-raiders-trial-generation", "<generation>"]`;
- active daemon arguments exactly `["daemon"]`;
- rejection of self-check, recovery, installer-private commands, extra arguments, malformed generation, record substitution, bundle substitution, signature/Team/protocol/identity mismatch, and a selected path outside the derived release root;
- the execution adapter receives the already validated executable plus literal arguments and environment, with no shell string.

- [ ] **Step 2: Run launcher tests RED**

```bash
swift test --disable-sandbox --package-path companion --filter LauncherSelectionTests
```

Expected: compilation fails because the launcher target and selection types are absent.

- [ ] **Step 3: Implement a pure selector and minimal live executable**

The pure layer should return this value and perform no execution itself:

```swift
public struct LauncherSelection: Equatable, Sendable {
    public let release: ReleaseReference
    public let executable: URL
    public let arguments: [String]
    public let releaseStateGeneration: Int64
}
```

The live target must only:

1. parse `CommandLine.arguments` into an allowed `LauncherInvocation`;
2. validate the launcher bundle identifier `com.redlattice.runtime-raiders-launcher`, launcher protocol 1, hardened runtime, and its own Team ID;
3. call the selector with real no-follow filesystem and Security.framework operations;
4. rebuild `argv` from the fixed selected executable and literal arguments; and
5. call `Darwin.execv`.

No Foundation `Process`, shell, network API, timer, state writer, cleanup routine, or background queue belongs in this target.

- [ ] **Step 4: Replace path-bound protocol-1 routing rules**

Update `CompanionCommandRouter.route` to accept:

```swift
case ["daemon"]:
    return exactVersionedActiveExecutable(...) ? .daemon(trialGeneration: nil) : nil
case ["daemon", "__runtime-raiders-trial-generation", let rawGeneration]:
    return validatedTrialExecutableAndGeneration(...) ? .daemon(trialGeneration: generation) : nil
```

Keep `__self-check` direct-agent-only. Remove `__recover-update`; the stable selector makes the fixed rollback recovery route obsolete. The launcher parser must never forward any private route.

- [ ] **Step 5: Run selection and route tests GREEN**

```bash
swift test --disable-sandbox --package-path companion --filter 'LauncherSelectionTests|ControlProtocolTests/testCommandRouting|ControlProtocolTests/testDaemonAndInternalCommands'
```

Expected: the launcher selection matrix and exact agent path rules pass.

- [ ] **Step 6: Add a process-level no-write/no-network smoke test**

Build the launcher in debug mode, point it at a temporary support tree through a test-only dependency seam, replace `exec` with a recorder, and assert the tree fingerprint is unchanged and no network/notification operation exists in the operation surface.

- [ ] **Step 7: Commit the launcher slice**

```bash
git add companion/Package.swift companion/Sources/RuntimeRaidersCore/LauncherSelection.swift companion/Sources/RuntimeRaidersLauncher/main.swift companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Tests/RuntimeRaidersCoreTests/LauncherSelectionTests.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift
git commit -m "feat: add stable versioned release launcher"
```

---

### Task 3: Make prepared startup generation-bound and crash deterministic

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentController.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift`

**Interfaces:**
- Add `releaseStateGeneration: Int64?` to `ControlRequest`, present only for `prepare_update` and `resume_update`.
- Add `preparedReleaseStateGeneration: Int64?` to `AgentStatus`; it is non-null exactly while prepared.
- Produce `PreparedReleaseDisposition` with `.resumeCommittedActive`, `.exitUncommittedTrial`, and `.failClosed`.
- Keep `CompanionPreparedStartupLease` as the exclusive lock owner and `CompanionPreparedStartupObservation` as the non-owning abandonment observer.

- [ ] **Step 1: Add generation and abandonment tests**

Extend `ControlProtocolTests` to prove:

- prepare/resume frames require one positive safe generation and reject it for every other command;
- prepare validates current state generation, active self identity, non-null newer trial, and held lease before pausing;
- a trial startup requires its private generation, exact trial identity/path, and held lease;
- an active daemon prepared at generation G resumes when the lease closes and it is still active;
- an uncommitted trial at generation G exits when the lease closes and it remains trial;
- a committed former trial resumes when the lease closes and it is active with trial cleared;
- malformed or contradictory state keeps collection paused and fails closed;
- resume is idempotent only for the exact committed generation and clears prepared state after deferred startup succeeds.

- [ ] **Step 2: Run the new prepared tests RED**

```bash
swift test --disable-sandbox --package-path companion --filter ControlProtocolTests
```

Expected: failures show missing generation fields and missing release-aware abandonment behavior.

- [ ] **Step 3: Replace the boolean-only preparation coordinator**

Change `SerializedUpdatePreparation` to store an optional prepared generation and to accept typed closures:

```swift
public func prepare(generation: Int64) -> ControlResponse
public func resume(generation: Int64) -> ControlResponse
public var preparedGeneration: Int64? { get }
```

Preparation must validate before any pause callback. After pausing, start one lease-abandonment observer. When the lease closes, reload release state and compare the current process identity:

```swift
public enum PreparedReleaseDisposition {
    case resumeCommittedActive
    case exitUncommittedTrial
    case failClosed
}
```

Resume calls deferred provider installation exactly once; exit requests the daemon run loop to stop without collection; fail-closed leaves all work paused and stops rather than looping under launchd with an unsafe selector.

- [ ] **Step 4: Reorder daemon initialization to preserve protected bytes**

Resolve startup mode and construct the prepared coordinator before enabling any release check. Do not call `ReleaseChecker.availability()`, mutate notification state, persist a supported collector migration, watch providers, upload, heartbeat, or notify during prepared startup. Create or consult the release checker only inside the deferred committed-active start path after resume.

- [ ] **Step 5: Wire exact status and control validation**

Return the prepared generation in `AgentStatus`. `LiveUpdateStatusProvider` must compare it with the updater's expected generation, in addition to identity, enrollment, state, Run count, and outbox count.

- [ ] **Step 6: Run prepared and persistence suites GREEN**

```bash
swift test --disable-sandbox --package-path companion --filter 'ControlProtocolTests|AgentControllerTests'
```

Expected: all prepared-startup, state-migration, socket framing, and abandonment tests pass with protected bytes unchanged until resume.

- [ ] **Step 7: Commit the prepared-runtime slice**

```bash
git add companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift
git commit -m "feat: bind prepared startup to release generations"
```

---

### Task 4: Validate the exact two-application release archive

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/ZipArchiveValidator.swift`
- Create: `companion/Sources/RuntimeRaidersCore/ReleaseArchiveVerifier.swift`
- Refactor: `companion/Sources/RuntimeRaidersCore/CandidateVerifier.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ZipArchiveValidatorTests.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ReleaseArchiveVerifierTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/CandidateVerifierTests.swift`

**Interfaces:**
- Replace the single-app archive result with `VerifiedReleaseArchive(agent:launcher:)`.
- Agent verification requires bundle ID `com.redlattice.runtime-raiders-agent`, protocol 2, exact manifest identity, higher sequence than installed, hardened runtime, secure timestamp, notarization, all architectures, and installed Team ID.
- Launcher verification requires bundle ID `com.redlattice.runtime-raiders-launcher`, launcher protocol 1, hardened runtime, secure timestamp, notarization, all architectures, and the same Team ID.

- [ ] **Step 1: Rewrite archive-shape tests first**

The accepted ZIP must contain only:

```text
Runtime Raiders Release/
Runtime Raiders Release/Runtime Raiders Agent.app/
Runtime Raiders Release/Runtime Raiders Launcher.app/
```

with regular-file descendants. Add rejection cases for either missing app, any third root/child, case-fold collision, link, special file, writable mode, duplicate path, unsafe path, Zip64, unsupported compression/flags, archive size limits, and extracted-tree substitution.

- [ ] **Step 2: Add injected two-bundle trust tests**

Use synthetic `CandidateSignatureFacts` and identity loaders. Prove every individual identity, Team, hardened-runtime, timestamp, notarization, architecture, manifest, agent protocol, and launcher protocol mismatch fails before promotion.

- [ ] **Step 3: Run the archive tests RED**

```bash
swift test --disable-sandbox --package-path companion --filter 'ZipArchiveValidatorTests|ReleaseArchiveVerifierTests|CandidateVerifierTests'
```

Expected: existing one-app expectations fail and the new verifier is missing.

- [ ] **Step 4: Implement exact archive and trust validation**

Keep ZIP parsing bounded and no-follow. Refactor Security.framework inspection into one reusable signed-bundle inspector; do not weaken the existing Developer ID, designated requirement, architecture, nested-code, symlink, timestamp, Gatekeeper/notarization, or Team ID checks.

The routine updater may validate but must not replace the packaged launcher. A launcher-protocol change is installer-only.

- [ ] **Step 5: Run archive tests GREEN**

Run the Step 3 command again. Expected: all selected tests pass.

- [ ] **Step 6: Commit the release-verification slice**

```bash
git add companion/Sources/RuntimeRaidersCore/ZipArchiveValidator.swift companion/Sources/RuntimeRaidersCore/ReleaseArchiveVerifier.swift companion/Sources/RuntimeRaidersCore/CandidateVerifier.swift companion/Tests/RuntimeRaidersCoreTests/ZipArchiveValidatorTests.swift companion/Tests/RuntimeRaidersCoreTests/ReleaseArchiveVerifierTests.swift companion/Tests/RuntimeRaidersCoreTests/CandidateVerifierTests.swift
git commit -m "feat: verify protocol two release archives"
```

---

### Task 5: Replace fixed-slot swapping with the versioned trial transaction

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/VersionedReleaseTransaction.swift`
- Rewrite: `companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Rewrite: `companion/Tests/RuntimeRaidersCoreTests/CompanionUpdaterTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`

**Interfaces:**
- `CompanionUpdaterOperations` uses `kickstart` only; remove routine `bootout`, `bootstrap`, stopped proof, recovery-command emission, and fixed-bundle restart operations.
- `VersionedReleaseTransaction` owns candidate promotion, state generations, protected snapshots, optional diagnostic journal writes, and best-effort workspace cleanup.
- Delete `StableUpdateRecovery`, `StableRecoveryFileTransaction`, `__recover-update`, and every fixed rollback/failed application dependency from protocol-2 code.

- [ ] **Step 1: Replace the updater harness with the approved lifecycle matrix**

Build the test harness around three synthetic releases N, N+1, and N+2 plus injected operations. Required success assertions:

1. N remains active while N+1 is downloaded, promoted, recorded as trial, launched, and health-checked.
2. Successful commit produces active N+1, fallback N, trial null, with monotonically incremented generations.
3. A second update produces active N+2, fallback N+1, trial null while N and every workspace/journal residue remain untouched.
4. Forced cleanup, journal, and old-release deletion failures do not change success and do not block N+2.

Add failure injection before and after download, extract, archive validation, bundle verification, promotion, trial record, lease, prepare, kickstart, trial start, health, commit, resume, revert, and prior-active health. Simulate updater process exit at every durable boundary by discarding the harness coordinator and invoking launcher/daemon recovery from the remaining filesystem state.

- [ ] **Step 2: Run updater tests RED**

```bash
swift test --disable-sandbox --package-path companion --filter CompanionUpdaterTests
```

Expected: failures show the old fixed `installed/rollback/failed` swap behavior.

- [ ] **Step 3: Implement unique promotion and state transitions**

`VersionedReleaseTransaction` must expose operations equivalent to:

```swift
func promoteVerifiedCandidate(_ verified: VerifiedReleaseArchive) throws -> ReleaseReference
func recordTrial(_ candidate: ReleaseReference) throws -> ReleaseStateV1
func commitTrial(expectedGeneration: Int64) throws -> ReleaseStateV1
func clearTrial(expectedGeneration: Int64) throws -> ReleaseStateV1
func restorePriorSelection(expectedGeneration: Int64) throws -> ReleaseStateV1
func cleanupBestEffort()
```

Promotion creates the final unique release directory, moves only the verified agent application into it, synchronizes the tree and parent, and refuses an existing target. The packaged launcher remains staging input only. Journal writes are bounded and best-effort; journal reads never drive a transition.

- [ ] **Step 4: Implement the exact update order**

The updater must perform:

```text
lock -> validate active/daemon/state/zero Runs -> fetch protocol 2
-> download/validate/extract/self-check -> promote unique candidate
-> state trial generation -> acquire prepared lease
-> prepare active for that generation -> kickstart -k stable job
-> verify prepared trial health -> state commit generation
-> resume committed generation -> release lease/lock -> best-effort cleanup
```

If candidate health fails, atomically clear trial, kickstart committed active while the lease is held, verify its prepared health, resume prior intent, then report rollback. If resume fails after commit while the updater is alive, atomically restore the exact pre-trial active/fallback relation at the next generation, kickstart/verify/resume it, and report rollback.

- [ ] **Step 5: Implement crash reconciliation without cleanup dependence**

At updater start, if a valid state contains trial but no lease is held, require the committed active daemon to be healthy, clear trial at the next generation, and leave the unselected candidate directory untouched. A later higher-sequence manifest must proceed even when that release, arbitrary old releases, workspaces, or a malformed journal remain.

- [ ] **Step 6: Wire stable launchd kickstart and versioned trust root**

`LaunchdJobController.restart()` remains the sole routine launchd mutation and must issue exactly:

```text
/bin/launchctl kickstart -k gui/<uid>/com.redlattice.runtime-raiders-agent
```

`runForegroundUpdate` must load active identity/path from release state, validate `Bundle.main` is that exact active bundle, validate the stable launcher, and bind all status comparisons to the expected state generation.

- [ ] **Step 7: Run updater and control suites GREEN**

```bash
swift test --disable-sandbox --package-path companion --filter 'CompanionUpdaterTests|ControlProtocolTests'
```

Expected: two-hop, all cleanup failures, every crash boundary, rollback, active-Run refusal, state preservation, and kickstart-only tests pass.

- [ ] **Step 8: Prove fixed slots are no longer correctness dependencies**

```bash
rg -n 'rollbackApplication|failedApplication|StableUpdateRecovery|__recover-update|Runtime Raiders Agent\.rollback|Runtime Raiders Agent\.failed' companion/Sources companion/Tests
```

Expected: no protocol-2 source or test references. Legacy names may remain only in installer migration fixture data or historical documentation.

- [ ] **Step 9: Commit the updater replacement**

```bash
git add companion/Sources/RuntimeRaidersCore/VersionedReleaseTransaction.swift companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/CompanionUpdaterTests.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift
git commit -m "feat: activate updates through versioned trials"
```

---

### Task 6: Build and validate the two signed application bundles

**Files:**
- Modify: `scripts/release/build-runtime-raiders-agent.sh`
- Modify: `companion/packaging/com.redlattice.runtime-raiders-agent.plist.template`
- Modify: `companion/Sources/RuntimeRaidersReleaseValidator/main.swift`
- Modify: `tests/companion-installer.test.ts`

**Interfaces:**
- The release archive has exact top-level `Runtime Raiders Release/` containing the two app bundles.
- The public quartet filenames and URLs remain unchanged.
- The release manifest stays schema version 1 and declares update protocol 2.

- [ ] **Step 1: Change release-builder tests before the script**

Update fake build/sign/notary fixtures to require universal agent and launcher products, exact Info.plists, two signing calls, validation of both extracted apps, notarization and staple validation for both apps, exact archive roots, and atomic all-or-nothing replacement of the four public files.

Assert launcher metadata includes:

```xml
<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-launcher</string>
<key>CFBundleExecutable</key><string>runtime-raiders-launcher</string>
<key>RuntimeRaidersLauncherProtocolVersion</key><integer>1</integer>
```

Assert agent metadata declares `RuntimeRaidersUpdateProtocolVersion` 2 and the manifest contains `"update_protocol_version":2`.

- [ ] **Step 2: Run focused builder tests RED**

```bash
npx vitest run tests/companion-installer.test.ts -t 'release|archive|sign|notar|quartet'
```

Expected: failures show only the agent product is currently built and the archive has the old one-app root.

- [ ] **Step 3: Build both universal products and app bundles**

For both arm64 and x86_64, build `raiders` and `runtime-raiders-launcher`, combine each with `lipo`, render both exact Info.plists, and place them beneath one `Runtime Raiders Release` staging directory. Validate the launcher protocol independently from the agent release identity.

- [ ] **Step 4: Sign, notarize, staple, extract, and independently revalidate**

Sign each app with hardened runtime and timestamp. Submit notarization inputs that cover both applications, staple and validate each application, then create the public ZIP from the release container. Extract it into a fresh directory, run Security.framework/codesign validation on both apps, and run `runtime-raiders-release-validator` on the ZIP before computing the checksum or rendering the manifest/installer.

- [ ] **Step 5: Point launchd template at the stable launcher**

The plist `ProgramArguments` must render the installed launcher executable followed by literal `daemon`. It must contain no active-release path.

- [ ] **Step 6: Run builder tests GREEN**

```bash
npx vitest run tests/companion-installer.test.ts -t 'release|archive|sign|notar|quartet'
bash -n scripts/release/build-runtime-raiders-agent.sh
```

Expected: all selected builder and quartet rollback tests pass.

- [ ] **Step 7: Commit packaging construction**

```bash
git add scripts/release/build-runtime-raiders-agent.sh companion/packaging/com.redlattice.runtime-raiders-agent.plist.template companion/Sources/RuntimeRaidersReleaseValidator/main.swift tests/companion-installer.test.ts
git commit -m "build: package signed launcher with agent releases"
```

---

### Task 7: Implement fresh installation and exact sequence-8 migration rollback

**Files:**
- Rewrite: `companion/packaging/install.sh`
- Create: `companion/Sources/RuntimeRaidersCore/LegacyMigrationControl.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`
- Rewrite migration portions: `tests/companion-installer.test.ts`
- Modify: `companion/RELEASE`

**Interfaces:**
- Fresh installs create protocol-2 generation 1 with the new release active, fallback/trial null, and collection off.
- Migration accepts only a fully validated flat protocol-1 sequence-8 installation, reuses its enrollment, preserves its intent, and leaves its application in place.
- Add direct-agent-only private installer lease, legacy-prepare, and committed-resume coordination. They must never be forwarded by the stable launcher and must accept no arbitrary filesystem path.

- [ ] **Step 1: Add fresh and migration fixtures before rewriting the installer**

Required success cases:

- fresh one-line piped install creates launcher, one versioned agent, generation-1 state, stable plist/shim, new enrollment, and verified-off daemon;
- existing valid enrollment is detected before any TTY/code read and no enrollment endpoint is called;
- flat sequence 8 migrates with its app bytes/inode and all legacy rollback/failed/diagnostic/workspace entries unchanged;
- migration active is the candidate, fallback/trial are null, launcher/plist/shim are stable, and protected-state fingerprints match;
- both prior disabled and prior enabled intent are restored only after prepared health acceptance;
- reinstall against an existing protocol-2 layout fails with a clear `raiders update` instruction rather than rewriting it.

- [ ] **Step 2: Add failure injection at every replacement boundary**

Inject failure after archive verification, enrollment decision, prepare, old job stop, each directory creation, launcher placement, release placement, state write, plist replacement, shim replacement, command-link replacement, bootstrap, prepared health, and resume. Every case must restore the exact old plist/shim/link/daemon arrangement, leave flat sequence 8 runnable at its original path, preserve existing enrollment and state bytes, and permit a clean retry. A newly issued enrollment retains the existing safe-retry behavior.

- [ ] **Step 3: Run installer migration tests RED**

```bash
npx vitest run tests/companion-installer.test.ts -t 'fresh protocol two|sequence eight migration|migration rollback|existing enrollment'
```

Expected: failures show the current installer always prompts first and replaces the flat app.

- [ ] **Step 4: Reorder enrollment and archive handling**

Preflight all owned paths, then validate an existing enrollment before reading `/dev/tty`. Prompt for a one-time code only when enrollment is absent. Extract the exact release container and independently validate both signed apps and embedded protocols before quiescing any daemon.

- [ ] **Step 5: Add bounded direct-agent migration helpers**

Add three exact direct-agent-only routes:

```text
__runtime-raiders-installer-lease
__runtime-raiders-legacy-prepare
__runtime-raiders-installer-resume <generation>
```

The lease command acquires `CompanionPreparedStartupLease`, writes one fixed readiness line, and holds the lease until stdin closes. The POSIX installer owns a private FIFO and file descriptor inside its transaction directory, records the helper PID, verifies readiness, and closes/reaps it on every trap path.

The legacy-prepare command uses `LegacyMigrationControl` to send the exact bounded protocol-1 frame `{"command":"prepare_update"}\n` to the fixed owner-only control socket and decode only `ControlResponse`; it exists because the sequence-8 CLI has no user-routable prepare command. The installer-resume command sends the new generation-bound resume frame only after verifying its own exact active versioned path and release-state generation.

All three routes require direct execution of the independently verified candidate agent, accept no caller path, network value, token, or content, and are rejected by the launcher. Add route, frame, timeout, malformed-response, and wrong-path tests before production code.

This helper is temporary only during installation; it is not a daemon, timer, updater, or persistent second process.

- [ ] **Step 6: Implement the fresh/migration transaction**

For migration:

1. validate exact flat sequence 8, current plist/shim/enrollment/status/zero Runs;
2. preserve collection intent without rewriting it;
3. start the prepared lease keeper, use the candidate's legacy-prepare client, and prove the flat daemon reports prepared with zero Runs;
4. stop the old launchd job and prove it absent;
5. create owner-only launcher/releases/installation directories;
6. install the launcher and candidate release without moving the flat app;
7. atomically write generation 1 active candidate, fallback/trial null;
8. atomically replace plist and shim with stable-launcher forms;
9. bootstrap the stable job and verify prepared candidate identity/state/zero Runs;
10. send a generation-bound direct-agent resume, verify restored intent and health;
11. close/reap the lease keeper and commit the installer transaction.

For fresh install, use the same protocol-2 placement and prepared verification path with initial intent off and no flat rollback surface.

- [ ] **Step 7: Implement exact rollback ordering**

On failure, keep collection paused, stop any new job, restore the old plist/shim/link surfaces by rename, remove only transaction-created protocol-2 paths after verifying their exact transaction seals, bootstrap the unchanged flat application, verify its prior intent/health, and then release the lease. Never remove or rename legacy evidence.

- [ ] **Step 8: Move the source release contract to the migration release**

After all installer tests are green, update `companion/RELEASE` to `companion_version=0.3.0`, `release_sequence=9`, and `update_protocol_version=2`. Keep `version=1`. Do not add a Git SHA to this file; the release builder continues to receive and verify the exact clean `--release-sha` at build time.

- [ ] **Step 9: Run the complete installer suite GREEN**

```bash
sh -n companion/packaging/install.sh
npx vitest run tests/companion-installer.test.ts
```

Expected: fresh, one-line pipe, enrollment privacy, migration, rollback, retry, uninstall, build, signing-fixture, archive, and quartet tests all pass.

- [ ] **Step 10: Commit installer migration**

```bash
git add companion/packaging/install.sh companion/Sources/RuntimeRaidersCore/LegacyMigrationControl.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift tests/companion-installer.test.ts companion/RELEASE
git commit -m "feat: migrate flat installs to versioned releases"
```

---

### Task 8: Make Gate 1 one command and add unpublished signed-release Gate 2

**Files:**
- Create: `scripts/test/runtime-raiders-lifecycle.sh`
- Create: `scripts/test/verify-runtime-raiders-signed-release.sh`
- Modify: `package.json`
- Modify: `tests/companion-installer.test.ts`
- Create: `docs/runtime-raiders-companion-release-gates.md`

**Interfaces:**
- Produce `npm run canary:lifecycle-test` with no external effects.
- Produce a Gate 2 script that consumes a local unpublished quartet and operates only in a temporary home with fake network and launchd boundaries while using real signatures and binaries.

- [ ] **Step 1: Add a guard test for the Gate 1 command**

Add a Vitest assertion that reads the script and package entry, rejects real `curl`/`ssh`/Caddy/Pi/publication/`raiders on` calls, and requires temporary directories plus fake launchd/network environment. Run `npm run canary:lifecycle-test` before adding it and confirm the missing-script failure.

- [ ] **Step 2: Implement the one-command local lifecycle gate**

The script must run, in order:

```bash
sh -n companion/packaging/install.sh
bash -n scripts/release/build-runtime-raiders-agent.sh
swift test --disable-sandbox --package-path companion
npx vitest run tests/companion-installer.test.ts
```

It must set a trap for only its own verified temporary directory, avoid the installed support directory, and fail on the first failing suite. Add:

```json
"canary:lifecycle-test": "bash scripts/test/runtime-raiders-lifecycle.sh"
```

- [ ] **Step 3: Run Gate 1 twice**

```bash
npm run canary:lifecycle-test
npm run canary:lifecycle-test
```

Expected: both runs pass from a clean source tree, proving no previous workspace, journal, or release residue is required.

- [ ] **Step 4: Implement the unpublished signed-release harness**

`verify-runtime-raiders-signed-release.sh <quartet-directory>` must:

- validate the quartet filenames, checksum, manifest, and exact archive tree;
- use real `codesign`, Security.framework validator, `spctl`, and `stapler` checks for both extracted apps;
- create an owner-only temporary HOME and installed-style support tree;
- create temporary older/current/newer protocol-2 fixture bundles from the real universal agent executable, render distinct test identities, and sign them with the separately authorized Developer ID solely inside the temporary home;
- exercise the real launcher as a process against active, fallback, held-lease trial, missing, malformed, unsafe-mode, symlinked, and identity-mismatched state fixtures; observe active selection through `status` and held-lease trial selection through a bounded prepared daemon start, with no launcher test bypass or injected production backdoor;
- run the rendered real installer against the real archive with only network and launchd replaced by local fakes;
- inject each migration failure and compare exact pre/post flat-layout fingerprints; and
- delete only its verified temporary directory on success or failure.

The harness must refuse a published URL and accept only local regular files.

- [ ] **Step 5: Document the four gates and approval stops**

The runbook must state:

1. Gate 1: local external-effect-free lifecycle command;
2. Gate 2: separately authorized real signing/notarization, then temporary-home signed quartet validation while unpublished;
3. Gate 3: separately authorized publication and installed-off sequence-8 migration canary;
4. Gate 4: separately authorized next release and normal protocol-2 update canary;
5. collection/on and office activation remain later decisions.

- [ ] **Step 6: Commit the gate tooling**

```bash
git add scripts/test/runtime-raiders-lifecycle.sh scripts/test/verify-runtime-raiders-signed-release.sh package.json tests/companion-installer.test.ts docs/runtime-raiders-companion-release-gates.md
git commit -m "test: add versioned release lifecycle gates"
```

---

### Task 9: Complete local verification and stop before signing

**Files:**
- Verify: all files changed in Tasks 1-8
- Verify unchanged outside planned scope: server, Pi, Caddy, DNS, scoring, provider adapters, public artifacts, installed companion

**Interfaces:**
- Consume the committed implementation.
- Produce fresh local evidence and a reviewable implementation branch; do not create a release artifact.

- [ ] **Step 1: Run the complete Swift package**

```bash
swift test --disable-sandbox --package-path companion
```

Expected: every Swift test passes with zero failures.

- [ ] **Step 2: Run Gate 1 and repository checks**

```bash
npm run canary:lifecycle-test
npm test
npm run typecheck
```

Expected: the lifecycle gate, all Vitest files, and TypeScript validation pass.

- [ ] **Step 3: Verify shell and source hygiene**

```bash
sh -n companion/packaging/install.sh
bash -n scripts/release/build-runtime-raiders-agent.sh
bash -n scripts/test/runtime-raiders-lifecycle.sh
bash -n scripts/test/verify-runtime-raiders-signed-release.sh
git diff --check
git status --short
```

Expected: all parsers and diff checks pass; status contains no generated artifact, `.build`, temporary home, or test residue.

- [ ] **Step 4: Audit obsolete fixed-slot behavior and privacy boundaries**

```bash
rg -n 'Runtime Raiders Agent\.(rollback|failed)\.app|StableUpdateRecovery|__recover-update' companion/Sources companion/Tests scripts/test tests/companion-installer.test.ts
rg -n 'prompt|message|content|transcript|provider.*read|CLAUDE_CODE_ENABLE_TELEMETRY|OTEL' companion/Sources/RuntimeRaidersCore/LauncherSelection.swift companion/Sources/RuntimeRaidersLauncher companion/Sources/RuntimeRaidersCore/VersionedReleaseTransaction.swift scripts/test/runtime-raiders-lifecycle.sh
```

Expected: fixed-slot behavior appears only as explicitly preserved legacy installer fixture evidence, and the launcher/update/state surfaces contain no content or telemetry collection.

- [ ] **Step 5: Review commit and specification coverage**

```bash
git log --oneline --decorate dec88d4f..HEAD
git diff --stat dec88d4f..HEAD
git diff --name-only dec88d4f..HEAD
```

Manually check every acceptance criterion in the approved specification against a named passing test. Search the plan implementation for placeholders:

```bash
rg -n 'TODO|FIXME|TBD|placeholder|fatalError\("not implemented' companion scripts/test tests/companion-installer.test.ts
```

Expected: no implementation placeholder remains and every design criterion maps to executable evidence.

- [ ] **Step 6: Request a code review**

Use `superpowers:requesting-code-review` against the complete branch. Resolve only verified issues, rerun the affected focused test first, then rerun Steps 1-4.

- [ ] **Step 7: Stop at the signing boundary**

Report the branch head SHA, commit list, exact test totals, baseline caveats, and any preserved diagnostic worktrees. Do not build/sign/notarize, push/publish, install/migrate the canary, run a real update, enable collection, or activate the office without the corresponding new authorization.

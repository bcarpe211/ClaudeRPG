# Runtime Raiders Prepared Migration Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep supported collector-state migrations in memory while an updated companion is undergoing prepared health verification, then persist them only after the updater explicitly resumes the candidate.

**Architecture:** Preserve the updater's exact frozen-byte boundary and move the write boundary inside `AgentController`: construction may decode and migrate state in memory, but only the existing provider installation path persists a migrated state. The existing prepared-startup coordinator already defers that installation path until explicit resume, so no new state transaction, updater exception, or lock protocol is introduced.

**Tech Stack:** Swift 6, XCTest, Swift Package Manager, existing Runtime Raiders owner-only atomic state storage, Vitest/TypeScript repository verification.

## Global Constraints

- Protected enrollment, collector-state, and existing outbox bytes remain exact through candidate bootstrap and prepared health verification.
- A supported legacy adapter snapshot may be transformed only in memory before candidate health acceptance.
- A missing collector-state file must still create and persist the initial disabled state during controller construction.
- Invalid or unsupported persisted state must still fail closed without writing replacement state.
- `CompanionUpdater`, `PreparedDaemonStartupCoordinator`, bundle swap, rollback, terminal recovery, signing, and health rules do not change.
- Collection intent remains unchanged; prepared startup performs no collection, upload, provider watching, or Raid Power emission before resume.
- Do not change `companion/RELEASE`, build or sign artifacts, publish artifacts, update a companion, run `raiders on`, activate another canary, or activate the office.
- Follow red-green TDD: observe the regression fail for a protected-state byte change before changing production code.

---

### Task 1: Defer legacy migration persistence through prepared health

**Files:**
- Modify: `companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift:980-1066`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentController.swift:424-445`
- Reference: `docs/superpowers/specs/2026-08-08-runtime-raiders-prepared-migration-persistence-design.md`

**Interfaces:**
- Consumes: `AgentController.init(...)`, `AgentController.install(existingFiles:)`, `CompanionPreparedStartupLease.init(paths:)`, `PreparedDaemonStartupCoordinator.init(paths:deferredStart:)`, `PreparedDaemonStartupCoordinator.start()`, and `PreparedDaemonStartupCoordinator.resume()`.
- Produces: the invariant that `AgentController` construction can prepare a supported migration in memory without changing an existing `collector-state.json`; the existing `install(existingFiles:)` call remains the persistence boundary.

- [ ] **Step 1: Confirm the clean execution baseline**

Run:

```bash
test -z "$(git status --short)"
test ! -e companion/.build
git rev-parse --verify HEAD
```

Expected: the worktree is clean, no pre-existing Swift build directory could be mistaken for plan-created output, and the command prints the committed plan SHA.

- [ ] **Step 2: Extend the existing legacy-snapshot test with the prepared-startup boundary**

In `testLegacyRejectedSnapshotMigratesThroughCapturedEOFBeforeFutureRun`, replace the direct upgraded-controller construction and installation block with this sequence:

```swift
let legacyStateBytes = try Data(contentsOf: stateFile)
let lease = try CompanionPreparedStartupLease(paths: harness.paths)
defer { lease.unlock() }
let upgraded = try harness.makeController()
let startup = try PreparedDaemonStartupCoordinator(paths: harness.paths) {
    try upgraded.install(existingFiles: [file])
}

try startup.start()

XCTAssertTrue(startup.startsPrepared)
XCTAssertEqual(try Data(contentsOf: stateFile), legacyStateBytes)
XCTAssertFalse(upgraded.isAcceptingCollection)

try startup.resume()

XCTAssertNotEqual(try Data(contentsOf: stateFile), legacyStateBytes)
while upgraded.hasPendingReadWork {
    try upgraded.continuePendingWork()
}
XCTAssertTrue(upgraded.isAcceptingCollection)
```

Keep the remainder of the test unchanged so it continues to prove that the persisted version-2 snapshots establish a safe reseed boundary and score only the later live Run.

- [ ] **Step 3: Run the regression and verify the red state**

Run:

```bash
swift test --package-path companion --filter AgentControllerTests/testLegacyRejectedSnapshotMigratesThroughCapturedEOFBeforeFutureRun
```

Expected: FAIL at the new byte-equality assertion because sequence 7 currently persists migrated snapshots inside `AgentController.init(...)`. The failure must show differing collector-state bytes, not a fixture, compilation, lease, or filesystem error.

- [ ] **Step 4: Apply the minimal production change**

In `AgentController.init(...)`, keep migration and acceptance calculation but persist only the missing initial state:

```swift
self.stateDirectoryDescriptor = stateDirectoryDescriptor
_ = try migrateLegacyAdapterSnapshots()
acceptingCollection = state.enabled
    && !state.files.values.contains(where: \.seeding)
if stateWasMissing { try persist() }
```

Do not change `migrateLegacyAdapterSnapshots()`, `persist()`, `install(existingFiles:)`, prepared-startup coordination, or updater frozen-state comparison.

- [ ] **Step 5: Run the focused regression and verify the green state**

Run:

```bash
swift test --package-path companion --filter AgentControllerTests/testLegacyRejectedSnapshotMigratesThroughCapturedEOFBeforeFutureRun
```

Expected: PASS. Before `startup.resume()`, the legacy bytes remain exact and collection is not accepting; after resume, the bytes change through the existing atomic writer and the future Run receives only post-boundary usage.

- [ ] **Step 6: Run the neighboring safety suites**

Run:

```bash
swift test --package-path companion --filter AgentControllerTests
swift test --package-path companion --filter ControlProtocolTests
swift test --package-path companion --filter CompanionUpdaterTests
```

Expected: all three selected suites pass with zero failures. In particular, prepared startup remains deferred, updater protected-state mutation tests remain strict, and rollback behavior is unchanged.

- [ ] **Step 7: Review the narrow diff**

Run:

```bash
git diff --check
git diff -- companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift
git status --short
```

Expected: one test-boundary change and the initializer's two-line persistence change only. `companion/RELEASE`, `CompanionUpdater.swift`, and `PreparedDaemonStartup.swift` remain unchanged.

- [ ] **Step 8: Commit the red-green fix**

```bash
git add companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift
git commit -m "fix: defer prepared collector migration persistence"
```

### Task 2: Verify the complete local release boundary

**Files:**
- Verify: `companion/Sources/RuntimeRaidersCore/AgentController.swift`
- Verify: `companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift`
- Verify unchanged: `companion/RELEASE`
- Verify unchanged: `companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift`
- Verify unchanged: `companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift`

**Interfaces:**
- Consumes: the committed Task 1 change and all existing Swift, installer, and server tests.
- Produces: fresh local evidence that the narrow fix is ready for a separately authorized release-sequence change, without creating or publishing that release.

- [ ] **Step 1: Run the complete Swift package suite**

Run:

```bash
swift test --package-path companion
```

Expected: every Runtime Raiders companion test passes with zero failures.

- [ ] **Step 2: Run repository-wide regression checks**

Run:

```bash
npm test
npm run typecheck
npm run canary:upgrade-test
```

Expected: Vitest, TypeScript, and installer/update regression checks all pass with zero failures.

- [ ] **Step 3: Check shell syntax and source cleanliness**

Run:

```bash
sh -n companion/packaging/install.sh
bash -n scripts/release/build-runtime-raiders-agent.sh
git diff --check HEAD^ HEAD
repo_root=$(git rev-parse --show-toplevel)
test "$repo_root" = "$(pwd -P)"
build_dir="$repo_root/companion/.build"
test "$build_dir" = "$repo_root/companion/.build"
test -d "$build_dir"
test ! -L "$build_dir"
rm -rf -- "$build_dir"
test ! -e "$build_dir"
git status --short
```

Expected: both shell parsers and diff check succeed, the plan-created Swift build directory is verified and removed, and the worktree is clean.

- [ ] **Step 4: Prove release and updater scope stayed unchanged**

Run:

```bash
git diff --exit-code ac6947c..HEAD -- companion/RELEASE companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift companion/Sources/RuntimeRaidersCore/PreparedDaemonStartup.swift
git show --stat --oneline HEAD
```

Expected: the scoped diff command emits nothing and exits zero; the implementation commit contains only `AgentController.swift` and `AgentControllerTests.swift`.

- [ ] **Step 5: Stop at the release gate**

Record the fresh test totals and implementation commit SHA in the handoff. Do not change the release sequence, build/sign/notarize artifacts, push, publish, install, update the canary, enable collection, or activate the office without a new explicit authorization.

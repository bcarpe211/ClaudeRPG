# Runtime Raiders Codex Contract and Manual Updates Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correctly classify version-drifting Codex Desktop and CLI Runs, then add private release discovery and an explicit, signed, rollback-safe `raiders update` workflow.

**Architecture:** Keep provider parsing, release parsing, update discovery, archive validation, trust validation, and bundle replacement as separate Swift units with injected side effects. Extend the existing signed universal-app builder and immutable Pi release selector so the same strict public manifest is embedded in, published with, and checked against each candidate.

**Tech Stack:** Swift 6 / Foundation / Security / CryptoKit on macOS 13+, XCTest, Bash, Node.js 20, TypeScript, Vitest, Caddy, launchd

## Global Constraints

- Do not enable OTel or change any OpenAI, Anthropic, Omp, shell, editor, or provider configuration.
- Do not read, store, log, or upload prompts, responses, commands, tool calls, file contents, paths, repository names, window titles, native Run identifiers, or provider record fragments.
- Send release checks only to `https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json`, with no query, body, cookie, credential, enrollment field, device field, version field, provider field, or usage field.
- Keep one existing LaunchAgent and daemon; the update notification may spawn only one fixed, short-lived `/usr/bin/osascript` child.
- Release discovery and `raiders update` never download or execute a remote schema, parser, scoring rule, script, or shell command; the separately gated first-install workflow remains the sole published-installer exception.
- Never install automatically. Only the player's foreground `raiders update` command may download and replace the app.
- Preserve the simple single-line `curl .../install.sh | /bin/sh` experience for routine first-time office onboarding after the controlled canary passes. The canary itself must use a locally downloaded, recorded-digest-verified installer; manifests and ZIPs are never piped to a shell.
- Refuse replacement when a locally known Run is active, recheck atomically before daemon quiescence, and never interrupt a provider process.
- Keep collector-state version `1` and Codex snapshot version `1` backward-readable by the installed release; add only optional, unknown-key-safe fields.
- Keep enrollment, collector state, cursors, update state, and outbox outside the replaceable app bundle.
- Keep provider, model, and effort display-only; do not change the server event schema, database, scoring, or leaderboard.
- Keep the existing production Run as audit evidence; do not repair, delete, or reclassify it.
- Keep office collection activation as a separate explicit authorization after the signed two-sequence canary.
- Production server or Caddy work remains subject to the paused, rollback-protected deployment procedure.

---

## File and responsibility map

| File | Responsibility |
| --- | --- |
| `companion/Sources/RuntimeRaidersCore/CodexAdapter.swift` | Exact Codex source classification, build-tolerant structural contract, content-free compatibility state |
| `companion/Sources/RuntimeRaidersCore/CompanionRelease.swift` | Installed signed release identity from the app's sealed `Info.plist` |
| `companion/Sources/RuntimeRaidersCore/ReleaseManifest.swift` | Exact public manifest schema, bounds, URL pin, monotonic comparison |
| `companion/Sources/RuntimeRaidersCore/ReleaseChecker.swift` | Owner-only update state, 24-hour check, one notification attempt, status availability |
| `companion/Sources/RuntimeRaidersCore/ArtifactDownloader.swift` | Fixed-origin, no-redirect, bounded streaming download and SHA-256 |
| `companion/Sources/RuntimeRaidersCore/ZipArchiveValidator.swift` | ZIP central-directory safety checks before extraction |
| `companion/Sources/RuntimeRaidersCore/SystemCommandRunner.swift` | Bounded shell-free execution of fixed macOS trust and launch utilities |
| `companion/Sources/RuntimeRaidersCore/CandidateVerifier.swift` | Bundle identity, all-architecture signature, Team ID, hardened runtime, timestamp, notarization policy |
| `companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift` | Update lock, active-Run gates, app swap, health validation, rollback, failed-rollback preservation |
| `companion/Sources/RuntimeRaidersCore/AgentPaths.swift` | Stable update state, lock, staging, installed app, and LaunchAgent paths |
| `companion/Sources/RuntimeRaidersCore/AgentController.swift` | Persisted compatibility diagnostics, restart-safe active Run count, status/doctor fields |
| `companion/Sources/RuntimeRaidersCore/ControlSocket.swift` | Owner-only internal daemon-quiescence request and documented command timeout policy |
| `companion/Sources/RuntimeRaidersCLI/main.swift` | Thin daemon wiring, separate update queue, user-command allowlist, self-check, live updater operations |
| `companion/RELEASE` | Reviewed companion version, release sequence, and update protocol that force a new Git SHA per sequence |
| `scripts/release/build-runtime-raiders-agent.sh` | Embed release facts, sign/notarize/staple, create ZIP/checksum/public manifest as one local transaction |
| `companion/packaging/install.sh` | Validate embedded release facts during first install without changing enrollment semantics |
| `scripts/pi/runtime-raiders-artifacts.sh` | Backward-compatible v1 status plus monotonic v2 quartet publication and atomic selector swap |
| `deploy/Caddyfile` | One additional literal JSON manifest route before the existing application fallback |
| `scripts/pi/runtime-raiders-preflight.sh` | Include the fourth literal artifact route in a fresh unpublished cutover check |
| `docs/runtime-raiders/companion-operations.md` | Build, publish, manual update, recovery, and privacy operations |
| `docs/runtime-raiders/companion-update-canary.md` | Exact two-sequence installed-off and live classification acceptance record |

The current large controller and installer remain in place; this plan adds focused files instead of folding update behavior into either one.

---

### Task 1: Make Codex compatibility structural and surface-correct

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/CodexAdapter.swift:7-480`
- Modify: `companion/Fixtures/codex/cli-*.jsonl`
- Modify: `companion/Fixtures/codex/desktop-*.jsonl`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/CodexAdapterTests.swift:8-505`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift`

**Interfaces:**
- Produces: `CodexCompatibilityIssue`, `CodexAdapter.compatibilityIssue`, and `CodexAdapter.hasActiveRun`.
- Preserves: `CodexAdapter.consume(...) -> [NativeRunObservation]` and snapshot version `1`.
- Consumed by: Task 3 doctor aggregation and Task 5 active-Run refusal.

- [ ] **Step 1: Replace the exact-version test with failing structural-contract tests**

Add tests named:

```swift
func testVscodeRootClassifiesOnlyAsDesktopAcrossBoundedVersions() throws
func testExecRootClassifiesOnlyAsCLIAcrossBoundedVersions() throws
func testStrictSubagentObjectRemainsDesktop() throws
func testMalformedOrOversizedVersionFailsClosedWithContractReason() throws
func testUnknownSourceFailsClosedWithSourceReason() throws
func testCompatibilityReasonSurvivesSnapshotWithoutContent() throws
func testActiveRunStateSurvivesSnapshotWithoutExposingNativeID() throws
```

Use `0.146.0-alpha.3.1`, `0.146.0-alpha.9.2`, and `1.0.0` as accepted bounded version samples. Use missing, numeric, empty, and 101-byte values as rejected versions. Assert an `exec` record emits nothing from a Desktop adapter and a `vscode` record emits nothing from a CLI adapter.

- [ ] **Step 2: Run the focused tests and confirm the old implementation fails for the live-shaped sources**

Run:

```bash
cd companion
swift test --filter CodexAdapterTests
```

Expected: FAIL because `vscode` is currently classified as CLI, `exec` is not distinguished, and newer bounded versions are rejected.

- [ ] **Step 3: Define the content-free compatibility interface without changing snapshot version**

Add:

```swift
public enum CodexCompatibilityIssue: String, Codable, CaseIterable, Equatable, Sendable {
    case unsupportedSource = "unsupported_source"
    case unsupportedContract = "unsupported_contract"
}

public var compatibilityIssue: CodexCompatibilityIssue? { storedCompatibilityIssue }
public var hasActiveRun: Bool { activeNativeID != nil && activeCompletedOrdinal == nil }
```

Add `compatibilityIssue: CodexCompatibilityIssue?` to `PersistedState`, implement custom decoding with `decodeIfPresent`, and continue encoding `version: 1`. Old binaries ignore the extra key; new binaries accept snapshots written before the field existed.

- [ ] **Step 4: Implement exact source mapping and bounded version validation**

Replace the version equality and broad string check with:

```swift
private static func validRecordVersion(_ value: Any?) -> Bool {
    guard let value = value as? String else { return false }
    return !value.isEmpty && value.utf8.count <= 100
}

private static func sessionSurface(_ source: Any?) -> RunSurface? {
    if let source = source as? String {
        switch source {
        case "vscode": return .codexDesktop
        case "exec": return .codexCLI
        default: return nil
        }
    }
    return strictSubagentSurface(source)
}
```

Set `.unsupportedContract` for malformed session metadata and `.unsupportedSource` only when every required metadata field is valid but `source` is unknown. A valid surface that differs from one adapter's `expectedSurface` is an expected non-match, not a compatibility warning.

- [ ] **Step 5: Make lifecycle invariants explicitly reject regressions**

Retain the existing exact record kinds and counter maxima. Add assertions that a token observation cannot move any cumulative counter backward and that an event timestamp cannot precede the active Run start. Emit nothing, retain no pending invalid value, and set `.unsupportedContract` for a recognized file whose required lifecycle shape violates those invariants.

- [ ] **Step 6: Update every synthetic fixture and inline controller record**

Change CLI root fixtures from synthetic or `cli` source strings to exact `exec`. Change Desktop root fixtures to exact `vscode`. Keep one direct strict-subagent test object. Do not copy any live path, Run ID, prompt, response, or record fragment into the repository.

- [ ] **Step 7: Run adapter, controller, and privacy tests**

Run:

```bash
cd companion
swift test --filter CodexAdapterTests
swift test --filter AgentControllerTests
swift test --filter PrivacyEncoderTests
```

Expected: PASS; fixture output still crosses the existing privacy encoder, and snapshots contain only the compatibility enum rather than rejected record data.

- [ ] **Step 8: Commit the structural compatibility unit**

```bash
git add companion/Sources/RuntimeRaidersCore/CodexAdapter.swift companion/Fixtures/codex companion/Tests/RuntimeRaidersCoreTests/CodexAdapterTests.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift
git commit -m "fix(raiders): classify Codex surfaces structurally"
```

---

### Task 2: Define signed release identity and the strict public manifest

**Files:**
- Create: `companion/RELEASE`
- Create: `companion/Sources/RuntimeRaidersCore/CompanionRelease.swift`
- Create: `companion/Sources/RuntimeRaidersCore/ReleaseManifest.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ReleaseManifestTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentPaths.swift:3-25`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/AtomicStoreTests.swift:114-133`

**Interfaces:**
- Produces: `CompanionReleaseIdentity`, `ReleaseManifestV1`, `CompanionUpdateAvailability`, and stable manifest/archive URLs.
- Consumed by: Tasks 3-8.

- [ ] **Step 1: Add failing release-identity and exact-manifest tests**

Cover:

```swift
func testReleaseIdentityRequiresExactNamedInfoDictionaryValues() throws
func testManifestAcceptsOnlyTheExactVersionOneShape() throws
func testManifestRejectsExtraKeysBooleansUnsafeIntegersAndBadStrings() throws
func testManifestPinsTheExactArchiveURL() throws
func testAvailabilityRequiresHigherSequenceAndMatchingProtocol() throws
```

Use these public contracts:

```swift
public struct CompanionReleaseIdentity: Codable, Equatable, Sendable {
    public let releaseSequence: Int64
    public let releaseSHA: String
    public let companionVersion: String
    public let updateProtocolVersion: Int

    public static func parse(infoDictionary: [String: Any]) throws -> Self
}

public struct ReleaseManifestV1: Codable, Equatable, Sendable {
    public static let manifestURL = URL(string:
        "https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json"
    )!
    public static let archiveURL = URL(string:
        "https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"
    )!
    public static func decode(_ data: Data) throws -> Self
    public func availability(from installed: CompanionReleaseIdentity)
        -> CompanionUpdateAvailability?
}

public struct CompanionUpdateAvailability: Codable, Equatable, Sendable {
    public let installedVersion: String
    public let installedSequence: Int64
    public let availableVersion: String
    public let availableSequence: Int64
    public let updateCommand: String // exactly "raiders update"
}
```

- [ ] **Step 2: Run the new test classes and verify missing-type failures**

```bash
cd companion
swift test --filter CompanionReleaseTests
swift test --filter ReleaseManifestTests
```

Expected: FAIL because the types do not exist.

- [ ] **Step 3: Add the reviewed first release metadata**

Create `companion/RELEASE` with exactly:

```text
version=1
companion_version=0.2.0
release_sequence=1
update_protocol_version=1
```

The release builder will require this exact four-line format. Advancing to the second signed canary requires a reviewed commit changing `companion_version` to `0.2.1` and `release_sequence` to `2`, which guarantees a different Git SHA and immutable release directory.

- [ ] **Step 4: Implement strict identity and manifest parsing**

Use `JSONSerialization` before constructing `ReleaseManifestV1` so exact key sets can be enforced. Exclude `CFBoolean` values from integer fields. Bound sequences to `1...9_007_199_254_740_991`, versions to 1-100 ASCII characters in `[A-Za-z0-9._+-]`, SHA fields to lowercase hexadecimal, and the URL to exact string equality.

Read installed identity from these sealed `Info.plist` keys:

```text
CFBundleIdentifier = com.redlattice.runtime-raiders-agent
CFBundleShortVersionString = <companion_version>
RuntimeRaidersReleaseSequence = <positive safe integer>
RuntimeRaidersReleaseSHA = <40 lowercase hex>
RuntimeRaidersUpdateProtocolVersion = 1
```

- [ ] **Step 5: Add stable owner-only update paths**

Extend `AgentPaths` with:

```swift
public let updateState: URL       // state/update-state.json
public let updateLock: URL        // state/update.lock
public let installedApplication: URL // support/Runtime Raiders Agent.app
public let rollbackApplication: URL  // support/Runtime Raiders Agent.rollback.app
public let failedApplication: URL    // support/Runtime Raiders Agent.failed.app
```

Assert construction only; `AgentPaths` must not create directories.

- [ ] **Step 6: Run the focused contract tests**

```bash
cd companion
swift test --filter CompanionReleaseTests
swift test --filter ReleaseManifestTests
swift test --filter AtomicStoreTests
```

Expected: PASS for exact shapes and FAIL-closed malformed inputs.

- [ ] **Step 7: Commit the release-contract unit**

```bash
git add companion/RELEASE companion/Sources/RuntimeRaidersCore/CompanionRelease.swift companion/Sources/RuntimeRaidersCore/ReleaseManifest.swift companion/Sources/RuntimeRaidersCore/AgentPaths.swift companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift companion/Tests/RuntimeRaidersCoreTests/ReleaseManifestTests.swift companion/Tests/RuntimeRaidersCoreTests/AtomicStoreTests.swift
git commit -m "feat(raiders): define signed release contracts"
```

---

### Task 3: Add private daily discovery, one notification, status, and doctor output

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/ReleaseChecker.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ReleaseCheckerTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentController.swift:16-102,314-380,589-647,1099-1114`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift:6-260,310-361`

**Interfaces:**
- Consumes: `ReleaseManifestV1`, `CompanionReleaseIdentity`, and `CodexCompatibilityIssue`.
- Produces: `UpdateStateV1`, `UpdateStateStore`, `ReleaseChecker`, enriched `AgentStatus`, and enriched `DoctorReport`.
- Preserves: collection, uploader, watcher, and heartbeat behavior when discovery fails.

- [ ] **Step 1: Add failing state, cadence, request-privacy, and notification tests**

Add tests for:

```swift
func testMalformedStateLoadsAsEmptyAndRewritesOwnerOnly() throws
func testCheckIsDueOnlyAfterTwentyFourHours() throws
func testRequestHasExactURLGETAndNoReportingFields() throws
func testHigherSequenceIsCachedAndNotifiedExactlyOnce() throws
func testNotificationAttemptIsRecordedBeforeNotifierRuns() throws
func testNetworkAndManifestFailuresPreserveCollectionIndependentState() throws
func testStatusShowsInstalledAvailableAndExactUpdateCommand() throws
func testDoctorReportsOnlySortedCompatibilityReasonCodes() throws
```

Inspect the captured `URLRequest`: `httpMethod == "GET"`, `httpBody == nil`, no query, and no `Authorization`, `Cookie`, enrollment, device, version, provider, model, effort, usage, or Run fields.

- [ ] **Step 2: Run focused tests and verify they fail before the checker exists**

```bash
cd companion
swift test --filter ReleaseCheckerTests
swift test --filter AgentControllerTests
```

Expected: FAIL for missing types and missing status/doctor fields.

- [ ] **Step 3: Implement the owner-only update state**

Use this exact persisted schema:

```swift
struct UpdateStateV1: Codable, Equatable {
    let version: Int                 // exactly 1
    var lastCheckAttemptMS: Int64?
    var lastObservedReleaseSequence: Int64?
    var lastNotifiedReleaseSequence: Int64?
    var cachedManifest: ReleaseManifestV1?
}
```

Open the state directory through the existing no-symlink owner-only directory logic. Read `update-state.json` with `openat(..., O_NOFOLLOW)`, require a regular file owned by the current user with mode `0600`, cap it at 16 KiB, and write through `AtomicStore`. A malformed file becomes an empty v1 state; never copy malformed bytes into diagnostics.

- [ ] **Step 4: Implement checker cadence and one-time notification ordering**

Expose:

```swift
public final class ReleaseChecker: @unchecked Sendable {
    public typealias Transport = @Sendable (URLRequest) throws -> UploadHTTPResponse
    public typealias Notifier = @Sendable () -> Bool

    public func checkIfDue() -> ReleaseCheckResult
    public func fetchNow() throws -> ReleaseManifestV1
    public func availability() -> CompanionUpdateAvailability?
}

public enum ReleaseCheckResult: Equatable, Sendable {
    case notDue
    case checked(CompanionUpdateAvailability?)
    case failed
}
```

Under one lock, persist `lastCheckAttemptMS` before network access. On a valid higher sequence, persist the cached manifest and `lastNotifiedReleaseSequence` before invoking the notifier. Preserve a previously validated cached manifest on transient network or malformed-response failure, but never cache the failed response.

The live transport uses an ephemeral session with no cache or credential storage, refuses redirects, allows only the exact compiled manifest URL, caps the response at 64 KiB, and applies a two-second request/resource timeout. It constructs the fixed anonymous `GET` itself rather than accepting a caller-supplied request.

- [ ] **Step 5: Implement the fixed native notification**

The live notifier must call `Process` directly, without a shell, with exactly:

```swift
executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
arguments = [
    "-e",
    "display notification \"Run raiders update.\" with title \"Runtime Raiders update available\"",
]
```

Discard bounded output. Return `false` on launch, timeout, or nonzero-exit failure. Do not interpolate manifest or user values into the argument.

- [ ] **Step 6: Enrich status and doctor without exposing record data**

Add flat status fields:

```swift
installedCompanionVersion: String
installedReleaseSequence: Int64
availableCompanionVersion: String?
availableReleaseSequence: Int64?
updateCommand: String? // exactly "raiders update" only when available
```

Add doctor fields:

```swift
compatibilityNeedsReview: Bool
compatibilityReasons: [CodexCompatibilityIssue]
```

Aggregate issues by decoding the optional enum from persisted adapter snapshots. Count active snapshots so `activeRunCount` remains conservative across daemon restart. Never expose snapshot paths or native identifiers.

- [ ] **Step 7: Wire discovery on a queue separate from provider collection**

In `DaemonRuntime`, add a dedicated utility `updateQueue`. After the control socket and collector install succeed, dispatch exactly one `checkIfDue()` call on that queue. Do not use `workQueue`; a two-second manifest timeout must not delay file callbacks. Status reads only the local cached availability.

- [ ] **Step 8: Run discovery, status, doctor, and control regression tests**

```bash
cd companion
swift test --filter ReleaseCheckerTests
swift test --filter AgentControllerTests
swift test --filter ControlProtocolTests
swift test --filter UploaderTests
```

Expected: PASS; checks still occur when collection is disabled, and no test request contains a player or device fact.

- [ ] **Step 9: Commit the discovery unit**

```bash
git add companion/Sources/RuntimeRaidersCore/ReleaseChecker.swift companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/ReleaseCheckerTests.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift
git commit -m "feat(raiders): notify once for signed updates"
```

---

### Task 4: Build bounded download, ZIP safety, and candidate trust validation

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/ArtifactDownloader.swift`
- Create: `companion/Sources/RuntimeRaidersCore/ZipArchiveValidator.swift`
- Create: `companion/Sources/RuntimeRaidersCore/SystemCommandRunner.swift`
- Create: `companion/Sources/RuntimeRaidersCore/CandidateVerifier.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ArtifactDownloaderTests.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ZipArchiveValidatorTests.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/SystemCommandRunnerTests.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/CandidateVerifierTests.swift`

**Interfaces:**
- Consumes: the exact manifest and installed release identity from Task 2.
- Produces: `DownloadReceipt`, `ZipArchiveValidator.validate`, `SystemCommandRunner`, `CandidateSignatureFacts`, and `CandidateVerifier.verify`.
- Consumed by: Task 5 updater transaction.

- [ ] **Step 1: Add failing download-policy tests**

Cover an exact HTTPS request, redirect refusal, non-200 response, 128 MiB plus one byte, timeout, partial-file cleanup, SHA mismatch, and destination symlink refusal. The successful result is:

```swift
public struct DownloadReceipt: Equatable, Sendable {
    public let byteCount: Int64
    public let sha256: String
}
```

- [ ] **Step 2: Add failing ZIP central-directory tests**

Use a small in-test ZIP builder and cover:

- one exact `Runtime Raiders Agent.app/` root;
- absolute paths, `..`, `.`, empty components, backslashes, control characters, and duplicate entries;
- non-ASCII path bytes, case-insensitive path collisions, and central/local-header name mismatches;
- symlink and special-file Unix mode bits;
- encrypted, multi-disk, ZIP64, unsupported compression, truncated, and trailing-garbage archives;
- more than 4,096 entries; and
- total uncompressed size above 256 MiB.

Expose:

```swift
public enum ZipArchiveValidator {
    public static func validate(_ archive: URL) throws -> ZipArchiveSummary
}
```

- [ ] **Step 3: Add failing candidate-policy and process-boundary tests**

Test wrong bundle ID, Team ID mismatch with the installed self, invalid one-architecture slice, missing hardened runtime, missing secure timestamp, missing notarization, mismatched embedded manifest fields, and a valid candidate. Test the process boundary with an injected absolute executable: argument preservation without a shell, 64 KiB stdout and stderr caps, timeout termination, and typed exit status.

Separate inspection from policy:

```swift
public struct CandidateSignatureFacts: Equatable, Sendable {
    public let bundleIdentifier: String
    public let teamIdentifier: String
    public let allArchitecturesValid: Bool
    public let hardenedRuntime: Bool
    public let secureTimestampPresent: Bool
    public let gatekeeperNotarized: Bool
}

public struct CandidateVerifier {
    public func verify(
        candidate: URL,
        manifest: ReleaseManifestV1,
        installed: CompanionReleaseIdentity,
        installedTeamIdentifier: String
    ) throws -> CompanionReleaseIdentity
}
```

- [ ] **Step 4: Run the four new test classes and verify missing-type failures**

```bash
cd companion
swift test --filter ArtifactDownloaderTests
swift test --filter ZipArchiveValidatorTests
swift test --filter SystemCommandRunnerTests
swift test --filter CandidateVerifierTests
```

Expected: FAIL because the validation and bounded process units do not exist.

- [ ] **Step 5: Implement bounded streaming download**

Use an ephemeral `URLSession`, no cache, no credential storage, one connection, a redirect delegate that returns `nil`, a 10-second connection/request limit, and a 120-second resource limit. Stream to an `O_CREAT | O_EXCL | O_NOFOLLOW` mode-`0600` file while updating `CryptoKit.SHA256`; never retain the 128 MiB body in memory. Cancel and unlink on any overflow or error.

- [ ] **Step 6: Implement the bounded shell-free process runner**

Create a process runner that accepts only an absolute executable URL and an argument array, never invokes a shell, caps stdout and stderr at 64 KiB each, terminates on timeout, and returns a typed exit result. Live callers may use only compiled absolute executable paths; candidate and staging paths are data arguments, never executable selections.

- [ ] **Step 7: Implement the ZIP validator before invoking `/usr/bin/ditto`**

Parse the classic EOCD, central directory, and referenced local headers directly from the bounded local file. Require printable ASCII relative paths, compare each central name and method to its local header, and reject ZIP64 sentinels, inconsistent or overlapping offsets/counts, data outside the declared archive, case-folded duplicate paths, unsafe external attributes, and unexpected roots before extraction. After `ditto -x -k`, recursively `lstat` the staging tree again and require only directories and regular files beneath the exact app root.

- [ ] **Step 8: Implement system trust inspection with built-in macOS facilities**

Use `SecStaticCodeCreateWithPath`, the installed app's designated requirement, and `SecStaticCodeCheckValidity` with `kSecCSCheckAllArchitectures`, strict, nested-code, and symlink-restriction flags. Also require `/usr/bin/codesign --verify --strict --all-architectures` with that designated requirement. Read Team ID, signing flags, and timestamp from `SecCodeCopySigningInformation`; compare the candidate Team ID to the verified installed self.

Run `/usr/bin/codesign --verify --strict --check-notarization -R=notarized <app>` and `/usr/sbin/spctl --assess --type execute --verbose=4 <app>` directly with bounded output. Require successful notarization assessment. The release-time ZIP digest binds this runtime result to the app that passed `xcrun stapler validate` before zipping; no player-side Xcode installation is required.

- [ ] **Step 9: Run validation and existing network tests**

```bash
cd companion
swift test --filter ArtifactDownloaderTests
swift test --filter ZipArchiveValidatorTests
swift test --filter SystemCommandRunnerTests
swift test --filter CandidateVerifierTests
swift test --filter UploaderTests
```

Expected: PASS, including redirect and output-size boundaries.

- [ ] **Step 10: Commit the artifact trust unit**

```bash
git add companion/Sources/RuntimeRaidersCore/ArtifactDownloader.swift companion/Sources/RuntimeRaidersCore/ZipArchiveValidator.swift companion/Sources/RuntimeRaidersCore/SystemCommandRunner.swift companion/Sources/RuntimeRaidersCore/CandidateVerifier.swift companion/Tests/RuntimeRaidersCoreTests/ArtifactDownloaderTests.swift companion/Tests/RuntimeRaidersCoreTests/ZipArchiveValidatorTests.swift companion/Tests/RuntimeRaidersCoreTests/SystemCommandRunnerTests.swift companion/Tests/RuntimeRaidersCoreTests/CandidateVerifierTests.swift
git commit -m "feat(raiders): verify update artifacts locally"
```

---

### Task 5: Implement the rollback-safe foreground update transaction

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/CompanionUpdaterTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentController.swift:399-438`

**Interfaces:**
- Consumes: Tasks 2-4 release, download, ZIP, trust, status, and state interfaces.
- Produces: `CompanionUpdater.run() -> CompanionUpdateResult`, `UpdateFileTransaction`, and `AgentController.persistDisabledForRecovery`.
- Consumed by: Task 6 live CLI wiring.

- [ ] **Step 1: Add failing orchestration tests with injected operations**

Define a fake operation log and cover exact order for:

```swift
func testAlreadyCurrentReturnsWithoutDownload() throws
func testInitialActiveRunRefusesBeforeDownload() throws
func testSecondActiveRunCheckRefusesBeforeQuiescence() throws
func testDigestOrCandidateFailureNeverStopsDaemon() throws
func testInsufficientSpaceRefusesBeforeQuiescence() throws
func testSuccessfulUpdatePreservesEnabledAndDisabledIntent() throws
func testPostSwapHealthFailureRestoresOldBundleAndState() throws
func testRollbackFailurePreservesBothBundlesAndPersistsDisabled() throws
func testConcurrentUpdateLockRefusesSecondUpdater() throws
```

The successful operation sequence must be:

```text
lock, status, fetch, download, archive-validate, extract, candidate-verify,
self-check, status-recheck, prepare-daemon, bootout, swap, bootstrap,
health-verify, cleanup, unlock
```

Use these exact public results and recovery entry point:

```swift
public enum CompanionUpdateResult: Equatable, Sendable {
    case alreadyCurrent
    case updated(from: CompanionReleaseIdentity, to: CompanionReleaseIdentity)
}

public final class CompanionUpdater {
    public func run() throws -> CompanionUpdateResult
}

public static func persistDisabledForRecovery(
    paths: AgentPaths,
    surfaces: [RunSurface]
) throws
```

- [ ] **Step 2: Add failing real temporary-filesystem transaction tests**

Create owner-only fake installed and candidate app directories under one temporary support directory. Assert:

- staging and rollback paths start at mode `0700`;
- no symlink target is followed;
- swap uses sibling renames rather than copy-overwrite;
- rollback moves a failed candidate aside before restoring the old app;
- cleanup never deletes the only verified app; and
- enrollment, collector state, adapter snapshots/cursors, and outbox byte-for-byte hashes do not change; and
- after the required fresh manifest fetch, update state changes only through `ReleaseChecker`, then remains byte-for-byte unchanged through quiescence, swap, health verification, and rollback.

- [ ] **Step 3: Run the updater tests and verify they fail before implementation**

```bash
cd companion
swift test --filter CompanionUpdaterTests
```

Expected: FAIL because `CompanionUpdater` and `UpdateFileTransaction` do not exist.

- [ ] **Step 4: Implement the exclusive update lock and pre-swap phase**

Open `state/update.lock` with `O_CREAT | O_NOFOLLOW | O_CLOEXEC`, require a current-user regular file with mode `0600`, and take `flock(LOCK_EX | LOCK_NB)`. While holding it:

1. load live/local status and refuse an active Run;
2. force a fresh manifest fetch, ignoring the 24-hour throttle;
3. require a higher compatible sequence;
4. create an owner-only staging directory;
5. download and compare the exact manifest digest;
6. validate and extract the ZIP;
7. verify candidate signature/release identity; and
8. execute the candidate's fixed `__self-check` command and compare its bounded JSON identity.

Before step 8, require local available capacity for the retained old app, the
candidate's validated uncompressed size, and a 64 MiB safety margin. No daemon
state changes occur before all eight steps and the capacity gate pass.

- [ ] **Step 5: Implement quiescence, swap, health validation, and cleanup**

Recheck active Runs through the daemon's serialized prepare request. Capture the exact prior persisted enabled state, then boot out the one existing LaunchAgent without writing `enabled=false`. Swap the app bundle through sibling renames, bootstrap the unchanged plist, and poll for at most 10 seconds until status proves:

- daemon running;
- exact new sequence, SHA, and companion version;
- prior enabled/disabled intent restored;
- enrollment still valid;
- collector state valid; and
- queued-event count unchanged or greater only from legitimate resumed collection.

Only then remove staging and rollback directories.

- [ ] **Step 6: Implement rollback and terminal recovery behavior**

On any post-quiescence failure, boot out the candidate, move it to the stable owner-only `Runtime Raiders Agent.failed.app`, restore `Runtime Raiders Agent.rollback.app`, bootstrap, and verify the prior release identity, daemon health, and prior enabled state. If restoration cannot complete, keep both app directories, atomically set only `collector-state.json.enabled` to `false` while preserving all file snapshots, and print this exact local recovery command:

```bash
"$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.rollback.app/Contents/MacOS/runtime-raiders-agent" __recover-update
```

The rollback binary accepts `__recover-update` only when it is running from the
exact stable rollback bundle, revalidates both bundles, restores the prior app,
and restarts it disabled. Never delete the last verified app.

- [ ] **Step 7: Run updater and controller state tests**

```bash
cd companion
swift test --filter CompanionUpdaterTests
swift test --filter AgentControllerTests
swift test --filter AtomicStoreTests
swift test --filter OutboxTests
```

Expected: PASS with byte-for-byte protected-state assertions and only the explicitly permitted pre-swap update-state write.

- [ ] **Step 8: Commit the transaction unit**

```bash
git add companion/Sources/RuntimeRaidersCore/CompanionUpdater.swift companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Tests/RuntimeRaidersCoreTests/CompanionUpdaterTests.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift
git commit -m "feat(raiders): add rollback-safe update transaction"
```

---

### Task 6: Wire daemon quiescence, self-check, and the user command allowlist

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift:7-115,393-445`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift:5-164`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift:28-368`

**Interfaces:**
- Consumes: `CompanionUpdater` and the release checker.
- Produces: owner-only `.prepareUpdate` control request, documented `raiders update`, and fixed internal `__self-check`.
- Preserves: documented `raiders daemon|on|off|status|doctor|uninstall` behavior.

- [ ] **Step 1: Add failing control and command-routing tests**

Assert:

- `.prepareUpdate` has a 30-second control timeout and no invocation metadata;
- it refuses when the conservative active count is nonzero;
- when accepted, it pauses watcher/uploader/heartbeat without calling `turnOff()`;
- `raiders update` is routed locally and never sent over the control socket;
- `raiders prepare_update` is rejected by the user-facing parser; and
- `__self-check` emits only exact release identity JSON; and
- `__recover-update` is rejected unless the verified executable is inside the exact stable rollback bundle.

- [ ] **Step 2: Run control tests and verify missing command behavior**

```bash
cd companion
swift test --filter ControlProtocolTests
```

Expected: FAIL for the missing internal command, routing, and daemon preparation behavior.

- [ ] **Step 3: Separate user commands from internal control commands**

Keep `ControlCommand.prepareUpdate` codable for the owner-only socket, but parse terminal arguments through a new private allowlist:

```swift
private enum UserCommand: String {
    case on, off, status, doctor, uninstall, update
}
```

Handle `daemon` only from launchd's exact invocation, `__self-check` only as an exact internal single argument, and `__recover-update` only from the stable rollback bundle. Reject all additional or combined arguments with the updated usage string.

- [ ] **Step 4: Implement serialized daemon preparation**

On `.prepareUpdate`, execute on `workQueue`, re-read the conservative active count, and return failure without side effects if nonzero. Otherwise pause acceptance, uploader, heartbeat, and watcher, but do not change persisted collection intent. The foreground updater must immediately boot out or restart the job on every exit path so a prepared daemon cannot remain paused.

- [ ] **Step 5: Wire bounded direct process execution into the live updater**

Use the bounded `SystemCommandRunner` from Task 4 with only compiled absolute paths for `ditto`, `codesign`, `spctl`, `launchctl`, and candidate self-check. Keep all executable selection local; only the candidate app path may be passed as a data argument.

At startup, load release identity from `Bundle.main.infoDictionary`. Use its companion version in events and heartbeat instead of the mutable `RUNTIME_RAIDERS_COMPANION_VERSION` environment variable.

- [ ] **Step 6: Run the complete Swift suite**

```bash
cd companion
swift test --quiet
```

Expected: all prior and new tests PASS; no test displays a real notification or touches the installed app.

- [ ] **Step 7: Commit CLI and daemon wiring**

```bash
git add companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift
git commit -m "feat(raiders): expose explicit companion updates"
```

---

### Task 7: Embed and transactionally build the signed release quartet

**Files:**
- Modify: `scripts/release/build-runtime-raiders-agent.sh:1-164`
- Modify: `companion/packaging/install.sh:4-80,292-325`
- Modify: `tests/companion-installer.test.ts:1061-1303`

**Interfaces:**
- Consumes: exact `companion/RELEASE` and final Git SHA.
- Produces: `install.sh`, `runtime-raiders-agent.zip`, `runtime-raiders-agent.zip.sha256`, and `runtime-raiders-agent.update.json` as one local transaction.
- Consumed by: Task 8 Pi publication.

- [ ] **Step 1: Add failing release-builder tests for required metadata**

Require `--release-sha <40-lowercase-hex>` and a clean `HEAD` equal to that SHA. Add failure cases for malformed/extra/missing `companion/RELEASE` lines, unsafe version characters, nonpositive/unsafe sequence, unsupported protocol, and dirty or mismatched Git state.

- [ ] **Step 2: Add failing quartet and sealed-identity tests**

After a fake successful build, assert the staged `Info.plist` contains the five exact identity keys, the public JSON has the exact seven-key schema from the design, its ZIP digest equals the generated checksum, and `install.sh` contains the rendered companion version, sequence, protocol, Team ID, and fixed URLs with no placeholder remaining. Inspect the distribution archive and require its only top-level entry to be `Runtime Raiders Agent.app/`; it must not contain a `__MACOSX` sidecar.

Inject failure at each of the four final output moves and prove the previous complete quartet is restored without touching an orphan or symlink target.

- [ ] **Step 3: Run the release-builder tests and confirm old triplet behavior fails**

```bash
npm test -- tests/companion-installer.test.ts
```

Expected: FAIL because the current builder has no release identity or public manifest and accepts no release SHA.

- [ ] **Step 4: Parse tracked release metadata and embed sealed app facts**

Read exactly four newline-terminated lines including the `version=1` header, reject any extra line, validate each value, and verify clean Git `HEAD`. Render the `Info.plist` identity before signing. After signing, validate all architectures, notarize, staple, validate the staple, verify again, and only then create the distribution ZIP. Keep `--sequesterRsrc` only on the temporary notarization upload; build the distributed ZIP without it so the strict updater archive has one app root and no `__MACOSX` sidecar.

- [ ] **Step 5: Generate the canonical public manifest after ZIP hashing**

Write compact sorted JSON ending in one newline:

```json
{"companion_version":"0.2.0","manifest_version":1,"release_sequence":1,"release_sha":"<exact release SHA>","update_protocol_version":1,"zip_sha256":"<exact ZIP digest>","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}
```

Use the actual release SHA and digest, not literal angle-bracket text. Re-read and validate it before beginning the final output transaction.

- [ ] **Step 6: Strengthen first-install identity checks**

Before enrollment or replacement, `install.sh` must use `/usr/bin/plutil` to require the candidate bundle ID, rendered version, release sequence, release SHA, and protocol to equal the rendered installer contract. Continue strict designated-requirement verification and existing rollback semantics. Do not make the installer fetch or execute the public manifest.

- [ ] **Step 7: Run builder, installer, and shell syntax tests**

```bash
bash -n scripts/release/build-runtime-raiders-agent.sh
sh -n companion/packaging/install.sh
npm test -- tests/companion-installer.test.ts
```

Expected: PASS with a four-file local transaction and no publication command in the build log.

- [ ] **Step 8: Commit the signed-build unit**

```bash
git add scripts/release/build-runtime-raiders-agent.sh companion/packaging/install.sh tests/companion-installer.test.ts
git commit -m "build(raiders): seal update release metadata"
```

---

### Task 8: Publish the monotonic manifest through the existing atomic selector

**Files:**
- Modify: `scripts/pi/runtime-raiders-artifacts.sh:1-434`
- Modify: `tests/runtime-raiders-artifacts.test.ts:1-987`
- Modify: `deploy/Caddyfile:1-41`
- Modify: `tests/deploy-runtime-raiders.test.ts:52-85`
- Modify: `scripts/pi/runtime-raiders-preflight.sh:193-203,386-405`
- Modify: `tests/runtime-raiders-preflight.test.ts`

**Interfaces:**
- Consumes: signed local quartet and public manifest from Task 7.
- Produces: backward-compatible v1 status, immutable v2 release directories, monotonic sequence enforcement, and one literal JSON route.

- [ ] **Step 1: Extend the artifact fixture and write failing v2 publication tests**

The source fixture must contain exactly four files. Add tests that require:

- `--release-sequence`, `--companion-version`, and `--update-manifest-sha256` exactly once;
- exact public manifest fields matching CLI arguments and ZIP bytes;
- release sequence greater than every valid v2 release already stored, including withdrawn releases;
- sequence reuse and downgrade rejection;
- v1 existing-release status remains readable;
- v2 status prints sequence, version, protocol, and manifest digest;
- immutable v2 directories contain three download files and one private manifest; and
- any public/private manifest mismatch leaves `current` unchanged; and
- a failed bounded public re-fetch of the selected ZIP or JSON restores the prior selector (or removes the first selector) while retaining the immutable release for diagnosis.

- [ ] **Step 2: Run artifact tests and confirm the old v1 triplet contract fails**

```bash
npm test -- tests/runtime-raiders-artifacts.test.ts
```

Expected: FAIL because publish currently accepts only three digests and two download files.

- [ ] **Step 3: Implement backward-compatible root manifest validation**

Keep accepting existing private version-1 manifests with the current three digests and exact old layout. Create new releases only with private manifest version `2`:

```text
version=2
release_sha=<40 lowercase hex>
release_sequence=<positive safe integer>
companion_version=<bounded ASCII version>
update_protocol_version=1
installer_sha256=<64 lowercase hex>
zip_sha256=<64 lowercase hex>
checksum_sha256=<64 lowercase hex>
update_manifest_sha256=<64 lowercase hex>
```

Validate all stored v2 sequences before selecting a new release. A damaged v2 release makes publication fail closed rather than being skipped.

- [ ] **Step 4: Stage and select the complete immutable v2 directory**

Copy the public manifest to `downloads/runtime-raiders-agent.update.json` with root ownership and mode `0644`. Recalculate all four digests and cross-check public JSON against the private v2 manifest before renaming the complete directory and atomically replacing `current`.

- [ ] **Step 5: Re-fetch the selected public ZIP and manifest before committing publication**

After selector replacement, use `/usr/bin/curl` without redirects against only the two compiled `https://raiders.redlattice.com/downloads/...` URLs. Apply HTTPS-only, fail-on-HTTP-error, 30-second timeout, 128 MiB ZIP, and 64 KiB JSON bounds; download into an owner-only temporary directory. Recalculate both digests, strictly decode the JSON, and compare every public field to the private v2 manifest. On any failure, atomically restore the previous relative selector or remove the first selector, retain the immutable release directory for diagnosis, and exit nonzero.

- [ ] **Step 6: Add the exact Caddy JSON handler and update its contract tests**

Add before the matcherless fallback:

```caddyfile
handle /downloads/runtime-raiders-agent.update.json {
	header Cache-Control "no-store"
	header X-Content-Type-Options "nosniff"
	header Content-Type "application/json; charset=utf-8"
	root * /var/lib/runtime-raiders/current
	file_server
}
```

Require exactly four literal file handlers, four file servers, four `no-store` headers, no wildcard route, and no directory browsing.

- [ ] **Step 7: Extend fresh preflight's unpublished route set**

Add the manifest path to the exact 404 loop and its fake curl matcher. Retain the initial-cutover requirement that `current` is absent; this does not redefine an already-completed production cutover.

- [ ] **Step 8: Run publication, Caddy, and preflight tests**

```bash
bash -n scripts/pi/runtime-raiders-artifacts.sh
bash -n scripts/pi/runtime-raiders-preflight.sh
npm test -- tests/runtime-raiders-artifacts.test.ts tests/deploy-runtime-raiders.test.ts tests/runtime-raiders-preflight.test.ts
```

Expected: PASS for v1 compatibility, monotonic v2 publication, public re-fetch rollback, and exactly four fixed routes.

- [ ] **Step 9: Commit the publication unit**

```bash
git add scripts/pi/runtime-raiders-artifacts.sh tests/runtime-raiders-artifacts.test.ts deploy/Caddyfile tests/deploy-runtime-raiders.test.ts scripts/pi/runtime-raiders-preflight.sh tests/runtime-raiders-preflight.test.ts
git commit -m "feat(raiders): publish monotonic update manifests"
```

---

### Task 9: Update operations, privacy gates, and the two-sequence canary record

**Files:**
- Create: `docs/runtime-raiders/companion-update-canary.md`
- Modify: `docs/runtime-raiders/companion-operations.md:1-171`
- Modify: `docs/runtime-raiders/canary-checklist.md`
- Modify: `docs/runtime-raiders/cutover-authorization-packet.md`
- Modify: `docs/RUNTIME_RAIDERS_CUTOVER.md`
- Modify: `docs/superpowers/specs/2026-08-03-runtime-raiders-caddy-publication-design.md`
- Modify: `tests/runtime-raiders-publication-docs.test.ts:1-166`

**Interfaces:**
- Consumes: completed CLI/build/publication behavior.
- Produces: exact operator instructions and separate approvals for Caddy, publication, installed-off update canary, live provider canary, and office activation.

- [ ] **Step 1: Write failing documentation contract tests**

Change the expected URL set to four and require all operational documents to name:

```text
runtime-raiders-agent.update.json
--release-sequence "$RELEASE_SEQUENCE"
--companion-version "$COMPANION_VERSION"
--update-manifest-sha256 "$UPDATE_MANIFEST_SHA256"
raiders update
```

Require separate ordered gates for first updater-capable install, second-sequence publication, manual update, live Desktop/CLI classification, and office activation. Reject any instruction that pipes the update manifest, ZIP, or installer to a shell for the canary.

Treat routine onboarding and controlled validation as different contracts: the routine office-install section must retain the single-line fixed-origin `curl .../install.sh | /bin/sh` command, while the installed-off canary must download, verify the recorded installer SHA-256, and execute the local file. This exact documentation contract is an intentional product and security gate approved by the user; it prevents either path from silently replacing the other.

- [ ] **Step 2: Run documentation tests and verify the old triplet language fails**

```bash
npm test -- tests/runtime-raiders-publication-docs.test.ts
```

Expected: FAIL on three-file, 3/3, signed-triplet, and missing manual-update language.

- [ ] **Step 3: Update build and publication operations**

Document the signed quartet, exact four digests, tracked `companion/RELEASE`, immutable v1/v2 behavior, manifest headers, withdrawal, and recovery. State explicitly that discovery works while collection is off and sends an anonymous static GET only to the trusted game server.

Document the three installation lifecycles without conflating them: routine new-player onboarding uses the one-line installer pipe after all rollout gates pass, the controlled first canary uses a locally downloaded and digest-verified installer, and already-installed players use only `raiders update`.

- [ ] **Step 4: Write the two-sequence canary document**

The record must require aggregate status/timestamps only and this exact order:

1. build/sign/notarize/staple sequence 1 from its exact clean SHA;
2. separately approve Caddy route preparation and sequence-1 publication;
3. install sequence 1 with collection persistently off;
4. commit `companion/RELEASE` version `0.2.1`, sequence `2`, producing a new SHA;
5. rebuild/review/sign and separately approve sequence-2 publication;
6. observe one notification and matching `raiders status` availability;
7. run `raiders update` manually and verify signing, version, sequence, daemon health, disabled state, enrollment, cursors, and outbox;
8. confirm no second notification for sequence 2;
9. separately authorize a bounded `raiders on` canary;
10. complete one official Codex Desktop root Run and one Codex CLI root Run;
11. verify `codex_desktop` and `codex_cli`, content-free storage, Raid Power, model, and effort; and
12. run `raiders off` before seeking separate office activation.

Do not place prompts, responses, record paths, native IDs, tokens, credentials, or provider fragments in the record.

- [ ] **Step 5: Run docs, brand, and publication suites**

```bash
npm test -- tests/runtime-raiders-publication-docs.test.ts tests/brand-copy.test.ts tests/provider-shape-audit.test.ts
```

Expected: PASS with four-route terminology and no unsupported-provider claim.

- [ ] **Step 6: Commit operational documentation**

```bash
git add docs/runtime-raiders/companion-update-canary.md docs/runtime-raiders/companion-operations.md docs/runtime-raiders/canary-checklist.md docs/runtime-raiders/cutover-authorization-packet.md docs/RUNTIME_RAIDERS_CUTOVER.md docs/superpowers/specs/2026-08-03-runtime-raiders-caddy-publication-design.md tests/runtime-raiders-publication-docs.test.ts
git commit -m "docs(raiders): add manual update release gates"
```

---

### Task 10: Complete verification and independent review before any release action

**Files:**
- Modify only if a concrete review finding requires a test-backed correction.

**Interfaces:**
- Consumes: Tasks 1-9.
- Produces: a clean, reviewed implementation branch; it does not authorize merge, publication, installation, or collection.

- [ ] **Step 1: Run syntax and formatting safety checks**

```bash
bash -n scripts/release/build-runtime-raiders-agent.sh
bash -n scripts/pi/runtime-raiders-artifacts.sh
bash -n scripts/pi/runtime-raiders-preflight.sh
sh -n companion/packaging/install.sh
git diff --check
```

Expected: all commands exit `0` with no output from `git diff --check`.

- [ ] **Step 2: Run the complete companion suite**

```bash
cd companion
swift test --quiet
```

Expected: all Swift tests PASS with no real notification, provider invocation, installed-app mutation, or production network request.

- [ ] **Step 3: Run server typecheck and the complete Node suite**

```bash
npm run typecheck
npm test -- --reporter=dot
```

Expected: TypeScript exits `0`; every Vitest file passes with the existing ignored licensed assets present locally.

- [ ] **Step 4: Perform privacy and network trap review**

Search the diff and tests for every outbound request constructor and every newly persisted/printed type. Confirm the only new network destination is the exact static manifest/ZIP origin, the manifest request is anonymous, diagnostics contain enums only, and no provider record text enters update state, status, doctor, logs, or outbox.

- [ ] **Step 5: Request independent code review**

Use `superpowers:requesting-code-review` against the full branch diff. Require review of:

- same-shaped Codex drift and fail-closed behavior;
- snapshot/state backward compatibility;
- TOCTOU boundaries around ZIP validation, signature verification, and rename;
- active-Run double-check and daemon quiescence;
- rollback failure preservation;
- sequence monotonicity across withdrawn releases;
- v1 production release compatibility; and
- content-free network/status/doctor behavior.

- [ ] **Step 6: Resolve every accepted finding test-first**

For each finding, add one focused failing regression, run it to confirm the failure, make the smallest correction, rerun the focused suite, then rerun Steps 1-3. Do not change production state during review.

- [ ] **Step 7: Commit review corrections if the diff changed**

Start this step only from the clean state proven after Task 9. Add each
regression to an existing test file, then commit all tracked review corrections:

```bash
git status --short
git commit -am "fix(raiders): address update workflow review"
```

If review produces no code change, record that fact in the task handoff instead of creating an empty commit.

- [ ] **Step 8: Verify final branch state**

```bash
git status --short --branch
git log --oneline --decorate -12
```

Expected: the worktree is clean and every implementation unit has a reviewable commit after the approved design and plan commits.

---

## Post-implementation release gates

These gates are intentionally outside implementation authorization:

1. Review and explicitly authorize branch integration.
2. Merge while preserving a clean, exact release SHA.
3. Build, sign, notarize, staple, and record the sequence-1 quartet.
4. With the game paused, separately authorize and deploy the reviewed Caddy/publication changes with rollback armed.
5. Separately authorize sequence-1 publication and installed-off canary installation.
6. Create and review the sequence-2 release metadata commit; rebuild and separately authorize publication.
7. Run the manual update canary and record only the approved aggregate evidence.
8. Separately authorize live Codex Desktop and CLI scoring validation.
9. Turn the canary back off and review results.
10. Let the user decide when to authorize office activation.

No implementation, merge, build, Caddy change, publication, installation, notification, or successful update implies `raiders on`.

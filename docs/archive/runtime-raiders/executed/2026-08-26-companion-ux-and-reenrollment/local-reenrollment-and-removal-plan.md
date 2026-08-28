# Runtime Raiders Local Re-enrollment and Removal Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resumable `raiders re-enroll`, recoverable `raiders uninstall`, and fail-closed `raiders uninstall --everything` commands around the approved server credential lifecycle.

**Architecture:** Put credential/network, journal, queue, and filesystem mutation behind small `RuntimeRaidersCore` components with injected operations. A journaled coordinator owns the re-enrollment phase machine; a separate removal coordinator owns revocation proof and descriptor-relative deletion. The CLI owns only command routing, TTY capability, private prompts, and content-free presentation.

**Tech Stack:** Swift 6, Foundation, Security, Darwin/POSIX file descriptors and `flock`, ServiceManagement, XCTest, POSIX shell, Zsh, Vitest.

**Spec:** [`design.md`](design.md)

**Depends on:** [`command-ux-plan.md`](command-ux-plan.md) and
[`server-credential-lifecycle-plan.md`](server-credential-lifecycle-plan.md).

## Global Constraints

- Re-enrollment requires collection already off; it never turns collection on.
- Browser login never retargets the installed device.
- Queued events are delivered to the old/current Raider, explicitly discarded, or left untouched on cancel; they are never transferred.
- Enrollment codes are read privately from `/dev/tty`, never placed in argv/environment, and never written to disk.
- Replacement tokens are generated locally with 32 cryptographically random bytes, base64url encoded to exactly 43 characters, and persisted only in a `0600` owner-only journal.
- A successful re-enrollment proves the replacement token active, installs configuration atomically, resets collector state to disabled/empty, and re-registers the managed agent.
- Ordinary uninstall removes executable/background artifacts and preserves enrollment, collector state, cursors, outbox, and recovery journal.
- `uninstall --everything` records confirmation, proves server revocation, then removes only Runtime Raiders-owned local artifacts.
- No code follows symlinks or relies on path-string validation for destructive operations.
- Never delete Codex sessions, `.codex`, unrelated LaunchAgents, unrelated command files, Raiders, accounts, Runs, scores, rewards, or beta history.
- Do not create/publish a release, bump a version, deploy endpoints, change production, or enable collection.

---

## File map

- `companion/Sources/RuntimeRaidersCore/CompanionLifecyclePaths.swift`: exact owned path inventory rooted at a supplied home directory.
- `companion/Sources/RuntimeRaidersCore/RecoveryJournal.swift`: versioned journal model/store and lifecycle lock.
- `companion/Sources/RuntimeRaidersCore/AgentController.swift`: atomic enrollment writer and disabled/empty collector-state reset.
- `companion/Sources/RuntimeRaidersCore/EnrollmentClient.swift`: strict lifecycle HTTP client and secure credential generation.
- `companion/Sources/RuntimeRaidersCore/Outbox.swift`: validated discard-all operation.
- `companion/Sources/RuntimeRaidersCore/OneShotOutboxDelivery.swift`: synchronous bounded queue drain with existing upload wire format.
- `companion/Sources/RuntimeRaidersCore/ReEnrollmentCoordinator.swift`: resumable phase machine.
- `companion/Sources/RuntimeRaidersCore/OwnedInstallationRemover.swift`: descriptor-relative, no-follow installation deletion.
- `companion/Sources/RuntimeRaidersCore/RemovalCoordinator.swift`: preserve/everything removal workflows.
- `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`: public lifecycle command routes.
- `companion/Sources/RuntimeRaidersCLI/main.swift`: private TTY prompts and live component wiring.
- Corresponding files under `companion/Tests/RuntimeRaidersCoreTests/`: focused unit/integration tests.
- `companion/packaging/install.sh`, `tests/companion-installer.test.ts`: preserved-state reinstall contract.
- `docs/runtime-raiders/employee-beta.md`, `docs/runtime-raiders/companion-operations.md`, `docs/BACKLOG.md`: supported employee/operator procedure.

### Task 1: Add lifecycle paths, lock, journal, and atomic configuration writes

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/CompanionLifecyclePaths.swift`
- Create: `companion/Sources/RuntimeRaidersCore/RecoveryJournal.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/AgentController.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/RecoveryJournalTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`

**Interfaces:**
- Produces: `CompanionLifecyclePaths`, `LifecycleLock`, `RecoveryJournal`, `RecoveryJournalStore`, `EnrollmentConfiguration.persist`, and `AgentController.resetForReEnrollment`.
- Reuses: `OwnerOnlyDirectory` and descriptor form of `AtomicStore.write`.

- [ ] **Step 1: Write failing exact-path tests**

Given `/Users/test`, assert:

```swift
let paths = CompanionLifecyclePaths(homeDirectory: URL(fileURLWithPath: "/Users/test"))
XCTAssertEqual(paths.agent.supportDirectory.path,
               "/Users/test/Library/Application Support/Runtime Raiders")
XCTAssertEqual(paths.supportShim.path,
               "/Users/test/Library/Application Support/Runtime Raiders/raiders")
XCTAssertEqual(paths.commandShim.path, "/Users/test/.local/bin/raiders")
XCTAssertEqual(paths.legacyPlist.path,
               "/Users/test/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist")
XCTAssertEqual(paths.enrollment.path,
               "/Users/test/Library/Application Support/Runtime Raiders/state/enrollment.json")
XCTAssertEqual(paths.recoveryJournal.lastPathComponent, "re-enrollment.json")
XCTAssertEqual(paths.lifecycleLock.lastPathComponent, "lifecycle.lock")
```

Reject non-file URLs, non-absolute homes, and roots whose standardized path differs from the input.

- [ ] **Step 2: Write failing journal and lock tests**

Use this exact model:

```swift
public enum ReEnrollmentPhase: String, Codable, Sendable {
    case replacementPrepared
    case serverCommitted
    case configurationInstalled
    case collectorReset
    case agentRegistered
}

public enum RecordedQueueDisposition: String, Codable, Sendable {
    case delivered
    case discarded
    case empty
}

public struct RecoveryJournal: Codable, Equatable, Sendable {
    public let version: Int
    public let operationID: UUID
    public let replacementDeviceID: UUID
    public let replacementDeviceToken: String
    public let companionVersion: String
    public let queueDisposition: RecordedQueueDisposition
    public var phase: ReEnrollmentPhase
}
```

Assert round-trip exact keys, mode `0600`, parent mode `0700`, atomic replacement, persistence across a simulated crash, rejection of extra/missing keys, bad version, invalid token, symlink file/parent, wrong owner/mode/type, oversized data, and a directory swap after open. Assert two `LifecycleLock.acquire` calls cannot overlap and release permits a later acquisition.

- [ ] **Step 3: Write failing enrollment-persist and collector-reset tests**

Construct `EnrollmentConfiguration` through a new public initializer, persist it, load it with `loadExisting`, and assert exact equality and `0600` mode. Seed an enabled collector state containing cursors/snapshots, call:

```swift
try AgentController.resetForReEnrollment(paths: paths, surfaces: [.codexCLI, .codexDesktop])
```

and assert `persistedCollectorState` is `.disabled`, active adapter facts are empty, the outbox and enrollment are unchanged, and update state is unchanged. Add symlink/path-swap rejection.

- [ ] **Step 4: Run focused Swift tests and verify RED**

Run: `cd companion && swift test --filter RecoveryJournalTests && swift test --filter AgentControllerTests`

Expected: FAIL because lifecycle paths, journal, writer, and reset APIs do not exist.

- [ ] **Step 5: Implement descriptor-relative stores**

Implement:

```swift
public struct RecoveryJournalStore: Sendable {
    public init(paths: CompanionLifecyclePaths)
    public func load() throws -> RecoveryJournal?
    public func write(_ journal: RecoveryJournal) throws
    public func remove() throws
}

public final class LifecycleLock: @unchecked Sendable {
    public static func acquire(at url: URL) throws -> LifecycleLock
}
```

Open the verified state directory once; use `openat(...O_NOFOLLOW|O_CLOEXEC)`, `fstat`, and descriptor-relative `AtomicStore`. Journal decoding requires the exact JSON key set and validates version 1, UUIDs, version length `1...100`, token regex `^[A-Za-z0-9_-]{43}$`, owner, `0600`, one link, and maximum 16 KiB. Use nonblocking `flock(LOCK_EX | LOCK_NB)` so concurrent lifecycle operations fail immediately with a content-free busy error.

- [ ] **Step 6: Implement enrollment persistence and reset**

Add a public validated initializer and:

```swift
public func persist(to file: URL) throws
```

Serialize the same version-1 wire keys accepted by `loadExisting`, using lowercase hex dedupe secret and sorted enabled-surface values. `resetForReEnrollment` atomically writes a version-1 collector state with `enabled: false`, `files: [:]`, and empty deferred seed paths through an already verified state descriptor.

- [ ] **Step 7: Run tests and commit the storage foundation**

Run: `cd companion && swift test --filter RecoveryJournalTests && swift test --filter AgentControllerTests && swift test --filter ControlProtocolTests`

```bash
git add companion/Sources/RuntimeRaidersCore/CompanionLifecyclePaths.swift companion/Sources/RuntimeRaidersCore/RecoveryJournal.swift companion/Sources/RuntimeRaidersCore/AgentController.swift companion/Tests/RuntimeRaidersCoreTests/RecoveryJournalTests.swift companion/Tests/RuntimeRaidersCoreTests/AgentControllerTests.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift
git commit -m "feat(raiders): add lifecycle recovery storage"
```

### Task 2: Add the strict lifecycle HTTP client and secure credentials

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/EnrollmentClient.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/EnrollmentClientTests.swift`

**Interfaces:**
- Consumes: server routes from the server credential lifecycle plan and `UploadHTTPResponse`/bounded transport behavior from `Uploader.swift`.
- Produces: `EnrollmentClient`, `ReplacementMaterial`, `RecoveredEnrollment`, `ReplacementHTTPResult`, and `SecureCredentialGenerator`.

- [ ] **Step 1: Write failing request-shape and redaction tests**

With an injected transport, capture requests and assert:

```swift
XCTAssertEqual(request.httpMethod, "POST")
XCTAssertEqual(request.url?.path, "/api/raiders/re-enroll")
XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(oldToken)")
XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
```

Decode the body and require exactly `code`, `operation_id`, `replacement_device_id`, `replacement_device_token`, and `companion_version`. Add exact GET `/api/raiders/enrollment-config` and POST `/api/raiders/devices/revoke-current` `{}` request tests. Assert a thrown/printed error's description never contains old token, new token, code, device IDs, response body, or URL query.

- [ ] **Step 2: Write failing strict-response and secure-random tests**

Accept only 200/201 replacement and 200 recovery responses with exactly:

```json
{"device_id":"11111111-1111-4111-8111-111111111111","dedupe_secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","server_url":"https://raiders.redlattice.com","cutover_at":1780000000000,"enabled_surfaces":["codex_cli","codex_desktop"]}
```

Reject extra keys, wrong types, nonproduction origin outside test mode, malformed UUID/hex, duplicate/unsupported/empty surfaces, unsafe epoch, oversized response, redirects, and unexpected status. Map 401 invalid enrollment, 401 unauthorized, and 409 conflict to distinct content-free enum cases.

Generate 256 credentials and assert every token is 43-character base64url, every device/operation ID is a valid distinct UUID, and no token repeats.

- [ ] **Step 3: Run client tests and verify RED**

Run: `cd companion && swift test --filter EnrollmentClientTests`

Expected: FAIL because the client and generator do not exist.

- [ ] **Step 4: Implement the injected client**

Use these interfaces:

```swift
public struct ReplacementMaterial: Equatable, Sendable {
    public let operationID: UUID
    public let deviceID: UUID
    public let deviceToken: String
}

public struct RecoveredEnrollment: Equatable, Sendable {
    public let deviceID: String
    public let dedupeSecret: Data
    public let serverURL: URL
    public let cutoverAtMS: Int64
    public let enabledSurfaces: [RunSurface]
}

public enum ReplacementHTTPResult: Equatable, Sendable {
    case committed(RecoveredEnrollment)
    case invalidEnrollment
    case unauthorized
    case conflict
    case ambiguous
}

public struct EnrollmentClient: Sendable {
    public typealias Transport = @Sendable (URLRequest) throws -> UploadHTTPResponse
    public func replace(oldToken: String, code: String, material: ReplacementMaterial,
                        companionVersion: String) -> ReplacementHTTPResult
    public func recover(token: String) throws -> RecoveredEnrollment?
    public func revoke(token: String) throws -> Bool
}
```

`recover` returns `nil` only for 401; `revoke` returns true only for HTTP 200 exact body `{ "revoked": true }`. Transport errors and 5xx replacement responses become `.ambiguous`; strict response corruption throws and does not guess.

- [ ] **Step 5: Implement secure generation**

Use `SecRandomCopyBytes(kSecRandomDefault, 32, ...)`, then base64url encode by removing `=` and replacing `+`/`/` with `-`/`_`. No fallback PRNG is allowed. Return UUIDs from an injected UUID generator in tests and `UUID()` live.

- [ ] **Step 6: Run tests and commit the client**

Run: `cd companion && swift test --filter EnrollmentClientTests && swift test`

```bash
git add companion/Sources/RuntimeRaidersCore/EnrollmentClient.swift companion/Tests/RuntimeRaidersCoreTests/EnrollmentClientTests.swift
git commit -m "feat(raiders): add enrollment lifecycle client"
```

### Task 3: Add validated queue discard and bounded one-shot delivery

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/Outbox.swift`
- Create: `companion/Sources/RuntimeRaidersCore/OneShotOutboxDelivery.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/Uploader.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/OutboxTests.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/OneShotOutboxDeliveryTests.swift`

**Interfaces:**
- Produces: `Outbox.discardAllValidated() -> Int` and `OneShotOutboxDelivery.drain() throws -> Int`.
- Reuses: the exact current `/api/runs/events` batch encoding, limits, status validation, and acknowledgment semantics.

- [ ] **Step 1: Write failing discard tests**

Enqueue three canonical events, call discard, assert return 3, count 0, and directory fsync. Assert a malformed owned `64hex.json`, symlink, hard-linked record, wrong-owner/mode record, directory swap, or canonical-name/content mismatch causes an error before any canonical record is removed. An unrelated non-owned filename remains untouched and is not counted.

- [ ] **Step 2: Write failing delivery tests**

Seed 205 events and an injected transport. Assert drain sends batches `100, 100, 5`, acknowledges only after each 2xx response, returns 205, leaves collection state/heartbeat untouched, and sends the old device bearer. On failure in batch two, assert batch one is gone and 105 records remain. Reject a malformed record before the first request.

- [ ] **Step 3: Run queue tests and verify RED**

Run: `cd companion && swift test --filter OutboxTests && swift test --filter OneShotOutboxDeliveryTests`

Expected: FAIL because explicit discard/drain APIs do not exist.

- [ ] **Step 4: Implement fail-before-delete validation**

Under the existing outbox lock, enumerate every owned record name, open with `O_NOFOLLOW`, require regular file, effective-user owner, mode `0600`, link count 1, bounded size, canonical decode/re-encode equality, and filename equality. Build the complete validated array first; only then unlink each name and fsync. Return the validated count.

- [ ] **Step 5: Extract and reuse upload batch construction**

Move current private batch-body/request/status validation into internal `UploadBatchWire` helpers used unchanged by both `Uploader` and `OneShotOutboxDelivery`. The one-shot loop calls `records(limit: 100)`, sends synchronously with the configured bearer and production origin, acknowledges only on accepted status, and stops when empty. It creates no watcher, activation coordinator, scheduler, or heartbeat.

- [ ] **Step 6: Run queue/uploader tests and commit**

Run: `cd companion && swift test --filter OutboxTests && swift test --filter OneShotOutboxDeliveryTests && swift test --filter UploaderTests`

```bash
git add companion/Sources/RuntimeRaidersCore/Outbox.swift companion/Sources/RuntimeRaidersCore/OneShotOutboxDelivery.swift companion/Sources/RuntimeRaidersCore/Uploader.swift companion/Tests/RuntimeRaidersCoreTests/OutboxTests.swift companion/Tests/RuntimeRaidersCoreTests/OneShotOutboxDeliveryTests.swift companion/Tests/RuntimeRaidersCoreTests/UploaderTests.swift
git commit -m "feat(raiders): resolve queued events explicitly"
```

### Task 4: Implement the resumable re-enrollment coordinator

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/ReEnrollmentCoordinator.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ReEnrollmentCoordinatorTests.swift`

**Interfaces:**
- Consumes: Tasks 1-3 plus `ManagedAgentServiceController`.
- Produces: `QueueDisposition`, `ReEnrollmentOutcome`, `ReEnrollmentOperations`, and `ReEnrollmentCoordinator.run()`.

- [ ] **Step 1: Write failing happy-path state-machine tests**

Define:

```swift
public enum QueueDisposition: Equatable, Sendable { case deliver, discard, cancel }
public enum ReEnrollmentOutcome: Equatable, Sendable {
    case completed
    case cancelled
    case collectionMustBeOff
    case invalidEnrollment
    case recoveryRequired
}
```

Inject operations that append action names. For empty, deliver, and discard paths assert exact ordering:

```text
lock, read-old-config, prove-off, unregister, count-queue,
summarize, confirm-re-enroll, resolve-queue,
create-journal(replacementPrepared), request-code,
replace, journal(serverCommitted), persist-new-config,
journal(configurationInstalled), reset-collector,
journal(collectorReset), register, journal(agentRegistered),
verify-new-config-and-off, delete-journal
```

Assert code is requested only after queue resolution; cancel does not request a
code or mutate enrollment, re-registers the managed agent, and remains off.
Invalid/expired/consumed code removes the uncommitted prepared journal,
re-registers the agent, preserves the old enrollment, and remains off.
Successful result remains disabled.

- [ ] **Step 2: Write failing interruption and ambiguity matrix tests**

After every action boundary, throw a simulated crash, construct a new coordinator over the persisted journal, and resume. Assert:

- before server commit, old config/token remain active and code is requested again;
- ambiguous replacement probes the new token with bounded delays `100, 250, 500, 1000` milliseconds;
- a recovered new token skips old replacement and advances local commit;
- if new is unauthorized and old is active, outcome is `invalidEnrollment` and a later invocation can request a fresh code;
- if neither proves coherent, outcome is `recoveryRequired`, journal remains, agent remains unregistered, and collection remains off;
- after configuration install, resume never restores old enrollment;
- journal deletion occurs only after final verification.

Also assert exact old-token rejection/new-token acceptance through injected server state and same-Raider/different-Raider dedupe secrets.

- [ ] **Step 3: Run coordinator tests and verify RED**

Run: `cd companion && swift test --filter ReEnrollmentCoordinatorTests`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 4: Implement injected operations and phase advancement**

Use a single operations value containing typed closures for lock, status, managed service, queue count/choice/delivery/discard, code prompt, material generation, journal load/write/remove, replace/recover, enrollment persist/load, collector reset, delays, and verification. The live initializer composes the concrete components; tests use closures only.

On entry, if a valid journal exists, resume its phase before offering a new operation. Without a journal, prove `.disabled`, unregister and verify the agent, resolve queue, then generate material and durably journal `replacementPrepared`. Never store the enrollment code. Every phase write happens after the action named by that phase is durable.

- [ ] **Step 5: Implement ambiguous recovery without guessing**

For `.ambiguous`, call recovery with the journaled replacement token at each bounded delay. A valid response means server commit. If all probes return unauthorized, probe the old token through configuration recovery: active old means the transaction did not commit and the journal may be removed after preserving off state; neither token active means keep the journal and return `.recoveryRequired`. Network errors keep the journal and return `.recoveryRequired`.

- [ ] **Step 6: Run coordinator tests and commit**

Run: `cd companion && swift test --filter ReEnrollmentCoordinatorTests && swift test`

```bash
git add companion/Sources/RuntimeRaidersCore/ReEnrollmentCoordinator.swift companion/Tests/RuntimeRaidersCoreTests/ReEnrollmentCoordinatorTests.swift
git commit -m "feat(raiders): coordinate resumable re-enrollment"
```

### Task 5: Implement descriptor-relative preserve and complete removal

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/OwnedInstallationRemover.swift`
- Create: `companion/Sources/RuntimeRaidersCore/RemovalCoordinator.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/OwnedInstallationRemoverTests.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/RemovalCoordinatorTests.swift`

**Interfaces:**
- Consumes: lifecycle paths/lock, managed service, enrollment client, and outbox from earlier tasks.
- Produces: `RemovalMode`, `OwnedInstallationRemover.removeExecutableArtifacts`, `removeAllArtifacts`, and `RemovalCoordinator.run(mode:)`.

- [ ] **Step 1: Write failing safe-removal tests**

Build a temporary home with the exact app, support shim, command symlink, state, outbox, socket, legacy plist, and obsolete owned directories. For preserve mode assert removal of app, support shim, exact command symlink, socket, legacy plist, `releases`, `installation`, and `launcher`, while enrollment, collector state/cursors, outbox records, recovery journal, state/outbox directories, and parent support directory remain byte-identical.

For complete mode assert the full support directory and exact command symlink are absent after revocation authorization. In both modes create unrelated siblings in `.local/bin`, `Library/LaunchAgents`, `Application Support`, and `.codex/sessions`; assert byte-identical fingerprints.

- [ ] **Step 2: Write failing attack and idempotency tests**

Independently replace support, state, outbox, app, shim, command, or plist with a symlink; swap a directory after validation; add a hard-linked secret; change owner/mode in injectable metadata tests; cross a device boundary; add an unexpected top-level support entry. Assert no removal begins. Assert a command symlink pointing anywhere except the exact support shim is rejected, not unlinked. Assert a second call after successful removal is success.

- [ ] **Step 3: Write failing coordinator-order tests**

For ordinary uninstall assert:

```text
lock, persist-off, stop-daemon, unregister, verify-unregistered,
remove-executable-artifacts, verify-preserved-state
```

For `--everything` with a queue assert:

```text
lock, persist-off, stop-daemon, unregister, verify-unregistered,
summarize, confirm-discard, confirm-everything, revoke, verify-revoked,
discard-queue, remove-all-artifacts
```

Network/auth/ambiguous revocation failure must occur before queue discard or file deletion. Missing enrollment skips revocation only when the verified enrollment path is absent, not corrupt. A corrupt present enrollment returns assisted-recovery failure with no deletion.

- [ ] **Step 4: Run removal tests and verify RED**

Run: `cd companion && swift test --filter OwnedInstallationRemoverTests && swift test --filter RemovalCoordinatorTests`

Expected: FAIL because removers and coordinators do not exist.

- [ ] **Step 5: Implement no-follow tree deletion**

Open verified parent directories and retain descriptors. At the support top level accept only:

```text
Runtime Raiders.app, raiders, state, outbox, agent.sock,
releases, installation, launcher
```

Preserve mode never opens state/outbox for deletion. Complete mode recursively enumerates by descriptor, rejects symlinks and device/owner changes, requires regular files to have one link, descends with `openat(O_DIRECTORY|O_NOFOLLOW)`, removes files with `unlinkat`, and directories with `unlinkat(...AT_REMOVEDIR)` after children. Validate state/outbox names against known fixed files, journal/temporary-file grammar, and canonical 64-hex outbox records before deleting. The signed app tree may contain arbitrary names but every node must remain on the opened device, be owned by the effective user, and contain no symlink.

- [ ] **Step 6: Implement removal coordination**

Use:

```swift
public enum RemovalMode: Equatable, Sendable { case preserveState, everything }
public enum RemovalOutcome: Equatable, Sendable {
    case removedPreservingState
    case removedEverything
    case cancelled
    case revocationRequired
    case assistedRecoveryRequired
}
```

In everything mode, record confirmations in memory only, call `EnrollmentClient.revoke`, and on an ambiguous error call it again with bounded recovery attempts; the endpoint's idempotent response is revocation proof. Only then call `discardAllValidated` and `removeAllArtifacts`.

- [ ] **Step 7: Run removal tests and commit**

Run: `cd companion && swift test --filter OwnedInstallationRemoverTests && swift test --filter RemovalCoordinatorTests && swift test`

```bash
git add companion/Sources/RuntimeRaidersCore/OwnedInstallationRemover.swift companion/Sources/RuntimeRaidersCore/RemovalCoordinator.swift companion/Tests/RuntimeRaidersCoreTests/OwnedInstallationRemoverTests.swift companion/Tests/RuntimeRaidersCoreTests/RemovalCoordinatorTests.swift
git commit -m "feat(raiders): add bounded companion removal"
```

### Task 6: Wire interactive CLI commands without leaking secrets

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift`

**Interfaces:**
- Consumes: command UX plan and coordinators from Tasks 4-5.
- Produces: `.reEnroll`, `.uninstall(.preserveState)`, and `.uninstall(.everything)` routes plus private `/dev/tty` prompts.

- [ ] **Step 1: Write failing route and TTY tests**

Assert:

```swift
XCTAssertEqual(route(["re-enroll"]), .reEnroll)
XCTAssertEqual(route(["uninstall"]), .uninstall(.preserveState))
XCTAssertEqual(route(["uninstall", "--everything"]), .uninstall(.everything))
XCTAssertNil(route(["re-enroll", "CODE"]))
XCTAssertNil(route(["uninstall", "--all"]))
```

Captured/non-TTY invocations of re-enroll and everything exit nonzero before state/network operations. Ordinary uninstall remains noninteractive.

- [ ] **Step 2: Write failing prompt/redaction integration tests**

Use a pseudo-terminal fixture. Assert the enrollment code is not echoed and never appears in stdout/stderr, journal, request log, or process arguments. Re-enrollment requires exact `RE-ENROLL` after its summary. For queue choices accept only `deliver`, `discard`, or `cancel`; discard requires exact `DISCARD`. Everything requires exact `UNINSTALL EVERYTHING`. EOF, signal, misspelling, or terminal-control failure cancels/fails closed and restores terminal echo.

Assert content-free summaries and final messages include queue count, off state, installed version, preserved/removed categories, no-history-transfer warning, and the safe next action. Assert they exclude every secret, device/player ID, local path, cursor, provider content, and native Run ID.

- [ ] **Step 3: Run CLI tests and verify RED**

Run: `cd companion && swift test --filter ControlProtocolTests && swift test --filter RuntimeRaidersCLIIntegrationTests`

Expected: FAIL because lifecycle routes and prompt wiring do not exist.

- [ ] **Step 4: Implement routes and private terminal reader**

Extend `CompanionCommandRoute` with the three lifecycle routes. In CLI live mode, open `/dev/tty` with `O_RDWR|O_CLOEXEC|O_NOFOLLOW`, require a character device owned by root or the effective user, capture `tcgetattr`, disable only `ECHO`, restore attributes in `defer`, and read a bounded line. Maximums: 64 bytes for enrollment code, 32 for choice, and 64 for confirmations. Never accept a code from stdin, argv, environment, or a flag.

Update `raiders help` to replace the interim uninstall line and add exactly:

```text
  re-enroll                Change this device's Raider enrollment
  uninstall                Remove the app and preserve local state
  uninstall --everything   Revoke and remove all local Runtime Raiders data
```

The daemon `.uninstall` control command remains a stop-and-persist-off primitive. The outer CLI calls it first, then performs managed-service and filesystem coordination after the daemon exits.

- [ ] **Step 5: Wire live dependencies and output mapping**

Build `CompanionLifecyclePaths` from the real home, acquire the lifecycle lock, load existing enrollment, use `Uploader.liveCancellableTransport` through `EnrollmentClient`, and pass `ManagedAgentServiceController.live`. Map outcomes to the exact content-free output and nonzero exit for collection-on, invalid code, revocation-required, or assisted-recovery-required. Re-enrollment success ends with collection off and suggests `raiders status`, then deliberate `raiders on`.

- [ ] **Step 6: Run CLI tests and commit**

Run: `cd companion && swift test --filter ControlProtocolTests && swift test --filter RuntimeRaidersCLIIntegrationTests && swift test`

```bash
git add companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift
git commit -m "feat(raiders): expose re-enroll and removal commands"
```

### Task 7: Verify preserved-state reinstall and update supported procedures

**Files:**
- Modify: `companion/packaging/install.sh`
- Modify: `tests/companion-installer.test.ts`
- Modify: `tests/runtime-raiders-onboarding.test.ts`
- Modify: `docs/runtime-raiders/employee-beta.md`
- Modify: `docs/runtime-raiders/companion-operations.md`
- Modify: `docs/BACKLOG.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: passing fresh/reinstall/recovery/removal matrices and the official employee procedure.

- [ ] **Step 1: Add failing installer matrix tests**

Add fixtures for:

- ordinary uninstall followed by reinstall: no code prompt, exact enrollment/cursors/outbox restored, daemon registered, collection still off;
- complete removal followed by reinstall: private fresh enrollment prompt required;
- interrupted re-enrollment followed by reinstall: journal/state preserved and install refuses to overwrite or silently enroll;
- corrupt preserved enrollment: fail closed without prompting or deleting it;
- no account/history mutation in every local flow.

Assert readiness uses `status --json`, never the human output.

- [ ] **Step 2: Run installer tests and verify RED**

Run: `npm test -- tests/companion-installer.test.ts tests/runtime-raiders-onboarding.test.ts`

Expected: at least the recovery-journal and preserved uninstall fixtures fail until installer classification is updated.

- [ ] **Step 3: Update installer classification narrowly**

Treat valid enrollment + state/outbox + absent app/shims as a preserved-state reinstall, not a fresh enrollment. Validate the recovery journal before installation; if present, install executable artifacts and leave collection off but do not discard/replace the journal. Print `Run `raiders re-enroll` to resume recovery.` after successful install. A corrupt present journal or enrollment fails closed.

Do not add a shell implementation of re-enrollment/removal; those remain signed Swift commands.

- [ ] **Step 4: Update employee and operator docs**

Document:

```text
Change Raider: `raiders off`, then `raiders re-enroll`.
Remove the app but keep recovery state: `raiders uninstall`.
Revoke and remove every local Runtime Raiders artifact: `raiders uninstall --everything`.
Browser login alone never changes an installed enrollment.
Neither removal mode deletes a Raider, account, Run, score, reward, or beta history.
```

Remove the undocumented manual cleanup sequence only after all matrices pass. Mark backlog item 33 complete.

- [ ] **Step 5: Run shell and focused installer verification**

Run: `/bin/sh -n companion/packaging/install.sh`

Run: `/bin/zsh -n companion/packaging/install.sh`

Run: `npm test -- tests/companion-installer.test.ts tests/runtime-raiders-onboarding.test.ts`

Run: `cd companion && swift test`

Expected: PASS; no installer path turns collection on.

- [ ] **Step 6: Run complete repository verification**

Run: `npm run typecheck`

Run: `npm test`

Run: `/bin/bash scripts/test/runtime-raiders-gate-safety.sh`

Run: `git diff --check`

Expected: all Node/Swift/shell suites pass. Do not run release `prepare`, publication, a live canary, SSH, or production deployment.

- [ ] **Step 7: Commit the supported lifecycle checkpoint**

```bash
git add companion/packaging/install.sh tests/companion-installer.test.ts tests/runtime-raiders-onboarding.test.ts docs/runtime-raiders/employee-beta.md docs/runtime-raiders/companion-operations.md docs/BACKLOG.md
git commit -m "docs(raiders): support reinstall and enrollment recovery"
```

- [ ] **Step 8: Confirm the no-release boundary**

Run: `git status --short`

Run: `git log --oneline --decorate --max-count=20`

Run: `git diff --name-only e7fbd9f..HEAD | rg '(^dist/|version$|Info.plist)'`

Expected: clean worktree, reviewable task commits, and no version bump, immutable artifact, publication, deployment, or production mutation.

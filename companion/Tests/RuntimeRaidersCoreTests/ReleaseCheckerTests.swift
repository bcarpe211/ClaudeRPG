import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

@_silgen_name("flock")
private func releaseCheckerTestFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

@_silgen_name("fork")
private func releaseCheckerTestFork() -> pid_t

final class ReleaseCheckerTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    func testMalformedStateLoadsAsEmptyAndRewritesOwnerOnly() throws {
        try withPaths { paths in
            try FileManager.default.createDirectory(
                at: paths.stateDirectory,
                withIntermediateDirectories: true
            )
            try Data("DO_NOT_COPY_MALFORMED_STATE".utf8).write(to: paths.updateState)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: paths.updateState.path
            )

            let store = try UpdateStateStore(paths: paths)

            XCTAssertEqual(try store.load(), UpdateStateV1())
            XCTAssertEqual(try permissions(paths.stateDirectory), 0o700)
            XCTAssertEqual(try permissions(paths.updateState), 0o600)
            XCTAssertFalse(
                String(decoding: try Data(contentsOf: paths.updateState), as: UTF8.self)
                    .contains("DO_NOT_COPY_MALFORMED_STATE")
            )

            try FileManager.default.removeItem(at: paths.updateState)
            let trap = paths.supportDirectory.deletingLastPathComponent()
                .appendingPathComponent("update-state-trap")
            try Data("DO_NOT_REPLACE_SYMLINK_TARGET".utf8).write(to: trap)
            try FileManager.default.createSymbolicLink(
                at: paths.updateState,
                withDestinationURL: trap
            )
            XCTAssertEqual(try store.load(), UpdateStateV1())
            XCTAssertEqual(try Data(contentsOf: trap), Data("DO_NOT_REPLACE_SYMLINK_TARGET".utf8))
            var metadata = stat()
            XCTAssertEqual(Darwin.lstat(paths.updateState.path, &metadata), 0)
            XCTAssertEqual(metadata.st_mode & S_IFMT, S_IFREG)

            try FileManager.default.removeItem(at: paths.updateState)
            try Data(repeating: 0x61, count: 16 * 1_024 + 1).write(to: paths.updateState)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: paths.updateState.path
            )
            XCTAssertEqual(try store.load(), UpdateStateV1())
            XCTAssertLessThanOrEqual(try Data(contentsOf: paths.updateState).count, 16 * 1_024)
        }
    }

    func testStateWritesStayAnchoredAfterValidatedParentPathIsReplaced() throws {
        try withPaths { paths in
            let store = try UpdateStateStore(paths: paths)
            try store.save(UpdateStateV1(lastCheckAttemptMS: 1))
            let pinnedDirectory = paths.stateDirectory.deletingLastPathComponent()
                .appendingPathComponent("pinned-state", isDirectory: true)
            let replacementTarget = paths.stateDirectory.deletingLastPathComponent()
                .appendingPathComponent("replacement-state", isDirectory: true)
            try FileManager.default.moveItem(at: paths.stateDirectory, to: pinnedDirectory)
            try FileManager.default.createDirectory(at: replacementTarget, withIntermediateDirectories: false)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: replacementTarget.path
            )
            let trap = replacementTarget.appendingPathComponent("update-state.json")
            let trapContents = Data("DO_NOT_REPLACE_REDIRECTED_TARGET".utf8)
            try trapContents.write(to: trap)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: trap.path
            )
            try FileManager.default.createSymbolicLink(
                at: paths.stateDirectory,
                withDestinationURL: replacementTarget
            )

            try store.save(UpdateStateV1(lastCheckAttemptMS: 2))

            let pinnedState = try JSONDecoder().decode(
                UpdateStateV1.self,
                from: Data(contentsOf: pinnedDirectory.appendingPathComponent("update-state.json"))
            )
            XCTAssertEqual(pinnedState.lastCheckAttemptMS, 2)
            XCTAssertEqual(try Data(contentsOf: trap), trapContents)
        }
    }

    func testCheckIsDueOnlyAfterTwentyFourHours() throws {
        try withPaths { paths in
            let clock = LockedBox(now)
            let requests = LockedBox(0)
            let attemptSeenByTransport = LockedBox<Int64?>(nil)
            let responseBody = validManifestData()
            let checker = try makeChecker(
                paths: paths,
                clockMS: { clock.value },
                transport: { _ in
                    requests.withValue { $0 += 1 }
                    attemptSeenByTransport.value = try UpdateStateStore(paths: paths)
                        .load().lastCheckAttemptMS
                    return .init(statusCode: 200, body: responseBody)
                }
            )

            XCTAssertEqual(checker.checkIfDue(), .checked(self.availability))
            XCTAssertEqual(attemptSeenByTransport.value, now)
            clock.value = now + 86_400_000 - 1
            XCTAssertEqual(checker.checkIfDue(), .notDue)
            XCTAssertEqual(requests.value, 1)
            clock.value = now + 86_400_000
            XCTAssertEqual(checker.checkIfDue(), .checked(self.availability))
            XCTAssertEqual(requests.value, 2)
        }
    }

    func testRequestHasExactURLGETAndNoReportingFields() throws {
        try withPaths { paths in
            let captured = LockedBox<URLRequest?>(nil)
            let responseBody = validManifestData()
            let checker = try makeChecker(paths: paths, transport: { request in
                captured.value = request
                return .init(statusCode: 200, body: responseBody)
            })

            XCTAssertEqual(try checker.fetchNow(), manifest)
            let request = try XCTUnwrap(captured.value)
            XCTAssertEqual(request.url, ReleaseManifestV1.manifestURL)
            XCTAssertNil(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.query)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)
            XCTAssertEqual(request.timeoutInterval, 2)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            let serialized = String(describing: request.allHTTPHeaderFields ?? [:]).lowercased()
            for forbidden in [
                "enrollment", "player", "device", "version", "provider", "model",
                "effort", "usage", "run",
            ] {
                XCTAssertFalse(serialized.contains(forbidden), forbidden)
            }
        }
    }

    func testForcedFetchPersistsExactValidatedManifestWithoutNotification() throws {
        try withPaths { paths in
            let notifications = LockedBox(0)
            let responseBody = validManifestData()
            let checker = try makeChecker(
                paths: paths,
                transport: { _ in .init(statusCode: 200, body: responseBody) },
                notifier: {
                    notifications.withValue { $0 += 1 }
                    return true
                }
            )

            XCTAssertEqual(try checker.fetchNow(), manifest)

            let persisted = try UpdateStateStore(paths: paths).load()
            XCTAssertEqual(persisted.lastCheckAttemptMS, now)
            XCTAssertEqual(persisted.lastObservedReleaseSequence, manifest.releaseSequence)
            XCTAssertEqual(persisted.cachedManifest, manifest)
            XCTAssertNil(persisted.lastNotifiedReleaseSequence)
            XCTAssertEqual(notifications.value, 0)

            let newInstance = try makeChecker(
                paths: paths,
                transport: { _ in throw URLError(.cannotConnectToHost) }
            )
            XCTAssertEqual(newInstance.availability(), availability)

        }
    }

    func testProtocolOneCachedManifestIsReadableAndIgnoredWithoutRewriteByProtocolTwoIdentity() throws {
        try withPaths { paths in
            let cached = manifest
            let store = try UpdateStateStore(paths: paths)
            try store.save(UpdateStateV1(
                lastCheckAttemptMS: now,
                lastObservedReleaseSequence: cached.releaseSequence,
                cachedManifest: cached
            ))
            let originalBytes = try Data(contentsOf: paths.updateState)
            let protocolTwo = CompanionReleaseIdentity(
                releaseSequence: 1,
                releaseSHA: String(repeating: "c", count: 40),
                companionVersion: "0.2.0",
                updateProtocolVersion: 2
            )
            let checker = try ReleaseChecker(
                paths: paths,
                installed: protocolTwo,
                transport: { _ in throw URLError(.cannotConnectToHost) }
            )

            XCTAssertEqual(try store.load().cachedManifest, cached)
            XCTAssertNil(checker.availability())
            XCTAssertEqual(try Data(contentsOf: paths.updateState), originalBytes)
        }
    }

    func testForcedFetchRetainsAndReturnsHigherMonotonicCachedManifest() throws {
        try withPaths { paths in
            let higher = try manifest(sequence: 3, version: "0.3.0", shaByte: "d")
            let responseBody = validManifestData()
            try UpdateStateStore(paths: paths).save(UpdateStateV1(
                lastCheckAttemptMS: now - 1,
                lastObservedReleaseSequence: higher.releaseSequence,
                lastNotifiedReleaseSequence: higher.releaseSequence,
                cachedManifest: higher
            ))
            let checker = try makeChecker(
                paths: paths,
                transport: { _ in .init(statusCode: 200, body: responseBody) }
            )

            XCTAssertEqual(try checker.fetchNow(), higher)

            let persisted = try UpdateStateStore(paths: paths).load()
            XCTAssertEqual(persisted.lastCheckAttemptMS, now)
            XCTAssertEqual(persisted.lastObservedReleaseSequence, higher.releaseSequence)
            XCTAssertEqual(persisted.lastNotifiedReleaseSequence, higher.releaseSequence)
            XCTAssertEqual(persisted.cachedManifest, higher)
        }
    }

    func testConcurrentInstancesMergeFreshStateAfterNetworkWithoutLosingHigherManifestOrMarker() throws {
        try withPaths { paths in
            let higher = try manifest(sequence: 3, version: "0.3.0", shaByte: "d")
            let fixedNow = now
            let lowerManifestData = validManifestData()
            let higherManifestData = manifestData(higher)
            let higherAvailability = CompanionUpdateAvailability(
                installedVersion: "0.2.0",
                installedSequence: 1,
                availableVersion: "0.3.0",
                availableSequence: 3,
                updateCommand: "raiders update"
            )
            let backgroundEnteredNetwork = DispatchSemaphore(value: 0)
            let releaseBackgroundNetwork = DispatchSemaphore(value: 0)
            let backgroundFinished = DispatchSemaphore(value: 0)
            let foregroundFinished = DispatchSemaphore(value: 0)
            let backgroundResult = LockedBox<ReleaseCheckResult?>(nil)
            let foregroundResult = LockedBox<Result<ReleaseManifestV1, Error>?>(nil)
            let stateSeenByNotifier = LockedBox<UpdateStateV1?>(nil)
            let background = try makeChecker(
                paths: paths,
                clockMS: { fixedNow },
                transport: { _ in
                    backgroundEnteredNetwork.signal()
                    _ = releaseBackgroundNetwork.wait(timeout: .now() + 5)
                    return .init(statusCode: 200, body: lowerManifestData)
                },
                notifier: {
                    stateSeenByNotifier.value = try? UpdateStateStore(paths: paths).load()
                    return true
                }
            )
            let foreground = try makeChecker(
                paths: paths,
                clockMS: { fixedNow + 1 },
                transport: { _ in .init(statusCode: 200, body: higherManifestData) }
            )

            DispatchQueue.global(qos: .utility).async {
                backgroundResult.value = background.checkIfDue()
                backgroundFinished.signal()
            }
            XCTAssertEqual(backgroundEnteredNetwork.wait(timeout: .now() + 2), .success)
            DispatchQueue.global(qos: .utility).async {
                foregroundResult.value = Result { try foreground.fetchNow() }
                foregroundFinished.signal()
            }
            let foregroundCompletedBeforeRelease = foregroundFinished.wait(timeout: .now() + 1)
            XCTAssertEqual(
                foregroundCompletedBeforeRelease,
                .success,
                "the update-state filesystem lock must not span network I/O"
            )
            releaseBackgroundNetwork.signal()
            if foregroundCompletedBeforeRelease == .timedOut {
                XCTAssertEqual(foregroundFinished.wait(timeout: .now() + 2), .success)
            }
            XCTAssertEqual(backgroundFinished.wait(timeout: .now() + 2), .success)

            XCTAssertEqual(try foregroundResult.value?.get(), higher)
            XCTAssertEqual(backgroundResult.value, .checked(higherAvailability))
            let persisted = try UpdateStateStore(paths: paths).load()
            XCTAssertEqual(persisted.lastCheckAttemptMS, now + 1)
            XCTAssertEqual(persisted.lastObservedReleaseSequence, 3)
            XCTAssertEqual(persisted.lastNotifiedReleaseSequence, 3)
            XCTAssertEqual(persisted.cachedManifest, higher)
            XCTAssertEqual(stateSeenByNotifier.value, persisted)
        }
    }

    func testUpdateStateStoreBlocksBehindIndependentProcessLock() throws {
        try withPaths { paths in
            let fixedNow = now
            let store = try UpdateStateStore(paths: paths)
            let lockURL = paths.stateDirectory.appendingPathComponent(
                "update-state.lock",
                isDirectory: false
            )
            let lockPath = strdup(lockURL.path)
            guard let lockPath else { throw POSIXError(.ENOMEM) }
            defer { free(lockPath) }
            var ready = [Int32](repeating: -1, count: 2)
            var release = [Int32](repeating: -1, count: 2)
            guard Darwin.pipe(&ready) == 0, Darwin.pipe(&release) == 0 else {
                throw POSIXError(.EIO)
            }
            let child = releaseCheckerTestFork()
            guard child >= 0 else { throw POSIXError(.EIO) }
            if child == 0 {
                Darwin.close(ready[0])
                Darwin.close(release[1])
                let descriptor = Darwin.open(
                    lockPath,
                    O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
                    mode_t(0o600)
                )
                var outcome: Int32 = descriptor >= 0
                    ? releaseCheckerTestFlock(descriptor, LOCK_EX | LOCK_NB)
                    : -errno
                if descriptor >= 0, outcome != 0 { outcome = -errno }
                _ = Darwin.write(ready[1], &outcome, MemoryLayout<Int32>.size)
                if outcome == 0 {
                    var token: UInt8 = 0
                    _ = Darwin.read(release[0], &token, 1)
                    _ = releaseCheckerTestFlock(descriptor, LOCK_UN)
                }
                if descriptor >= 0 { Darwin.close(descriptor) }
                Darwin.close(ready[1])
                Darwin.close(release[0])
                Darwin._exit(0)
            }
            Darwin.close(ready[1])
            Darwin.close(release[0])
            defer {
                Darwin.close(ready[0])
                Darwin.close(release[1])
                var status: Int32 = 0
                _ = Darwin.waitpid(child, &status, 0)
            }
            var childOutcome: Int32 = -1
            XCTAssertEqual(
                Darwin.read(ready[0], &childOutcome, MemoryLayout<Int32>.size),
                MemoryLayout<Int32>.size
            )
            XCTAssertEqual(childOutcome, 0)

            let saveFinished = DispatchSemaphore(value: 0)
            let saveResult = LockedBox<Result<Void, Error>?>(nil)
            DispatchQueue.global(qos: .utility).async {
                saveResult.value = Result {
                    try store.save(UpdateStateV1(lastCheckAttemptMS: fixedNow))
                }
                saveFinished.signal()
            }
            let completedWhileChildHeldLock = saveFinished.wait(timeout: .now() + 0.1)
            XCTAssertEqual(
                completedWhileChildHeldLock,
                .timedOut,
                "state writes must wait for the independent process lock"
            )
            var releaseToken: UInt8 = 1
            XCTAssertEqual(Darwin.write(release[1], &releaseToken, 1), 1)
            if completedWhileChildHeldLock == .timedOut {
                XCTAssertEqual(saveFinished.wait(timeout: .now() + 2), .success)
            }
            XCTAssertNoThrow(try saveResult.value?.get())
            XCTAssertEqual(try store.load().lastCheckAttemptMS, now)
        }
    }

    func testUpdateStateLockIsReleasedWhenAtomicMutationThrows() throws {
        enum ExpectedFailure: Error { case injected }

        try withPaths { paths in
            let first = try UpdateStateStore(paths: paths)
            XCTAssertThrowsError(
                try first.withExclusiveState { _ in throw ExpectedFailure.injected }
            ) { error in
                XCTAssertTrue(error is ExpectedFailure)
            }

            let second = try UpdateStateStore(paths: paths)
            try second.withExclusiveState { state in
                state.lastCheckAttemptMS = now
            }
            XCTAssertEqual(try first.load().lastCheckAttemptMS, now)
        }
    }

    func testUpdateStateLockRejectsSymlinkWithoutTouchingTarget() throws {
        try withPaths { paths in
            try FileManager.default.createDirectory(
                at: paths.stateDirectory,
                withIntermediateDirectories: true
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: paths.stateDirectory.path
            )
            let target = paths.supportDirectory.deletingLastPathComponent()
                .appendingPathComponent("update-state-lock-target")
            let targetBytes = Data("DO_NOT_TOUCH_UPDATE_STATE_LOCK_TARGET".utf8)
            try targetBytes.write(to: target)
            let lockURL = paths.stateDirectory.appendingPathComponent(
                "update-state.lock",
                isDirectory: false
            )
            try FileManager.default.createSymbolicLink(at: lockURL, withDestinationURL: target)

            XCTAssertThrowsError(try UpdateStateStore(paths: paths))
            XCTAssertEqual(try Data(contentsOf: target), targetBytes)
            var metadata = stat()
            XCTAssertEqual(Darwin.lstat(lockURL.path, &metadata), 0)
            XCTAssertEqual(metadata.st_mode & S_IFMT, S_IFLNK)
        }
    }

    func testLiveTransportSendsOnlyBoundedAnonymousHeadersOnWire() throws {
        let server = try RawHTTPServer(responseBody: validManifestData())
        defer { server.stop() }
        var request = URLRequest(url: server.url)
        request.httpMethod = "GET"
        request.timeoutInterval = 2

        let response = try ReleaseChecker.liveTransport(request, allowedURL: server.url)
        let wire = String(decoding: try server.capturedRequest(), as: UTF8.self)
        let headers = parsedHeaders(wire)

        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(response.body, validManifestData())
        XCTAssertEqual(headers["user-agent"], "anonymous")
        XCTAssertEqual(headers["accept-language"], "*")
        for forbidden in [
            ProcessInfo.processInfo.processName,
            ProcessInfo.processInfo.operatingSystemVersionString,
            "CFNetwork",
            "Darwin",
            "device",
            "player",
            "companion_version",
        ] where !forbidden.isEmpty {
            XCTAssertFalse(wire.localizedCaseInsensitiveContains(forbidden), forbidden)
        }
    }

    func testHigherSequenceIsCachedAndNotifiedExactlyOnce() throws {
        try withPaths { paths in
            let clock = LockedBox(now)
            let notifications = LockedBox(0)
            let responseBody = validManifestData()
            var checker = try makeChecker(
                paths: paths,
                clockMS: { clock.value },
                transport: { _ in .init(statusCode: 200, body: responseBody) },
                notifier: {
                    notifications.withValue { $0 += 1 }
                    return true
                }
            )

            XCTAssertEqual(checker.checkIfDue(), .checked(availability))
            XCTAssertEqual(checker.availability(), availability)
            XCTAssertEqual(notifications.value, 1)

            clock.value += 86_400_000
            checker = try makeChecker(
                paths: paths,
                clockMS: { clock.value },
                transport: { _ in .init(statusCode: 200, body: responseBody) },
                notifier: {
                    notifications.withValue { $0 += 1 }
                    return true
                }
            )
            XCTAssertEqual(checker.checkIfDue(), .checked(availability))
            XCTAssertEqual(notifications.value, 1)
            let state = try UpdateStateStore(paths: paths).load()
            XCTAssertEqual(state.lastObservedReleaseSequence, 2)
            XCTAssertEqual(state.lastNotifiedReleaseSequence, 2)
            XCTAssertEqual(state.cachedManifest, manifest)
        }
    }

    func testNotificationAttemptIsRecordedBeforeNotifierRuns() throws {
        try withPaths { paths in
            let stateSeenByNotifier = LockedBox<UpdateStateV1?>(nil)
            let responseBody = validManifestData()
            let checker = try makeChecker(
                paths: paths,
                transport: { _ in .init(statusCode: 200, body: responseBody) },
                notifier: {
                    stateSeenByNotifier.value = try? UpdateStateStore(paths: paths).load()
                    return false
                }
            )

            XCTAssertEqual(checker.checkIfDue(), .checked(availability))
            XCTAssertEqual(stateSeenByNotifier.value?.lastNotifiedReleaseSequence, 2)
        }
    }

    func testNetworkAndManifestFailuresPreserveCollectionIndependentState() throws {
        try withPaths { paths in
            let fixedNow = now
            let providerRoot = paths.supportDirectory.appendingPathComponent(
                "codex",
                isDirectory: true
            )
            try FileManager.default.createDirectory(
                at: providerRoot,
                withIntermediateDirectories: true
            )
            let registry = try AdapterRegistry.enabled(
                surfaces: [.codexCLI],
                codexRoot: providerRoot
            )
            let outbox = try Outbox(directory: paths.outboxDirectory)
            let controller = try AgentController(
                registry: registry,
                paths: paths,
                outbox: outbox,
                configuration: AgentConfiguration(
                    companionVersion: "0.2.0",
                    deviceID: "00000000-0000-4000-8000-000000000001",
                    dedupeSecret: Data("DO_NOT_EXPORT_LOCAL_SECRET".utf8)
                )
            )
            let store = try UpdateStateStore(paths: paths)
            try store.save(UpdateStateV1(
                lastCheckAttemptMS: now - 86_400_000,
                lastObservedReleaseSequence: 2,
                lastNotifiedReleaseSequence: 2,
                cachedManifest: manifest
            ))
            let networkFailure = try makeChecker(
                paths: paths,
                clockMS: { fixedNow },
                transport: { _ in throw URLError(.cannotConnectToHost) }
            )

            XCTAssertEqual(networkFailure.checkIfDue(), .failed)
            XCTAssertEqual(networkFailure.availability(), availability)
            XCTAssertFalse(controller.enabled)

            try controller.turnOn(existingFiles: [])
            let malformedFailure = try makeChecker(
                paths: paths,
                clockMS: { fixedNow + 86_400_000 },
                transport: { _ in .init(statusCode: 200, body: Data("{}".utf8)) }
            )
            XCTAssertEqual(malformedFailure.checkIfDue(), .failed)
            XCTAssertEqual(malformedFailure.availability(), availability)
            XCTAssertTrue(controller.enabled)
            XCTAssertEqual(try outbox.queuedCount(), 0)

            let oversizedFailure = try makeChecker(
                paths: paths,
                clockMS: { fixedNow + 2 * 86_400_000 },
                transport: { _ in
                    .init(statusCode: 200, body: Data(repeating: 0x61, count: 64 * 1_024 + 1))
                }
            )
            XCTAssertEqual(oversizedFailure.checkIfDue(), .failed)
            XCTAssertEqual(oversizedFailure.availability(), availability)
            XCTAssertTrue(controller.enabled)
        }
    }

    private var installed: CompanionReleaseIdentity {
        CompanionReleaseIdentity(
            releaseSequence: 1,
            releaseSHA: String(repeating: "c", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 1
        )
    }

    private var manifest: ReleaseManifestV1 {
        try! ReleaseManifestV1.decode(validManifestData())
    }

    private var availability: CompanionUpdateAvailability {
        CompanionUpdateAvailability(
            installedVersion: "0.2.0",
            installedSequence: 1,
            availableVersion: "0.2.1",
            availableSequence: 2,
            updateCommand: "raiders update"
        )
    }

    private func makeChecker(
        paths: AgentPaths,
        clockMS: @escaping @Sendable () -> Int64 = { 1_800_000_000_000 },
        transport: @escaping ReleaseChecker.Transport,
        notifier: @escaping ReleaseChecker.Notifier = { true }
    ) throws -> ReleaseChecker {
        try ReleaseChecker(
            paths: paths,
            installed: installed,
            transport: transport,
            notifier: notifier,
            clockMS: clockMS
        )
    }

    private func validManifestData() -> Data {
        Data(#"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#.utf8)
    }

    private func manifestData(_ manifest: ReleaseManifestV1) -> Data {
        Data(
            "{\"manifest_version\":1,\"companion_version\":\"\(manifest.companionVersion)\",\"release_sequence\":\(manifest.releaseSequence),\"release_sha\":\"\(manifest.releaseSHA)\",\"update_protocol_version\":\(manifest.updateProtocolVersion),\"zip_sha256\":\"\(manifest.zipSHA256)\",\"zip_url\":\"\(manifest.zipURL.absoluteString)\"}".utf8
        )
    }

    private func manifest(
        sequence: Int64,
        version: String,
        shaByte: Character
    ) throws -> ReleaseManifestV1 {
        try ReleaseManifestV1.decode(Data(
            "{\"manifest_version\":1,\"companion_version\":\"\(version)\",\"release_sequence\":\(sequence),\"release_sha\":\"\(String(repeating: shaByte, count: 40))\",\"update_protocol_version\":1,\"zip_sha256\":\"\(String(repeating: shaByte, count: 64))\",\"zip_url\":\"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip\"}".utf8
        ))
    }

    private func parsedHeaders(_ wire: String) -> [String: String] {
        var headers: [String: String] = [:]
        for line in wire.components(separatedBy: "\r\n").dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[String(line[..<colon]).lowercased()] = String(line[line.index(after: colon)...])
                .trimmingCharacters(in: .whitespaces)
        }
        return headers
    }

    private func withPaths(_ body: (AgentPaths) throws -> Void) throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-release-checker-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(AgentPaths(applicationSupportDirectory: root))
    }

    private func permissions(_ url: URL) throws -> mode_t {
        var metadata = stat()
        guard Darwin.lstat(url.path, &metadata) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return metadata.st_mode & 0o777
    }
}

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }

    func withValue<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(&stored) }
    }
}

private final class RawHTTPServer: @unchecked Sendable {
    private let listening: Int32
    private let responseBody: Data
    private let completed = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var request = Data()
    private var error: Error?
    private var stopped = false
    let url: URL

    init(responseBody: Data) throws {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw Self.posixError() }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Darwin.listen(descriptor, 1) == 0 else {
            Darwin.close(descriptor)
            throw Self.posixError()
        }
        var boundAddress = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &boundAddress) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(descriptor, $0, &length)
            }
        }
        guard named == 0,
              let url = URL(string: "http://127.0.0.1:\(UInt16(bigEndian: boundAddress.sin_port))/manifest") else {
            Darwin.close(descriptor)
            throw Self.posixError()
        }
        listening = descriptor
        self.responseBody = responseBody
        self.url = url
        DispatchQueue.global(qos: .utility).async { [self] in serve() }
    }

    func capturedRequest() throws -> Data {
        guard completed.wait(timeout: .now() + 2) == .success else {
            throw URLError(.timedOut)
        }
        return try lock.withLock {
            if let error { throw error }
            return request
        }
    }

    func stop() {
        let shouldClose = lock.withLock { () -> Bool in
            guard !stopped else { return false }
            stopped = true
            return true
        }
        if shouldClose { Darwin.close(listening) }
    }

    private func serve() {
        let client = Darwin.accept(listening, nil, nil)
        guard client >= 0 else {
            finish(error: Self.posixError())
            return
        }
        defer { Darwin.close(client) }
        var captured = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while captured.count <= 16 * 1_024 {
            let count = Darwin.read(client, &buffer, buffer.count)
            if count > 0 {
                captured.append(contentsOf: buffer.prefix(count))
                if captured.range(of: Data("\r\n\r\n".utf8)) != nil { break }
            } else if count < 0, errno == EINTR {
                continue
            } else {
                finish(error: count == 0 ? URLError(.networkConnectionLost) : Self.posixError())
                return
            }
        }
        let head = Data(
            "HTTP/1.1 200 OK\r\nContent-Length: \(responseBody.count)\r\nConnection: close\r\n\r\n".utf8
        )
        do {
            try writeAll(head + responseBody, to: client)
            lock.withLock { request = captured }
            completed.signal()
        } catch {
            finish(error: error)
        }
    }

    private func finish(error: Error) {
        lock.withLock { self.error = error }
        completed.signal()
    }

    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw Self.posixError() }
            }
        }
    }

    private static func posixError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

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

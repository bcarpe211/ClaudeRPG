import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ReleaseCheckerTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    func testDailyCheckIsAtMostOncePerTwentyFourHoursAndHandlesClockRollback() throws {
        try withPaths { paths in
            let requests = LockedBox(0)
            let clock = LockedBox(now)
            let checker = try makeChecker(paths: paths, clock: { clock.value }) { request in
                requests.value += 1
                return makeVersionResponse("0.4.1")
            }

            XCTAssertEqual(checker.checkIfDue(), .checked(availableVersion: "0.4.1"))
            XCTAssertEqual(checker.checkIfDue(), .notDue)
            clock.value = now - 1
            XCTAssertEqual(checker.checkIfDue(), .notDue)
            clock.value = now + 24 * 60 * 60 * 1_000
            XCTAssertEqual(checker.checkIfDue(), .checked(availableVersion: "0.4.1"))
            XCTAssertEqual(requests.value, 2)
        }
    }

    func testNotifiesOnlyOncePerAvailableVersion() throws {
        try withPaths { paths in
            let clock = LockedBox(now)
            let remoteVersion = LockedBox("0.4.1")
            let notifications = LockedBox(0)
            let checker = try makeChecker(
                paths: paths,
                clock: { clock.value },
                notifier: { notifications.value += 1; return true }
            ) { request in
                makeVersionResponse(remoteVersion.value)
            }

            XCTAssertEqual(checker.checkIfDue(), .checked(availableVersion: "0.4.1"))
            clock.value += 24 * 60 * 60 * 1_000
            XCTAssertEqual(checker.checkIfDue(), .checked(availableVersion: "0.4.1"))
            remoteVersion.value = "0.4.2"
            clock.value += 24 * 60 * 60 * 1_000
            XCTAssertEqual(checker.checkIfDue(), .checked(availableVersion: "0.4.2"))
            XCTAssertEqual(notifications.value, 2)
        }
    }

    func testManualFetchAlwaysChecksImmediatelyAndUsesOnlyMethodAndURL() throws {
        try withPaths { paths in
            let requests = LockedBox(0)
            let checker = try makeChecker(paths: paths) { request in
                requests.value += 1
                XCTAssertEqual(request.url, VersionDocument.url)
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertNil(request.httpBody)
                XCTAssertTrue(request.allHTTPHeaderFields?.isEmpty ?? true)
                return makeVersionResponse("0.4.1")
            }

            XCTAssertEqual(try checker.fetchNow(), "0.4.1")
            XCTAssertEqual(try checker.fetchNow(), "0.4.1")
            XCTAssertEqual(requests.value, 2)
        }
    }

    func testCheckChangesOnlyUpdateStateFile() throws {
        try withPaths { paths in
            let checker = try makeChecker(paths: paths) { request in
                makeVersionResponse("0.4.1")
            }
            XCTAssertEqual(checker.checkIfDue(), .checked(availableVersion: "0.4.1"))
            let contents = try FileManager.default.contentsOfDirectory(
                atPath: paths.stateDirectory.path
            ).sorted()
            XCTAssertEqual(contents, ["update-state.json", "update-state.lock"])
        }
    }

    func testFailurePersistsAttemptButNoAvailability() throws {
        try withPaths { paths in
            let checker = try makeChecker(paths: paths) { _ in throw URLError(.cannotConnectToHost) }
            XCTAssertEqual(checker.checkIfDue(), .failed)
            XCTAssertEqual(try UpdateStateStore(paths: paths).load().lastCheckAttemptMS, now)
            XCTAssertNil(checker.availability())
        }
    }

    private func makeChecker(
        paths: AgentPaths,
        clock: @escaping ReleaseChecker.Clock = { 1_800_000_000_000 },
        notifier: @escaping ReleaseChecker.Notifier = { true },
        transport: @escaping ReleaseChecker.Transport
    ) throws -> ReleaseChecker {
        try ReleaseChecker(
            paths: paths,
            installedVersion: "0.4.0",
            transport: transport,
            notifier: notifier,
            clockMS: clock
        )
    }

    private func withPaths(_ body: (AgentPaths) throws -> Void) throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-version-checker-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try body(AgentPaths(applicationSupportDirectory: root))
    }
}

private func makeVersionResponse(_ version: String) -> UploadHTTPResponse {
    UploadHTTPResponse(statusCode: 200, body: Data(#"{"version":"\#(version)"}"#.utf8))
}

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value

    init(_ value: Value) { storage = value }

    var value: Value {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

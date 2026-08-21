import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class AtomicStoreTests: XCTestCase {
    private static let umaskProbeLock = NSLock()

    func testWriteCreatesACompleteStateFile() throws {
        try withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("state.json")
            let expected = Data(#"{"cursor":17}"#.utf8)

            try AtomicStore().write(expected, to: destination)

            XCTAssertEqual(try Data(contentsOf: destination), expected)
            XCTAssertEqual(try temporaryFiles(in: directory), [])
        }
    }

    func testWriteAtomicallyOverwritesOldCompleteState() throws {
        try withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("state.json")
            let old = Data(#"{"version":"old","padding":"complete"}"#.utf8)
            let new = Data(#"{"version":"new"}"#.utf8)
            try old.write(to: destination)

            try AtomicStore().write(new, to: destination)

            XCTAssertEqual(try Data(contentsOf: destination), new)
            XCTAssertEqual(try temporaryFiles(in: directory), [])
        }
    }

    func testReplacementFailurePreservesOldCompleteStateAndCleansTemporaryFile() throws {
        enum ExpectedFailure: Error { case replacement }

        try withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("state.json")
            let old = Data(#"{"version":"old","padding":"complete"}"#.utf8)
            try old.write(to: destination)
            let store = AtomicStore(replace: { _, _ in throw ExpectedFailure.replacement })

            XCTAssertThrowsError(try store.write(Data(#"{"version":"new"}"#.utf8), to: destination))
            XCTAssertEqual(try Data(contentsOf: destination), old)
            XCTAssertEqual(try temporaryFiles(in: directory), [])
        }
    }

    func testTemporaryFileIsPrivateFromTheInstantItBecomesVisible() throws {
        enum ExpectedFailure: Error { case replacement }

        Self.umaskProbeLock.lock()
        let originalUmask = Darwin.umask(0)
        defer {
            Darwin.umask(originalUmask)
            Self.umaskProbeLock.unlock()
        }

        try withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("state.json")
            let probe = TemporaryModeProbe()
            let observerReady = DispatchSemaphore(value: 0)
            let observerFinished = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .userInitiated).async {
                observerReady.signal()
                while !probe.isFinished {
                    autoreleasepool {
                        let names = (try? FileManager.default.contentsOfDirectory(
                            atPath: directory.path
                        )) ?? []
                        for name in names where name.contains(".runtime-raiders-tmp-") {
                            let temporary = directory.appendingPathComponent(name)
                            if let attributes = try? FileManager.default.attributesOfItem(
                                atPath: temporary.path
                            ), let permissions = attributes[.posixPermissions] as? NSNumber {
                                probe.record(permissions.intValue & 0o777)
                            }
                        }
                    }
                }
                observerFinished.signal()
            }
            observerReady.wait()

            let store = AtomicStore(replace: { temporary, _ in
                let attributes = try FileManager.default.attributesOfItem(atPath: temporary.path)
                let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
                probe.record(permissions.intValue & 0o777)
                throw ExpectedFailure.replacement
            })
            XCTAssertThrowsError(
                try store.write(Data(repeating: 0x5a, count: 64 * 1_024 * 1_024), to: destination)
            )
            probe.finish()
            observerFinished.wait()

            XCTAssertFalse(probe.modes.isEmpty)
            XCTAssertEqual(probe.modes, [0o600])
            XCTAssertEqual(try temporaryFiles(in: directory), [])
        }
    }

    func testMissingParentFailsWithoutCreatingAnyPath() throws {
        try withTemporaryDirectory { directory in
            let missing = directory.appendingPathComponent("missing", isDirectory: true)
            let destination = missing.appendingPathComponent("state.json")

            XCTAssertThrowsError(try AtomicStore().write(Data("state".utf8), to: destination))
            XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
        }
    }

    func testAgentPathsAreDeterministicAndDoNotCreateDirectories() throws {
        try withTemporaryDirectory { directory in
            let paths = AgentPaths(applicationSupportDirectory: directory)
            let support = directory.appendingPathComponent("Runtime Raiders", isDirectory: true)

            XCTAssertEqual(paths.supportDirectory, support)
            XCTAssertEqual(
                paths.stateDirectory,
                support.appendingPathComponent("state", isDirectory: true)
            )
            XCTAssertEqual(
                paths.outboxDirectory,
                support.appendingPathComponent("outbox", isDirectory: true)
            )
            XCTAssertEqual(
                paths.controlSocket,
                support.appendingPathComponent("agent.sock", isDirectory: false)
            )
            XCTAssertEqual(
                paths.updateState,
                support.appendingPathComponent("state/update-state.json", isDirectory: false)
            )
            XCTAssertEqual(
                paths.updateLock,
                support.appendingPathComponent("state/update.lock", isDirectory: false)
            )
            XCTAssertEqual(
                paths.agentApplication,
                support.appendingPathComponent("Runtime Raiders Agent.app", isDirectory: true)
            )
            XCTAssertFalse(FileManager.default.fileExists(atPath: support.path))
        }
    }

    private func temporaryFiles(in directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.contains(".runtime-raiders-tmp-") }
    }

    private func withTemporaryDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("runtime-raiders-atomic-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }
}

private final class TemporaryModeProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var observedModes: Set<Int> = []

    var isFinished: Bool {
        lock.withLock { finished }
    }

    var modes: Set<Int> {
        lock.withLock { observedModes }
    }

    func record(_ mode: Int) {
        _ = lock.withLock { observedModes.insert(mode) }
    }

    func finish() {
        lock.withLock { finished = true }
    }
}

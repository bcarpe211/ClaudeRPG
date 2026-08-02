import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class AtomicStoreTests: XCTestCase {
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

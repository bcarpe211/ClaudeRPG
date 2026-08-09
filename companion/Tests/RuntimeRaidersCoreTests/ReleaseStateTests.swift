import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ReleaseStateTests: XCTestCase {
    func testReleaseReferenceAndStateDecodeOnlyExactProtocolTwoSchema() throws {
        let state = try ReleaseStateV1.decode(stateData())
        XCTAssertEqual(state.schemaVersion, 1)
        XCTAssertEqual(state.generation, 7)
        XCTAssertEqual(state.active, reference(sequence: 9, sha: "a"))
        XCTAssertEqual(state.fallback, reference(sequence: 8, sha: "b"))
        XCTAssertNil(state.trial)

        for invalid in [
            stateJSON().replacingOccurrences(of: "\"trial\":null", with: "\"trial\":null,\"path\":\"/tmp/evil\""),
            stateJSON().replacingOccurrences(of: "\"generation\":7", with: "\"generation\":0"),
            stateJSON().replacingOccurrences(of: "\"update_protocol_version\":2", with: "\"update_protocol_version\":1"),
            stateJSON().replacingOccurrences(of: "\"release_sequence\":8", with: "\"release_sequence\":9"),
            stateJSON().replacingOccurrences(of: "\"fallback\":{", with: "\"fallback\":{\"path\":\"relative\",")
        ].enumerated() {
            XCTAssertThrowsError(try ReleaseStateV1.decode(Data(invalid.element.utf8)), "invalid case \(invalid.offset)")
        }
        XCTAssertThrowsError(try ReleaseStateV1.decode(Data(repeating: 0x61, count: 16 * 1_024 + 1)))
    }

    func testReleaseDirectoryIsReconstructedFromValidatedIdentity() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)

        XCTAssertEqual(
            try paths.releaseDirectory(for: reference(sequence: 9, sha: "a")).path,
            root.appendingPathComponent("Runtime Raiders/releases/sequence-9-\(String(repeating: "a", count: 40))").path
        )
        XCTAssertEqual(
            try paths.application(for: reference(sequence: 9, sha: "a")).lastPathComponent,
            "Runtime Raiders Agent.app"
        )
        XCTAssertEqual(
            paths.legacyFlatApplication.lastPathComponent,
            "Runtime Raiders Agent.app"
        )
        XCTAssertEqual(paths.launcherApplication.lastPathComponent, "Runtime Raiders Launcher.app")
        XCTAssertEqual(paths.launcherExecutable.lastPathComponent, "runtime-raiders-launcher")
        XCTAssertEqual(paths.releaseState.path, root.appendingPathComponent("Runtime Raiders/installation/release-state.json").path)
        XCTAssertEqual(paths.updateJournal.path, root.appendingPathComponent("Runtime Raiders/installation/update-journal.json").path)
    }

    func testInitialStateIsExclusiveAndReplacementUsesGenerationCAS() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        let store = try ReleaseStateStore(paths: paths)
        let initial = state(generation: 1, active: reference(sequence: 9, sha: "a"))

        try store.createInitial(initial)
        XCTAssertEqual(try store.load(), initial)
        XCTAssertThrowsError(try store.createInitial(initial))

        let next = state(
            generation: 2,
            active: reference(sequence: 10, sha: "c"),
            fallback: reference(sequence: 9, sha: "a")
        )
        XCTAssertThrowsError(try store.replace(expectedGeneration: 0, with: next))
        try store.replace(expectedGeneration: 1, with: next)
        XCTAssertEqual(try store.load(), next)
    }

    func testUnsafeAndPartialRecordsFailClosedWithoutReplacement() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        let store = try ReleaseStateStore(paths: paths)
        XCTAssertThrowsError(try store.load())

        try FileManager.default.createDirectory(at: paths.installationDirectory, withIntermediateDirectories: true)
        let trap = root.appendingPathComponent("trap")
        try Data("unchanged".utf8).write(to: trap)
        try FileManager.default.createSymbolicLink(at: paths.releaseState, withDestinationURL: trap)
        XCTAssertThrowsError(try store.load())
        XCTAssertEqual(try Data(contentsOf: trap), Data("unchanged".utf8))

        try FileManager.default.removeItem(at: paths.releaseState)
        try Data("{\"schema_version\":".utf8).write(to: paths.releaseState)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: paths.releaseState.path)
        XCTAssertThrowsError(try store.load())
        XCTAssertEqual(try Data(contentsOf: paths.releaseState), Data("{\"schema_version\":".utf8))

        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.releaseState.path)
        XCTAssertThrowsError(try store.load())

        try FileManager.default.removeItem(at: paths.releaseState)
        try Data(repeating: 0x61, count: 16 * 1_024 + 1).write(to: paths.releaseState)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.releaseState.path)
        XCTAssertThrowsError(try store.load())

        try FileManager.default.removeItem(at: paths.releaseState)
        let valid = try JSONEncoder().encode(state(
            generation: 1,
            active: reference(sequence: 9, sha: "a")
        ))
        try valid.write(to: paths.releaseState)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.releaseState.path)
        try FileManager.default.linkItem(
            at: paths.releaseState,
            to: paths.installationDirectory.appendingPathComponent("duplicate-release-state")
        )
        XCTAssertThrowsError(try store.load())
    }

    func testInterruptedReplacementLeavesCompleteOldRecord() throws {
        enum Expected: Error { case interrupted }

        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        let initial = state(generation: 1, active: reference(sequence: 9, sha: "a"))
        let first = try ReleaseStateStore(paths: paths)
        try first.createInitial(initial)
        let interrupted = try ReleaseStateStore(paths: paths, beforeRename: { throw Expected.interrupted })
        let next = state(
            generation: 2,
            active: reference(sequence: 10, sha: "c"),
            fallback: reference(sequence: 9, sha: "a")
        )

        XCTAssertThrowsError(try interrupted.replace(expectedGeneration: 1, with: next))
        XCTAssertEqual(try first.load(), initial)
    }

    func testConcurrentStoresAllowOnlyOneCASReplacement() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        let initial = state(generation: 1, active: reference(sequence: 9, sha: "a"))
        let initialStore = try ReleaseStateStore(paths: paths)
        try initialStore.createInitial(initial)
        let enteredRename = DispatchSemaphore(value: 0)
        let releaseRename = DispatchSemaphore(value: 0)
        let first = try ReleaseStateStore(paths: paths, beforeRename: {
            enteredRename.signal()
            _ = releaseRename.wait(timeout: .now() + 2)
        })
        let second = try ReleaseStateStore(paths: paths)
        let firstResult = ReleaseStateResultBox()
        let secondResult = ReleaseStateResultBox()
        let firstFinished = DispatchSemaphore(value: 0)
        let secondFinished = DispatchSemaphore(value: 0)
        let next = state(
            generation: 2,
            active: reference(sequence: 10, sha: "c"),
            fallback: reference(sequence: 9, sha: "a")
        )

        DispatchQueue.global().async {
            firstResult.value = Result { try first.replace(expectedGeneration: 1, with: next) }
            firstFinished.signal()
        }
        XCTAssertEqual(enteredRename.wait(timeout: .now() + 1), .success)
        DispatchQueue.global().async {
            secondResult.value = Result { try second.replace(expectedGeneration: 1, with: next) }
            secondFinished.signal()
        }
        XCTAssertEqual(secondFinished.wait(timeout: .now() + 0.1), .timedOut)
        releaseRename.signal()
        XCTAssertEqual(firstFinished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(secondFinished.wait(timeout: .now() + 1), .success)
        XCTAssertNoThrow(try firstResult.value?.get())
        XCTAssertThrowsError(try secondResult.value?.get())
        XCTAssertEqual(try initialStore.load(), next)
    }

    private func reference(sequence: Int64, sha: String) -> ReleaseReference {
        ReleaseReference(
            releaseSequence: sequence,
            releaseSHA: String(repeating: sha, count: 40),
            companionVersion: "0.3.\(sequence)",
            updateProtocolVersion: 2
        )
    }

    private func state(
        generation: Int64,
        active: ReleaseReference,
        fallback: ReleaseReference? = nil,
        trial: ReleaseReference? = nil
    ) -> ReleaseStateV1 {
        ReleaseStateV1(
            schemaVersion: 1,
            generation: generation,
            active: active,
            fallback: fallback,
            trial: trial
        )
    }

    private func stateData() -> Data { Data(stateJSON().utf8) }

    private func stateJSON() -> String {
        #"{"schema_version":1,"generation":7,"active":{"release_sequence":9,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","companion_version":"0.3.9","update_protocol_version":2},"fallback":{"release_sequence":8,"release_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","companion_version":"0.3.8","update_protocol_version":2},"trial":null}"#
    }

    private func temporaryDirectory() -> URL {
        URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-release-state-\(UUID().uuidString)", isDirectory: true)
    }
}

private final class ReleaseStateResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Result<Void, Error>?

    var value: Result<Void, Error>? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class RecoveryJournalTests: XCTestCase {
    private let replacementToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    func testJournalRoundTripsExactVersionOneWireWithPrivateAtomicStorage() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let store = try RecoveryJournalStore(paths: fixture.paths)
        let first = journal(phase: .replacementPrepared)

        try store.write(first)

        XCTAssertEqual(try store.load(), first)
        XCTAssertEqual(try permissions(fixture.paths.agent.stateDirectory), 0o700)
        XCTAssertEqual(try permissions(fixture.paths.recoveryJournal), 0o600)
        let firstInode = try inode(fixture.paths.recoveryJournal)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixture.paths.recoveryJournal))
                as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), [
            "version", "operation_id", "replacement_device_id",
            "replacement_device_token", "companion_version", "queue_disposition", "phase",
        ])

        var second = first
        second.phase = .serverCommitted
        try store.write(second)

        XCTAssertEqual(try store.load(), second)
        XCTAssertNotEqual(try inode(fixture.paths.recoveryJournal), firstInode)
        XCTAssertEqual(try permissions(fixture.paths.recoveryJournal), 0o600)
    }

    func testJournalPersistsAcrossStoreLifetimeAndRemovalIsDurableAndIdempotent() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let expected = journal(phase: .collectorReset)
        do {
            let store = try RecoveryJournalStore(paths: fixture.paths)
            try store.write(expected)
        }

        let recovered = try RecoveryJournalStore(paths: fixture.paths)
        XCTAssertEqual(try recovered.load(), expected)
        try recovered.remove()
        XCTAssertNil(try recovered.load())
        try recovered.remove()
        XCTAssertNil(try recovered.load())
    }

    func testJournalRejectsMissingExtraBadVersionAndInvalidTokenWithoutLeakingSecret() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let store = try RecoveryJournalStore(paths: fixture.paths)
        let base: [String: Any] = [
            "version": 1,
            "operation_id": "00000000-0000-4000-8000-000000000001",
            "replacement_device_id": "00000000-0000-4000-8000-000000000002",
            "replacement_device_token": replacementToken,
            "companion_version": "0.4.8",
            "queue_disposition": "empty",
            "phase": "replacementPrepared",
        ]
        var fixtures: [[String: Any]] = []
        var missing = base
        missing.removeValue(forKey: "phase")
        fixtures.append(missing)
        var extra = base
        extra["unexpected"] = true
        fixtures.append(extra)
        var badVersion = base
        badVersion["version"] = 2
        fixtures.append(badVersion)
        var badToken = base
        badToken["replacement_device_token"] = String(repeating: "!", count: 43)
        fixtures.append(badToken)

        for object in fixtures {
            try writeRaw(try JSONSerialization.data(withJSONObject: object), to: fixture.paths.recoveryJournal)
            XCTAssertThrowsError(try store.load()) { error in
                XCTAssertFalse(String(describing: error).contains(self.replacementToken))
            }
        }

        var invalid = journal(phase: .replacementPrepared)
        invalid = RecoveryJournal(
            version: invalid.version,
            operationID: invalid.operationID,
            replacementDeviceID: invalid.replacementDeviceID,
            replacementDeviceToken: String(repeating: "!", count: 43),
            companionVersion: invalid.companionVersion,
            queueDisposition: invalid.queueDisposition,
            phase: invalid.phase
        )
        XCTAssertThrowsError(try store.write(invalid)) { error in
            XCTAssertFalse(String(describing: error).contains(String(repeating: "!", count: 43)))
        }
    }

    func testJournalDescriptionsRedactReplacementToken() {
        let value = journal(phase: .replacementPrepared)

        XCTAssertFalse(String(describing: value).contains(replacementToken))
        XCTAssertFalse(String(reflecting: value).contains(replacementToken))
    }

    func testJournalRejectsWrongModeTypeLinkCountAndBoundedSize() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let store = try RecoveryJournalStore(paths: fixture.paths)
        try store.write(journal(phase: .replacementPrepared))

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o644],
            ofItemAtPath: fixture.paths.recoveryJournal.path
        )
        XCTAssertThrowsError(try store.load())
        try FileManager.default.removeItem(at: fixture.paths.recoveryJournal)

        try FileManager.default.createDirectory(
            at: fixture.paths.recoveryJournal,
            withIntermediateDirectories: false
        )
        XCTAssertThrowsError(try store.load())
        try FileManager.default.removeItem(at: fixture.paths.recoveryJournal)

        try store.write(journal(phase: .replacementPrepared))
        let hardLink = fixture.paths.agent.stateDirectory.appendingPathComponent("journal-hard-link")
        try FileManager.default.linkItem(at: fixture.paths.recoveryJournal, to: hardLink)
        XCTAssertThrowsError(try store.load())
        try FileManager.default.removeItem(at: hardLink)
        try FileManager.default.removeItem(at: fixture.paths.recoveryJournal)

        try writeRaw(Data(), to: fixture.paths.recoveryJournal)
        XCTAssertThrowsError(try store.load())
        try writeRaw(Data(repeating: 0x61, count: 16_385), to: fixture.paths.recoveryJournal)
        XCTAssertThrowsError(try store.load())

        var metadata = stat()
        metadata.st_mode = mode_t(S_IFREG | 0o600)
        metadata.st_uid = Darwin.geteuid() &+ 1
        metadata.st_nlink = 1
        metadata.st_size = 10
        XCTAssertFalse(VerifiedStateDirectory.validPrivateFile(metadata, maximumBytes: 16_384))
    }

    func testJournalRejectsSymlinkFileAndParentWithoutTouchingTarget() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let outside = fixture.root.appendingPathComponent("outside-secret")
        let original = Data("DO_NOT_EXPORT_RECOVERY_SECRET".utf8)
        try writeRaw(original, to: outside)
        try FileManager.default.createSymbolicLink(
            at: fixture.paths.recoveryJournal,
            withDestinationURL: outside
        )
        let store = try RecoveryJournalStore(paths: fixture.paths)

        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.write(journal(phase: .replacementPrepared)))
        XCTAssertThrowsError(try store.remove())
        XCTAssertEqual(try Data(contentsOf: outside), original)

        try FileManager.default.removeItem(at: fixture.paths.recoveryJournal)
        let pinned = fixture.root.appendingPathComponent("state-pinned", isDirectory: true)
        try FileManager.default.moveItem(at: fixture.paths.agent.stateDirectory, to: pinned)
        let outsideDirectory = fixture.root.appendingPathComponent("outside-state", isDirectory: true)
        try FileManager.default.createDirectory(
            at: outsideDirectory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.createSymbolicLink(
            at: fixture.paths.agent.stateDirectory,
            withDestinationURL: outsideDirectory
        )
        XCTAssertThrowsError(try RecoveryJournalStore(paths: fixture.paths))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: outsideDirectory.appendingPathComponent("re-enrollment.json").path
        ))
    }

    func testRetainedStateDescriptorRejectsDirectorySwapBeforeJournalMutation() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let store = try RecoveryJournalStore(paths: fixture.paths)
        let pinned = fixture.root.appendingPathComponent("state-pinned", isDirectory: true)
        try FileManager.default.moveItem(at: fixture.paths.agent.stateDirectory, to: pinned)
        try FileManager.default.createDirectory(
            at: fixture.paths.agent.stateDirectory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )

        XCTAssertThrowsError(try store.write(journal(phase: .replacementPrepared)))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: pinned.appendingPathComponent("re-enrollment.json").path
        ))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: fixture.paths.recoveryJournal.path
        ))
    }

    func testLifecycleLockIsPrivateNonblockingAndReleasedOnClose() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        var first: LifecycleLock? = try LifecycleLock.acquire(at: fixture.paths.lifecycleLock)

        XCTAssertNotNil(first)
        XCTAssertEqual(try permissions(fixture.paths.lifecycleLock), 0o600)
        XCTAssertThrowsError(try LifecycleLock.acquire(at: fixture.paths.lifecycleLock)) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .busy)
        }

        first = nil
        XCTAssertNotNil(try LifecycleLock.acquire(at: fixture.paths.lifecycleLock))
    }

    private func journal(phase: ReEnrollmentPhase) -> RecoveryJournal {
        RecoveryJournal(
            version: 1,
            operationID: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!,
            replacementDeviceID: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!,
            replacementDeviceToken: replacementToken,
            companionVersion: "0.4.8",
            queueDisposition: .empty,
            phase: phase
        )
    }

    private func writeRaw(_ data: Data, to file: URL) throws {
        try? FileManager.default.removeItem(at: file)
        try data.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    private func permissions(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }

    private func inode(_ url: URL) throws -> UInt64 {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.systemFileNumber] as? NSNumber).uint64Value
    }
}

private final class Fixture {
    let root: URL
    let paths: CompanionLifecyclePaths

    init() throws {
        root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-recovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        paths = try CompanionLifecyclePaths(homeDirectory: root)
        try FileManager.default.createDirectory(
            at: paths.agent.stateDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: paths.agent.stateDirectory.path
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}

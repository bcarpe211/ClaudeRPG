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

    func testAtomicJournalInterruptionsRecoverOnlyOldOrNewCompleteValue() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let original = journal(phase: .replacementPrepared)
        var replacement = original
        replacement.phase = .serverCommitted
        let normal = try RecoveryJournalStore(paths: fixture.paths)
        try normal.write(original)
        let originalBytes = try Data(contentsOf: fixture.paths.recoveryJournal)

        let beforeRename = try RecoveryJournalStore(
            paths: fixture.paths,
            atomicStore: AtomicStore(descriptorCheckpoint: { checkpoint in
                if checkpoint == .beforeRename { throw SimulatedInterruption() }
            })
        )
        XCTAssertThrowsError(try beforeRename.write(replacement))
        XCTAssertEqual(try RecoveryJournalStore(paths: fixture.paths).load(), original)
        XCTAssertEqual(try Data(contentsOf: fixture.paths.recoveryJournal), originalBytes)

        let afterRename = try RecoveryJournalStore(
            paths: fixture.paths,
            atomicStore: AtomicStore(descriptorCheckpoint: { checkpoint in
                if checkpoint == .afterRenameBeforeDirectorySync {
                    throw SimulatedInterruption()
                }
            })
        )
        XCTAssertThrowsError(try afterRename.write(replacement))
        XCTAssertEqual(try RecoveryJournalStore(paths: fixture.paths).load(), replacement)
        XCTAssertNotEqual(try Data(contentsOf: fixture.paths.recoveryJournal), originalBytes)
    }

    func testJournalStoreReadPathRejectsInjectedWrongOwnerAndSetgidMetadata() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let normal = try RecoveryJournalStore(paths: fixture.paths)
        try normal.write(journal(phase: .replacementPrepared))

        let wrongOwner = try RecoveryJournalStore(
            paths: fixture.paths,
            metadataTransform: { metadata in
                var changed = metadata
                changed.st_uid = Darwin.geteuid() &+ 1
                return changed
            }
        )
        XCTAssertThrowsError(try wrongOwner.load())

        let setgid = try RecoveryJournalStore(
            paths: fixture.paths,
            metadataTransform: { metadata in
                var changed = metadata
                changed.st_mode |= mode_t(S_ISGID)
                return changed
            }
        )
        XCTAssertThrowsError(try setgid.load())
        XCTAssertEqual(try fullPermissions(fixture.paths.recoveryJournal), 0o600)
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

    func testJournalRejectsNonASCIIControlAndWrongByteLengthTokensOnWriteAndLoad() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let store = try RecoveryJournalStore(paths: fixture.paths)
        let invalidTokens = [
            String(repeating: "A", count: 42),
            String(repeating: "A", count: 44),
            String(repeating: "A", count: 42) + "\n",
            String(repeating: "A", count: 42) + "\r",
            String(repeating: "A", count: 41) + "é",
        ]

        for (index, token) in invalidTokens.enumerated() {
            let invalid = RecoveryJournal(
                version: 1,
                operationID: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!,
                replacementDeviceID: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!,
                replacementDeviceToken: token,
                companionVersion: "0.4.8",
                queueDisposition: .empty,
                phase: .replacementPrepared
            )
            XCTAssertThrowsError(try store.write(invalid), "write case \(index)")

            let object: [String: Any] = [
                "version": 1,
                "operation_id": "00000000-0000-4000-8000-000000000001",
                "replacement_device_id": "00000000-0000-4000-8000-000000000002",
                "replacement_device_token": token,
                "companion_version": "0.4.8",
                "queue_disposition": "empty",
                "phase": "replacementPrepared",
            ]
            try writeRaw(try JSONSerialization.data(withJSONObject: object), to: fixture.paths.recoveryJournal)
            XCTAssertThrowsError(try store.load(), "load case \(index)")
        }
    }

    func testJournalRejectsDuplicateTopLevelSecurityKeysBeforeDecode() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let store = try RecoveryJournalStore(paths: fixture.paths)
        let prefix = #"{"operation_id":"00000000-0000-4000-8000-000000000001","replacement_device_id":"00000000-0000-4000-8000-000000000002","companion_version":"0.4.8","queue_disposition":"empty","#
        let validToken = String(repeating: "A", count: 43)
        let otherToken = String(repeating: "B", count: 43)
        let fixtures = [
            prefix + #""version":1,"version":1,"replacement_device_token":"\#(validToken)","phase":"replacementPrepared"}"#,
            prefix + #""version":1,"version":2,"replacement_device_token":"\#(validToken)","phase":"replacementPrepared"}"#,
            prefix + #""version":1,"replacement_device_token":"\#(validToken)","replacement_device_token":"\#(validToken)","phase":"replacementPrepared"}"#,
            prefix + #""version":1,"replacement_device_token":"\#(validToken)","replacement_device_token":"\#(otherToken)","phase":"replacementPrepared"}"#,
            prefix + #""version":1,"replacement_device_token":"\#(validToken)","phase":"replacementPrepared","phase":"replacementPrepared"}"#,
            prefix + #""version":1,"replacement_device_token":"\#(validToken)","phase":"replacementPrepared","phase":"serverCommitted"}"#,
        ]

        for (index, raw) in fixtures.enumerated() {
            try writeRaw(Data(raw.utf8), to: fixture.paths.recoveryJournal)
            XCTAssertThrowsError(try store.load(), "duplicate case \(index)")
        }
    }

    func testJournalReadRejectsSetIDAndStickyPermissionBits() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let store = try RecoveryJournalStore(paths: fixture.paths)
        let modes: [mode_t] = [0o4600, 0o1600]

        for mode in modes {
            try? FileManager.default.removeItem(at: fixture.paths.recoveryJournal)
            try store.write(journal(phase: .replacementPrepared))
            XCTAssertEqual(Darwin.chmod(fixture.paths.recoveryJournal.path, mode), 0)
            XCTAssertEqual(try fullPermissions(fixture.paths.recoveryJournal), Int(mode))
            XCTAssertThrowsError(try store.load(), "mode \(String(mode, radix: 8))")
        }
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
        var first: LifecycleLock? = try fixture.acquireLifecycleLock()

        XCTAssertNotNil(first)
        XCTAssertEqual(try permissions(fixture.paths.lifecycleLock), 0o600)
        XCTAssertThrowsError(try fixture.acquireLifecycleLock()) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .busy)
        }

        first = nil
        XCTAssertNotNil(try fixture.acquireLifecycleLock())
    }

    func testHeldLifecycleLockSurvivesSupportTreeRemovalAndReplacement() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = try fixture.acquireLifecycleLock()
        XCTAssertNotNil(first)

        try FileManager.default.removeItem(at: fixture.paths.agent.supportDirectory)
        XCTAssertThrowsError(try fixture.acquireLifecycleLock()) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .busy)
        }

        try FileManager.default.createDirectory(
            at: fixture.paths.agent.stateDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: fixture.paths.agent.stateDirectory.path
        )
        XCTAssertThrowsError(try fixture.acquireLifecycleLock()) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .busy)
        }
    }

    func testHeldLifecycleLockSurvivesMarkerUnlinkAndRecreationUntilRelease() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        var first: LifecycleLock? = try fixture.acquireLifecycleLock()
        XCTAssertNotNil(first)

        try FileManager.default.removeItem(at: fixture.paths.lifecycleLock)
        XCTAssertTrue(FileManager.default.createFile(
            atPath: fixture.paths.lifecycleLock.path,
            contents: Data(),
            attributes: [.posixPermissions: 0o600]
        ))
        XCTAssertThrowsError(try fixture.acquireLifecycleLock()) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .busy)
        }

        first = nil
        XCTAssertNotNil(try fixture.acquireLifecycleLock())
    }

    func testHeldLifecycleLockSurvivesMarkerRenameReplacement() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = try fixture.acquireLifecycleLock()
        let replacement = fixture.paths.lifecycleLock
            .deletingLastPathComponent()
            .appendingPathComponent("replacement.lock")
        XCTAssertTrue(FileManager.default.createFile(
            atPath: replacement.path,
            contents: Data(),
            attributes: [.posixPermissions: 0o600]
        ))
        XCTAssertEqual(Darwin.rename(replacement.path, fixture.paths.lifecycleLock.path), 0)

        XCTAssertThrowsError(try fixture.acquireLifecycleLock()) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .busy)
        }
        XCTAssertNotNil(first)
    }

    func testLifecycleLockRejectsUnsafeParentAndHomeMetadataBeforeAcquisition() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }

        XCTAssertThrowsError(try LifecycleLock.acquire(at: fixture.paths.lifecycleLock)) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .invalidState)
        }

        XCTAssertEqual(Darwin.chmod(fixture.root.path, 0o722), 0)
        defer { _ = Darwin.chmod(fixture.root.path, 0o700) }
        XCTAssertThrowsError(try fixture.acquireLifecycleLock()) { error in
            XCTAssertEqual(error as? LifecycleStorageError, .invalidState)
        }
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

    private func fullPermissions(_ url: URL) throws -> Int {
        var metadata = stat()
        guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.EIO) }
        return Int(metadata.st_mode & 0o7777)
    }

    private func inode(_ url: URL) throws -> UInt64 {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.systemFileNumber] as? NSNumber).uint64Value
    }
}

private struct SimulatedInterruption: Error {}

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
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: paths.agent.supportDirectory.deletingLastPathComponent().path
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }

    func acquireLifecycleLock() throws -> LifecycleLock {
        try LifecycleLock.acquire(
            at: paths.lifecycleLock,
            anchorParentMetadataTransform: { metadata in
                var supported = metadata
                supported.st_uid = 0
                supported.st_mode = (supported.st_mode & mode_t(S_IFMT)) | 0o755
                return supported
            }
        )
    }
}

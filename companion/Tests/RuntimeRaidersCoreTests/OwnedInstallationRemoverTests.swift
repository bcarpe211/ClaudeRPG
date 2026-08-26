import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

@_silgen_name("flock")
private func testRemovalFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

final class OwnedInstallationRemoverTests: XCTestCase {
    func testPreserveRemovalDeletesOnlyExecutableArtifactsAndPreservesStateBytes() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let protectedBefore = try fixture.protectedFingerprint()
        let unrelatedBefore = try fixture.unrelatedFingerprint()

        try OwnedInstallationRemover(paths: fixture.paths).removeExecutableArtifacts()

        for removed in fixture.executableArtifacts {
            XCTAssertFalse(entryExists(removed), "owned executable artifact must be absent")
        }
        XCTAssertEqual(try fixture.protectedFingerprint(), protectedBefore)
        XCTAssertEqual(try fixture.unrelatedFingerprint(), unrelatedBefore)
        XCTAssertTrue(entryExists(fixture.paths.agent.supportDirectory))
        XCTAssertTrue(entryExists(fixture.paths.agent.stateDirectory))
        XCTAssertTrue(entryExists(fixture.paths.agent.outboxDirectory))
    }

    func testCompleteRemovalDeletesSupportAndExactCommandButPreservesUnrelatedSiblings() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let unrelatedBefore = try fixture.unrelatedFingerprint()
        let remover = OwnedInstallationRemover(paths: fixture.paths)

        let session = try remover.prepareSession()
        let snapshot = try session.validatedQueueSnapshot()
        try session.discardValidatedQueue(snapshot)
        try removeEverythingThroughCoordinator(session: session, queueCount: snapshot.count)

        XCTAssertFalse(entryExists(fixture.paths.agent.supportDirectory))
        XCTAssertFalse(entryExists(fixture.paths.commandShim))
        XCTAssertFalse(entryExists(fixture.paths.legacyPlist))
        XCTAssertEqual(try fixture.unrelatedFingerprint(), unrelatedBefore)
        XCTAssertTrue(entryExists(fixture.paths.lifecycleLock))
    }

    func testEverySymlinkReplacementFailsBeforeAnyDeletionAndDoesNotTouchTarget() throws {
        let attacks: [(String, (RemovalFixture, URL) throws -> Void)] = [
            ("support", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.supportDirectory, target: target)
            }),
            ("state", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.stateDirectory, target: target)
            }),
            ("outbox", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.outboxDirectory, target: target)
            }),
            ("app", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.agentApplication, target: target)
            }),
            ("shim", { fixture, target in
                try replaceWithSymlink(fixture.paths.supportShim, target: target)
            }),
            ("plist", { fixture, target in
                try replaceWithSymlink(fixture.paths.legacyPlist, target: target)
            }),
        ]

        for (name, attack) in attacks {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let target = fixture.root.appendingPathComponent("outside-\(name)")
            try writePrivate(Data("outside-\(name)".utf8), to: target)
            try attack(fixture, target)
            var removals: [String] = []
            let remover = OwnedInstallationRemover(
                paths: fixture.paths,
                removalObserver: { removals.append($0) }
            )

            XCTAssertThrowsError(try remover.removeExecutableArtifacts(), name)
            XCTAssertTrue(removals.isEmpty, name)
            XCTAssertEqual(try Data(contentsOf: target), Data("outside-\(name)".utf8), name)
            XCTAssertTrue(entryExists(fixture.paths.commandShim), name)
            XCTAssertTrue(entryExists(fixture.paths.legacyPlist), name)
        }
    }

    func testWrongCommandTargetIsRejectedRatherThanUnlinked() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        try FileManager.default.removeItem(at: fixture.paths.commandShim)
        try FileManager.default.createSymbolicLink(
            at: fixture.paths.commandShim,
            withDestinationURL: fixture.unrelatedCommand
        )
        var removals: [String] = []

        XCTAssertThrowsError(
            try OwnedInstallationRemover(
                paths: fixture.paths,
                removalObserver: { removals.append($0) }
            ).removeExecutableArtifacts()
        )
        XCTAssertTrue(removals.isEmpty)
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: fixture.paths.commandShim.path),
            fixture.unrelatedCommand.path
        )
    }

    func testHardLinkUnexpectedEntryAndUnsafeStateOrOutboxNamesFailBeforeDeletion() throws {
        let mutations: [(String, (RemovalFixture) throws -> Void)] = [
            ("hard-linked-enrollment-secret", { fixture in
                try FileManager.default.removeItem(at: fixture.paths.enrollment)
                guard Darwin.link(
                    fixture.unrelatedCommand.path,
                    fixture.paths.enrollment.path
                ) == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
            }),
            ("nested-app-symlink", { fixture in
                try FileManager.default.createSymbolicLink(
                    at: fixture.paths.agent.agentApplication.appendingPathComponent("nested-link"),
                    withDestinationURL: fixture.unrelatedCommand
                )
            }),
            ("unexpected-top-level", { fixture in
                try writePrivate(
                    Data("unexpected".utf8),
                    to: fixture.paths.agent.supportDirectory.appendingPathComponent("other")
                )
            }),
            ("unsafe-state-name", { fixture in
                try writePrivate(
                    Data("unsafe".utf8),
                    to: fixture.paths.agent.stateDirectory.appendingPathComponent("secret.txt")
                )
            }),
            ("unsafe-outbox-name", { fixture in
                try writePrivate(
                    Data("unsafe".utf8),
                    to: fixture.paths.agent.outboxDirectory.appendingPathComponent("record.json")
                )
            }),
        ]

        for (name, mutate) in mutations {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            try mutate(fixture)
            var removals: [String] = []

            XCTAssertThrowsError(
                try OwnedInstallationRemover(
                    paths: fixture.paths,
                    removalObserver: { removals.append($0) }
                ).prepareSession(),
                name
            )
            XCTAssertTrue(removals.isEmpty, name)
            XCTAssertTrue(entryExists(fixture.paths.agent.agentApplication), name)
            XCTAssertTrue(entryExists(fixture.paths.commandShim), name)
        }
    }

    func testOwnerModeTypeAndDeviceMetadataFailuresBeginNoDeletion() throws {
        let changes: [(String, (inout stat) -> Void)] = [
            ("owner", { $0.st_uid = Darwin.geteuid() &+ 1 }),
            ("mode", { $0.st_mode = ($0.st_mode & ~mode_t(0o7777)) | 0o777 }),
            ("type", { $0.st_mode = ($0.st_mode & ~mode_t(S_IFMT)) | mode_t(S_IFCHR) }),
            ("device", { $0.st_dev = $0.st_dev &+ 1 }),
        ]

        for (name, change) in changes {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            var removals: [String] = []
            let remover = OwnedInstallationRemover(
                paths: fixture.paths,
                metadataTransform: { relative, metadata in
                    guard relative == "Runtime Raiders.app" else { return metadata }
                    var changed = metadata
                    change(&changed)
                    return changed
                },
                removalObserver: { removals.append($0) }
            )

            XCTAssertThrowsError(try remover.removeExecutableArtifacts(), name)
            XCTAssertTrue(removals.isEmpty, name)
            XCTAssertTrue(entryExists(fixture.paths.agent.agentApplication), name)
        }
    }

    func testDirectorySwapAfterValidationIsRejectedBeforeDeletion() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let displaced = fixture.root.appendingPathComponent("displaced-support", isDirectory: true)
        var removals: [String] = []
        let remover = OwnedInstallationRemover(
            paths: fixture.paths,
            validationCheckpoint: {
                try FileManager.default.moveItem(
                    at: fixture.paths.agent.supportDirectory,
                    to: displaced
                )
                try FileManager.default.createDirectory(
                    at: fixture.paths.agent.supportDirectory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            },
            removalObserver: { removals.append($0) }
        )

        XCTAssertThrowsError(try remover.removeExecutableArtifacts())
        XCTAssertTrue(removals.isEmpty)
        XCTAssertTrue(entryExists(displaced.appendingPathComponent("Runtime Raiders.app")))
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
        XCTAssertTrue(entryExists(fixture.paths.legacyPlist))
    }

    func testNestedStateDirectorySwapAfterValidationIsRejectedBeforeDeletion() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let displaced = fixture.root.appendingPathComponent("displaced-state", isDirectory: true)
        var removals: [String] = []
        let remover = OwnedInstallationRemover(
            paths: fixture.paths,
            validationCheckpoint: {
                try FileManager.default.moveItem(
                    at: fixture.paths.agent.stateDirectory,
                    to: displaced
                )
                try FileManager.default.createDirectory(
                    at: fixture.paths.agent.stateDirectory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            },
            removalObserver: { removals.append($0) }
        )

        XCTAssertThrowsError(try remover.removeExecutableArtifacts())
        XCTAssertTrue(removals.isEmpty)
        XCTAssertTrue(entryExists(displaced.appendingPathComponent("enrollment.json")))
        XCTAssertTrue(entryExists(fixture.paths.agent.agentApplication))
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
    }

    func testSuccessfulRemovalIsIdempotentInBothModes() throws {
        let preserve = try RemovalFixture()
        defer { preserve.remove() }
        let preserveRemover = OwnedInstallationRemover(paths: preserve.paths)
        try preserveRemover.removeExecutableArtifacts()
        try preserveRemover.removeExecutableArtifacts()
        XCTAssertTrue(entryExists(preserve.paths.enrollment))

        let complete = try RemovalFixture()
        defer { complete.remove() }
        let completeRemover = OwnedInstallationRemover(paths: complete.paths)
        var session = try completeRemover.prepareSession()
        var snapshot = try session.validatedQueueSnapshot()
        try session.discardValidatedQueue(snapshot)
        try removeEverythingThroughCoordinator(session: session, queueCount: snapshot.count)
        session = try completeRemover.prepareSession()
        snapshot = try session.validatedQueueSnapshot()
        try removeEverythingThroughCoordinator(session: session, queueCount: snapshot.count)
        XCTAssertFalse(entryExists(complete.paths.agent.supportDirectory))
    }

    func testValidatedQueueSnapshotRejectsMalformedOversizedAndChangedRecordsBeforeDeletion() throws {
        let mutations: [(String, (RemovalFixture, OwnedInstallationRemovalSession, RemovalQueueSnapshot) throws -> Void)] = [
            ("added", { fixture, _, _ in
                try writePrivate(Data("malformed".utf8), to: fixture.paths.agent.outboxDirectory.appendingPathComponent(String(repeating: "b", count: 64) + ".json"))
            }),
            ("removed", { fixture, _, snapshot in
                try FileManager.default.removeItem(at: fixture.paths.agent.outboxDirectory.appendingPathComponent(snapshot.names[0]))
            }),
            ("changed", { fixture, _, snapshot in
                try writePrivateReplacing(Data("changed".utf8), at: fixture.paths.agent.outboxDirectory.appendingPathComponent(snapshot.names[0]))
            }),
        ]

        for (name, mutate) in mutations {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let session = try OwnedInstallationRemover(paths: fixture.paths).prepareSession()
            let snapshot = try session.validatedQueueSnapshot()
            try mutate(fixture, session, snapshot)

            XCTAssertThrowsError(try session.discardValidatedQueue(snapshot), name)
            XCTAssertTrue(entryExists(fixture.paths.agent.supportDirectory), name)
            XCTAssertTrue(entryExists(fixture.paths.commandShim), name)
        }

        let oversized = try RemovalFixture()
        defer { oversized.remove() }
        let record = try XCTUnwrap(try FileManager.default.contentsOfDirectory(
            at: oversized.paths.agent.outboxDirectory,
            includingPropertiesForKeys: nil
        ).first)
        try writePrivateReplacing(Data(repeating: 0x41, count: 65_537), at: record)
        XCTAssertThrowsError(try OwnedInstallationRemover(paths: oversized.paths).prepareSession())
        XCTAssertTrue(entryExists(oversized.paths.commandShim))
    }

    func testZeroQueueSnapshotMustRemainExactlyEmptyBeforeCompleteDeletion() throws {
        let fixture = try RemovalFixture(includeQueuedRecord: false)
        defer { fixture.remove() }
        let session = try OwnedInstallationRemover(paths: fixture.paths).prepareSession()
        let snapshot = try session.validatedQueueSnapshot()
        XCTAssertEqual(snapshot.count, 0)
        try enqueueCanonicalEvent(in: fixture.paths.agent.outboxDirectory, sequence: 2)

        XCTAssertThrowsError(try session.verifyQueueEmpty(snapshot))
        XCTAssertTrue(entryExists(fixture.paths.agent.supportDirectory))
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
    }

    func testRetainedSessionRejectsEnrollmentStateOutboxAndParentSwaps() throws {
        let attacks: [(String, (RemovalFixture) throws -> Void)] = [
            ("enrollment", { fixture in
                try writePrivateReplacing(try validEnrollmentData(tokenByte: 0x22), at: fixture.paths.enrollment)
            }),
            ("state", { fixture in
                try swapDirectory(fixture.paths.agent.stateDirectory, under: fixture.root, replacementName: "replacement-state")
            }),
            ("outbox", { fixture in
                try swapDirectory(fixture.paths.agent.outboxDirectory, under: fixture.root, replacementName: "replacement-outbox")
            }),
            ("application-support-parent", { fixture in
                try swapDirectory(fixture.paths.agent.supportDirectory.deletingLastPathComponent(), under: fixture.root, replacementName: "replacement-application-support")
            }),
        ]

        for (name, attack) in attacks {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let session = try OwnedInstallationRemover(paths: fixture.paths).prepareSession()
            let snapshot = try session.validatedQueueSnapshot()
            try attack(fixture)

            XCTAssertThrowsError(try session.loadEnrollment(), name)
            XCTAssertThrowsError(try session.discardValidatedQueue(snapshot), name)
            XCTAssertTrue(entryExists(fixture.paths.commandShim), name)
        }
    }

    func testEnrollmentSameInodeMutationBetweenValidationAndReadReturnsNoRevocationEvidence() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let originalInode = try inode(fixture.paths.enrollment)
        let replacement = try validEnrollmentData(tokenByte: 0x44)
        XCTAssertEqual(replacement.count, try Data(contentsOf: fixture.paths.enrollment).count)
        var checkpointCalls = 0
        let remover = OwnedInstallationRemover(
            paths: fixture.paths,
            enrollmentReadCheckpoint: {
                checkpointCalls += 1
                try writePrivateReplacing(replacement, at: fixture.paths.enrollment)
                XCTAssertEqual(try inode(fixture.paths.enrollment), originalInode)
            }
        )
        let session = try remover.prepareSession()
        var revocationEvidence: EnrollmentConfiguration?

        XCTAssertThrowsError(revocationEvidence = try session.loadEnrollment())
        XCTAssertNil(revocationEvidence)
        XCTAssertEqual(checkpointCalls, 1)
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
    }

    func testHeldSocketLifetimeLockPreventsSessionPreparationAndDeletion() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let lock = Darwin.open(fixture.socketLock.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(lock, 0)
        defer { Darwin.close(lock) }
        XCTAssertEqual(testRemovalFlock(lock, LOCK_EX | LOCK_NB), 0)
        defer { _ = testRemovalFlock(lock, LOCK_UN) }

        XCTAssertThrowsError(try OwnedInstallationRemover(paths: fixture.paths).prepareSession())
        XCTAssertTrue(entryExists(fixture.paths.agent.agentApplication))
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
    }

    func testSocketLifetimeLockRemainsHeldAfterUnlinkUntilSessionDestruction() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        var session: OwnedInstallationRemovalSession? = try OwnedInstallationRemover(
            paths: fixture.paths
        ).prepareSession()
        let contender = Darwin.open(
            fixture.socketLock.path,
            O_RDWR | O_NOFOLLOW | O_CLOEXEC
        )
        XCTAssertGreaterThanOrEqual(contender, 0)
        defer { Darwin.close(contender) }

        XCTAssertNotEqual(testRemovalFlock(contender, LOCK_EX | LOCK_NB), 0)
        try XCTUnwrap(session).removeExecutableArtifacts()
        XCTAssertFalse(entryExists(fixture.socketLock))
        XCTAssertNotEqual(testRemovalFlock(contender, LOCK_EX | LOCK_NB), 0)

        session = nil
        XCTAssertEqual(testRemovalFlock(contender, LOCK_EX | LOCK_NB), 0)
        XCTAssertEqual(testRemovalFlock(contender, LOCK_UN), 0)
    }

    func testCurrentStateInventoryAndEveryGrammarClassHasABoundedSize() throws {
        let limits: [(String, (RemovalFixture) -> URL, Int)] = [
            ("enrollment", { $0.paths.enrollment }, 65_537),
            ("journal", { $0.paths.recoveryJournal }, 16_385),
            ("collector", { $0.paths.agent.stateDirectory.appendingPathComponent("collector-state.json") }, 4 * 1_024 * 1_024 + 1),
            ("update-state", { $0.paths.agent.updateState }, 16_385),
            ("update-state-lock", { $0.paths.agent.updateLock }, 1),
            ("shim", { $0.paths.supportShim }, 4 * 1_024 * 1_024 + 1),
            ("owned-tree", { $0.paths.agent.supportDirectory.appendingPathComponent("releases/owned.dat") }, 512 * 1_024 * 1_024 + 1),
            ("signed-app", { $0.paths.agent.agentExecutable }, 512 * 1_024 * 1_024 + 1),
            ("plist", { $0.paths.legacyPlist }, 1 * 1_024 * 1_024 + 1),
        ]

        for (name, url, size) in limits {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            guard Darwin.truncate(url(fixture).path, off_t(size)) == 0 else { throw POSIXError(.EIO) }
            XCTAssertThrowsError(try OwnedInstallationRemover(paths: fixture.paths).prepareSession(), name)
            XCTAssertTrue(entryExists(fixture.paths.commandShim), name)
        }

        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        XCTAssertTrue(entryExists(fixture.paths.agent.updateLock))
        XCTAssertEqual(fixture.paths.agent.updateLock.lastPathComponent, "update-state.lock")
        XCTAssertNoThrow(try OwnedInstallationRemover(paths: fixture.paths).prepareSession())
    }

    func testMetadataFailuresAcrossStateOutboxCommandAndPlistBeginNoDeletion() throws {
        for branch in ["state", "outbox", "command", "legacy-plist"] {
            for mutation in MetadataMutation.allCases {
                let fixture = try RemovalFixture()
                defer { fixture.remove() }
                var removals: [String] = []
                let remover = OwnedInstallationRemover(
                    paths: fixture.paths,
                    metadataTransform: { relative, metadata in
                        guard relative == branch else { return metadata }
                        return mutation.applying(to: metadata)
                    },
                    removalObserver: { removals.append($0) }
                )
                XCTAssertThrowsError(try remover.prepareSession(), "\(branch)-\(mutation)")
                XCTAssertTrue(removals.isEmpty)
                XCTAssertTrue(entryExists(fixture.paths.commandShim))
            }
        }
    }

    func testPartialPreserveRemovalResumesAfterEarlyUnlinkAndDirectorySyncFailure() throws {
        for failAt in [2, 5] {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let unrelatedBefore = try fixture.unrelatedFingerprint()
            var mutationCount = 0
            let failing = OwnedInstallationRemover(
                paths: fixture.paths,
                removalObserver: { _ in
                    mutationCount += 1
                    if mutationCount == failAt { throw RemovalTestError.injected }
                }
            )

            XCTAssertThrowsError(try failing.removeExecutableArtifacts())
            try OwnedInstallationRemover(paths: fixture.paths).removeExecutableArtifacts()
            XCTAssertEqual(try fixture.unrelatedFingerprint(), unrelatedBefore)
            XCTAssertTrue(entryExists(fixture.paths.enrollment))
            XCTAssertFalse(entryExists(fixture.paths.commandShim))
        }
    }

    func testAtomicTemporaryFilesInheritTheirCanonicalSizeBounds() throws {
        let uuid = "11111111-1111-4111-8111-111111111111"
        let cases: [(String, Int)] = [
            (".enrollment.json.runtime-raiders-tmp-\(uuid)", 65_537),
            (".collector-state.json.runtime-raiders-tmp-\(uuid)", 4 * 1_024 * 1_024 + 1),
            (".update-state.json.runtime-raiders-tmp-\(uuid)", 16_385),
            (".re-enrollment.json.runtime-raiders-tmp-\(uuid)", 16_385),
        ]
        for (name, size) in cases {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let temporary = fixture.paths.agent.stateDirectory.appendingPathComponent(name)
            try writePrivate(Data(), to: temporary)
            XCTAssertEqual(Darwin.truncate(temporary.path, off_t(size)), 0)
            XCTAssertThrowsError(try OwnedInstallationRemover(paths: fixture.paths).prepareSession())
            XCTAssertTrue(entryExists(fixture.paths.commandShim))
        }

        let outbox = try RemovalFixture()
        defer { outbox.remove() }
        let temporaryName = ".\(String(repeating: "a", count: 64)).json.runtime-raiders-tmp-\(uuid)"
        let temporary = outbox.paths.agent.outboxDirectory.appendingPathComponent(temporaryName)
        try writePrivate(Data(), to: temporary)
        XCTAssertEqual(Darwin.truncate(temporary.path, 65_537), 0)
        XCTAssertThrowsError(try OwnedInstallationRemover(paths: outbox.paths).prepareSession())
        XCTAssertTrue(entryExists(outbox.paths.commandShim))
    }

    func testPartialCompleteRemovalResumesAfterEarlyUnlinksAndDirectorySync() throws {
        for failAt in [3, 8] {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let unrelatedBefore = try fixture.unrelatedFingerprint()
            var mutationCount = 0
            let failing = OwnedInstallationRemover(
                paths: fixture.paths,
                removalObserver: { _ in
                    mutationCount += 1
                    if mutationCount == failAt { throw RemovalTestError.injected }
                }
            )
            var first: OwnedInstallationRemovalSession? = try failing.prepareSession()

            XCTAssertThrowsError(
                try removalCoordinator(session: try XCTUnwrap(first)).run(mode: .everything)
            )
            first = nil

            let resumed = try OwnedInstallationRemover(paths: fixture.paths).prepareSession()
            try removeEverythingThroughCoordinator(session: resumed)
            XCTAssertFalse(entryExists(fixture.paths.agent.supportDirectory))
            XCTAssertFalse(entryExists(fixture.paths.commandShim))
            XCTAssertEqual(try fixture.unrelatedFingerprint(), unrelatedBefore)
        }
    }

    func testSupportParentSwapAfterAnEarlyUnlinkStopsAtTheSwapBoundary() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let displaced = fixture.root.appendingPathComponent("displaced-after-unlink", isDirectory: true)
        let replacementMarker = fixture.root.appendingPathComponent(
            "Library/Application Support/replacement-marker"
        )
        var observed: [String] = []
        let remover = OwnedInstallationRemover(
            paths: fixture.paths,
            removalObserver: { relative in
                observed.append(relative)
                guard observed.count == 2 else { return }
                try FileManager.default.moveItem(
                    at: fixture.paths.agent.supportDirectory,
                    to: displaced
                )
                try FileManager.default.createDirectory(
                    at: fixture.paths.agent.supportDirectory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
                try writePrivate(Data("replacement".utf8), to: replacementMarker)
            }
        )

        XCTAssertThrowsError(try remover.removeExecutableArtifacts())
        XCTAssertEqual(observed.count, 2)
        XCTAssertEqual(try Data(contentsOf: replacementMarker), Data("replacement".utf8))
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
    }

    func testLiveOperationsBindQueueAndEnrollmentAcrossRevocation() throws {
        enum Mutation: Equatable, Sendable {
            case corruptBeforeSummary, addQueueDuringRevoke, replaceEnrollmentDuringRevoke
        }
        for mutation in [Mutation.corruptBeforeSummary, .addQueueDuringRevoke, .replaceEnrollmentDuringRevoke] {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let record = try XCTUnwrap(try FileManager.default.contentsOfDirectory(
                at: fixture.paths.agent.outboxDirectory,
                includingPropertiesForKeys: nil
            ).first)
            if mutation == .corruptBeforeSummary {
                try writePrivateReplacing(Data("corrupt".utf8), at: record)
            }
            let trace = RemovalTrace()
            let client = try EnrollmentClient(
                origin: URL(string: "https://raiders.redlattice.com")!
            ) { _ in
                trace.actions.append("revoke")
                switch mutation {
                case .corruptBeforeSummary: break
                case .addQueueDuringRevoke:
                    try enqueueCanonicalEvent(in: fixture.paths.agent.outboxDirectory, sequence: 2)
                case .replaceEnrollmentDuringRevoke:
                    try writePrivateReplacing(
                        try validEnrollmentData(tokenByte: 0x44),
                        at: fixture.paths.enrollment
                    )
                }
                return UploadHTTPResponse(statusCode: 200, body: Data(#"{"revoked":true}"#.utf8))
            }
            let managed = ManagedAgentServiceController(operations: .init(
                register: {},
                unregister: { trace.actions.append("unregister") },
                status: { .notRegistered }
            ))
            let operations = RemovalOperations.live(
                paths: fixture.paths,
                managedAgent: managed,
                enrollmentClient: client,
                persistCollectionOff: { trace.actions.append("off") },
                stopDaemon: { trace.actions.append("stop") },
                summarize: { _ in trace.actions.append("summary") },
                confirmDiscard: { _ in true },
                confirmEverything: { true },
                delayMilliseconds: { _ in },
                acquireLock: { trace.actions.append("lock"); return TestRemovalLock() }
            )

            XCTAssertThrowsError(try RemovalCoordinator(operations: operations).run(mode: .everything))
            XCTAssertTrue(entryExists(fixture.paths.agent.supportDirectory))
            XCTAssertTrue(entryExists(fixture.paths.commandShim))
            if mutation == .corruptBeforeSummary {
                XCTAssertFalse(trace.actions.contains("summary"))
                XCTAssertFalse(trace.actions.contains("revoke"))
            } else {
                XCTAssertTrue(trace.actions.contains("revoke"), "\(mutation): \(trace.actions)")
                XCTAssertEqual(try FileManager.default.contentsOfDirectory(
                    atPath: fixture.paths.agent.outboxDirectory.path
                ).count, mutation == .addQueueDuringRevoke ? 2 : 1, "\(mutation): \(trace.actions)")
            }
        }
    }
}

private enum MetadataMutation: String, CaseIterable, CustomStringConvertible {
    case owner, mode, type, device

    var description: String { rawValue }

    func applying(to metadata: stat) -> stat {
        var result = metadata
        switch self {
        case .owner: result.st_uid = Darwin.geteuid() &+ 1
        case .mode: result.st_mode = (result.st_mode & ~mode_t(0o7777)) | 0o666
        case .type: result.st_mode = (result.st_mode & ~mode_t(S_IFMT)) | mode_t(S_IFCHR)
        case .device: result.st_dev = result.st_dev &+ 1
        }
        return result
    }
}

private func removeEverythingThroughCoordinator(
    session: OwnedInstallationRemovalSession,
    queueCount: Int = 0
) throws {
    let coordinator = removalCoordinator(session: session)
    XCTAssertEqual(try coordinator.run(mode: .everything), .removedEverything)
    _ = queueCount
}

private func removalCoordinator(
    session: OwnedInstallationRemovalSession
) -> RemovalCoordinator {
    let operations = RemovalOperations(
        acquireLock: { TestRemovalLock() },
        persistCollectionOff: {},
        stopDaemon: {},
        unregisterAgent: {},
        verifyAgentUnregistered: { true },
        prepareSession: { session },
        queueSnapshot: { try ($0 as! OwnedInstallationRemovalSession).validatedQueueSnapshot() },
        summarize: { _ in },
        confirmDiscard: { _ in true },
        confirmEverything: { true },
        loadEnrollment: { _ in nil },
        revoke: { _ in true },
        delayMilliseconds: { _ in },
        discardQueue: { removalSession, snapshot in
            try (removalSession as! OwnedInstallationRemovalSession).discardValidatedQueue(snapshot)
        },
        verifyQueueEmpty: { removalSession, snapshot in
            try (removalSession as! OwnedInstallationRemovalSession).verifyQueueEmpty(snapshot)
        },
        removeExecutableArtifacts: { removalSession in
            try (removalSession as! OwnedInstallationRemovalSession).removeExecutableArtifacts()
        },
        verifyPreservedState: { removalSession in
            try (removalSession as! OwnedInstallationRemovalSession).verifyPreservedState()
        },
        removeAllArtifacts: { removalSession, authorization in
            try (removalSession as! OwnedInstallationRemovalSession).removeAllArtifacts(
                authorization: authorization
            )
        },
        revocationProof: {}
    )
    return RemovalCoordinator(operations: operations)
}

private final class TestRemovalLock: RemovalLock, @unchecked Sendable {}
private enum RemovalTestError: Error { case injected }
private final class RemovalTrace: @unchecked Sendable { var actions: [String] = [] }

private final class RemovalFixture: @unchecked Sendable {
    let root: URL
    let paths: CompanionLifecyclePaths
    let unrelatedCommand: URL

    init(includeQueuedRecord: Bool = true) throws {
        root = URL(fileURLWithPath: "/private/tmp", isDirectory: true).appendingPathComponent(
            "r5-\(UUID().uuidString.prefix(8))",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        paths = try CompanionLifecyclePaths(homeDirectory: root)
        for directory in [
            root.appendingPathComponent("Library", isDirectory: true),
            root.appendingPathComponent("Library/Application Support", isDirectory: true),
            paths.agent.supportDirectory,
            paths.agent.stateDirectory,
            paths.agent.outboxDirectory,
            root.appendingPathComponent("Library/LaunchAgents", isDirectory: true),
            root.appendingPathComponent(".local", isDirectory: true),
            root.appendingPathComponent(".local/bin", isDirectory: true),
            root.appendingPathComponent(".codex", isDirectory: true),
            root.appendingPathComponent(".codex/sessions", isDirectory: true),
        ] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
        }

        let app = paths.agent.agentApplication
        for directory in [
            app,
            app.appendingPathComponent("Contents", isDirectory: true),
            app.appendingPathComponent("Contents/MacOS", isDirectory: true),
            app.appendingPathComponent("Contents/Resources", isDirectory: true),
            app.appendingPathComponent("Contents/Library", isDirectory: true),
            app.appendingPathComponent("Contents/Library/LaunchAgents", isDirectory: true),
        ] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o755]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: directory.path
            )
        }
        try writeFile(Data("agent".utf8), to: paths.agent.agentExecutable, mode: 0o755)
        try writeFile(Data("managed".utf8), to: paths.managedPlist, mode: 0o644)
        try writeFile(
            Data("resource".utf8),
            to: app.appendingPathComponent("Contents/Resources/data.bin"),
            mode: 0o644
        )
        try writeFile(Data("shim".utf8), to: paths.supportShim, mode: 0o700)
        try FileManager.default.createSymbolicLink(
            at: paths.commandShim,
            withDestinationURL: paths.supportShim
        )
        try writePrivate(Data("legacy".utf8), to: paths.legacyPlist)
        try makeUnixSocket(at: paths.agent.controlSocket)
        try writeFile(
            Data(),
            to: paths.agent.supportDirectory.appendingPathComponent(
                ".agent.sock.runtime-raiders.lock"
            ),
            mode: 0o600
        )

        try writePrivate(try validEnrollmentData(tokenByte: 0x11), to: paths.enrollment)
        try writePrivate(
            Data(#"{"enabled":false,"files":{},"version":1}"#.utf8),
            to: paths.agent.stateDirectory.appendingPathComponent("collector-state.json")
        )
        try writePrivate(Data(#"{"version":1}"#.utf8), to: paths.agent.stateDirectory.appendingPathComponent("update-state.json"))
        try writePrivate(Data("journal".utf8), to: paths.recoveryJournal)
        try writeFile(Data(), to: paths.agent.updateLock, mode: 0o600)
        if includeQueuedRecord {
            try enqueueCanonicalEvent(in: paths.agent.outboxDirectory, sequence: 1)
        }

        for name in ["releases", "installation", "launcher"] {
            let directory = paths.agent.supportDirectory.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            try writePrivate(Data(name.utf8), to: directory.appendingPathComponent("owned.dat"))
        }

        unrelatedCommand = root.appendingPathComponent(".local/bin/unrelated")
        try writePrivate(Data("keep-command".utf8), to: unrelatedCommand)
        try writePrivate(
            Data("keep-plist".utf8),
            to: root.appendingPathComponent("Library/LaunchAgents/unrelated.plist")
        )
        let unrelatedSupport = root.appendingPathComponent(
            "Library/Application Support/Unrelated",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: unrelatedSupport,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        try writePrivate(Data("keep-support".utf8), to: unrelatedSupport.appendingPathComponent("data"))
        try writePrivate(
            Data("keep-session".utf8),
            to: root.appendingPathComponent(".codex/sessions/session.jsonl")
        )
        try writeFile(Data(), to: paths.lifecycleLock, mode: 0o600)
    }

    var executableArtifacts: [URL] {
        [
            paths.agent.agentApplication,
            paths.supportShim,
            paths.commandShim,
            paths.agent.controlSocket,
            paths.agent.supportDirectory.appendingPathComponent(
                ".agent.sock.runtime-raiders.lock"
            ),
            paths.legacyPlist,
            paths.agent.supportDirectory.appendingPathComponent("releases"),
            paths.agent.supportDirectory.appendingPathComponent("installation"),
            paths.agent.supportDirectory.appendingPathComponent("launcher"),
        ]
    }

    var socketLock: URL {
        paths.agent.supportDirectory.appendingPathComponent(
            ".agent.sock.runtime-raiders.lock"
        )
    }

    func protectedFingerprint() throws -> [String: String] {
        try fingerprint([
            paths.agent.stateDirectory,
            paths.agent.outboxDirectory,
        ])
    }

    func unrelatedFingerprint() throws -> [String: String] {
        try fingerprint([
            root.appendingPathComponent(".local/bin/unrelated"),
            root.appendingPathComponent("Library/LaunchAgents/unrelated.plist"),
            root.appendingPathComponent("Library/Application Support/Unrelated"),
            root.appendingPathComponent(".codex/sessions"),
            paths.lifecycleLock,
        ])
    }

    func remove() { try? FileManager.default.removeItem(at: root) }
}

private func fingerprint(_ roots: [URL]) throws -> [String: String] {
    var result: [String: String] = [:]
    for root in roots {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else {
            result[root.path] = "absent"
            continue
        }
        if isDirectory.boolValue {
            let names = try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
            result[root.path] = "directory:\(try inode(root)):\(try fullMode(root)):\(names.joined(separator: ","))"
            for name in names {
                result.merge(
                    try fingerprint([root.appendingPathComponent(name)]),
                    uniquingKeysWith: { _, new in new }
                )
            }
        } else {
            let data = try Data(contentsOf: root)
            let mode = try fullMode(root)
            result[root.path] = "file:\(try inode(root)):\(mode):\(data.base64EncodedString())"
        }
    }
    return result
}

private func validEnrollmentData(tokenByte: UInt8) throws -> Data {
    let temporary = URL(
        fileURLWithPath: "/private/tmp/r5-enrollment-\(UUID().uuidString)",
        isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: temporary) }
    try FileManager.default.createDirectory(
        at: temporary,
        withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700]
    )
    let configuration = try EnrollmentConfiguration(
        deviceID: "11111111-1111-4111-8111-111111111111",
        deviceToken: Data(repeating: tokenByte, count: 32).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: ""),
        dedupeSecret: Data(repeating: 0x33, count: 32),
        serverURL: URL(string: "https://raiders.redlattice.com")!,
        cutoverAtMS: 0,
        enabledSurfaces: [.codexCLI, .codexDesktop]
    )
    try configuration.persist(to: temporary.appendingPathComponent("enrollment.json"))
    return try Data(contentsOf: temporary.appendingPathComponent("enrollment.json"))
}

private func enqueueCanonicalEvent(in directory: URL, sequence: Int64) throws {
    let outbox = try Outbox(directory: directory)
    let observedAt = 2_000 + sequence
    try outbox.enqueue(RunEventV1(
        schemaVersion: 1,
        companionVersion: "0.1.0",
        deviceID: "00000000-0000-4000-8000-000000000001",
        provider: .codex,
        surface: .codexCLI,
        runKey: String(repeating: "a", count: 64),
        sequence: sequence,
        eventTimeMS: observedAt - 500,
        observedAtMS: observedAt,
        startedAtMS: observedAt - 1_000,
        state: .open,
        usage: .init(input: sequence, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0),
        model: nil,
        effort: nil,
        idempotencyKey: String(format: "%064llx", sequence)
    ))
}

private func writePrivateReplacing(_ data: Data, at url: URL) throws {
    let descriptor = Darwin.open(url.path, O_WRONLY | O_TRUNC | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw POSIXError(.EIO) }
    defer { Darwin.close(descriptor) }
    try data.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
            if count > 0 { offset += count }
            else if count < 0, errno == EINTR { continue }
            else { throw POSIXError(.EIO) }
        }
    }
}

private func swapDirectory(_ url: URL, under root: URL, replacementName: String) throws {
    let displaced = root.appendingPathComponent("displaced-\(replacementName)", isDirectory: true)
    try FileManager.default.moveItem(at: url, to: displaced)
    try FileManager.default.createDirectory(
        at: url,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    try writePrivate(Data("replacement".utf8), to: url.appendingPathComponent(replacementName))
}

private func replaceWithSymlink(_ url: URL, target: URL) throws {
    try FileManager.default.removeItem(at: url)
    try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
}

private func writePrivate(_ data: Data, to url: URL) throws {
    try writeFile(data, to: url, mode: 0o600)
}

private func writeFile(_ data: Data, to url: URL, mode: Int) throws {
    guard FileManager.default.createFile(
        atPath: url.path,
        contents: data,
        attributes: [.posixPermissions: mode]
    ) else { throw CocoaError(.fileWriteUnknown) }
    try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
}

private func makeUnixSocket(at url: URL) throws {
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw POSIXError(.EIO) }
    defer { Darwin.close(descriptor) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(url.path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw POSIXError(.ENAMETOOLONG)
    }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        for index in buffer.indices { buffer[index] = 0 }
        for (index, byte) in bytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + bytes.count)
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(descriptor, $0, length)
        }
    }
    guard result == 0, Darwin.chmod(url.path, 0o600) == 0 else { throw POSIXError(.EIO) }
}

private func entryExists(_ url: URL) -> Bool {
    var metadata = stat()
    return Darwin.lstat(url.path, &metadata) == 0
}

private func fullMode(_ url: URL) throws -> Int {
    var metadata = stat()
    guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.EIO) }
    return Int(metadata.st_mode & 0o7777)
}

private func inode(_ url: URL) throws -> UInt64 {
    var metadata = stat()
    guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.EIO) }
    return UInt64(metadata.st_ino)
}

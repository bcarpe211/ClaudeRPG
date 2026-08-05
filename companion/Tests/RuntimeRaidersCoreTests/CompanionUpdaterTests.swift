import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class CompanionUpdaterTests: XCTestCase {
    func testAlreadyCurrentReturnsWithoutDownload() throws {
        try withHarness { harness in
            harness.manifest = harness.oldManifest

            XCTAssertEqual(try harness.makeUpdater().run(), .alreadyCurrent)
            XCTAssertEqual(harness.log.values, ["lock", "status", "fetch", "unlock"])
            XCTAssertFalse(harness.downloadCalled)
        }
    }

    func testInitialActiveRunRefusesBeforeDownload() throws {
        try withHarness { harness in
            harness.initialStatus = harness.oldStatus(activeRunCount: 1)

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .activeRun)
            }
            XCTAssertEqual(harness.log.values, ["lock", "status", "unlock"])
            XCTAssertFalse(harness.downloadCalled)
        }
    }

    func testSecondActiveRunCheckRefusesBeforeQuiescence() throws {
        try withHarness { harness in
            harness.preparedStatus = harness.oldStatus(activeRunCount: 1)
            harness.healthStatuses = [harness.oldStatus()]

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .activeRun)
            }
            XCTAssertTrue(harness.log.values.contains("status-recheck"))
            XCTAssertTrue(harness.log.values.contains("prepare-daemon"))
            XCTAssertEqual(harness.bootoutCallCount, 1)
            XCTAssertEqual(harness.bootstrapCallCount, 1)
            XCTAssertEqual(try harness.installedMarker(), "old")
        }
    }

    func testUpdateLockRefusesSymlinkWithoutTouchingTarget() throws {
        try withHarness { harness in
            let trap = harness.root.appendingPathComponent("DO_NOT_LOCK")
            try writeOwnerFile(Data("trap".utf8), to: trap)
            try FileManager.default.createSymbolicLink(
                at: harness.paths.updateLock,
                withDestinationURL: trap
            )

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .unsafeFilesystem)
            }
            XCTAssertEqual(try Data(contentsOf: trap), Data("trap".utf8))
            XCTAssertFalse(harness.log.values.contains("status"))
        }
    }

    func testDigestOrCandidateFailureNeverStopsDaemon() throws {
        try withHarness { harness in
            harness.receiptDigest = String(repeating: "d", count: 64)
            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .digestMismatch)
            }
            XCTAssertFalse(harness.log.values.contains("prepare-daemon"))
            XCTAssertFalse(harness.log.values.contains("bootout"))
        }
        try withHarness { harness in
            harness.candidateFailure = true
            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .candidateRejected)
            }
            XCTAssertFalse(harness.log.values.contains("prepare-daemon"))
            XCTAssertFalse(harness.log.values.contains("bootout"))
        }
    }

    func testInsufficientSpaceRefusesBeforeQuiescence() throws {
        try withHarness { harness in
            harness.availableCapacity = 0

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .insufficientSpace)
            }
            XCTAssertFalse(harness.log.values.contains("self-check"))
            XCTAssertFalse(harness.log.values.contains("status-recheck"))
            XCTAssertFalse(harness.log.values.contains("prepare-daemon"))
            XCTAssertFalse(harness.log.values.contains("bootout"))
        }
    }

    func testSuccessfulUpdatePreservesEnabledAndDisabledIntent() throws {
        for enabled in [true, false] {
            try withHarness { harness in
                harness.initialStatus = harness.oldStatus(enabled: enabled)
                harness.recheckStatus = harness.oldStatus(enabled: enabled)
                harness.preparedStatus = harness.oldStatus(enabled: enabled)
                harness.healthStatuses = [harness.newStatus(enabled: enabled)]
                try harness.setCollectorEnabled(enabled)

                XCTAssertEqual(
                    try harness.makeUpdater().run(),
                    .updated(from: harness.oldIdentity, to: harness.newIdentity)
                )
                XCTAssertEqual(
                    harness.log.values,
                    [
                        "lock", "status", "fetch", "download", "archive-validate",
                        "extract", "candidate-verify", "self-check", "status-recheck",
                        "prepare-daemon", "bootout", "swap", "bootstrap",
                        "health-verify", "cleanup", "unlock",
                    ]
                )
                XCTAssertEqual(try harness.installedMarker(), "new")
                XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
                XCTAssertEqual(
                    try AgentController.persistedEnabled(
                        paths: harness.paths,
                        surfaces: [.codexCLI]
                    ),
                    enabled
                )
            }
        }
    }

    func testPostSwapHealthFailureRestoresOldBundleAndState() throws {
        try withHarness { harness in
            harness.healthStatuses = [
                harness.newStatus(enabled: false),
                harness.oldStatus(enabled: true),
            ]
            let before = try harness.protectedBytes()

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .updateRolledBack)
            }

            XCTAssertEqual(try harness.installedMarker(), "old")
            XCTAssertEqual(try harness.protectedBytes(), before)
            XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.failedApplication.path))
        }
    }

    func testRollbackFailurePreservesBothBundlesAndPersistsDisabled() throws {
        try withHarness { harness in
            harness.healthStatuses = [harness.newStatus(enabled: false)]
            harness.beforeFirstHealth = {
                try FileManager.default.createDirectory(
                    at: harness.paths.failedApplication,
                    withIntermediateDirectories: false
                )
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: harness.paths.failedApplication.path
                )
            }
            let enrollmentBefore = try Data(contentsOf: harness.enrollment)
            let outboxBefore = try Data(contentsOf: harness.outboxRecord)

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(
                    error as? CompanionUpdaterError,
                    .rollbackFailed(recoveryCommand: CompanionUpdater.recoveryCommand)
                )
            }

            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.installedApplication.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
            XCTAssertEqual(try harness.installedMarker(), "new")
            XCTAssertEqual(try Data(contentsOf: harness.enrollment), enrollmentBefore)
            XCTAssertEqual(try Data(contentsOf: harness.outboxRecord), outboxBefore)
            XCTAssertEqual(
                try AgentController.persistedEnabled(paths: harness.paths, surfaces: [.codexCLI]),
                false
            )
            XCTAssertEqual(harness.recoveryCommands.values, [CompanionUpdater.recoveryCommand])
        }
    }

    func testConcurrentUpdateLockRefusesSecondUpdater() throws {
        try withHarness { harness in
            let enteredStatus = DispatchSemaphore(value: 0)
            let releaseStatus = DispatchSemaphore(value: 0)
            harness.beforeInitialStatus = {
                enteredStatus.signal()
                _ = releaseStatus.wait(timeout: .now() + 5)
            }
            let firstResult = LockedValues<Result<CompanionUpdateResult, Error>>([])
            let finished = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .utility).async {
                firstResult.append(Result { try harness.makeUpdater().run() })
                finished.signal()
            }
            XCTAssertEqual(enteredStatus.wait(timeout: .now() + 2), .success)

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .updateInProgress)
            }

            releaseStatus.signal()
            XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
            XCTAssertEqual(try firstResult.values.first?.get(), .updated(from: harness.oldIdentity, to: harness.newIdentity))
        }
    }

    func testFileTransactionCreatesOwnerOnlyWorkspaceAndUsesSiblingRenames() throws {
        try withTransaction { transaction, paths in
            XCTAssertEqual(try permissions(transaction.workspaceDirectory), 0o700)
            XCTAssertEqual(try permissions(transaction.stagingDirectory), 0o700)
            try makeFakeApp(transaction.candidateApplication, marker: "candidate")
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: transaction.candidateApplication.path
            )
            try transaction.sealValidatedCandidate()
            let installedInode = try inode(paths.installedApplication)
            let candidateInode = try inode(transaction.candidateApplication)

            try transaction.swap()

            XCTAssertEqual(try inode(paths.installedApplication), candidateInode)
            XCTAssertEqual(try inode(paths.rollbackApplication), installedInode)
            XCTAssertEqual(try permissions(paths.installedApplication), 0o700)
            XCTAssertEqual(try permissions(paths.rollbackApplication), 0o700)
            XCTAssertFalse(FileManager.default.fileExists(atPath: transaction.promotedCandidateApplication.path))
        }
    }

    func testFileTransactionNeverFollowsSymlinkTargets() throws {
        let root = temporaryURL("rr-updater-symlink")
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        try privateDirectory(paths.supportDirectory)
        let target = root.appendingPathComponent("DO_NOT_TOUCH", isDirectory: true)
        try makeFakeApp(target, marker: "trap")
        try FileManager.default.createSymbolicLink(
            at: paths.installedApplication,
            withDestinationURL: target
        )

        XCTAssertThrowsError(try UpdateFileTransaction(paths: paths))
        XCTAssertEqual(try marker(target), "trap")
    }

    func testRollbackMovesFailedCandidateAsideBeforeRestoringOldApp() throws {
        try withTransaction { transaction, paths in
            try makeFakeApp(transaction.candidateApplication, marker: "candidate")
            try transaction.sealValidatedCandidate()
            let oldInode = try inode(paths.installedApplication)
            let candidateInode = try inode(transaction.candidateApplication)
            try transaction.swap()

            try transaction.rollback()

            XCTAssertEqual(try inode(paths.installedApplication), oldInode)
            XCTAssertEqual(try inode(paths.failedApplication), candidateInode)
            XCTAssertFalse(FileManager.default.fileExists(atPath: paths.rollbackApplication.path))
        }
    }

    func testCleanupNeverDeletesOnlyVerifiedApplication() throws {
        try withTransaction { transaction, paths in
            try FileManager.default.moveItem(
                at: paths.installedApplication,
                to: paths.rollbackApplication
            )

            XCTAssertThrowsError(try transaction.cleanupAfterSuccess())
            XCTAssertTrue(FileManager.default.fileExists(atPath: paths.rollbackApplication.path))
        }
    }

    func testCleanupFailureAfterVerifiedHealthKeepsNewAppInstalled() throws {
        try withHarness { harness in
            let trap = harness.root.appendingPathComponent("DO_NOT_TOUCH_CLEANUP_TRAP")
            try Data("trap".utf8).write(to: trap)
            harness.beforeFirstHealth = {
                try FileManager.default.createSymbolicLink(
                    at: harness.paths.rollbackApplication.appendingPathComponent("0-trap"),
                    withDestinationURL: trap
                )
            }

            XCTAssertEqual(
                try harness.makeUpdater().run(),
                .updated(from: harness.oldIdentity, to: harness.newIdentity)
            )
            XCTAssertEqual(try harness.installedMarker(), "new")
            XCTAssertEqual(try Data(contentsOf: trap), Data("trap".utf8))
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
        }
    }

    func testFreshDiscoveryMayChangeOnlyUpdateStateThenAllProtectedBytesStayStable() throws {
        try withHarness { harness in
            let protectedBefore = try harness.protectedBytes()
            let updateBefore = try Data(contentsOf: harness.paths.updateState)
            harness.assertFrozenState = {
                XCTAssertEqual(try harness.protectedBytes(), protectedBefore)
            }

            _ = try harness.makeUpdater().run()

            let updateAfter = try Data(contentsOf: harness.paths.updateState)
            XCTAssertNotEqual(updateBefore, updateAfter)
            XCTAssertEqual(
                try UpdateStateStore(paths: harness.paths).load().cachedManifest,
                harness.manifest
            )
            try harness.assertFrozenState()
        }
    }

    func testOnlyFreshFetchMayChangeUpdateState() throws {
        try withHarness { harness in
            harness.beforeInitialStatus = {
                try! writeOwnerFile(
                    Data("{\"lastCheckAttemptMS\":2,\"version\":1}".utf8),
                    to: harness.paths.updateState
                )
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .protectedStateChanged)
            }
            XCTAssertFalse(harness.log.values.contains("fetch"))
        }
    }

    func testCandidateContentSealRejectsSameLengthRewriteWithRestoredModificationTime() throws {
        try withHarness { harness in
            harness.candidateVerificationSideEffect = { candidate in
                try rewriteSameLengthRestoringModificationTime(
                    candidate.appendingPathComponent("marker"),
                    with: Data("bad".utf8)
                )
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .unsafeFilesystem)
            }
            XCTAssertEqual(try harness.installedMarker(), "old")
            XCTAssertFalse(harness.log.values.contains("prepare-daemon"))
        }
    }

    func testCandidateSealRejectsPathnameSubstitutionAfterVerification() throws {
        try withHarness { harness in
            harness.candidateVerificationSideEffect = { candidate in
                let displaced = candidate.deletingLastPathComponent()
                    .appendingPathComponent("verified-but-displaced.app", isDirectory: true)
                try FileManager.default.moveItem(at: candidate, to: displaced)
                try makeFakeApp(candidate, marker: "new")
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .unsafeFilesystem)
            }
            XCTAssertEqual(try harness.installedMarker(), "old")
        }
    }

    func testCandidateContentSealIsRecheckedAfterSelfCheck() throws {
        try withHarness { harness in
            harness.selfCheckSideEffect = { executable in
                try rewriteSameLengthRestoringModificationTime(
                    executable.deletingLastPathComponent().deletingLastPathComponent()
                        .deletingLastPathComponent().appendingPathComponent("marker"),
                    with: Data("bad".utf8)
                )
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .unsafeFilesystem)
            }
            XCTAssertFalse(harness.log.values.contains("prepare-daemon"))
            XCTAssertEqual(try harness.installedMarker(), "old")
        }
    }

    func testPriorBundleSealRejectsSameMetadataRewriteBeforeRollback() throws {
        try withHarness { harness in
            harness.healthStatuses = [harness.newStatus(enabled: false)]
            harness.beforeFirstHealth = {
                try rewriteSameLengthRestoringModificationTime(
                    harness.paths.rollbackApplication.appendingPathComponent("marker"),
                    with: Data("bad".utf8)
                )
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .terminalSafetyFailure)
            }
            XCTAssertTrue(harness.recoveryCommands.values.isEmpty)
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
        }
    }

    func testCleanupRetainsRollbackWhenInstalledCandidateChangesAfterHealth() throws {
        try withHarness { harness in
            harness.beforeCleanup = {
                try! rewriteSameLengthRestoringModificationTime(
                    harness.paths.installedApplication.appendingPathComponent("marker"),
                    with: Data("bad".utf8)
                )
            }

            XCTAssertEqual(
                try harness.makeUpdater().run(),
                .updated(from: harness.oldIdentity, to: harness.newIdentity)
            )
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
            XCTAssertThrowsError(try harness.makeUpdater().run())
        }
    }

    func testCleanupRetainsRollbackWhenPriorBundleChangesAfterHealth() throws {
        try withHarness { harness in
            harness.beforeCleanup = {
                try! rewriteSameLengthRestoringModificationTime(
                    harness.paths.rollbackApplication.appendingPathComponent("marker"),
                    with: Data("bad".utf8)
                )
            }

            XCTAssertEqual(
                try harness.makeUpdater().run(),
                .updated(from: harness.oldIdentity, to: harness.newIdentity)
            )
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
        }
    }

    func testCleanupRetainsRollbackOnInstalledPathnameSubstitutionAfterHealth() throws {
        try withHarness { harness in
            harness.beforeCleanup = {
                let displaced = harness.paths.supportDirectory
                    .appendingPathComponent("substituted-healthy-candidate.app", isDirectory: true)
                try! FileManager.default.moveItem(at: harness.paths.installedApplication, to: displaced)
                try! makeFakeApp(harness.paths.installedApplication, marker: "new")
            }

            XCTAssertEqual(
                try harness.makeUpdater().run(),
                .updated(from: harness.oldIdentity, to: harness.newIdentity)
            )
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
            XCTAssertTrue(
                FileManager.default.fileExists(
                    atPath: harness.paths.supportDirectory
                        .appendingPathComponent("substituted-healthy-candidate.app").path
                )
            )
        }
    }

    func testArchiveDigestSealRejectsInPlaceSameLengthRewriteBeforeExtraction() throws {
        try withHarness { harness in
            harness.extractionSideEffect = { archive in
                let original = try Data(contentsOf: archive)
                var changed = original
                let payload = try XCTUnwrap(changed.range(of: Data("abc".utf8)))
                changed.replaceSubrange(payload, with: Data("xyz".utf8))
                try rewriteSameLengthRestoringModificationTime(archive, with: changed)
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .digestMismatch)
            }
            XCTAssertFalse(harness.log.values.contains("prepare-daemon"))
            XCTAssertEqual(try harness.installedMarker(), "old")
        }
    }

    func testAcceptedPrepareWithLostResponseRestartsUnchangedInstalledApplication() throws {
        try withHarness { harness in
            harness.prepareSideEffect = { throw InjectedUpdaterFailure.responseLost }
            harness.healthStatuses = [harness.oldStatus()]

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? InjectedUpdaterFailure, .responseLost)
            }
            XCTAssertEqual(harness.bootoutCallCount, 1)
            XCTAssertEqual(harness.bootstrapCallCount, 1)
            XCTAssertEqual(try harness.installedMarker(), "old")
            XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.rollbackApplication.path))
        }
    }

    func testInvalidPrepareResponseRestartsUnchangedInstalledApplication() throws {
        try withHarness { harness in
            harness.preparedStatus = harness.oldStatus(activeRunCount: 1)
            harness.healthStatuses = [harness.oldStatus()]

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .activeRun)
            }
            XCTAssertEqual(harness.bootoutCallCount, 1)
            XCTAssertEqual(harness.bootstrapCallCount, 1)
            XCTAssertEqual(try harness.installedMarker(), "old")
        }
    }

    func testProtectedStateMutationWinsOverFetchThrow() throws {
        try withHarness { harness in
            harness.fetchSideEffect = {
                try writeOwnerFile(Data("changed-enrollment".utf8), to: harness.enrollment)
                throw InjectedUpdaterFailure.operation
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .protectedStateChanged)
            }
        }
    }

    func testProtectedStateMutationWinsOverDownloadThrow() throws {
        try withHarness { harness in
            harness.downloadSideEffect = { _ in
                try writeOwnerFile(
                    Data("changed-collector".utf8),
                    to: harness.paths.stateDirectory.appendingPathComponent("collector-state.json")
                )
                throw InjectedUpdaterFailure.operation
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .protectedStateChanged)
            }
        }
    }

    func testProtectedStateMutationWinsOverNonzeroSelfCheck() throws {
        try withHarness { harness in
            harness.selfCheckSideEffect = { _ in
                try writeOwnerFile(Data("changed-outbox".utf8), to: harness.outboxRecords[1])
            }
            harness.selfCheckResult = .init(
                exitStatus: .exited(9),
                stdout: Data(),
                stderr: Data("failed".utf8)
            )

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .protectedStateChanged)
            }
        }
    }

    func testTerminalRecoveryRestoresStableVerifiedRollbackBeforeEmittingCommand() throws {
        for failure in RecoveryFailure.allCases {
            try withHarness { harness in
                harness.healthStatuses = [
                    harness.newStatus(enabled: false),
                    harness.oldStatus(enabled: true),
                ]
                switch failure {
                case .bootstrap:
                    harness.bootstrapSideEffect = { call in
                        if call == 1 { throw InjectedUpdaterFailure.operation }
                    }
                case .health:
                    harness.healthStatuses = [
                        harness.newStatus(enabled: false),
                        harness.newStatus(enabled: false),
                    ]
                case .protectedSnapshot:
                    harness.healthSideEffect = { call in
                        if call == 2 {
                            try writeOwnerFile(Data("changed-enrollment".utf8), to: harness.enrollment)
                        }
                    }
                case .cleanup:
                    harness.healthSideEffect = { call in
                        if call == 2 { try harness.installWorkspaceCleanupTrap() }
                    }
                }

                XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                    XCTAssertEqual(
                        error as? CompanionUpdaterError,
                        .rollbackFailed(recoveryCommand: CompanionUpdater.recoveryCommand),
                        "failure: \(failure)"
                    )
                }
                XCTAssertEqual(try marker(harness.paths.rollbackApplication), "old")
                XCTAssertTrue(
                    FileManager.default.fileExists(atPath: harness.paths.failedApplication.path),
                    "missing failed candidate for \(failure)"
                )
                if FileManager.default.fileExists(atPath: harness.paths.failedApplication.path) {
                    XCTAssertEqual(try marker(harness.paths.failedApplication), "new")
                }
                XCTAssertTrue(
                    FileManager.default.fileExists(
                        atPath: harness.paths.rollbackApplication
                            .appendingPathComponent("Contents/MacOS/runtime-raiders-agent").path
                    )
                )
                XCTAssertEqual(harness.recoveryCommands.values, [CompanionUpdater.recoveryCommand])
            }
        }
    }

    func testTerminalRecoveryDoesNotEmitCommandWhenDisabledPersistenceFails() throws {
        try withHarness { harness in
            harness.healthStatuses = [harness.newStatus(enabled: false)]
            harness.bootoutSideEffect = { call in
                guard call == 1 else { return }
                let state = harness.paths.stateDirectory.appendingPathComponent("collector-state.json")
                try FileManager.default.removeItem(at: state)
                try FileManager.default.createDirectory(at: state, withIntermediateDirectories: false)
            }

            XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .terminalSafetyFailure)
            }
            XCTAssertTrue(harness.recoveryCommands.values.isEmpty)
        }
    }

    func testCandidateAuditRejectsHardlinkedRegularFile() throws {
        try withTransaction { transaction, _ in
            try makeFakeApp(transaction.candidateApplication, marker: "candidate")
            let marker = transaction.candidateApplication.appendingPathComponent("marker")
            let alias = transaction.candidateApplication.appendingPathComponent("marker-alias")
            guard Darwin.link(marker.path, alias.path) == 0 else { throw POSIXError(.EIO) }

            XCTAssertThrowsError(try transaction.sealValidatedCandidate()) { error in
                XCTAssertEqual(error as? CompanionUpdaterError, .unsafeFilesystem)
            }
        }
    }

    private func withHarness(_ body: (UpdaterHarness) throws -> Void) throws {
        let harness = try UpdaterHarness()
        defer { try? FileManager.default.removeItem(at: harness.root) }
        try body(harness)
    }

    private func withTransaction(
        _ body: (UpdateFileTransaction, AgentPaths) throws -> Void
    ) throws {
        let root = temporaryURL("rr-file-transaction")
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        try privateDirectory(paths.supportDirectory)
        try makeFakeApp(paths.installedApplication, marker: "installed")
        let transaction = try UpdateFileTransaction(paths: paths)
        try body(transaction, paths)
    }
}

private final class UpdaterHarness: @unchecked Sendable {
    let root = temporaryURL("rr-companion-updater")
    let paths: AgentPaths
    let oldIdentity = CompanionReleaseIdentity(
        releaseSequence: 1,
        releaseSHA: String(repeating: "c", count: 40),
        companionVersion: "0.2.0",
        updateProtocolVersion: 1
    )
    let newIdentity = CompanionReleaseIdentity(
        releaseSequence: 2,
        releaseSHA: String(repeating: "a", count: 40),
        companionVersion: "0.2.1",
        updateProtocolVersion: 1
    )
    let log = LockedValues<String>([])
    let recoveryCommands = LockedValues<String>([])
    let enrollment: URL
    let outboxRecords: [URL]
    var outboxRecord: URL { outboxRecords[0] }
    var manifest: ReleaseManifestV1
    var initialStatus: CompanionUpdateStatus
    var recheckStatus: CompanionUpdateStatus
    var preparedStatus: CompanionUpdateStatus
    var healthStatuses: [CompanionUpdateStatus]
    var receiptDigest: String
    var availableCapacity = Int64.max
    var candidateFailure = false
    var downloadCalled = false
    var beforeInitialStatus: () -> Void = {}
    var beforeFirstHealth: () throws -> Void = {}
    var fetchSideEffect: () throws -> Void = {}
    var downloadSideEffect: (URL) throws -> Void = { _ in }
    var extractionSideEffect: (URL) throws -> Void = { _ in }
    var candidateVerificationSideEffect: (URL) throws -> Void = { _ in }
    var selfCheckSideEffect: (URL) throws -> Void = { _ in }
    var selfCheckResult: SystemCommandResult?
    var prepareSideEffect: () throws -> Void = {}
    var bootoutSideEffect: (Int) throws -> Void = { _ in }
    var bootstrapSideEffect: (Int) throws -> Void = { _ in }
    var healthSideEffect: (Int) throws -> Void = { _ in }
    var beforeCleanup: () -> Void = {}
    var assertFrozenState: () throws -> Void = {}
    private var statusCalls = 0
    private var healthCalls = 0
    private var bootoutCalls = 0
    private var bootstrapCalls = 0
    private var healthNow: TimeInterval = 0
    private var releaseCheckNow: Int64 = 1_800_000_000_000
    private let variableLock = NSLock()

    var bootoutCallCount: Int { variableLock.withLock { bootoutCalls } }
    var bootstrapCallCount: Int { variableLock.withLock { bootstrapCalls } }

    init() throws {
        paths = AgentPaths(applicationSupportDirectory: root)
        enrollment = paths.stateDirectory.appendingPathComponent("enrollment.json")
        let archiveDigest = sha256Hex(testArchiveData())
        receiptDigest = archiveDigest
        manifest = try makeManifest(identity: newIdentity, zipSHA256: archiveDigest)
        let verifiedOld = VerifiedCompanionApplication(identity: oldIdentity, teamIdentifier: "REDLATTICE")
        let verifiedNew = VerifiedCompanionApplication(identity: newIdentity, teamIdentifier: "REDLATTICE")
        initialStatus = CompanionUpdateStatus(
            verifiedApplication: verifiedOld,
            daemonRunning: true,
            enabled: true,
            enrollmentValid: true,
            collectorStateValid: true,
            activeRunCount: 0,
            queuedEventCount: 2
        )
        recheckStatus = initialStatus
        preparedStatus = initialStatus
        healthStatuses = [CompanionUpdateStatus(
            verifiedApplication: verifiedNew,
            daemonRunning: true,
            enabled: true,
            enrollmentValid: true,
            collectorStateValid: true,
            activeRunCount: 0,
            queuedEventCount: 2
        )]

        try privateDirectory(paths.supportDirectory)
        try privateDirectory(paths.stateDirectory)
        try privateDirectory(paths.outboxDirectory)
        try makeFakeApp(paths.installedApplication, marker: "old")
        try writeOwnerFile(
            Data(#"{"cutover_at":1700000000000,"dedupe_secret":"abababababababababababababababababababababababababababababababab","device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","enabled_surfaces":["codex_cli"],"server_url":"http://127.0.0.1:8765","version":1}"#.utf8),
            to: enrollment
        )
        let outbox = try Outbox(directory: paths.outboxDirectory)
        try outbox.enqueue(makeUpdaterEvent(sequence: 1))
        try outbox.enqueue(makeUpdaterEvent(sequence: 2))
        outboxRecords = try outbox.records(limit: 100).map(\.url)

        let providerRoot = root.appendingPathComponent("codex", isDirectory: true)
        try privateDirectory(providerRoot)
        let provider = providerRoot.appendingPathComponent("nested-snapshot.jsonl")
        try Data("{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"fixture\",\"originator\":\"originator\",\"source\":\"exec\",\"cli_version\":\"0.146.0-alpha.3.1\"}}\n".utf8).write(to: provider)
        let registry = try AdapterRegistry.enabled(surfaces: [.codexCLI], codexRoot: providerRoot)
        let controller = try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: .init(
                companionVersion: "0.2.0",
                deviceID: "00000000-0000-4000-8000-000000000001",
                dedupeSecret: Data("fixture-secret".utf8)
            )
        )
        try controller.turnOn(existingFiles: [provider])
        try UpdateStateStore(paths: paths).save(UpdateStateV1(lastCheckAttemptMS: 1))
    }

    var oldManifest: ReleaseManifestV1 {
        try! makeManifest(identity: oldIdentity, zipSHA256: sha256Hex(testArchiveData()))
    }

    func oldStatus(enabled: Bool = true, activeRunCount: Int = 0) -> CompanionUpdateStatus {
        CompanionUpdateStatus(
            verifiedApplication: .init(identity: oldIdentity, teamIdentifier: "REDLATTICE"),
            daemonRunning: true,
            enabled: enabled,
            enrollmentValid: true,
            collectorStateValid: true,
            activeRunCount: activeRunCount,
            queuedEventCount: 2
        )
    }

    func newStatus(enabled: Bool = true) -> CompanionUpdateStatus {
        CompanionUpdateStatus(
            verifiedApplication: .init(identity: newIdentity, teamIdentifier: "REDLATTICE"),
            daemonRunning: true,
            enabled: enabled,
            enrollmentValid: true,
            collectorStateValid: true,
            activeRunCount: 0,
            queuedEventCount: 2
        )
    }

    func makeUpdater() -> CompanionUpdater {
        CompanionUpdater(
            paths: paths,
            surfaces: [.codexCLI],
            operations: CompanionUpdaterOperations(
                status: {
                    let call = self.variableLock.withLock { () -> Int in
                        defer { self.statusCalls += 1 }
                        return self.statusCalls
                    }
                    if call == 0 {
                        self.beforeInitialStatus()
                        return self.initialStatus
                    }
                    return self.recheckStatus
                },
                fetchManifest: {
                    try self.fetchSideEffect()
                    let now = self.variableLock.withLock { () -> Int64 in
                        defer { self.releaseCheckNow += 24 * 60 * 60 * 1_000 + 1 }
                        return self.releaseCheckNow
                    }
                    let body = manifestData(self.manifest)
                    let checker = try ReleaseChecker(
                        paths: self.paths,
                        installed: self.oldIdentity,
                        transport: { _ in .init(statusCode: 200, body: body) },
                        notifier: { true },
                        clockMS: { now }
                    )
                    guard case .checked = checker.checkIfDue() else {
                        throw InjectedUpdaterFailure.operation
                    }
                    return self.manifest
                },
                downloadArchive: { source, destination, digest in
                    self.downloadCalled = true
                    XCTAssertEqual(source, self.manifest.zipURL)
                    XCTAssertEqual(digest, self.manifest.zipSHA256)
                    let archive = testArchiveData()
                    try archive.write(to: destination)
                    try FileManager.default.setAttributes(
                        [.posixPermissions: 0o600],
                        ofItemAtPath: destination.path
                    )
                    try self.downloadSideEffect(destination)
                    return DownloadReceipt(byteCount: Int64(archive.count), sha256: self.receiptDigest)
                },
                runCommand: { executable, arguments, _ in
                    if executable.path == "/usr/bin/ditto" {
                        XCTAssertEqual(arguments.prefix(2), ["-x", "-k"])
                        try self.extractionSideEffect(URL(fileURLWithPath: arguments[2]))
                        let staging = URL(fileURLWithPath: arguments[3], isDirectory: true)
                        try makeFakeApp(
                            staging.appendingPathComponent("Runtime Raiders Agent.app", isDirectory: true),
                            marker: "new"
                        )
                        return .init(exitStatus: .exited(0), stdout: Data(), stderr: Data())
                    }
                    XCTAssertEqual(executable.lastPathComponent, "runtime-raiders-agent")
                    XCTAssertEqual(arguments, ["__self-check"])
                    try self.selfCheckSideEffect(executable)
                    if let selfCheckResult = self.selfCheckResult { return selfCheckResult }
                    return .init(
                        exitStatus: .exited(0),
                        stdout: selfCheckData(self.newIdentity),
                        stderr: Data()
                    )
                },
                verifyCandidate: { candidate, manifest, installed in
                    XCTAssertEqual(candidate.lastPathComponent, "Runtime Raiders Agent.app")
                    XCTAssertEqual(installed.identity, self.oldIdentity)
                    XCTAssertEqual(installed.teamIdentifier, "REDLATTICE")
                    XCTAssertEqual(manifest, self.manifest)
                    try self.candidateVerificationSideEffect(candidate)
                    if self.candidateFailure { throw CompanionUpdaterError.candidateRejected }
                    return self.newIdentity
                },
                availableCapacity: { _ in self.availableCapacity },
                prepareDaemon: {
                    try self.assertFrozenState()
                    try self.prepareSideEffect()
                    return self.preparedStatus
                },
                bootout: {
                    let call = self.variableLock.withLock { () -> Int in
                        defer { self.bootoutCalls += 1 }
                        return self.bootoutCalls
                    }
                    try self.bootoutSideEffect(call)
                    try self.assertFrozenState()
                },
                bootstrap: {
                    let call = self.variableLock.withLock { () -> Int in
                        defer { self.bootstrapCalls += 1 }
                        return self.bootstrapCalls
                    }
                    try self.bootstrapSideEffect(call)
                    try self.assertFrozenState()
                },
                healthStatus: {
                    let index = self.variableLock.withLock { () -> Int in
                        defer { self.healthCalls += 1 }
                        return self.healthCalls
                    }
                    if index == 0 { try self.beforeFirstHealth() }
                    try self.healthSideEffect(index)
                    try self.assertFrozenState()
                    return self.healthStatuses[min(index, self.healthStatuses.count - 1)]
                },
                emitRecoveryCommand: { self.recoveryCommands.append($0) },
                observe: {
                    if $0 == .cleanup { self.beforeCleanup() }
                    self.log.append($0.rawValue)
                },
                monotonicNow: { self.variableLock.withLock { self.healthNow } },
                sleep: { interval in
                    self.variableLock.withLock { self.healthNow += max(interval, 10) }
                }
            )
        )
    }

    func installedMarker() throws -> String { try marker(paths.installedApplication) }

    func protectedBytes() throws -> [String: Data] {
        var bytes = [
            "enrollment": try Data(contentsOf: enrollment),
            "collector": try Data(contentsOf: paths.stateDirectory.appendingPathComponent("collector-state.json")),
        ]
        for (index, record) in outboxRecords.enumerated() {
            bytes["outbox-\(index)"] = try Data(contentsOf: record)
        }
        return bytes
    }

    func setCollectorEnabled(_ enabled: Bool) throws {
        if !enabled {
            try AgentController.persistDisabledForRecovery(paths: paths, surfaces: [.codexCLI])
        }
    }

    func installWorkspaceCleanupTrap() throws {
        let name = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(atPath: paths.supportDirectory.path)
                .first { $0.hasPrefix(".runtime-raiders-update-") }
        )
        let workspace = paths.supportDirectory.appendingPathComponent(name, isDirectory: true)
        let trapTarget = root.appendingPathComponent("DO_NOT_TOUCH_WORKSPACE_TRAP")
        try writeOwnerFile(Data("trap".utf8), to: trapTarget)
        try FileManager.default.createSymbolicLink(
            at: workspace.appendingPathComponent("staging/cleanup-trap"),
            withDestinationURL: trapTarget
        )
    }
}

private final class LockedValues<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Value]

    init(_ values: [Value]) { storage = values }
    var values: [Value] { lock.withLock { storage } }
    func append(_ value: Value) { lock.withLock { storage.append(value) } }
}

private enum InjectedUpdaterFailure: Error, Equatable {
    case operation
    case responseLost
}

private enum RecoveryFailure: String, CaseIterable {
    case bootstrap
    case health
    case protectedSnapshot
    case cleanup
}

private func temporaryURL(_ prefix: String) -> URL {
    URL(fileURLWithPath: "/private/tmp", isDirectory: true)
        .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
}

private func privateDirectory(_ directory: URL) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
}

private func writeOwnerFile(_ data: Data, to file: URL) throws {
    try data.write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
}

private func rewriteSameLengthRestoringModificationTime(_ file: URL, with data: Data) throws {
    var metadata = stat()
    guard Darwin.lstat(file.path, &metadata) == 0,
          metadata.st_mode & S_IFMT == S_IFREG,
          metadata.st_size == data.count else {
        throw POSIXError(.EINVAL)
    }
    try data.write(to: file)
    let times = [metadata.st_atimespec, metadata.st_mtimespec]
    let result = file.path.withCString { path in
        times.withUnsafeBufferPointer {
            Darwin.utimensat(AT_FDCWD, path, $0.baseAddress, AT_SYMLINK_NOFOLLOW)
        }
    }
    guard result == 0 else { throw POSIXError(.EIO) }
}

private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func makeManifest(
    identity: CompanionReleaseIdentity,
    zipSHA256: String
) throws -> ReleaseManifestV1 {
    try ReleaseManifestV1.decode(
        Data(
            "{\"manifest_version\":1,\"companion_version\":\"\(identity.companionVersion)\",\"release_sequence\":\(identity.releaseSequence),\"release_sha\":\"\(identity.releaseSHA)\",\"update_protocol_version\":\(identity.updateProtocolVersion),\"zip_sha256\":\"\(zipSHA256)\",\"zip_url\":\"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip\"}".utf8
        )
    )
}

private func manifestData(_ manifest: ReleaseManifestV1) -> Data {
    Data(
        "{\"manifest_version\":1,\"companion_version\":\"\(manifest.companionVersion)\",\"release_sequence\":\(manifest.releaseSequence),\"release_sha\":\"\(manifest.releaseSHA)\",\"update_protocol_version\":\(manifest.updateProtocolVersion),\"zip_sha256\":\"\(manifest.zipSHA256)\",\"zip_url\":\"\(manifest.zipURL.absoluteString)\"}".utf8
    )
}

private func makeUpdaterEvent(sequence: Int64) -> RunEventV1 {
    RunEventV1(
        schemaVersion: 1,
        companionVersion: "0.2.0",
        deviceID: "00000000-0000-4000-8000-000000000001",
        provider: .codex,
        surface: .codexCLI,
        runKey: String(repeating: "a", count: 64),
        sequence: sequence,
        eventTimeMS: 1_800_000_000_000 + sequence,
        observedAtMS: 1_800_000_000_100 + sequence,
        startedAtMS: 1_800_000_000_000,
        state: .open,
        usage: .init(
            input: sequence,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoningOutput: 0
        ),
        model: nil,
        effort: nil,
        idempotencyKey: String(format: "%064llx", sequence)
    )
}

private func makeFakeApp(_ app: URL, marker value: String) throws {
    let executableDirectory = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
    try FileManager.default.createDirectory(at: executableDirectory, withIntermediateDirectories: true)
    for directory in [app, app.appendingPathComponent("Contents", isDirectory: true), executableDirectory] {
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }
    try writeOwnerFile(Data(value.utf8), to: app.appendingPathComponent("marker"))
    let executable = executableDirectory.appendingPathComponent("runtime-raiders-agent")
    try writeOwnerFile(Data("fixture".utf8), to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
}

private func marker(_ app: URL) throws -> String {
    String(decoding: try Data(contentsOf: app.appendingPathComponent("marker")), as: UTF8.self)
}

private func permissions(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
}

private func inode(_ url: URL) throws -> UInt64 {
    var metadata = stat()
    guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.ENOENT) }
    return UInt64(metadata.st_ino)
}

private func selfCheckData(_ identity: CompanionReleaseIdentity) -> Data {
    Data("{\"companion_version\":\"\(identity.companionVersion)\",\"release_sequence\":\(identity.releaseSequence),\"release_sha\":\"\(identity.releaseSHA)\",\"update_protocol_version\":\(identity.updateProtocolVersion)}\n".utf8)
}

private func testArchiveData() -> Data {
    let entries: [(name: String, data: Data, mode: UInt32)] = [
        ("Runtime Raiders Agent.app/", Data(), UInt32(S_IFDIR | 0o755)),
        ("Runtime Raiders Agent.app/Contents/Info.plist", Data("abc".utf8), UInt32(S_IFREG | 0o644)),
    ]
    var archive = Data()
    var offsets: [UInt32] = []
    for entry in entries {
        let name = Array(entry.name.utf8)
        offsets.append(UInt32(archive.count))
        archive.appendLittleEndian(UInt32(0x04034b50))
        archive.appendLittleEndian(UInt16(20))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt32(0))
        archive.appendLittleEndian(UInt32(entry.data.count))
        archive.appendLittleEndian(UInt32(entry.data.count))
        archive.appendLittleEndian(UInt16(name.count))
        archive.appendLittleEndian(UInt16(0))
        archive.append(contentsOf: name)
        archive.append(entry.data)
    }
    let centralOffset = UInt32(archive.count)
    for (index, entry) in entries.enumerated() {
        let name = Array(entry.name.utf8)
        archive.appendLittleEndian(UInt32(0x02014b50))
        archive.appendLittleEndian(UInt16(0x0314))
        archive.appendLittleEndian(UInt16(20))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt32(0))
        archive.appendLittleEndian(UInt32(entry.data.count))
        archive.appendLittleEndian(UInt32(entry.data.count))
        archive.appendLittleEndian(UInt16(name.count))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(UInt16(0))
        archive.appendLittleEndian(entry.mode << 16)
        archive.appendLittleEndian(offsets[index])
        archive.append(contentsOf: name)
    }
    let centralSize = UInt32(archive.count) - centralOffset
    archive.appendLittleEndian(UInt32(0x06054b50))
    archive.appendLittleEndian(UInt16(0))
    archive.appendLittleEndian(UInt16(0))
    archive.appendLittleEndian(UInt16(entries.count))
    archive.appendLittleEndian(UInt16(entries.count))
    archive.appendLittleEndian(centralSize)
    archive.appendLittleEndian(centralOffset)
    archive.appendLittleEndian(UInt16(0))
    return archive
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

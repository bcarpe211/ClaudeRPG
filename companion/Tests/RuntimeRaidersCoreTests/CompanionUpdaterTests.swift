import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class CompanionUpdaterTests: XCTestCase {
    func testAlreadyCurrentStopsBeforeDownload() throws {
        try withHarness { harness in
            harness.manifest = harness.manifest(for: harness.n)

            XCTAssertEqual(try harness.makeUpdater().run(), .alreadyCurrent)
            XCTAssertFalse(harness.downloadCalled)
            XCTAssertEqual(try harness.state(), harness.initialState)
        }
    }

    func testTwoSuccessiveUpdatesUseVersionedTrialsAndRetainEveryRelease() throws {
        try withHarness { harness in
            try harness.runUpdate(to: harness.n1)

            let afterFirst = try harness.state()
            XCTAssertEqual(afterFirst.generation, 3)
            XCTAssertEqual(afterFirst.active, harness.n1)
            XCTAssertEqual(afterFirst.fallback, harness.n)
            XCTAssertNil(afterFirst.trial)
            XCTAssertTrue(harness.activeObservedDuringTrialHealth)
            XCTAssertEqual(harness.kickstartCount, 1)

            let oldWorkspaceResidue = harness.paths.supportDirectory.appendingPathComponent(
                "update-old-diagnostic-residue",
                isDirectory: true
            )
            try privateDirectory(oldWorkspaceResidue)
            try writeOwnerFile(
                Data("untouched".utf8),
                to: oldWorkspaceResidue.appendingPathComponent("evidence")
            )
            try harness.leaveMalformedJournalAndOldReleaseResidue()
            harness.resetForNextUpdate(to: harness.n2)
            try harness.runUpdate(to: harness.n2)

            let afterSecond = try harness.state()
            XCTAssertEqual(afterSecond.generation, 5)
            XCTAssertEqual(afterSecond.active, harness.n2)
            XCTAssertEqual(afterSecond.fallback, harness.n1)
            XCTAssertNil(afterSecond.trial)
            XCTAssertTrue(FileManager.default.fileExists(atPath: try harness.paths.application(for: harness.n).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: try harness.paths.application(for: harness.n1).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: try harness.paths.application(for: harness.n2).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: oldWorkspaceResidue.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: harness.unselectedResidue.path))
            XCTAssertEqual(harness.kickstartCount, 2)
        }
    }

    func testJournalAndCleanupFailuresCannotChangeCommitOrBlockHigherSequence() throws {
        try withHarness { harness in
            harness.transactionFaults = [.journalWrite, .workspaceCleanup]
            try harness.runUpdate(to: harness.n1)
            XCTAssertEqual(try harness.state().active, harness.n1)

            harness.resetForNextUpdate(to: harness.n2)
            harness.transactionFaults = [.journalWrite, .workspaceCleanup]
            try harness.runUpdate(to: harness.n2)

            let final = try harness.state()
            XCTAssertEqual(final.active, harness.n2)
            XCTAssertEqual(final.fallback, harness.n1)
            XCTAssertNil(final.trial)
        }
    }

    func testActiveRunRefusesBeforeFetchingOrChangingSelection() throws {
        try withHarness { harness in
            harness.activeRunCount = 1

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .activeRun)
            }
            XCTAssertFalse(harness.fetchCalled)
            XCTAssertEqual(try harness.state(), harness.initialState)
        }
    }

    func testFailuresAroundPreTrialStagesLeaveCommittedSelectionUntouched() throws {
        let checkpoints: [CompanionUpdaterCheckpoint] = [
            .beforeDownload, .afterDownload,
            .beforeArchiveValidation, .afterArchiveValidation,
            .beforeExtraction, .afterExtraction,
            .beforeCandidateVerification, .afterCandidateVerification,
            .beforePromotion, .afterPromotion,
        ]
        for checkpoint in checkpoints {
            try withHarness { harness in
                harness.failOnce(at: checkpoint)
                XCTAssertThrowsError(try harness.makeUpdater().run())
                XCTAssertEqual(try harness.state(), harness.initialState, "checkpoint \(checkpoint)")
                XCTAssertEqual(harness.kickstartCount, 0, "checkpoint \(checkpoint)")
            }
        }
    }

    func testFailuresAroundTrialPrepareAndHealthClearTrialAndRestorePriorActive() throws {
        let checkpoints: [CompanionUpdaterCheckpoint] = [
            .beforeTrialRecord, .afterTrialRecord,
            .beforeLease, .afterLease,
            .beforePrepare, .afterPrepare,
            .beforeKickstart, .afterKickstart,
            .beforeTrialHealth, .afterTrialHealth,
        ]
        for checkpoint in checkpoints {
            try withHarness { harness in
                harness.failOnce(at: checkpoint)
                XCTAssertThrowsError(try harness.makeUpdater().run()) { error in
                    if checkpoint == .beforeTrialRecord {
                        XCTAssertNotEqual(error as? CompanionUpdaterError, .rollbackFailed)
                    } else {
                        XCTAssertEqual(error as? CompanionUpdaterError, .updateRolledBack)
                    }
                }
                let final = try harness.state()
                XCTAssertEqual(final.active, harness.n, "checkpoint \(checkpoint)")
                XCTAssertNil(final.fallback, "checkpoint \(checkpoint)")
                XCTAssertNil(final.trial, "checkpoint \(checkpoint)")
            }
        }
    }

    func testCandidateHealthFailureClearsTrialBeforeKickstartingPriorActive() throws {
        try withHarness { harness in
            harness.rejectCandidateHealth = true

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .updateRolledBack)
            }
            let final = try harness.state()
            XCTAssertEqual(final.active, harness.n)
            XCTAssertNil(final.trial)
            XCTAssertEqual(harness.kickstartSelections, [harness.n1, harness.n])
            XCTAssertEqual(harness.resumedGenerations.last, final.generation)
        }
    }

    func testCandidateHealthWithActiveRunRollsBackBeforeCommit() throws {
        try withHarness { harness in
            harness.candidateHealthActiveRunCount = 1

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .updateRolledBack)
            }
            let final = try harness.state()
            XCTAssertEqual(final.active, harness.n)
            XCTAssertNil(final.trial)
        }
    }

    func testPriorActiveHealthWithActiveRunFailsRollbackClosed() throws {
        try withHarness { harness in
            harness.rejectCandidateHealth = true
            harness.priorHealthActiveRunCount = 1

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .rollbackFailed)
            }
            XCTAssertEqual(try harness.state().active, harness.n)
            XCTAssertNil(try harness.state().trial)
        }
    }

    func testResumeFailureAfterCommitRestoresExactPreTrialSelection() throws {
        try withHarness(initialActive: .n1WithFallback) { harness in
            harness.failCandidateResume = true

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .updateRolledBack)
            }

            let final = try harness.state()
            XCTAssertEqual(final.generation, 5)
            XCTAssertEqual(final.active, harness.n1)
            XCTAssertEqual(final.fallback, harness.n)
            XCTAssertNil(final.trial)
            XCTAssertEqual(harness.kickstartSelections, [harness.n2, harness.n1])
            XCTAssertEqual(harness.resumedGenerations.last, final.generation)
        }
    }

    func testPriorActiveHealthFailureAfterRollbackIsTerminalRollbackFailure() throws {
        try withHarness { harness in
            harness.rejectCandidateHealth = true
            harness.rejectPriorHealth = true

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .rollbackFailed)
            }
            XCTAssertEqual(try harness.state().active, harness.n)
            XCTAssertNil(try harness.state().trial)
        }
    }

    func testFailureAfterCommitBeforeResumeRestoresPriorSelection() throws {
        try withHarness(initialActive: .n1WithFallback) { harness in
            harness.failOnce(at: .afterCommit)

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .updateRolledBack)
            }
            let final = try harness.state()
            XCTAssertEqual(final.active, harness.n1)
            XCTAssertEqual(final.fallback, harness.n)
            XCTAssertNil(final.trial)
        }
    }

    func testCommitAndResumeBoundaryFailuresHaveDeterministicSelection() throws {
        for checkpoint: CompanionUpdaterCheckpoint in [.beforeCommit, .afterCommit, .beforeResume] {
            try withHarness { harness in
                harness.failOnce(at: checkpoint)
                XCTAssertThrowsError(try harness.makeUpdater().run()) {
                    XCTAssertEqual($0 as? CompanionUpdaterError, .updateRolledBack)
                }
                XCTAssertEqual(try harness.state().active, harness.n, "checkpoint \(checkpoint)")
                XCTAssertNil(try harness.state().trial, "checkpoint \(checkpoint)")
            }
        }

        try withHarness { harness in
            harness.failOnce(at: .afterResume)
            try harness.runUpdate(to: harness.n1)
            XCTAssertEqual(try harness.state().active, harness.n1)
            XCTAssertEqual(try harness.state().fallback, harness.n)
            XCTAssertNil(try harness.state().trial)
        }
    }

    func testRevertAndPriorHealthBoundaryFailuresFailClosedWithoutFixedSlots() throws {
        for checkpoint: CompanionUpdaterCheckpoint in [.beforeRevert, .afterRevert] {
            try withHarness { harness in
                harness.failCandidateResume = true
                harness.failOnce(at: checkpoint)
                XCTAssertThrowsError(try harness.makeUpdater().run()) {
                    XCTAssertEqual($0 as? CompanionUpdaterError, .rollbackFailed)
                }
                let current = try harness.state()
                if checkpoint == .beforeRevert {
                    XCTAssertEqual(current.active, harness.n1)
                    XCTAssertEqual(current.fallback, harness.n)
                } else {
                    XCTAssertEqual(current.active, harness.n)
                    XCTAssertNil(current.fallback)
                }
                XCTAssertNil(current.trial)
            }
        }

        for checkpoint: CompanionUpdaterCheckpoint in [.beforePriorHealth, .afterPriorHealth] {
            try withHarness { harness in
                harness.rejectCandidateHealth = true
                harness.failOnce(at: checkpoint)
                XCTAssertThrowsError(try harness.makeUpdater().run()) {
                    XCTAssertEqual($0 as? CompanionUpdaterError, .rollbackFailed)
                }
                XCTAssertEqual(try harness.state().active, harness.n)
                XCTAssertNil(try harness.state().trial)
            }
        }
    }

    func testStaleTrialWithoutLeaseIsClearedBeforeAHealthyHigherUpdate() throws {
        try withHarness { harness in
            try harness.promoteAndRecordTrial(harness.n1)
            let staleGeneration = try harness.state().generation
            try harness.leaveMalformedJournalAndOldReleaseResidue()
            harness.resetForNextUpdate(to: harness.n2)

            try harness.runUpdate(to: harness.n2)

            let final = try harness.state()
            XCTAssertGreaterThan(final.generation, staleGeneration)
            XCTAssertEqual(final.active, harness.n2)
            XCTAssertEqual(final.fallback, harness.n)
            XCTAssertNil(final.trial)
            XCTAssertTrue(FileManager.default.fileExists(atPath: try harness.paths.application(for: harness.n1).path))
        }
    }

    func testStaleTrialReconciliationRequiresHealthyCommittedActive() throws {
        try withHarness { harness in
            try harness.promoteAndRecordTrial(harness.n1)
            harness.initialDaemonRunning = false

            XCTAssertThrowsError(try harness.makeUpdater().run()) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .invalidStatus)
            }
            XCTAssertEqual(try harness.state().trial, harness.n1)
        }
    }

    func testUniquePromotionMovesOnlyAgentAndRefusesExistingReleaseTarget() throws {
        try withHarness { harness in
            let transaction = try harness.makeTransaction()
            try harness.populateExtractedRelease(transaction, release: harness.n1)
            let verified = try harness.verifiedArchive(transaction, release: harness.n1)

            XCTAssertEqual(try transaction.promoteVerifiedCandidate(verified), harness.n1)
            XCTAssertTrue(FileManager.default.fileExists(atPath: try harness.paths.application(for: harness.n1).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: verified.launcher.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: verified.agent.application.path))

            let duplicate = try harness.makeTransaction()
            try harness.populateExtractedRelease(duplicate, release: harness.n1)
            XCTAssertThrowsError(try duplicate.promoteVerifiedCandidate(
                harness.verifiedArchive(duplicate, release: harness.n1)
            )) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .unsafeFilesystem)
            }
        }
    }

    func testPromotionRejectsAgentChangedAfterArchiveVerification() throws {
        try withHarness { harness in
            let transaction = try harness.makeTransaction()
            try harness.populateExtractedRelease(transaction, release: harness.n1)
            let verified = try harness.verifiedArchive(transaction, release: harness.n1)
            try Data("xx".utf8).write(
                to: verified.agent.application.appendingPathComponent("marker")
            )

            XCTAssertThrowsError(try transaction.promoteVerifiedCandidate(verified)) {
                XCTAssertEqual($0 as? CompanionUpdaterError, .unsafeFilesystem)
            }
            XCTAssertEqual(try harness.state(), harness.initialState)
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: try harness.paths.application(for: harness.n1).path
            ))
        }
    }

    func testTrialCommitClearAndRestoreAlwaysAdvanceOneGeneration() throws {
        try withHarness(initialActive: .n1WithFallback) { harness in
            let transaction = try harness.makeTransaction()
            try harness.populateExtractedRelease(transaction, release: harness.n2)
            _ = try transaction.promoteVerifiedCandidate(
                harness.verifiedArchive(transaction, release: harness.n2)
            )
            let trial = try transaction.recordTrial(harness.n2)
            XCTAssertEqual(trial.generation, 3)
            XCTAssertEqual(trial.active, harness.n1)
            let committed = try transaction.commitTrial(expectedGeneration: trial.generation)
            XCTAssertEqual(committed.generation, 4)
            XCTAssertEqual(committed.active, harness.n2)
            let restored = try transaction.restorePriorSelection(expectedGeneration: committed.generation)
            XCTAssertEqual(restored.generation, 5)
            XCTAssertEqual(restored.active, harness.n1)
            XCTAssertEqual(restored.fallback, harness.n)
        }
    }

    func testDiscardedTransactionAtEachDurableBoundaryUsesOnlyReleaseStateForRecovery() throws {
        try withHarness { harness in
            do {
                let transaction = try harness.makeTransaction()
                try harness.populateExtractedRelease(transaction, release: harness.n1)
                _ = try transaction.promoteVerifiedCandidate(
                    harness.verifiedArchive(transaction, release: harness.n1)
                )
            }
            XCTAssertEqual(try harness.state(), harness.initialState)
            XCTAssertTrue(FileManager.default.fileExists(atPath: try harness.paths.application(for: harness.n1).path))
        }
        try withHarness { harness in
            let trialTransaction = try harness.makeTransaction()
            try harness.populateExtractedRelease(trialTransaction, release: harness.n1)
            _ = try trialTransaction.promoteVerifiedCandidate(
                harness.verifiedArchive(trialTransaction, release: harness.n1)
            )
            let trial = try trialTransaction.recordTrial(harness.n1)
            XCTAssertEqual(trial.active, harness.n)
            harness.manifest = harness.manifest(for: harness.n)
            XCTAssertEqual(try harness.makeUpdater().run(), .alreadyCurrent)
            XCTAssertNil(try harness.state().trial)
            XCTAssertEqual(try harness.state().active, harness.n)

        }
        try withHarness { harness in
            let commitTransaction = try harness.makeTransaction()
            try harness.populateExtractedRelease(commitTransaction, release: harness.n1)
            _ = try commitTransaction.promoteVerifiedCandidate(
                harness.verifiedArchive(commitTransaction, release: harness.n1)
            )
            let rerecorded = try commitTransaction.recordTrial(harness.n1)
            let committed = try commitTransaction.commitTrial(expectedGeneration: rerecorded.generation)
            XCTAssertEqual(committed.active, harness.n1)
            XCTAssertNil(committed.trial)
            XCTAssertEqual(try harness.state(), committed)
        }
    }

    func testEveryLeaseBoundCrashUsesRealLauncherAndPreparedDaemonRecovery() throws {
        for boundary in LeaseBoundCrashBoundary.allCases {
            try withHarness { harness in
                var transaction: VersionedReleaseTransaction? = try harness.makeTransaction()
                try harness.populateExtractedRelease(try XCTUnwrap(transaction), release: harness.n1)
                _ = try XCTUnwrap(transaction).promoteVerifiedCandidate(
                    try harness.verifiedArchive(try XCTUnwrap(transaction), release: harness.n1)
                )
                let trialState = try XCTUnwrap(transaction).recordTrial(harness.n1)

                let activeSelection = try harness.daemonSelection()
                XCTAssertEqual(activeSelection.release, harness.n, "boundary \(boundary)")
                let activeRuntime = try harness.preparedRuntime(selection: activeSelection)
                try activeRuntime.start()
                XCTAssertEqual(activeRuntime.startCount, 1, "boundary \(boundary)")

                let lease = try CompanionPreparedStartupLease(paths: harness.paths)
                XCTAssertNotNil(try CompanionPreparedStartupLease.observe(paths: harness.paths))
                let heldSelection = try harness.daemonSelection()
                XCTAssertEqual(heldSelection.release, harness.n1, "boundary \(boundary)")
                XCTAssertEqual(
                    heldSelection.arguments,
                    ["daemon", "__runtime-raiders-trial-generation", String(trialState.generation)],
                    "boundary \(boundary)"
                )

                if boundary == .afterLease {
                    transaction = nil
                    lease.unlock()
                    XCTAssertNil(try CompanionPreparedStartupLease.observe(paths: harness.paths))
                    XCTAssertEqual(try harness.daemonSelection().release, harness.n)
                    try harness.reconcileAbandonedTrial()
                    XCTAssertNil(try harness.state().trial)
                    return
                }

                if boundary == .afterPrepare {
                    XCTAssertTrue(activeRuntime.prepare(generation: trialState.generation).ok)
                    XCTAssertTrue(activeRuntime.preparation.isPrepared)
                    transaction = nil
                    lease.unlock()
                    activeRuntime.drainAbandonment()
                    XCTAssertEqual(activeRuntime.events, [.resumed], "boundary \(boundary)")
                    XCTAssertFalse(activeRuntime.preparation.isPrepared)
                    XCTAssertEqual(activeRuntime.startCount, 1)
                    XCTAssertEqual(try harness.daemonSelection().release, harness.n)
                    try harness.reconcileAbandonedTrial()
                    XCTAssertNil(try harness.state().trial)
                    return
                }

                let candidateRuntime = try harness.preparedRuntime(selection: heldSelection)
                try candidateRuntime.start()
                XCTAssertTrue(candidateRuntime.preparation.isPrepared)
                XCTAssertEqual(candidateRuntime.startCount, 0)
                candidateRuntime.observeAbandonment(generation: trialState.generation)

                var committed: ReleaseStateV1?
                if boundary == .afterCommit || boundary == .afterResume {
                    committed = try XCTUnwrap(transaction).commitTrial(
                        expectedGeneration: trialState.generation
                    )
                    XCTAssertEqual(try harness.daemonSelection().release, harness.n1)
                }
                if boundary == .afterResume {
                    XCTAssertTrue(candidateRuntime.preparation.resume(
                        generation: try XCTUnwrap(committed).generation
                    ).ok)
                    XCTAssertFalse(candidateRuntime.preparation.isPrepared)
                    XCTAssertEqual(candidateRuntime.startCount, 1)
                }

                transaction = nil
                lease.unlock()
                candidateRuntime.drainAbandonment()
                XCTAssertNil(try CompanionPreparedStartupLease.observe(paths: harness.paths))

                switch boundary {
                case .afterKickstart, .afterHealth:
                    XCTAssertEqual(candidateRuntime.events, [.exited], "boundary \(boundary)")
                    XCTAssertEqual(candidateRuntime.startCount, 0)
                    XCTAssertEqual(try harness.daemonSelection().release, harness.n)
                    try harness.reconcileAbandonedTrial()
                    XCTAssertNil(try harness.state().trial)
                case .afterCommit:
                    XCTAssertEqual(candidateRuntime.events, [.resumed])
                    XCTAssertEqual(candidateRuntime.startCount, 1)
                    XCTAssertFalse(candidateRuntime.preparation.isPrepared)
                    XCTAssertEqual(try harness.state(), try XCTUnwrap(committed))
                    XCTAssertEqual(try harness.daemonSelection().release, harness.n1)
                case .afterResume:
                    XCTAssertEqual(candidateRuntime.events, [])
                    XCTAssertEqual(candidateRuntime.startCount, 1)
                    XCTAssertEqual(try harness.state(), try XCTUnwrap(committed))
                    XCTAssertEqual(try harness.daemonSelection().release, harness.n1)
                case .afterLease, .afterPrepare:
                    XCTFail("handled before candidate launch")
                }
            }
        }
    }

    func testProtectedStateAndOutboxRemainByteExactThroughTrialHealth() throws {
        try withHarness { harness in
            let before = try harness.protectedBytes()
            harness.onCandidateHealth = {
                XCTAssertEqual(try harness.protectedBytes(), before)
            }
            try harness.runUpdate(to: harness.n1)
            XCTAssertEqual(try harness.protectedBytes(), before)
        }
    }
}

private enum InitialActive {
    case n
    case n1WithFallback
}

private enum HarnessFailure: Error {
    case injected
}

private final class VersionedUpdaterHarness {
    let root = temporaryURL("runtime-raiders-versioned-updater")
    let paths: AgentPaths
    let n = release(9, "a", "0.3.0")
    let n1 = release(10, "b", "0.3.1")
    let n2 = release(11, "c", "0.3.2")
    let team = "ABCDEFGHIJ"
    let initialState: ReleaseStateV1
    let unselectedResidue: URL

    var manifest: ReleaseManifestV1
    var activeRunCount = 0
    var initialDaemonRunning = true
    var downloadCalled = false
    var fetchCalled = false
    var activeObservedDuringTrialHealth = false
    var rejectCandidateHealth = false
    var rejectPriorHealth = false
    var candidateHealthActiveRunCount = 0
    var priorHealthActiveRunCount = 0
    var failCandidateResume = false
    var onCandidateHealth: () throws -> Void = {}
    var kickstartCount = 0
    var kickstartSelections: [ReleaseReference] = []
    var resumedGenerations: [Int64] = []
    var workspaces: [URL] = []
    var transactionFaults: Set<VersionedReleaseTransactionFault> = []
    private var failedCheckpoint: CompanionUpdaterCheckpoint?
    private var failureConsumed = false

    init(initialActive: InitialActive) throws {
        paths = AgentPaths(applicationSupportDirectory: root)
        unselectedResidue = paths.releasesDirectory.appendingPathComponent(
            "sequence-7-" + String(repeating: "d", count: 40),
            isDirectory: true
        )
        try privateDirectory(paths.supportDirectory)
        try privateDirectory(paths.stateDirectory)
        try privateDirectory(paths.outboxDirectory)
        try privateDirectory(paths.releasesDirectory)
        try privateDirectory(paths.installationDirectory)
        try writeOwnerFile(Data("enrollment".utf8), to: paths.stateDirectory.appendingPathComponent("enrollment.json"))
        try writeOwnerFile(Data("collector".utf8), to: paths.stateDirectory.appendingPathComponent("collector-state.json"))
        try writeOwnerFile(Data("event".utf8), to: paths.outboxDirectory.appendingPathComponent(String(repeating: "e", count: 64) + ".json"))

        let selectedState: ReleaseStateV1
        let selectedManifest: ReleaseManifestV1
        let installedReleases: [ReleaseReference]
        switch initialActive {
        case .n:
            selectedState = ReleaseStateV1(
                schemaVersion: 1, generation: 1, active: n, fallback: nil, trial: nil
            )
            selectedManifest = try makeManifest(n1)
            installedReleases = [n]
        case .n1WithFallback:
            selectedState = ReleaseStateV1(
                schemaVersion: 1, generation: 2, active: n1, fallback: n, trial: nil
            )
            selectedManifest = try makeManifest(n2)
            installedReleases = [n, n1]
        }
        initialState = selectedState
        manifest = selectedManifest
        for release in installedReleases { try makeInstalledRelease(release) }
        let store = try ReleaseStateStore(paths: paths)
        if selectedState.generation == 1 {
            try store.createInitial(selectedState)
        } else {
            let generationOne = ReleaseStateV1(
                schemaVersion: 1, generation: 1, active: n, fallback: nil, trial: nil
            )
            try store.createInitial(generationOne)
            try store.replace(expectedGeneration: 1, with: selectedState)
        }
    }

    deinit { try? FileManager.default.removeItem(at: root) }

    func state() throws -> ReleaseStateV1 { try ReleaseStateStore(paths: paths).load() }

    func manifest(for release: ReleaseReference) -> ReleaseManifestV1 {
        try! makeManifest(release)
    }

    func runUpdate(to release: ReleaseReference) throws {
        manifest = manifest(for: release)
        let from = try state().active.companionReleaseIdentity()
        XCTAssertEqual(
            try makeUpdater().run(),
            .updated(from: from, to: try release.companionReleaseIdentity())
        )
    }

    func resetForNextUpdate(to release: ReleaseReference) {
        manifest = manifest(for: release)
        activeObservedDuringTrialHealth = false
        rejectCandidateHealth = false
        rejectPriorHealth = false
        failCandidateResume = false
        failedCheckpoint = nil
        failureConsumed = false
    }

    func failOnce(at checkpoint: CompanionUpdaterCheckpoint) {
        failedCheckpoint = checkpoint
        failureConsumed = false
    }

    func makeUpdater() -> CompanionUpdater {
        CompanionUpdater(
            paths: paths,
            surfaces: [.codexCLI],
            operations: CompanionUpdaterOperations(
                status: { [unowned self] expected, generation in
                    let current = try state()
                    guard current.active == expected, current.generation == generation else {
                        throw CompanionUpdaterError.invalidStatus
                    }
                    return updateStatus(
                        release: expected,
                        daemonRunning: initialDaemonRunning,
                        activeRuns: activeRunCount
                    )
                },
                fetchManifest: { [unowned self] in
                    fetchCalled = true
                    return manifest
                },
                downloadArchive: { [unowned self] _, destination, digest in
                    downloadCalled = true
                    let data = testArchiveData()
                    try data.write(to: destination)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
                    return DownloadReceipt(byteCount: Int64(data.count), sha256: digest)
                },
                runCommand: { [unowned self] executable, arguments, _ in
                    if executable.path == "/usr/bin/ditto" {
                        let destination = URL(fileURLWithPath: arguments.last!)
                        try createExtractedReleaseFixture(at: destination, release: manifest.reference)
                        return SystemCommandResult(exitStatus: .exited(0), stdout: Data(), stderr: Data())
                    }
                    let reference = try manifest.reference.companionReleaseIdentity()
                    return SystemCommandResult(
                        exitStatus: .exited(0),
                        stdout: selfCheckData(reference),
                        stderr: Data()
                    )
                },
                verifyArchive: { [unowned self] root, manifest, installed in
                    let activeIdentity = try state().active.companionReleaseIdentity()
                    guard installed.identity == activeIdentity,
                          manifest.reference == self.manifest.reference else {
                        throw CompanionUpdaterError.candidateRejected
                    }
                    return try testReleaseArchiveVerifier(
                        identity: try manifest.reference.companionReleaseIdentity(),
                        teamIdentifier: team
                    ).verify(
                        extractedRoot: root,
                        manifest: manifest,
                        installed: installed.identity,
                        installedTeamIdentifier: installed.teamIdentifier
                    )
                },
                availableCapacity: { _ in Int64.max },
                acquirePreparedLease: { [paths] in try CompanionPreparedStartupLease(paths: paths) },
                prepareDaemon: { [unowned self] generation in
                    let current = try state()
                    guard current.generation == generation, current.trial != nil else {
                        throw CompanionUpdaterError.invalidStatus
                    }
                    if activeRunCount > 0 { return .refusedActiveRun }
                    return .prepared(updateStatus(
                        release: current.active,
                        preparedGeneration: generation
                    ))
                },
                kickstartDaemon: { [unowned self] in
                    kickstartCount += 1
                    kickstartSelections.append(try daemonSelection().release)
                },
                resumePreparedDaemon: { [unowned self] generation in
                    let current = try state()
                    if failCandidateResume, current.active == manifest.reference {
                        failCandidateResume = false
                        throw HarnessFailure.injected
                    }
                    guard current.generation == generation, current.trial == nil else {
                        throw CompanionUpdaterError.invalidStatus
                    }
                    resumedGenerations.append(generation)
                },
                healthStatus: { [unowned self] expected, generation in
                    let current = try state()
                    guard current.generation == generation else {
                        throw CompanionUpdaterError.invalidStatus
                    }
                    if expected == manifest.reference {
                        try onCandidateHealth()
                        activeObservedDuringTrialHealth = current.active != expected && current.trial == expected
                        if rejectCandidateHealth {
                            return updateStatus(release: current.active, preparedGeneration: generation)
                        }
                    } else if rejectPriorHealth {
                        return updateStatus(release: manifest.reference, preparedGeneration: generation)
                    }
                    return updateStatus(
                        release: expected,
                        activeRuns: expected == manifest.reference
                            ? candidateHealthActiveRunCount
                            : priorHealthActiveRunCount,
                        preparedGeneration: generation
                    )
                },
                checkpoint: { [unowned self] checkpoint in
                    if checkpoint == failedCheckpoint, !failureConsumed {
                        failureConsumed = true
                        throw HarnessFailure.injected
                    }
                }
            ),
            transactionFactory: { [unowned self] in try makeTransaction() }
        )
    }

    func makeTransaction() throws -> VersionedReleaseTransaction {
        let transaction = try VersionedReleaseTransaction(
            paths: paths,
            fault: { [unowned self] fault in
                if transactionFaults.contains(fault) { throw HarnessFailure.injected }
            }
        )
        workspaces.append(transaction.workspaceDirectory)
        return transaction
    }

    func populateExtractedRelease(_ transaction: VersionedReleaseTransaction, release: ReleaseReference) throws {
        try createExtractedReleaseFixture(at: transaction.stagingDirectory, release: release)
    }

    func verifiedArchive(
        _ transaction: VersionedReleaseTransaction,
        release: ReleaseReference
    ) throws -> VerifiedReleaseArchive {
        let installed = try state().active.companionReleaseIdentity()
        return try testReleaseArchiveVerifier(
            identity: try release.companionReleaseIdentity(),
            teamIdentifier: team
        ).verify(
            extractedRoot: transaction.stagingDirectory,
            manifest: manifest(for: release),
            installed: installed,
            installedTeamIdentifier: team
        )
    }

    func promoteAndRecordTrial(_ release: ReleaseReference) throws {
        let transaction = try makeTransaction()
        try populateExtractedRelease(transaction, release: release)
        _ = try transaction.promoteVerifiedCandidate(verifiedArchive(transaction, release: release))
        _ = try transaction.recordTrial(release)
    }

    func leaveMalformedJournalAndOldReleaseResidue() throws {
        try writeOwnerFile(Data("not-json".utf8), to: paths.updateJournal)
        try privateDirectory(unselectedResidue)
        try writeOwnerFile(Data("untouched".utf8), to: unselectedResidue.appendingPathComponent("evidence"))
    }

    func protectedBytes() throws -> [String: Data] {
        [
            "enrollment": try Data(contentsOf: paths.stateDirectory.appendingPathComponent("enrollment.json")),
            "collector": try Data(contentsOf: paths.stateDirectory.appendingPathComponent("collector-state.json")),
            "outbox": try Data(contentsOf: paths.outboxDirectory.appendingPathComponent(String(repeating: "e", count: 64) + ".json")),
        ]
    }

    func daemonSelection() throws -> LauncherSelection {
        let knownReleases = [n, n1, n2]
        let launcher = LauncherBundleValidation(
            bundle: paths.launcherApplication,
            executable: paths.launcherExecutable,
            bundleIdentifier: "com.redlattice.runtime-raiders-launcher",
            teamIdentifier: team,
            hardenedRuntime: true,
            allArchitecturesValid: true,
            launcherProtocolVersion: 1,
            releaseIdentity: nil
        )
        let selector = LauncherSelector(operations: LauncherSelectionOperations(
            paths: paths,
            loadReleaseState: { [paths] in try ReleaseStateStore.loadExisting(paths: paths) },
            preparedStartupLeaseIsHeld: { [paths] in
                try CompanionPreparedStartupLease.observe(paths: paths) != nil
            },
            inspectLauncher: { launcher },
            inspectAgent: { [paths, team] application in
                guard let release = try knownReleases.first(where: {
                    try paths.application(for: $0).standardizedFileURL ==
                        application.standardizedFileURL
                }) else {
                    throw HarnessFailure.injected
                }
                return LauncherBundleValidation(
                    bundle: application,
                    executable: try paths.executable(for: release),
                    bundleIdentifier: "com.redlattice.runtime-raiders-agent",
                    teamIdentifier: team,
                    hardenedRuntime: true,
                    allArchitecturesValid: true,
                    launcherProtocolVersion: nil,
                    releaseIdentity: try release.companionReleaseIdentity()
                )
            }
        ))
        return try selector.select(invocation: .daemon)
    }

    func preparedRuntime(selection: LauncherSelection) throws -> CrashPreparedRuntime {
        let trialGeneration = selection.arguments.count == 3
            ? selection.releaseStateGeneration
            : nil
        let starts = CrashStartCounter()
        let coordinator = try PreparedDaemonStartupCoordinator(
            paths: paths,
            trialGeneration: trialGeneration,
            releaseIdentity: try selection.release.companionReleaseIdentity(),
            loadReleaseState: { [paths] in try ReleaseStateStore.loadExisting(paths: paths) },
            deferredStart: { starts.increment() }
        )
        return CrashPreparedRuntime(coordinator: coordinator, starts: starts)
    }

    func reconcileAbandonedTrial() throws {
        manifest = manifest(for: try state().active)
        XCTAssertEqual(try makeUpdater().run(), .alreadyCurrent)
    }

    private func updateStatus(
        release: ReleaseReference,
        daemonRunning: Bool = true,
        activeRuns: Int = 0,
        preparedGeneration: Int64? = nil
    ) -> CompanionUpdateStatus {
        CompanionUpdateStatus(
            verifiedApplication: VerifiedCompanionApplication(
                identity: try! release.companionReleaseIdentity(),
                teamIdentifier: team
            ),
            daemonRunning: daemonRunning,
            enabled: true,
            enrollmentValid: true,
            collectorStateValid: true,
            activeRunCount: activeRuns,
            queuedEventCount: 1,
            preparedReleaseStateGeneration: preparedGeneration
        )
    }

    private func makeInstalledRelease(_ release: ReleaseReference) throws {
        let app = try paths.application(for: release)
        try makeFakeApp(app, marker: String(release.releaseSequence))
        try privateDirectory(app.deletingLastPathComponent())
    }
}

private enum LeaseBoundCrashBoundary: CaseIterable {
    case afterLease
    case afterPrepare
    case afterKickstart
    case afterHealth
    case afterCommit
    case afterResume
}

private enum CrashPreparedEvent: Equatable {
    case resumed
    case exited
    case failedClosed
}

private final class CrashStartCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0

    var value: Int { lock.withLock { storage } }
    func increment() { lock.withLock { storage += 1 } }
}

private final class CrashPreparedRuntime: @unchecked Sendable {
    let coordinator: PreparedDaemonStartupCoordinator
    let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.crash-recovery")
    private let starts: CrashStartCounter
    private let bridge: CrashAbandonmentBridge
    let preparation: SerializedUpdatePreparation

    init(coordinator: PreparedDaemonStartupCoordinator, starts: CrashStartCounter) {
        self.coordinator = coordinator
        self.starts = starts
        let bridge = CrashAbandonmentBridge()
        self.bridge = bridge
        let preparation = SerializedUpdatePreparation(
            workQueue: DispatchQueue(
                label: "com.redlattice.runtime-raiders.tests.crash-recovery-work"
            ),
            activeRunCount: { 0 },
            validatePreparation: { generation in
                try coordinator.validatePreparation(generation: generation)
            },
            pauseAcceptance: {},
            pauseUploader: {},
            pauseHeartbeat: {},
            pauseWatcher: {},
            startAbandonmentObserver: { generation in bridge.start(generation: generation) },
            initiallyPreparedGeneration: coordinator.initiallyPreparedGeneration,
            validateResume: { generation in
                try coordinator.validateResume(generation: generation)
            },
            resume: { _ in try coordinator.resume() }
        )
        let orchestrator = PreparedReleaseAbandonmentOrchestrator(
            coordinator: coordinator,
            queue: queue,
            preparedGeneration: { bridge.preparedGeneration },
            resumeAfterAbandonment: { generation in
                bridge.resumeAfterAbandonment(generation: generation)
            },
            exitUncommittedTrial: { bridge.append(.exited) },
            failClosed: { bridge.append(.failedClosed) }
        )
        bridge.connect(preparation: preparation, orchestrator: orchestrator)
        self.preparation = preparation
    }

    var events: [CrashPreparedEvent] { bridge.events }
    var startCount: Int { starts.value }

    func start() throws {
        try coordinator.start()
    }

    func prepare(generation: Int64) -> ControlResponse {
        preparation.prepare(generation: generation)
    }

    func observeAbandonment(generation: Int64) {
        bridge.start(generation: generation)
    }

    func drainAbandonment() {
        queue.sync {}
    }

}

private final class CrashAbandonmentBridge: @unchecked Sendable {
    private let lock = NSLock()
    private var preparation: SerializedUpdatePreparation?
    private var orchestrator: PreparedReleaseAbandonmentOrchestrator?
    private var eventStorage: [CrashPreparedEvent] = []

    var preparedGeneration: Int64? {
        lock.withLock { preparation?.preparedGeneration }
    }

    var events: [CrashPreparedEvent] { lock.withLock { eventStorage } }

    func connect(
        preparation: SerializedUpdatePreparation,
        orchestrator: PreparedReleaseAbandonmentOrchestrator
    ) {
        lock.withLock {
            self.preparation = preparation
            self.orchestrator = orchestrator
        }
    }

    func start(generation: Int64) {
        lock.withLock { orchestrator }?.start(generation: generation)
    }

    func resumeAfterAbandonment(generation: Int64) -> ControlResponse {
        guard let preparation = lock.withLock({ preparation }) else {
            return ControlResponse(ok: false, message: "unconnected preparation")
        }
        let response = preparation.resumeAfterAbandonment(generation: generation)
        if response.ok { append(.resumed) }
        return response
    }

    func append(_ event: CrashPreparedEvent) {
        lock.withLock { eventStorage.append(event) }
    }
}

private func withHarness(
    initialActive: InitialActive = .n,
    _ body: (VersionedUpdaterHarness) throws -> Void
) throws {
    let harness = try VersionedUpdaterHarness(initialActive: initialActive)
    try body(harness)
}

private func release(_ sequence: Int64, _ scalar: Character, _ version: String) -> ReleaseReference {
    ReleaseReference(
        releaseSequence: sequence,
        releaseSHA: String(repeating: String(scalar), count: 40),
        companionVersion: version,
        updateProtocolVersion: 2
    )
}

private func makeManifest(_ release: ReleaseReference) throws -> ReleaseManifestV1 {
    let digest = SHA256.hash(data: testArchiveData())
        .map { String(format: "%02x", $0) }
        .joined()
    return try ReleaseManifestV1.decode(Data(
        "{\"manifest_version\":1,\"companion_version\":\"\(release.companionVersion)\",\"release_sequence\":\(release.releaseSequence),\"release_sha\":\"\(release.releaseSHA)\",\"update_protocol_version\":2,\"zip_sha256\":\"\(digest)\",\"zip_url\":\"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip\"}".utf8
    ))
}

private extension ReleaseManifestV1 {
    var reference: ReleaseReference {
        ReleaseReference(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: updateProtocolVersion
        )
    }
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

private func makeFakeApp(_ app: URL, marker: String) throws {
    let executableDirectory = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
    try privateDirectory(executableDirectory)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: app.path)
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o700],
        ofItemAtPath: app.appendingPathComponent("Contents", isDirectory: true).path
    )
    try writeOwnerFile(Data(marker.utf8), to: app.appendingPathComponent("marker"))
    let executable = executableDirectory.appendingPathComponent("runtime-raiders-agent")
    try writeOwnerFile(Data("fixture".utf8), to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
}

private func createExtractedReleaseFixture(at staging: URL, release: ReleaseReference) throws {
    let root = staging.appendingPathComponent("Runtime Raiders Release", isDirectory: true)
    let agent = root.appendingPathComponent("Runtime Raiders Agent.app", isDirectory: true)
    let launcher = root.appendingPathComponent("Runtime Raiders Launcher.app", isDirectory: true)
    try makeFakeApp(agent, marker: String(release.releaseSequence))
    try privateDirectory(launcher.appendingPathComponent("Contents", isDirectory: true))
    try writeOwnerFile(Data("launcher".utf8), to: launcher.appendingPathComponent("Contents/Info.plist"))
    for directory in [root, agent, launcher] {
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }
}

private func testReleaseArchiveVerifier(
    identity: CompanionReleaseIdentity,
    teamIdentifier: String
) -> ReleaseArchiveVerifier {
    ReleaseArchiveVerifier(
        signatureInspector: { application in
            CandidateSignatureFacts(
                bundleIdentifier: application.lastPathComponent == "Runtime Raiders Agent.app"
                    ? "com.redlattice.runtime-raiders-agent"
                    : "com.redlattice.runtime-raiders-launcher",
                teamIdentifier: teamIdentifier,
                signatureValid: true,
                allArchitecturesValid: true,
                hardenedRuntime: true,
                secureTimestampPresent: true,
                gatekeeperNotarized: true
            )
        },
        agentIdentityLoader: { _ in identity },
        launcherProtocolLoader: { _ in 1 }
    )
}

private func selfCheckData(_ identity: CompanionReleaseIdentity) -> Data {
    Data("{\"companion_version\":\"\(identity.companionVersion)\",\"release_sequence\":\(identity.releaseSequence),\"release_sha\":\"\(identity.releaseSHA)\",\"update_protocol_version\":\(identity.updateProtocolVersion)}\n".utf8)
}

private func testArchiveData() -> Data {
    let entries: [(String, Data, UInt32)] = [
        ("Runtime Raiders Release/", Data(), UInt32(S_IFDIR | 0o755)),
        ("Runtime Raiders Release/Runtime Raiders Agent.app/", Data(), UInt32(S_IFDIR | 0o755)),
        ("Runtime Raiders Release/Runtime Raiders Agent.app/Contents/Info.plist", Data("abc".utf8), UInt32(S_IFREG | 0o644)),
        ("Runtime Raiders Release/Runtime Raiders Launcher.app/", Data(), UInt32(S_IFDIR | 0o755)),
        ("Runtime Raiders Release/Runtime Raiders Launcher.app/Contents/Info.plist", Data("abc".utf8), UInt32(S_IFREG | 0o644)),
    ]
    var archive = Data()
    var offsets: [UInt32] = []
    for (name, data, _) in entries {
        let bytes = Array(name.utf8)
        offsets.append(UInt32(archive.count))
        archive.appendLE(UInt32(0x04034b50)); archive.appendLE(UInt16(20))
        archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0))
        archive.appendLE(UInt32(0)); archive.appendLE(UInt32(data.count)); archive.appendLE(UInt32(data.count))
        archive.appendLE(UInt16(bytes.count)); archive.appendLE(UInt16(0)); archive.append(contentsOf: bytes); archive.append(data)
    }
    let centralOffset = UInt32(archive.count)
    for (index, entry) in entries.enumerated() {
        let bytes = Array(entry.0.utf8)
        archive.appendLE(UInt32(0x02014b50)); archive.appendLE(UInt16(0x0314)); archive.appendLE(UInt16(20))
        archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0))
        archive.appendLE(UInt32(0)); archive.appendLE(UInt32(entry.1.count)); archive.appendLE(UInt32(entry.1.count))
        archive.appendLE(UInt16(bytes.count)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0))
        archive.appendLE(entry.2 << 16); archive.appendLE(offsets[index]); archive.append(contentsOf: bytes)
    }
    let centralSize = UInt32(archive.count) - centralOffset
    archive.appendLE(UInt32(0x06054b50)); archive.appendLE(UInt16(0)); archive.appendLE(UInt16(0))
    archive.appendLE(UInt16(entries.count)); archive.appendLE(UInt16(entries.count))
    archive.appendLE(centralSize); archive.appendLE(centralOffset); archive.appendLE(UInt16(0))
    return archive
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
    }
}

import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ReEnrollmentCoordinatorTests: XCTestCase {
    func testLiveOperationsComposeLifecycleJournalEnrollmentQueueAndManagedAgentAPIs() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true).appendingPathComponent(
            "rr-task4-live-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        let paths = try CompanionLifecyclePaths(homeDirectory: root)
        try FileManager.default.createDirectory(
            at: paths.agent.stateDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let old = try EnrollmentConfiguration(
            deviceID: "11111111-1111-4111-8111-111111111111",
            deviceToken: String(repeating: "o", count: 43),
            dedupeSecret: Data(repeating: 0x11, count: 32),
            serverURL: URL(string: "https://raiders.redlattice.com")!,
            cutoverAtMS: 0,
            enabledSurfaces: [.codexCLI, .codexDesktop]
        )
        try old.persist(to: paths.enrollment)
        let collectorState = paths.agent.stateDirectory.appendingPathComponent(
            "collector-state.json"
        )
        try Data(#"{"enabled":false,"files":{},"version":1}"#.utf8).write(
            to: collectorState
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: collectorState.path
        )
        let outbox = try Outbox(directory: paths.agent.outboxDirectory)
        let service = ServiceState()
        let managed = ManagedAgentServiceController(operations: ManagedAgentServiceOperations(
            register: { service.registered = true },
            unregister: { service.registered = false },
            status: { service.registered ? .enabled : .notRegistered }
        ))
        let client = try EnrollmentClient(
            origin: URL(string: "https://raiders.redlattice.com")!,
            transport: { _ in throw TestError.recovery }
        )
        let operations = try ReEnrollmentOperations.live(
            paths: paths,
            companionVersion: "test",
            managedAgent: managed,
            outbox: outbox,
            enrollmentClient: client,
            uploadTransport: { _ in throw TestError.recovery },
            summarize: { _ in },
            confirmReEnrollment: { true },
            resolveQueue: { _ in .cancel },
            requestCode: { String(repeating: "c", count: 43) },
            delayMilliseconds: { _ in }
        )

        XCTAssertNil(try operations.loadJournal())
        XCTAssertEqual(try operations.readEnrollment(), old)
        XCTAssertTrue(try operations.proveCollectionOff())
        XCTAssertEqual(try operations.countQueue(), 0)
        try operations.unregisterAgent()
        XCTAssertFalse(service.registered)
        try operations.registerAgent()
        XCTAssertTrue(service.registered)

        let material = try operations.generateMaterial()
        let journal = RecoveryJournal(
            version: 1,
            operationID: material.operationID,
            replacementDeviceID: material.deviceID,
            replacementDeviceToken: material.deviceToken,
            companionVersion: operations.companionVersion,
            queueDisposition: .empty,
            phase: .replacementPrepared
        )
        try operations.writeJournal(journal)
        XCTAssertEqual(try operations.loadJournal(), journal)
        try operations.removeJournal()
        XCTAssertNil(try operations.loadJournal())
    }

    func testEmptyQueueCompletesInExactOrderAndRemainsOff() throws {
        let harness = Harness(queueCount: 0)

        XCTAssertEqual(try harness.run(), .completed)
        XCTAssertEqual(harness.actions, Self.happyPathActions)
        XCTAssertTrue(harness.collectionOff)
        XCTAssertTrue(harness.agentRegistered)
        XCTAssertNil(harness.journal)
        XCTAssertEqual(harness.promptedCodes, 1)
        XCTAssertEqual(harness.queueCount, 0)
        XCTAssertNil(harness.activeLock)
        for written in harness.journalWrites {
            let encoded = try JSONEncoder().encode(written)
            XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains(harness.code),
                           "journal contained enrollment code")
        }
    }

    func testDeliverAndDiscardResolveQueueBeforeRequestingCodeWithoutTransfer() throws {
        for disposition in [QueueDisposition.deliver, .discard] {
            let harness = Harness(queueCount: 3, queueDisposition: disposition)

            XCTAssertEqual(try harness.run(), .completed)
            XCTAssertEqual(harness.actions, Self.happyPathActions)
            XCTAssertEqual(harness.queueCount, 0)
            XCTAssertTrue(harness.queueOwnerToken == harness.old.deviceToken,
                          "queue resolved with the wrong credential")
            XCTAssertFalse(harness.queueOwnerToken == harness.current.deviceToken)
            XCTAssertLessThan(
                try XCTUnwrap(harness.actions.firstIndex(of: "resolve-queue")),
                try XCTUnwrap(harness.actions.firstIndex(of: "request-code"))
            )
            XCTAssertEqual(harness.journalWrites.first?.queueDisposition,
                           disposition == .deliver ? .delivered : .discarded)
            XCTAssertTrue(harness.collectionOff)
        }
    }

    func testCancelLeavesQueueAndEnrollmentUntouchedAndReregistersAgent() throws {
        let harness = Harness(queueCount: 3, queueDisposition: .cancel)
        let original = harness.current

        XCTAssertEqual(try harness.run(), .cancelled)
        XCTAssertEqual(harness.current, original)
        XCTAssertEqual(harness.queueCount, 3)
        XCTAssertEqual(harness.promptedCodes, 0)
        XCTAssertEqual(harness.replaceCalls, 0)
        XCTAssertNil(harness.journal)
        XCTAssertTrue(harness.agentRegistered)
        XCTAssertTrue(harness.collectionOff)
    }

    func testCollectionMustBeOffDoesNotUnregisterOrMutate() throws {
        let harness = Harness(queueCount: 2)
        harness.collectionOff = false
        let original = harness.current

        XCTAssertEqual(try harness.run(), .collectionMustBeOff)
        XCTAssertEqual(harness.actions, ["lock", "read-old-config", "prove-off"])
        XCTAssertEqual(harness.current, original)
        XCTAssertEqual(harness.queueCount, 2)
        XCTAssertTrue(harness.agentRegistered)
        XCTAssertNil(harness.journal)
    }

    func testInvalidEnrollmentRemovesOnlyPreparedJournalAndPreservesOldConfiguration() throws {
        let harness = Harness(queueCount: 0)
        harness.replacementResult = .invalidEnrollment
        let original = harness.current

        XCTAssertEqual(try harness.run(), .invalidEnrollment)
        XCTAssertEqual(harness.current, original)
        XCTAssertEqual(harness.journalWrites.map(\.phase), [.replacementPrepared])
        XCTAssertNil(harness.journal)
        XCTAssertTrue(harness.agentRegistered)
        XCTAssertTrue(harness.collectionOff)
    }

    func testAmbiguousReplacementUsesExactDelaysAndRecoveredNewSkipsReplacement() throws {
        let harness = Harness(queueCount: 0)
        harness.replacementResult = .ambiguous
        harness.newRecovery = [nil, nil, nil, harness.recovered]

        XCTAssertEqual(try harness.run(), .completed)
        XCTAssertEqual(harness.delays, [100, 250, 500, 1_000])
        XCTAssertEqual(harness.replaceCalls, 1)
        XCTAssertEqual(harness.recoveryTokenLabels, Array(repeating: "new", count: 4))
        XCTAssertTrue(harness.current.deviceToken == harness.newToken,
                      "replacement credential was not installed")

        let resumed = Harness(queueCount: 0)
        resumed.agentRegistered = false
        resumed.journal = resumed.preparedJournal
        resumed.serverActiveTokens = [resumed.newToken]
        resumed.newRecovery = [resumed.recovered]

        XCTAssertEqual(try resumed.run(), .completed)
        XCTAssertEqual(resumed.replaceCalls, 0)
        XCTAssertEqual(resumed.promptedCodes, 0)
        XCTAssertEqual(resumed.delays, [100])
        XCTAssertTrue(resumed.current.deviceToken == resumed.newToken,
                      "recovered credential was not installed")
    }

    func testAllNewUnauthorizedThenOldActiveClearsPreparedJournalAndAllowsFreshCode() throws {
        let harness = Harness(queueCount: 0)
        harness.agentRegistered = false
        harness.journal = harness.preparedJournal
        harness.newRecovery = [nil, nil, nil, nil]
        harness.oldRecovery = harness.oldRecovered

        XCTAssertEqual(try harness.run(), .invalidEnrollment)
        XCTAssertEqual(harness.delays, [100, 250, 500, 1_000])
        XCTAssertEqual(harness.recoveryTokenLabels,
                       Array(repeating: "new", count: 4) + ["old"])
        XCTAssertNil(harness.journal)
        XCTAssertTrue(harness.agentRegistered)
        XCTAssertEqual(harness.promptedCodes, 0)

        harness.replacementResult = .committed(harness.recovered)
        harness.serverActiveTokens = [harness.old.deviceToken]
        XCTAssertEqual(try harness.run(), .completed)
        XCTAssertEqual(harness.promptedCodes, 1)
    }

    func testNeitherCredentialCoherentKeepsJournalAgentUnregisteredAndOff() throws {
        let harness = Harness(queueCount: 0)
        harness.agentRegistered = false
        harness.journal = harness.preparedJournal
        harness.newRecovery = [nil, nil, nil, nil]
        harness.oldRecovery = nil
        harness.serverActiveTokens = []

        XCTAssertEqual(try harness.run(), .recoveryRequired)
        XCTAssertEqual(harness.journal, harness.preparedJournal)
        XCTAssertFalse(harness.agentRegistered)
        XCTAssertTrue(harness.collectionOff)
        XCTAssertEqual(harness.current, harness.old)
    }

    func testRecoveryErrorKeepsJournalWithoutRegistrationOrMutation() throws {
        let harness = Harness(queueCount: 0)
        harness.agentRegistered = false
        harness.journal = harness.preparedJournal
        harness.recoveryError = TestError.recovery

        XCTAssertEqual(try harness.run(), .recoveryRequired)
        XCTAssertEqual(harness.journal, harness.preparedJournal)
        XCTAssertFalse(harness.agentRegistered)
        XCTAssertTrue(harness.collectionOff)
        XCTAssertEqual(harness.current, harness.old)
    }

    func testThrowingReplaceResponseIsRecoveryRequiredAndNeverGuessedUncommitted() throws {
        let harness = Harness(queueCount: 0)
        harness.replaceError = EnrollmentClientError.corruptResponse

        XCTAssertEqual(try harness.run(), .recoveryRequired)
        XCTAssertEqual(harness.journal, harness.preparedJournal)
        XCTAssertFalse(harness.agentRegistered)
        XCTAssertTrue(harness.collectionOff)
        XCTAssertEqual(harness.current, harness.old)
        XCTAssertFalse(harness.actions.contains("delete-journal"))
    }

    func testResumeFromEveryDurablePhasePerformsOnlyRemainingMutations() throws {
        let phases: [(ReEnrollmentPhase, [String])] = [
            (.serverCommitted, [
                "lock", "recover-new", "persist-new-config",
                "journal(configurationInstalled)", "reset-collector",
                "journal(collectorReset)", "register", "journal(agentRegistered)",
                "verify-new-config-and-off", "delete-journal",
            ]),
            (.configurationInstalled, [
                "lock", "read-old-config", "reset-collector", "journal(collectorReset)", "register",
                "journal(agentRegistered)", "verify-new-config-and-off", "delete-journal",
            ]),
            (.collectorReset, [
                "lock", "read-old-config", "register", "journal(agentRegistered)",
                "verify-new-config-and-off", "delete-journal",
            ]),
            (.agentRegistered, [
                "lock", "read-old-config", "verify-new-config-and-off", "delete-journal",
            ]),
        ]

        for (phase, expectedActions) in phases {
            let harness = Harness(queueCount: 0)
            harness.agentRegistered = phase == .agentRegistered
            harness.journal = harness.journal(phase: phase)
            harness.serverActiveTokens = [harness.newToken]
            if phase == .serverCommitted {
                harness.newRecovery = [harness.recovered]
            } else {
                harness.current = harness.newConfiguration
            }

            XCTAssertEqual(try harness.run(), .completed, "phase \(phase)")
            XCTAssertEqual(harness.actions, expectedActions, "phase \(phase)")
            XCTAssertEqual(harness.current, harness.newConfiguration)
            XCTAssertTrue(harness.collectionOff)
            XCTAssertNil(harness.journal)
        }
    }

    func testCrashAfterEachPreCleanupBoundaryResumesWithoutRestoringOldEnrollment() throws {
        let boundaries: [ReEnrollmentActionBoundary] = [
            .lock, .readEnrollment, .proveCollectionOff, .unregisterAgent, .countQueue,
            .summarize, .confirmReEnrollment, .resolveQueue, .createJournal, .requestCode,
            .replace, .serverCommitted, .persistNewConfiguration, .configurationInstalled,
            .resetCollector, .collectorReset, .registerAgent, .agentRegistered,
            .verifyNewConfigurationAndOff,
        ]
        for boundary in boundaries {
            let harness = Harness(queueCount: 0)
            harness.crashBoundary = boundary

            XCTAssertThrowsError(try harness.run(), "boundary \(boundary)")
            harness.crashBoundary = nil

            var outcome: ReEnrollmentOutcome = .recoveryRequired
            for _ in 0..<3 {
                outcome = try harness.run()
                if outcome == .completed { break }
            }
            XCTAssertEqual(outcome, .completed, "boundary \(boundary)")
            XCTAssertEqual(harness.current, harness.newConfiguration, "boundary \(boundary)")
            XCTAssertTrue(harness.collectionOff, "boundary \(boundary)")
            XCTAssertNil(harness.journal, "boundary \(boundary)")
        }
    }

    func testCrashAtEveryAmbiguityProbeBoundaryKeepsRecoveryResumable() throws {
        for boundary in [
            ReEnrollmentActionBoundary.delay,
            .recoverNew,
            .recoverOld,
        ] {
            let harness = Harness(queueCount: 0)
            harness.agentRegistered = false
            harness.journal = harness.preparedJournal
            harness.newRecovery = [nil, nil, nil, nil]
            harness.oldRecovery = harness.oldRecovered
            harness.crashBoundary = boundary

            XCTAssertThrowsError(try harness.run(), "boundary \(boundary)")
            XCTAssertEqual(harness.journal?.phase, .replacementPrepared)
            XCTAssertFalse(harness.agentRegistered)
            XCTAssertTrue(harness.collectionOff)

            XCTAssertEqual(try harness.run(), .invalidEnrollment)
            XCTAssertNil(harness.journal)
            XCTAssertTrue(harness.agentRegistered)
        }
    }

    func testCrashAfterFinalJournalDeletionLeavesDurablyCompletedLocalState() throws {
        let harness = Harness(queueCount: 0)
        harness.crashBoundary = .deleteJournal

        XCTAssertThrowsError(try harness.run())
        XCTAssertNil(harness.journal)
        XCTAssertEqual(harness.current, harness.newConfiguration)
        XCTAssertTrue(harness.collectionOff)
        XCTAssertTrue(harness.agentRegistered)
    }

    func testSameAndDifferentRaiderSecretsInstallExactlyServerReturnedSecret() throws {
        for secret in [Data(repeating: 0x11, count: 32), Data(repeating: 0x44, count: 32)] {
            let harness = Harness(queueCount: 0, replacementSecret: secret)
            XCTAssertEqual(try harness.run(), .completed)
            XCTAssertEqual(harness.current.dedupeSecret, secret)
            XCTAssertEqual(harness.queueCount, 0)
            XCTAssertFalse(harness.serverActiveTokens.contains(harness.old.deviceToken))
            XCTAssertTrue(harness.serverActiveTokens.contains(harness.newToken))
        }
    }

    func testDiagnosticsNeverContainCredentialsOrIdentifiers() throws {
        let harness = Harness(queueCount: 0)
        harness.replaceError = EnrollmentClientError.corruptResponse
        _ = try harness.run()

        let diagnostics = String(describing: ReEnrollmentOutcome.recoveryRequired)
            + String(reflecting: ReEnrollmentOutcome.recoveryRequired)
        for secret in [
            harness.old.deviceToken,
            harness.newToken,
            harness.code,
            harness.preparedJournal.operationID.uuidString,
            harness.preparedJournal.replacementDeviceID.uuidString,
        ] {
            XCTAssertFalse(diagnostics.contains(secret), "diagnostics exposed secret material")
        }
    }

    private static let happyPathActions = [
        "lock", "read-old-config", "prove-off", "unregister", "count-queue",
        "summarize", "confirm-re-enroll", "resolve-queue",
        "create-journal(replacementPrepared)", "request-code", "replace",
        "journal(serverCommitted)", "persist-new-config",
        "journal(configurationInstalled)", "reset-collector", "journal(collectorReset)",
        "register", "journal(agentRegistered)", "verify-new-config-and-off",
        "delete-journal",
    ]
}

private enum TestError: Error { case recovery, crash }

private final class TestLock: ReEnrollmentLock, @unchecked Sendable {}

private final class ServiceState: @unchecked Sendable {
    var registered = true
}

private final class Harness: @unchecked Sendable {
    let old: EnrollmentConfiguration
    let newToken = String(repeating: "n", count: 43)
    let code = String(repeating: "c", count: 43)
    let material: ReplacementMaterial
    let recovered: RecoveredEnrollment
    let oldRecovered: RecoveredEnrollment
    let preparedJournal: RecoveryJournal
    let newConfiguration: EnrollmentConfiguration

    var current: EnrollmentConfiguration
    var collectionOff = true
    var agentRegistered = true
    var queueCount: Int
    var queueDisposition: QueueDisposition
    var queueOwnerToken: String
    var journal: RecoveryJournal?
    var journalWrites: [RecoveryJournal] = []
    var actions: [String] = []
    var delays: [Int] = []
    var recoveryTokens: [String] = []
    var recoveryTokenLabels: [String] {
        recoveryTokens.map { token in
            if token == newToken { return "new" }
            if token == old.deviceToken { return "old" }
            return "unknown"
        }
    }
    var newRecovery: [RecoveredEnrollment?] = []
    var oldRecovery: RecoveredEnrollment?
    var recoveryError: Error?
    var replacementResult: ReplacementHTTPResult
    var replaceError: Error?
    var replaceCalls = 0
    var promptedCodes = 0
    var serverActiveTokens: Set<String>
    var crashBoundary: ReEnrollmentActionBoundary?
    weak var activeLock: TestLock?

    init(
        queueCount: Int,
        queueDisposition: QueueDisposition = .deliver,
        replacementSecret: Data = Data(repeating: 0x44, count: 32)
    ) {
        let oldToken = String(repeating: "o", count: 43)
        old = try! EnrollmentConfiguration(
            deviceID: "11111111-1111-4111-8111-111111111111",
            deviceToken: oldToken,
            dedupeSecret: Data(repeating: 0x11, count: 32),
            serverURL: URL(string: "https://raiders.redlattice.com")!,
            cutoverAtMS: 0,
            enabledSurfaces: [.codexCLI, .codexDesktop]
        )
        material = ReplacementMaterial(
            operationID: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!,
            deviceID: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!,
            deviceToken: newToken
        )
        recovered = RecoveredEnrollment(
            deviceID: material.deviceID.uuidString.lowercased(),
            dedupeSecret: replacementSecret,
            serverURL: URL(string: "https://raiders.redlattice.com")!,
            cutoverAtMS: 0,
            enabledSurfaces: [.codexCLI, .codexDesktop]
        )
        oldRecovered = RecoveredEnrollment(
            deviceID: old.deviceID.lowercased(),
            dedupeSecret: old.dedupeSecret,
            serverURL: old.serverURL,
            cutoverAtMS: old.cutoverAtMS,
            enabledSurfaces: old.enabledSurfaces
        )
        preparedJournal = RecoveryJournal(
            version: 1,
            operationID: material.operationID,
            replacementDeviceID: material.deviceID,
            replacementDeviceToken: material.deviceToken,
            companionVersion: "0.4.8",
            queueDisposition: queueCount == 0 ? .empty :
                (queueDisposition == .deliver ? .delivered : .discarded),
            phase: .replacementPrepared
        )
        newConfiguration = try! EnrollmentConfiguration(
            deviceID: recovered.deviceID,
            deviceToken: newToken,
            dedupeSecret: recovered.dedupeSecret,
            serverURL: recovered.serverURL,
            cutoverAtMS: recovered.cutoverAtMS,
            enabledSurfaces: recovered.enabledSurfaces
        )
        current = old
        self.queueCount = queueCount
        self.queueDisposition = queueDisposition
        queueOwnerToken = oldToken
        replacementResult = .committed(recovered)
        serverActiveTokens = [oldToken]
    }

    func journal(phase: ReEnrollmentPhase) -> RecoveryJournal {
        var value = preparedJournal
        value.phase = phase
        return value
    }

    func run() throws -> ReEnrollmentOutcome {
        try ReEnrollmentCoordinator(operations: operations()).run()
    }

    private func operations() -> ReEnrollmentOperations {
        ReEnrollmentOperations(
            companionVersion: "0.4.8",
            acquireLock: {
                self.actions.append("lock")
                let lock = TestLock()
                self.activeLock = lock
                return lock
            },
            loadJournal: { self.journal },
            readEnrollment: {
                self.actions.append("read-old-config")
                return self.current
            },
            proveCollectionOff: {
                self.actions.append("prove-off")
                return self.collectionOff
            },
            unregisterAgent: {
                self.actions.append("unregister")
                self.agentRegistered = false
            },
            countQueue: {
                self.actions.append("count-queue")
                return self.queueCount
            },
            summarize: { _ in self.actions.append("summarize") },
            confirmReEnrollment: {
                self.actions.append("confirm-re-enroll")
                return true
            },
            resolveQueue: { count in
                self.actions.append("resolve-queue")
                return count == 0 ? .deliver : self.queueDisposition
            },
            deliverQueue: { configuration in
                XCTAssertTrue(configuration.deviceToken == self.old.deviceToken,
                              "delivery used the wrong credential")
                self.queueOwnerToken = configuration.deviceToken
                self.queueCount = 0
            },
            discardQueue: {
                self.queueCount = 0
            },
            generateMaterial: { self.material },
            writeJournal: { value in
                self.journal = value
                self.journalWrites.append(value)
                if value.phase == .replacementPrepared, self.journalWrites.count == 1 {
                    self.actions.append("create-journal(replacementPrepared)")
                } else {
                    self.actions.append("journal(\(value.phase.rawValue))")
                }
            },
            requestCode: {
                self.actions.append("request-code")
                self.promptedCodes += 1
                return self.code
            },
            replace: { oldConfiguration, code, material, _ in
                self.actions.append("replace")
                self.replaceCalls += 1
                XCTAssertEqual(oldConfiguration, self.old)
                XCTAssertTrue(code == self.code, "replacement used the wrong code")
                XCTAssertEqual(material, self.material)
                if let replaceError = self.replaceError { throw replaceError }
                if case .committed = self.replacementResult {
                    self.serverActiveTokens.remove(self.old.deviceToken)
                    self.serverActiveTokens.insert(self.newToken)
                }
                return self.replacementResult
            },
            recover: { token in
                self.recoveryTokens.append(token)
                if token == self.newToken { self.actions.append("recover-new") }
                if let recoveryError = self.recoveryError { throw recoveryError }
                if token == self.newToken {
                    if !self.newRecovery.isEmpty { return self.newRecovery.removeFirst() }
                    return self.serverActiveTokens.contains(token) ? self.recovered : nil
                }
                return self.oldRecovery ??
                    (self.serverActiveTokens.contains(token) ? self.oldRecovered : nil)
            },
            persistEnrollment: { configuration in
                self.actions.append("persist-new-config")
                self.current = configuration
            },
            resetCollector: { surfaces in
                self.actions.append("reset-collector")
                XCTAssertEqual(Set(surfaces), Set(self.recovered.enabledSurfaces))
                XCTAssertEqual(self.queueCount, 0)
                self.collectionOff = true
            },
            registerAgent: {
                self.actions.append("register")
                self.agentRegistered = true
            },
            verifyEnrollmentAndOff: { expected in
                XCTAssertNotNil(self.activeLock, "lifecycle lock released before verification")
                self.actions.append("verify-new-config-and-off")
                return self.current == expected && self.collectionOff
            },
            delayMilliseconds: { value in self.delays.append(value) },
            removeJournal: {
                XCTAssertNotNil(self.activeLock, "lifecycle lock released before journal cleanup")
                self.actions.append("delete-journal")
                self.journal = nil
            },
            interruptionPoint: { boundary in
                if self.crashBoundary == boundary {
                    self.crashBoundary = nil
                    throw TestError.crash
                }
            }
        )
    }
}

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
            requestCode: {
                service.requestedCodes += 1
                return String(repeating: "c", count: 43)
            },
            delayMilliseconds: { _ in },
            acquireLock: { TestLock() }
        )

        XCTAssertNil(try operations.loadJournal())
        XCTAssertEqual(try operations.readEnrollment(), old)
        XCTAssertTrue(try operations.proveCollectionOff())
        XCTAssertEqual(try operations.countQueue(), 0)
        try operations.unregisterAgent()
        XCTAssertFalse(service.registered)
        try operations.registerAgent()
        XCTAssertTrue(service.registered)

        let queued = RunEventV1(
            schemaVersion: 1,
            companionVersion: "test",
            deviceID: old.deviceID,
            provider: .codex,
            surface: .codexCLI,
            runKey: String(repeating: "a", count: 64),
            sequence: 1,
            eventTimeMS: 1,
            observedAtMS: 1,
            startedAtMS: 1,
            state: .open,
            usage: .init(input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0),
            model: nil,
            effort: nil,
            idempotencyKey: String(repeating: "b", count: 64)
        )
        _ = try outbox.enqueue(queued)
        XCTAssertEqual(try outbox.queuedCount(), 1)
        let originalRecords = try outbox.records(limit: 10)
        XCTAssertTrue(
            try operations.verifyEnrollmentAndOff(old, false),
            "cancellation verification must permit an unchanged nonempty queue"
        )

        XCTAssertEqual(try ReEnrollmentCoordinator(operations: operations).run(), .cancelled)
        XCTAssertEqual(try EnrollmentConfiguration.loadExisting(from: paths.enrollment), old)
        XCTAssertEqual(try outbox.queuedCount(), 1)
        XCTAssertEqual(try outbox.records(limit: 10), originalRecords)
        XCTAssertTrue(service.registered)
        XCTAssertEqual(service.requestedCodes, 0)
        XCTAssertNil(try operations.loadJournal())

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

    func testLiveOperationsResumeAgentRegisteredAndProveFinalEnabledState() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true).appendingPathComponent(
            "rr-task4-live-resume-\(UUID().uuidString)",
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
        let replacementDeviceID = UUID(
            uuidString: "33333333-3333-4333-8333-333333333333"
        )!
        let replacementToken = String(repeating: "n", count: 43)
        let secret = Data(repeating: 0x44, count: 32)
        let expected = try EnrollmentConfiguration(
            deviceID: replacementDeviceID.uuidString.lowercased(),
            deviceToken: replacementToken,
            dedupeSecret: secret,
            serverURL: URL(string: "https://raiders.redlattice.com")!,
            cutoverAtMS: 42,
            enabledSurfaces: [.codexCLI, .codexDesktop]
        )
        try expected.persist(to: paths.enrollment)
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
        let journal = RecoveryJournal(
            version: 1,
            operationID: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!,
            replacementDeviceID: replacementDeviceID,
            replacementDeviceToken: replacementToken,
            companionVersion: "test",
            queueDisposition: .empty,
            phase: .agentRegistered
        )
        let journalStore = try RecoveryJournalStore(paths: paths)
        try journalStore.write(journal)
        let outbox = try Outbox(directory: paths.agent.outboxDirectory)
        let service = ServiceState()
        let managed = ManagedAgentServiceController(operations: ManagedAgentServiceOperations(
            register: { service.registered = true },
            unregister: { service.registered = false },
            status: { service.registered ? .enabled : .notRegistered }
        ))
        let secretHex = secret.map { String(format: "%02x", $0) }.joined()
        let responseBody = try JSONSerialization.data(withJSONObject: [
            "device_id": replacementDeviceID.uuidString.lowercased(),
            "dedupe_secret": secretHex,
            "server_url": "https://raiders.redlattice.com",
            "cutover_at": 42,
            "enabled_surfaces": ["codex_cli", "codex_desktop"],
        ])
        let client = try EnrollmentClient(
            origin: URL(string: "https://raiders.redlattice.com")!,
            transport: { _ in UploadHTTPResponse(statusCode: 200, body: responseBody) }
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
            delayMilliseconds: { _ in },
            acquireLock: { TestLock() }
        )

        XCTAssertEqual(try ReEnrollmentCoordinator(operations: operations).run(), .completed)
        XCTAssertNil(try journalStore.load())
        XCTAssertEqual(try EnrollmentConfiguration.loadExisting(from: paths.enrollment), expected)
        XCTAssertTrue(service.registered)
        XCTAssertTrue(try operations.verifyEnrollmentAndOff(expected, true))
    }

    func testLiveOperationsFailClosedOnEveryInvalidCanonicalQueueObservation() throws {
        let cases: [(String, (URL, URL) throws -> Void)] = [
            ("malformed", { directory, _ in
                let record = directory.appendingPathComponent(String(repeating: "a", count: 64) + ".json")
                try Data("malformed".utf8).write(to: record)
                XCTAssertEqual(Darwin.chmod(record.path, 0o600), 0)
            }),
            ("nominally-empty", { directory, _ in
                let record = directory.appendingPathComponent(String(repeating: "b", count: 64) + ".json")
                try Data().write(to: record)
                XCTAssertEqual(Darwin.chmod(record.path, 0o600), 0)
            }),
            ("symlink", { directory, root in
                let outside = root.appendingPathComponent("outside-record")
                try Data("outside".utf8).write(to: outside)
                try FileManager.default.createSymbolicLink(
                    at: directory.appendingPathComponent(String(repeating: "c", count: 64) + ".json"),
                    withDestinationURL: outside
                )
            }),
            ("hard-link", { directory, root in
                let event = makeLiveQueueEvent(idempotencyKey: String(repeating: "d", count: 64))
                let record = directory.appendingPathComponent(event.idempotencyKey + ".json")
                try PrivacyEncoder().encode(event).write(to: record)
                XCTAssertEqual(Darwin.chmod(record.path, 0o600), 0)
                try FileManager.default.linkItem(
                    at: record,
                    to: root.appendingPathComponent("outside-hard-link")
                )
            }),
            ("replaced", { directory, root in
                let event = makeLiveQueueEvent(idempotencyKey: String(repeating: "e", count: 64))
                let record = directory.appendingPathComponent(event.idempotencyKey + ".json")
                try PrivacyEncoder().encode(event).write(to: record)
                XCTAssertEqual(Darwin.chmod(record.path, 0o600), 0)
                let replacement = root.appendingPathComponent("replacement-record")
                try Data().write(to: replacement)
                XCTAssertEqual(Darwin.chmod(replacement.path, 0o600), 0)
                _ = Darwin.rename(replacement.path, record.path)
            }),
        ]

        for (name, corrupt) in cases {
            let fixture = try makeLiveQueueProofFixture(name: name)
            defer { try? FileManager.default.removeItem(at: fixture.root) }
            try corrupt(fixture.paths.agent.outboxDirectory, fixture.root)

            XCTAssertThrowsError(
                try ReEnrollmentCoordinator(operations: fixture.operations).run(),
                "initial queue proof accepted \(name)"
            )
            XCTAssertNil(try fixture.journalStore.load(), "journaled queue as empty for \(name)")
            XCTAssertEqual(fixture.networkRequests.value, 0, "requested replacement for \(name)")
            try fixture.operations.registerAgent()
            XCTAssertThrowsError(
                try fixture.operations.verifyEnrollmentAndOff(fixture.enrollment, true),
                "final empty proof accepted \(name)"
            )
        }
    }

    func testLiveReEnrollmentPreflightRejectsHardLinkedEnrollmentBeforeNetworkMutation() throws {
        let fixture = try makeLiveQueueProofFixture(name: "hard-linked-enrollment")
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try FileManager.default.linkItem(
            at: fixture.paths.enrollment,
            to: fixture.root.appendingPathComponent("outside-enrollment")
        )

        XCTAssertThrowsError(try ReEnrollmentCoordinator(operations: fixture.operations).run())
        XCTAssertEqual(fixture.networkRequests.value, 0)
        XCTAssertNil(try fixture.journalStore.load())
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

    func testPreparedResumeUnregistersBeforeRecoveryAfterCrashDuringInvalidCleanup() throws {
        let harness = Harness(queueCount: 0)
        harness.replacementResult = .invalidEnrollment
        harness.crashBoundary = .registerAgent

        XCTAssertThrowsError(try harness.run())
        XCTAssertEqual(harness.journal?.phase, .replacementPrepared)
        XCTAssertTrue(harness.agentRegistered)

        let resumeActionStart = harness.actions.count
        XCTAssertEqual(try harness.run(), .invalidEnrollment)
        XCTAssertEqual(
            Array(harness.actions[resumeActionStart...]),
            [
                "lock", "unregister", "read-old-config",
                "recover-new", "recover-new", "recover-new", "recover-new",
                "register", "verify-new-config-and-off", "delete-journal",
            ]
        )
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
                "lock", "unregister", "recover-new", "persist-new-config",
                "journal(configurationInstalled)", "reset-collector",
                "journal(collectorReset)", "register", "journal(agentRegistered)",
                "verify-new-config-and-off", "delete-journal",
            ]),
            (.configurationInstalled, [
                "lock", "unregister", "recover-new", "read-old-config", "reset-collector",
                "journal(collectorReset)", "register",
                "journal(agentRegistered)", "verify-new-config-and-off", "delete-journal",
            ]),
            (.collectorReset, [
                "lock", "unregister", "recover-new", "read-old-config", "register",
                "journal(agentRegistered)",
                "verify-new-config-and-off", "delete-journal",
            ]),
            (.agentRegistered, [
                "lock", "unregister", "recover-new", "read-old-config", "register",
                "verify-new-config-and-off", "delete-journal",
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

    func testAgentRegisteredResumeRequiresFinalEnabledProof() throws {
        for status in [
            ManagedAgentStatus.notRegistered,
            .notFound,
            .requiresApproval,
        ] {
            let harness = Harness(queueCount: 0)
            harness.current = harness.newConfiguration
            harness.journal = harness.journal(phase: .agentRegistered)
            harness.serverActiveTokens = [harness.newToken]
            harness.agentRegistered = false
            harness.registeredStatusAfterRegister = status

            XCTAssertEqual(try harness.run(), .recoveryRequired, "status \(status)")
            XCTAssertEqual(harness.journal?.phase, .agentRegistered, "status \(status)")
            XCTAssertFalse(harness.agentRegistered, "status \(status)")
            XCTAssertTrue(harness.collectionOff, "status \(status)")
        }
    }

    func testFailedFinalProofReturnsToUnregisteredRecoveryState() throws {
        let harness = Harness(queueCount: 0)
        harness.current = harness.newConfiguration
        harness.journal = harness.journal(phase: .agentRegistered)
        harness.serverActiveTokens = [harness.newToken]
        harness.agentRegistered = false
        harness.verificationSucceeds = false

        XCTAssertEqual(try harness.run(), .recoveryRequired)
        XCTAssertEqual(harness.journal?.phase, .agentRegistered)
        XCTAssertFalse(harness.agentRegistered)
        XCTAssertTrue(harness.collectionOff)
    }

    func testMutateThenThrowRegistrationCleansUpEveryCoordinatorPath() throws {
        let invalid = Harness(queueCount: 0)
        invalid.replacementResult = .invalidEnrollment
        invalid.registerMutatesBeforeThrow = true
        invalid.registerError = SensitiveOperationError(harness: invalid)

        XCTAssertEqual(try? invalid.run(), .recoveryRequired)
        XCTAssertEqual(invalid.journal?.phase, .replacementPrepared)
        XCTAssertEqual(Array(invalid.actions.suffix(2)), ["register", "unregister"])
        XCTAssertFalse(invalid.agentRegistered)
        XCTAssertEqual(invalid.current, invalid.old)
        XCTAssertEqual(invalid.queueCount, 0)
        XCTAssertTrue(invalid.collectionOff)

        let cancellation = Harness(queueCount: 3, queueDisposition: .cancel)
        cancellation.registerMutatesBeforeThrow = true
        cancellation.registerError = SensitiveOperationError(harness: cancellation)

        XCTAssertEqual(try? cancellation.run(), .recoveryRequired)
        XCTAssertNil(cancellation.journal)
        XCTAssertEqual(Array(cancellation.actions.suffix(2)), ["register", "unregister"])
        XCTAssertFalse(cancellation.agentRegistered)
        XCTAssertEqual(cancellation.current, cancellation.old)
        XCTAssertEqual(cancellation.queueCount, 3)
        XCTAssertTrue(cancellation.collectionOff)

        let completion = Harness(queueCount: 0)
        completion.registerMutatesBeforeThrow = true
        completion.registerError = SensitiveOperationError(harness: completion)

        XCTAssertEqual(try? completion.run(), .recoveryRequired)
        XCTAssertEqual(completion.journal?.phase, .collectorReset)
        XCTAssertEqual(Array(completion.actions.suffix(2)), ["register", "unregister"])
        XCTAssertFalse(completion.agentRegistered)
        XCTAssertEqual(completion.current, completion.newConfiguration)
        XCTAssertEqual(completion.queueCount, 0)
        XCTAssertTrue(completion.collectionOff)
    }

    func testThrowingVerifierCleansUpInvalidAndFinalRegistration() throws {
        let invalid = Harness(queueCount: 0)
        invalid.replacementResult = .invalidEnrollment
        invalid.verificationError = SensitiveOperationError(harness: invalid)

        XCTAssertEqual(try? invalid.run(), .recoveryRequired)
        XCTAssertEqual(invalid.journal?.phase, .replacementPrepared)
        XCTAssertEqual(
            Array(invalid.actions.suffix(3)),
            ["register", "verify-new-config-and-off", "unregister"]
        )
        XCTAssertFalse(invalid.agentRegistered)
        XCTAssertEqual(invalid.current, invalid.old)
        XCTAssertTrue(invalid.collectionOff)

        let completion = Harness(queueCount: 0)
        completion.verificationError = SensitiveOperationError(harness: completion)

        XCTAssertEqual(try? completion.run(), .recoveryRequired)
        XCTAssertEqual(completion.journal?.phase, .agentRegistered)
        XCTAssertEqual(
            Array(completion.actions.suffix(3)),
            ["journal(agentRegistered)", "verify-new-config-and-off", "unregister"]
        )
        XCTAssertFalse(completion.agentRegistered)
        XCTAssertEqual(completion.current, completion.newConfiguration)
        XCTAssertTrue(completion.collectionOff)
    }

    func testThrowingCancellationVerifierAndQueueCountCleanUpWithoutMutation() throws {
        let throwingVerifier = Harness(queueCount: 3, queueDisposition: .cancel)
        throwingVerifier.verificationError = SensitiveOperationError(harness: throwingVerifier)

        XCTAssertEqual(try? throwingVerifier.run(), .recoveryRequired)
        XCTAssertNil(throwingVerifier.journal)
        XCTAssertEqual(
            Array(throwingVerifier.actions.suffix(3)),
            ["register", "verify-new-config-and-off", "unregister"]
        )
        XCTAssertFalse(throwingVerifier.agentRegistered)
        XCTAssertEqual(throwingVerifier.current, throwingVerifier.old)
        XCTAssertEqual(throwingVerifier.queueCount, 3)
        XCTAssertTrue(throwingVerifier.collectionOff)

        let throwingCount = Harness(queueCount: 3, queueDisposition: .cancel)
        throwingCount.queueCountErrorOnCall = 2
        throwingCount.queueCountError = SensitiveOperationError(harness: throwingCount)

        XCTAssertEqual(try? throwingCount.run(), .recoveryRequired)
        XCTAssertNil(throwingCount.journal)
        XCTAssertEqual(
            Array(throwingCount.actions.suffix(4)),
            ["register", "verify-new-config-and-off", "count-queue", "unregister"]
        )
        XCTAssertFalse(throwingCount.agentRegistered)
        XCTAssertEqual(throwingCount.current, throwingCount.old)
        XCTAssertEqual(throwingCount.queueCount, 3)
        XCTAssertTrue(throwingCount.collectionOff)
    }

    func testCleanupFailureExposesOnlyContentFreeCoordinatorError() throws {
        enum CleanupFailure {
            case unregisterThrows
            case proofThrows
            case proofReturnsFalse
        }

        for mode in [
            CleanupFailure.unregisterThrows,
            .proofThrows,
            .proofReturnsFalse,
        ] {
            let harness = Harness(queueCount: 0)
            harness.verificationError = SensitiveOperationError(harness: harness)
            switch mode {
            case .unregisterThrows:
                harness.unregisterErrorOnCall = 2
                harness.unregisterError = SensitiveOperationError(
                    harness: harness,
                    additionalSentinel: SensitiveOperationError.cleanupSentinel
                )
            case .proofThrows:
                harness.verifyUnregisteredErrorOnCall = 2
                harness.verifyUnregisteredError = SensitiveOperationError(
                    harness: harness,
                    additionalSentinel: SensitiveOperationError.cleanupSentinel
                )
            case .proofReturnsFalse:
                harness.verifyUnregisteredFailureOnCall = 2
            }

            XCTAssertThrowsError(try harness.run()) { error in
                let diagnostics = String(describing: error) + String(reflecting: error)
                XCTAssertEqual(error as? ReEnrollmentCoordinatorError, .operationFailed)
                XCTAssertFalse(diagnostics.contains(harness.old.deviceToken))
                XCTAssertFalse(diagnostics.contains(harness.newToken))
                XCTAssertFalse(diagnostics.contains(harness.code))
                XCTAssertFalse(diagnostics.contains(harness.preparedJournal.operationID.uuidString))
                XCTAssertFalse(diagnostics.contains(harness.preparedJournal.replacementDeviceID.uuidString))
                XCTAssertFalse(diagnostics.contains(SensitiveOperationError.responseSentinel))
                XCTAssertFalse(diagnostics.contains(SensitiveOperationError.querySentinel))
                XCTAssertFalse(diagnostics.contains(SensitiveOperationError.cleanupSentinel))
            }
            XCTAssertEqual(harness.journal?.phase, .agentRegistered)
            XCTAssertTrue(harness.collectionOff)
            XCTAssertEqual(harness.current, harness.newConfiguration)
            XCTAssertEqual(harness.queueCount, 0)
            XCTAssertEqual(harness.unregisterCalls, 2)
            if case .unregisterThrows = mode {
                XCTAssertTrue(harness.agentRegistered)
            } else {
                XCTAssertFalse(harness.agentRegistered)
            }
        }
    }

    func testThrowingPostRegistrationJournalMutationsAlsoCleanUp() throws {
        let journalWrite = Harness(queueCount: 0)
        journalWrite.journalWriteErrorPhase = .agentRegistered
        journalWrite.journalWriteError = SensitiveOperationError(harness: journalWrite)

        XCTAssertEqual(try? journalWrite.run(), .recoveryRequired)
        XCTAssertEqual(journalWrite.journal?.phase, .collectorReset)
        XCTAssertEqual(
            Array(journalWrite.actions.suffix(3)),
            ["register", "journal(agentRegistered)", "unregister"]
        )
        XCTAssertFalse(journalWrite.agentRegistered)
        XCTAssertEqual(journalWrite.current, journalWrite.newConfiguration)
        XCTAssertTrue(journalWrite.collectionOff)

        let invalidRemoval = Harness(queueCount: 0)
        invalidRemoval.replacementResult = .invalidEnrollment
        invalidRemoval.removeJournalError = SensitiveOperationError(harness: invalidRemoval)

        XCTAssertEqual(try? invalidRemoval.run(), .recoveryRequired)
        XCTAssertEqual(invalidRemoval.journal?.phase, .replacementPrepared)
        XCTAssertEqual(
            Array(invalidRemoval.actions.suffix(3)),
            ["verify-new-config-and-off", "delete-journal", "unregister"]
        )
        XCTAssertFalse(invalidRemoval.agentRegistered)
        XCTAssertEqual(invalidRemoval.current, invalidRemoval.old)
        XCTAssertTrue(invalidRemoval.collectionOff)

        let finalRemoval = Harness(queueCount: 0)
        finalRemoval.removeJournalError = SensitiveOperationError(harness: finalRemoval)

        XCTAssertEqual(try? finalRemoval.run(), .recoveryRequired)
        XCTAssertEqual(finalRemoval.journal?.phase, .agentRegistered)
        XCTAssertEqual(
            Array(finalRemoval.actions.suffix(3)),
            ["verify-new-config-and-off", "delete-journal", "unregister"]
        )
        XCTAssertFalse(finalRemoval.agentRegistered)
        XCTAssertEqual(finalRemoval.current, finalRemoval.newConfiguration)
        XCTAssertTrue(finalRemoval.collectionOff)
    }

    func testInstalledResumeRequiresFullAuthoritativeConfigurationCoherence() throws {
        let mismatches: [(String, (Harness) -> EnrollmentConfiguration)] = [
            ("device ID", { harness in
                try! EnrollmentConfiguration(
                    deviceID: "44444444-4444-4444-8444-444444444444",
                    deviceToken: harness.newToken,
                    dedupeSecret: harness.recovered.dedupeSecret,
                    serverURL: harness.recovered.serverURL,
                    cutoverAtMS: harness.recovered.cutoverAtMS,
                    enabledSurfaces: harness.recovered.enabledSurfaces
                )
            }),
            ("token", { harness in
                try! EnrollmentConfiguration(
                    deviceID: harness.recovered.deviceID,
                    deviceToken: String(repeating: "x", count: 43),
                    dedupeSecret: harness.recovered.dedupeSecret,
                    serverURL: harness.recovered.serverURL,
                    cutoverAtMS: harness.recovered.cutoverAtMS,
                    enabledSurfaces: harness.recovered.enabledSurfaces
                )
            }),
            ("secret", { harness in
                try! EnrollmentConfiguration(
                    deviceID: harness.recovered.deviceID,
                    deviceToken: harness.newToken,
                    dedupeSecret: Data(repeating: 0x55, count: 32),
                    serverURL: harness.recovered.serverURL,
                    cutoverAtMS: harness.recovered.cutoverAtMS,
                    enabledSurfaces: harness.recovered.enabledSurfaces
                )
            }),
            ("cutover", { harness in
                try! EnrollmentConfiguration(
                    deviceID: harness.recovered.deviceID,
                    deviceToken: harness.newToken,
                    dedupeSecret: harness.recovered.dedupeSecret,
                    serverURL: harness.recovered.serverURL,
                    cutoverAtMS: 9,
                    enabledSurfaces: harness.recovered.enabledSurfaces
                )
            }),
            ("surfaces", { harness in
                try! EnrollmentConfiguration(
                    deviceID: harness.recovered.deviceID,
                    deviceToken: harness.newToken,
                    dedupeSecret: harness.recovered.dedupeSecret,
                    serverURL: harness.recovered.serverURL,
                    cutoverAtMS: harness.recovered.cutoverAtMS,
                    enabledSurfaces: [.codexCLI]
                )
            }),
        ]

        for phase in [
            ReEnrollmentPhase.configurationInstalled,
            .collectorReset,
            .agentRegistered,
        ] {
            for (label, mismatch) in mismatches {
                let harness = Harness(queueCount: 0)
                harness.current = mismatch(harness)
                harness.journal = harness.journal(phase: phase)
                harness.serverActiveTokens = [harness.newToken]
                harness.agentRegistered = true

                XCTAssertEqual(
                    try harness.run(),
                    .recoveryRequired,
                    "phase \(phase), mismatch \(label)"
                )
                XCTAssertEqual(harness.journal?.phase, phase)
                XCTAssertFalse(harness.agentRegistered)
                XCTAssertTrue(harness.collectionOff)
            }
        }

        let originHarness = Harness(queueCount: 0)
        originHarness.current = originHarness.newConfiguration
        originHarness.journal = originHarness.journal(phase: .configurationInstalled)
        originHarness.serverActiveTokens = [originHarness.newToken]
        originHarness.recoveredOverride = RecoveredEnrollment(
            deviceID: originHarness.recovered.deviceID,
            dedupeSecret: originHarness.recovered.dedupeSecret,
            serverURL: URL(string: "https://unexpected.invalid")!,
            cutoverAtMS: originHarness.recovered.cutoverAtMS,
            enabledSurfaces: originHarness.recovered.enabledSurfaces
        )

        XCTAssertEqual(try originHarness.run(), .recoveryRequired)
        XCTAssertEqual(originHarness.journal?.phase, .configurationInstalled)
        XCTAssertFalse(originHarness.agentRegistered)
    }

    func testCrashBeforeJournalCreationStartsFreshAndCompletesOnFirstResume() throws {
        let boundaries: [ReEnrollmentActionBoundary] = [
            .lock, .readEnrollment, .proveCollectionOff, .unregisterAgent, .countQueue,
            .summarize, .confirmReEnrollment, .resolveQueue,
        ]
        for boundary in boundaries {
            let harness = Harness(queueCount: 0)
            harness.crashBoundary = boundary

            XCTAssertThrowsError(try harness.run(), "boundary \(boundary)")
            XCTAssertNil(harness.journal, "boundary \(boundary)")

            let resumeActionStart = harness.actions.count
            XCTAssertEqual(try harness.run(), .completed, "boundary \(boundary)")
            XCTAssertEqual(
                Array(harness.actions[resumeActionStart...]),
                Self.happyPathActions,
                "boundary \(boundary)"
            )
            XCTAssertEqual(harness.current, harness.newConfiguration, "boundary \(boundary)")
            XCTAssertTrue(harness.collectionOff, "boundary \(boundary)")
            XCTAssertNil(harness.journal, "boundary \(boundary)")
        }
    }

    func testCrashWithPreparedJournalHasExplicitFirstResumeOutcome() throws {
        for boundary in [
            ReEnrollmentActionBoundary.createJournal,
            .requestCode,
        ] {
            let harness = Harness(queueCount: 0)
            harness.crashBoundary = boundary

            XCTAssertThrowsError(try harness.run(), "boundary \(boundary)")
            XCTAssertEqual(harness.journal?.phase, .replacementPrepared)

            let resumeActionStart = harness.actions.count
            XCTAssertEqual(try harness.run(), .invalidEnrollment, "boundary \(boundary)")
            XCTAssertEqual(
                Array(harness.actions[resumeActionStart...]),
                [
                    "lock", "unregister", "read-old-config",
                    "recover-new", "recover-new", "recover-new", "recover-new",
                    "register", "verify-new-config-and-off", "delete-journal",
                ],
                "boundary \(boundary)"
            )
            XCTAssertEqual(harness.current, harness.old, "boundary \(boundary)")
            XCTAssertTrue(harness.collectionOff, "boundary \(boundary)")
            XCTAssertNil(harness.journal, "boundary \(boundary)")
        }
    }

    func testCrashAfterReplacementMutationCompletesOnFirstResume() throws {
        let boundaries: [ReEnrollmentActionBoundary] = [
            .replace, .serverCommitted, .persistNewConfiguration, .configurationInstalled,
            .resetCollector, .collectorReset, .registerAgent, .agentRegistered,
            .verifyNewConfigurationAndOff,
        ]
        for boundary in boundaries {
            let harness = Harness(queueCount: 0)
            harness.crashBoundary = boundary

            XCTAssertThrowsError(try harness.run(), "boundary \(boundary)")
            XCTAssertNotNil(harness.journal, "boundary \(boundary)")

            let resumeActionStart = harness.actions.count
            XCTAssertEqual(try harness.run(), .completed, "boundary \(boundary)")
            XCTAssertEqual(
                Array(harness.actions[resumeActionStart...]),
                expectedResumeActions(after: boundary),
                "boundary \(boundary)"
            )
            XCTAssertEqual(harness.current, harness.newConfiguration, "boundary \(boundary)")
            XCTAssertTrue(harness.collectionOff, "boundary \(boundary)")
            XCTAssertNil(harness.journal, "boundary \(boundary)")
        }

        func expectedResumeActions(
            after boundary: ReEnrollmentActionBoundary
        ) -> [String] {
            switch boundary {
            case .replace:
                return [
                    "lock", "unregister", "read-old-config", "recover-new",
                    "journal(serverCommitted)", "persist-new-config",
                    "journal(configurationInstalled)", "reset-collector",
                    "journal(collectorReset)", "register", "journal(agentRegistered)",
                    "verify-new-config-and-off", "delete-journal",
                ]
            case .serverCommitted, .persistNewConfiguration:
                return [
                    "lock", "unregister", "recover-new", "persist-new-config",
                    "journal(configurationInstalled)", "reset-collector",
                    "journal(collectorReset)", "register", "journal(agentRegistered)",
                    "verify-new-config-and-off", "delete-journal",
                ]
            case .configurationInstalled, .resetCollector:
                return [
                    "lock", "unregister", "recover-new", "read-old-config",
                    "reset-collector", "journal(collectorReset)", "register",
                    "journal(agentRegistered)", "verify-new-config-and-off", "delete-journal",
                ]
            case .collectorReset, .registerAgent:
                return [
                    "lock", "unregister", "recover-new", "read-old-config", "register",
                    "journal(agentRegistered)", "verify-new-config-and-off", "delete-journal",
                ]
            case .agentRegistered, .verifyNewConfigurationAndOff:
                return [
                    "lock", "unregister", "recover-new", "read-old-config", "register",
                    "verify-new-config-and-off", "delete-journal",
                ]
            default:
                XCTFail("unexpected post-replacement boundary")
                return []
            }
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

            let resumeActionStart = harness.actions.count
            XCTAssertEqual(try harness.run(), .invalidEnrollment)
            XCTAssertEqual(
                Array(harness.actions[resumeActionStart...]),
                [
                    "lock", "unregister", "read-old-config",
                    "recover-new", "recover-new", "recover-new", "recover-new",
                    "register", "verify-new-config-and-off", "delete-journal",
                ],
                "boundary \(boundary)"
            )
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

    func testSecretBearingThrownErrorsAreSanitizedAtCoordinatorBoundary() throws {
        let replacementHarness = Harness(queueCount: 0)
        replacementHarness.replaceError = SensitiveOperationError(harness: replacementHarness)
        XCTAssertEqual(try replacementHarness.run(), .recoveryRequired)

        let recoveryHarness = Harness(queueCount: 0)
        recoveryHarness.agentRegistered = false
        recoveryHarness.journal = recoveryHarness.preparedJournal
        recoveryHarness.recoveryError = SensitiveOperationError(harness: recoveryHarness)
        XCTAssertEqual(try recoveryHarness.run(), .recoveryRequired)

        let registrationHarness = Harness(queueCount: 3, queueDisposition: .cancel)
        registrationHarness.registerError = SensitiveOperationError(harness: registrationHarness)
        let registrationOutcome = try registrationHarness.run()
        XCTAssertEqual(registrationOutcome, .recoveryRequired)
        let diagnostics = String(describing: registrationOutcome)
            + String(reflecting: registrationOutcome)
        XCTAssertFalse(diagnostics.contains(registrationHarness.old.deviceToken))
        XCTAssertFalse(diagnostics.contains(registrationHarness.newToken))
        XCTAssertFalse(diagnostics.contains(registrationHarness.code))
        XCTAssertFalse(diagnostics.contains(registrationHarness.preparedJournal.operationID.uuidString))
        XCTAssertFalse(diagnostics.contains(registrationHarness.preparedJournal.replacementDeviceID.uuidString))
        XCTAssertFalse(diagnostics.contains(SensitiveOperationError.responseSentinel))
        XCTAssertFalse(diagnostics.contains(SensitiveOperationError.querySentinel))
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

private struct LiveQueueProofFixture {
    let root: URL
    let paths: CompanionLifecyclePaths
    let enrollment: EnrollmentConfiguration
    let journalStore: RecoveryJournalStore
    let operations: ReEnrollmentOperations
    let networkRequests: LockedInteger
}

private func makeLiveQueueProofFixture(name: String) throws -> LiveQueueProofFixture {
    let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
        .appendingPathComponent("rr-queue-proof-\(name)-\(UUID().uuidString)", isDirectory: true)
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
    let enrollment = try EnrollmentConfiguration(
        deviceID: "11111111-1111-4111-8111-111111111111",
        deviceToken: String(repeating: "o", count: 43),
        dedupeSecret: Data(repeating: 0x11, count: 32),
        serverURL: URL(string: "https://raiders.redlattice.com")!,
        cutoverAtMS: 0,
        enabledSurfaces: [.codexCLI, .codexDesktop]
    )
    try enrollment.persist(to: paths.enrollment)
    let collectorState = paths.agent.stateDirectory.appendingPathComponent("collector-state.json")
    try Data(#"{"enabled":false,"files":{},"version":1}"#.utf8).write(to: collectorState)
    XCTAssertEqual(Darwin.chmod(collectorState.path, 0o600), 0)
    let outbox = try Outbox(directory: paths.agent.outboxDirectory)
    let service = ServiceState()
    let managed = ManagedAgentServiceController(operations: ManagedAgentServiceOperations(
        register: { service.registered = true },
        unregister: { service.registered = false },
        status: { service.registered ? .enabled : .notRegistered }
    ))
    let networkRequests = LockedInteger()
    let client = try EnrollmentClient(
        origin: URL(string: "https://raiders.redlattice.com")!,
        transport: { _ in
            networkRequests.increment()
            throw TestError.recovery
        }
    )
    let operations = try ReEnrollmentOperations.live(
        paths: paths,
        companionVersion: "test",
        managedAgent: managed,
        outbox: outbox,
        enrollmentClient: client,
        uploadTransport: { _ in
            networkRequests.increment()
            throw TestError.recovery
        },
        summarize: { _ in XCTFail("invalid queue reached summary") },
        confirmReEnrollment: {
            XCTFail("invalid queue reached confirmation")
            return false
        },
        resolveQueue: { _ in
            XCTFail("invalid queue reached disposition")
            return .cancel
        },
        requestCode: {
            XCTFail("invalid queue requested a code")
            return String(repeating: "c", count: 43)
        },
        delayMilliseconds: { _ in },
        acquireLock: { TestLock() }
    )
    return LiveQueueProofFixture(
        root: root,
        paths: paths,
        enrollment: enrollment,
        journalStore: try RecoveryJournalStore(paths: paths),
        operations: operations,
        networkRequests: networkRequests
    )
}

private func makeLiveQueueEvent(idempotencyKey: String) -> RunEventV1 {
    RunEventV1(
        schemaVersion: 1,
        companionVersion: "test",
        deviceID: "11111111-1111-4111-8111-111111111111",
        provider: .codex,
        surface: .codexCLI,
        runKey: String(repeating: "f", count: 64),
        sequence: 1,
        eventTimeMS: 1,
        observedAtMS: 1,
        startedAtMS: 1,
        state: .open,
        usage: .init(input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0),
        model: nil,
        effort: nil,
        idempotencyKey: idempotencyKey
    )
}

private final class LockedInteger: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    var value: Int { lock.withLock { stored } }
    func increment() { lock.withLock { stored += 1 } }
}

private enum TestError: Error { case recovery, crash }

private struct SensitiveOperationError: Error, CustomStringConvertible, CustomDebugStringConvertible {
    static let responseSentinel = "sensitive-response-body"
    static let querySentinel = "?device_token=sensitive-query-token"
    static let cleanupSentinel = "sensitive-cleanup-error"

    let material: String

    init(harness: Harness, additionalSentinel: String? = nil) {
        material = [
            harness.old.deviceToken,
            harness.newToken,
            harness.code,
            harness.preparedJournal.operationID.uuidString,
            harness.preparedJournal.replacementDeviceID.uuidString,
            Self.responseSentinel,
            Self.querySentinel,
            additionalSentinel,
        ].compactMap { $0 }.joined(separator: ":")
    }

    var description: String { material }
    var debugDescription: String { material }
}

private final class TestLock: ReEnrollmentLock, @unchecked Sendable {}

private final class ServiceState: @unchecked Sendable {
    var registered = true
    var requestedCodes = 0
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
    var recoveredOverride: RecoveredEnrollment?
    var replacementResult: ReplacementHTTPResult
    var replaceError: Error?
    var registerError: Error?
    var registerMutatesBeforeThrow = false
    var registeredStatusAfterRegister = ManagedAgentStatus.enabled
    var verificationSucceeds = true
    var verificationError: Error?
    var queueCountCalls = 0
    var queueCountErrorOnCall: Int?
    var queueCountError: Error?
    var unregisterCalls = 0
    var unregisterErrorOnCall: Int?
    var unregisterError: Error?
    var verifyUnregisteredCalls = 0
    var verifyUnregisteredErrorOnCall: Int?
    var verifyUnregisteredError: Error?
    var verifyUnregisteredFailureOnCall: Int?
    var journalWriteErrorPhase: ReEnrollmentPhase?
    var journalWriteError: Error?
    var removeJournalError: Error?
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
                self.unregisterCalls += 1
                if self.unregisterErrorOnCall == self.unregisterCalls,
                   let unregisterError = self.unregisterError {
                    throw unregisterError
                }
                self.agentRegistered = false
            },
            verifyAgentUnregistered: {
                self.verifyUnregisteredCalls += 1
                if self.verifyUnregisteredErrorOnCall == self.verifyUnregisteredCalls,
                   let verifyUnregisteredError = self.verifyUnregisteredError {
                    throw verifyUnregisteredError
                }
                return !self.agentRegistered
                    && self.verifyUnregisteredFailureOnCall != self.verifyUnregisteredCalls
            },
            countQueue: {
                self.actions.append("count-queue")
                self.queueCountCalls += 1
                if self.queueCountErrorOnCall == self.queueCountCalls,
                   let queueCountError = self.queueCountError {
                    throw queueCountError
                }
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
                if value.phase == .replacementPrepared, self.journalWrites.isEmpty {
                    self.actions.append("create-journal(replacementPrepared)")
                } else {
                    self.actions.append("journal(\(value.phase.rawValue))")
                }
                if self.journalWriteErrorPhase == value.phase,
                   let journalWriteError = self.journalWriteError {
                    throw journalWriteError
                }
                self.journal = value
                self.journalWrites.append(value)
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
                    if let recoveredOverride = self.recoveredOverride {
                        return recoveredOverride
                    }
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
                if self.registerMutatesBeforeThrow { self.agentRegistered = true }
                if let registerError = self.registerError { throw registerError }
                self.agentRegistered = self.registeredStatusAfterRegister == .enabled
            },
            verifyEnrollmentAndOff: { expected, requireEmptyQueue in
                XCTAssertNotNil(self.activeLock, "lifecycle lock released before verification")
                self.actions.append("verify-new-config-and-off")
                if let verificationError = self.verificationError { throw verificationError }
                return self.current == expected
                    && self.collectionOff
                    && self.agentRegistered
                    && self.verificationSucceeds
                    && (!requireEmptyQueue || self.queueCount == 0)
            },
            delayMilliseconds: { value in self.delays.append(value) },
            removeJournal: {
                XCTAssertNotNil(self.activeLock, "lifecycle lock released before journal cleanup")
                self.actions.append("delete-journal")
                if let removeJournalError = self.removeJournalError { throw removeJournalError }
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

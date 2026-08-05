import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class AgentControllerTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    func testPersistDisabledForRecoveryChangesOnlyEnabledAndPreservesQueue() throws {
        try withHarness { harness in
            let stateFile = harness.paths.stateDirectory.appendingPathComponent("collector-state.json")
            let before = try Data(contentsOf: stateFile)
            let queuedBefore = try harness.outbox.queuedCount()
            let expected = Data(
                String(decoding: before, as: UTF8.self)
                    .replacingOccurrences(of: "\"enabled\":true", with: "\"enabled\":false")
                    .utf8
            )

            try AgentController.persistDisabledForRecovery(
                paths: harness.paths,
                surfaces: harness.registry.surfaces
            )

            XCTAssertEqual(try Data(contentsOf: stateFile), expected)
            XCTAssertEqual(try harness.outbox.queuedCount(), queuedBefore)
            XCTAssertEqual(
                try AgentController.persistedEnabled(
                    paths: harness.paths,
                    surfaces: harness.registry.surfaces
                ),
                false
            )
        }
    }

    func testPersistDisabledForRecoveryHandlesNestedStateEscapesAndMultipleDeferredPaths() throws {
        try withHarness { harness in
            let retained = try harness.makeFile(
                "retained-\\\"nested.jsonl",
                contents: completedRun(nativeID: "recovery-parser-retained")
            )
            let deferredOne = try harness.makeFile("deferred-one.jsonl", contents: Data())
            let deferredTwo = try harness.makeFile("deferred-two.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [retained, deferredOne, deferredTwo])
            try harness.controller.turnOff()
            try FileManager.default.removeItem(at: deferredOne)
            try FileManager.default.removeItem(at: deferredTwo)
            try harness.controller.turnOn(existingFiles: [retained])

            let stateFile = harness.paths.stateDirectory.appendingPathComponent("collector-state.json")
            let before = try Data(contentsOf: stateFile)
            let text = String(decoding: before, as: UTF8.self)
            XCTAssertTrue(text.contains("deferredSeedPaths"))
            XCTAssertTrue(text.contains("adapterSnapshots"))
            XCTAssertTrue(text.contains("\\\\\\\""))
            let expected = Data(
                text.replacingOccurrences(of: "\"enabled\":true", with: "\"enabled\":false").utf8
            )
            XCTAssertNotEqual(before, expected)

            try AgentController.persistDisabledForRecovery(
                paths: harness.paths,
                surfaces: harness.registry.surfaces
            )

            XCTAssertEqual(try Data(contentsOf: stateFile), expected)
            XCTAssertEqual(
                try AgentController.persistedEnabled(
                    paths: harness.paths,
                    surfaces: harness.registry.surfaces
                ),
                false
            )
        }
    }

    func testPersistDisabledForRecoveryRejectsAmbiguousOrMissingTopLevelEnabled() throws {
        let invalidFixtures = [
            #"{"version":1,"enabled":false,"enabled":true,"files":{}}"#,
            #"{"version":1,"enabled":true,"enabled":false,"files":{}}"#,
            #"{"version":1,"enabled":false,"enabled":false,"files":{}}"#,
            #"{"version":1,"files":{}}"#,
            #"{"version":1,"enabled":"false","files":{}}"#,
            #"{"version":1,"files":{},"nested":{"enabled":false}}"#,
            #"{"version":1,"\u0065nabled":true,"files":{}}"#,
            #"{"version":1,"\u0065nabled":true,"enabled":false,"files":{}}"#,
        ]

        for fixture in invalidFixtures {
            try withHarness { harness in
                let stateFile = harness.paths.stateDirectory
                    .appendingPathComponent("collector-state.json")
                let before = Data(fixture.utf8)
                try before.write(to: stateFile)

                XCTAssertThrowsError(
                    try AgentController.persistDisabledForRecovery(
                        paths: harness.paths,
                        surfaces: harness.registry.surfaces
                    ),
                    "fixture: \(fixture)"
                ) { error in
                    XCTAssertEqual(error as? AgentControllerError, .invalidState)
                }
                XCTAssertEqual(try Data(contentsOf: stateFile), before)
            }
        }
    }

    func testPersistDisabledForRecoveryIgnoresNestedEnabledMembersAndPreservesBytes() throws {
        try withHarness { harness in
            let stateFile = harness.paths.stateDirectory
                .appendingPathComponent("collector-state.json")
            let fixture = #"{"version":1,"extra":{"enabled":false,"items":[{"enabled":true},"enabled"]},"enabled":true,"files":{}}"#
            let expected = #"{"version":1,"extra":{"enabled":false,"items":[{"enabled":true},"enabled"]},"enabled":false,"files":{}}"#
            try Data(fixture.utf8).write(to: stateFile)

            try AgentController.persistDisabledForRecovery(
                paths: harness.paths,
                surfaces: harness.registry.surfaces
            )

            XCTAssertEqual(try Data(contentsOf: stateFile), Data(expected.utf8))
        }
    }

    func testPersistDisabledForRecoveryValidatesUniqueFalseBeforeReturningByteIdentically() throws {
        try withHarness { harness in
            let stateFile = harness.paths.stateDirectory
                .appendingPathComponent("collector-state.json")
            let fixture = #" { "version" : 1, "enabled" : false, "files" : {}, "nested" : [{"enabled":true}] } "#
            let before = Data(fixture.utf8)
            try before.write(to: stateFile)

            try AgentController.persistDisabledForRecovery(
                paths: harness.paths,
                surfaces: harness.registry.surfaces
            )

            XCTAssertEqual(try Data(contentsOf: stateFile), before)
        }
    }

    func testStatusShowsInstalledAvailableAndExactUpdateCommand() throws {
        try withHarness { harness in
            let installed = CompanionReleaseIdentity(
                releaseSequence: 1,
                releaseSHA: String(repeating: "a", count: 40),
                companionVersion: "0.2.0",
                updateProtocolVersion: 1
            )
            let available = CompanionUpdateAvailability(
                installedVersion: "0.2.0",
                installedSequence: 1,
                availableVersion: "0.2.1",
                availableSequence: 2,
                updateCommand: "raiders update"
            )

            let status = try harness.controller.status(
                daemonRunning: true,
                serverEnabledSurfaces: [.codexCLI],
                lastSuccessfulUploadMS: nil,
                installedRelease: installed,
                updateAvailability: available
            )

            XCTAssertEqual(status.installedCompanionVersion, "0.2.0")
            XCTAssertEqual(status.installedReleaseSequence, 1)
            XCTAssertEqual(status.availableCompanionVersion, "0.2.1")
            XCTAssertEqual(status.availableReleaseSequence, 2)
            XCTAssertEqual(status.updateCommand, "raiders update")
        }
    }

    func testDoctorReportsOnlySortedCompatibilityReasonCodes() throws {
        try withHarness { harness in
            let source = try harness.makeFile("unsupported-source.jsonl", contents: Data())
            let contract = try harness.makeFile("unsupported-contract.jsonl", contents: Data())
            let active = try harness.makeFile("active-restart.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [source, contract, active])
            try append(lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"source","originator":"originator","source":"unknown","cli_version":"0.146.0-alpha.3.1"}}"#,
            ]), to: source)
            try append(lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"contract","originator":"originator","cli_version":"0.146.0-alpha.3.1"}}"#,
            ]), to: contract)
            try append(runPrefix(nativeID: "DO_NOT_EXPORT_ACTIVE_NATIVE_ID"), to: active)
            try harness.controller.processChangedFiles([source, contract, active])

            let restarted = try harness.makeController()
            let report = restarted.doctor(
                codexRootReadable: true,
                serverHealthy: true,
                signingValid: true,
                enrollmentAllowedSurfaces: [.codexCLI],
                claudeOTelEnvironmentPresent: false
            )
            let status = try restarted.status(
                daemonRunning: true,
                serverEnabledSurfaces: [.codexCLI],
                lastSuccessfulUploadMS: nil
            )

            XCTAssertTrue(report.compatibilityNeedsReview)
            XCTAssertEqual(report.compatibilityReasons, [.unsupportedContract, .unsupportedSource])
            XCTAssertEqual(status.activeRunCount, 1)
            let rendered = report.description + status.description
            XCTAssertFalse(rendered.contains("unsupported-source.jsonl"))
            XCTAssertFalse(rendered.contains("DO_NOT_EXPORT_ACTIVE_NATIVE_ID"))
        }
    }

    func testFirstInstallSeedsEOFBeforeObservingFutureAppends() throws {
        try withHarness { harness in
            let existing = try harness.makeFile("existing.jsonl", contents: completedRun(nativeID: "DO_NOT_EXPORT_OLD"))
            try harness.controller.install(existingFiles: [existing])
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            try append(completedRun(nativeID: "future-1"), to: existing)
            try harness.controller.processChangedFiles([existing])
            XCTAssertGreaterThan(try harness.outbox.queuedCount(), 0)
        }
    }

    func testLiveCreatedFileRetainsPreCallbackLifecycleForLaterCompletion() throws {
        try withHarness { harness in
            let boundaryFile = try harness.makeFile("boundary.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [boundaryFile])

            let newFile = try harness.makeFile(
                "new-live.jsonl",
                contents: runPrefix(nativeID: "live-created-run")
            )
            try harness.controller.processChangedFiles([newFile])
            try append(runSuffix(), to: newFile)
            try harness.controller.processChangedFiles([newFile])

            let completed = try XCTUnwrap(
                try harness.outbox.records(limit: 100).map(\.event).last {
                    $0.state == .completed
                }
            )
            XCTAssertEqual(
                completed.usage,
                UsageCountersV1(
                    input: 3,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningOutput: 0
                )
            )
        }
    }

    func testInitialBoundaryReadsOnlyBoundedProvenanceRegardlessOfHistoricalSize() throws {
        try withHarness { harness in
            var history = lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            ])
            history.append(Data(repeating: 0x78, count: 4 * 1_024 * 1_024))
            let file = try harness.makeFile("large-history.jsonl", contents: history)

            try harness.controller.install(existingFiles: [file])

            XCTAssertLessThanOrEqual(harness.controller.lastCallbackBytesRead, 70_000)
            XCTAssertFalse(harness.controller.hasPendingSeedWork)
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            try append(turnWithoutSessionMeta(nativeID: "future-after-large-history"), to: file)
            while true {
                try harness.controller.processChangedFiles([file])
                if !harness.controller.hasPendingReadWork { break }
            }
            XCTAssertEqual(
                try harness.outbox.records(limit: 100).filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testSeededSessionMetadataVerifiesLaterTurnsWithoutRepeatedMetadata() throws {
        try withHarness { harness in
            let file = try harness.makeFile(
                "single-session-meta.jsonl",
                contents: lines([
                    #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
                ])
            )
            try harness.controller.install(existingFiles: [file])

            try append(turnWithoutSessionMeta(nativeID: "future-without-session-meta"), to: file)
            while true {
                try harness.controller.processChangedFiles([file])
                if !harness.controller.hasPendingReadWork { break }
            }

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertEqual(events.last?.state, .completed)
            XCTAssertEqual(events.filter { $0.state == .completed }.count, 1)
        }
    }

    func testReplacementInodeAtTrackedPathSeedsEOFBeforeFutureAppends() throws {
        try withHarness { harness in
            let file = try harness.makeFile("replaced.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(completedRun(nativeID: "before-replacement"), to: file)
            try harness.controller.processChangedFiles([file])
            let before = try harness.outbox.queuedCount()

            let retired = harness.root.appendingPathComponent("retired.jsonl")
            try FileManager.default.moveItem(at: file, to: retired)
            _ = try harness.makeFile(
                "replaced.jsonl",
                contents: completedRun(nativeID: "DO_NOT_EXPORT_REPLACEMENT_HISTORY")
            )
            try harness.controller.processChangedFiles([file])
            XCTAssertEqual(try harness.outbox.queuedCount(), before)

            try append(completedRun(nativeID: "after-replacement"), to: file)
            try harness.controller.processChangedFiles([file])
            XCTAssertGreaterThan(try harness.outbox.queuedCount(), before)
        }
    }

    func testEmptyInitialSeedRetainsIdentitySoImmediateReplacementStillSeedsEOF() throws {
        try withHarness { harness in
            let file = try harness.makeFile("empty-then-replaced.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])

            let retired = harness.root.appendingPathComponent("retired-empty.jsonl")
            try FileManager.default.moveItem(at: file, to: retired)
            _ = try harness.makeFile(
                "empty-then-replaced.jsonl",
                contents: completedRun(nativeID: "DO_NOT_EXPORT_IMMEDIATE_REPLACEMENT")
            )
            try harness.controller.processChangedFiles([file])
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            try append(completedRun(nativeID: "future-after-immediate-replacement"), to: file)
            try harness.controller.processChangedFiles([file])
            XCTAssertGreaterThan(try harness.outbox.queuedCount(), 0)
        }
    }

    func testOffStopsReadsAndOnSeedsEveryUnreadExistingFileWithoutDeletingQueue() throws {
        try withHarness { harness in
            let file = try harness.makeFile("session.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(completedRun(nativeID: "queued-before-off"), to: file)
            try harness.controller.processChangedFiles([file])
            let queued = try harness.outbox.queuedCount()
            XCTAssertGreaterThan(queued, 0)

            try harness.controller.turnOff()
            try append(completedRun(nativeID: "DO_NOT_EXPORT_WHILE_OFF"), to: file)
            try harness.controller.processChangedFiles([file])
            XCTAssertEqual(try harness.outbox.queuedCount(), queued)

            try harness.controller.turnOn(existingFiles: [file])
            XCTAssertEqual(try harness.outbox.queuedCount(), queued)
            try append(completedRun(nativeID: "after-on"), to: file)
            try harness.controller.processChangedFiles([file])
            XCTAssertGreaterThan(try harness.outbox.queuedCount(), queued)
        }
    }

    func testOffOnPreservesVerifiedSurfaceWithoutCarryingHistoricalLifecycle() throws {
        try withHarness { harness in
            let file = try harness.makeFile(
                "single-session-meta-off-on.jsonl",
                contents: lines([
                    #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
                ])
            )
            try harness.controller.install(existingFiles: [file])
            try append(turnWithoutSessionMeta(nativeID: "before-off"), to: file)
            try harness.controller.processChangedFiles([file])
            let before = try harness.outbox.queuedCount()
            XCTAssertGreaterThan(before, 0)

            try harness.controller.turnOff()
            try append(turnWithoutSessionMeta(nativeID: "DO_NOT_EXPORT_WHILE_OFF"), to: file)
            try harness.controller.turnOn(existingFiles: [file])
            XCTAssertEqual(try harness.outbox.queuedCount(), before)

            try append(turnWithoutSessionMeta(nativeID: "future-after-on-no-meta"), to: file)
            while true {
                try harness.controller.processChangedFiles([file])
                if !harness.controller.hasPendingReadWork { break }
            }
            XCTAssertEqual(
                try harness.outbox.records(limit: 100).filter { $0.event.state == .completed }.count,
                2
            )
        }
    }

    func testPauseGateStopsInFlightReadBeforeOffCanWaitOnControllerLock() throws {
        try withHarness { harness in
            let file = try harness.makeFile("in-flight-off.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            let readFinished = DispatchSemaphore(value: 0)
            let releaseRead = DispatchSemaphore(value: 0)
            harness.controller = try harness.makeController {
                readFinished.signal()
                releaseRead.wait()
            }
            let controller = harness.controller
            try append(completedRun(nativeID: "DO_NOT_EXPORT_IN_FLIGHT_OFF"), to: file)
            let processFinished = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .utility).async {
                try? controller.processChangedFiles([file])
                processFinished.signal()
            }
            XCTAssertEqual(readFinished.wait(timeout: .now() + 2), .success)

            controller.pauseCollection()
            let offFinished = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .utility).async {
                try? controller.turnOff()
                offFinished.signal()
            }
            releaseRead.signal()

            XCTAssertEqual(processFinished.wait(timeout: .now() + 2), .success)
            XCTAssertEqual(offFinished.wait(timeout: .now() + 2), .success)
            XCTAssertFalse(controller.enabled)
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)
        }
    }

    func testRepeatedOnWhileEnabledDoesNotSeedUnreadEvents() throws {
        try withHarness { harness in
            let file = try harness.makeFile("already-on.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(completedRun(nativeID: "unread-before-repeated-on"), to: file)

            try harness.controller.turnOn(existingFiles: [file])
            try harness.controller.processChangedFiles([file])

            XCTAssertGreaterThan(try harness.outbox.queuedCount(), 0)
        }
    }

    func testRestartAtomicallyRestoresCursorOrdinalAndAdapterSnapshotInOriginalOrder() throws {
        try withHarness { harness in
            let file = try harness.makeFile("restart.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(runPrefix(nativeID: "restart-run"), to: file)
            try harness.controller.processChangedFiles([file])
            let firstCount = try harness.outbox.queuedCount()
            XCTAssertEqual(firstCount, 1)

            let restarted = try harness.makeController()
            try append(runSuffix(), to: file)
            try restarted.processChangedFiles([file])

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertEqual(events.map(\.sequence), events.map(\.sequence).sorted())
            XCTAssertEqual(events.last?.state, .completed)
            XCTAssertEqual(Set(events.map(\.idempotencyKey)).count, events.count)
            let stateFiles = try FileManager.default.contentsOfDirectory(
                at: harness.paths.stateDirectory,
                includingPropertiesForKeys: nil
            )
            let stateBytes = try Data(contentsOf: XCTUnwrap(stateFiles.first))
            let stateText = String(decoding: stateBytes, as: UTF8.self)
            XCTAssertTrue(stateText.contains("cursor"))
            XCTAssertTrue(stateText.contains("adapterSnapshots"))
        }
    }

    func testDaemonRestartWithMissingCollectorStateFailsClosedAcrossRuntimeComponents() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-missing-state-restart-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let providerRoot = root.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: providerRoot, withIntermediateDirectories: true)
        let providerFile = providerRoot.appendingPathComponent("existing.jsonl")
        try Data().write(to: providerFile)
        let paths = AgentPaths(applicationSupportDirectory: root)
        let registry = try AdapterRegistry.enabled(
            surfaces: [.codexCLI],
            codexRoot: providerRoot
        )
        let outbox = try Outbox(directory: paths.outboxDirectory)
        let configuration = AgentConfiguration(
            companionVersion: "0.1.0",
            deviceID: "00000000-0000-4000-8000-000000000001",
            dedupeSecret: Data("DO_NOT_EXPORT_LOCAL_SECRET".utf8)
        )

        var original: AgentController? = try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: configuration,
            clockMS: { self.now }
        )
        try original?.turnOn(existingFiles: [providerFile])
        try original?.install(existingFiles: [providerFile])
        try append(completedRun(nativeID: "queued-before-missing-state"), to: providerFile)
        try original?.processChangedFiles([providerFile])
        let queuedBeforeRestart = try outbox.queuedCount()
        XCTAssertGreaterThan(queuedBeforeRestart, 0)
        try original?.turnOff()
        original = nil

        let enrollmentFile = paths.stateDirectory.appendingPathComponent("enrollment.json")
        let enrollmentData = Data(
            """
            {"version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dedupe_secret":"\(String(repeating: "ab", count: 32))","server_url":"http://127.0.0.1:8765","cutover_at":1700000000000,"enabled_surfaces":["codex_cli"]}
            """.utf8
        )
        try enrollmentData.write(to: enrollmentFile)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: enrollmentFile.path
        )
        let enrollment = try EnrollmentConfiguration.load(
            from: enrollmentFile,
            allowsTestOrigin: true
        )
        try FileManager.default.removeItem(
            at: paths.stateDirectory.appendingPathComponent("collector-state.json")
        )
        try append(
            completedRun(nativeID: "DO_NOT_EXPORT_AFTER_MISSING_STATE"),
            to: providerFile
        )

        let providerRead = expectation(description: "missing state must not read provider data")
        providerRead.isInverted = true
        let watcherStartRequested = expectation(
            description: "missing state must not request file watcher startup"
        )
        watcherStartRequested.isInverted = true
        let uploadStarted = expectation(description: "missing state must not drain outbox")
        uploadStarted.isInverted = true
        let heartbeatStarted = expectation(description: "missing state must not enable heartbeat")
        heartbeatStarted.isInverted = true
        let restarted = try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: .init(
                companionVersion: "0.1.0",
                deviceID: enrollment.deviceID,
                dedupeSecret: enrollment.dedupeSecret
            ),
            clockMS: { self.now },
            afterProviderRead: { providerRead.fulfill() }
        )
        let uploadConfiguration = UploadConfiguration(
            origin: enrollment.serverURL,
            deviceToken: enrollment.deviceToken,
            allowsTestOrigin: true
        )
        let uploader = try Uploader(
            outbox: outbox,
            configuration: uploadConfiguration,
            transport: { _ in
                uploadStarted.fulfill()
                return .init(
                    statusCode: 200,
                    body: Data(
                        "{\"accepted\":\(queuedBeforeRestart),\"duplicate\":0,\"ignored\":0}".utf8
                    )
                )
            },
            clockMS: { self.now }
        )
        let heartbeat = try Heartbeat(
            configuration: uploadConfiguration,
            companionVersion: "0.1.0",
            transport: { _ in
                heartbeatStarted.fulfill()
                return .init(statusCode: 204, body: Data())
            },
            clockMS: { self.now }
        )
        let watcher = FileWatcher(registry: registry) { files in
            try? restarted.processChangedFiles(files)
        }
        defer {
            uploader.setEnabled(false)
            heartbeat.setEnabled(false)
            watcher.stop()
        }

        let existingFiles = try watcher.discoverProviderFiles()
        try restarted.install(existingFiles: existingFiles)
        uploader.schedule(enabled: restarted.enabled)
        heartbeat.setEnabled(restarted.enabled)
        if restarted.enabled {
            watcherStartRequested.fulfill()
            try? watcher.start()
        }

        XCTAssertFalse(restarted.enabled)
        XCTAssertFalse(restarted.isAcceptingCollection)
        XCTAssertEqual(
            try AgentController.persistedCollectorState(
                paths: paths,
                surfaces: enrollment.enabledSurfaces
            ),
            .disabled
        )
        wait(
            for: [providerRead, watcherStartRequested, uploadStarted, heartbeatStarted],
            timeout: 0.5
        )
        XCTAssertEqual(try outbox.queuedCount(), queuedBeforeRestart)
    }

    func testRestartRecoversPastPersistedOversizedLineAndCollectsLaterValidRun() throws {
        try withHarness { harness in
            let file = try harness.makeFile("oversized-restart.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(
                Data(
                    repeating: Character("x").asciiValue!,
                    count: JSONLReader.maximumBufferedLineBytes + 1
                ),
                to: file
            )

            try harness.controller.processChangedFiles([file])
            XCTAssertTrue(harness.controller.hasPendingReadWork)
            try harness.controller.continuePendingWork()
            XCTAssertFalse(harness.controller.hasPendingReadWork)
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            let restarted = try harness.makeController()
            let trapNativeID = "DO_NOT_REPORT_OVERSIZED_SUFFIX"
            let validNativeID = "valid-after-oversized-restart"
            var appended = completedRun(nativeID: trapNativeID)
            appended.append(completedRun(nativeID: validNativeID))
            try append(appended, to: file)
            try restarted.processChangedFiles([file])
            while restarted.hasPendingReadWork {
                try restarted.continuePendingWork()
            }

            let records = try harness.outbox.records(limit: 100)
            let completedRunKeys = records
                .filter { $0.event.state == .completed }
                .map(\.event.runKey)
            let dedupeSecret = Data("DO_NOT_EXPORT_LOCAL_SECRET".utf8)
            let trapRunKey = try RunIdentity.key(
                provider: .codex,
                nativeID: trapNativeID,
                dedupeSecret: dedupeSecret
            )
            let validRunKey = try RunIdentity.key(
                provider: .codex,
                nativeID: validNativeID,
                dedupeSecret: dedupeSecret
            )
            XCTAssertFalse(completedRunKeys.contains(trapRunKey))
            XCTAssertEqual(completedRunKeys, [validRunKey])
        }
    }

    func testDeterministicPrivacyRejectionAdvancesCursorAndContinuesAfterRestart() throws {
        try withHarness { harness in
            let file = try harness.makeFile("privacy-rejection.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])

            var diagnostics: [CollectorDiagnostic] = []
            harness.controller = try harness.makeController(diagnosticHandler: { diagnostic in
                diagnostics.append(diagnostic)
            })
            var firstAppend = overSevenDayRun(nativeID: "rejected-duration")
            firstAppend.append(completedRun(nativeID: "valid-after-rejection"))
            try append(firstAppend, to: file)

            try harness.controller.processChangedFiles([file])

            XCTAssertEqual(diagnostics, [.deterministicRecordRejected])
            XCTAssertEqual(
                try harness.outbox.records(limit: 100)
                    .filter { $0.event.state == .completed }.count,
                1
            )

            var restartedDiagnostics: [CollectorDiagnostic] = []
            let restarted = try harness.makeController(diagnosticHandler: { diagnostic in
                restartedDiagnostics.append(diagnostic)
            })
            try append(completedRun(nativeID: "valid-after-restart"), to: file)
            try restarted.processChangedFiles([file])

            XCTAssertEqual(restartedDiagnostics, [])
            XCTAssertEqual(
                try harness.outbox.records(limit: 100)
                    .filter { $0.event.state == .completed }.count,
                2
            )
        }
    }

    func testEachCallbackReadsAtMostConfiguredBoundAndPreservesProviderFileOrder() throws {
        try withHarness(readLimitBytes: 96) { harness in
            let file = try harness.makeFile("bounded.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(completedRun(nativeID: "bounded-run"), to: file)

            try harness.controller.processChangedFiles([file])
            XCTAssertLessThanOrEqual(harness.controller.lastCallbackBytesRead, 96)
            while harness.controller.lastCallbackBytesRead > 0 {
                try harness.controller.processChangedFiles([file])
            }

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertEqual(events.map(\.sequence), events.map(\.sequence).sorted())
            XCTAssertEqual(events.last?.state, .completed)
        }
    }

    func testNormalBacklogAndSkippedFilesRemainDirtyUntilBoundedContinuationReachesEOF() throws {
        try withHarness(readLimitBytes: 128) { harness in
            let first = try harness.makeFile("dirty-a.jsonl", contents: Data())
            let second = try harness.makeFile("dirty-b.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [first, second])
            try append(completedRun(nativeID: "dirty-a"), to: first)
            try append(completedRun(nativeID: "dirty-b"), to: second)

            try harness.controller.processChangedFiles([first, second])
            XCTAssertTrue(harness.controller.hasPendingReadWork)
            XCTAssertLessThanOrEqual(harness.controller.lastCallbackBytesRead, 128)
            var callbacks = 1
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
                XCTAssertLessThanOrEqual(harness.controller.lastCallbackBytesRead, 128)
                callbacks += 1
                XCTAssertLessThan(callbacks, 100)
            }

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertEqual(events.filter { $0.state == .completed }.count, 2)
        }
    }

    func testMissingPendingFileCannotStarveHealthyLaterFile() throws {
        try withHarness(readLimitBytes: 128) { harness in
            let missing = try harness.makeFile("a-missing.jsonl", contents: Data())
            let healthy = try harness.makeFile("z-healthy.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [missing, healthy])
            try append(completedRun(nativeID: "healthy-after-missing"), to: healthy)
            try FileManager.default.removeItem(at: missing)

            XCTAssertNoThrow(
                try harness.controller.processChangedFiles([missing, healthy])
            )
            var callbacks = 0
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
                callbacks += 1
                XCTAssertLessThan(callbacks, 100)
            }

            XCTAssertEqual(
                try harness.outbox.records(limit: 100).filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testRunRegistryCapsLiveRunsAndDerivesStalledLocallyWithoutEvents() throws {
        var registry = RunRegistry(capacity: 256, stallAfterMS: 15 * 60 * 1_000)
        for index in 0..<300 {
            registry.observe(makeEvent(run: index, observedAtMS: now))
        }
        XCTAssertEqual(registry.activeRunCount, 256)
        XCTAssertEqual(registry.statuses(nowMS: now + 15 * 60 * 1_000 - 1).filter { $0.state == .open }.count, 256)
        XCTAssertEqual(registry.statuses(nowMS: now + 15 * 60 * 1_000).filter { $0.state == .stalled }.count, 256)
    }

    func testSameInodeRewriteResetsAdaptersAndPhysicalOrdinalBeforeConsumption() throws {
        try withHarness { harness in
            let file = try harness.makeFile("rewrite.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            let firstRun = completedRun(nativeID: "first-run")
            try append(firstRun, to: file)
            try harness.controller.processChangedFiles([file])

            let rewrittenRun = completedRun(nativeID: "rewritten-run")
            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: rewrittenRun)
            try handle.close()
            try harness.controller.processChangedFiles([file])

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertTrue(events.contains {
                $0.state == .completed && $0.sequence == Int64(rewrittenRun.count)
            })
        }
    }

    func testExactLimitSnapshottedEOFSchedulesNormalContinuationBeforeFutureAppend() throws {
        try withHarness(readLimitBytes: 128) { harness in
            let file = try harness.makeFile(
                "exact-limit.jsonl",
                contents: Data(repeating: 0x78, count: 128)
            )
            try harness.controller.install(existingFiles: [file])
            XCTAssertFalse(harness.controller.hasPendingSeedWork)
            XCTAssertTrue(harness.controller.hasPendingReadWork)
            XCTAssertEqual(harness.controller.lastCallbackBytesRead, 128)

            try harness.controller.continuePendingWork()
            XCTAssertFalse(harness.controller.hasPendingSeedWork)
            XCTAssertEqual(harness.controller.lastCallbackBytesRead, 0)
            try append(completedRun(nativeID: "future-after-exact-eof"), to: file)
            while true {
                try harness.controller.processChangedFiles([file])
                if harness.controller.lastCallbackBytesRead == 0 { break }
            }

            XCTAssertEqual(try harness.outbox.records(limit: 100).last?.event.state, .completed)
        }
    }

    func testInstallCapturesEveryFileBoundaryBeforeLowBudgetSeedWork() throws {
        try withHarness(readLimitBytes: 128) { harness in
            let metadata = lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            ])
            let files = try (0..<4).map { index in
                try harness.makeFile("boundary-\(index).jsonl", contents: metadata)
            }

            try harness.controller.install(existingFiles: files)
            try append(
                turnWithoutSessionMeta(nativeID: "future-on-later-file"),
                to: files.last!
            )
            var callbacks = 0
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
                callbacks += 1
                XCTAssertLessThan(callbacks, 100)
            }

            XCTAssertEqual(
                try harness.outbox.records(limit: 100)
                    .filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testChangedPathIsBufferedWhileMultiCallbackBoundaryIsStillClosed() throws {
        try withHarness(readLimitBytes: 64) { harness in
            let metadata = lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            ])
            let first = try harness.makeFile("buffer-a.jsonl", contents: metadata)
            let second = try harness.makeFile("buffer-b.jsonl", contents: metadata)
            try harness.controller.install(existingFiles: [first, second])
            XCTAssertFalse(harness.controller.isAcceptingCollection)

            let created = try harness.makeFile("buffer-created.jsonl", contents: metadata)
            try harness.controller.processChangedFiles([created])
            XCTAssertTrue(harness.controller.hasPendingReadWork)
            XCTAssertFalse(harness.controller.isAcceptingCollection)
            try append(
                turnWithoutSessionMeta(nativeID: "future-after-buffered-boundary"),
                to: created
            )

            var callbacks = 0
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
                callbacks += 1
                XCTAssertLessThan(callbacks, 100)
            }

            XCTAssertTrue(harness.controller.isAcceptingCollection)
            XCTAssertEqual(
                try harness.outbox.records(limit: 100)
                    .filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testDisappearingCapturedFileCannotBlockBoundaryActivation() throws {
        try withHarness(readLimitBytes: 64) { harness in
            let metadata = lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            ])
            let first = try harness.makeFile("vanish-a.jsonl", contents: metadata)
            let disappearing = try harness.makeFile("vanish-b.jsonl", contents: metadata)
            try harness.controller.install(existingFiles: [first, disappearing])
            try FileManager.default.removeItem(at: disappearing)

            var callbacks = 0
            while harness.controller.hasPendingReadWork, callbacks < 100 {
                try harness.controller.continuePendingWork()
                callbacks += 1
            }

            XCTAssertLessThan(callbacks, 100)
            XCTAssertTrue(harness.controller.isAcceptingCollection)
            XCTAssertFalse(harness.controller.hasPendingSeedWork)
        }
    }

    func testAppendArrivingBetweenSeedSlicesIsCollectedAfterSnapshottedEOF() throws {
        try withHarness(readLimitBytes: 128) { harness in
            let file = try harness.makeFile(
                "seed-boundary.jsonl",
                contents: completedRun(nativeID: "DO_NOT_EXPORT_HISTORY")
            )
            try harness.controller.install(existingFiles: [file])
            XCTAssertTrue(harness.controller.hasPendingSeedWork)

            try append(completedRun(nativeID: "future-during-seed"), to: file)
            var callbacks = 0
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
                callbacks += 1
                XCTAssertLessThan(callbacks, 100)
            }

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertEqual(events.filter { $0.state == .completed }.count, 1)
            XCTAssertEqual(events.last?.state, .completed)
        }
    }

    func testCapturedTailRewriteRepinsCurrentEOFBeforeScoringExtensions() throws {
        try withHarness(readLimitBytes: 64) { harness in
            let metadata = lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            ])
            var original = metadata
            original.append(completedRun(nativeID: "old-history"))
            let file = try harness.makeFile("captured-tail-rewrite.jsonl", contents: original)

            try harness.controller.install(existingFiles: [file])
            XCTAssertTrue(harness.controller.hasPendingSeedWork)

            var rewritten = metadata
            rewritten.append(completedRun(nativeID: "new-history"))
            rewritten.append(completedRun(nativeID: "extension-run"))
            XCTAssertEqual(original.prefix(64), rewritten.prefix(64))
            XCTAssertGreaterThan(rewritten.count, original.count)
            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: rewritten)
            try handle.close()

            var callbacks = 0
            while harness.controller.hasPendingReadWork, callbacks < 100 {
                try harness.controller.continuePendingWork()
                callbacks += 1
            }
            XCTAssertLessThan(callbacks, 100)
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            try append(
                turnWithoutSessionMeta(nativeID: "future-after-tail-repin"),
                to: file
            )
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
            }
            try harness.controller.processChangedFiles([file])
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
            }
            XCTAssertEqual(
                try harness.outbox.records(limit: 100)
                    .filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testCapturedTailAllowsAppendOnlyGrowthAfterBoundaryCapture() throws {
        try withHarness(readLimitBytes: 64) { harness in
            let file = try harness.makeFile(
                "captured-tail-append.jsonl",
                contents: completedRun(nativeID: "old-history")
            )
            try harness.controller.install(existingFiles: [file])
            XCTAssertTrue(harness.controller.hasPendingSeedWork)

            try append(
                completedRun(nativeID: "append-only-future"),
                to: file
            )
            var callbacks = 0
            while harness.controller.hasPendingReadWork, callbacks < 100 {
                try harness.controller.continuePendingWork()
                callbacks += 1
            }

            XCTAssertLessThan(callbacks, 100)
            XCTAssertEqual(
                try harness.outbox.records(limit: 100)
                    .filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testPersistedPositiveSeedTargetRequiresCapturedCheckpoint() throws {
        try withHarness(readLimitBytes: 64) { harness in
            let file = try harness.makeFile(
                "missing-target-checkpoint.jsonl",
                contents: completedRun(nativeID: "old-history")
            )
            try harness.controller.install(existingFiles: [file])

            let stateFile = harness.paths.stateDirectory
                .appendingPathComponent("collector-state.json")
            var root = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(contentsOf: stateFile))
                    as? [String: Any]
            )
            var files = try XCTUnwrap(root["files"] as? [String: Any])
            var fileState = try XCTUnwrap(files[file.path] as? [String: Any])
            fileState.removeValue(forKey: "seedTargetCheckpoint")
            files[file.path] = fileState
            root["files"] = files
            let corrupted = try JSONSerialization.data(withJSONObject: root)
            let handle = try FileHandle(forWritingTo: stateFile)
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: corrupted)
            try handle.close()

            XCTAssertThrowsError(try harness.makeController()) { error in
                XCTAssertEqual(error as? AgentControllerError, .invalidState)
            }
        }
    }

    func testSnapshottedSeedEOFSurvivesRestartBeforeFutureAppendIsCollected() throws {
        try withHarness(readLimitBytes: 128) { harness in
            let file = try harness.makeFile(
                "seed-boundary-restart.jsonl",
                contents: completedRun(nativeID: "DO_NOT_EXPORT_RESTART_HISTORY")
            )
            try harness.controller.install(existingFiles: [file])
            XCTAssertTrue(harness.controller.hasPendingSeedWork)
            try append(completedRun(nativeID: "future-after-seed-restart"), to: file)

            let restarted = try harness.makeController()
            try restarted.install(existingFiles: [file])
            var callbacks = 0
            while restarted.hasPendingReadWork {
                try restarted.continuePendingWork()
                callbacks += 1
                XCTAssertLessThan(callbacks, 100)
            }

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertEqual(events.filter { $0.state == .completed }.count, 1)
            XCTAssertEqual(events.last?.state, .completed)
        }
    }

    func testSameInodeLargerRewriteDuringSeedingRepinsEOFBeforeCollection() throws {
        try withHarness(readLimitBytes: 128) { harness in
            let file = try harness.makeFile(
                "seed-rewrite.jsonl",
                contents: completedRun(nativeID: "DO_NOT_EXPORT_OLD_SEED_HISTORY")
            )
            try harness.controller.install(existingFiles: [file])
            XCTAssertTrue(harness.controller.hasPendingSeedWork)

            var rewritten = lines([
                #"{"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"content":"DO_NOT_EXPORT_REWRITE_PREFIX"}}"#,
            ])
            rewritten.append(completedRun(nativeID: "DO_NOT_EXPORT_REWRITTEN_HISTORY_A"))
            rewritten.append(completedRun(nativeID: "DO_NOT_EXPORT_REWRITTEN_HISTORY_B"))
            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: rewritten)
            try handle.close()

            var callbacks = 0
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
                callbacks += 1
                XCTAssertLessThan(callbacks, 100)
            }
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            try append(turnWithoutSessionMeta(nativeID: "future-after-seed-rewrite"), to: file)
            while true {
                try harness.controller.processChangedFiles([file])
                if !harness.controller.hasPendingReadWork { break }
            }
            XCTAssertEqual(
                try harness.outbox.records(limit: 100).filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testOffAndOnClearLocalActiveRunRegistry() throws {
        try withHarness { harness in
            let file = try harness.makeFile("active.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(runPrefix(nativeID: "active-before-off"), to: file)
            try harness.controller.processChangedFiles([file])
            XCTAssertEqual(harness.controller.activeRunCount, 1)

            try harness.controller.turnOff()
            XCTAssertEqual(harness.controller.activeRunCount, 0)
            try harness.controller.turnOn(existingFiles: [file])
            XCTAssertEqual(harness.controller.activeRunCount, 0)
        }
    }

    func testTrackedFileAbsentAtOnIsSeededWhenItReappears() throws {
        try withHarness { harness in
            let file = try harness.makeFile("temporarily-absent.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try harness.controller.turnOff()
            try append(completedRun(nativeID: "DO_NOT_EXPORT_WRITTEN_WHILE_OFF"), to: file)
            let parked = harness.root.appendingPathComponent("parked.jsonl")
            try FileManager.default.moveItem(at: file, to: parked)

            try harness.controller.turnOn(existingFiles: [])
            let restarted = try harness.makeController()
            try restarted.install(existingFiles: [])
            try FileManager.default.moveItem(at: parked, to: file)
            try restarted.processChangedFiles([file])
            while restarted.hasPendingReadWork {
                try restarted.continuePendingWork()
            }
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            try append(completedRun(nativeID: "future-after-reappear"), to: file)
            try restarted.processChangedFiles([file])
            XCTAssertGreaterThan(try harness.outbox.queuedCount(), 0)
        }
    }

    func testRestartPreservesOffWithoutReadingProviderOrDrainingQueue() throws {
        try withHarness { harness in
            let file = try harness.makeFile("off-restart.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try harness.controller.turnOff()
            try append(completedRun(nativeID: "DO_NOT_EXPORT_OFF_RESTART"), to: file)

            let restarted = try harness.makeController()
            try restarted.install(existingFiles: [file])

            XCTAssertFalse(restarted.enabled)
            XCTAssertEqual(restarted.lastCallbackBytesRead, 0)
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)
        }
    }

    func testStoppedDaemonStateReadersDoNotCreateMissingDirectories() throws {
        try withHarness { harness in
            let file = try harness.makeFile("offline-status.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            XCTAssertEqual(
                try AgentController.persistedEnabled(
                    paths: harness.paths,
                    surfaces: [.codexCLI]
                ),
                true
            )

            try append(completedRun(nativeID: "queued-for-offline-status"), to: file)
            try harness.controller.processChangedFiles([file])
            XCTAssertGreaterThan(
                try Outbox.queuedCount(inExistingDirectory: harness.paths.outboxDirectory),
                0
            )
            try harness.controller.turnOff()
            XCTAssertEqual(
                try AgentController.persistedEnabled(
                    paths: harness.paths,
                    surfaces: [.codexCLI]
                ),
                false
            )
        }

        let missingBase = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-offline-missing-\(UUID().uuidString)", isDirectory: true)
        let missingPaths = AgentPaths(applicationSupportDirectory: missingBase)
        XCTAssertNil(
            try AgentController.persistedEnabled(
                paths: missingPaths,
                surfaces: [.codexCLI]
            )
        )
        XCTAssertEqual(
            try Outbox.queuedCount(inExistingDirectory: missingPaths.outboxDirectory),
            0
        )
        XCTAssertThrowsError(
            try EnrollmentConfiguration.loadExisting(
                from: missingPaths.stateDirectory.appendingPathComponent("enrollment.json")
            )
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: missingBase.path))
    }

    func testPersistedCollectorStateDistinguishesMissingInvalidEnabledAndDisabled() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-persisted-status-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)

        XCTAssertEqual(
            try AgentController.persistedCollectorState(paths: paths, surfaces: [.codexCLI]),
            .missing
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.stateDirectory.path))

        try FileManager.default.createDirectory(
            at: paths.stateDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let stateFile = paths.stateDirectory.appendingPathComponent("collector-state.json")
        try Data("not-json".utf8).write(to: stateFile)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: stateFile.path
        )
        XCTAssertEqual(
            try AgentController.persistedCollectorState(paths: paths, surfaces: [.codexCLI]),
            .invalid
        )

        try Data(#"{"enabled":true,"files":{},"version":1}"#.utf8).write(to: stateFile)
        XCTAssertEqual(
            try AgentController.persistedCollectorState(paths: paths, surfaces: [.codexCLI]),
            .enabled
        )

        try Data(#"{"enabled":false,"files":{},"version":1}"#.utf8).write(to: stateFile)
        XCTAssertEqual(
            try AgentController.persistedCollectorState(paths: paths, surfaces: [.codexCLI]),
            .disabled
        )
    }

    func testControllerAndControlSocketRejectSymlinkedOwnedDirectoriesWithoutChmodTarget() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-owned-links-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: parent) }
        let target = parent.appendingPathComponent("target", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        let link = parent.appendingPathComponent("link", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        let providerRoot = parent.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: providerRoot, withIntermediateDirectories: false)
        let registry = try AdapterRegistry.enabled(surfaces: [.codexCLI], codexRoot: providerRoot)
        let safeOutbox = try Outbox(directory: parent.appendingPathComponent("safe-outbox"))
        XCTAssertThrowsError(
            try AgentController(
                registry: registry,
                paths: AgentPaths(applicationSupportDirectory: link),
                outbox: safeOutbox,
                configuration: .init(
                    companionVersion: "0.1.0",
                    deviceID: "00000000-0000-4000-8000-000000000001",
                    dedupeSecret: Data("synthetic-secret".utf8)
                )
            )
        )
        XCTAssertEqual(try permissions(target), 0o755)

        let socket = ControlSocketServer(socketURL: link.appendingPathComponent("agent.sock"))
        XCTAssertThrowsError(try socket.start { _ in .init(ok: true, message: "unexpected") })
        XCTAssertEqual(try permissions(target), 0o755)
    }

    func testCollectorStateRejectsFinalSymlinkWithoutReadingOrReplacingTarget() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-state-link-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let providerRoot = root.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: providerRoot, withIntermediateDirectories: true)
        let paths = AgentPaths(applicationSupportDirectory: root)
        let outbox = try Outbox(directory: paths.outboxDirectory)
        try FileManager.default.createDirectory(
            at: paths.stateDirectory,
            withIntermediateDirectories: true
        )
        let target = root.appendingPathComponent("outside-state.json")
        let original = Data(#"{"enabled":false,"files":{},"version":1}"#.utf8)
        try original.write(to: target)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        try FileManager.default.createSymbolicLink(
            at: paths.stateDirectory.appendingPathComponent("collector-state.json"),
            withDestinationURL: target
        )
        let registry = try AdapterRegistry.enabled(surfaces: [.codexCLI], codexRoot: providerRoot)

        XCTAssertThrowsError(
            try AgentController(
                registry: registry,
                paths: paths,
                outbox: outbox,
                configuration: .init(
                    companionVersion: "0.1.0",
                    deviceID: "00000000-0000-4000-8000-000000000001",
                    dedupeSecret: Data("synthetic-secret".utf8)
                )
            )
        )
        XCTAssertEqual(try Data(contentsOf: target), original)
    }

    func testCollectorStateWritesStayOnPinnedDirectoryAfterParentPathSwap() throws {
        try withHarness { harness in
            try harness.controller.install(existingFiles: [])
            let pinned = harness.paths.supportDirectory.appendingPathComponent(
                "state-pinned",
                isDirectory: true
            )
            let outside = harness.root.appendingPathComponent("outside-state", isDirectory: true)
            try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
            try FileManager.default.moveItem(at: harness.paths.stateDirectory, to: pinned)
            try FileManager.default.createSymbolicLink(
                at: harness.paths.stateDirectory,
                withDestinationURL: outside
            )

            try harness.controller.turnOff()

            let pinnedState = try Data(
                contentsOf: pinned.appendingPathComponent("collector-state.json")
            )
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: pinnedState) as? [String: Any]
            )
            XCTAssertEqual(object["enabled"] as? Bool, false)
            XCTAssertFalse(
                FileManager.default.fileExists(
                    atPath: outside.appendingPathComponent("collector-state.json").path
                )
            )
        }
    }

    func testFileWatcherUsesOnlyApprovedCodexRootAndSkipsSymlinkedProviderFiles() throws {
        try withHarness { harness in
            let nested = harness.providerRoot.appendingPathComponent("sessions", isDirectory: true)
            try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
            let regular = nested.appendingPathComponent("rollout.jsonl")
            try Data().write(to: regular)
            let unchanged = nested.appendingPathComponent("unchanged.jsonl")
            try Data().write(to: unchanged)
            try Data().write(to: nested.appendingPathComponent("ignore.txt"))
            let outside = harness.root.appendingPathComponent("outside.jsonl")
            try Data("DO_NOT_EXPORT_OUTSIDE".utf8).write(to: outside)
            try FileManager.default.createSymbolicLink(
                at: nested.appendingPathComponent("linked.jsonl"),
                withDestinationURL: outside
            )
            let outsideDirectory = harness.root.appendingPathComponent("outside-dir", isDirectory: true)
            try FileManager.default.createDirectory(
                at: outsideDirectory,
                withIntermediateDirectories: false
            )
            let escaped = outsideDirectory.appendingPathComponent("escaped.jsonl")
            try Data("DO_NOT_EXPORT_DIRECTORY_ESCAPE".utf8).write(to: escaped)
            let directoryLink = harness.providerRoot.appendingPathComponent("linked-dir")
            try FileManager.default.createSymbolicLink(
                at: directoryLink,
                withDestinationURL: outsideDirectory
            )
            let watcher = FileWatcher(registry: harness.registry) { _ in }

            XCTAssertEqual(watcher.watchedRoots, [harness.registry.codexRoot])
            XCTAssertEqual(try watcher.discoverProviderFiles(), [regular, unchanged])
            XCTAssertEqual(try watcher.providerFiles(forChangedPaths: [regular.path]), [regular])
            XCTAssertTrue(
                try watcher.providerFiles(
                    forChangedPaths: [directoryLink.appendingPathComponent("escaped.jsonl").path]
                ).isEmpty
            )
        }
    }

    func testWatcherStartRescanCollectsFilesCreatedAfterAcceptedBoundaries() throws {
        for startsEnabled in [true, false] {
            try withHarness { harness in
                let existing = try harness.makeFile("existing.jsonl", contents: Data())
                if !startsEnabled {
                    try harness.controller.install(existingFiles: [existing])
                    try harness.controller.turnOff()
                    try append(
                        completedRun(nativeID: "DO_NOT_EXPORT_OFF_INTERVAL"),
                        to: existing
                    )
                }

                let newFile = harness.providerRoot.appendingPathComponent("created-in-gap.jsonl")
                let existingFuture = completedRun(nativeID: "existing-created-in-gap")
                let newLiveRun = completedRun(nativeID: "new-file-after-boundary")
                let callbackFinished = DispatchSemaphore(value: 0)
                let controller = harness.controller
                let queue = DispatchQueue(
                    label: "com.redlattice.runtime-raiders.start-race-test"
                )
                let watcher = FileWatcher(
                    registry: harness.registry,
                    processingQueue: queue,
                    afterStreamStarted: {
                        try! appendProviderData(existingFuture, to: existing)
                        try! newLiveRun.write(to: newFile)
                    }
                ) { files in
                    try? controller.processChangedFiles(files)
                    while controller.hasPendingReadWork {
                        try? controller.continuePendingWork()
                    }
                    callbackFinished.signal()
                }
                defer { watcher.stop() }

                let boundaryFiles = try watcher.discoverProviderFiles()
                if startsEnabled {
                    try controller.install(existingFiles: boundaryFiles)
                } else {
                    try controller.turnOn(existingFiles: boundaryFiles)
                }
                try watcher.start()
                XCTAssertEqual(callbackFinished.wait(timeout: .now() + 2), .success)

                XCTAssertEqual(
                    try harness.outbox.records(limit: 100)
                        .filter { $0.event.state == .completed }.count,
                    2
                )

                try append(
                    turnWithoutSessionMeta(nativeID: "future-in-gap-created-file"),
                    to: newFile
                )
                try controller.processChangedFiles([newFile])
                while controller.hasPendingReadWork {
                    try controller.continuePendingWork()
                }
                XCTAssertEqual(
                    try harness.outbox.records(limit: 100)
                        .filter { $0.event.state == .completed }.count,
                    3
                )
            }
        }
    }

    func testOnlyPrivacyEncoderOutputReachesOutboxAndStatusDoctorStayContentFree() throws {
        try withHarness { harness in
            let file = try harness.makeFile("privacy.jsonl", contents: Data())
            try harness.controller.install(existingFiles: [file])
            try append(completedRun(nativeID: "DO_NOT_EXPORT_NATIVE", trap: "DO_NOT_EXPORT_PROMPT_PATH_TOOL"), to: file)
            try harness.controller.processChangedFiles([file])
            for record in try harness.outbox.records(limit: 100) {
                XCTAssertEqual(record.encodedEvent, try PrivacyEncoder().encode(record.event))
                XCTAssertFalse(String(decoding: record.encodedEvent, as: UTF8.self).contains("DO_NOT_EXPORT"))
            }

            let status = try harness.controller.status(
                daemonRunning: true,
                serverEnabledSurfaces: [.codexCLI],
                lastSuccessfulUploadMS: now
            )
            XCTAssertEqual(status.persistedState, .enabled)
            XCTAssertTrue(status.description.contains(#""persistedState":"enabled""#))
            XCTAssertEqual(status.compiledAdapters[.claudeCode], .unavailable)
            XCTAssertEqual(status.compiledAdapters[.omp], .unavailable)
            let doctor = harness.controller.doctor(
                codexRootReadable: true,
                serverHealthy: true,
                signingValid: true,
                enrollmentAllowedSurfaces: [.codexCLI],
                environment: ["CLAUDE_CODE_ENABLE_TELEMETRY": "DO_NOT_EXPORT_ENV_VALUE"]
            )
            let rendered = String(decoding: try JSONEncoder().encode([status.description, doctor.description]), as: UTF8.self)
            XCTAssertFalse(rendered.contains("DO_NOT_EXPORT"))
            XCTAssertTrue(doctor.claudeOTelEnvironmentPresent)
        }
    }

    func testControlSocketIsOwnerOnlyAndFramesBoundedCommandsWithoutShellExecution() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-control-\(UUID().uuidString.prefix(8))", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let server = ControlSocketServer(socketURL: socketURL, maximumFrameBytes: 64)
        try server.start { command in
            XCTAssertEqual(command, .status)
            return ControlResponse(ok: true, message: "enabled")
        }
        defer { server.stop() }

        XCTAssertEqual(try permissions(parent), 0o700)
        XCTAssertEqual(try permissions(socketURL), 0o600)
        XCTAssertEqual(
            try ControlSocketClient.send(.status, to: socketURL, maximumFrameBytes: 64),
            ControlResponse(ok: true, message: "enabled")
        )
        XCTAssertThrowsError(try ControlSocketProtocol.decode(Data(repeating: 0x61, count: 65), maximumFrameBytes: 64))
        XCTAssertThrowsError(try ControlSocketProtocol.decode(Data("status; rm -rf /\n".utf8), maximumFrameBytes: 64))
    }

    func testSecondControlServerCannotStealLiveOwnedSocket() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-live-socket-\(UUID().uuidString.prefix(8))", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let first = ControlSocketServer(socketURL: socketURL)
        try first.start { _ in .init(ok: true, message: "first") }
        defer { first.stop() }
        let second = ControlSocketServer(socketURL: socketURL)

        XCTAssertThrowsError(try second.start { _ in .init(ok: true, message: "second") })
        XCTAssertEqual(
            try ControlSocketClient.send(.status, to: socketURL),
            .init(ok: true, message: "first")
        )
    }

    func testControlLifetimeLockPreventsReplacementAfterSocketPathIsRemoved() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-socket-lock-\(UUID().uuidString.prefix(8))", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let first = ControlSocketServer(socketURL: socketURL)
        try first.start { _ in .init(ok: true, message: "first") }
        defer { first.stop() }
        XCTAssertEqual(Darwin.unlink(socketURL.path), 0)

        let second = ControlSocketServer(socketURL: socketURL)
        defer { second.stop() }
        XCTAssertThrowsError(try second.start { _ in .init(ok: true, message: "second") }) {
            XCTAssertEqual($0 as? ControlSocketError, .liveSocket)
        }
    }

    func testEnrollmentConfigurationIsBoundedPrivateNoFollowAndParsesHexSecret() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-enrollment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: parent) }
        let file = parent.appendingPathComponent("enrollment.json")
        let secret = String(repeating: "ab", count: 32)
        let json = Data(
            """
            {"version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dedupe_secret":"\(secret)","server_url":"https://raiders.test","cutover_at":1700000000000,"enabled_surfaces":["codex_desktop","codex_cli"]}
            """.utf8
        )
        try json.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)

        let loaded = try EnrollmentConfiguration.load(from: file, allowsTestOrigin: true)
        XCTAssertEqual(loaded.deviceID, "00000000-0000-4000-8000-000000000001")
        XCTAssertEqual(loaded.dedupeSecret, Data(repeating: 0xab, count: 32))
        XCTAssertEqual(loaded.enabledSurfaces, [.codexDesktop, .codexCLI])
        XCTAssertThrowsError(try EnrollmentConfiguration.load(from: file))

        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        XCTAssertThrowsError(try EnrollmentConfiguration.load(from: file, allowsTestOrigin: true))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let link = parent.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try EnrollmentConfiguration.load(from: link, allowsTestOrigin: true))
        let oversized = parent.appendingPathComponent("oversized.json")
        try Data(repeating: 0x20, count: 65_537).write(to: oversized)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: oversized.path)
        XCTAssertThrowsError(
            try EnrollmentConfiguration.load(from: oversized, allowsTestOrigin: true)
        )

        var unknown = try XCTUnwrap(
            JSONSerialization.jsonObject(with: json) as? [String: Any]
        )
        unknown["unknown"] = "DO_NOT_EXPORT_UNKNOWN_CONFIG"
        let unknownData = try JSONSerialization.data(withJSONObject: unknown)
        try unknownData.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        XCTAssertThrowsError(try EnrollmentConfiguration.load(from: file, allowsTestOrigin: true))
    }

    private func permissions(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }

    private func makeEvent(run: Int, observedAtMS: Int64) -> RunEventV1 {
        RunEventV1(
            schemaVersion: 1, companionVersion: "0.1.0",
            deviceID: "00000000-0000-4000-8000-000000000001", provider: .codex,
            surface: .codexCLI, runKey: String(format: "%064x", run + 1), sequence: 1,
            eventTimeMS: observedAtMS, observedAtMS: observedAtMS, startedAtMS: observedAtMS,
            state: .open,
            usage: .init(input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0),
            model: nil, effort: nil, idempotencyKey: String(format: "%064x", run + 10_000)
        )
    }

    private func runPrefix(nativeID: String) -> Data {
        lines([
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"\(nativeID)\",\"model\":\"synthetic\"}}",
        ])
    }

    private func runSuffix() -> Data {
        lines([
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}"#,
            #"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ])
    }

    private func completedRun(nativeID: String, trap: String = "") -> Data {
        var prefix = runPrefix(nativeID: nativeID)
        if !trap.isEmpty {
            prefix.append(lines(["{\"timestamp\":\"2026-01-01T00:00:02.500Z\",\"type\":\"response_item\",\"payload\":{\"content\":\"\(trap)\"}}"] ))
        }
        prefix.append(runSuffix())
        return prefix
    }

    private func overSevenDayRun(nativeID: String) -> Data {
        lines([
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"\(nativeID)\",\"model\":\"synthetic\"}}",
            #"{"timestamp":"2026-01-09T00:00:03Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ])
    }

    private func turnWithoutSessionMeta(nativeID: String) -> Data {
        lines([
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"\(nativeID)\",\"model\":\"synthetic\"}}",
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}"#,
            #"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ])
    }

    private func lines(_ values: [String]) -> Data {
        Data((values.joined(separator: "\n") + "\n").utf8)
    }

    private func append(_ data: Data, to file: URL) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }

    private func withHarness(
        readLimitBytes: Int = JSONLReader.maximumReadBytes,
        _ body: (ControllerHarness) throws -> Void
    ) throws {
        let harness = try ControllerHarness(now: now, readLimitBytes: readLimitBytes)
        defer { try? FileManager.default.removeItem(at: harness.root) }
        try body(harness)
    }
}

private func appendProviderData(_ data: Data, to file: URL) throws {
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data)
}

private final class ControllerHarness {
    let root: URL
    let providerRoot: URL
    let paths: AgentPaths
    let registry: AdapterRegistry
    let outbox: Outbox
    let now: Int64
    let readLimitBytes: Int
    var controller: AgentController

    init(now: Int64, readLimitBytes: Int) throws {
        self.now = now
        self.readLimitBytes = readLimitBytes
        root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-controller-\(UUID().uuidString)", isDirectory: true)
        providerRoot = root.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: providerRoot, withIntermediateDirectories: true)
        paths = AgentPaths(applicationSupportDirectory: root)
        registry = try AdapterRegistry.enabled(surfaces: [.codexCLI], codexRoot: providerRoot)
        outbox = try Outbox(directory: paths.outboxDirectory)
        let fixedNow = now
        controller = try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: .init(
                companionVersion: "0.1.0",
                deviceID: "00000000-0000-4000-8000-000000000001",
                dedupeSecret: Data("DO_NOT_EXPORT_LOCAL_SECRET".utf8)
            ),
            readLimitBytes: readLimitBytes,
            clockMS: { fixedNow }
        )
        try controller.turnOn(existingFiles: [])
    }

    func makeController(
        afterProviderRead: @escaping @Sendable () -> Void = {},
        diagnosticHandler: @escaping (CollectorDiagnostic) -> Void = { _ in }
    ) throws -> AgentController {
        try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: .init(
                companionVersion: "0.1.0",
                deviceID: "00000000-0000-4000-8000-000000000001",
                dedupeSecret: Data("DO_NOT_EXPORT_LOCAL_SECRET".utf8)
            ),
            readLimitBytes: readLimitBytes,
            clockMS: { self.now },
            afterProviderRead: afterProviderRead,
            diagnosticHandler: diagnosticHandler
        )
    }

    func makeFile(_ name: String, contents: Data) throws -> URL {
        let file = providerRoot.appendingPathComponent(name)
        try contents.write(to: file)
        return file
    }
}

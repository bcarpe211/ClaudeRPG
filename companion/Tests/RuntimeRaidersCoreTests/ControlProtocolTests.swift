import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ControlProtocolTests: XCTestCase {
    func testAgentPathsExposeOneStableApplicationWithoutChangingStatePaths() {
        let root = URL(fileURLWithPath: "/Users/test/Library/Application Support")
        let paths = AgentPaths(applicationSupportDirectory: root)
        let support = root.appendingPathComponent("Runtime Raiders", isDirectory: true)
        let application = support.appendingPathComponent(
            "Runtime Raiders Agent.app",
            isDirectory: true
        )

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
        XCTAssertEqual(paths.agentApplication, application)
        XCTAssertEqual(
            paths.agentExecutable,
            application.appendingPathComponent(
                "Contents/MacOS/runtime-raiders-agent",
                isDirectory: false
            )
        )
    }

    func testFlatCommandRoutingUsesOnlyStableDaemonControlAndUpdateCheckRoutes() {
        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-flat-routing")
        )
        let stableExecutable = paths.agentExecutable
        let otherExecutable = URL(fileURLWithPath: "/private/tmp/runtime-raiders-agent")

        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: [],
                executableURL: otherExecutable,
                paths: paths
            ),
            .control(.status)
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["daemon"],
                executableURL: stableExecutable,
                paths: paths
            ),
            .daemon
        )
        XCTAssertNil(CompanionCommandRouter.route(
            arguments: ["daemon"],
            executableURL: otherExecutable,
            paths: paths
        ))
        for command in [
            ControlCommand.on,
            .off,
            .status,
            .doctor,
            .uninstall,
        ] {
            XCTAssertEqual(
                CompanionCommandRouter.route(
                    arguments: [command.rawValue],
                    executableURL: otherExecutable,
                    paths: paths
                ),
                .control(command)
            )
        }
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["update"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .updateCheck
        )

        for arguments in [
            ["prepare_update"],
            ["resume_update"],
            ["__self-check"],
            ["__runtime-raiders-installer-lease"],
            ["__runtime-raiders-legacy-prepare"],
            ["__runtime-raiders-installer-validate-legacy"],
            ["__runtime-raiders-installer-retire-sequence-eight-command"],
            ["__runtime-raiders-installer-status", "legacy-running"],
            ["__runtime-raiders-installer-protected-state"],
            ["__runtime-raiders-installer-sync-migration", "candidate"],
            ["__runtime-raiders-legacy-resume"],
            ["__runtime-raiders-installer-resume", "1"],
            ["daemon", "__runtime-raiders-trial-generation", "1"],
            ["daemon", "__runtime-raiders-installer-migration-generation", "1"],
        ] {
            XCTAssertNil(
                CompanionCommandRouter.route(
                    arguments: arguments,
                    executableURL: stableExecutable,
                    paths: paths
                ),
                "accepted retired route \(arguments)"
            )
        }
    }

    func testNormalDaemonStartupStartsControlBeforeOptionalActivationAndVersionCheck() throws {
        var actions: [String] = []
        let enabledStartup = NormalDaemonStartupCoordinator(operations: DaemonStartupOperations(
            startControl: { actions.append("control") },
            prepareLocalState: { actions.append("local-state") },
            activatePersistedEnabled: { actions.append("activate") },
            scheduleVersionCheck: { actions.append("version-check") }
        ))

        try enabledStartup.start(persistedEnabled: true)

        XCTAssertEqual(actions, ["control", "local-state", "activate", "version-check"])

        actions.removeAll()
        let disabledStartup = NormalDaemonStartupCoordinator(operations: DaemonStartupOperations(
            startControl: { actions.append("control") },
            prepareLocalState: { actions.append("local-state") },
            activatePersistedEnabled: { actions.append("activate") },
            scheduleVersionCheck: { actions.append("version-check") }
        ))

        try disabledStartup.start(persistedEnabled: false)

        XCTAssertEqual(actions, ["control", "local-state", "version-check"])
    }

    func testVersionCheckSchedulerChecksImmediatelyRepeatsHourlyAndCancelsShutdownTimer() throws {
        let harness = VersionCheckScheduleHarness()
        let scheduler = RecurringVersionCheckScheduler(
            operations: VersionCheckScheduleOperations(
                checkIfDue: { harness.check() },
                execute: { action in harness.enqueue(action) },
                scheduleAfter: { delay, action in
                    harness.schedule(after: delay, action: action)
                }
            )
        )

        scheduler.start()

        XCTAssertEqual(harness.checkCount, 0)
        XCTAssertEqual(harness.enqueuedActionCount, 1)
        XCTAssertEqual(harness.delays, [60 * 60])

        try harness.enqueuedAction(at: 0)()
        XCTAssertEqual(harness.checkCount, 1)

        let firstOpportunity = try harness.action(at: 0)
        firstOpportunity()

        XCTAssertEqual(harness.checkCount, 1)
        XCTAssertEqual(harness.enqueuedActionCount, 2)
        XCTAssertEqual(harness.delays, [60 * 60, 60 * 60])

        try harness.enqueuedAction(at: 1)()
        XCTAssertEqual(harness.checkCount, 2)

        let shutdownTimer = try harness.action(at: 1)
        scheduler.stop()

        XCTAssertEqual(harness.cancelledTimerIDs, [1])
        shutdownTimer()
        XCTAssertEqual(harness.checkCount, 2)
        XCTAssertEqual(harness.delays, [60 * 60, 60 * 60])
    }

    func testVersionCheckSchedulerEnqueuesStartupCheckWithoutRunningInline() throws {
        let harness = VersionCheckScheduleHarness()
        let scheduler = RecurringVersionCheckScheduler(
            operations: VersionCheckScheduleOperations(
                checkIfDue: { harness.check() },
                execute: { action in harness.enqueue(action) },
                scheduleAfter: { delay, action in
                    harness.schedule(after: delay, action: action)
                }
            )
        )

        scheduler.start()

        XCTAssertEqual(harness.checkCount, 0)
        XCTAssertEqual(harness.enqueuedActionCount, 1)

        scheduler.stop()
        try harness.enqueuedAction(at: 0)()
        XCTAssertEqual(harness.checkCount, 0)
    }

    func testVersionCheckSchedulerStopWaitsForInFlightCheckBeforeReturning() throws {
        let checkStarted = DispatchSemaphore(value: 0)
        let allowCheckToFinish = DispatchSemaphore(value: 0)
        let checkFinished = DispatchSemaphore(value: 0)
        let cancellationStarted = DispatchSemaphore(value: 0)
        let allowCancellationToFinish = DispatchSemaphore(value: 0)
        let stopReturned = DispatchSemaphore(value: 0)
        let harness = VersionCheckScheduleHarness { _ in
            cancellationStarted.signal()
            allowCancellationToFinish.wait()
        }
        let scheduler = RecurringVersionCheckScheduler(
            operations: VersionCheckScheduleOperations(
                checkIfDue: {
                    checkStarted.signal()
                    allowCheckToFinish.wait()
                    checkFinished.signal()
                },
                execute: { action in harness.enqueue(action) },
                scheduleAfter: { delay, action in
                    harness.schedule(after: delay, action: action)
                }
            )
        )

        scheduler.start()
        let startupCheck = try harness.enqueuedAction(at: 0)
        DispatchQueue(label: "version-check-test.check").async(execute: startupCheck)
        XCTAssertEqual(checkStarted.wait(timeout: .now() + 1), .success)

        DispatchQueue(label: "version-check-test.stop").async {
            scheduler.stop()
            stopReturned.signal()
        }
        XCTAssertEqual(cancellationStarted.wait(timeout: .now() + 1), .success)
        allowCancellationToFinish.signal()

        XCTAssertEqual(stopReturned.wait(timeout: .now() + 0.2), .timedOut)
        allowCheckToFinish.signal()
        XCTAssertEqual(checkFinished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(stopReturned.wait(timeout: .now() + 1), .success)
    }

    func testAgentStatusWireIncludesActivationStateWithoutRemovingEnabled() throws {
        let status = AgentStatus(
            enabled: true,
            activationState: .preparing,
            daemonRunning: true,
            persistedState: .enabled,
            serverEnabledSurfaces: [.codexDesktop],
            compiledAdapters: [.codexDesktop: .available],
            queuedEventCount: 0,
            lastSuccessfulUploadMS: nil,
            activeRunCount: 0
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(status.description.utf8))
                as? [String: Any]
        )

        XCTAssertEqual(object["enabled"] as? Bool, true)
        XCTAssertEqual(object["activationState"] as? String, "preparing")
        XCTAssertNil(object["availableReleaseSequence"])
        XCTAssertNil(object["preparedForUpdate"])
        XCTAssertNil(object["preparedReleaseStateGeneration"])
    }


    func testSerializedResumeIsIdempotentAndClearsPreparedOnlyAfterResumeSucceeds() {
        let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.resume-preparation")
        var resumeCalls = 0
        let preparation = SerializedUpdatePreparation(
            workQueue: queue,
            activeRunCount: { 0 },
            pauseAcceptance: {},
            pauseUploader: {},
            pauseHeartbeat: {},
            pauseWatcher: {},
            resume: { _ in
                resumeCalls += 1
                if resumeCalls == 1 { throw POSIXError(.EIO) }
            }
        )
        XCTAssertTrue(preparation.prepare(generation: 7).ok)
        XCTAssertTrue(preparation.isPrepared)
        XCTAssertEqual(preparation.preparedGeneration, 7)

        XCTAssertFalse(preparation.resume(generation: 8).ok)
        XCTAssertTrue(preparation.isPrepared)
        XCTAssertTrue(preparation.resume(generation: 8).ok)
        XCTAssertFalse(preparation.isPrepared)
        XCTAssertTrue(preparation.resume(generation: 8).ok)
        XCTAssertFalse(preparation.resume(generation: 9).ok)
        XCTAssertEqual(resumeCalls, 2)
    }

    func testSerializedPreparationCanStartQuiescedUntilExplicitCommit() {
        let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.start-prepared")
        var resumed = false
        let preparation = SerializedUpdatePreparation(
            workQueue: queue,
            activeRunCount: { 0 },
            pauseAcceptance: {},
            pauseUploader: {},
            pauseHeartbeat: {},
            pauseWatcher: {},
            initiallyPreparedGeneration: 7,
            resume: { _ in resumed = true }
        )

        XCTAssertTrue(preparation.isPrepared)
        XCTAssertEqual(preparation.preparedGeneration, 7)
        XCTAssertTrue(preparation.resume(generation: 8).ok)
        XCTAssertTrue(resumed)
        XCTAssertFalse(preparation.isPrepared)
    }

    func testAbandonmentResumeRequiresThePreparedGeneration() {
        let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.abandoned-resume")
        var resumeCalls = 0
        let preparation = SerializedUpdatePreparation(
            workQueue: queue,
            activeRunCount: { 0 },
            pauseAcceptance: {},
            pauseUploader: {},
            pauseHeartbeat: {},
            pauseWatcher: {},
            initiallyPreparedGeneration: 7,
            resume: { generation in
                XCTAssertEqual(generation, 7)
                resumeCalls += 1
            }
        )

        XCTAssertFalse(preparation.resumeAfterAbandonment(generation: 8).ok)
        XCTAssertTrue(preparation.isPrepared)
        XCTAssertTrue(preparation.resumeAfterAbandonment(generation: 7).ok)
        XCTAssertFalse(preparation.isPrepared)
        XCTAssertEqual(resumeCalls, 1)
    }

    func testIdempotentResumeStillRequiresTheExactCurrentCommittedGeneration() {
        enum Injected: Error { case staleGeneration }
        let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.resume-generation")
        var currentCommittedGeneration: Int64 = 8
        let preparation = SerializedUpdatePreparation(
            workQueue: queue,
            activeRunCount: { 0 },
            pauseAcceptance: {},
            pauseUploader: {},
            pauseHeartbeat: {},
            pauseWatcher: {},
            initiallyPreparedGeneration: 7,
            validateResume: { generation in
                if generation != currentCommittedGeneration { throw Injected.staleGeneration }
            }
        )

        XCTAssertTrue(preparation.resume(generation: 8).ok)
        XCTAssertTrue(preparation.resume(generation: 8).ok)
        currentCommittedGeneration = 9
        XCTAssertFalse(preparation.resume(generation: 8).ok)
    }

    func testBroadUpdateLockAloneStartsDaemonNormally() throws {
        let fixture = try PreparedStartupFixture()
        defer { fixture.cleanup() }
        let updateLock = try CompanionUpdateLock(paths: fixture.paths)
        defer { updateLock.unlock() }
        let actions = PreparedStartupActionLog()
        let startup = try PreparedDaemonStartupCoordinator(
            paths: fixture.paths,
            deferredStart: { actions.append("runtime-start") }
        )

        try startup.start()

        XCTAssertFalse(startup.startsPrepared)
        XCTAssertEqual(actions.values, ["runtime-start"])
    }

    func testExplicitPreparedStartupLeaseDefersProviderAndRuntimeWork() throws {
        let fixture = try PreparedStartupFixture()
        defer { fixture.cleanup() }
        let lease = try CompanionPreparedStartupLease(paths: fixture.paths)
        defer { lease.unlock() }
        let actions = PreparedStartupActionLog()
        let startup = try PreparedDaemonStartupCoordinator(
            paths: fixture.paths,
            deferredStart: {
                actions.append("provider-discovery")
                actions.append("provider-install")
                actions.append("release-discovery")
                actions.append("outbox-prune")
                actions.append("read-continuation")
                actions.append("upload")
                actions.append("heartbeat")
                actions.append("watcher")
            }
        )

        try startup.start()

        XCTAssertTrue(startup.startsPrepared)
        XCTAssertEqual(actions.values, [])
    }

    func testExplicitResumePerformsDeferredStartupExactlyOnce() throws {
        let fixture = try PreparedStartupFixture()
        defer { fixture.cleanup() }
        let lease = try CompanionPreparedStartupLease(paths: fixture.paths)
        defer { lease.unlock() }
        let actions = PreparedStartupActionLog()
        let startup = try PreparedDaemonStartupCoordinator(
            paths: fixture.paths,
            deferredStart: { actions.append("deferred-start") }
        )
        try startup.start()

        try startup.resume()
        try startup.resume()

        XCTAssertEqual(actions.values, ["deferred-start"])
    }

    func testAbandonedPreparedStartupLeaseSelfResumesRunningDaemon() throws {
        let fixture = try PreparedStartupFixture()
        defer { fixture.cleanup() }
        let lease = try CompanionPreparedStartupLease(paths: fixture.paths)
        let actions = PreparedStartupActionLog()
        let startup = try PreparedDaemonStartupCoordinator(
            paths: fixture.paths,
            deferredStart: { actions.append("deferred-start") }
        )
        try startup.start()
        let resumed = expectation(description: "prepared daemon self-resumes")
        startup.monitorAbandonment(
            on: DispatchQueue(label: "com.redlattice.runtime-raiders.tests.prepared-abandonment")
        ) {
            do {
                try startup.resume()
            } catch {
                XCTFail("unexpected resume failure: \(error)")
            }
            resumed.fulfill()
        }

        lease.unlock()
        wait(for: [resumed], timeout: 2)

        XCTAssertEqual(actions.values, ["deferred-start"])
        XCTAssertNil(try CompanionPreparedStartupLease.observe(paths: fixture.paths))
    }

    func testSerializedPrepareUpdateRefusesActiveRunWithoutPausingAnything() {
        let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.prepare-refusal")
        var actions: [String] = []
        let preparation = SerializedUpdatePreparation(
            workQueue: queue,
            activeRunCount: { 1 },
            pauseAcceptance: { actions.append("acceptance") },
            pauseUploader: { actions.append("uploader") },
            pauseHeartbeat: { actions.append("heartbeat") },
            pauseWatcher: { actions.append("watcher") }
        )

        XCTAssertEqual(
            preparation.prepare(generation: 7),
            ControlResponse(ok: false, message: "active Run prevents update")
        )
        XCTAssertEqual(actions, [])
    }

    func testSerializedPrepareUpdatePausesCollectionWithoutPersistingOff() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-prepare-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let codexRoot = root.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: codexRoot, withIntermediateDirectories: true)
        let paths = AgentPaths(applicationSupportDirectory: root)
        let registry = try AdapterRegistry.enabled(surfaces: [.codexCLI], codexRoot: codexRoot)
        let outbox = try Outbox(directory: paths.outboxDirectory)
        let controller = try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: AgentConfiguration(
                companionVersion: "0.2.0",
                deviceID: "11111111-2222-4333-8444-555555555555",
                dedupeSecret: Data(repeating: 0x41, count: 32)
            )
        )
        try controller.turnOn(existingFiles: [])
        XCTAssertTrue(controller.enabled)
        XCTAssertTrue(controller.isAcceptingCollection)

        let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.prepare-accepted")
        let key = DispatchSpecificKey<String>()
        queue.setSpecific(key: key, value: "work-queue")
        var actions: [String] = []
        let preparation = SerializedUpdatePreparation(
            workQueue: queue,
            activeRunCount: {
                XCTAssertEqual(DispatchQueue.getSpecific(key: key), "work-queue")
                return try controller.status(
                    daemonRunning: true,
                    serverEnabledSurfaces: [.codexCLI],
                    lastSuccessfulUploadMS: nil
                ).activeRunCount
            },
            pauseAcceptance: {
                XCTAssertEqual(DispatchQueue.getSpecific(key: key), "work-queue")
                controller.pauseCollection()
                actions.append("acceptance")
            },
            pauseUploader: { actions.append("uploader") },
            pauseHeartbeat: { actions.append("heartbeat") },
            pauseWatcher: { actions.append("watcher") }
        )

        XCTAssertEqual(
            preparation.prepare(generation: 7),
            ControlResponse(ok: true, message: "prepared for update")
        )
        XCTAssertEqual(actions, ["acceptance", "uploader", "heartbeat", "watcher"])
        XCTAssertFalse(controller.isAcceptingCollection)
        XCTAssertTrue(controller.enabled)
        XCTAssertEqual(
            try AgentController.persistedEnabled(paths: paths, surfaces: [.codexCLI]),
            true
        )
    }

    func testSerializedPrepareValidatesReleaseBeforeAnyPauseAndStartsOneObserver() {
        enum Injected: Error { case invalidRelease }
        let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.prepare-validation")
        var actions: [String] = []
        var valid = false
        let preparation = SerializedUpdatePreparation(
            workQueue: queue,
            activeRunCount: { actions.append("runs"); return 0 },
            validatePreparation: { generation in
                actions.append("validate-\(generation)")
                if !valid { throw Injected.invalidRelease }
            },
            pauseAcceptance: { actions.append("acceptance") },
            pauseUploader: { actions.append("uploader") },
            pauseHeartbeat: { actions.append("heartbeat") },
            pauseWatcher: { actions.append("watcher") },
            startAbandonmentObserver: { actions.append("observe-\($0)") }
        )

        XCTAssertFalse(preparation.prepare(generation: 7).ok)
        XCTAssertEqual(actions, ["runs", "validate-7"])
        XCTAssertNil(preparation.preparedGeneration)

        actions.removeAll()
        valid = true
        XCTAssertTrue(preparation.prepare(generation: 7).ok)
        XCTAssertEqual(actions, [
            "runs", "validate-7", "acceptance", "uploader", "heartbeat", "watcher", "observe-7",
        ])
        XCTAssertTrue(preparation.prepare(generation: 7).ok)
        XCTAssertEqual(actions.filter { $0 == "observe-7" }.count, 1)
    }

    func testPreparedReleaseValidationRequiresGenerationActiveIdentityTrialAndLease() throws {
        let fixture = releaseFixture()

        XCTAssertNoThrow(try PreparedDaemonStartupCoordinator.validatePreparation(
            generation: 7,
            releaseIdentity: fixture.activeIdentity,
            releaseState: fixture.trialState,
            leaseHeld: true
        ))
        XCTAssertThrowsError(try PreparedDaemonStartupCoordinator.validatePreparation(
            generation: 6,
            releaseIdentity: fixture.activeIdentity,
            releaseState: fixture.trialState,
            leaseHeld: true
        ))
        XCTAssertThrowsError(try PreparedDaemonStartupCoordinator.validatePreparation(
            generation: 7,
            releaseIdentity: fixture.trialIdentity,
            releaseState: fixture.trialState,
            leaseHeld: true
        ))
        XCTAssertThrowsError(try PreparedDaemonStartupCoordinator.validatePreparation(
            generation: 7,
            releaseIdentity: fixture.activeIdentity,
            releaseState: ReleaseStateV1(
                schemaVersion: 1,
                generation: 7,
                active: fixture.active,
                fallback: nil,
                trial: nil
            ),
            leaseHeld: true
        ))
        XCTAssertThrowsError(try PreparedDaemonStartupCoordinator.validatePreparation(
            generation: 7,
            releaseIdentity: fixture.activeIdentity,
            releaseState: fixture.trialState,
            leaseHeld: false
        ))
    }

    func testLeaseAbandonmentDispositionIsGenerationAndReleaseBound() {
        let fixture = releaseFixture()
        XCTAssertEqual(
            PreparedDaemonStartupCoordinator.disposition(
                preparedGeneration: 7,
                startedAsTrial: false,
                releaseIdentity: fixture.activeIdentity,
                releaseState: fixture.trialState
            ),
            .resumeCommittedActive
        )
        XCTAssertEqual(
            PreparedDaemonStartupCoordinator.disposition(
                preparedGeneration: 7,
                startedAsTrial: true,
                releaseIdentity: fixture.trialIdentity,
                releaseState: fixture.trialState
            ),
            .exitUncommittedTrial
        )
        XCTAssertEqual(
            PreparedDaemonStartupCoordinator.disposition(
                preparedGeneration: 7,
                startedAsTrial: true,
                releaseIdentity: fixture.trialIdentity,
                releaseState: ReleaseStateV1(
                    schemaVersion: 1,
                    generation: 8,
                    active: fixture.trial,
                    fallback: fixture.active,
                    trial: nil
                )
            ),
            .resumeCommittedActive
        )
        XCTAssertEqual(
            PreparedDaemonStartupCoordinator.disposition(
                preparedGeneration: 7,
                startedAsTrial: false,
                releaseIdentity: fixture.activeIdentity,
                releaseState: ReleaseStateV1(
                    schemaVersion: 2,
                    generation: 7,
                    active: fixture.active,
                    fallback: nil,
                    trial: fixture.trial
                )
            ),
            .failClosed
        )
        XCTAssertEqual(
            PreparedDaemonStartupCoordinator.disposition(
                preparedGeneration: 8,
                startedAsTrial: false,
                releaseIdentity: fixture.activeIdentity,
                releaseState: fixture.trialState
            ),
            .failClosed
        )
    }

    func testLockDrivenAbandonmentResumesCommittedActive() throws {
        let fixture = releaseFixture()
        let started = expectation(description: "committed active resumes")
        let harness = try ReleaseAbandonmentHarness(
            releaseState: fixture.trialState,
            releaseIdentity: fixture.activeIdentity,
            trialGeneration: nil,
            deferredStart: { started.fulfill() }
        )
        defer { harness.cleanup() }
        let preparation = harness.preparation()
        let stopped = LockedFlag()
        let orchestrator = harness.orchestrator(
            preparation: preparation,
            exitUncommittedTrial: { stopped.set() },
            failClosed: { stopped.set() }
        )

        orchestrator.start(generation: 7)
        harness.lease.unlock()
        wait(for: [started], timeout: 2)

        XCTAssertFalse(preparation.isPrepared)
        XCTAssertFalse(stopped.value)
    }

    func testLockDrivenAbandonmentExitsUncommittedTrialWithoutDeferredStart() throws {
        let fixture = releaseFixture()
        let exited = expectation(description: "uncommitted trial exits")
        let deferredStarts = LockedCounter()
        let harness = try ReleaseAbandonmentHarness(
            releaseState: fixture.trialState,
            releaseIdentity: fixture.trialIdentity,
            trialGeneration: 7,
            deferredStart: { deferredStarts.increment() }
        )
        defer { harness.cleanup() }
        let preparation = harness.preparation()
        let orchestrator = harness.orchestrator(
            preparation: preparation,
            exitUncommittedTrial: { exited.fulfill() },
            failClosed: { XCTFail("unexpected fail-closed") }
        )

        orchestrator.start(generation: 7)
        harness.lease.unlock()
        wait(for: [exited], timeout: 2)

        XCTAssertEqual(deferredStarts.value, 0)
        XCTAssertTrue(preparation.isPrepared)
    }

    func testLockDrivenAbandonmentResumesCommittedFormerTrial() throws {
        let fixture = releaseFixture()
        let started = expectation(description: "committed former trial resumes")
        let harness = try ReleaseAbandonmentHarness(
            releaseState: fixture.trialState,
            releaseIdentity: fixture.trialIdentity,
            trialGeneration: 7,
            deferredStart: { started.fulfill() }
        )
        defer { harness.cleanup() }
        let preparation = harness.preparation()
        let stopped = LockedFlag()
        let orchestrator = harness.orchestrator(
            preparation: preparation,
            exitUncommittedTrial: { stopped.set() },
            failClosed: { stopped.set() }
        )
        harness.releaseState.value = ReleaseStateV1(
            schemaVersion: 1,
            generation: 8,
            active: fixture.trial,
            fallback: fixture.active,
            trial: nil
        )

        orchestrator.start(generation: 7)
        harness.lease.unlock()
        wait(for: [started], timeout: 2)

        XCTAssertFalse(preparation.isPrepared)
        XCTAssertFalse(stopped.value)
    }

    func testLockDrivenMalformedAndContradictoryAbandonmentStopFailClosed() throws {
        let fixture = releaseFixture()
        let otherTrial = ReleaseReference(
            releaseSequence: 11,
            releaseSHA: String(repeating: "c", count: 40),
            companionVersion: "0.3.11",
            updateProtocolVersion: 2
        )
        let unsafeStates = [
            ReleaseStateV1(
                schemaVersion: 2,
                generation: 7,
                active: fixture.active,
                fallback: nil,
                trial: fixture.trial
            ),
            ReleaseStateV1(
                schemaVersion: 1,
                generation: 8,
                active: fixture.active,
                fallback: nil,
                trial: otherTrial
            ),
        ]

        for (index, unsafeState) in unsafeStates.enumerated() {
            let stopped = expectation(description: "unsafe state \(index) stops")
            let deferredStarts = LockedCounter()
            let harness = try ReleaseAbandonmentHarness(
                releaseState: fixture.trialState,
                releaseIdentity: fixture.trialIdentity,
                trialGeneration: 7,
                deferredStart: { deferredStarts.increment() }
            )
            let preparation = harness.preparation()
            let orchestrator = harness.orchestrator(
                preparation: preparation,
                exitUncommittedTrial: { XCTFail("unsafe state must fail closed") },
                failClosed: { stopped.fulfill() }
            )
            harness.releaseState.value = unsafeState

            orchestrator.start(generation: 7)
            harness.lease.unlock()
            wait(for: [stopped], timeout: 2)

            XCTAssertEqual(deferredStarts.value, 0)
            XCTAssertTrue(preparation.isPrepared)
            harness.cleanup()
        }
    }

    func testExplicitResumeRacingLeaseReleaseStartsOnceWithoutStaleStop() throws {
        let fixture = releaseFixture()
        let deferredStartEntered = DispatchSemaphore(value: 0)
        let allowDeferredStart = DispatchSemaphore(value: 0)
        let abandonmentAttempted = DispatchSemaphore(value: 0)
        let explicitResumeFinished = expectation(description: "explicit resume finishes")
        let deferredStarts = LockedCounter()
        let stopped = LockedFlag()
        let harness = try ReleaseAbandonmentHarness(
            releaseState: fixture.trialState,
            releaseIdentity: fixture.trialIdentity,
            trialGeneration: 7,
            deferredStart: {
                deferredStarts.increment()
                deferredStartEntered.signal()
                _ = allowDeferredStart.wait(timeout: .now() + 2)
            }
        )
        defer { harness.cleanup() }
        harness.releaseState.value = ReleaseStateV1(
            schemaVersion: 1,
            generation: 8,
            active: fixture.trial,
            fallback: fixture.active,
            trial: nil
        )
        let preparation = harness.preparation(validateResume: { generation in
            guard generation == 8 else { throw PreparedDaemonStartupError.invalidReleaseState }
        })
        let orchestrator = harness.orchestrator(
            preparation: preparation,
            resumeAfterAbandonment: { generation in
                abandonmentAttempted.signal()
                return preparation.resumeAfterAbandonment(generation: generation)
            },
            exitUncommittedTrial: { stopped.set() },
            failClosed: { stopped.set() }
        )
        orchestrator.start(generation: 7)

        DispatchQueue(label: "com.redlattice.runtime-raiders.tests.explicit-resume").async {
            XCTAssertTrue(preparation.resume(generation: 8).ok)
            explicitResumeFinished.fulfill()
        }
        XCTAssertEqual(deferredStartEntered.wait(timeout: .now() + 2), .success)
        harness.lease.unlock()
        XCTAssertEqual(abandonmentAttempted.wait(timeout: .now() + 2), .success)
        allowDeferredStart.signal()
        wait(for: [explicitResumeFinished], timeout: 2)
        harness.queue.sync {}

        XCTAssertEqual(deferredStarts.value, 1)
        XCTAssertFalse(preparation.isPrepared)
        XCTAssertFalse(stopped.value)
    }


    func testLegacyMigrationControlUsesOnlyExactBoundedFrameAndResponse() throws {
        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-legacy-control")
        )
        var observedFrame = Data()
        var observedSocket: URL?
        let control = LegacyMigrationControl(exchange: { frame, socket, maximumBytes, timeout in
            observedFrame = frame
            observedSocket = socket
            XCTAssertEqual(maximumBytes, 4_096)
            XCTAssertEqual(timeout, 30)
            return Data(#"{"ok":true,"message":"prepared"}"#.utf8) + Data([0x0A])
        })

        XCTAssertEqual(try control.prepare(paths: paths), ControlResponse(ok: true, message: "prepared"))
        XCTAssertEqual(observedFrame, Data(#"{"command":"prepare_update"}"#.utf8) + Data([0x0A]))
        XCTAssertEqual(observedSocket, paths.controlSocket)

        XCTAssertEqual(try control.resume(paths: paths), ControlResponse(ok: true, message: "prepared"))
        XCTAssertEqual(observedFrame, Data(#"{"command":"resume_update"}"#.utf8) + Data([0x0A]))

        for response in [
            Data(),
            Data(#"{"ok":true}"#.utf8) + Data([0x0A]),
            Data(#"{"ok":true,"message":"prepared","extra":1}"#.utf8) + Data([0x0A]),
            Data(repeating: 0x61, count: 4_097),
        ] {
            let malformed = LegacyMigrationControl(exchange: { _, _, _, _ in response })
            XCTAssertThrowsError(try malformed.prepare(paths: paths))
        }
        let timedOut = LegacyMigrationControl(exchange: { _, _, _, _ in throw POSIXError(.ETIMEDOUT) })
        XCTAssertThrowsError(try timedOut.prepare(paths: paths))
    }

    func testInstallerLeaseKeeperHoldsUntilInputClosesAndWritesOneReadinessLine() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true).appendingPathComponent(
            "rr-installer-lease-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        let input = Pipe()
        let output = Pipe()
        input.fileHandleForWriting.closeFile()
        var heldAtReadiness = false
        try InstallerPreparedLeaseKeeper.run(
            paths: paths,
            input: input.fileHandleForReading,
            output: output.fileHandleForWriting
        ) {
            heldAtReadiness = try CompanionPreparedStartupLease.observe(paths: paths) != nil
        }
        output.fileHandleForWriting.closeFile()
        let readiness = output.fileHandleForReading.readDataToEndOfFile()
        XCTAssertEqual(String(decoding: readiness, as: UTF8.self), "runtime-raiders-installer-lease-ready\n")
        XCTAssertTrue(heldAtReadiness)
        XCTAssertNil(try CompanionPreparedStartupLease.observe(paths: paths))
    }


    func testSelfCheckEmitsOnlyExactSealedReleaseIdentityJSON() throws {
        let identity = CompanionReleaseIdentity(
            releaseSequence: 7,
            releaseSHA: String(repeating: "a", count: 40),
            companionVersion: "0.2.3",
            updateProtocolVersion: 1
        )
        let data = try CompanionSelfCheck.encode(identity)

        XCTAssertEqual(
            String(decoding: data, as: UTF8.self),
            #"{"companion_version":"0.2.3","release_sequence":7,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1}"# + "\n"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), [
            "companion_version",
            "release_sequence",
            "release_sha",
            "update_protocol_version",
        ])
    }

    func testLaunchdControllerUsesOnlyKickstartForTheStableLoadedJob() throws {
        var calls: [(String, [String], TimeInterval)] = []
        let controller = LaunchdJobController(
            userIdentifier: 501,
            runCommand: { executable, arguments, timeout in
                calls.append((executable.path, arguments, timeout))
                return SystemCommandResult(exitStatus: .exited(0), stdout: Data(), stderr: Data())
            }
        )

        try controller.restart()

        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].0, "/bin/launchctl")
        XCTAssertEqual(calls[0].1, [
            "kickstart",
            "-k",
            "gui/501/com.redlattice.runtime-raiders-agent",
        ])
        XCTAssertEqual(calls[0].2, 10)
    }

    func testDoctorRequestCarriesOnlyKnownInvocationEnvironmentPresence() throws {
        let request = ControlRequest.invocation(
            command: .doctor,
            environment: [
                "OTEL_EXPORTER_OTLP_HEADERS": "DO_NOT_EXPORT_SECRET_VALUE",
                "ARBITRARY_ENVIRONMENT_KEY": "DO_NOT_EXPORT_ARBITRARY_VALUE",
            ]
        )

        let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
        let rendered = try XCTUnwrap(String(data: frame, encoding: .utf8))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
        )

        XCTAssertEqual(Set(object.keys), ["command", "claude_otel_environment_present"])
        XCTAssertEqual(object["command"] as? String, "doctor")
        XCTAssertEqual(object["claude_otel_environment_present"] as? Bool, true)
        XCTAssertFalse(rendered.contains("OTEL_EXPORTER_OTLP_HEADERS"))
        XCTAssertFalse(rendered.contains("ARBITRARY_ENVIRONMENT_KEY"))
        XCTAssertFalse(rendered.contains("DO_NOT_EXPORT"))
        XCTAssertEqual(
            try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
            request
        )
    }

    func testPublicNonDoctorCommandsRoundTripWithoutInternalMetadata() throws {
        for command in ControlCommand.allCases where command != .doctor {
            let request = ControlRequest.invocation(
                command: command,
                environment: ["CLAUDE_CODE_ENABLE_TELEMETRY": "DO_NOT_EXPORT_VALUE"]
            )
            let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
            )

            XCTAssertEqual(Set(object.keys), ["command"])
            XCTAssertNil(request.claudeOTelEnvironmentPresent)
            XCTAssertEqual(
                try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
                request
            )
        }
    }

    func testProtocolRejectsMalformedExtraAndCommandInconsistentFields() {
        let invalidFrames: [Data] = [
            Data("status\n".utf8),
            Data(#"{"command":"doctor"}"#.utf8) + Data([0x0A]),
            Data(#"{"command":"status","claude_otel_environment_present":false}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":"true"}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":false,"extra":true}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"prepare_update"}"#.utf8) + Data([0x0A]),
            Data(#"{"command":"resume_update"}"#.utf8) + Data([0x0A]),
            Data(#"{"command":"prepare_update","release_state_generation":0}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"resume_update","release_state_generation":9007199254740992}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"status","release_state_generation":7}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"unknown"}"#.utf8) + Data([0x0A]),
            Data("[]\n".utf8),
        ]

        for frame in invalidFrames {
            XCTAssertThrowsError(
                try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
                String(decoding: frame, as: UTF8.self)
            )
        }
        XCTAssertThrowsError(
            try ControlSocketProtocol.encode(
                ControlRequest(command: .doctor),
                maximumFrameBytes: 4_096
            )
        )
        XCTAssertThrowsError(
            try ControlSocketProtocol.encode(
                ControlRequest(command: .status, claudeOTelEnvironmentPresent: true),
                maximumFrameBytes: 4_096
            )
        )
    }

    func testKnownEnvironmentDetectionIgnoresValuesAndArbitraryNames() {
        for name in [
            "CLAUDE_CODE_ENABLE_TELEMETRY",
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_HEADERS",
            "OTEL_METRICS_EXPORTER",
            "OTEL_LOGS_EXPORTER",
        ] {
            XCTAssertTrue(DoctorEnvironment.claudeOTelPresent(in: [name: ""]))
            XCTAssertTrue(DoctorEnvironment.claudeOTelPresent(in: [name: "DO_NOT_EXPORT"]))
        }
        XCTAssertFalse(DoctorEnvironment.claudeOTelPresent(in: [:]))
        XCTAssertFalse(DoctorEnvironment.claudeOTelPresent(in: [
            "OTEL_UNRELATED_VARIABLE": "DO_NOT_EXPORT",
            "CLAUDE_UNRELATED_VARIABLE": "DO_NOT_EXPORT",
        ]))
        XCTAssertTrue(DoctorEnvironment.combinedPresence(
            invocationPresent: true,
            daemonEnvironment: [:]
        ))
        XCTAssertTrue(DoctorEnvironment.combinedPresence(
            invocationPresent: false,
            daemonEnvironment: ["OTEL_LOGS_EXPORTER": "DO_NOT_EXPORT"]
        ))
        XCTAssertFalse(DoctorEnvironment.combinedPresence(
            invocationPresent: false,
            daemonEnvironment: ["OTEL_UNRELATED_VARIABLE": "DO_NOT_EXPORT"]
        ))
    }

    func testSocketPassesTypedDoctorPresenceToRequestHandler() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-doctor-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let server = ControlSocketServer(socketURL: socketURL)
        try server.startRequests { request in
            ControlResponse(
                ok: true,
                message: request.claudeOTelEnvironmentPresent == true ? "present" : "absent"
            )
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .doctor, claudeOTelEnvironmentPresent: true),
            to: socketURL
        )

        XCTAssertEqual(response, ControlResponse(ok: true, message: "present"))
    }

    func testAttestedSocketResponseReportsTheActualServingExecutable() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-attested-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let server = ControlSocketServer(socketURL: socketURL)
        try server.startRequests { _ in ControlResponse(ok: true, message: "status") }
        defer { server.stop() }

        let (response, peer) = try ControlSocketClient.sendAttested(
            request: ControlRequest(command: .status),
            to: socketURL
        )

        XCTAssertEqual(response, ControlResponse(ok: true, message: "status"))
        XCTAssertEqual(
            peer.executableURL.resolvingSymlinksInPath().standardizedFileURL.path,
            try XCTUnwrap(Bundle.main.executableURL)
                .resolvingSymlinksInPath().standardizedFileURL.path
        )
        XCTAssertEqual(peer.auditToken.count, MemoryLayout<audit_token_t>.size)
        XCTAssertTrue(InstallerDynamicCodeIdentityValidator().matches(
            peer: peer,
            expectedExecutable: peer.executableURL
        ))
        XCTAssertFalse(InstallerDynamicCodeIdentityValidator().matches(
            peer: peer,
            expectedExecutable: URL(fileURLWithPath: "/usr/bin/xcrun")
        ))
        XCTAssertFalse(InstallerDynamicCodeIdentityValidator().matches(
            peer: ControlPeerIdentity(
                executableURL: peer.executableURL,
                auditToken: Data(repeating: 0, count: MemoryLayout<audit_token_t>.size)
            ),
            expectedExecutable: peer.executableURL
        ))
    }

    func testOnCrossesInitialTimeoutThroughSerializedReadinessBarrier() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-slow-on-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = PreparedStartupActionLog()
        let enabledStatus = AgentStatus(
            enabled: true,
            daemonRunning: true,
            persistedState: .enabled,
            serverEnabledSurfaces: [.codexDesktop, .codexCLI],
            compiledAdapters: [.codexDesktop: .available, .codexCLI: .available],
            queuedEventCount: 0,
            lastSuccessfulUploadMS: nil,
            activeRunCount: 0
        )
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            commands.append(command.rawValue)
            switch command {
            case .on:
                Thread.sleep(forTimeInterval: 1.25)
                return ControlResponse(ok: true, message: "enabled")
            case .status:
                return ControlResponse(ok: true, message: enabledStatus.description)
            default:
                return ControlResponse(ok: false, message: "unexpected command")
            }
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .on),
            to: socketURL,
            initialTimeoutSeconds: 1,
            enableCompletionTimeoutSeconds: 3
        )

        XCTAssertEqual(response, ControlResponse(ok: true, message: "enabled"))
        XCTAssertEqual(commands.values, ["on", "status"])
    }

    func testTimedOutOnFailsClosedWhenReadinessBarrierIsInconclusive() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-inconclusive-on-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = PreparedStartupActionLog()
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            commands.append(command.rawValue)
            switch command {
            case .on:
                Thread.sleep(forTimeInterval: 1.25)
                return ControlResponse(ok: true, message: "enabled")
            case .status:
                return ControlResponse(ok: true, message: "not-agent-status")
            case .off:
                return ControlResponse(ok: true, message: "off")
            default:
                return ControlResponse(ok: false, message: "unexpected command")
            }
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .on),
            to: socketURL,
            initialTimeoutSeconds: 1,
            enableCompletionTimeoutSeconds: 3
        )

        XCTAssertEqual(response, ControlResponse(ok: false, message: "unable to enable"))
        XCTAssertEqual(commands.values, ["on", "status", "off"])
    }

    func testTimedOutOnNeverReportsFailureAsSafeWhenOffCannotBeVerified() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-unverified-off-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = PreparedStartupActionLog()
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            commands.append(command.rawValue)
            switch command {
            case .on:
                Thread.sleep(forTimeInterval: 1.25)
                return ControlResponse(ok: true, message: "enabled")
            case .status:
                return ControlResponse(ok: true, message: "not-agent-status")
            case .off:
                return ControlResponse(ok: false, message: "unable to turn off")
            default:
                return ControlResponse(ok: false, message: "unexpected command")
            }
        }
        defer { server.stop() }

        XCTAssertThrowsError(try ControlSocketClient.send(
            request: ControlRequest(command: .on),
            to: socketURL,
            initialTimeoutSeconds: 1,
            enableCompletionTimeoutSeconds: 3
        )) { error in
            XCTAssertEqual(error as? ControlSocketError, .enableCompletionUnverified)
        }
        XCTAssertEqual(commands.values, ["on", "status", "off"])
    }

    private func makeRecoveryPaths(_ suffix: String) throws -> AgentPaths {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-stable-recovery-\(suffix)-\(UUID().uuidString)", isDirectory: true)
        let paths = AgentPaths(applicationSupportDirectory: root)
        try FileManager.default.createDirectory(at: paths.supportDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: paths.supportDirectory.path
        )
        return paths
    }

    private func makeRecoveryApp(_ app: URL, marker: String, mode: Int) throws {
        let executableDirectory = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: executableDirectory, withIntermediateDirectories: true)
        try Data(marker.utf8).write(to: app.appendingPathComponent("marker"))
        try Data("fixture".utf8).write(
            to: executableDirectory.appendingPathComponent("runtime-raiders-agent")
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: mode],
            ofItemAtPath: app.path
        )
    }

    private func recoveryPermissions(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }

    private func recoveryInode(_ url: URL) throws -> UInt64 {
        var metadata = stat()
        guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.EIO) }
        return UInt64(metadata.st_ino)
    }

    private func recoveryMarker(_ app: URL) throws -> String {
        String(
            decoding: try Data(contentsOf: app.appendingPathComponent("marker")),
            as: UTF8.self
        )
    }
}

private final class PreparedStartupFixture {
    let root: URL
    let paths: AgentPaths

    init() throws {
        root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-prepared-startup-\(UUID().uuidString)", isDirectory: true)
        paths = AgentPaths(applicationSupportDirectory: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: root)
    }
}

private final class PreparedStartupActionLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] { lock.withLock { storage } }

    func append(_ value: String) {
        lock.withLock { storage.append(value) }
    }
}

private struct PreparedReleaseFixture {
    let active: ReleaseReference
    let trial: ReleaseReference
    let activeIdentity: CompanionReleaseIdentity
    let trialIdentity: CompanionReleaseIdentity
    let trialState: ReleaseStateV1
}

private func releaseFixture() -> PreparedReleaseFixture {
    let active = ReleaseReference(
        releaseSequence: 9,
        releaseSHA: String(repeating: "a", count: 40),
        companionVersion: "0.3.9",
        updateProtocolVersion: 2
    )
    let trial = ReleaseReference(
        releaseSequence: 10,
        releaseSHA: String(repeating: "b", count: 40),
        companionVersion: "0.3.10",
        updateProtocolVersion: 2
    )
    return PreparedReleaseFixture(
        active: active,
        trial: trial,
        activeIdentity: try! active.companionReleaseIdentity(),
        trialIdentity: try! trial.companionReleaseIdentity(),
        trialState: ReleaseStateV1(
            schemaVersion: 1,
            generation: 7,
            active: active,
            fallback: nil,
            trial: trial
        )
    )
}

private final class LockedReleaseState: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: ReleaseStateV1

    init(_ value: ReleaseStateV1) { storage = value }

    var value: ReleaseStateV1 {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0

    var value: Int { lock.withLock { storage } }
    func increment() { lock.withLock { storage += 1 } }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = false

    var value: Bool { lock.withLock { storage } }
    func set() { lock.withLock { storage = true } }
}

private final class ReleaseAbandonmentHarness {
    let root: URL
    let paths: AgentPaths
    let lease: CompanionPreparedStartupLease
    let releaseState: LockedReleaseState
    let coordinator: PreparedDaemonStartupCoordinator
    let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.tests.release-abandonment")

    init(
        releaseState: ReleaseStateV1,
        releaseIdentity: CompanionReleaseIdentity,
        trialGeneration: Int64?,
        deferredStart: @escaping () throws -> Void
    ) throws {
        root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-release-abandonment-\(UUID().uuidString)", isDirectory: true)
        paths = AgentPaths(applicationSupportDirectory: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        lease = try CompanionPreparedStartupLease(paths: paths)
        let state = LockedReleaseState(releaseState)
        self.releaseState = state
        coordinator = try PreparedDaemonStartupCoordinator(
            paths: paths,
            trialGeneration: trialGeneration,
            releaseIdentity: releaseIdentity,
            loadReleaseState: { state.value },
            deferredStart: deferredStart
        )
    }

    func preparation(
        validateResume: @escaping (Int64) throws -> Void = { _ in }
    ) -> SerializedUpdatePreparation {
        SerializedUpdatePreparation(
            workQueue: DispatchQueue(
                label: "com.redlattice.runtime-raiders.tests.release-abandonment-work"
            ),
            activeRunCount: { 0 },
            pauseAcceptance: {},
            pauseUploader: {},
            pauseHeartbeat: {},
            pauseWatcher: {},
            initiallyPreparedGeneration: coordinator.initiallyPreparedGeneration,
            validateResume: validateResume,
            resume: { _ in try self.coordinator.resume() }
        )
    }

    func orchestrator(
        preparation: SerializedUpdatePreparation,
        resumeAfterAbandonment: (@Sendable (Int64) -> ControlResponse)? = nil,
        exitUncommittedTrial: @escaping @Sendable () -> Void,
        failClosed: @escaping @Sendable () -> Void
    ) -> PreparedReleaseAbandonmentOrchestrator {
        PreparedReleaseAbandonmentOrchestrator(
            coordinator: coordinator,
            queue: queue,
            preparedGeneration: { preparation.preparedGeneration },
            resumeAfterAbandonment: resumeAfterAbandonment ?? {
                preparation.resumeAfterAbandonment(generation: $0)
            },
            exitUncommittedTrial: exitUncommittedTrial,
            failClosed: failClosed
        )
    }

    func cleanup() {
        lease.unlock()
        try? FileManager.default.removeItem(at: root)
    }
}

private final class VersionCheckScheduleHarness: @unchecked Sendable {
    private let lock = NSLock()
    private let cancellationObserver: @Sendable (Int) -> Void
    private var checkCountStorage = 0
    private var delaysStorage: [TimeInterval] = []
    private var actionsStorage: [@Sendable () -> Void] = []
    private var enqueuedActionsStorage: [@Sendable () -> Void] = []
    private var cancelledTimerIDsStorage: [Int] = []

    var checkCount: Int { lock.withLock { checkCountStorage } }
    var delays: [TimeInterval] { lock.withLock { delaysStorage } }
    var cancelledTimerIDs: [Int] { lock.withLock { cancelledTimerIDsStorage } }
    var enqueuedActionCount: Int { lock.withLock { enqueuedActionsStorage.count } }

    init(cancellationObserver: @escaping @Sendable (Int) -> Void = { _ in }) {
        self.cancellationObserver = cancellationObserver
    }

    func check() {
        lock.withLock { checkCountStorage += 1 }
    }

    func enqueue(_ action: @escaping @Sendable () -> Void) {
        lock.withLock { enqueuedActionsStorage.append(action) }
    }

    func schedule(
        after delay: TimeInterval,
        action: @escaping @Sendable () -> Void
    ) -> ScheduledVersionCheck {
        let timerID = lock.withLock { () -> Int in
            let timerID = actionsStorage.count
            delaysStorage.append(delay)
            actionsStorage.append(action)
            return timerID
        }
        return ScheduledVersionCheck { [weak self] in
            self?.lock.withLock { self?.cancelledTimerIDsStorage.append(timerID) }
            self?.cancellationObserver(timerID)
        }
    }

    func action(at index: Int) throws -> @Sendable () -> Void {
        try lock.withLock {
            guard actionsStorage.indices.contains(index) else {
                throw POSIXError(.EINVAL)
            }
            return actionsStorage[index]
        }
    }

    func enqueuedAction(at index: Int) throws -> @Sendable () -> Void {
        try lock.withLock {
            guard enqueuedActionsStorage.indices.contains(index) else {
                throw POSIXError(.EINVAL)
            }
            return enqueuedActionsStorage[index]
        }
    }
}

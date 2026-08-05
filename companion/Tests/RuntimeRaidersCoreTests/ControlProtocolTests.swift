import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ControlProtocolTests: XCTestCase {
    func testPrepareUpdateUsesLongTimeoutAndCarriesNoInvocationMetadata() throws {
        let request = ControlRequest.invocation(
            command: .prepareUpdate,
            environment: ["OTEL_EXPORTER_OTLP_HEADERS": "DO_NOT_EXPORT_SECRET_VALUE"]
        )
        let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
        )

        XCTAssertEqual(ControlSocketClient.timeoutSeconds(for: .prepareUpdate), 30)
        XCTAssertEqual(Set(object.keys), ["command"])
        XCTAssertEqual(object["command"] as? String, "prepare_update")
        XCTAssertNil(request.claudeOTelEnvironmentPresent)
        XCTAssertEqual(
            try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
            request
        )
    }

    func testResumeUpdateIsInternalLongTimeoutMetadataFreeAndNotUserRoutable() throws {
        let request = ControlRequest.invocation(
            command: .resumeUpdate,
            environment: ["OTEL_EXPORTER_OTLP_HEADERS": "DO_NOT_EXPORT_SECRET_VALUE"]
        )
        let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
        )
        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-resume-routing")
        )

        XCTAssertEqual(ControlSocketClient.timeoutSeconds(for: .resumeUpdate), 30)
        XCTAssertEqual(Set(object.keys), ["command"])
        XCTAssertEqual(object["command"] as? String, "resume_update")
        XCTAssertNil(request.claudeOTelEnvironmentPresent)
        XCTAssertNil(CompanionCommandRouter.route(
            arguments: ["resume_update"],
            executableURL: URL(fileURLWithPath: "/private/tmp/runtime-raiders-agent"),
            paths: paths
        ))
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
            resume: {
                resumeCalls += 1
                if resumeCalls == 1 { throw POSIXError(.EIO) }
            }
        )
        XCTAssertTrue(preparation.prepare().ok)
        XCTAssertTrue(preparation.isPrepared)

        XCTAssertFalse(preparation.resume().ok)
        XCTAssertTrue(preparation.isPrepared)
        XCTAssertTrue(preparation.resume().ok)
        XCTAssertFalse(preparation.isPrepared)
        XCTAssertTrue(preparation.resume().ok)
        XCTAssertEqual(resumeCalls, 2)
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
            preparation.prepare(),
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
            preparation.prepare(),
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

    func testCommandRoutingKeepsUpdateLocalAndRejectsInternalControlName() {
        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-routing")
        )
        let ordinaryExecutable = URL(fileURLWithPath: "/private/tmp/runtime-raiders-agent")

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
                    executableURL: ordinaryExecutable,
                    paths: paths
                ),
                .control(command)
            )
        }
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["update"],
                executableURL: ordinaryExecutable,
                paths: paths
            ),
            .foregroundUpdate
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["prepare_update"],
                executableURL: ordinaryExecutable,
                paths: paths
            )
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["update", "status"],
                executableURL: ordinaryExecutable,
                paths: paths
            )
        )
    }

    func testDaemonAndInternalCommandsRequireExactSingleArgumentAndPathRules() {
        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-internal-routing")
        )
        let installedExecutable = paths.installedApplication
            .appendingPathComponent("Contents/MacOS/runtime-raiders-agent")
        let rollbackExecutable = paths.rollbackApplication
            .appendingPathComponent("Contents/MacOS/runtime-raiders-agent")
        let otherExecutable = URL(fileURLWithPath: "/private/tmp/runtime-raiders-agent")

        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["daemon"],
                executableURL: installedExecutable,
                paths: paths
            ),
            .daemon
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["daemon"],
                executableURL: otherExecutable,
                paths: paths
            )
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["__self-check"],
                executableURL: otherExecutable,
                paths: paths
            ),
            .selfCheck
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["__self-check", "status"],
                executableURL: otherExecutable,
                paths: paths
            )
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["__recover-update"],
                executableURL: rollbackExecutable,
                paths: paths
            ),
            .recoverUpdate
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["__recover-update"],
                executableURL: installedExecutable,
                paths: paths
            )
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["__recover-update", "status"],
                executableURL: rollbackExecutable,
                paths: paths
            )
        )
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

    func testLaunchdControllerUsesOnlyFixedExecutableAndExactJobArguments() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-launchd-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let plist = root.appendingPathComponent("com.redlattice.runtime-raiders-agent.plist")
        try Data("plist".utf8).write(to: plist)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plist.path)
        var calls: [(String, [String], TimeInterval)] = []
        let controller = LaunchdJobController(
            userIdentifier: 501,
            plistURL: plist,
            runCommand: { executable, arguments, timeout in
                calls.append((executable.path, arguments, timeout))
                return SystemCommandResult(exitStatus: .exited(0), stdout: Data(), stderr: Data())
            }
        )

        try controller.bootout()
        try controller.bootstrap()
        try controller.restart()

        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls[0].0, "/bin/launchctl")
        XCTAssertEqual(calls[0].1, [
            "bootout",
            "gui/501/com.redlattice.runtime-raiders-agent",
        ])
        XCTAssertEqual(calls[0].2, 10)
        XCTAssertEqual(calls[1].0, "/bin/launchctl")
        XCTAssertEqual(calls[1].1, [
            "bootstrap",
            "gui/501",
            plist.standardizedFileURL.path,
        ])
        XCTAssertEqual(calls[1].2, 10)
        XCTAssertEqual(calls[2].0, "/bin/launchctl")
        XCTAssertEqual(calls[2].1, [
            "kickstart",
            "-k",
            "gui/501/com.redlattice.runtime-raiders-agent",
        ])
        XCTAssertEqual(calls[2].2, 10)
    }

    func testLaunchdStoppedProofRequiresIndependentPositiveJobAbsenceEvidence() {
        let plist = URL(fileURLWithPath: "/private/tmp/com.redlattice.runtime-raiders-agent.plist")
        func controller(
            _ operation: @escaping () throws -> SystemCommandResult
        ) -> LaunchdJobController {
            LaunchdJobController(
                userIdentifier: 501,
                plistURL: plist,
                runCommand: { executable, arguments, timeout in
                    XCTAssertEqual(executable.path, "/bin/launchctl")
                    XCTAssertEqual(arguments, [
                        "print",
                        "gui/501/com.redlattice.runtime-raiders-agent",
                    ])
                    XCTAssertEqual(timeout, 5)
                    return try operation()
                }
            )
        }

        XCTAssertTrue(controller {
            SystemCommandResult(
                exitStatus: .exited(113),
                stdout: Data(),
                stderr: Data("Could not find service in domain for user gui: 501".utf8)
            )
        }.proveStopped())
        XCTAssertFalse(controller {
            SystemCommandResult(
                exitStatus: .exited(0),
                stdout: Data("running".utf8),
                stderr: Data()
            )
        }.proveStopped())
        XCTAssertFalse(controller {
            SystemCommandResult(
                exitStatus: .exited(113),
                stdout: Data(),
                stderr: Data("response was lost".utf8)
            )
        }.proveStopped())
        XCTAssertFalse(controller {
            throw POSIXError(.EIO)
        }.proveStopped())
    }

    func testStableRecoveryRevalidatesBundlesAfterStoppedProofBeforeRestore() throws {
        let paths = try makeRecoveryPaths("ordered")
        defer { try? FileManager.default.removeItem(at: paths.supportDirectory.deletingLastPathComponent()) }
        var log: [String] = []
        let recovery = StableUpdateRecovery(paths: paths, operations: StableUpdateRecoveryOperations(
            phase: {
                log.append("phase")
                return .rollbackOnly
            },
            verifyBundles: { phase in
                XCTAssertEqual(phase, .rollbackOnly)
                log.append("verify")
            },
            persistDisabled: { log.append("disable") },
            bootout: { log.append("bootout") },
            proveStopped: {
                log.append("proof")
                return true
            },
            restore: { phase in
                XCTAssertEqual(phase, .rollbackOnly)
                log.append("restore")
            },
            verifyRestoredBundle: { phase in
                XCTAssertEqual(phase, .rollbackOnly)
                log.append("verify-restored")
            },
            bootstrap: { log.append("bootstrap") },
            verifyDisabledHealth: {
                log.append("health")
                return true
            }
        ))

        try recovery.run()

        XCTAssertEqual(log, [
            "phase", "verify", "disable", "bootout", "proof", "verify", "restore",
            "verify-restored", "bootstrap", "health",
        ])
    }

    func testStableRecoveryTreatsBootoutResponseLossConservativelyAndGatesRestoreOnProof() throws {
        let responsePaths = try makeRecoveryPaths("response-lost")
        defer {
            try? FileManager.default.removeItem(
                at: responsePaths.supportDirectory.deletingLastPathComponent()
            )
        }
        var restoredAfterResponseLoss = false
        let responseLost = StableUpdateRecovery(paths: responsePaths, operations: StableUpdateRecoveryOperations(
            phase: { .rollbackOnly },
            verifyBundles: { _ in },
            persistDisabled: {},
            bootout: { throw POSIXError(.EIO) },
            proveStopped: { true },
            restore: { _ in restoredAfterResponseLoss = true },
            verifyRestoredBundle: { _ in },
            bootstrap: {},
            verifyDisabledHealth: { true }
        ))
        try responseLost.run()
        XCTAssertTrue(restoredAfterResponseLoss)

        let noProofPaths = try makeRecoveryPaths("no-proof")
        defer {
            try? FileManager.default.removeItem(
                at: noProofPaths.supportDirectory.deletingLastPathComponent()
            )
        }
        var restoredWithoutProof = false
        let notProven = StableUpdateRecovery(paths: noProofPaths, operations: StableUpdateRecoveryOperations(
            phase: { .rollbackOnly },
            verifyBundles: { _ in },
            persistDisabled: {},
            bootout: {},
            proveStopped: { false },
            restore: { _ in restoredWithoutProof = true },
            verifyRestoredBundle: { _ in },
            bootstrap: {},
            verifyDisabledHealth: { true }
        ))
        XCTAssertThrowsError(try notProven.run()) { error in
            XCTAssertEqual(error as? StableUpdateRecoveryError, .daemonNotProvenStopped)
        }
        XCTAssertFalse(restoredWithoutProof)
    }

    func testStableRecoveryLayoutAcceptsSafe0755RollbackOnlyAndRestoresItOwnerOnly() throws {
        let paths = try makeRecoveryPaths("rollback-only")
        defer { try? FileManager.default.removeItem(at: paths.supportDirectory.deletingLastPathComponent()) }
        try makeRecoveryApp(paths.rollbackApplication, marker: "old", mode: 0o755)
        let rollbackInode = try recoveryInode(paths.rollbackApplication)
        let layout = try StableRecoveryFileTransaction(paths: paths)

        let phase = try layout.inspectAndNormalize()

        XCTAssertEqual(phase, .rollbackOnly)
        XCTAssertEqual(try recoveryPermissions(paths.rollbackApplication), 0o700)
        try layout.restore(phase: phase)
        XCTAssertEqual(try recoveryInode(paths.installedApplication), rollbackInode)
        XCTAssertEqual(try recoveryMarker(paths.installedApplication), "old")
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.rollbackApplication.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.failedApplication.path))
    }

    func testStableRecoveryLayoutRequiresExactPostSwapPairAndPreservesAmbiguousState() throws {
        let postSwap = try makeRecoveryPaths("post-swap")
        defer { try? FileManager.default.removeItem(at: postSwap.supportDirectory.deletingLastPathComponent()) }
        try makeRecoveryApp(postSwap.rollbackApplication, marker: "old", mode: 0o700)
        try makeRecoveryApp(postSwap.failedApplication, marker: "new", mode: 0o700)
        let failedInode = try recoveryInode(postSwap.failedApplication)
        let layout = try StableRecoveryFileTransaction(paths: postSwap)
        let phase = try layout.inspectAndNormalize()
        XCTAssertEqual(phase, .rollbackAndFailed)
        try layout.restore(phase: phase)
        XCTAssertEqual(try recoveryMarker(postSwap.installedApplication), "old")
        XCTAssertEqual(try recoveryInode(postSwap.failedApplication), failedInode)
        XCTAssertEqual(try recoveryMarker(postSwap.failedApplication), "new")

        let ambiguous = try makeRecoveryPaths("ambiguous")
        defer { try? FileManager.default.removeItem(at: ambiguous.supportDirectory.deletingLastPathComponent()) }
        try makeRecoveryApp(ambiguous.installedApplication, marker: "installed", mode: 0o755)
        try makeRecoveryApp(ambiguous.rollbackApplication, marker: "rollback", mode: 0o700)
        let installedInode = try recoveryInode(ambiguous.installedApplication)
        let rollbackInode = try recoveryInode(ambiguous.rollbackApplication)
        let ambiguousLayout = try StableRecoveryFileTransaction(paths: ambiguous)
        XCTAssertThrowsError(try ambiguousLayout.inspectAndNormalize())
        XCTAssertEqual(try recoveryInode(ambiguous.installedApplication), installedInode)
        XCTAssertEqual(try recoveryInode(ambiguous.rollbackApplication), rollbackInode)

        let unsafeFailed = try makeRecoveryPaths("unsafe-failed")
        defer {
            try? FileManager.default.removeItem(
                at: unsafeFailed.supportDirectory.deletingLastPathComponent()
            )
        }
        try makeRecoveryApp(unsafeFailed.rollbackApplication, marker: "rollback", mode: 0o755)
        try makeRecoveryApp(unsafeFailed.failedApplication, marker: "failed", mode: 0o755)
        let unsafeLayout = try StableRecoveryFileTransaction(paths: unsafeFailed)
        XCTAssertThrowsError(try unsafeLayout.inspectAndNormalize())
        XCTAssertEqual(try recoveryPermissions(unsafeFailed.rollbackApplication), 0o755)
        XCTAssertEqual(try recoveryPermissions(unsafeFailed.failedApplication), 0o755)
    }

    func testStableRecoveryPollsHealthWithoutRealSleepAndPreservesInstalledOnDeadline() throws {
        let delayedPaths = try makeRecoveryPaths("delayed-health")
        defer { try? FileManager.default.removeItem(at: delayedPaths.supportDirectory.deletingLastPathComponent()) }
        var healthCalls = 0
        var now: TimeInterval = 0
        var sleeps: [TimeInterval] = []
        let delayed = StableUpdateRecovery(paths: delayedPaths, operations: StableUpdateRecoveryOperations(
            phase: { .rollbackOnly },
            verifyBundles: { _ in },
            persistDisabled: {},
            bootout: {},
            proveStopped: { true },
            restore: { _ in },
            verifyRestoredBundle: { _ in },
            bootstrap: {},
            verifyDisabledHealth: {
                healthCalls += 1
                return healthCalls == 3
            },
            monotonicNow: { now },
            sleep: { interval in
                sleeps.append(interval)
                now += interval
            }
        ))
        try delayed.run()
        XCTAssertEqual(healthCalls, 3)
        XCTAssertEqual(sleeps, [0.1, 0.1])

        let timeoutPaths = try makeRecoveryPaths("health-timeout")
        defer { try? FileManager.default.removeItem(at: timeoutPaths.supportDirectory.deletingLastPathComponent()) }
        try makeRecoveryApp(timeoutPaths.rollbackApplication, marker: "old", mode: 0o700)
        let timeoutLayout = try StableRecoveryFileTransaction(paths: timeoutPaths)
        var timeoutNow: TimeInterval = 0
        let timedOut = StableUpdateRecovery(paths: timeoutPaths, operations: StableUpdateRecoveryOperations(
            phase: { try timeoutLayout.inspectAndNormalize() },
            verifyBundles: { _ in },
            persistDisabled: {},
            bootout: {},
            proveStopped: { true },
            restore: { try timeoutLayout.restore(phase: $0) },
            verifyRestoredBundle: { _ in },
            bootstrap: {},
            verifyDisabledHealth: { false },
            monotonicNow: { timeoutNow },
            sleep: { timeoutNow += max($0, 5) }
        ))
        XCTAssertThrowsError(try timedOut.run()) { error in
            XCTAssertEqual(error as? StableUpdateRecoveryError, .healthVerificationFailed)
        }
        XCTAssertEqual(try recoveryMarker(timeoutPaths.installedApplication), "old")
        XCTAssertFalse(FileManager.default.fileExists(atPath: timeoutPaths.rollbackApplication.path))
    }

    func testStableRecoveryRefusesHeldSharedUpdateLockBeforeEffectsAndReleasesAfterFailure() throws {
        let paths = try makeRecoveryPaths("shared-lock")
        defer { try? FileManager.default.removeItem(at: paths.supportDirectory.deletingLastPathComponent()) }
        let held = try CompanionUpdateLock(paths: paths)
        var effects = 0
        let blocked = StableUpdateRecovery(paths: paths, operations: StableUpdateRecoveryOperations(
            phase: {
                effects += 1
                return .rollbackOnly
            },
            verifyBundles: { _ in effects += 1 },
            persistDisabled: { effects += 1 },
            bootout: { effects += 1 },
            proveStopped: {
                effects += 1
                return true
            },
            restore: { _ in effects += 1 },
            verifyRestoredBundle: { _ in effects += 1 },
            bootstrap: { effects += 1 },
            verifyDisabledHealth: {
                effects += 1
                return true
            }
        ))
        XCTAssertThrowsError(try blocked.run()) { error in
            XCTAssertEqual(error as? CompanionUpdaterError, .updateInProgress)
        }
        XCTAssertEqual(effects, 0)
        held.unlock()

        let failing = StableUpdateRecovery(paths: paths, operations: StableUpdateRecoveryOperations(
            phase: { .rollbackOnly },
            verifyBundles: { _ in throw POSIXError(.EIO) },
            persistDisabled: {},
            bootout: {},
            proveStopped: { true },
            restore: { _ in },
            verifyRestoredBundle: { _ in },
            bootstrap: {},
            verifyDisabledHealth: { true }
        ))
        XCTAssertThrowsError(try failing.run())
        let reacquired = try CompanionUpdateLock(paths: paths)
        reacquired.unlock()
    }

    func testStableRecoveryReleasesSharedLockAcrossEveryFailingStage() throws {
        enum Failure: String, CaseIterable {
            case phase
            case firstVerification
            case persistDisabled
            case stoppedProof
            case secondVerification
            case restore
            case restoredVerification
            case bootstrap
            case health
            case clock
        }

        for failure in Failure.allCases {
            let paths = try makeRecoveryPaths("release-lock-\(failure.rawValue)")
            var verificationCount = 0
            var now: TimeInterval = 0
            let recovery = StableUpdateRecovery(
                paths: paths,
                operations: StableUpdateRecoveryOperations(
                    phase: {
                        if failure == .phase { throw POSIXError(.EIO) }
                        return .rollbackOnly
                    },
                    verifyBundles: { _ in
                        verificationCount += 1
                        if failure == .firstVerification && verificationCount == 1 {
                            throw POSIXError(.EIO)
                        }
                        if failure == .secondVerification && verificationCount == 2 {
                            throw POSIXError(.EIO)
                        }
                    },
                    persistDisabled: {
                        if failure == .persistDisabled { throw POSIXError(.EIO) }
                    },
                    bootout: {},
                    proveStopped: { failure != .stoppedProof },
                    restore: { _ in
                        if failure == .restore { throw POSIXError(.EIO) }
                    },
                    verifyRestoredBundle: { _ in
                        if failure == .restoredVerification { throw POSIXError(.EIO) }
                    },
                    bootstrap: {
                        if failure == .bootstrap { throw POSIXError(.EIO) }
                    },
                    verifyDisabledHealth: {
                        if failure == .health { throw POSIXError(.EIO) }
                        return true
                    },
                    monotonicNow: {
                        failure == .clock ? .nan : now
                    },
                    sleep: { now += max($0, 10) }
                )
            )

            XCTAssertThrowsError(try recovery.run(), failure.rawValue)
            let reacquired = try CompanionUpdateLock(paths: paths)
            reacquired.unlock()
            try FileManager.default.removeItem(
                at: paths.supportDirectory.deletingLastPathComponent()
            )
        }
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

    func testNonDoctorCommandsRoundTripWithoutDoctorMetadata() throws {
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
        let invalidFrames = [
            Data("status\n".utf8),
            Data(#"{"command":"doctor"}"#.utf8) + Data([0x0A]),
            Data(#"{"command":"status","claude_otel_environment_present":false}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":"true"}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":false,"extra":true}"#.utf8)
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

    func testOnWaitsForSafeInitializationBeyondFastControlTimeout() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-slow-on-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let handlerFinished = DispatchSemaphore(value: 0)
        let server = ControlSocketServer(socketURL: socketURL)
        try server.start { command in
            defer { handlerFinished.signal() }
            XCTAssertEqual(command, .on)
            Thread.sleep(forTimeInterval: 2.25)
            return ControlResponse(ok: true, message: "enabled")
        }
        defer { server.stop() }

        let result = Result {
            try ControlSocketClient.send(.on, to: socketURL)
        }

        XCTAssertEqual(handlerFinished.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(
            try result.get(),
            ControlResponse(ok: true, message: "enabled")
        )
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

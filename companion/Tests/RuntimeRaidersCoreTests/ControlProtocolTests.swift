import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ControlProtocolTests: XCTestCase {
    func testPrepareUpdateUsesLongTimeoutAndCarriesExactReleaseGeneration() throws {
        let request = ControlRequest(command: .prepareUpdate, releaseStateGeneration: 7)
        let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
        )

        XCTAssertEqual(ControlSocketClient.timeoutSeconds(for: .prepareUpdate), 30)
        XCTAssertEqual(Set(object.keys), ["command", "release_state_generation"])
        XCTAssertEqual(object["command"] as? String, "prepare_update")
        XCTAssertEqual(object["release_state_generation"] as? Int64, 7)
        XCTAssertNil(request.claudeOTelEnvironmentPresent)
        XCTAssertEqual(
            try ControlSocketProtocol.decode(frame, maximumFrameBytes: 4_096),
            request
        )
    }

    func testResumeUpdateIsInternalGenerationBoundAndNotUserRoutable() throws {
        let request = ControlRequest(command: .resumeUpdate, releaseStateGeneration: 8)
        let frame = try ControlSocketProtocol.encode(request, maximumFrameBytes: 4_096)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: frame.dropLast()) as? [String: Any]
        )
        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-resume-routing")
        )

        XCTAssertEqual(ControlSocketClient.timeoutSeconds(for: .resumeUpdate), 30)
        XCTAssertEqual(Set(object.keys), ["command", "release_state_generation"])
        XCTAssertEqual(object["command"] as? String, "resume_update")
        XCTAssertEqual(object["release_state_generation"] as? Int64, 8)
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
        let state = ReleaseStateV1(
            schemaVersion: 1,
            generation: 7,
            active: active,
            fallback: nil,
            trial: trial
        )
        let activeExecutable = try! paths.executable(for: active)
        let trialExecutable = try! paths.executable(for: trial)
        let otherExecutable = URL(fileURLWithPath: "/private/tmp/runtime-raiders-agent")

        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["daemon"],
                executableURL: activeExecutable,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: false,
                releaseIdentity: try! active.companionReleaseIdentity()
            ),
            .daemon(trialGeneration: nil)
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["daemon"],
                executableURL: otherExecutable,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: false,
                releaseIdentity: try! active.companionReleaseIdentity()
            )
        )
        XCTAssertEqual(
            CompanionCommandRouter.route(
                arguments: ["daemon", "__runtime-raiders-trial-generation", "7"],
                executableURL: trialExecutable,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: true,
                releaseIdentity: try! trial.companionReleaseIdentity()
            ),
            .daemon(trialGeneration: 7)
        )
        for malformed in ["", "0", "-1", "+7", "7.0", " 7", "9007199254740992"] {
            XCTAssertNil(
                CompanionCommandRouter.route(
                    arguments: ["daemon", "__runtime-raiders-trial-generation", malformed],
                    executableURL: trialExecutable,
                    paths: paths,
                    releaseState: state,
                    preparedStartupLeaseHeld: true,
                    releaseIdentity: try! trial.companionReleaseIdentity()
                ),
                "accepted malformed generation \(malformed)"
            )
        }
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["daemon", "__runtime-raiders-trial-generation", "7"],
                executableURL: activeExecutable,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: true,
                releaseIdentity: try! trial.companionReleaseIdentity()
            )
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["daemon", "__runtime-raiders-trial-generation", "7"],
                executableURL: trialExecutable,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: false,
                releaseIdentity: try! trial.companionReleaseIdentity()
            )
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["daemon", "__runtime-raiders-trial-generation", "7"],
                executableURL: trialExecutable,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: true,
                releaseIdentity: try! active.companionReleaseIdentity()
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
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["__recover-update"],
                executableURL: activeExecutable,
                paths: paths
            )
        )
        XCTAssertNil(
            CompanionCommandRouter.route(
                arguments: ["__recover-update", "status"],
                executableURL: activeExecutable,
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
            revertRestored: { _ in log.append("revert") },
            verifyRestoredBundle: { phase in
                XCTAssertEqual(phase, .rollbackOnly)
                log.append("verify-restored")
            },
            bootstrap: {
                XCTAssertNotNil(try CompanionPreparedStartupLease.observe(paths: paths))
                log.append("bootstrap")
            },
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
            revertRestored: { _ in },
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
            revertRestored: { _ in },
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
        try makeRecoveryApp(paths.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o755)
        let rollbackInode = try recoveryInode(paths.legacyProtocolOne.rollbackApplication)
        let layout = try StableRecoveryFileTransaction(paths: paths)

        let phase = try layout.inspectAndNormalize()

        XCTAssertEqual(phase, .rollbackOnly)
        XCTAssertEqual(try recoveryPermissions(paths.legacyProtocolOne.rollbackApplication), 0o700)
        try layout.restore(phase: phase)
        XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.installedApplication), rollbackInode)
        XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.installedApplication), "old")
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.legacyProtocolOne.rollbackApplication.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.legacyProtocolOne.failedApplication.path))
    }

    func testStableRecoveryLayoutRequiresExactPostSwapPairAndPreservesAmbiguousState() throws {
        let postSwap = try makeRecoveryPaths("post-swap")
        defer { try? FileManager.default.removeItem(at: postSwap.supportDirectory.deletingLastPathComponent()) }
        try makeRecoveryApp(postSwap.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o700)
        try makeRecoveryApp(postSwap.legacyProtocolOne.failedApplication, marker: "new", mode: 0o700)
        let failedInode = try recoveryInode(postSwap.legacyProtocolOne.failedApplication)
        let layout = try StableRecoveryFileTransaction(paths: postSwap)
        let phase = try layout.inspectAndNormalize()
        XCTAssertEqual(phase, .rollbackAndFailed)
        try layout.restore(phase: phase)
        XCTAssertEqual(try recoveryMarker(postSwap.legacyProtocolOne.installedApplication), "old")
        XCTAssertEqual(try recoveryInode(postSwap.legacyProtocolOne.failedApplication), failedInode)
        XCTAssertEqual(try recoveryMarker(postSwap.legacyProtocolOne.failedApplication), "new")

        let ambiguous = try makeRecoveryPaths("ambiguous")
        defer { try? FileManager.default.removeItem(at: ambiguous.supportDirectory.deletingLastPathComponent()) }
        try makeRecoveryApp(ambiguous.legacyProtocolOne.installedApplication, marker: "installed", mode: 0o755)
        try makeRecoveryApp(ambiguous.legacyProtocolOne.rollbackApplication, marker: "rollback", mode: 0o700)
        let installedInode = try recoveryInode(ambiguous.legacyProtocolOne.installedApplication)
        let rollbackInode = try recoveryInode(ambiguous.legacyProtocolOne.rollbackApplication)
        let ambiguousLayout = try StableRecoveryFileTransaction(paths: ambiguous)
        XCTAssertThrowsError(try ambiguousLayout.inspectAndNormalize())
        XCTAssertEqual(try recoveryInode(ambiguous.legacyProtocolOne.installedApplication), installedInode)
        XCTAssertEqual(try recoveryInode(ambiguous.legacyProtocolOne.rollbackApplication), rollbackInode)

        let unsafeFailed = try makeRecoveryPaths("unsafe-failed")
        defer {
            try? FileManager.default.removeItem(
                at: unsafeFailed.supportDirectory.deletingLastPathComponent()
            )
        }
        try makeRecoveryApp(unsafeFailed.legacyProtocolOne.rollbackApplication, marker: "rollback", mode: 0o755)
        try makeRecoveryApp(unsafeFailed.legacyProtocolOne.failedApplication, marker: "failed", mode: 0o755)
        let unsafeLayout = try StableRecoveryFileTransaction(paths: unsafeFailed)
        XCTAssertThrowsError(try unsafeLayout.inspectAndNormalize())
        XCTAssertEqual(try recoveryPermissions(unsafeFailed.legacyProtocolOne.rollbackApplication), 0o755)
        XCTAssertEqual(try recoveryPermissions(unsafeFailed.legacyProtocolOne.failedApplication), 0o755)
    }

    func testStableRecoveryLayoutRevertsExactRollbackAfterEveryPostRenameThrow() throws {
        enum Injected: Error { case operation }

        for fault: StableRecoveryRestoreFault in [
            .parentSynchronize,
            .installedPostcheck,
            .failedCandidatePostcheck,
        ] {
            let paths = try makeRecoveryPaths("restore-post-rename-\(fault)")
            defer {
                try? FileManager.default.removeItem(
                    at: paths.supportDirectory.deletingLastPathComponent()
                )
            }
            try makeRecoveryApp(paths.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o700)
            try makeRecoveryApp(paths.legacyProtocolOne.failedApplication, marker: "new", mode: 0o700)
            let rollbackInode = try recoveryInode(paths.legacyProtocolOne.rollbackApplication)
            let failedInode = try recoveryInode(paths.legacyProtocolOne.failedApplication)
            var pendingFault: StableRecoveryRestoreFault? = fault
            let layout = try StableRecoveryFileTransaction(
                paths: paths,
                restoreFault: { checkpoint in
                    guard pendingFault == checkpoint else { return }
                    pendingFault = nil
                    throw Injected.operation
                }
            )
            let phase = try layout.inspectAndNormalize()

            XCTAssertThrowsError(try layout.restore(phase: phase), String(describing: fault)) {
                XCTAssertTrue($0 is Injected, String(describing: fault))
            }
            let installedExists = FileManager.default.fileExists(
                atPath: paths.legacyProtocolOne.installedApplication.path
            )
            let rollbackExists = FileManager.default.fileExists(
                atPath: paths.legacyProtocolOne.rollbackApplication.path
            )
            XCTAssertFalse(installedExists, String(describing: fault))
            XCTAssertTrue(rollbackExists, String(describing: fault))
            guard !installedExists, rollbackExists else { continue }
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.rollbackApplication), rollbackInode)
            XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.rollbackApplication), "old")
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
            XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.failedApplication), "new")

            let retryPhase = try layout.inspectAndNormalize()
            XCTAssertEqual(retryPhase, .rollbackAndFailed)
            try layout.restore(phase: retryPhase)
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.installedApplication), rollbackInode)
            XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.installedApplication), "old")
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
        }
    }

    func testStableRecoveryLayoutReturnsTypedTerminalErrorWhenInternalRevertIsUnsafe() throws {
        enum Injected: Error { case operation }

        let paths = try makeRecoveryPaths("restore-post-rename-unsafe-revert")
        defer {
            try? FileManager.default.removeItem(
                at: paths.supportDirectory.deletingLastPathComponent()
            )
        }
        try makeRecoveryApp(paths.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o700)
        try makeRecoveryApp(paths.legacyProtocolOne.failedApplication, marker: "new", mode: 0o700)
        let failedInode = try recoveryInode(paths.legacyProtocolOne.failedApplication)
        let layout = try StableRecoveryFileTransaction(
            paths: paths,
            restoreFault: { checkpoint in
                guard checkpoint == .installedPostcheck else { return }
                try FileManager.default.removeItem(at: paths.legacyProtocolOne.installedApplication)
                try self.makeRecoveryApp(
                    paths.legacyProtocolOne.installedApplication,
                    marker: "intruder",
                    mode: 0o700
                )
                throw Injected.operation
            }
        )
        let phase = try layout.inspectAndNormalize()

        XCTAssertThrowsError(try layout.restore(phase: phase)) { error in
            XCTAssertEqual(error as? StableUpdateRecoveryError, .retrySafetyFailure)
        }
        XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.installedApplication), "intruder")
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.legacyProtocolOne.rollbackApplication.path))
        XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
        XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.failedApplication), "new")
    }

    func testStableRecoveryBootsOutWhenBootstrapStartsDaemonThenThrowsAndRetrySucceeds() throws {
        enum Injected: Error { case operation }

        let paths = try makeRecoveryPaths("bootstrap-start-then-throw")
        defer {
            try? FileManager.default.removeItem(
                at: paths.supportDirectory.deletingLastPathComponent()
            )
        }
        try makeRecoveryApp(paths.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o700)
        try makeRecoveryApp(paths.legacyProtocolOne.failedApplication, marker: "new", mode: 0o700)
        let rollbackInode = try recoveryInode(paths.legacyProtocolOne.rollbackApplication)
        let failedInode = try recoveryInode(paths.legacyProtocolOne.failedApplication)
        let layout = try StableRecoveryFileTransaction(paths: paths)
        var attempt = 0
        var bootouts = 0
        var stoppedProofs = 0
        var daemonRunning = true
        let recovery = StableUpdateRecovery(
            paths: paths,
            operations: StableUpdateRecoveryOperations(
                phase: {
                    attempt += 1
                    return try layout.inspectAndNormalize()
                },
                verifyBundles: { _ in },
                persistDisabled: {},
                bootout: {
                    bootouts += 1
                    daemonRunning = false
                },
                proveStopped: {
                    stoppedProofs += 1
                    return !daemonRunning
                },
                restore: { try layout.restore(phase: $0) },
                revertRestored: { try layout.revertRestore(phase: $0) },
                verifyRestoredBundle: { _ in },
                bootstrap: {
                    daemonRunning = true
                    if attempt == 1 { throw Injected.operation }
                },
                verifyDisabledHealth: { true }
            )
        )

        XCTAssertThrowsError(try recovery.run()) { error in
            XCTAssertTrue(error is Injected)
        }
        XCTAssertEqual(bootouts, 2)
        XCTAssertEqual(stoppedProofs, 2)
        XCTAssertFalse(daemonRunning)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.legacyProtocolOne.installedApplication.path))
        XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.rollbackApplication), rollbackInode)
        XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)

        try recovery.run()

        XCTAssertEqual(attempt, 2)
        XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.installedApplication), rollbackInode)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.legacyProtocolOne.rollbackApplication.path))
        XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
        XCTAssertTrue(daemonRunning)
    }

    func testStableRecoveryRevertsEveryPostRestoreFailureAndSecondRunSucceeds() throws {
        enum Failure: String, CaseIterable {
            case restoredVerification
            case bootstrap
            case invalidHealth
            case healthTimeout
        }
        enum Injected: Error { case operation }

        for failure in Failure.allCases {
            let paths = try makeRecoveryPaths("retry-\(failure.rawValue)")
            defer {
                try? FileManager.default.removeItem(
                    at: paths.supportDirectory.deletingLastPathComponent()
                )
            }
            try makeRecoveryApp(paths.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o700)
            try makeRecoveryApp(paths.legacyProtocolOne.failedApplication, marker: "new", mode: 0o700)
            let rollbackInode = try recoveryInode(paths.legacyProtocolOne.rollbackApplication)
            let failedInode = try recoveryInode(paths.legacyProtocolOne.failedApplication)
            let layout = try StableRecoveryFileTransaction(paths: paths)
            var attempt = 0
            var bootouts = 0
            var stoppedProofs = 0
            var daemonRunning = true
            var now: TimeInterval = 0
            let recovery = StableUpdateRecovery(
                paths: paths,
                operations: StableUpdateRecoveryOperations(
                    phase: {
                        attempt += 1
                        now = 0
                        return try layout.inspectAndNormalize()
                    },
                    verifyBundles: { phase in
                        XCTAssertEqual(phase, .rollbackAndFailed)
                        XCTAssertEqual(try self.recoveryInode(paths.legacyProtocolOne.rollbackApplication), rollbackInode)
                        XCTAssertEqual(try self.recoveryMarker(paths.legacyProtocolOne.rollbackApplication), "old")
                        XCTAssertEqual(try self.recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
                        XCTAssertEqual(try self.recoveryMarker(paths.legacyProtocolOne.failedApplication), "new")
                    },
                    persistDisabled: {},
                    bootout: {
                        bootouts += 1
                        daemonRunning = false
                    },
                    proveStopped: {
                        stoppedProofs += 1
                        return !daemonRunning
                    },
                    restore: { try layout.restore(phase: $0) },
                    revertRestored: { try layout.revertRestore(phase: $0) },
                    verifyRestoredBundle: { phase in
                        XCTAssertEqual(phase, .rollbackAndFailed)
                        XCTAssertEqual(try self.recoveryInode(paths.legacyProtocolOne.installedApplication), rollbackInode)
                        XCTAssertEqual(try self.recoveryMarker(paths.legacyProtocolOne.installedApplication), "old")
                        XCTAssertEqual(try self.recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
                        if attempt == 1, failure == .restoredVerification {
                            throw Injected.operation
                        }
                    },
                    bootstrap: {
                        if attempt == 1, failure == .bootstrap { throw Injected.operation }
                        daemonRunning = true
                    },
                    verifyDisabledHealth: {
                        if attempt == 1, failure == .invalidHealth { throw Injected.operation }
                        return attempt != 1 || failure != .healthTimeout
                    },
                    monotonicNow: { now },
                    sleep: { now += max($0, 10) }
                )
            )

            XCTAssertThrowsError(try recovery.run(), failure.rawValue) { error in
                if failure == .restoredVerification || failure == .bootstrap {
                    XCTAssertTrue(error is Injected)
                } else {
                    XCTAssertEqual(
                        error as? StableUpdateRecoveryError,
                        .healthVerificationFailed
                    )
                }
            }
            XCTAssertEqual(bootouts, 2, failure.rawValue)
            XCTAssertEqual(stoppedProofs, 2, failure.rawValue)
            XCTAssertFalse(daemonRunning, failure.rawValue)
            XCTAssertFalse(
                FileManager.default.fileExists(atPath: paths.legacyProtocolOne.installedApplication.path),
                failure.rawValue
            )
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.rollbackApplication), rollbackInode)
            XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.rollbackApplication), "old")
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
            XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.failedApplication), "new")

            try recovery.run()

            XCTAssertEqual(attempt, 2, failure.rawValue)
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.installedApplication), rollbackInode)
            XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.installedApplication), "old")
            XCTAssertFalse(FileManager.default.fileExists(atPath: paths.legacyProtocolOne.rollbackApplication.path))
            XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
            XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.failedApplication), "new")
            XCTAssertTrue(daemonRunning, failure.rawValue)
        }
    }

    func testStableRecoveryReportsDistinctTerminalErrorWhenExactRevertIsUnsafe() throws {
        enum Injected: Error { case operation }

        let paths = try makeRecoveryPaths("unsafe-retry-revert")
        defer {
            try? FileManager.default.removeItem(
                at: paths.supportDirectory.deletingLastPathComponent()
            )
        }
        try makeRecoveryApp(paths.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o700)
        try makeRecoveryApp(paths.legacyProtocolOne.failedApplication, marker: "new", mode: 0o700)
        let failedInode = try recoveryInode(paths.legacyProtocolOne.failedApplication)
        let layout = try StableRecoveryFileTransaction(paths: paths)
        var bootouts = 0
        let recovery = StableUpdateRecovery(
            paths: paths,
            operations: StableUpdateRecoveryOperations(
                phase: { try layout.inspectAndNormalize() },
                verifyBundles: { _ in },
                persistDisabled: {},
                bootout: { bootouts += 1 },
                proveStopped: { true },
                restore: { try layout.restore(phase: $0) },
                revertRestored: { try layout.revertRestore(phase: $0) },
                verifyRestoredBundle: { _ in
                    try FileManager.default.removeItem(at: paths.legacyProtocolOne.installedApplication)
                    try self.makeRecoveryApp(
                        paths.legacyProtocolOne.installedApplication,
                        marker: "intruder",
                        mode: 0o700
                    )
                    throw Injected.operation
                },
                bootstrap: {},
                verifyDisabledHealth: { true }
            )
        )

        XCTAssertThrowsError(try recovery.run()) { error in
            XCTAssertEqual(error as? StableUpdateRecoveryError, .retrySafetyFailure)
        }
        XCTAssertEqual(bootouts, 2)
        XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.installedApplication), "intruder")
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.legacyProtocolOne.rollbackApplication.path))
        XCTAssertEqual(try recoveryInode(paths.legacyProtocolOne.failedApplication), failedInode)
        XCTAssertEqual(try recoveryMarker(paths.legacyProtocolOne.failedApplication), "new")
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
            revertRestored: { _ in },
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
        try makeRecoveryApp(timeoutPaths.legacyProtocolOne.rollbackApplication, marker: "old", mode: 0o700)
        let timeoutLayout = try StableRecoveryFileTransaction(paths: timeoutPaths)
        var timeoutNow: TimeInterval = 0
        let timedOut = StableUpdateRecovery(paths: timeoutPaths, operations: StableUpdateRecoveryOperations(
            phase: { try timeoutLayout.inspectAndNormalize() },
            verifyBundles: { _ in },
            persistDisabled: {},
            bootout: {},
            proveStopped: { true },
            restore: { try timeoutLayout.restore(phase: $0) },
            revertRestored: { try timeoutLayout.revertRestore(phase: $0) },
            verifyRestoredBundle: { _ in },
            bootstrap: {},
            verifyDisabledHealth: { false },
            monotonicNow: { timeoutNow },
            sleep: { timeoutNow += max($0, 5) }
        ))
        XCTAssertThrowsError(try timedOut.run()) { error in
            XCTAssertEqual(error as? StableUpdateRecoveryError, .healthVerificationFailed)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: timeoutPaths.legacyProtocolOne.installedApplication.path))
        XCTAssertEqual(try recoveryMarker(timeoutPaths.legacyProtocolOne.rollbackApplication), "old")
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
            revertRestored: { _ in effects += 1 },
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
            revertRestored: { _ in },
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
                    revertRestored: { _ in },
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

    func testPublicNonDoctorCommandsRoundTripWithoutInternalMetadata() throws {
        for command in ControlCommand.allCases where
            command != .doctor && command != .prepareUpdate && command != .resumeUpdate {
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
        XCTAssertThrowsError(
            try ControlSocketProtocol.encode(
                ControlRequest(command: .prepareUpdate),
                maximumFrameBytes: 4_096
            )
        )
        XCTAssertThrowsError(
            try ControlSocketProtocol.encode(
                ControlRequest(command: .resumeUpdate, releaseStateGeneration: -1),
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

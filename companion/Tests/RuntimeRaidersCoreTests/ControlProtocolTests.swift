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

        XCTAssertEqual(calls.count, 2)
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
        var log: [String] = []
        let recovery = StableUpdateRecovery(operations: StableUpdateRecoveryOperations(
            verifyBundles: { log.append("verify") },
            persistDisabled: { log.append("disable") },
            bootout: { log.append("bootout") },
            proveStopped: {
                log.append("proof")
                return true
            },
            restore: { log.append("restore") },
            bootstrap: { log.append("bootstrap") },
            verifyDisabledHealth: {
                log.append("health")
                return true
            }
        ))

        try recovery.run()

        XCTAssertEqual(log, [
            "verify", "disable", "bootout", "proof", "verify", "restore",
            "bootstrap", "health",
        ])
    }

    func testStableRecoveryTreatsBootoutResponseLossConservativelyAndGatesRestoreOnProof() throws {
        var restoredAfterResponseLoss = false
        let responseLost = StableUpdateRecovery(operations: StableUpdateRecoveryOperations(
            verifyBundles: {},
            persistDisabled: {},
            bootout: { throw POSIXError(.EIO) },
            proveStopped: { true },
            restore: { restoredAfterResponseLoss = true },
            bootstrap: {},
            verifyDisabledHealth: { true }
        ))
        try responseLost.run()
        XCTAssertTrue(restoredAfterResponseLoss)

        var restoredWithoutProof = false
        let notProven = StableUpdateRecovery(operations: StableUpdateRecoveryOperations(
            verifyBundles: {},
            persistDisabled: {},
            bootout: {},
            proveStopped: { false },
            restore: { restoredWithoutProof = true },
            bootstrap: {},
            verifyDisabledHealth: { true }
        ))
        XCTAssertThrowsError(try notProven.run()) { error in
            XCTAssertEqual(error as? StableUpdateRecoveryError, .daemonNotProvenStopped)
        }
        XCTAssertFalse(restoredWithoutProof)
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
}

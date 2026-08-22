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
            "Runtime Raiders.app",
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
        for action in [
            ManagedAgentAction.register,
            .unregister,
            .status,
        ] {
            XCTAssertEqual(
                CompanionCommandRouter.route(
                    arguments: ["__runtime-raiders-managed-agent", action.rawValue],
                    executableURL: stableExecutable,
                    paths: paths
                ),
                .managedAgent(action)
            )
            XCTAssertNil(CompanionCommandRouter.route(
                arguments: ["__runtime-raiders-managed-agent", action.rawValue],
                executableURL: otherExecutable,
                paths: paths
            ))
        }
        for arguments in [
            ["__runtime-raiders-managed-agent"],
            ["__runtime-raiders-managed-agent", "unknown"],
            ["__runtime-raiders-managed-agent", "status", "extra"],
        ] {
            XCTAssertNil(CompanionCommandRouter.route(
                arguments: arguments,
                executableURL: stableExecutable,
                paths: paths
            ))
        }
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

        let retiredPrepare = ["prepare", "update"].joined(separator: "_")
        let retiredResume = ["resume", "update"].joined(separator: "_")
        for arguments in [
            [retiredPrepare],
            [retiredResume],
            ["__self-check"],
            ["__runtime-raiders-register-application"],
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
        XCTAssertNil(object["installedReleaseSequence"])
        XCTAssertNil(object["preparedForUpdate"])
        XCTAssertNil(object["preparedReleaseStateGeneration"])
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
        let retiredPrepare = ["prepare", "update"].joined(separator: "_")
        let retiredResume = ["resume", "update"].joined(separator: "_")
        let invalidFrames: [Data] = [
            Data("status\n".utf8),
            Data(#"{"command":"doctor"}"#.utf8) + Data([0x0A]),
            Data(#"{"command":"status","claude_otel_environment_present":false}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":"true"}"#.utf8)
                + Data([0x0A]),
            Data(#"{"command":"doctor","claude_otel_environment_present":false,"extra":true}"#.utf8)
                + Data([0x0A]),
            Data("{\"command\":\"\(retiredPrepare)\"}".utf8) + Data([0x0A]),
            Data("{\"command\":\"\(retiredResume)\"}".utf8) + Data([0x0A]),
            Data("{\"command\":\"\(retiredPrepare)\",\"release_state_generation\":0}".utf8)
                + Data([0x0A]),
            Data("{\"command\":\"\(retiredResume)\",\"release_state_generation\":9007199254740992}".utf8)
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

    func testDoctorWaitsLongerThanItsBoundedServerHealthProbe() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-slow-doctor-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let server = ControlSocketServer(socketURL: socketURL)
        try server.startRequests { request in
            XCTAssertEqual(request.command, .doctor)
            Thread.sleep(forTimeInterval: 2.25)
            return ControlResponse(ok: true, message: "server health unavailable")
        }
        defer { server.stop() }

        let response = try ControlSocketClient.send(
            request: ControlRequest(command: .doctor, claudeOTelEnvironmentPresent: false),
            to: socketURL
        )

        XCTAssertEqual(
            response,
            ControlResponse(ok: true, message: "server health unavailable")
        )
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
    }

    func testOnCrossesInitialTimeoutThroughSerializedReadinessBarrier() throws {
        let parent = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-slow-on-control-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let socketURL = parent.appendingPathComponent("agent.sock")
        let commands = ControlActionLog()
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
        let commands = ControlActionLog()
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
        let commands = ControlActionLog()
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

private final class ControlActionLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] { lock.withLock { storage } }

    func append(_ value: String) {
        lock.withLock { storage.append(value) }
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

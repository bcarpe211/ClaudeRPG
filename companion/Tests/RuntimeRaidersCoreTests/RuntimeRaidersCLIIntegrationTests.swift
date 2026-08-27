import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class RuntimeRaidersCLIIntegrationTests: XCTestCase {
    func testActualVersionOnlyAppRunsStatusUpdateAndRuntimeInputVersionLoad() throws {
        try withActualVersionOnlyApp { fixture in
            let before = try treeFingerprint(fixture.paths.supportDirectory)
            let pretty = try runCLI(fixture, arguments: ["status"])
            XCTAssertEqual(pretty.exitStatus, 0, pretty.stderr)
            XCTAssertTrue(pretty.stdout.hasPrefix("Runtime Raiders\nCollection: OFF\n"))
            XCTAssertFalse(pretty.stdout.contains("\u{001B}["))

            let json = try runCLI(fixture, arguments: ["status", "--json"])
            XCTAssertEqual(json.exitStatus, 0, json.stderr)
            XCTAssertEqual(
                JSONSerialization.isValidJSONObject(
                    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.stdout.utf8)))
                ),
                true
            )
            XCTAssertTrue(json.stdout.contains(#""installedCompanionVersion":"1.2.3""#))

            let help = try runCLI(fixture, arguments: ["help"])
            XCTAssertEqual(help.exitStatus, 0, help.stderr)
            XCTAssertEqual(help.stdout, "Usage: raiders <command>\n\nCommands:\n  on                       Turn collection on\n  off                      Turn collection off\n  status                   Show collection and agent status\n  status --json            Show machine-readable status\n  doctor                   Run content-free health checks\n  update                   Check for a companion update\n  re-enroll                Change this device's Raider enrollment\n  uninstall                Remove the app and preserve local state\n  uninstall --everything   Revoke and remove all local Runtime Raiders data\n  help                     Show this help\n")

            let update = try runCLI(fixture, arguments: ["update"])
            XCTAssertEqual(update.exitStatus, 0, update.stderr)
            XCTAssertEqual(update.stdout, "Runtime Raiders 1.2.3 is current.\n")

            let runtimeInputs = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"]
            )
            XCTAssertEqual(runtimeInputs.exitStatus, 0, runtimeInputs.stderr)
            XCTAssertEqual(runtimeInputs.stdout, "1.2.3\n")

            let registration = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-managed-agent", "register"]
            )
            XCTAssertEqual(registration.exitStatus, 0, registration.stderr)
            XCTAssertEqual(registration.stdout, "enabled\n")
            let managedStatus = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-managed-agent", "status"]
            )
            XCTAssertEqual(managedStatus.exitStatus, 0, managedStatus.stderr)
            XCTAssertEqual(managedStatus.stdout, "enabled\n")
            let unregistration = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-managed-agent", "unregister"]
            )
            XCTAssertEqual(unregistration.exitStatus, 0, unregistration.stderr)
            XCTAssertEqual(unregistration.stdout, "not-registered\n")
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)

            let ungated = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                includeVerificationGate: false
            )
            XCTAssertNotEqual(ungated.exitStatus, 0)

            for action in ["register", "status", "unregister"] {
                let ungatedManagedAgent = try runCLI(
                    fixture,
                    arguments: ["__runtime-raiders-managed-agent", action],
                    includeVerificationGate: false
                )
                XCTAssertNotEqual(ungatedManagedAgent.exitStatus, 0)
            }
        }
    }

    func testVerificationModeRejectsNormalRoutesBeforeSocketOrStateBehavior() throws {
        try withActualVersionOnlyApp { fixture in
            let recorder = RequestRecorder()
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.startRequests { request in
                recorder.record(request.command)
                return ControlResponse(ok: true, message: "verification reached socket")
            }
            defer { server.stop() }
            let before = try treeFingerprint(fixture.paths.supportDirectory)

            for arguments in [
                ["on"], ["off"], ["doctor"], ["uninstall"], ["unknown"], [],
            ] {
                let result = try runCLI(fixture, arguments: arguments)
                XCTAssertNotEqual(result.exitStatus, 0, "accepted \(arguments)")
                XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
            }

            XCTAssertEqual(recorder.commands, [])
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)

            let status = try runCLI(fixture, arguments: ["status"])
            XCTAssertEqual(status.exitStatus, 0, status.stderr)
            XCTAssertTrue(status.stdout.hasPrefix("Runtime Raiders\nCollection: OFF\n"))
            XCTAssertEqual(recorder.commands, [])
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)
        }
    }

    func testControlCommandsRenderOnlyApprovedDaemonStates() throws {
        try withActualVersionOnlyApp { fixture in
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.start { command in
                switch command {
                case .on:
                    return ControlResponse(ok: true, message: "preparing")
                case .off:
                    return ControlResponse(ok: true, message: "disabled")
                default:
                    return ControlResponse(ok: false, message: "unexpected command")
                }
            }
            defer { server.stop() }

            let on = try runCLI(
                fixture,
                arguments: ["on"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )
            XCTAssertEqual(on.exitStatus, 0, on.stderr)
            XCTAssertEqual(
                on.stdout,
                "Runtime Raiders collection is ON\nStatus: Preparing safely in the background.\n"
            )
            XCTAssertFalse(on.stdout.contains("\u{001B}["))

            let off = try runCLI(
                fixture,
                arguments: ["off"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )
            XCTAssertEqual(off.exitStatus, 0, off.stderr)
            XCTAssertEqual(off.stdout, "Runtime Raiders collection is OFF\n")
        }
    }

    func testControlStatusRejectsMalformedDaemonSuccessResponse() throws {
        try withActualVersionOnlyApp { fixture in
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.start { command in
                XCTAssertEqual(command, .status)
                return ControlResponse(ok: true, message: "not a status document")
            }
            defer { server.stop() }

            let result = try runCLI(
                fixture,
                arguments: ["status", "--json"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(
                result.stderr.contains("Runtime Raiders status response was invalid."),
                result.stderr
            )
        }
    }

    func testControlStatusDecodesDaemonJSONAndPreservesMachineReadableWireOutput() throws {
        try withActualVersionOnlyApp { fixture in
            let status = AgentStatus(
                enabled: true,
                activationState: .ready,
                daemonRunning: true,
                persistedState: .enabled,
                serverEnabledSurfaces: [.codexDesktop],
                compiledAdapters: [.codexDesktop: .available],
                queuedEventCount: 3,
                lastSuccessfulUploadMS: nil,
                activeRunCount: 1,
                installedCompanionVersion: "1.2.3",
                availableCompanionVersion: nil,
                updateCommand: nil
            )
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.start { command in
                XCTAssertEqual(command, .status)
                return ControlResponse(ok: true, message: status.description)
            }
            defer { server.stop() }

            let pretty = try runCLI(
                fixture,
                arguments: ["status"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )
            XCTAssertEqual(pretty.exitStatus, 0, pretty.stderr)
            XCTAssertTrue(pretty.stdout.hasPrefix("Runtime Raiders\nCollection: ON\n"))
            XCTAssertFalse(pretty.stdout.contains("\u{001B}["))

            let json = try runCLI(
                fixture,
                arguments: ["status", "--json"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )
            XCTAssertEqual(json.exitStatus, 0, json.stderr)
            XCTAssertEqual(json.stdout, status.description + "\n")
            XCTAssertTrue(json.stdout.contains(#""lastSuccessfulUploadMS":null"#))
        }
    }

    func testDaemonUnavailableStatusUsesTheSelectedLocalOutputFormat() throws {
        try withActualVersionOnlyApp { fixture in
            let pretty = try runCLI(
                fixture,
                arguments: ["status"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )
            XCTAssertEqual(pretty.exitStatus, 0, pretty.stderr)
            XCTAssertTrue(pretty.stdout.hasPrefix("Runtime Raiders\nCollection: OFF\n"))
            XCTAssertFalse(pretty.stdout.contains("\u{001B}["))

            let json = try runCLI(
                fixture,
                arguments: ["status", "--json"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )
            XCTAssertEqual(json.exitStatus, 0, json.stderr)
            XCTAssertEqual(
                JSONSerialization.isValidJSONObject(
                    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.stdout.utf8)))
                ),
                true
            )
            XCTAssertTrue(json.stdout.contains(#""lastSuccessfulUploadMS":null"#))
        }
    }

    func testControlOnRendersReadyDaemonState() throws {
        try withActualVersionOnlyApp { fixture in
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.start { command in
                XCTAssertEqual(command, .on)
                return ControlResponse(ok: true, message: "ready")
            }
            defer { server.stop() }

            let result = try runCLI(
                fixture,
                arguments: ["on"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )

            XCTAssertEqual(result.exitStatus, 0, result.stderr)
            XCTAssertEqual(result.stdout, "Runtime Raiders collection is ON\nStatus: Ready.\n")
        }
    }

    func testTimedOutControlOnRendersRecoveredPreparingStateThroughActualExecutable() throws {
        try withActualVersionOnlyApp { fixture in
            let status = AgentStatus(
                enabled: true,
                activationState: .preparing,
                daemonRunning: true,
                persistedState: .enabled,
                serverEnabledSurfaces: [.codexDesktop, .codexCLI],
                compiledAdapters: [.codexDesktop: .available, .codexCLI: .available],
                queuedEventCount: 0,
                lastSuccessfulUploadMS: nil,
                activeRunCount: 0,
                installedCompanionVersion: "1.2.3",
                availableCompanionVersion: nil,
                updateCommand: nil
            )
            let commands = RequestRecorder()
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.start { command in
                commands.record(command)
                switch command {
                case .on:
                    Thread.sleep(forTimeInterval: 30.25)
                    return ControlResponse(ok: true, message: "enabled")
                case .status:
                    return ControlResponse(ok: true, message: status.description)
                default:
                    return ControlResponse(ok: false, message: "unexpected command")
                }
            }
            defer { server.stop() }

            let result = try runCLI(
                fixture,
                arguments: ["on"],
                includeVerificationGate: false,
                includeSupportOverride: false,
                completionTimeout: .seconds(40)
            )

            XCTAssertEqual(result.exitStatus, 0, result.stderr)
            XCTAssertEqual(
                result.stdout,
                "Runtime Raiders collection is ON\nStatus: Preparing safely in the background.\n"
            )
            XCTAssertEqual(commands.commands, [.on, .status])
        }
    }

    func testControlCommandsRejectUnexpectedSuccessfulDaemonMessages() throws {
        try withActualVersionOnlyApp { fixture in
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.start { command in
                switch command {
                case .on:
                    return ControlResponse(ok: true, message: "enabled")
                case .off:
                    return ControlResponse(ok: true, message: "off")
                default:
                    return ControlResponse(ok: false, message: "unexpected command")
                }
            }
            defer { server.stop() }

            for arguments in [["on"], ["off"]] {
                let result = try runCLI(
                    fixture,
                    arguments: arguments,
                    includeVerificationGate: false,
                    includeSupportOverride: false
                )
                XCTAssertNotEqual(result.exitStatus, 0, "accepted \(arguments)")
                XCTAssertTrue(
                    result.stderr.contains("Runtime Raiders control response was invalid."),
                    result.stderr
                )
            }
        }
    }

    func testInvalidPublicArgumentsPrintExactCurrentUsage() throws {
        try withActualVersionOnlyApp { fixture in
            let result = try runCLI(
                fixture,
                arguments: ["status", "--json", "extra"],
                includeVerificationGate: false,
                includeSupportOverride: false
            )

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertEqual(result.stdout, "")
            XCTAssertEqual(
                result.stderr,
                "usage: raiders on|off|status|status --json|doctor|re-enroll|uninstall|uninstall --everything|update|help\n"
            )
        }
    }

    func testNonTTYLifecycleRequestsFailBeforeDaemonStateServiceQueueOrNetworkOperations() throws {
        try withActualVersionOnlyApp { fixture in
            let recorder = RequestRecorder()
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.startRequests { request in
                recorder.record(request.command)
                return ControlResponse(ok: true, message: "unexpected lifecycle request")
            }
            defer { server.stop() }
            let before = try treeFingerprint(fixture.paths.supportDirectory)

            for (arguments, scenario) in [
                (["re-enroll"], "re-enroll-completed-empty"),
                (["uninstall", "--everything"], "uninstall-everything-completed-queued"),
            ] {
                try removeLifecycleCaptures(fixture)
                let result = try runCLI(
                    fixture,
                    arguments: arguments,
                    lifecycleScenario: scenario
                )

                XCTAssertNotEqual(result.exitStatus, 0, "accepted \(arguments)")
                XCTAssertEqual(result.stdout, "")
                XCTAssertEqual(
                    result.stderr,
                    "Runtime Raiders lifecycle commands require an interactive terminal.\n" +
                    "Next: run the command again from an interactive terminal.\n"
                )
                XCTAssertEqual(
                    try treeFingerprint(fixture.paths.supportDirectory),
                    before,
                    "mutated state for \(arguments)"
                )
                XCTAssertEqual(recorder.commands, [])
                XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleActions(fixture).path))
                XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
                XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleJournal(fixture).path))
            }
        }
    }

    func testReEnrollmentExecutableUsesRealLifecycleLockExclusion() throws {
        try withActualVersionOnlyApp { fixture in
            let lifecycle = try lifecyclePaths(fixture)
            let heldLock = try LifecycleLock.acquireLifecycleVerification(
                at: lifecycle.lifecycleLock
            )
            defer { _ = heldLock }
            let enrollmentBefore = try Data(contentsOf: lifecycle.enrollment)
            let outboxBefore = try treeFingerprint(lifecycle.agent.outboxDirectory)
            let process = try startPTYCLI(
                fixture,
                arguments: ["re-enroll"],
                lifecycleScenario: "re-enroll-completed-empty"
            )

            let result = try process.wait(timeoutIterations: 100)

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertEqual(
                result.stderr,
                "Runtime Raiders lifecycle operation could not be completed safely.\n" +
                "Next: run raiders status, then retry the lifecycle command.\n"
            )
            XCTAssertEqual(try Data(contentsOf: lifecycle.enrollment), enrollmentBefore)
            XCTAssertEqual(try treeFingerprint(lifecycle.agent.outboxDirectory), outboxBefore)
            XCTAssertNil(try RecoveryJournalStore(paths: lifecycle).load())
            let actions = try lifecycleActionLines(fixture)
            XCTAssertFalse(actions.contains { $0.hasPrefix("service:") })
            XCTAssertFalse(actions.contains { $0.hasPrefix("network:") })
        }
    }

    func testOrdinaryUninstallRemainsNoninteractiveAndReportsPreservedState() throws {
        try withActualVersionOnlyApp { fixture in
            let lifecycle = try lifecyclePaths(fixture)
            let enrollmentBefore = try Data(contentsOf: lifecycle.enrollment)
            let collectorBefore = try Data(
                contentsOf: lifecycle.agent.stateDirectory.appendingPathComponent(
                    "collector-state.json"
                )
            )
            let outboxBefore = try treeFingerprint(lifecycle.agent.outboxDirectory)
            let outsideBefore = try Data(contentsOf: fixture.versionResponse)
            let result = try runCLI(
                fixture,
                arguments: ["uninstall"],
                lifecycleScenario: "uninstall-preserve-completed"
            )

            XCTAssertEqual(result.exitStatus, 0, result.contentFreeDiagnostics)
            XCTAssertEqual(
                result.stdout,
                "Runtime Raiders was removed.\n" +
                "Preserved: enrollment, collector state, queued events, and recovery state.\n" +
                "Browser login does not change the preserved enrollment.\n" +
                "Raider, account, Runs, scores, rewards, and history were preserved.\n" +
                "Next: reinstall Runtime Raiders to restore the companion; collection will remain OFF.\n"
            )
            XCTAssertEqual(result.stderr, "")
            XCTAssertFalse(
                FileManager.default.fileExists(atPath: lifecycle.agent.agentApplication.path)
            )
            XCTAssertEqual(try Data(contentsOf: lifecycle.enrollment), enrollmentBefore)
            XCTAssertEqual(
                try Data(
                    contentsOf: lifecycle.agent.stateDirectory.appendingPathComponent(
                        "collector-state.json"
                    )
                ),
                collectorBefore
            )
            XCTAssertEqual(try treeFingerprint(lifecycle.agent.outboxDirectory), outboxBefore)
            XCTAssertEqual(try Data(contentsOf: fixture.versionResponse), outsideBefore)
            try assertLifecycleOutputIsContentFree(result.stdout + result.stderr, fixture: fixture)
            try assertOrderedLifecycleActions(
                [
                    "collection:persist-off",
                    "control:uninstall",
                    "service:status:enabled",
                    "service:unregister",
                    "service:status:not-registered",
                ],
                in: fixture
            )
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
        }
    }

    func testReEnrollmentPTYSuccessKeepsCodePrivateAndRedactsCapturedArtifacts() throws {
        try withActualVersionOnlyApp { fixture in
            let code = syntheticEnrollmentCode()
            XCTAssertEqual(code.utf8.count, 43)
            let lifecycle = try lifecyclePaths(fixture)
            let oldEnrollment = try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment)
            let journalStore = try RecoveryJournalStore(paths: lifecycle)
            let process = try startPTYCLI(
                fixture,
                arguments: ["re-enroll"],
                lifecycleScenario: "re-enroll-completed-empty"
            )
            try process.waitForPrompt("Type RE-ENROLL to continue: ")
            XCTAssertFalse(process.arguments.contains(code))
            try process.sendLine("RE-ENROLL")
            try process.waitForPrompt("Enrollment code: ")
            XCTAssertFalse(process.terminalTranscript.contains(code))
            let pending = try XCTUnwrap(journalStore.load())
            XCTAssertEqual(pending.phase, .replacementPrepared)
            try process.sendLine(code)

            let result = try process.wait()
            XCTAssertEqual(result.exitStatus, 0, result.contentFreeDiagnostics)
            XCTAssertEqual(
                result.stdout,
                reEnrollmentSummary(queueCount: 0) +
                "Runtime Raiders re-enrollment succeeded.\n" +
                "Collection remains OFF.\n" +
                "History was not transferred; Runs, scores, and rewards remain with their original Raider.\n" +
                "Next: run raiders status, then deliberately run raiders on.\n"
            )
            XCTAssertEqual(result.stderr, "")
            XCTAssertFalse(process.terminalTranscript.contains(code))
            XCTAssertFalse(result.stdout.contains(code))
            XCTAssertFalse(result.stderr.contains(code))
            XCTAssertFalse(result.contentFreeDiagnostics.contains(code))
            XCTAssertNil(try journalStore.load())
            let installed = try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment)
            XCTAssertNotEqual(installed, oldEnrollment)
            XCTAssertEqual(
                try AgentController.persistedCollectorState(
                    paths: lifecycle.agent,
                    surfaces: installed.enabledSurfaces
                ),
                .disabled
            )
            XCTAssertEqual(
                try Outbox.queuedCount(inExistingDirectory: lifecycle.agent.outboxDirectory),
                0
            )
            let requestCapture = String(
                decoding: try Data(contentsOf: lifecycleRequest(fixture)),
                as: UTF8.self
            )
            XCTAssertTrue(requestCapture.contains(#""path":"/api/raiders/re-enroll""#))
            XCTAssertTrue(requestCapture.contains(#""method":"POST""#))
            XCTAssertTrue(requestCapture.contains(#""contract":"exact""#))
            XCTAssertTrue(requestCapture.contains("[REDACTED]"))
            XCTAssertFalse(requestCapture.contains(code))
            try assertOrderedLifecycleActions(
                [
                    "control:uninstall",
                    "service:status:enabled",
                    "service:unregister",
                    "service:status:not-registered",
                    "network:request:/api/raiders/re-enroll",
                    "service:register",
                    "service:status:enabled",
                ],
                in: fixture
            )
            try assertLifecycleOutputIsContentFree(
                result.stdout + result.stderr + process.terminalTranscript,
                fixture: fixture,
                additionalSecrets: [code, pending.replacementDeviceToken]
            )
        }
    }

    func testReEnrollmentPTYMalformedCodeRestoresOldStateAndRemovesJournalBeforeRequest() throws {
        try withActualVersionOnlyApp { fixture in
            let malformedCode = "private-\(UUID().uuidString)"
            XCTAssertEqual(malformedCode.utf8.count, 44)
            let lifecycle = try lifecyclePaths(fixture)
            let oldEnrollment = try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment)
            let oldCollector = try Data(
                contentsOf: lifecycle.agent.stateDirectory.appendingPathComponent(
                    "collector-state.json"
                )
            )
            let oldOutbox = try treeFingerprint(lifecycle.agent.outboxDirectory)
            let journalStore = try RecoveryJournalStore(paths: lifecycle)
            let process = try startPTYCLI(
                fixture,
                arguments: ["re-enroll"],
                lifecycleScenario: "re-enroll-completed-empty"
            )
            try process.waitForPrompt("Type RE-ENROLL to continue: ")
            try process.sendLine("RE-ENROLL")
            try process.waitForPrompt("Enrollment code: ")
            let pending = try XCTUnwrap(journalStore.load())
            XCTAssertEqual(pending.phase, .replacementPrepared)
            try process.sendLine(malformedCode)

            let result = try process.wait()
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertEqual(
                result.stderr,
                "The enrollment code was not accepted. Collection remains OFF.\n" +
                "Next: create a fresh code and run raiders re-enroll again.\n"
            )
            XCTAssertNil(try journalStore.load())
            XCTAssertEqual(
                try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment),
                oldEnrollment
            )
            XCTAssertEqual(
                try Data(
                    contentsOf: lifecycle.agent.stateDirectory.appendingPathComponent(
                        "collector-state.json"
                    )
                ),
                oldCollector
            )
            XCTAssertEqual(try treeFingerprint(lifecycle.agent.outboxDirectory), oldOutbox)
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
            try assertOrderedLifecycleActions(
                [
                    "service:status:enabled",
                    "service:unregister",
                    "service:status:not-registered",
                    "service:register",
                    "service:status:enabled",
                ],
                in: fixture
            )
            XCTAssertFalse(
                try lifecycleActionLines(fixture).contains {
                    $0.hasPrefix("network:request:")
                }
            )
            try assertLifecycleOutputIsContentFree(
                result.stdout + result.stderr + process.terminalTranscript,
                fixture: fixture,
                additionalSecrets: [malformedCode, pending.replacementDeviceToken]
            )
        }
    }

    func testReEnrollmentPTYAcceptsOnlyDeliverDiscardOrCancelAndRequiresExactDiscard() throws {
        for disposition in ["deliver", "discard", "cancel"] {
            try withActualVersionOnlyApp { fixture in
                let code = syntheticEnrollmentCode()
                let lifecycle = try lifecyclePaths(fixture)
                let oldEnrollment = try EnrollmentConfiguration.loadExisting(
                    from: lifecycle.enrollment
                )
                let process = try startPTYCLI(
                    fixture,
                    arguments: ["re-enroll"],
                    lifecycleScenario: "re-enroll-completed-queued"
                )
                XCTAssertEqual(
                    try Outbox.queuedCount(inExistingDirectory: lifecycle.agent.outboxDirectory),
                    2
                )
                try process.waitForPrompt("Type RE-ENROLL to continue: ")
                try process.sendLine("RE-ENROLL")
                try process.waitForPrompt("Choose deliver, discard, or cancel: ")
                try process.sendLine(disposition)
                if disposition == "discard" {
                    try process.waitForPrompt("Type DISCARD to discard 2 queued events: ")
                    try process.sendLine("DISCARD")
                }
                if disposition != "cancel" {
                    try process.waitForPrompt("Enrollment code: ")
                    try process.sendLine(code)
                }

                let result = try process.wait()
                XCTAssertEqual(result.exitStatus, 0, result.contentFreeDiagnostics)
                if disposition == "cancel" {
                    XCTAssertEqual(
                        result.stdout,
                        reEnrollmentSummary(queueCount: 2) +
                        "Runtime Raiders re-enrollment was cancelled.\n" +
                        "Collection remains OFF; enrollment and queued events were unchanged.\n" +
                        "Next: run raiders status.\n"
                    )
                    XCTAssertFalse(process.terminalTranscript.contains("Enrollment code: "))
                    XCTAssertEqual(
                        try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment),
                        oldEnrollment
                    )
                    XCTAssertEqual(
                        try Outbox.queuedCount(
                            inExistingDirectory: lifecycle.agent.outboxDirectory
                        ),
                        2
                    )
                } else {
                    XCTAssertTrue(result.stdout.hasSuffix(
                        "Runtime Raiders re-enrollment succeeded.\n" +
                        "Collection remains OFF.\n" +
                        "History was not transferred; Runs, scores, and rewards remain with their original Raider.\n" +
                        "Next: run raiders status, then deliberately run raiders on.\n"
                    ))
                    XCTAssertNotEqual(
                        try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment),
                        oldEnrollment
                    )
                    XCTAssertEqual(
                        try Outbox.queuedCount(
                            inExistingDirectory: lifecycle.agent.outboxDirectory
                        ),
                        0
                    )
                    if disposition == "deliver" {
                        let capture = String(
                            decoding: try Data(contentsOf: lifecycleRequest(fixture)),
                            as: UTF8.self
                        )
                        XCTAssertTrue(capture.contains(#""path":"/api/runs/events""#))
                        XCTAssertTrue(capture.contains(#""contract":"exact""#))
                    }
                }
                XCTAssertFalse(
                    FileManager.default.fileExists(atPath: lifecycle.recoveryJournal.path)
                )
                XCTAssertTrue(try lifecycleActionLines(fixture).contains("queue:\(disposition)"))
                try assertLifecycleOutputIsContentFree(
                    result.stdout + result.stderr + process.terminalTranscript,
                    fixture: fixture,
                    additionalSecrets: [code]
                )
            }
        }
    }

    func testLifecyclePTYMisspellingsFailClosedWithoutRequestOrDestructiveAction() throws {
        let cases: [(scenario: String, arguments: [String], steps: [(String, String)])] = [
            ("re-enroll-completed-empty", ["re-enroll"], [("Type RE-ENROLL to continue: ", "RE_ENROLL")]),
            ("re-enroll-completed-queued", ["re-enroll"], [
                ("Type RE-ENROLL to continue: ", "RE-ENROLL"),
                ("Choose deliver, discard, or cancel: ", "Deliver"),
            ]),
            ("re-enroll-completed-queued", ["re-enroll"], [
                ("Type RE-ENROLL to continue: ", "RE-ENROLL"),
                ("Choose deliver, discard, or cancel: ", "discard"),
                ("Type DISCARD to discard 2 queued events: ", "discard"),
            ]),
            ("uninstall-everything-completed-empty", ["uninstall", "--everything"], [
                ("Type UNINSTALL EVERYTHING to continue: ", "UNINSTALL ALL"),
            ]),
            ("uninstall-everything-completed-queued", ["uninstall", "--everything"], [
                ("Type DISCARD to discard 2 queued events: ", "discard"),
            ]),
        ]

        for item in cases {
            try withActualVersionOnlyApp { fixture in
                let process = try startPTYCLI(
                    fixture,
                    arguments: item.arguments,
                    lifecycleScenario: item.scenario
                )
                for (prompt, input) in item.steps {
                    try process.waitForPrompt(prompt)
                    try process.sendLine(input)
                }
                let result = try process.wait()
                XCTAssertNotEqual(result.exitStatus, 0)
                XCTAssertEqual(
                    result.stderr,
                    "Lifecycle confirmation was not exact. No lifecycle change was authorized.\n" +
                    "Next: review the prompt and run the command again.\n"
                )
                XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
                XCTAssertFalse(try lifecycleActionLines(fixture).contains("remove:everything"))
                try assertLifecycleOutputIsContentFree(
                    result.stdout + result.stderr + process.terminalTranscript,
                    fixture: fixture
                )
            }
        }
    }

    func testCompleteRemovalPTYRequiresBothExactConfirmationsAndReportsRemovedCategories() throws {
        try withActualVersionOnlyApp { fixture in
            let outsideBefore = try Data(contentsOf: fixture.versionResponse)
            let process = try startPTYCLI(
                fixture,
                arguments: ["uninstall", "--everything"],
                lifecycleScenario: "uninstall-everything-completed-queued"
            )
            try process.waitForPrompt("Type DISCARD to discard 2 queued events: ")
            try process.sendLine("DISCARD")
            try process.waitForPrompt("Type UNINSTALL EVERYTHING to continue: ")
            try process.sendLine("UNINSTALL EVERYTHING")

            let result = try process.wait()
            XCTAssertEqual(result.exitStatus, 0, result.contentFreeDiagnostics)
            XCTAssertEqual(
                result.stdout,
                completeRemovalSummary(queueCount: 2) +
                "Runtime Raiders was removed and this device enrollment was revoked.\n" +
                "Removed: app, background agent, command, enrollment, collector state, queued events, and recovery state.\n" +
                "Raider, account, Runs, scores, rewards, and history were preserved.\n" +
                "Next: reinstall Runtime Raiders if you want to enroll this device again.\n"
            )
            XCTAssertEqual(result.stderr, "")
            XCTAssertFalse(
                FileManager.default.fileExists(atPath: fixture.paths.supportDirectory.path)
            )
            XCTAssertEqual(try Data(contentsOf: fixture.versionResponse), outsideBefore)
            let requestCapture = String(
                decoding: try Data(contentsOf: lifecycleRequest(fixture)),
                as: UTF8.self
            )
            XCTAssertTrue(
                requestCapture.contains(#""path":"/api/raiders/devices/revoke-current""#)
            )
            XCTAssertTrue(requestCapture.contains(#""method":"POST""#))
            XCTAssertTrue(requestCapture.contains(#""contract":"exact""#))
            XCTAssertTrue(requestCapture.contains("[REDACTED]"))
            try assertOrderedLifecycleActions(
                [
                    "collection:persist-off",
                    "control:uninstall",
                    "service:status:enabled",
                    "service:unregister",
                    "service:status:not-registered",
                    "prompt:discard-confirmed",
                    "prompt:everything-confirmed",
                    "network:request:/api/raiders/devices/revoke-current",
                ],
                in: fixture
            )
            try assertLifecycleOutputIsContentFree(
                result.stdout + result.stderr + process.terminalTranscript,
                fixture: fixture
            )
        }
    }

    func testCompleteRemovalPTYOmitsDiscardForEmptyQueue() throws {
        try withActualVersionOnlyApp { fixture in
            let process = try startPTYCLI(
                fixture,
                arguments: ["uninstall", "--everything"],
                lifecycleScenario: "uninstall-everything-completed-empty"
            )
            try process.waitForPrompt("Type UNINSTALL EVERYTHING to continue: ")
            XCTAssertFalse(process.terminalTranscript.contains("Type DISCARD"))
            try process.sendLine("UNINSTALL EVERYTHING")

            let result = try process.wait()
            XCTAssertEqual(result.exitStatus, 0, result.contentFreeDiagnostics)
            XCTAssertFalse(process.terminalTranscript.contains("Type DISCARD"))
            XCTAssertFalse(try lifecycleActionLines(fixture).contains("queue:discard"))
        }
    }

    func testLifecyclePTYEOFFailsClosedAndRestoresEcho() throws {
        try withActualVersionOnlyApp { fixture in
            let process = try startPTYCLI(
                fixture,
                arguments: ["re-enroll"],
                lifecycleScenario: "re-enroll-completed-empty"
            )
            try process.waitForPrompt("Type RE-ENROLL to continue: ")
            XCTAssertFalse(process.echoEnabled)
            try process.sendEOF()

            let result = try process.wait()
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(process.echoEnabled)
            XCTAssertEqual(
                result.stderr,
                "Private lifecycle input ended before confirmation. No lifecycle change was authorized.\n" +
                "Next: run the command again from an interactive terminal.\n"
            )
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
            XCTAssertFalse(try lifecycleActionLines(fixture).contains("network:request"))
        }
    }

    func testLifecyclePTYSignalFailsClosedAndRestoresEcho() throws {
        try withActualVersionOnlyApp { fixture in
            let process = try startPTYCLI(
                fixture,
                arguments: ["re-enroll"],
                lifecycleScenario: "re-enroll-completed-empty"
            )
            try process.waitForPrompt("Type RE-ENROLL to continue: ")
            XCTAssertFalse(process.echoEnabled)
            try process.sendSignal(SIGINT)

            let result = try process.wait()
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(process.echoEnabled)
            XCTAssertEqual(
                result.stderr,
                "Lifecycle input was interrupted. No lifecycle change was authorized.\n" +
                "Next: run the command again from an interactive terminal.\n"
            )
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
            XCTAssertFalse(try lifecycleActionLines(fixture).contains("network:request"))
        }
    }

    func testReEnrollmentCodePromptEOFAndSignalPreserveJournalThenResumeSafely() throws {
        for interruption in ["eof", "signal"] {
            try withActualVersionOnlyApp { fixture in
                let lifecycle = try lifecyclePaths(fixture)
                let oldEnrollment = try EnrollmentConfiguration.loadExisting(
                    from: lifecycle.enrollment
                )
                let outboxBefore = try treeFingerprint(lifecycle.agent.outboxDirectory)
                let journalStore = try RecoveryJournalStore(paths: lifecycle)
                let process = try startPTYCLI(
                    fixture,
                    arguments: ["re-enroll"],
                    lifecycleScenario: "re-enroll-completed-empty"
                )
                try process.waitForPrompt("Type RE-ENROLL to continue: ")
                try process.sendLine("RE-ENROLL")
                try process.waitForPrompt("Enrollment code: ")
                let pending = try XCTUnwrap(journalStore.load())
                XCTAssertEqual(pending.phase, .replacementPrepared)
                XCTAssertFalse(process.echoEnabled)

                if interruption == "eof" {
                    try process.sendEOF()
                } else {
                    try process.sendSignal(SIGINT)
                }
                let interrupted = try process.wait()

                XCTAssertNotEqual(interrupted.exitStatus, 0)
                XCTAssertTrue(process.echoEnabled)
                XCTAssertEqual(
                    interrupted.stderr,
                    "Runtime Raiders needs assisted recovery. Collection remains OFF.\n" +
                    "Next: run raiders re-enroll again; if it still fails, seek assisted recovery.\n"
                )
                XCTAssertEqual(try journalStore.load(), pending)
                XCTAssertEqual(
                    try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment),
                    oldEnrollment
                )
                XCTAssertEqual(
                    try AgentController.persistedCollectorState(
                        paths: lifecycle.agent,
                        surfaces: oldEnrollment.enabledSurfaces
                    ),
                    .disabled
                )
                XCTAssertEqual(try treeFingerprint(lifecycle.agent.outboxDirectory), outboxBefore)
                let actionsAfterInterruption = try lifecycleActionLines(fixture)
                XCTAssertTrue(actionsAfterInterruption.contains("service:unregister"))
                XCTAssertFalse(actionsAfterInterruption.contains("service:register"))
                XCTAssertFalse(
                    actionsAfterInterruption.contains { $0.hasPrefix("network:request:") }
                )

                let resumed = try startPTYCLI(
                    fixture,
                    arguments: ["re-enroll"],
                    lifecycleScenario: "re-enroll-completed-empty"
                )
                let resumedResult = try resumed.wait()

                XCTAssertEqual(resumedResult.exitStatus, 0, resumedResult.contentFreeDiagnostics)
                XCTAssertEqual(
                    resumedResult.stdout,
                    "Runtime Raiders re-enrollment succeeded.\n" +
                    "Collection remains OFF.\n" +
                    "History was not transferred; Runs, scores, and rewards remain with their original Raider.\n" +
                    "Next: run raiders status, then deliberately run raiders on.\n"
                )
                XCTAssertNil(try journalStore.load())
                let installed = try EnrollmentConfiguration.loadExisting(from: lifecycle.enrollment)
                XCTAssertNotEqual(installed, oldEnrollment)
                XCTAssertEqual(
                    try AgentController.persistedCollectorState(
                        paths: lifecycle.agent,
                        surfaces: installed.enabledSurfaces
                    ),
                    .disabled
                )
                XCTAssertEqual(try treeFingerprint(lifecycle.agent.outboxDirectory), outboxBefore)
                try assertLifecycleOutputIsContentFree(
                    interrupted.stdout + interrupted.stderr + process.terminalTranscript +
                        resumedResult.stdout + resumedResult.stderr + resumed.terminalTranscript,
                    fixture: fixture,
                    additionalSecrets: [pending.replacementDeviceToken]
                )
            }
        }
    }

    func testLifecycleFailuresRemainContentFreeAndNameSafeNextActions() throws {
        let validCode = syntheticEnrollmentCode()
        let cases: [(scenario: String, arguments: [String], inputs: [(String, String)], expected: String)] = [
            (
                "re-enroll-collection-on", ["re-enroll"], [],
                "Collection is ON. No enrollment change was made.\nNext: run raiders off, then run raiders re-enroll again.\n"
            ),
            (
                "re-enroll-invalid-enrollment-empty", ["re-enroll"],
                [("Type RE-ENROLL to continue: ", "RE-ENROLL"), ("Enrollment code: ", validCode)],
                "The enrollment code was not accepted. Collection remains OFF.\nNext: create a fresh code and run raiders re-enroll again.\n"
            ),
            (
                "re-enroll-recovery-required-empty", ["re-enroll"],
                [("Type RE-ENROLL to continue: ", "RE-ENROLL"), ("Enrollment code: ", validCode)],
                "Runtime Raiders needs assisted recovery. Collection remains OFF.\nNext: run raiders re-enroll again; if it still fails, seek assisted recovery.\n"
            ),
            (
                "uninstall-everything-revocation-required-empty", ["uninstall", "--everything"],
                [("Type UNINSTALL EVERYTHING to continue: ", "UNINSTALL EVERYTHING")],
                "Device revocation could not be confirmed. No local data was deleted.\nNext: reconnect and run raiders uninstall --everything again.\n"
            ),
            (
                "uninstall-everything-assisted-recovery-empty", ["uninstall", "--everything"],
                [("Type UNINSTALL EVERYTHING to continue: ", "UNINSTALL EVERYTHING")],
                "Local enrollment needs assisted recovery. No local data was deleted.\nNext: seek assisted recovery before removing local state.\n"
            ),
        ]

        for item in cases {
            try withActualVersionOnlyApp { fixture in
                let process = try startPTYCLI(
                    fixture,
                    arguments: item.arguments,
                    lifecycleScenario: item.scenario
                )
                for (prompt, input) in item.inputs {
                    try process.waitForPrompt(prompt)
                    try process.sendLine(input)
                }
                let result = try process.wait()
                XCTAssertNotEqual(result.exitStatus, 0)
                XCTAssertEqual(result.stderr, item.expected)
                try assertLifecycleOutputIsContentFree(
                    result.stdout + result.stderr + process.terminalTranscript,
                    fixture: fixture,
                    additionalSecrets: item.inputs.compactMap { prompt, input in
                        prompt == "Enrollment code: " ? input : nil
                    }
                )
            }
        }
    }

    func testLifecycleSetupFailuresMapToContentFreeErrorWithSafeNextAction() throws {
        let expected =
            "Runtime Raiders lifecycle operation could not be completed safely.\n" +
            "Next: run raiders status, then retry the lifecycle command.\n"
        try withActualVersionOnlyApp { fixture in
            let reEnroll = try startPTYCLI(
                fixture,
                arguments: ["re-enroll"],
                lifecycleScenario: "re-enroll-setup-failure"
            )
            let reEnrollResult = try reEnroll.wait()
            XCTAssertNotEqual(reEnrollResult.exitStatus, 0)
            XCTAssertEqual(reEnrollResult.stderr, expected)
            try assertLifecycleOutputIsContentFree(
                reEnrollResult.stdout + reEnrollResult.stderr + reEnroll.terminalTranscript,
                fixture: fixture
            )
        }
        try withActualVersionOnlyApp { fixture in
            let removal = try runCLI(
                fixture,
                arguments: ["uninstall"],
                lifecycleScenario: "uninstall-setup-failure"
            )
            XCTAssertNotEqual(removal.exitStatus, 0)
            XCTAssertEqual(removal.stderr, expected)
            try assertLifecycleOutputIsContentFree(removal.stdout + removal.stderr, fixture: fixture)
        }
    }

    func testVerificationModeRejectsDaemonBeforeEnrollmentOrRuntimeStartup() throws {
        try withActualVersionOnlyApp { fixture in
            let enrollment = fixture.paths.stateDirectory.appendingPathComponent(
                "enrollment.json",
                isDirectory: false
            )
            try FileManager.default.removeItem(at: enrollment)
            let before = try treeFingerprint(fixture.paths.supportDirectory)

            let result = try runCLI(fixture, arguments: ["daemon"])

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.paths.controlSocket.path))
        }
    }

    func testVerificationRuntimeInputsDoesNotMutateAStateDirectorySwappedAfterValidation() throws {
        try withActualVersionOnlyApp { fixture in
            let swappedState = fixture.paths.supportDirectory.appendingPathComponent(
                "state-swap",
                isDirectory: true
            )
            try FileManager.default.createDirectory(
                at: swappedState,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o755]
            )
            let enrollmentName = "enrollment.json"
            try FileManager.default.copyItem(
                at: fixture.paths.stateDirectory.appendingPathComponent(enrollmentName),
                to: swappedState.appendingPathComponent(enrollmentName)
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: swappedState.appendingPathComponent(enrollmentName).path
            )

            let swappedDescriptor = Darwin.open(
                swappedState.path,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            XCTAssertGreaterThanOrEqual(swappedDescriptor, 0)
            guard swappedDescriptor >= 0 else { return }
            defer { Darwin.close(swappedDescriptor) }
            let originalStateInode = try directoryInode(fixture.paths.stateDirectory)
            let before = try metadataFingerprint(fixture.paths.supportDirectory)
            let racer = DirectorySwapRacer(
                first: fixture.paths.stateDirectory.path,
                second: swappedState.path
            )
            racer.start()
            var mutated = false
            for _ in 0..<128 {
                _ = try runCLI(
                    fixture,
                    arguments: ["__runtime-raiders-verify-runtime-inputs"]
                )
                if try directoryPermissions(swappedDescriptor) == 0o700 {
                    mutated = true
                    break
                }
            }
            XCTAssertTrue(racer.stop(), "directory swap racer did not stop within its bound")
            XCTAssertNil(racer.failure)
            if try directoryInode(fixture.paths.stateDirectory) != originalStateInode {
                try swapDirectories(fixture.paths.stateDirectory.path, swappedState.path)
            }

            XCTAssertFalse(mutated, "verification self-check changed the swapped directory mode")
            XCTAssertEqual(try metadataFingerprint(fixture.paths.supportDirectory), before)
        }
    }

    func testVerificationModeRejectsUpdateWithoutAValidOfflineResponse() throws {
        try withActualVersionOnlyApp { fixture in
            let result = try runCLI(
                fixture,
                arguments: ["update"],
                versionResponsePath: ""
            )

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.paths.updateLock.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.paths.updateState.path))
        }
    }

    func testVerificationSupportPathRejectsNoncanonicalSymlinkedAndLooseDirectories() throws {
        try withActualVersionOnlyApp { fixture in
            let noncanonical = fixture.applicationSupport.path.replacingOccurrences(
                of: "/Library/Application Support",
                with: "/Library/../Library/Application Support"
            )
            var result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                supportOverridePath: noncanonical
            )
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)

            let aliasRoot = URL(
                fileURLWithPath: "/private/tmp/rrv.\(UUID().uuidString.prefix(6))",
                isDirectory: true
            )
            try FileManager.default.createSymbolicLink(
                at: aliasRoot,
                withDestinationURL: fixture.root
            )
            defer { try? FileManager.default.removeItem(at: aliasRoot) }
            result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                supportOverridePath: aliasRoot
                    .appendingPathComponent("Library/Application Support", isDirectory: true)
                    .path
            )
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)

            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: fixture.applicationSupport.path
            )
            defer {
                try? FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: fixture.applicationSupport.path
                )
            }
            result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"]
            )
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
        }
    }

    func testHiddenVerificationRouteIsUnavailableWithoutTheSupportOverride() throws {
        try withActualVersionOnlyApp { fixture in
            let result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                includeVerificationGate: false,
                includeSupportOverride: false,
                versionResponsePath: ""
            )

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
        }
    }

    func testLifecycleVerificationScenarioCannotReachLockSeamWithoutGate() throws {
        try withActualVersionOnlyApp { fixture in
            let lifecycle = try lifecyclePaths(fixture)
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycle.lifecycleLock.path))

            let result = try runCLI(
                fixture,
                arguments: ["re-enroll"],
                includeVerificationGate: false,
                lifecycleScenario: "re-enroll-completed-empty"
            )

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycle.lifecycleLock.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleActions(fixture).path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
            XCTAssertNil(try RecoveryJournalStore(paths: lifecycle).load())
        }
    }

    func testActualCLIRejectsMissingAndWrongVersionOnlyPlists() throws {
        try withActualVersionOnlyApp { fixture in
            for invalid in [
                versionInfo(removing: "CFBundleVersion"),
                versionInfo(replacing: "CFBundleIdentifier", with: "com.example.other"),
                versionInfo(replacing: "CFBundleVersion", with: "1.2.4"),
            ] {
                try writeInfo(invalid, to: fixture.info)
                let result = try runCLI(
                    fixture,
                    arguments: ["__runtime-raiders-verify-runtime-inputs"]
                )
                XCTAssertNotEqual(result.exitStatus, 0, "accepted invalid plist \(invalid)")
            }
        }
    }

    private struct Fixture {
        let root: URL
        let home: URL
        let applicationSupport: URL
        let captureDirectory: URL
        let paths: AgentPaths
        let executable: URL
        let info: URL
        let versionResponse: URL
    }

    private struct ProcessResult {
        let exitStatus: Int32
        let stdout: String
        let stderr: String

        var contentFreeDiagnostics: String {
            "exit=\(exitStatus) stdout-bytes=\(stdout.utf8.count) stderr-bytes=\(stderr.utf8.count)"
        }
    }

    private enum FixtureError: Error {
        case builtExecutableMissing
        case cannotCreateVerificationRoot
        case processTimedOut
    }

    private final class PTYCLIProcess {
        let arguments: [String]
        private(set) var terminalTranscript = ""
        private let processID: pid_t
        private let master: Int32
        private let stdoutRead: Int32
        private let stderrRead: Int32
        private var waited = false

        init(
            executable: URL,
            arguments: [String],
            environment: [String: String]
        ) throws {
            self.arguments = arguments
            var stdoutPipe = [Int32](repeating: -1, count: 2)
            var stderrPipe = [Int32](repeating: -1, count: 2)
            guard Darwin.pipe(&stdoutPipe) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            guard Darwin.pipe(&stderrPipe) == 0 else {
                let saved = errno
                Darwin.close(stdoutPipe[0])
                Darwin.close(stdoutPipe[1])
                throw POSIXError(POSIXErrorCode(rawValue: saved) ?? .EIO)
            }
            var masterDescriptor: Int32 = -1
            let argumentStrings = [executable.path] + arguments
            let environmentStrings = environment.sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }
            let argv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(
                capacity: argumentStrings.count + 1
            )
            argv.initialize(repeating: nil, count: argumentStrings.count + 1)
            let envp = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(
                capacity: environmentStrings.count + 1
            )
            envp.initialize(repeating: nil, count: environmentStrings.count + 1)
            for (index, value) in argumentStrings.enumerated() { argv[index] = strdup(value) }
            for (index, value) in environmentStrings.enumerated() { envp[index] = strdup(value) }
            defer {
                for index in argumentStrings.indices { free(argv[index]) }
                for index in environmentStrings.indices { free(envp[index]) }
                argv.deinitialize(count: argumentStrings.count + 1)
                envp.deinitialize(count: environmentStrings.count + 1)
                argv.deallocate()
                envp.deallocate()
            }
            guard argumentStrings.indices.allSatisfy({ argv[$0] != nil }),
                  environmentStrings.indices.allSatisfy({ envp[$0] != nil }) else {
                Darwin.close(stdoutPipe[0])
                Darwin.close(stdoutPipe[1])
                Darwin.close(stderrPipe[0])
                Darwin.close(stderrPipe[1])
                throw POSIXError(.ENOMEM)
            }
            let executablePath = argv[0]!
            let stdoutReadDescriptor = stdoutPipe[0]
            let stdoutWriteDescriptor = stdoutPipe[1]
            let stderrReadDescriptor = stderrPipe[0]
            let stderrWriteDescriptor = stderrPipe[1]

            let child = forkPseudoTerminal(&masterDescriptor, nil, nil, nil)
            guard child >= 0 else {
                let saved = errno
                for descriptor in stdoutPipe + stderrPipe where descriptor >= 0 {
                    Darwin.close(descriptor)
                }
                throw POSIXError(POSIXErrorCode(rawValue: saved) ?? .EIO)
            }
            if child == 0 {
                Darwin.close(stdoutReadDescriptor)
                Darwin.close(stderrReadDescriptor)
                guard Darwin.dup2(stdoutWriteDescriptor, STDOUT_FILENO) >= 0,
                      Darwin.dup2(stderrWriteDescriptor, STDERR_FILENO) >= 0 else {
                    Darwin._exit(126)
                }
                Darwin.close(stdoutWriteDescriptor)
                Darwin.close(stderrWriteDescriptor)
                _ = Darwin.execve(executablePath, argv, envp)
                Darwin._exit(127)
            }

            processID = child
            master = masterDescriptor
            stdoutRead = stdoutReadDescriptor
            stderrRead = stderrReadDescriptor
            Darwin.close(stdoutWriteDescriptor)
            Darwin.close(stderrWriteDescriptor)
            _ = Darwin.fcntl(master, F_SETFL, Darwin.fcntl(master, F_GETFL) | O_NONBLOCK)
        }

        deinit {
            if !waited {
                Darwin.kill(processID, SIGKILL)
                var status: Int32 = 0
                _ = Darwin.waitpid(processID, &status, 0)
            }
            Darwin.close(master)
            Darwin.close(stdoutRead)
            Darwin.close(stderrRead)
        }

        var echoEnabled: Bool {
            var state = termios()
            return Darwin.tcgetattr(master, &state) == 0 && state.c_lflag & tcflag_t(ECHO) != 0
        }

        func waitForPrompt(_ prompt: String) throws {
            for _ in 0..<300 {
                drainTerminal()
                if terminalTranscript.contains(prompt) { return }
                var status: Int32 = 0
                if Darwin.waitpid(processID, &status, WNOHANG) == processID {
                    waited = true
                    throw POSIXError(.ECHILD)
                }
                Darwin.usleep(10_000)
            }
            throw POSIXError(.ETIMEDOUT)
        }

        func sendLine(_ line: String) throws {
            try writeAll(Data((line + "\n").utf8), to: master)
        }

        func sendEOF() throws {
            try writeAll(Data([0x04]), to: master)
        }

        func sendSignal(_ value: Int32) throws {
            guard Darwin.kill(processID, value) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        }

        func wait(timeoutIterations: Int = 500) throws -> ProcessResult {
            var status: Int32 = 0
            for _ in 0..<timeoutIterations {
                let result = Darwin.waitpid(processID, &status, WNOHANG)
                if result == processID {
                    waited = true
                    drainTerminal()
                    return ProcessResult(
                        exitStatus: decodedExitStatus(status),
                        stdout: readToEnd(stdoutRead),
                        stderr: readToEnd(stderrRead)
                    )
                }
                guard result == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                drainTerminal()
                Darwin.usleep(10_000)
            }
            Darwin.kill(processID, SIGKILL)
            _ = Darwin.waitpid(processID, &status, 0)
            waited = true
            throw FixtureError.processTimedOut
        }

        private func drainTerminal() {
            var bytes = [UInt8](repeating: 0, count: 1_024)
            while true {
                let count = bytes.withUnsafeMutableBytes {
                    Darwin.read(master, $0.baseAddress, $0.count)
                }
                guard count > 0 else { return }
                terminalTranscript += String(decoding: bytes.prefix(Int(count)), as: UTF8.self)
            }
        }

        private func readToEnd(_ descriptor: Int32) -> String {
            var result = Data()
            var bytes = [UInt8](repeating: 0, count: 1_024)
            while true {
                let count = bytes.withUnsafeMutableBytes {
                    Darwin.read(descriptor, $0.baseAddress, $0.count)
                }
                guard count > 0 else { break }
                result.append(contentsOf: bytes.prefix(Int(count)))
            }
            return String(decoding: result, as: UTF8.self)
        }

        private func decodedExitStatus(_ status: Int32) -> Int32 {
            let signal = status & 0x7f
            return signal == 0 ? (status >> 8) & 0xff : 128 + signal
        }
    }

    private final class RequestRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [ControlCommand] = []

        var commands: [ControlCommand] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }

        func record(_ command: ControlCommand) {
            lock.lock()
            storage.append(command)
            lock.unlock()
        }
    }

    private final class DirectorySwapRacer: @unchecked Sendable {
        private let first: String
        private let second: String
        private let lock = NSLock()
        private let finished = DispatchSemaphore(value: 0)
        private var stopping = false
        private var failureStorage: Int32?

        init(first: String, second: String) {
            self.first = first
            self.second = second
        }

        var failure: Int32? {
            lock.lock()
            defer { lock.unlock() }
            return failureStorage
        }

        func start() {
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                defer { finished.signal() }
                while !lock.withLock({ stopping }) {
                    let result = first.withCString { firstPath in
                        second.withCString { secondPath in
                            Darwin.renameatx_np(
                                AT_FDCWD,
                                firstPath,
                                AT_FDCWD,
                                secondPath,
                                UInt32(RENAME_SWAP)
                            )
                        }
                    }
                    if result != 0 {
                        lock.lock()
                        failureStorage = errno
                        lock.unlock()
                        return
                    }
                    Darwin.sched_yield()
                }
            }
        }

        func stop() -> Bool {
            lock.lock()
            stopping = true
            lock.unlock()
            return finished.wait(timeout: .now() + 2) == .success
        }
    }

    private struct MetadataFingerprint: Equatable {
        let device: UInt64
        let inode: UInt64
        let mode: UInt16
        let contents: Data?
    }

    private func withActualVersionOnlyApp(_ body: (Fixture) throws -> Void) throws {
        var template = Array("/private/tmp/rrv.XXXXXX".utf8CString)
        let created = template.withUnsafeMutableBufferPointer { pointer -> String? in
            guard let path = Darwin.mkdtemp(pointer.baseAddress) else { return nil }
            return String(cString: path)
        }
        guard let created else { throw FixtureError.cannotCreateVerificationRoot }
        let root = URL(fileURLWithPath: created, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root
        let applicationSupport = home.appendingPathComponent(
            "Library/Application Support",
            isDirectory: true
        )
        let captureDirectory = root.appendingPathComponent(
            "lifecycle-verification",
            isDirectory: true
        )
        let paths = AgentPaths(applicationSupportDirectory: applicationSupport)
        XCTAssertLessThan(paths.controlSocket.path.utf8.count, 104)

        let contents = paths.agentApplication.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        for directory in [
            home,
            home.appendingPathComponent("Library", isDirectory: true),
            applicationSupport,
            paths.supportDirectory,
            paths.stateDirectory,
            paths.outboxDirectory,
            captureDirectory,
            paths.agentApplication,
            contents,
            macOS,
        ] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
        }

        let builtExecutable = Bundle(for: Self.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("raiders", isDirectory: false)
        guard FileManager.default.isExecutableFile(atPath: builtExecutable.path) else {
            throw FixtureError.builtExecutableMissing
        }
        try FileManager.default.copyItem(at: builtExecutable, to: paths.agentExecutable)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: paths.agentExecutable.path
        )

        let info = contents.appendingPathComponent("Info.plist", isDirectory: false)
        try writeInfo(versionInfo(), to: info)
        let enrollment = paths.stateDirectory.appendingPathComponent(
            "enrollment.json",
            isDirectory: false
        )
        try Data((
            #"{"version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dedupe_secret":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","server_url":"https://raiders.redlattice.com","cutover_at":1700000000000,"enabled_surfaces":["codex_desktop","codex_cli"]}"#
        ).utf8).write(to: enrollment)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: enrollment.path
        )
        let collectorState = paths.stateDirectory.appendingPathComponent(
            "collector-state.json",
            isDirectory: false
        )
        try Data(#"{"enabled":false,"files":{},"version":1}"#.utf8).write(
            to: collectorState
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: collectorState.path
        )
        let socketLifetimeLock = paths.supportDirectory.appendingPathComponent(
            ".agent.sock.runtime-raiders.lock",
            isDirectory: false
        )
        try Data().write(to: socketLifetimeLock)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: socketLifetimeLock.path
        )
        let versionResponse = root.appendingPathComponent(
            "version-response.json",
            isDirectory: false
        )
        try Data(#"{"version":"1.2.3"}"#.utf8).write(to: versionResponse)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: versionResponse.path
        )

        try body(Fixture(
            root: root,
            home: home,
            applicationSupport: applicationSupport,
            captureDirectory: captureDirectory,
            paths: paths,
            executable: paths.agentExecutable,
            info: info,
            versionResponse: versionResponse
        ))
    }

    private func startPTYCLI(
        _ fixture: Fixture,
        arguments: [String],
        lifecycleScenario: String
    ) throws -> PTYCLIProcess {
        try prepareLifecyclePTYFixture(fixture, scenario: lifecycleScenario)
        return try PTYCLIProcess(
            executable: fixture.executable,
            arguments: arguments,
            environment: cliEnvironment(fixture, lifecycleScenario: lifecycleScenario)
        )
    }

    private func cliEnvironment(
        _ fixture: Fixture,
        lifecycleScenario: String? = nil,
        includeVerificationGate: Bool = true,
        includeSupportOverride: Bool = true,
        supportOverridePath: String? = nil,
        versionResponsePath: String? = nil
    ) -> [String: String] {
        var environment: [String: String] = [
            "PATH": "/usr/bin:/bin",
            "HOME": fixture.home.path,
            "CFFIXED_USER_HOME": fixture.home.path,
            "RUNTIME_RAIDERS_VERIFY_VERSION_RESPONSE_FILE":
                versionResponsePath ?? fixture.versionResponse.path,
        ]
        if includeSupportOverride {
            environment["RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY"] =
                supportOverridePath ?? fixture.applicationSupport.path
        }
        if includeVerificationGate {
            environment["RUNTIME_RAIDERS_VERIFY_RUNTIME_INPUTS"] = "1"
        }
        if let lifecycleScenario {
            environment["RUNTIME_RAIDERS_VERIFY_LIFECYCLE_SCENARIO"] = lifecycleScenario
        }
        return environment
    }

    private func lifecycleActions(_ fixture: Fixture) -> URL {
        fixture.captureDirectory.appendingPathComponent(
            "lifecycle-actions.log",
            isDirectory: false
        )
    }

    private func lifecycleRequest(_ fixture: Fixture) -> URL {
        fixture.captureDirectory.appendingPathComponent(
            "lifecycle-request-capture.json",
            isDirectory: false
        )
    }

    private func lifecycleJournal(_ fixture: Fixture) -> URL {
        fixture.paths.stateDirectory.appendingPathComponent("re-enrollment.json")
    }

    private func lifecyclePaths(_ fixture: Fixture) throws -> CompanionLifecyclePaths {
        try CompanionLifecyclePaths(homeDirectory: fixture.home)
    }

    private func lifecycleActionLines(_ fixture: Fixture) throws -> [String] {
        guard FileManager.default.fileExists(atPath: lifecycleActions(fixture).path) else {
            return []
        }
        return String(
            decoding: try Data(contentsOf: lifecycleActions(fixture)),
            as: UTF8.self
        ).split(separator: "\n").map(String.init)
    }

    private func assertOrderedLifecycleActions(
        _ expected: [String],
        in fixture: Fixture,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let actual = try lifecycleActionLines(fixture)
        var nextIndex = actual.startIndex
        for action in expected {
            guard let found = actual[nextIndex...].firstIndex(of: action) else {
                XCTFail(
                    "missing ordered lifecycle action \(action); actual=\(actual)",
                    file: file,
                    line: line
                )
                return
            }
            nextIndex = actual.index(after: found)
        }
    }

    private func syntheticEnrollmentCode() -> String {
        "private\(UUID().uuidString)"
    }

    private func prepareLifecyclePTYFixture(_ fixture: Fixture, scenario: String) throws {
        if scenario == "re-enroll-collection-on" {
            let collector = fixture.paths.stateDirectory.appendingPathComponent(
                "collector-state.json"
            )
            try Data(#"{"enabled":true,"files":{},"version":1}"#.utf8).write(to: collector)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: collector.path
            )
        }
        guard scenario == "re-enroll-completed-queued" ||
                scenario == "uninstall-everything-completed-queued" else {
            return
        }
        let outbox = try Outbox(directory: fixture.paths.outboxDirectory)
        guard try outbox.queuedCount() == 0 else { return }
        for sequence in 1...2 {
            let event = RunEventV1(
                schemaVersion: 1,
                companionVersion: "1.2.3",
                deviceID: "00000000-0000-4000-8000-000000000001",
                provider: .codex,
                surface: .codexCLI,
                runKey: String(repeating: "a", count: 64),
                sequence: Int64(sequence),
                eventTimeMS: Int64(sequence),
                observedAtMS: Int64(sequence),
                startedAtMS: 1,
                state: .open,
                usage: .init(
                    input: Int64(sequence),
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoningOutput: 0
                ),
                model: nil,
                effort: nil,
                idempotencyKey: String(format: "%064x", sequence)
            )
            _ = try outbox.enqueue(event)
        }
    }

    private func removeLifecycleCaptures(_ fixture: Fixture) throws {
        for file in [lifecycleActions(fixture), lifecycleRequest(fixture), lifecycleJournal(fixture)] {
            if FileManager.default.fileExists(atPath: file.path) {
                try FileManager.default.removeItem(at: file)
            }
        }
    }

    private func reEnrollmentSummary(queueCount: Int) -> String {
        "Runtime Raiders re-enrollment\n" +
        "Collection: OFF\n" +
        "Background agent: Stopped\n" +
        "Queued events: \(queueCount)\n" +
        "Installed version: 1.2.3\n" +
        "Runs, scores, and rewards remain with their original Raider.\n"
    }

    private func completeRemovalSummary(queueCount: Int) -> String {
        "Runtime Raiders complete removal\n" +
        "Collection: OFF\n" +
        "Background agent: Stopped\n" +
        "Queued events: \(queueCount)\n" +
        "Remove: app, background agent, command, enrollment, collector state, queued events, and recovery state.\n" +
        "Raider, account, Runs, scores, rewards, and history will remain on the server.\n"
    }

    private func assertLifecycleOutputIsContentFree(
        _ text: String,
        fixture: Fixture,
        additionalSecrets: [String] = [],
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let forbidden = [
            fixture.root.path,
            "00000000-0000-4000-8000-000000000001",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "player-private-id",
            "cursor-private-value",
            "provider-private-content",
            "native-run-private-id",
        ] + additionalSecrets
        for (index, value) in forbidden.enumerated() where !value.isEmpty {
            XCTAssertFalse(
                text.contains(value),
                "content-free output contained forbidden value index \(index)",
                file: file,
                line: line
            )
        }
    }

    private func runCLI(
        _ fixture: Fixture,
        arguments: [String],
        includeVerificationGate: Bool = true,
        includeSupportOverride: Bool = true,
        supportOverridePath: String? = nil,
        versionResponsePath: String? = nil,
        lifecycleScenario: String? = nil,
        completionTimeout: DispatchTimeInterval = .seconds(5)
    ) throws -> ProcessResult {
        let process = Process()
        process.executableURL = fixture.executable
        process.arguments = arguments
        process.environment = cliEnvironment(
            fixture,
            lifecycleScenario: lifecycleScenario,
            includeVerificationGate: includeVerificationGate,
            includeSupportOverride: includeSupportOverride,
            supportOverridePath: supportOverridePath,
            versionResponsePath: versionResponsePath
        )
        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }

        try process.run()
        guard completed.wait(timeout: .now() + completionTimeout) == .success else {
            Darwin.kill(process.processIdentifier, SIGKILL)
            _ = completed.wait(timeout: .now() + 1)
            throw FixtureError.processTimedOut
        }
        return ProcessResult(
            exitStatus: process.terminationStatus,
            stdout: String(
                decoding: output.fileHandleForReading.readDataToEndOfFile(),
                as: UTF8.self
            ),
            stderr: String(
                decoding: error.fileHandleForReading.readDataToEndOfFile(),
                as: UTF8.self
            )
        )
    }

    private func treeFingerprint(_ root: URL) throws -> [String: Data] {
        let manager = FileManager.default
        guard let enumerator = manager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: []
        ) else { return [:] }
        var fingerprint: [String: Data] = [:]
        for case let url as URL in enumerator {
            let relative = String(url.path.dropFirst(root.path.count))
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            fingerprint[relative] = values.isRegularFile == true ? try Data(contentsOf: url) : Data()
        }
        return fingerprint
    }

    private func metadataFingerprint(_ root: URL) throws -> [String: MetadataFingerprint] {
        let manager = FileManager.default
        guard let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: nil) else {
            return [:]
        }
        var urls = [root]
        for case let url as URL in enumerator { urls.append(url) }
        var fingerprint: [String: MetadataFingerprint] = [:]
        for url in urls {
            var metadata = stat()
            guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.EIO) }
            let relative = String(url.path.dropFirst(root.path.count))
            fingerprint[relative] = MetadataFingerprint(
                device: UInt64(metadata.st_dev),
                inode: UInt64(metadata.st_ino),
                mode: UInt16(metadata.st_mode & (S_IFMT | 0o777)),
                contents: metadata.st_mode & S_IFMT == S_IFREG ? try Data(contentsOf: url) : nil
            )
        }
        return fingerprint
    }

    private func directoryInode(_ directory: URL) throws -> UInt64 {
        var metadata = stat()
        guard Darwin.lstat(directory.path, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR else {
            throw POSIXError(.EIO)
        }
        return UInt64(metadata.st_ino)
    }

    private func directoryPermissions(_ descriptor: Int32) throws -> UInt16 {
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR else {
            throw POSIXError(.EIO)
        }
        return UInt16(metadata.st_mode & 0o777)
    }

    private func swapDirectories(_ first: String, _ second: String) throws {
        let result = first.withCString { firstPath in
            second.withCString { secondPath in
                Darwin.renameatx_np(
                    AT_FDCWD,
                    firstPath,
                    AT_FDCWD,
                    secondPath,
                    UInt32(RENAME_SWAP)
                )
            }
        }
        guard result == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private func versionInfo() -> [String: Any] {
        [
            "CFBundleExecutable": "runtime-raiders-agent",
            "CFBundleIdentifier": "com.redlattice.runtime-raiders",
            "CFBundleName": "Runtime Raiders",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.2.3",
            "CFBundleVersion": "1.2.3",
        ]
    }

    private func versionInfo(removing key: String) -> [String: Any] {
        var info = versionInfo()
        info.removeValue(forKey: key)
        return info
    }

    private func versionInfo(replacing key: String, with value: Any) -> [String: Any] {
        var info = versionInfo()
        info[key] = value
        return info
    }

    private func writeInfo(_ info: [String: Any], to url: URL) throws {
        try PropertyListSerialization.data(
            fromPropertyList: info,
            format: .xml,
            options: 0
        ).write(to: url)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: url.path
        )
    }
}

@_silgen_name("forkpty")
private func forkPseudoTerminal(
    _ master: UnsafeMutablePointer<Int32>,
    _ name: UnsafeMutablePointer<CChar>?,
    _ termp: UnsafeMutableRawPointer?,
    _ winp: UnsafeMutableRawPointer?
) -> pid_t

private func writeAll(_ data: Data, to descriptor: Int32) throws {
    var offset = 0
    while offset < data.count {
        let count = data.withUnsafeBytes { bytes in
            Darwin.write(
                descriptor,
                bytes.baseAddress?.advanced(by: offset),
                data.count - offset
            )
        }
        guard count > 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        offset += count
    }
}

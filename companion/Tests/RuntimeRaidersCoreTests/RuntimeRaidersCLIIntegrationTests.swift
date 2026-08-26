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
                    "Runtime Raiders lifecycle commands require an interactive terminal.\n"
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

    func testOrdinaryUninstallRemainsNoninteractiveAndReportsPreservedState() throws {
        try withActualVersionOnlyApp { fixture in
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
            try assertLifecycleOutputIsContentFree(result.stdout + result.stderr, fixture: fixture)
            XCTAssertEqual(try lifecycleActionLines(fixture).first, "control:uninstall")
            XCTAssertFalse(FileManager.default.fileExists(atPath: lifecycleRequest(fixture).path))
        }
    }

    func testReEnrollmentPTYSuccessKeepsCodePrivateAndRedactsCapturedArtifacts() throws {
        try withActualVersionOnlyApp { fixture in
            let code = "private-\(UUID().uuidString)"
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
            for capture in [lifecycleJournal(fixture), lifecycleRequest(fixture)] {
                let contents = String(decoding: try Data(contentsOf: capture), as: UTF8.self)
                XCTAssertFalse(contents.contains(code))
                XCTAssertTrue(contents.contains("[REDACTED]"))
            }
            try assertLifecycleOutputIsContentFree(
                result.stdout + result.stderr + process.terminalTranscript,
                fixture: fixture,
                additionalSecrets: [code]
            )
        }
    }

    func testReEnrollmentPTYAcceptsOnlyDeliverDiscardOrCancelAndRequiresExactDiscard() throws {
        for disposition in ["deliver", "discard", "cancel"] {
            try withActualVersionOnlyApp { fixture in
                let code = "private-\(UUID().uuidString)"
                let process = try startPTYCLI(
                    fixture,
                    arguments: ["re-enroll"],
                    lifecycleScenario: "re-enroll-completed-queued"
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
                } else {
                    XCTAssertTrue(result.stdout.hasSuffix(
                        "Runtime Raiders re-enrollment succeeded.\n" +
                        "Collection remains OFF.\n" +
                        "History was not transferred; Runs, scores, and rewards remain with their original Raider.\n" +
                        "Next: run raiders status, then deliberately run raiders on.\n"
                    ))
                }
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
            XCTAssertTrue(try lifecycleActionLines(fixture).contains("queue:discard"))
            XCTAssertTrue(try lifecycleActionLines(fixture).contains("remove:everything"))
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

    func testLifecycleFailuresRemainContentFreeAndNameSafeNextActions() throws {
        let cases: [(scenario: String, arguments: [String], inputs: [(String, String)], expected: String)] = [
            (
                "re-enroll-collection-on", ["re-enroll"], [],
                "Collection is ON. No enrollment change was made.\nNext: run raiders off, then run raiders re-enroll again.\n"
            ),
            (
                "re-enroll-invalid-enrollment-empty", ["re-enroll"],
                [("Type RE-ENROLL to continue: ", "RE-ENROLL"), ("Enrollment code: ", "private-code")],
                "The enrollment code was not accepted. Collection remains OFF.\nNext: create a fresh code and run raiders re-enroll again.\n"
            ),
            (
                "re-enroll-recovery-required-empty", ["re-enroll"],
                [("Type RE-ENROLL to continue: ", "RE-ENROLL"), ("Enrollment code: ", "private-code")],
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
                    .appendingPathComponent("home/Library/Application Support", isDirectory: true)
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
            guard Darwin.pipe(&stdoutPipe) == 0, Darwin.pipe(&stderrPipe) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            var masterDescriptor: Int32 = -1
            var argv = ([executable.path] + arguments).map { strdup($0) }
            argv.append(nil)
            var envp = environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") }
            envp.append(nil)
            defer {
                for pointer in argv.dropLast() { free(pointer) }
                for pointer in envp.dropLast() { free(pointer) }
            }

            let child = forkPseudoTerminal(&masterDescriptor, nil, nil, nil)
            guard child >= 0 else {
                let saved = errno
                for descriptor in stdoutPipe + stderrPipe where descriptor >= 0 {
                    Darwin.close(descriptor)
                }
                throw POSIXError(POSIXErrorCode(rawValue: saved) ?? .EIO)
            }
            if child == 0 {
                Darwin.close(stdoutPipe[0])
                Darwin.close(stderrPipe[0])
                guard Darwin.dup2(stdoutPipe[1], STDOUT_FILENO) >= 0,
                      Darwin.dup2(stderrPipe[1], STDERR_FILENO) >= 0 else {
                    Darwin._exit(126)
                }
                Darwin.close(stdoutPipe[1])
                Darwin.close(stderrPipe[1])
                executable.path.withCString { executablePath in
                    argv.withUnsafeMutableBufferPointer { argumentBuffer in
                        envp.withUnsafeMutableBufferPointer { environmentBuffer in
                            _ = Darwin.execve(
                                executablePath,
                                argumentBuffer.baseAddress,
                                environmentBuffer.baseAddress
                            )
                        }
                    }
                }
                Darwin._exit(127)
            }

            processID = child
            master = masterDescriptor
            stdoutRead = stdoutPipe[0]
            stderrRead = stderrPipe[0]
            Darwin.close(stdoutPipe[1])
            Darwin.close(stderrPipe[1])
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
        let home = root.appendingPathComponent("home", isDirectory: true)
        let applicationSupport = home.appendingPathComponent(
            "Library/Application Support",
            isDirectory: true
        )
        let paths = AgentPaths(applicationSupportDirectory: applicationSupport)
        XCTAssertLessThan(paths.controlSocket.path.utf8.count, 104)

        let contents = paths.agentApplication.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        for directory in [
            root,
            home,
            home.appendingPathComponent("Library", isDirectory: true),
            applicationSupport,
            paths.supportDirectory,
            paths.stateDirectory,
            paths.outboxDirectory,
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
        let versionResponse = paths.stateDirectory.appendingPathComponent(
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
        try PTYCLIProcess(
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
        fixture.paths.stateDirectory.appendingPathComponent(
            "lifecycle-actions.log",
            isDirectory: false
        )
    }

    private func lifecycleRequest(_ fixture: Fixture) -> URL {
        fixture.paths.stateDirectory.appendingPathComponent(
            "lifecycle-request-capture.json",
            isDirectory: false
        )
    }

    private func lifecycleJournal(_ fixture: Fixture) -> URL {
        fixture.paths.stateDirectory.appendingPathComponent(
            "lifecycle-journal-capture.json",
            isDirectory: false
        )
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

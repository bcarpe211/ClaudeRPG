import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ControlProtocolTests: XCTestCase {
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

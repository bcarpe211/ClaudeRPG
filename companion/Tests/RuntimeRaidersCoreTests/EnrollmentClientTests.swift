import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class EnrollmentClientTests: XCTestCase, @unchecked Sendable {
    private let origin = URL(string: "http://127.0.0.1:8765")!
    private let oldToken = String(repeating: "O", count: 43)
    private let newToken = String(repeating: "N", count: 43)
    private let code = String(repeating: "C", count: 43)
    private let operationID = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    private let deviceID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let dedupeSecret = String(repeating: "a", count: 64)

    func testReplacementRequestHasExactAuthenticatedShape() throws {
        let requests = EnrollmentRequestLog()
        let client = try makeClient { request in
            requests.append(request)
            return self.response(status: 201, body: self.validConfiguration())
        }

        let result = try client.replace(
            oldToken: oldToken,
            code: code,
            material: material(),
            companionVersion: "0.4.8"
        )

        guard case .committed = result else {
            return XCTFail("replacement did not commit")
        }
        let request = try XCTUnwrap(requests.values.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/raiders/re-enroll")
        XCTAssertNil(request.url?.query)
        XCTAssertTrue(
            request.value(forHTTPHeaderField: "Authorization") == "Bearer " + oldToken,
            "authorization header mismatch"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(
            Set(object.keys),
            [
                "code", "operation_id", "replacement_device_id",
                "replacement_device_token", "companion_version",
            ]
        )
        XCTAssertTrue(object["code"] as? String == code, "code body value mismatch")
        XCTAssertTrue(
            object["operation_id"] as? String == operationID.uuidString.lowercased(),
            "operation identifier body value mismatch"
        )
        XCTAssertTrue(
            object["replacement_device_id"] as? String == deviceID.uuidString.lowercased(),
            "device identifier body value mismatch"
        )
        XCTAssertTrue(
            object["replacement_device_token"] as? String == newToken,
            "replacement token body value mismatch"
        )
        XCTAssertEqual(object["companion_version"] as? String, "0.4.8")
    }

    func testRecoveryAndRevocationRequestsHaveExactShapes() throws {
        let requestLog = EnrollmentRequestLog()
        let client = try makeClient { request in
            requestLog.append(request)
            if request.url?.path == "/api/raiders/enrollment-config" {
                return self.response(status: 200, body: self.validConfiguration())
            }
            return self.response(status: 200, body: #"{"revoked":true}"#)
        }

        XCTAssertNotNil(try client.recover(token: newToken))
        XCTAssertTrue(try client.revoke(token: newToken))
        let requests = requestLog.values
        XCTAssertEqual(requests.count, 2)

        let recovery = requests[0]
        XCTAssertEqual(recovery.httpMethod, "GET")
        XCTAssertEqual(recovery.url?.path, "/api/raiders/enrollment-config")
        XCTAssertNil(recovery.url?.query)
        XCTAssertNil(recovery.httpBody)
        XCTAssertNil(recovery.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertTrue(
            recovery.value(forHTTPHeaderField: "Authorization") == "Bearer " + newToken,
            "recovery authorization mismatch"
        )

        let revocation = requests[1]
        XCTAssertEqual(revocation.httpMethod, "POST")
        XCTAssertEqual(revocation.url?.path, "/api/raiders/devices/revoke-current")
        XCTAssertNil(revocation.url?.query)
        XCTAssertEqual(revocation.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertTrue(
            revocation.value(forHTTPHeaderField: "Authorization") == "Bearer " + newToken,
            "revocation authorization mismatch"
        )
        XCTAssertEqual(revocation.httpBody, Data("{}".utf8))
    }

    func testReplacementMapsOnlyExactCommittedAndFailureResponses() throws {
        for status in [200, 201] {
            let result = try replacing(status: status, body: validConfiguration())
            guard case let .committed(configuration) = result else {
                return XCTFail("expected committed replacement")
            }
            XCTAssertTrue(
                configuration.deviceID == deviceID.uuidString.lowercased(),
                "response device identifier was not preserved"
            )
            XCTAssertTrue(
                configuration.dedupeSecret == Data(repeating: 0xaa, count: 32),
                "response dedupe secret was not decoded exactly"
            )
            XCTAssertEqual(
                configuration.serverURL.absoluteString,
                "https://raiders.redlattice.com"
            )
            XCTAssertEqual(configuration.enabledSurfaces, [.codexCLI, .codexDesktop])
            XCTAssertEqual(configuration.cutoverAtMS, 1_780_000_000_000)
        }

        XCTAssertEqual(
            try replacing(status: 401, body: #"{"reason":"invalid_enrollment"}"#),
            .invalidEnrollment
        )
        XCTAssertEqual(
            try replacing(status: 401, body: #"{"reason":"unauthorized"}"#),
            .unauthorized
        )
        XCTAssertEqual(
            try replacing(status: 409, body: #"{"reason":"replacement_conflict"}"#),
            .conflict
        )
        XCTAssertEqual(try replacing(status: 500, body: #"{"anything":"private"}"#), .ambiguous)
        for status in [500, 502, 503] {
            XCTAssertEqual(
                try replacing(status: status, body: ""),
                .ambiguous,
                "empty replacement server error was not ambiguous"
            )
        }
        XCTAssertEqual(try replacing(transportError: SecretTransportError()), .ambiguous)
    }

    func testReplacementRejectsEveryCorruptOrUnexpectedResponse() throws {
        let corruptBodies: [String] = [
            validConfiguration(extra: #", "extra":true"#),
            validConfiguration(deviceID: "not-a-uuid"),
            validConfiguration(deviceID: "22222222-2222-4222-8222-222222222222"),
            validConfiguration(deviceID: "11111111-1111-4111-8111-11111111111A"),
            validConfiguration(dedupeSecret: String(repeating: "A", count: 64)),
            validConfiguration(dedupeSecret: String(repeating: "a", count: 63)),
            validConfiguration(serverURL: "http://raiders.redlattice.com"),
            validConfiguration(serverURL: "https://raiders.redlattice.com/?private=query"),
            validConfiguration(cutoverAt: "-1"),
            validConfiguration(cutoverAt: "1.5"),
            validConfiguration(cutoverAt: "9007199254740992"),
            validConfiguration(cutoverAt: "true"),
            validConfiguration(surfaces: #"[]"#),
            validConfiguration(surfaces: #"["codex_cli","codex_cli"]"#),
            validConfiguration(surfaces: #"["codex_cli","claude_code"]"#),
            validConfiguration(surfaces: #"["codex_cli",7]"#),
            #"{"device_id":"11111111-1111-4111-8111-111111111111","device_id":"22222222-2222-4222-8222-222222222222","dedupe_secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","server_url":"https://raiders.redlattice.com","cutover_at":1780000000000,"enabled_surfaces":["codex_cli"]}"#,
            #"{"device_id":true,"dedupe_secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","server_url":"https://raiders.redlattice.com","cutover_at":1780000000000,"enabled_surfaces":["codex_cli"]}"#,
            #"{"device_id":"11111111-1111-4111-8111-111111111111","dedupe_secret":7,"server_url":"https://raiders.redlattice.com","cutover_at":1780000000000,"enabled_surfaces":["codex_cli"]}"#,
            #"{"device_id":"11111111-1111-4111-8111-111111111111","dedupe_secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","server_url":null,"cutover_at":1780000000000,"enabled_surfaces":["codex_cli"]}"#,
            #"{"device_id":"11111111-1111-4111-8111-111111111111","dedupe_secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","server_url":"https://raiders.redlattice.com","cutover_at":"1780000000000","enabled_surfaces":["codex_cli"]}"#,
            #"{"device_id":"11111111-1111-4111-8111-111111111111","dedupe_secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","server_url":"https://raiders.redlattice.com","cutover_at":1780000000000,"enabled_surfaces":"codex_cli"}"#,
            #"{"device_id":"11111111-1111-4111-8111-111111111111","dedupe_secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","server_url":"https://raiders.redlattice.com","cutover_at":1780000000000}"#,
            "[]",
            "not json",
        ]
        for body in corruptBodies {
            assertContentFreeThrow {
                _ = try self.replacing(status: 200, body: body)
            }
        }

        for (status, body) in [
            (302, validConfiguration()),
            (204, ""),
            (400, #"{"reason":"invalid_request"}"#),
            (401, #"{"reason":"invalid_enrollment","extra":true}"#),
            (401, #"{"reason":"private"}"#),
            (409, #"{"reason":"replacement_conflict","reason":"private"}"#),
        ] {
            assertContentFreeThrow {
                _ = try self.replacing(status: status, body: body)
            }
        }

        let oversized = String(repeating: "x", count: 16 * 1_024 + 1)
        assertContentFreeThrow {
            _ = try self.replacing(status: 200, body: oversized)
        }
        for status in [500, 502, 503] {
            XCTAssertEqual(
                try replacing(status: status, body: oversized),
                .ambiguous,
                "oversized replacement server error was not ambiguous"
            )
        }
    }

    func testRecoveryReturnsNilOnlyForExactUnauthorizedAndOtherwiseFailsClosed() throws {
        XCTAssertNil(
            try recovering(status: 401, body: #"{"reason":"unauthorized"}"#)
        )
        XCTAssertNotNil(try recovering(status: 200, body: validConfiguration()))

        for (status, body) in [
            (201, validConfiguration()),
            (302, validConfiguration()),
            (401, #"{"reason":"invalid_enrollment"}"#),
            (401, #"{"reason":"unauthorized","extra":true}"#),
            (500, #"{"reason":"internal_error"}"#),
        ] {
            assertContentFreeThrow {
                _ = try self.recovering(status: status, body: body)
            }
        }
        assertContentFreeThrow {
            _ = try self.recovering(transportError: SecretTransportError())
        }
    }

    func testRevocationIsTrueOnlyForExactProofAndFalseOnlyForExactUnauthorized() throws {
        XCTAssertTrue(try revoking(status: 200, body: #"{"revoked":true}"#))
        XCTAssertFalse(try revoking(status: 401, body: #"{"reason":"unauthorized"}"#))

        for (status, body) in [
            (200, #"{"revoked":false}"#),
            (200, #"{"revoked":1}"#),
            (200, #"{"revoked":true,"extra":true}"#),
            (200, #"{"revoked":true,"revoked":true}"#),
            (201, #"{"revoked":true}"#),
            (302, #"{"revoked":true}"#),
            (401, #"{"reason":"unauthorized","extra":true}"#),
            (500, #"{"reason":"internal_error"}"#),
        ] {
            assertContentFreeThrow {
                _ = try self.revoking(status: status, body: body)
            }
        }
        assertContentFreeThrow {
            _ = try self.revoking(transportError: SecretTransportError())
        }
    }

    func testInputsOriginsAndDiagnosticsFailClosedWithoutDisclosingSensitiveValues() throws {
        let invalidOrigin = URL(string: "https://raiders.redlattice.com/?private=query")!
        assertContentFreeThrow {
            _ = try EnrollmentClient(origin: invalidOrigin, transport: { _ in
                throw SecretTransportError()
            })
        }
        for origin in [
            "http://raiders.redlattice.com",
            "https://raiders.redlattice.com.evil.test",
            "https://raiders.redlattice.com:444",
            "https://raiders.redlattice.com/path",
        ] {
            assertContentFreeThrow {
                _ = try EnrollmentClient(origin: URL(string: origin)!, transport: { _ in
                    throw SecretTransportError()
                })
            }
        }

        let client = try makeClient { _ in throw SecretTransportError() }
        for invalid in ["", String(repeating: "x", count: 42), String(repeating: "x", count: 44)] {
            assertContentFreeThrow {
                _ = try client.replace(
                    oldToken: invalid,
                    code: self.code,
                    material: self.material(),
                    companionVersion: "0.4.8"
                )
            }
        }
        assertContentFreeThrow {
            _ = try client.replace(
                oldToken: self.oldToken,
                code: self.code,
                material: self.material(),
                companionVersion: ""
            )
        }
        assertContentFreeThrow {
            _ = try client.recover(token: "not-a-token")
        }

        let redactedValues = [
            oldToken,
            newToken,
            code,
            operationID.uuidString,
            operationID.uuidString.lowercased(),
            deviceID.uuidString,
            deviceID.uuidString.lowercased(),
            dedupeSecret,
            "private=query",
            "PRIVATE_RESPONSE_BODY",
        ]
        let committed = try replacing(status: 200, body: validConfiguration())
        guard case let .committed(recovered) = committed else {
            return XCTFail("expected committed diagnostic fixture")
        }
        let diagnostics = [
            String(describing: material()),
            String(reflecting: material()),
            String(describing: recovered),
            String(reflecting: recovered),
            String(describing: committed),
            String(reflecting: committed),
            String(describing: try replacing(status: 500, body: "PRIVATE_RESPONSE_BODY")),
            String(reflecting: try replacing(status: 500, body: "PRIVATE_RESPONSE_BODY")),
        ]
        for diagnostic in diagnostics {
            for secret in redactedValues {
                XCTAssertFalse(diagnostic.contains(secret), "diagnostic disclosed sensitive input")
            }
        }
    }

    func testSecureGeneratorUsesExactBase64URLTokensAndUniqueDistinctIdentifiers() throws {
        let generator = SecureCredentialGenerator()
        var tokens = Set<String>()
        var deviceIDs = Set<UUID>()
        var operationIDs = Set<UUID>()
        for _ in 0..<256 {
            let generated = try generator.generate()
            XCTAssertEqual(generated.deviceToken.utf8.count, 43)
            XCTAssertNotNil(generated.deviceToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression))
            XCTAssertTrue(
                generated.deviceID != generated.operationID,
                "generated identifiers were not distinct"
            )
            XCTAssertTrue(tokens.insert(generated.deviceToken).inserted, "token repeated")
            XCTAssertTrue(deviceIDs.insert(generated.deviceID).inserted, "device identifier repeated")
            XCTAssertTrue(operationIDs.insert(generated.operationID).inserted, "operation identifier repeated")
        }

        let sequence = UUIDSequence([operationID, deviceID])
        let injected = SecureCredentialGenerator(uuidGenerator: { sequence.next() })
        let generated = try injected.generate()
        XCTAssertTrue(
            generated.operationID == operationID,
            "injected operation identifier was not used"
        )
        XCTAssertTrue(
            generated.deviceID == deviceID,
            "injected device identifier was not used"
        )
    }

    private func material() -> ReplacementMaterial {
        ReplacementMaterial(operationID: operationID, deviceID: deviceID, deviceToken: newToken)
    }

    private func makeClient(
        transport: @escaping EnrollmentClient.Transport
    ) throws -> EnrollmentClient {
        try EnrollmentClient(origin: origin, allowsTestOrigin: true, transport: transport)
    }

    private func makeProductionClient(
        transport: @escaping EnrollmentClient.Transport
    ) throws -> EnrollmentClient {
        try EnrollmentClient(
            origin: URL(string: "https://raiders.redlattice.com")!,
            transport: transport
        )
    }

    private func replacing(status: Int, body: String) throws -> ReplacementHTTPResult {
        let client = try makeProductionClient { _ in self.response(status: status, body: body) }
        return try client.replace(
            oldToken: oldToken,
            code: code,
            material: material(),
            companionVersion: "0.4.8"
        )
    }

    private func replacing(transportError: Error) throws -> ReplacementHTTPResult {
        let client = try makeProductionClient { _ in throw transportError }
        return try client.replace(
            oldToken: oldToken,
            code: code,
            material: material(),
            companionVersion: "0.4.8"
        )
    }

    private func recovering(status: Int, body: String) throws -> RecoveredEnrollment? {
        let client = try makeProductionClient { _ in self.response(status: status, body: body) }
        return try client.recover(token: newToken)
    }

    private func recovering(transportError: Error) throws -> RecoveredEnrollment? {
        let client = try makeProductionClient { _ in throw transportError }
        return try client.recover(token: newToken)
    }

    private func revoking(status: Int, body: String) throws -> Bool {
        let client = try makeProductionClient { _ in self.response(status: status, body: body) }
        return try client.revoke(token: newToken)
    }

    private func revoking(transportError: Error) throws -> Bool {
        let client = try makeProductionClient { _ in throw transportError }
        return try client.revoke(token: newToken)
    }

    private func response(status: Int, body: String) -> UploadHTTPResponse {
        UploadHTTPResponse(statusCode: status, body: Data(body.utf8))
    }

    private func validConfiguration(
        deviceID: String = "11111111-1111-4111-8111-111111111111",
        dedupeSecret: String? = nil,
        serverURL: String = "https://raiders.redlattice.com",
        cutoverAt: String = "1780000000000",
        surfaces: String = #"["codex_cli","codex_desktop"]"#,
        extra: String = ""
    ) -> String {
        let secret = dedupeSecret ?? self.dedupeSecret
        return #"{"device_id":"\#(deviceID)","dedupe_secret":"\#(secret)","server_url":"\#(serverURL)","cutover_at":\#(cutoverAt),"enabled_surfaces":\#(surfaces)\#(extra)}"#
    }

    private func assertContentFreeThrow(
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () throws -> Void
    ) {
        do {
            try body()
            XCTFail("expected content-free failure", file: file, line: line)
        } catch {
            let diagnostics = [String(describing: error), String(reflecting: error)]
            for diagnostic in diagnostics {
                for secret in [
                    oldToken, newToken, code,
                    operationID.uuidString, operationID.uuidString.lowercased(),
                    deviceID.uuidString, deviceID.uuidString.lowercased(),
                    dedupeSecret, "private=query", "PRIVATE_RESPONSE_BODY",
                ] {
                    XCTAssertFalse(
                        diagnostic.contains(secret),
                        "error diagnostic disclosed sensitive input",
                        file: file,
                        line: line
                    )
                }
            }
        }
    }
}

private struct SecretTransportError: Error, CustomStringConvertible {
    var description: String {
        "PRIVATE_RESPONSE_BODY?private=query/" + String(repeating: "O", count: 43)
    }
}

private final class UUIDSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [UUID]

    init(_ values: [UUID]) {
        self.values = values
    }

    func next() -> UUID {
        lock.withLock {
            precondition(!values.isEmpty)
            return values.removeFirst()
        }
    }
}

private final class EnrollmentRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var values: [URLRequest] {
        lock.withLock { requests }
    }

    func append(_ request: URLRequest) {
        lock.withLock { requests.append(request) }
    }
}

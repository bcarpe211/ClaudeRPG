import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class PrivacyEncoderTests: XCTestCase {
    private let maximumSafeInteger: Int64 = 9_007_199_254_740_991
    private let maximumRunDurationMS: Int64 = 7 * 24 * 60 * 60 * 1_000

    func testRunIdentityUsesStableLowercaseOpaqueHMACsWithDomainSeparation() throws {
        let nativeID = "DO_NOT_EXPORT_NATIVE_ID"
        let secret = Data("DO_NOT_EXPORT_DEDUPE_SECRET".utf8)

        let codex = try RunIdentity.key(provider: .codex, nativeID: nativeID, dedupeSecret: secret)
        let repeated = try RunIdentity.key(provider: .codex, nativeID: nativeID, dedupeSecret: secret)
        let otherProvider = try RunIdentity.key(provider: .claude, nativeID: nativeID, dedupeSecret: secret)
        let otherNativeID = try RunIdentity.key(
            provider: .codex,
            nativeID: "DO_NOT_EXPORT_OTHER_NATIVE_ID",
            dedupeSecret: secret
        )

        XCTAssertEqual(codex, repeated)
        XCTAssertEqual(codex, "d9059106f09358932adfec036a4c025137549be61e3007b5774768bf360d847b")
        XCTAssertTrue(codex.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil)
        XCTAssertNotEqual(codex, otherProvider)
        XCTAssertNotEqual(codex, otherNativeID)
        XCTAssertFalse(codex.contains(nativeID))
        XCTAssertFalse(codex.contains("DO_NOT_EXPORT_DEDUPE_SECRET"))
    }

    func testEventIdentityIsStableAndSeparatesSequences() throws {
        let runKey = try RunIdentity.key(
            provider: .codex,
            nativeID: "synthetic-run",
            dedupeSecret: Data("synthetic-secret".utf8)
        )

        let zero = try RunIdentity.eventKey(runKey: runKey, sequence: 0)
        let repeated = try RunIdentity.eventKey(runKey: runKey, sequence: 0)
        let one = try RunIdentity.eventKey(runKey: runKey, sequence: 1)

        XCTAssertEqual(zero, repeated)
        XCTAssertTrue(zero.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil)
        XCTAssertNotEqual(zero, one)
        XCTAssertFalse(zero.contains(runKey))

        XCTAssertEqual(
            try RunIdentity.eventKey(runKey: String(repeating: "0", count: 64), sequence: 0),
            "02c3e2a2982cca79ac85a805231ec569f3de309f58f335cb23a2e534384f0203"
        )
    }

    func testRunIdentityRejectsUnsafeEmptyAndMalformedInputsWithoutCrashing() throws {
        XCTAssertThrowsError(
            try RunIdentity.key(provider: .codex, nativeID: "", dedupeSecret: Data("secret".utf8))
        )
        XCTAssertThrowsError(
            try RunIdentity.key(provider: .codex, nativeID: "run", dedupeSecret: Data())
        )
        XCTAssertThrowsError(try RunIdentity.eventKey(runKey: "not-a-run-key", sequence: 0))
        XCTAssertThrowsError(
            try RunIdentity.eventKey(runKey: String(repeating: "a", count: 64), sequence: -1)
        )
        XCTAssertThrowsError(
            try RunIdentity.eventKey(
                runKey: String(repeating: "a", count: 64),
                sequence: maximumSafeInteger + 1
            )
        )
    }

    func testPrivacyEncoderEmitsOnlyTheStrictAllowlist() throws {
        let data = try PrivacyEncoder().encode(makeEvent())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(
            Set(object.keys),
            [
                "schema_version", "companion_version", "device_id", "provider",
                "surface", "run_key", "sequence", "event_time_ms",
                "observed_at_ms", "started_at_ms", "state", "usage", "model",
                "effort", "idempotency_key",
            ]
        )
        let usage = try XCTUnwrap(object["usage"] as? [String: Any])
        XCTAssertEqual(
            Set(usage.keys),
            ["input", "output", "cache_read", "cache_write", "reasoning_output"]
        )
    }

    func testPrivacyEncoderDropsEveryForbiddenUnknownAndLocalTrap() throws {
        let nativeID = "DO_NOT_EXPORT_NATIVE_ID"
        let secret = Data("DO_NOT_EXPORT_DEDUPE_SECRET".utf8)
        let runKey = try RunIdentity.key(provider: .codex, nativeID: nativeID, dedupeSecret: secret)
        let idempotencyKey = try RunIdentity.eventKey(runKey: runKey, sequence: 7)
        var source = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(makeEvent())) as? [String: Any]
        )
        source["run_key"] = runKey
        source["idempotency_key"] = idempotencyKey
        source["native_id"] = nativeID
        source["local_path"] = "/DO_NOT_EXPORT_LOCAL_PATH"
        source["workspace"] = "DO_NOT_EXPORT_WORKSPACE"
        source["prompt"] = "DO_NOT_EXPORT_PROMPT"
        source["response"] = "DO_NOT_EXPORT_RESPONSE"
        source["content"] = "DO_NOT_EXPORT_CONTENT"
        source["command"] = "DO_NOT_EXPORT_COMMAND"
        source["tool_arguments"] = ["value": "DO_NOT_EXPORT_TOOL_ARGUMENT"]
        source["tool_result"] = "DO_NOT_EXPORT_TOOL_RESULT"
        source["unknown"] = "DO_NOT_EXPORT_UNKNOWN_FIELD"

        let decoded = try JSONDecoder().decode(
            RunEventV1.self,
            from: JSONSerialization.data(withJSONObject: source)
        )
        let encoded = try PrivacyEncoder().encode(decoded)
        let rendered = try XCTUnwrap(String(data: encoded, encoding: .utf8))

        for trap in [
            nativeID,
            "DO_NOT_EXPORT_DEDUPE_SECRET",
            "/DO_NOT_EXPORT_LOCAL_PATH",
            "DO_NOT_EXPORT_WORKSPACE",
            "DO_NOT_EXPORT_PROMPT",
            "DO_NOT_EXPORT_RESPONSE",
            "DO_NOT_EXPORT_CONTENT",
            "DO_NOT_EXPORT_COMMAND",
            "DO_NOT_EXPORT_TOOL_ARGUMENT",
            "DO_NOT_EXPORT_TOOL_RESULT",
            "DO_NOT_EXPORT_UNKNOWN_FIELD",
        ] {
            XCTAssertFalse(rendered.contains(trap), trap)
        }
    }

    func testPrivacyEncoderAcceptsInclusiveNumericAndStringBoundaries() throws {
        var event = makeEvent()
        event.companionVersion = String(repeating: "v", count: 100)
        event.sequence = maximumSafeInteger
        event.startedAtMS = maximumSafeInteger - maximumRunDurationMS
        event.eventTimeMS = maximumSafeInteger
        event.observedAtMS = maximumSafeInteger
        event.usage = UsageCountersV1(
            input: 0,
            output: maximumSafeInteger,
            cacheRead: 0,
            cacheWrite: maximumSafeInteger,
            reasoningOutput: maximumSafeInteger
        )
        event.model = String(repeating: "m", count: 100)
        event.effort = ""

        XCTAssertNoThrow(try PrivacyEncoder().encode(event))
        event.model = nil
        event.effort = nil
        XCTAssertNoThrow(try PrivacyEncoder().encode(event))
    }

    func testPrivacyEncoderRejectsEveryNumericFieldOutsideSafeIntegerBounds() throws {
        var invalidEvents: [RunEventV1] = []
        for invalid in [-1, maximumSafeInteger + 1] {
            var sequence = makeEvent(); sequence.sequence = invalid; invalidEvents.append(sequence)
            var eventTime = makeEvent(); eventTime.eventTimeMS = invalid; invalidEvents.append(eventTime)
            var observed = makeEvent(); observed.observedAtMS = invalid; invalidEvents.append(observed)
            var started = makeEvent(); started.startedAtMS = invalid; invalidEvents.append(started)

            for field in 0..<5 {
                var event = makeEvent()
                var usage = event.usage
                switch field {
                case 0: usage.input = invalid
                case 1: usage.output = invalid
                case 2: usage.cacheRead = invalid
                case 3: usage.cacheWrite = invalid
                default: usage.reasoningOutput = invalid
                }
                event.usage = usage
                invalidEvents.append(event)
            }
        }

        for (index, event) in invalidEvents.enumerated() {
            XCTAssertThrowsError(try PrivacyEncoder().encode(event), "invalid numeric case \(index)")
        }
    }

    func testPrivacyEncoderRejectsEveryInvalidStringBoundaryAndKeyShape() throws {
        var invalidEvents: [RunEventV1] = []
        var emptyVersion = makeEvent(); emptyVersion.companionVersion = ""; invalidEvents.append(emptyVersion)
        var longVersion = makeEvent(); longVersion.companionVersion = String(repeating: "v", count: 101); invalidEvents.append(longVersion)
        var longModel = makeEvent(); longModel.model = String(repeating: "m", count: 101); invalidEvents.append(longModel)
        var longEffort = makeEvent(); longEffort.effort = String(repeating: "e", count: 101); invalidEvents.append(longEffort)
        var badUUID = makeEvent(); badUUID.deviceID = "not-a-uuid"; invalidEvents.append(badUUID)
        var shortRunKey = makeEvent(); shortRunKey.runKey = String(repeating: "a", count: 63); invalidEvents.append(shortRunKey)
        var upperRunKey = makeEvent(); upperRunKey.runKey = String(repeating: "A", count: 64); invalidEvents.append(upperRunKey)
        var badEventKey = makeEvent(); badEventKey.idempotencyKey = String(repeating: "g", count: 64); invalidEvents.append(badEventKey)

        for (index, event) in invalidEvents.enumerated() {
            XCTAssertThrowsError(try PrivacyEncoder().encode(event), "invalid string case \(index)")
        }
    }

    func testPrivacyEncoderRejectsSchemaProviderSurfaceAndTimestampViolations() throws {
        var invalidEvents: [RunEventV1] = []
        var schema = makeEvent(); schema.schemaVersion = 2; invalidEvents.append(schema)
        var mismatch = makeEvent(); mismatch.surface = .claudeCode; invalidEvents.append(mismatch)
        var eventBeforeStart = makeEvent(); eventBeforeStart.eventTimeMS = eventBeforeStart.startedAtMS - 1; invalidEvents.append(eventBeforeStart)
        var tooLong = makeEvent(); tooLong.eventTimeMS = tooLong.startedAtMS + maximumRunDurationMS + 1; invalidEvents.append(tooLong)
        var observedBeforeEvent = makeEvent(); observedBeforeEvent.observedAtMS = observedBeforeEvent.eventTimeMS - 1; invalidEvents.append(observedBeforeEvent)

        for (index, event) in invalidEvents.enumerated() {
            XCTAssertThrowsError(try PrivacyEncoder().encode(event), "invalid invariant case \(index)")
        }

        for (provider, surface) in [
            (RunProvider.codex, RunSurface.claudeCode),
            (.codex, .omp),
            (.claude, .codexDesktop),
            (.claude, .codexCLI),
            (.omp, .codexDesktop),
            (.omp, .claudeCode),
        ] {
            var event = makeEvent()
            event.provider = provider
            event.surface = surface
            XCTAssertThrowsError(try PrivacyEncoder().encode(event))
        }
    }

    func testPrivacyEncoderAcceptsEveryStateAndValidProviderSurfacePair() throws {
        for (provider, surface) in [
            (RunProvider.codex, RunSurface.codexDesktop),
            (.codex, .codexCLI),
            (.claude, .claudeCode),
            (.omp, .omp),
        ] {
            for state in RunState.allCases {
                var event = makeEvent()
                event.provider = provider
                event.surface = surface
                event.state = state
                XCTAssertNoThrow(try PrivacyEncoder().encode(event))
            }
        }
    }

    private func makeEvent() -> RunEventV1 {
        RunEventV1(
            schemaVersion: 1,
            companionVersion: "1.0.0",
            deviceID: "123E4567-E89B-12D3-A456-426614174000",
            provider: .codex,
            surface: .codexDesktop,
            runKey: String(repeating: "a", count: 64),
            sequence: 7,
            eventTimeMS: 1_700_000_001_000,
            observedAtMS: 1_700_000_001_500,
            startedAtMS: 1_700_000_000_000,
            state: .open,
            usage: UsageCountersV1(
                input: 1,
                output: 2,
                cacheRead: 3,
                cacheWrite: 4,
                reasoningOutput: 5
            ),
            model: "synthetic-model",
            effort: "medium",
            idempotencyKey: String(repeating: "b", count: 64)
        )
    }
}

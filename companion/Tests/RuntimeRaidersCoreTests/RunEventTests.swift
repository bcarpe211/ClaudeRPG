import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class RunEventTests: XCTestCase {
    func testRunEventCodableUsesOnlyApprovedSnakeCaseWireKeys() throws {
        let data = try JSONEncoder().encode(makeEvent())
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
        XCTAssertEqual(object["schema_version"] as? Int, 1)
        XCTAssertEqual(object["provider"] as? String, "codex")
        XCTAssertEqual(object["surface"] as? String, "codex_desktop")
        XCTAssertEqual(object["state"] as? String, "completed")

        let usage = try XCTUnwrap(object["usage"] as? [String: Any])
        XCTAssertEqual(
            Set(usage.keys),
            ["input", "output", "cache_read", "cache_write", "reasoning_output"]
        )
    }

    func testRunEventRoundTripsEveryApprovedEnumValue() throws {
        let pairs: [(RunProvider, RunSurface)] = [
            (.codex, .codexDesktop),
            (.codex, .codexCLI),
            (.claude, .claudeCode),
            (.omp, .omp),
        ]

        for (provider, surface) in pairs {
            for state in RunState.allCases {
                var event = makeEvent()
                event.provider = provider
                event.surface = surface
                event.state = state
                let data = try JSONEncoder().encode(event)
                XCTAssertEqual(try JSONDecoder().decode(RunEventV1.self, from: data), event)
            }
        }
    }

    func testRunEventDecodingRejectsUnknownProviderSurfaceAndStateValues() throws {
        let valid = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(makeEvent())) as? [String: Any]
        )

        for (key, value) in [
            ("provider", "unknown_provider"),
            ("surface", "unknown_surface"),
            ("state", "unknown_state"),
        ] {
            var invalid = valid
            invalid[key] = value
            let data = try JSONSerialization.data(withJSONObject: invalid)
            XCTAssertThrowsError(try JSONDecoder().decode(RunEventV1.self, from: data), key)
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
            sequence: 4,
            eventTimeMS: 1_700_000_001_000,
            observedAtMS: 1_700_000_001_500,
            startedAtMS: 1_700_000_000_000,
            state: .completed,
            usage: UsageCountersV1(
                input: 10,
                output: 20,
                cacheRead: 30,
                cacheWrite: 40,
                reasoningOutput: 50
            ),
            model: "synthetic-model",
            effort: "medium",
            idempotencyKey: String(repeating: "b", count: 64)
        )
    }
}

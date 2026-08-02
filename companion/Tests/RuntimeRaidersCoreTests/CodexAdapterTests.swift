import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class CodexAdapterTests: XCTestCase {
    private let observedAt: Int64 = 1_800_000_000_000

    func testCompletedFixturesNormalizeCumulativeUsageAndSurface() throws {
        let cases: [(String, RunSurface, Int64)] = [
            ("cli-completed", .codexCLI, 10),
            ("desktop-completed", .codexDesktop, 20),
        ]
        for (name, surface, input) in cases {
            var adapter = CodexAdapter(expectedSurface: surface)
            let observations = try consumeFixture(name, adapter: &adapter)
            XCTAssertEqual(observations.last?.state, .completed)
            XCTAssertEqual(observations.last?.surface, surface)
            XCTAssertEqual(observations.last?.usage.input, input)
            XCTAssertEqual(observations.last?.provider, .codex)
            XCTAssertEqual(observations.map(\.sequence), observations.map(\.sequence).sorted())
        }
    }

    func testUnverifiedFailureAndCancellationLabelsStayOpen() throws {
        for surface in [RunSurface.codexCLI, .codexDesktop] {
            let prefix = surface == .codexCLI ? "cli" : "desktop"
            var adapter = CodexAdapter(expectedSurface: surface)
            let observations = try consumeFixture("\(prefix)-failed-cancelled", adapter: &adapter)
            XCTAssertFalse(observations.contains { $0.state != .open })
            XCTAssertEqual(Set(observations.map(\.nativeID)).count, 2)
        }
    }

    func testReorderedUsageWaitsForIdentityAndDuplicatesAreStable() throws {
        let cases: [(String, RunSurface, Int64)] = [
            ("cli-duplicated-reordered", .codexCLI, 8),
            ("desktop-duplicated-reordered", .codexDesktop, 11),
        ]
        for (name, surface, expectedInput) in cases {
            var first = CodexAdapter(expectedSurface: surface)
            var replay = CodexAdapter(expectedSurface: surface)
            let observations = try consumeFixture(name, adapter: &first)
            let replayed = try consumeFixture(name, adapter: &replay)
            XCTAssertEqual(observations, replayed)
            XCTAssertEqual(observations.last?.state, .completed)
            XCTAssertEqual(observations.last?.usage.input, expectedInput)
            XCTAssertEqual(observations.last?.sequence, 6)
        }
    }

    func testParallelFixturesRemainDistinct() throws {
        for surface in [RunSurface.codexCLI, .codexDesktop] {
            let prefix = surface == .codexCLI ? "cli" : "desktop"
            var first = CodexAdapter(expectedSurface: surface)
            var second = CodexAdapter(expectedSurface: surface)
            let a = try consumeFixture("\(prefix)-parallel-a", adapter: &first)
            let b = try consumeFixture("\(prefix)-parallel-b", adapter: &second)
            XCTAssertNotEqual(a.last?.nativeID, b.last?.nativeID)
            XCTAssertNotEqual(a.last?.usage.input, b.last?.usage.input)
        }
    }

    func testPartialInvalidAndContentRecordsEmitNothing() throws {
        for surface in [RunSurface.codexCLI, .codexDesktop] {
            let prefix = surface == .codexCLI ? "cli" : "desktop"
            var adapter = CodexAdapter(expectedSurface: surface)
            let observations = try consumeFixture("\(prefix)-partial-line", adapter: &adapter)
            XCTAssertTrue(observations.allSatisfy { $0.state == .open })
            XCTAssertNotNil(observations.last)
        }
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        let forbidden = Data(#"{"timestamp":"2026-01-01T00:00:07Z","type":"response_item","payload":{"content":"DO_NOT_EXPORT_PROMPT","path":"DO_NOT_EXPORT_PATH"}}"#.utf8)
        XCTAssertTrue(adapter.consume(line: forbidden, source: .init(ordinal: 99), observedAt: observedAt).isEmpty)
    }

    func testInvalidUsageAndThreadTotalsNeverBecomeUsage() {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        let lines = [
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"source":"cli"}}"#,
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:00:02Z","type":"turn_context","payload":{"turn_id":"turn"}}"#,
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":999},"last_token_usage":{"input_tokens":true,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}}}"#,
        ]
        let output = lines.enumerated().flatMap { index, line in
            adapter.consume(line: Data(line.utf8), source: .init(ordinal: Int64(index)), observedAt: observedAt)
        }
        XCTAssertEqual(output.count, 1)
        XCTAssertEqual(output.last?.usage.input, 0)
    }

    func testSurfaceMustMatchVerifiedSessionMetadata() throws {
        var adapter = CodexAdapter(expectedSurface: .codexDesktop)
        let observations = try consumeFixture("cli-completed", adapter: &adapter)
        XCTAssertTrue(observations.isEmpty)
    }

    func testMatchingTurnContextProvidesBoundedDisplayMetadataOnly() throws {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        let lines = [
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"source":"cli","cwd":"DO_NOT_EXPORT_PATH"}}"#,
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:00:02Z","type":"turn_context","payload":{"turn_id":"turn-1","model":"gpt-test","effort":"high","content":"DO_NOT_EXPORT_PROMPT"}}"#,
        ]
        let output = lines.enumerated().flatMap { index, line in
            adapter.consume(line: Data(line.utf8), source: .init(ordinal: Int64(index)), observedAt: observedAt)
        }
        XCTAssertEqual(output.last?.model, "gpt-test")
        XCTAssertEqual(output.last?.effort, "high")
    }

    func testReorderedLifecycleFactsRemainPendingUntilStartAndIdentityResolve() throws {
        let data = try Data(contentsOf: fixtureURL("cli-completed"))
        let lines = data
            .split(separator: UInt8(0x0A), omittingEmptySubsequences: true)
            .map { Data($0) }
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        var output: [NativeRunObservation] = []
        for index in [0, 3, 6, 5, 1] {
            output += adapter.consume(
                line: lines[index],
                source: .init(ordinal: Int64(index)),
                observedAt: observedAt
            )
        }
        XCTAssertEqual(output.map(\.state), [.open, .completed])
        XCTAssertEqual(output.map(\.sequence), [3, 6])
        XCTAssertEqual(output.last?.usage.input, 10)
        XCTAssertEqual(output.last?.nativeID, "FAKE_CLI_TURN_COMPLETE")
    }

    func testSnapshotRestoresMidRunWithoutRescanningContent() throws {
        let data = try Data(contentsOf: fixtureURL("desktop-completed"))
        let lines = data
            .split(separator: UInt8(0x0A), omittingEmptySubsequences: true)
            .map { Data($0) }
        var adapter = CodexAdapter(expectedSurface: .codexDesktop)
        for index in 0...3 {
            _ = adapter.consume(
                line: lines[index], source: .init(ordinal: Int64(index)), observedAt: observedAt
            )
        }
        let snapshot = try adapter.snapshot()
        XCTAssertFalse(String(decoding: snapshot, as: UTF8.self).contains("DO_NOT_EXPORT"))
        var restored = try CodexAdapter(snapshot: snapshot)
        var tail: [NativeRunObservation] = []
        for index in 4...6 {
            tail += restored.consume(
                line: lines[index], source: .init(ordinal: Int64(index)), observedAt: observedAt
            )
        }
        XCTAssertEqual(tail.last?.state, .completed)
        XCTAssertEqual(tail.last?.usage.input, 20)
        XCTAssertEqual(tail.last?.nativeID, "FAKE_DESKTOP_TURN_COMPLETE")
        XCTAssertNoThrow(try CodexAdapter(snapshot: restored.snapshot()))
        XCTAssertThrowsError(try CodexAdapter(snapshot: Data("{}".utf8)))
        XCTAssertThrowsError(try CodexAdapter(snapshot: Data(repeating: 0x20, count: 65_537)))

        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: snapshot) as? [String: Any]
        )
        object["verifiedSurface"] = NSNull()
        let inconsistent = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try CodexAdapter(snapshot: inconsistent))

        object = try XCTUnwrap(JSONSerialization.jsonObject(with: snapshot) as? [String: Any])
        object["activeContextOrdinal"] = 0
        let impossibleOrdinal = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try CodexAdapter(snapshot: impossibleOrdinal))
    }

    func testReachableRejectedSurfaceSnapshotRestoresFailClosed() throws {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        let lines = [
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"source":"cli"}}"#,
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:00:02Z","type":"turn_context","payload":{"turn_id":"turn"}}"#,
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"session_meta","payload":{"source":{"desktop":true}}}"#,
        ]
        for (index, line) in lines.enumerated() {
            _ = adapter.consume(
                line: Data(line.utf8), source: .init(ordinal: Int64(index)), observedAt: observedAt
            )
        }
        var restored = try CodexAdapter(snapshot: adapter.snapshot())
        let completion = Data(#"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#.utf8)
        XCTAssertTrue(
            restored.consume(line: completion, source: .init(ordinal: 4), observedAt: observedAt).isEmpty
        )
    }

    func testDuplicateCompletionCannotRepeatOrStealTheNextTurn() {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        let lines = [
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"source":"cli"}}"#,
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:00:02Z","type":"turn_context","payload":{"turn_id":"turn-1"}}"#,
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}}}"#,
            #"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
            #"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
            #"{"timestamp":"2026-01-01T00:01:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:01:02Z","type":"turn_context","payload":{"turn_id":"turn-2"}}"#,
            #"{"timestamp":"2026-01-01T00:01:03Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]
        let output = lines.enumerated().flatMap { index, line in
            adapter.consume(
                line: Data(line.utf8), source: .init(ordinal: Int64(index)), observedAt: observedAt
            )
        }
        let terminals = output.filter { $0.state == .completed }
        XCTAssertEqual(terminals.map(\.nativeID), ["turn-1", "turn-2"])
        XCTAssertEqual(terminals.map(\.sequence), [4, 8])
    }

    func testEveryFixtureObservationPassesTheOutboundPrivacyGate() throws {
        let basePath = FileManager.default.temporaryDirectory.path
        let canonicalBase = URL(fileURLWithPath:
            basePath == "/var" || basePath.hasPrefix("/var/")
                ? "/private" + basePath
                : basePath
        )
        let root = canonicalBase
            .appendingPathComponent("runtime-raiders-fixture-privacy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let registry = try AdapterRegistry.enabled(
            surfaceNames: ["codex_cli", "codex_desktop"], codexRoot: root
        )
        let fixtures = try FileManager.default.contentsOfDirectory(
            at: fixtureURL(".").deletingLastPathComponent(),
            includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "jsonl" }
        var encodedCount = 0
        for fixture in fixtures {
            let surface: RunSurface = fixture.lastPathComponent.hasPrefix("cli-")
                ? .codexCLI : .codexDesktop
            var adapter = CodexAdapter(expectedSurface: surface)
            let data = try Data(contentsOf: fixture)
            for (index, line) in data.split(separator: UInt8(0x0A), omittingEmptySubsequences: true).enumerated() {
                for observation in adapter.consume(
                    line: Data(line), source: .init(ordinal: Int64(index)), observedAt: observedAt
                ) {
                    let event = try registry.event(
                        from: observation,
                        dedupeSecret: Data("fixture-secret".utf8),
                        companionVersion: "0.1.0",
                        deviceID: "00000000-0000-4000-8000-000000000001"
                    )
                    let encoded = try PrivacyEncoder().encode(event)
                    let text = String(decoding: encoded, as: UTF8.self)
                    XCTAssertFalse(text.contains("DO_NOT_EXPORT"))
                    XCTAssertFalse(text.contains(observation.nativeID))
                    encodedCount += 1
                }
            }
        }
        XCTAssertGreaterThan(encodedCount, 0)
    }

    private func consumeFixture(
        _ name: String,
        adapter: inout CodexAdapter
    ) throws -> [NativeRunObservation] {
        let data = try Data(contentsOf: fixtureURL(name))
        var output: [NativeRunObservation] = []
        for (index, line) in data.split(separator: 0x0A, omittingEmptySubsequences: true).enumerated() {
            output += adapter.consume(
                line: Data(line),
                source: ProviderRecordSource(ordinal: Int64(index)),
                observedAt: observedAt
            )
        }
        return output
    }

    private func fixtureURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/codex/\(name).jsonl")
    }
}

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
            XCTAssertEqual(observations.last?.sequence, 7)
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

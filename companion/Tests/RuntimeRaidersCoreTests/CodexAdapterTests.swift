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
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
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

    func testVscodeRootClassifiesOnlyAsDesktopAcrossBoundedVersions() throws {
        for version in ["0.146.0-alpha.3.1", "0.146.0-alpha.9.2", "1.0.0"] {
            var desktop = CodexAdapter(expectedSurface: .codexDesktop)
            var cli = CodexAdapter(expectedSurface: .codexCLI)
            let payload: [String: Any] = [
                "id": "session", "originator": "originator", "cli_version": version,
                "source": "vscode",
            ]
            XCTAssertEqual(try startRun(adapter: &desktop, payload: payload).count, 1)
            XCTAssertTrue(try startRun(adapter: &cli, payload: payload).isEmpty)
        }
    }

    func testExecRootClassifiesOnlyAsCLIAcrossBoundedVersions() throws {
        for version in ["0.146.0-alpha.3.1", "0.146.0-alpha.9.2", "1.0.0"] {
            var cli = CodexAdapter(expectedSurface: .codexCLI)
            var desktop = CodexAdapter(expectedSurface: .codexDesktop)
            let payload: [String: Any] = [
                "id": "session", "originator": "originator", "cli_version": version,
                "source": "exec",
            ]
            XCTAssertEqual(try startRun(adapter: &cli, payload: payload).count, 1)
            XCTAssertTrue(try startRun(adapter: &desktop, payload: payload).isEmpty)
        }
    }

    func testStrictSubagentObjectRemainsDesktop() throws {
        let payload: [String: Any] = [
            "id": "session", "originator": "originator", "cli_version": "1.0.0",
            "source": desktopSource(),
        ]
        var desktop = CodexAdapter(expectedSurface: .codexDesktop)
        var cli = CodexAdapter(expectedSurface: .codexCLI)
        XCTAssertEqual(try startRun(adapter: &desktop, payload: payload).count, 1)
        XCTAssertTrue(try startRun(adapter: &cli, payload: payload).isEmpty)
    }

    func testMalformedOrOversizedVersionFailsClosedWithContractReason() throws {
        let rejectedVersions: [Any?] = [nil, 146, "", String(repeating: "v", count: 101)]
        for version in rejectedVersions {
            var payload = validSessionPayload(for: .codexCLI)
            if let version { payload["cli_version"] = version } else { payload.removeValue(forKey: "cli_version") }
            var adapter = CodexAdapter(expectedSurface: .codexCLI)
            XCTAssertTrue(try startRun(adapter: &adapter, payload: payload).isEmpty)
            XCTAssertEqual(adapter.compatibilityIssue, .unsupportedContract)
        }
    }

    func testUnknownSourceFailsClosedWithSourceReason() throws {
        var payload = validSessionPayload(for: .codexCLI)
        payload["source"] = "unknown"
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        XCTAssertTrue(try startRun(adapter: &adapter, payload: payload).isEmpty)
        XCTAssertEqual(adapter.compatibilityIssue, .unsupportedSource)
    }

    func testCompatibilityReasonSurvivesSnapshotWithoutContent() throws {
        var payload = validSessionPayload(for: .codexCLI)
        payload["cli_version"] = ""
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        XCTAssertTrue(try startRun(adapter: &adapter, payload: payload).isEmpty)
        let snapshot = try adapter.snapshot()
        XCTAssertTrue(String(decoding: snapshot, as: UTF8.self).contains("unsupported_contract"))
        XCTAssertFalse(String(decoding: snapshot, as: UTF8.self).contains("source"))
        XCTAssertEqual(try CodexAdapter(snapshot: snapshot).compatibilityIssue, .unsupportedContract)
    }

    func testActiveRunStateSurvivesSnapshotWithoutExposingNativeID() throws {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        XCTAssertEqual(try startRun(adapter: &adapter, payload: validSessionPayload(for: .codexCLI)).count, 1)
        XCTAssertTrue(adapter.hasActiveRun)
        let snapshot = try adapter.snapshot()
        XCTAssertFalse(String(decoding: snapshot, as: UTF8.self).contains("source"))
        XCTAssertTrue(try CodexAdapter(snapshot: snapshot).hasActiveRun)
    }

    func testTokenRegressionFailsClosedWithContractReason() throws {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        _ = try startRun(adapter: &adapter, payload: validSessionPayload(for: .codexCLI))
        _ = adapter.consume(
            line: Data(#"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":4,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}}}"#.utf8),
            source: .init(ordinal: 3), observedAt: observedAt
        )
        XCTAssertTrue(adapter.consume(
            line: Data(#"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}}}"#.utf8),
            source: .init(ordinal: 4), observedAt: observedAt
        ).isEmpty)
        XCTAssertEqual(adapter.compatibilityIssue, .unsupportedContract)
        XCTAssertFalse(adapter.hasActiveRun)
    }

    func testPreStartEventTimestampFailsClosedWithContractReason() throws {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        _ = adapter.consume(
            line: try sessionMetadata(payload: validSessionPayload(for: .codexCLI), timestampSecond: 0),
            source: .init(ordinal: 0), observedAt: observedAt
        )
        _ = adapter.consume(
            line: Data(#"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"task_started"}}"#.utf8),
            source: .init(ordinal: 1), observedAt: observedAt
        )
        _ = adapter.consume(
            line: Data(#"{"timestamp":"2026-01-01T00:00:03Z","type":"turn_context","payload":{"turn_id":"turn"}}"#.utf8),
            source: .init(ordinal: 2), observedAt: observedAt
        )
        XCTAssertTrue(adapter.consume(
            line: Data(#"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}}}"#.utf8),
            source: .init(ordinal: 3), observedAt: observedAt
        ).isEmpty)
        XCTAssertEqual(adapter.compatibilityIssue, .unsupportedContract)
        XCTAssertFalse(adapter.hasActiveRun)
    }

    func testMalformedSessionProvenanceRejectsFilesPermanently() throws {
        for surface in [RunSurface.codexCLI, .codexDesktop] {
            let valid = validSessionPayload(for: surface)
            var cases: [(name: String, payload: [String: Any])] = []

            var missingID = valid
            missingID.removeValue(forKey: "id")
            cases.append(("missing id", missingID))
            cases.append(("wrong-type id", valid.merging(["id": 7]) { _, new in new }))
            cases.append(("empty id", valid.merging(["id": ""]) { _, new in new }))

            var missingOriginator = valid
            missingOriginator.removeValue(forKey: "originator")
            cases.append(("missing originator", missingOriginator))
            cases.append((
                "wrong-type originator",
                valid.merging(["originator": false]) { _, new in new }
            ))
            cases.append((
                "empty originator",
                valid.merging(["originator": ""]) { _, new in new }
            ))

            if surface == .codexCLI {
                cases.append((
                    "empty CLI source",
                    valid.merging(["source": ""]) { _, new in new }
                ))
            } else {
                cases.append((
                    "empty Desktop source",
                    valid.merging(["source": [String: Any]()]) { _, new in new }
                ))
                cases.append((
                    "arbitrary Desktop source",
                    valid.merging(["source": ["desktop": true]]) { _, new in new }
                ))
                cases.append((
                    "incomplete Desktop source",
                    valid.merging([
                        "source": ["subagent": ["thread_spawn": ["depth": 1]]],
                    ]) { _, new in new }
                ))
                var wrongDepth = desktopSource()
                var subagent = wrongDepth["subagent"] as! [String: Any]
                var threadSpawn = subagent["thread_spawn"] as! [String: Any]
                threadSpawn["depth"] = "1"
                subagent["thread_spawn"] = threadSpawn
                wrongDepth["subagent"] = subagent
                cases.append((
                    "wrong-type Desktop marker",
                    valid.merging(["source": wrongDepth]) { _, new in new }
                ))
            }

            for invalid in cases {
                var adapter = CodexAdapter(expectedSurface: surface)
                var output = adapter.consume(
                    line: try sessionMetadata(payload: invalid.payload, timestampSecond: 0),
                    source: .init(ordinal: 0),
                    observedAt: observedAt
                )
                output += adapter.consume(
                    line: try sessionMetadata(
                        payload: validSessionPayload(for: surface),
                        timestampSecond: 1
                    ),
                    source: .init(ordinal: 1),
                    observedAt: observedAt
                )
                let lifecycle = [
                    #"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"task_started"}}"#,
                    #"{"timestamp":"2026-01-01T00:00:03Z","type":"turn_context","payload":{"turn_id":"rejected-turn"}}"#,
                    #"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
                ]
                for (offset, line) in lifecycle.enumerated() {
                    output += adapter.consume(
                        line: Data(line.utf8),
                        source: .init(ordinal: Int64(offset + 2)),
                        observedAt: observedAt
                    )
                }

                XCTAssertTrue(
                    output.isEmpty,
                    "\(surface) accepted \(invalid.name)"
                )
                XCTAssertNoThrow(try CodexAdapter(snapshot: adapter.snapshot()))
            }
        }
    }

    func testIdentifiableMalformedSessionMetadataRejectsFilesPermanently() throws {
        let malformed = [
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta"}"#,
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":"invalid"}"#,
            #"{"type":"session_meta","payload":{}}"#,
            #"{"timestamp":"not-a-time","type":"session_meta","payload":{}}"#,
        ]
        let lifecycle = [
            #"{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"turn_context","payload":{"turn_id":"rejected-turn"}}"#,
            #"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]
        for (index, invalid) in malformed.enumerated() {
            var adapter = CodexAdapter(expectedSurface: .codexCLI)
            var output = adapter.consume(
                line: Data(invalid.utf8),
                source: .init(ordinal: 0),
                observedAt: observedAt
            )
            output += adapter.consume(
                line: try sessionMetadata(
                    payload: validSessionPayload(for: .codexCLI),
                    timestampSecond: 1
                ),
                source: .init(ordinal: 1),
                observedAt: observedAt
            )
            for (offset, line) in lifecycle.enumerated() {
                output += adapter.consume(
                    line: Data(line.utf8),
                    source: .init(ordinal: Int64(offset + 2)),
                    observedAt: observedAt
                )
            }

            XCTAssertTrue(output.isEmpty, "accepted malformed session case \(index)")
            XCTAssertNoThrow(try CodexAdapter(snapshot: adapter.snapshot()))
        }
    }

    func testMatchingTurnContextProvidesBoundedDisplayMetadataOnly() throws {
        var adapter = CodexAdapter(expectedSurface: .codexCLI)
        let lines = [
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1","cwd":"DO_NOT_EXPORT_PATH"}}"#,
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
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:00:02Z","type":"turn_context","payload":{"turn_id":"turn"}}"#,
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":{"subagent":{"thread_spawn":{"agent_nickname":"agent","agent_path":"path","agent_role":null,"depth":1,"parent_thread_id":"parent"}}},"cli_version":"0.146.0-alpha.3.1"}}"#,
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
            #"{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session","originator":"originator","source":"exec","cli_version":"0.146.0-alpha.3.1"}}"#,
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

    private func sessionMetadata(
        payload: [String: Any],
        timestampSecond: Int
    ) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "timestamp": String(format: "2026-01-01T00:00:%02dZ", timestampSecond),
            "type": "session_meta",
            "payload": payload,
        ])
    }

    private func validSessionPayload(for surface: RunSurface) -> [String: Any] {
        [
            "id": "session",
            "originator": "originator",
            "cli_version": "0.146.0-alpha.3.1",
            "source": surface == .codexCLI ? "exec" : "vscode",
        ]
    }

    private func startRun(
        adapter: inout CodexAdapter,
        payload: [String: Any]
    ) throws -> [NativeRunObservation] {
        _ = adapter.consume(
            line: try sessionMetadata(payload: payload, timestampSecond: 0),
            source: .init(ordinal: 0), observedAt: observedAt
        )
        _ = adapter.consume(
            line: Data(#"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#.utf8),
            source: .init(ordinal: 1), observedAt: observedAt
        )
        return adapter.consume(
            line: Data(#"{"timestamp":"2026-01-01T00:00:02Z","type":"turn_context","payload":{"turn_id":"turn"}}"#.utf8),
            source: .init(ordinal: 2), observedAt: observedAt
        )
    }

    private func desktopSource() -> [String: Any] {
        [
            "subagent": [
                "thread_spawn": [
                    "agent_nickname": "agent",
                    "agent_path": "path",
                    "agent_role": NSNull(),
                    "depth": 1,
                    "parent_thread_id": "parent",
                ] as [String: Any],
            ] as [String: Any],
        ]
    }

    private func fixtureURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/codex/\(name).jsonl")
    }
}

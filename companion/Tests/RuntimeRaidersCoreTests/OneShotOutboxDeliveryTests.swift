import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class OneShotOutboxDeliveryTests: XCTestCase {
    func testDrainSendsOneHundredOneHundredFiveWithOldBearerAndAcknowledgesAfterEachResponse() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            for sequence in 0..<205 {
                try outbox.enqueue(makeEvent(sequence: Int64(sequence)))
            }
            var requests: [URLRequest] = []
            var countsObservedInsideTransport: [Int] = []
            let expectedResponseCounts = [100, 100, 5]
            let delivery = try OneShotOutboxDelivery(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://127.0.0.1:8765")!,
                    deviceToken: "OLD_DEVICE_BEARER_DO_NOT_EXPORT",
                    allowsTestOrigin: true
                ),
                transport: { request in
                    countsObservedInsideTransport.append(try outbox.queuedCount())
                    requests.append(request)
                    let count = expectedResponseCounts[requests.count - 1]
                    return .init(
                        statusCode: 200,
                        body: Data("{\"accepted\":\(count),\"duplicate\":0,\"ignored\":0}".utf8)
                    )
                }
            )

            XCTAssertEqual(try delivery.drain(), 205)

            XCTAssertEqual(countsObservedInsideTransport, [205, 105, 5])
            XCTAssertEqual(try outbox.queuedCount(), 0)
            XCTAssertEqual(try requests.map(batchSize), [100, 100, 5])
            XCTAssertTrue(requests.allSatisfy {
                $0.value(forHTTPHeaderField: "Authorization") == "Bearer OLD_DEVICE_BEARER_DO_NOT_EXPORT"
            })
            XCTAssertTrue(requests.allSatisfy {
                $0.url?.absoluteString == "http://127.0.0.1:8765/api/runs/events"
                    && $0.httpMethod == "POST"
                    && $0.timeoutInterval == 2
                    && $0.value(forHTTPHeaderField: "Content-Type") == "application/json"
            })
        }
    }

    func testSecondBatchFailureKeepsUnsentOneHundredFiveRecords() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            for sequence in 0..<205 {
                try outbox.enqueue(makeEvent(sequence: Int64(sequence)))
            }
            var calls = 0
            let delivery = try OneShotOutboxDelivery(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "old-device-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in
                    calls += 1
                    if calls == 1 {
                        return .init(
                            statusCode: 200,
                            body: Data(#"{"accepted":100,"duplicate":0,"ignored":0}"#.utf8)
                        )
                    }
                    return .init(statusCode: 503, body: Data())
                }
            )

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertEqual(calls, 2)
            XCTAssertEqual(try outbox.queuedCount(), 105)
        }
    }

    func testMalformedOwnedRecordFailsBeforeFirstRequestAndLeavesQueueUntouched() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let malformed = directory.appendingPathComponent(String(repeating: "f", count: 64) + ".json")
            try Data("malformed".utf8).write(to: malformed)
            XCTAssertEqual(Darwin.chmod(malformed.path, 0o600), 0)
            var calls = 0
            let delivery = try OneShotOutboxDelivery(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "old-device-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in
                    calls += 1
                    return .init(statusCode: 200, body: Data())
                }
            )

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertEqual(calls, 0)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 2)
        }
    }

    func testDrainDoesNotMutateUnrelatedCollectorOrHeartbeatState() throws {
        try withTemporaryDirectory { directory in
            let outboxDirectory = directory.appendingPathComponent("outbox", isDirectory: true)
            let outbox = try Outbox(directory: outboxDirectory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let state = directory.appendingPathComponent("collector-state.json")
            let sentinel = Data(#"{"enabled":false,"heartbeat":"unchanged"}"#.utf8)
            try sentinel.write(to: state)
            let delivery = try OneShotOutboxDelivery(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "old-device-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in
                    .init(
                        statusCode: 200,
                        body: Data(#"{"accepted":1,"duplicate":0,"ignored":0}"#.utf8)
                    )
                }
            )

            XCTAssertEqual(try delivery.drain(), 1)
            XCTAssertEqual(try Data(contentsOf: state), sentinel)
        }
    }

    private func batchSize(_ request: URLRequest) throws -> Int {
        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        return try XCTUnwrap(object["events"] as? [Any]).count
    }

    private func makeEvent(sequence: Int64) -> RunEventV1 {
        RunEventV1(
            schemaVersion: 1,
            companionVersion: "0.4.8",
            deviceID: "00000000-0000-4000-8000-000000000001",
            provider: .codex,
            surface: .codexCLI,
            runKey: String(repeating: "a", count: 64),
            sequence: sequence,
            eventTimeMS: 1_700_000_000_500 + sequence,
            observedAtMS: 1_700_000_001_000 + sequence,
            startedAtMS: 1_700_000_000_000,
            state: .open,
            usage: .init(
                input: sequence,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoningOutput: 0
            ),
            model: nil,
            effort: nil,
            idempotencyKey: String(format: "%064llx", sequence + 1)
        )
    }

    private func withTemporaryDirectory(_ body: (URL) throws -> Void) throws {
        let temporary = FileManager.default.temporaryDirectory
        let canonicalTemporary = temporary.path == "/var" || temporary.path.hasPrefix("/var/")
            ? URL(fileURLWithPath: "/private" + temporary.path, isDirectory: true)
            : temporary
        let root = canonicalTemporary
            .appendingPathComponent("runtime-raiders-one-shot-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }
}

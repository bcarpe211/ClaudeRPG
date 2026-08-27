import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class OneShotOutboxDeliveryTests: XCTestCase {
    func testDrainSendsOneHundredOneHundredFiveWithOldBearerAndAcknowledgesAfterEachResponse() throws {
        try withTemporaryDirectory { directory in
            let synchronizations = DeliverySynchronizationCounter()
            let outbox = try Outbox(
                directory: directory,
                directorySynchronizationObserver: synchronizations.record
            )
            for sequence in 0..<205 {
                try outbox.enqueue(makeEvent(sequence: Int64(sequence)))
            }
            let synchronizationsBeforeDrain = synchronizations.count
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
            XCTAssertEqual(synchronizations.count, synchronizationsBeforeDrain + 3)
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

    func testMalformedRecordArrivingAfterAcceptedBatchStopsBeforeNextRequest() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            for sequence in 0..<101 {
                try outbox.enqueue(makeEvent(sequence: Int64(sequence)))
            }
            var calls = 0
            let delivery = try makeDelivery(outbox: outbox) { _ in
                calls += 1
                let malformed = directory.appendingPathComponent(
                    String(repeating: "f", count: 64) + ".json"
                )
                try Data("malformed".utf8).write(to: malformed)
                XCTAssertEqual(Darwin.chmod(malformed.path, 0o600), 0)
                return self.accepted(count: 100)
            }

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertEqual(calls, 1)
            XCTAssertEqual(try outbox.queuedCount(), 1)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 2)
        }
    }

    func testMalformedOwnedRecordFailsBeforeFirstRequestAndLeavesQueueUntouched() throws {
        try withTemporaryDirectory { directory in
            let synchronizations = DeliverySynchronizationCounter()
            let outbox = try Outbox(
                directory: directory,
                directorySynchronizationObserver: synchronizations.record
            )
            try outbox.enqueue(makeEvent(sequence: 1))
            let malformed = directory.appendingPathComponent(String(repeating: "f", count: 64) + ".json")
            try Data("malformed".utf8).write(to: malformed)
            XCTAssertEqual(Darwin.chmod(malformed.path, 0o600), 0)
            var calls = 0
            let synchronizationsBeforeDrain = synchronizations.count
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
            XCTAssertEqual(synchronizations.count, synchronizationsBeforeDrain)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 2)
        }
    }

    func testOwnedOversizedRecordFailsBeforeFirstRequest() throws {
        try assertInvalidOwnedEntryFailsBeforeRequest { directory in
            let oversized = directory.appendingPathComponent(String(repeating: "c", count: 64) + ".json")
            try Data(repeating: 0x78, count: 64 * 1_024 + 1).write(to: oversized)
            XCTAssertEqual(Darwin.chmod(oversized.path, 0o600), 0)
        }
    }

    func testOwnedDirectoryFailsBeforeFirstRequest() throws {
        try assertInvalidOwnedEntryFailsBeforeRequest { directory in
            try FileManager.default.createDirectory(
                at: directory.appendingPathComponent(
                    String(repeating: "c", count: 64) + ".json",
                    isDirectory: true
                ),
                withIntermediateDirectories: false
            )
        }
    }

    func testOwnedFIFOTransferFailsBeforeFirstRequest() throws {
        try assertInvalidOwnedEntryFailsBeforeRequest { directory in
            let fifo = directory.appendingPathComponent(String(repeating: "c", count: 64) + ".json")
            XCTAssertEqual(Darwin.mkfifo(fifo.path, 0o600), 0)
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

    func testAcceptedResponseDoesNotAcknowledgeSameNameReplacement() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let record = try XCTUnwrap(outbox.records(limit: 1).first)
            var calls = 0
            let delivery = try makeDelivery(outbox: outbox) { _ in
                calls += 1
                try FileManager.default.removeItem(at: record.url)
                try record.encodedEvent.write(to: record.url)
                XCTAssertEqual(Darwin.chmod(record.url.path, 0o600), 0)
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertEqual(calls, 1)
            XCTAssertTrue(FileManager.default.fileExists(atPath: record.url.path))
            if FileManager.default.fileExists(atPath: record.url.path) {
                XCTAssertEqual(try Data(contentsOf: record.url), record.encodedEvent)
            }
        }
    }

    func testAcceptedResponseDoesNotTreatUnlinkedUploadedRecordAsAcknowledged() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let record = try XCTUnwrap(outbox.records(limit: 1).first)
            let delivery = try makeDelivery(outbox: outbox) { _ in
                try FileManager.default.removeItem(at: record.url)
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())
        }
    }

    func testAcceptedResponseDoesNotAcknowledgeSymlinkReplacement() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let record = try XCTUnwrap(outbox.records(limit: 1).first)
            let target = directory.appendingPathComponent("unowned-target")
            let targetData = Data("unowned".utf8)
            try targetData.write(to: target)
            let delivery = try makeDelivery(outbox: outbox) { _ in
                try FileManager.default.removeItem(at: record.url)
                try FileManager.default.createSymbolicLink(at: record.url, withDestinationURL: target)
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertEqual(try Data(contentsOf: target), targetData)
            XCTAssertTrue(FileManager.default.fileExists(atPath: record.url.path))
        }
    }

    func testAcceptedResponseDoesNotAcknowledgeChangedRecordMetadata() throws {
        try withTemporaryDirectory { directory in
            let synchronizations = DeliverySynchronizationCounter()
            let outbox = try Outbox(
                directory: directory,
                directorySynchronizationObserver: synchronizations.record
            )
            try outbox.enqueue(makeEvent(sequence: 1))
            let record = try XCTUnwrap(outbox.records(limit: 1).first)
            let synchronizationsBeforeDrain = synchronizations.count
            let delivery = try makeDelivery(outbox: outbox) { _ in
                XCTAssertEqual(Darwin.chmod(record.url.path, 0o640), 0)
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertEqual(synchronizations.count, synchronizationsBeforeDrain)
            XCTAssertTrue(FileManager.default.fileExists(atPath: record.url.path))
        }
    }

    func testAcceptedResponseDoesNotAcknowledgeRecordHardLinkedDuringTransport() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let record = try XCTUnwrap(outbox.records(limit: 1).first)
            let hardLink = directory.appendingPathComponent("unowned-hard-link")
            let delivery = try makeDelivery(outbox: outbox) { _ in
                try FileManager.default.linkItem(at: record.url, to: hardLink)
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertTrue(FileManager.default.fileExists(atPath: record.url.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: hardLink.path))
        }
    }

    func testAcceptedResponseDoesNotAcknowledgeChangedCanonicalContent() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let record = try XCTUnwrap(outbox.records(limit: 1).first)
            var replacement = record.event
            replacement.usage.input += 1
            let replacementData = try PrivacyEncoder().encode(replacement)
            let originalInode = try inode(of: record.url)
            let delivery = try makeDelivery(outbox: outbox) { _ in
                try self.overwrite(record.url, with: replacementData)
                XCTAssertEqual(try self.inode(of: record.url), originalInode)
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertTrue(FileManager.default.fileExists(atPath: record.url.path))
            if FileManager.default.fileExists(atPath: record.url.path) {
                XCTAssertEqual(try Data(contentsOf: record.url), replacementData)
            }
        }
    }

    func testAcceptedResponseDoesNotAcknowledgeAfterOutboxDirectoryPathSwap() throws {
        try withTemporaryDirectory { root in
            let directory = root.appendingPathComponent("outbox", isDirectory: true)
            let moved = root.appendingPathComponent("moved-outbox", isDirectory: true)
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let record = try XCTUnwrap(outbox.records(limit: 1).first)
            let delivery = try makeDelivery(outbox: outbox) { _ in
                try FileManager.default.moveItem(at: directory, to: moved)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                XCTAssertEqual(Darwin.chmod(directory.path, 0o700), 0)
                try Data("replacement".utf8).write(
                    to: directory.appendingPathComponent("replacement.txt")
                )
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())

            XCTAssertTrue(FileManager.default.fileExists(
                atPath: moved.appendingPathComponent(record.url.lastPathComponent).path
            ))
            XCTAssertEqual(
                try Data(contentsOf: directory.appendingPathComponent("replacement.txt")),
                Data("replacement".utf8)
            )
        }
    }

    private func batchSize(_ request: URLRequest) throws -> Int {
        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        return try XCTUnwrap(object["events"] as? [Any]).count
    }

    private func makeDelivery(
        outbox: Outbox,
        transport: @escaping Uploader.Transport
    ) throws -> OneShotOutboxDelivery {
        try OneShotOutboxDelivery(
            outbox: outbox,
            configuration: .init(
                origin: URL(string: "http://localhost:8765")!,
                deviceToken: "old-device-token",
                allowsTestOrigin: true
            ),
            transport: transport
        )
    }

    private func assertInvalidOwnedEntryFailsBeforeRequest(
        preparing: (URL) throws -> Void
    ) throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try preparing(directory)
            var calls = 0
            let delivery = try makeDelivery(outbox: outbox) { _ in
                calls += 1
                return self.accepted(count: 1)
            }

            XCTAssertThrowsError(try delivery.drain())
            XCTAssertEqual(calls, 0)
        }
    }

    private func accepted(count: Int) -> UploadHTTPResponse {
        .init(
            statusCode: 200,
            body: Data("{\"accepted\":\(count),\"duplicate\":0,\"ignored\":0}".utf8)
        )
    }

    private func inode(of url: URL) throws -> ino_t {
        var metadata = stat()
        guard Darwin.lstat(url.path, &metadata) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return metadata.st_ino
    }

    private func overwrite(_ url: URL, with data: Data) throws {
        let descriptor = Darwin.open(url.path, O_WRONLY | O_TRUNC | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { Darwin.close(descriptor) }
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(
                    descriptor,
                    base.advanced(by: offset),
                    bytes.count - offset
                )
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            }
        }
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

private final class DeliverySynchronizationCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    var count: Int { lock.withLock { stored } }
    func record() { lock.withLock { stored += 1 } }
}

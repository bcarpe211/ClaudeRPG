import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class UploaderTests: XCTestCase {
    func testAcknowledged200UploadsAtMostOneHundredAndDeletesTheEntireBatch() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            for sequence in 0..<101 {
                try outbox.enqueue(makeEvent(sequence: Int64(sequence)))
            }
            var captured: URLRequest?
            let uploader = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://127.0.0.1:8765")!,
                    deviceToken: "DO_NOT_EXPORT_DEVICE_TOKEN",
                    allowsTestOrigin: true
                ),
                transport: { request in
                    captured = request
                    return UploadHTTPResponse(
                        statusCode: 200,
                        body: Data(#"{"accepted":98,"duplicate":1,"ignored":1}"#.utf8)
                    )
                },
                clockMS: { 10_000 },
                jitterMS: { $0 }
            )

            XCTAssertEqual(try uploader.performAttempt(enabled: true), .uploaded(100))
            XCTAssertEqual(try outbox.queuedCount(), 1)
            XCTAssertEqual(captured?.url?.absoluteString, "http://127.0.0.1:8765/api/runs/events")
            XCTAssertEqual(captured?.httpMethod, "POST")
            XCTAssertEqual(captured?.timeoutInterval, 2)
            XCTAssertEqual(captured?.value(forHTTPHeaderField: "Authorization"), "Bearer DO_NOT_EXPORT_DEVICE_TOKEN")
            let body = try XCTUnwrap(captured?.httpBody)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual((object["events"] as? [Any])?.count, 100)
        }
    }

    func testFailuresAndInvalidAcknowledgementsRetainQueueAndBackOffWithBoundedJitter() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            var now: Int64 = 20_000
            var response = UploadHTTPResponse(
                statusCode: 503,
                body: Data(#"{"error":"scoring_disabled"}"#.utf8)
            )
            let uploader = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "synthetic-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in response },
                clockMS: { now },
                jitterMS: { _ in Int64.max }
            )

            XCTAssertEqual(try uploader.performAttempt(enabled: true), .retryScheduled(atMS: 26_000))
            XCTAssertEqual(try outbox.queuedCount(), 1)
            now = 25_999
            XCTAssertEqual(try uploader.performAttempt(enabled: true), .waiting(untilMS: 26_000))
            now = 26_000
            response = UploadHTTPResponse(
                statusCode: 200,
                body: Data(#"{"accepted":0,"duplicate":0,"ignored":0}"#.utf8)
            )
            XCTAssertEqual(try uploader.performAttempt(enabled: true), .retryScheduled(atMS: 38_000))
            XCTAssertEqual(try outbox.queuedCount(), 1)

            now = 38_000
            for _ in 0..<10 {
                let result = try uploader.performAttempt(enabled: true)
                guard case let .retryScheduled(next) = result else {
                    return XCTFail("expected retry, got \(result)")
                }
                XCTAssertLessThanOrEqual(next - now, 300_000)
                now = next
            }
        }
    }

    func testOffNeverCallsTransportAndProductionOriginMustMatchExactly() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            var calls = 0
            let production = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "https://raiders.redlattice.com")!,
                    deviceToken: "synthetic-token"
                ),
                transport: { _ in
                    calls += 1
                    return .init(statusCode: 200, body: Data(#"{"accepted":1,"duplicate":0,"ignored":0}"#.utf8))
                }
            )
            XCTAssertEqual(try production.performAttempt(enabled: false), .disabled)
            XCTAssertEqual(calls, 0)
            XCTAssertEqual(try outbox.queuedCount(), 1)

            for origin in [
                "http://raiders.redlattice.com",
                "https://raiders.redlattice.com.evil.test",
                "https://raiders.redlattice.com:444",
                "https://raiders.redlattice.com/path",
            ] {
                XCTAssertThrowsError(
                    try Uploader(
                        outbox: outbox,
                        configuration: .init(origin: URL(string: origin)!, deviceToken: "token"),
                        transport: { _ in throw SyntheticTransportError.failed }
                    ),
                    origin
                )
            }
        }
    }

    func testEveryAttemptPrunesExpiredQueueBeforeSelectingUploadBatch() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory, maximumAgeMS: 1_000)
            try outbox.enqueue(makeEvent(sequence: 1))
            var calls = 0
            let uploader = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "synthetic-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in
                    calls += 1
                    return .init(statusCode: 200, body: Data())
                },
                clockMS: { 1_700_000_010_000 }
            )

            XCTAssertEqual(try uploader.performAttempt(enabled: true), .empty)
            XCTAssertEqual(calls, 0)
            XCTAssertEqual(try outbox.queuedCount(), 0)
        }
    }

    func testTurningOffDuringInFlightRequestRetainsBatchWhenResponseArrives() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let started = DispatchSemaphore(value: 0)
            let release = DispatchSemaphore(value: 0)
            let finished = DispatchSemaphore(value: 0)
            let captured = UploadResultBox()
            let uploader = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "synthetic-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in
                    started.signal()
                    release.wait()
                    return .init(
                        statusCode: 200,
                        body: Data(#"{"accepted":1,"duplicate":0,"ignored":0}"#.utf8)
                    )
                },
                clockMS: { 1_700_000_002_000 }
            )

            uploader.schedule(enabled: true) { result in
                captured.set(result)
                finished.signal()
            }
            XCTAssertEqual(started.wait(timeout: .now() + 2), .success)
            uploader.setEnabled(false)
            release.signal()
            XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)

            XCTAssertEqual(captured.value, .disabled)
            XCTAssertEqual(try outbox.queuedCount(), 1)
        }
    }

    func testOffCancelsOwnedInFlightUploaderAndHeartbeatRequests() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let uploadStarted = DispatchSemaphore(value: 0)
            let uploadCancelled = DispatchSemaphore(value: 0)
            let uploadRelease = DispatchSemaphore(value: 0)
            let uploader = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "synthetic-token",
                    allowsTestOrigin: true
                ),
                cancellableTransport: { _, cancellation in
                    cancellation.register {
                        uploadCancelled.signal()
                        uploadRelease.signal()
                    }
                    uploadStarted.signal()
                    uploadRelease.wait()
                    throw URLError(.cancelled)
                },
                clockMS: { 1_700_000_002_000 }
            )
            uploader.schedule(enabled: true)
            XCTAssertEqual(uploadStarted.wait(timeout: .now() + 2), .success)
            uploader.setEnabled(false)
            XCTAssertEqual(uploadCancelled.wait(timeout: .now() + 2), .success)

            let heartbeatStarted = DispatchSemaphore(value: 0)
            let heartbeatCancelled = DispatchSemaphore(value: 0)
            let heartbeatRelease = DispatchSemaphore(value: 0)
            let heartbeat = try Heartbeat(
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "synthetic-token",
                    allowsTestOrigin: true
                ),
                companionVersion: "0.2.0",
                cancellableTransport: { _, cancellation in
                    cancellation.register {
                        heartbeatCancelled.signal()
                        heartbeatRelease.signal()
                    }
                    heartbeatStarted.signal()
                    heartbeatRelease.wait()
                    throw URLError(.cancelled)
                }
            )
            heartbeat.setEnabled(true)
            XCTAssertEqual(heartbeatStarted.wait(timeout: .now() + 2), .success)
            heartbeat.setEnabled(false)
            XCTAssertEqual(heartbeatCancelled.wait(timeout: .now() + 2), .success)
        }
    }

    func testEnabledLoopAutomaticallyRetriesAndDrainsExistingQueue() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            try outbox.enqueue(makeEvent(sequence: 1))
            let attempts = IntegerBox()
            let clock = IntegerBox()
            let finished = DispatchSemaphore(value: 0)
            let scheduledDelay = IntegerBox()
            let uploader = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "synthetic-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in
                    let attempt = attempts.increment()
                    if attempt == 1 {
                        return .init(statusCode: 503, body: Data())
                    }
                    return .init(
                        statusCode: 200,
                        body: Data(#"{"accepted":1,"duplicate":0,"ignored":0}"#.utf8)
                    )
                },
                clockMS: { Int64(clock.value) },
                jitterMS: { $0 },
                retryScheduler: { delay, action in
                    scheduledDelay.set(Int(delay))
                    clock.add(Int(delay))
                    action()
                }
            )

            uploader.schedule(enabled: true) { result in
                if result == .uploaded(1) { finished.signal() }
            }
            XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)

            XCTAssertEqual(attempts.value, 2)
            XCTAssertEqual(scheduledDelay.value, 5_000)
            XCTAssertEqual(try outbox.queuedCount(), 0)
        }
    }

    func testWakeArrivingBetweenEmptyObservationAndIdleTransitionIsNotLost() throws {
        try withTemporaryDirectory { directory in
            let outbox = try Outbox(directory: directory)
            let holder = UploaderBox()
            let hookCalls = IntegerBox()
            let finished = DispatchSemaphore(value: 0)
            let event = makeEvent(sequence: 1)
            let uploader = try Uploader(
                outbox: outbox,
                configuration: .init(
                    origin: URL(string: "http://localhost:8765")!,
                    deviceToken: "synthetic-token",
                    allowsTestOrigin: true
                ),
                transport: { _ in
                    .init(
                        statusCode: 200,
                        body: Data(#"{"accepted":1,"duplicate":0,"ignored":0}"#.utf8)
                    )
                },
                clockMS: { 1_700_000_002_000 },
                idleHook: {
                    guard hookCalls.increment() == 1 else { return }
                    try! outbox.enqueue(event)
                    holder.value?.schedule(enabled: true)
                }
            )
            holder.value = uploader

            uploader.schedule(enabled: true) { result in
                if result == .uploaded(1) { finished.signal() }
            }

            XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
            XCTAssertEqual(try outbox.queuedCount(), 0)
        }
    }

    func testHeartbeatStartsImmediatelyUsesExactContractAndRepeatsEveryFiveMinutes() throws {
        let requests = RequestBox()
        let scheduler = ScheduledActionBox()
        let first = DispatchSemaphore(value: 0)
        let second = DispatchSemaphore(value: 0)
        let calls = IntegerBox()
        let heartbeat = try Heartbeat(
            configuration: .init(
                origin: URL(string: "http://localhost:8765")!,
                deviceToken: "synthetic-token",
                allowsTestOrigin: true
            ),
            companionVersion: "0.2.0",
            cancellableTransport: { request, _ in
                requests.append(request)
                if calls.increment() == 1 { first.signal() } else { second.signal() }
                return .init(statusCode: 204, body: Data())
            },
            scheduler: scheduler.schedule
        )

        heartbeat.setEnabled(true)
        XCTAssertEqual(first.wait(timeout: .now() + 2), .success)
        let request = try XCTUnwrap(requests.values.first)
        XCTAssertEqual(request.url?.absoluteString, "http://localhost:8765/api/runs/heartbeat")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.timeoutInterval, 2)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String],
            ["companion_version": "0.2.0"]
        )
        XCTAssertEqual(scheduler.delayMS, 300_000)

        scheduler.run()
        XCTAssertEqual(second.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(calls.value, 2)
    }

    func testHeartbeatOffCancelsCadenceAndOnly204CountsAsSuccess() throws {
        let scheduler = ScheduledActionBox()
        let called = DispatchSemaphore(value: 0)
        let heartbeat = try Heartbeat(
            configuration: .init(
                origin: URL(string: "http://localhost:8765")!,
                deviceToken: "synthetic-token",
                allowsTestOrigin: true
            ),
            companionVersion: "0.2.0",
            cancellableTransport: { _, _ in
                called.signal()
                return .init(statusCode: 200, body: Data())
            },
            scheduler: scheduler.schedule
        )

        heartbeat.setEnabled(true)
        XCTAssertEqual(called.wait(timeout: .now() + 2), .success)
        XCTAssertNil(heartbeat.lastSuccessfulHeartbeatMS)
        heartbeat.setEnabled(false)
        scheduler.run()
        XCTAssertEqual(called.wait(timeout: .now() + 0.05), .timedOut)
    }

    private enum SyntheticTransportError: Error { case failed }

    private func makeEvent(sequence: Int64) -> RunEventV1 {
        RunEventV1(
            schemaVersion: 1,
            companionVersion: "0.1.0",
            deviceID: "00000000-0000-4000-8000-000000000001",
            provider: .codex,
            surface: .codexCLI,
            runKey: String(repeating: "a", count: 64),
            sequence: sequence,
            eventTimeMS: 1_700_000_000_500 + sequence,
            observedAtMS: 1_700_000_001_000 + sequence,
            startedAtMS: 1_700_000_000_000,
            state: .open,
            usage: .init(input: sequence, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0),
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
            .appendingPathComponent("runtime-raiders-uploader-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }
}

private final class UploadResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: UploadAttemptResult?

    var value: UploadAttemptResult? { lock.withLock { stored } }
    func set(_ value: UploadAttemptResult) { lock.withLock { stored = value } }
}

private final class IntegerBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    var value: Int { lock.withLock { stored } }
    func set(_ value: Int) { lock.withLock { stored = value } }
    func increment() -> Int { lock.withLock { stored += 1; return stored } }
    func add(_ value: Int) { lock.withLock { stored += value } }
}

private final class UploaderBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Uploader?
    var value: Uploader? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [URLRequest] = []
    var values: [URLRequest] { lock.withLock { stored } }
    func append(_ value: URLRequest) { lock.withLock { stored.append(value) } }
}

private final class ScheduledActionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (@Sendable () -> Void)?
    private var storedDelayMS: Int64?

    var delayMS: Int64? { lock.withLock { storedDelayMS } }

    func schedule(_ delayMS: Int64, _ action: @escaping @Sendable () -> Void) {
        lock.withLock {
            storedDelayMS = delayMS
            self.action = action
        }
    }

    func run() {
        let action = lock.withLock { () -> (@Sendable () -> Void)? in
            defer { self.action = nil }
            return self.action
        }
        action?()
    }
}

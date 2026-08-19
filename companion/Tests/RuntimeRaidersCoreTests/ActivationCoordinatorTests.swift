import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ActivationCoordinatorTests: XCTestCase {
    func testInFlightChangedFileCannotScheduleUploadAfterTurnOffInvalidatesGeneration() throws {
        let readGate = InFlightChangeGate()
        try withHarness(afterProviderRead: { readGate.blockIfArmed() }) { harness in
            let files = try harness.makeHistoricalFiles(count: 1)
            let stopStarted = DispatchSemaphore(value: 0)
            let releaseStop = DispatchSemaphore(value: 0)
            let changedFinished = DispatchSemaphore(value: 0)
            let offFinished = DispatchSemaphore(value: 0)
            let runtime = RuntimeEnableState()
            try harness.controller.turnOn(existingFiles: files)
            while harness.controller.hasPendingReadWork {
                try harness.controller.continuePendingWork()
            }
            runtime.setEnabled(true)
            let coordinator = ActivationCoordinator(
                controller: harness.controller,
                workerQueue: DispatchQueue(label: "com.redlattice.runtime-raiders.tests.change-off-order"),
                operations: ActivationOperations(
                    startWatching: {},
                    stopWatching: {
                        stopStarted.signal()
                        releaseStop.wait()
                    },
                    discoverProviderFiles: { [] },
                    scheduleUpload: { runtime.setEnabled(true) },
                    becameReady: {},
                    becameDisabled: { runtime.setEnabled(false) }
                )
            )
            XCTAssertTrue(runtime.isEnabled)

            readGate.arm()
            try harness.appendDesktopCompletion(to: files[0])
            DispatchQueue.global(qos: .utility).async {
                coordinator.processChangedFiles([files[0]])
                changedFinished.signal()
            }
            XCTAssertEqual(readGate.readStarted.wait(timeout: .now() + 2), .success)

            DispatchQueue.global(qos: .utility).async {
                try? coordinator.turnOff()
                offFinished.signal()
            }
            XCTAssertEqual(stopStarted.wait(timeout: .now() + 2), .success)
            XCTAssertFalse(runtime.isEnabled)

            readGate.releaseRead.signal()
            XCTAssertEqual(changedFinished.wait(timeout: .now() + 0.05), .timedOut)
            XCTAssertFalse(runtime.isEnabled)

            releaseStop.signal()
            XCTAssertEqual(offFinished.wait(timeout: .now() + 2), .success)
            XCTAssertEqual(changedFinished.wait(timeout: .now() + 2), .success)
            XCTAssertFalse(runtime.isEnabled)
            XCTAssertEqual(harness.controller.activationState, .disabled)
        }
    }

    func testReadyCoordinatorContinuesBoundedLiveReadWorkToCompletion() throws {
        try withHarness(readLimitBytes: 64) { harness in
            let files = try harness.makeHistoricalFiles(count: 1)
            let ready = expectation(description: "activation ready")
            let coordinator = ActivationCoordinator(
                controller: harness.controller,
                workerQueue: DispatchQueue(label: "com.redlattice.runtime-raiders.tests.live-continuation"),
                operations: ActivationOperations(
                    startWatching: {},
                    stopWatching: {},
                    discoverProviderFiles: { files },
                    becameReady: { ready.fulfill() },
                    becameDisabled: {}
                )
            )
            XCTAssertEqual(try coordinator.turnOn(), .preparing)
            wait(for: [ready], timeout: 2)

            try harness.appendDesktopCompletion(to: files[0])
            coordinator.processChangedFiles([files[0]])

            let deadline = Date().addingTimeInterval(2)
            while harness.controller.hasPendingReadWork, Date() < deadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
            XCTAssertFalse(harness.controller.hasPendingReadWork)
            XCTAssertEqual(
                try harness.outbox.records(limit: 100)
                    .filter { $0.event.state == .completed }.count,
                1
            )
        }
    }

    func testTurnOffCannotBeOvertakenByAReadyNotificationAlreadyInFlight() throws {
        try withHarness { harness in
            let readyStarted = DispatchSemaphore(value: 0)
            let releaseReady = DispatchSemaphore(value: 0)
            let offFinished = DispatchSemaphore(value: 0)
            let actions = ActivationActionLog()
            let coordinator = ActivationCoordinator(
                controller: harness.controller,
                workerQueue: DispatchQueue(label: "com.redlattice.runtime-raiders.tests.ready-off-order"),
                operations: ActivationOperations(
                    startWatching: {},
                    stopWatching: {},
                    discoverProviderFiles: { [] },
                    becameReady: {
                        readyStarted.signal()
                        releaseReady.wait()
                        actions.append("ready")
                    },
                    becameDisabled: { actions.append("disabled") }
                )
            )
            XCTAssertEqual(try coordinator.turnOn(), .preparing)
            XCTAssertEqual(readyStarted.wait(timeout: .now() + 2), .success)

            DispatchQueue.global(qos: .utility).async {
                try? coordinator.turnOff()
                offFinished.signal()
            }

            XCTAssertEqual(offFinished.wait(timeout: .now() + 0.05), .timedOut)
            releaseReady.signal()
            XCTAssertEqual(offFinished.wait(timeout: .now() + 2), .success)
            XCTAssertEqual(actions.values, ["ready", "disabled"])
            XCTAssertEqual(harness.controller.activationState, .disabled)
        }
    }

    func testTurnOnAndTurnOffStayPromptWhile816FileDiscoveryIsBlocked() throws {
        try withHarness { harness in
            let files = try harness.makeHistoricalFiles(count: 816)
            let discoveryStarted = expectation(description: "discovery started")
            let staleReady = expectation(description: "stale activation never becomes ready")
            staleReady.isInverted = true
            let releaseDiscovery = DispatchSemaphore(value: 0)
            let coordinator = ActivationCoordinator(
                controller: harness.controller,
                workerQueue: DispatchQueue(label: "com.redlattice.runtime-raiders.tests.blocked-discovery"),
                operations: ActivationOperations(
                    startWatching: {},
                    stopWatching: {},
                    discoverProviderFiles: {
                        discoveryStarted.fulfill()
                        releaseDiscovery.wait()
                        return files
                    },
                    becameReady: { staleReady.fulfill() },
                    becameDisabled: {}
                )
            )

            let turnOnStarted = ContinuousClock.now
            let state = try coordinator.turnOn()
            let turnOnElapsed = ContinuousClock.now - turnOnStarted

            XCTAssertEqual(state, .preparing)
            XCTAssertLessThan(turnOnElapsed, .milliseconds(250))
            XCTAssertEqual(harness.controller.activationState, .preparing)
            wait(for: [discoveryStarted], timeout: 2)

            let statusStarted = ContinuousClock.now
            let status = try harness.controller.status(
                daemonRunning: true,
                serverEnabledSurfaces: [.codexDesktop],
                lastSuccessfulUploadMS: nil
            )
            let statusElapsed = ContinuousClock.now - statusStarted
            XCTAssertLessThan(statusElapsed, .milliseconds(250))
            XCTAssertEqual(status.activationState, .preparing)

            let turnOffStarted = ContinuousClock.now
            try coordinator.turnOff()
            let turnOffElapsed = ContinuousClock.now - turnOffStarted

            XCTAssertLessThan(turnOffElapsed, .milliseconds(250))
            XCTAssertEqual(harness.controller.activationState, .disabled)
            releaseDiscovery.signal()
            wait(for: [staleReady], timeout: 0.2)
            XCTAssertEqual(harness.controller.activationState, .disabled)
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)
        }
    }

    func test816HistoricalFilesSeedInBackgroundThenOneDesktopCompletionProducesOneRun() throws {
        try withHarness { harness in
            let files = try harness.makeHistoricalFiles(count: 816)
            let ready = expectation(description: "activation ready")
            let coordinator = ActivationCoordinator(
                controller: harness.controller,
                workerQueue: DispatchQueue(label: "com.redlattice.runtime-raiders.tests.seed-816"),
                operations: ActivationOperations(
                    startWatching: {},
                    stopWatching: {},
                    discoverProviderFiles: { files },
                    becameReady: { ready.fulfill() },
                    becameDisabled: {}
                )
            )

            let turnOnStarted = ContinuousClock.now
            let state = try coordinator.turnOn()
            let turnOnElapsed = ContinuousClock.now - turnOnStarted

            XCTAssertEqual(state, .preparing)
            XCTAssertLessThan(turnOnElapsed, .milliseconds(250))
            wait(for: [ready], timeout: 10)
            XCTAssertEqual(harness.controller.activationState, .ready)
            XCTAssertEqual(try harness.outbox.queuedCount(), 0)

            try harness.appendDesktopCompletion(to: files[0])
            coordinator.processChangedFiles([files[0]])

            let events = try harness.outbox.records(limit: 100).map(\.event)
            XCTAssertEqual(Set(events.map(\.runKey)).count, 1)
            XCTAssertEqual(events.filter { $0.state == .completed }.count, 1)
            XCTAssertTrue(events.allSatisfy { $0.surface == .codexDesktop })
        }
    }

    private func withHarness(
        readLimitBytes: Int = JSONLReader.maximumReadBytes,
        afterProviderRead: @escaping @Sendable () -> Void = {},
        _ body: (ActivationHarness) throws -> Void
    ) throws {
        let harness = try ActivationHarness(
            readLimitBytes: readLimitBytes,
            afterProviderRead: afterProviderRead
        )
        defer { try? FileManager.default.removeItem(at: harness.root) }
        try body(harness)
    }
}

private final class InFlightChangeGate: @unchecked Sendable {
    let readStarted = DispatchSemaphore(value: 0)
    let releaseRead = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var armed = false

    func arm() {
        lock.withLock { armed = true }
    }

    func blockIfArmed() {
        let shouldBlock = lock.withLock { () -> Bool in
            guard armed else { return false }
            armed = false
            return true
        }
        guard shouldBlock else { return }
        readStarted.signal()
        releaseRead.wait()
    }
}

private final class RuntimeEnableState: @unchecked Sendable {
    private let lock = NSLock()
    private var enabled = false

    var isEnabled: Bool { lock.withLock { enabled } }

    func setEnabled(_ value: Bool) {
        lock.withLock { enabled = value }
    }
}

private final class ActivationActionLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] { lock.withLock { storage } }

    func append(_ value: String) {
        lock.withLock { storage.append(value) }
    }
}

private final class ActivationHarness {
    let root: URL
    let providerRoot: URL
    let outbox: Outbox
    let controller: AgentController

    init(
        readLimitBytes: Int,
        afterProviderRead: @escaping @Sendable () -> Void
    ) throws {
        root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-activation-\(UUID().uuidString)", isDirectory: true)
        providerRoot = root.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: providerRoot, withIntermediateDirectories: true)
        let paths = AgentPaths(applicationSupportDirectory: root)
        let registry = try AdapterRegistry.enabled(
            surfaces: [.codexDesktop],
            codexRoot: providerRoot
        )
        outbox = try Outbox(directory: paths.outboxDirectory)
        controller = try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: AgentConfiguration(
                companionVersion: "0.1.0",
                deviceID: "00000000-0000-4000-8000-000000000001",
                dedupeSecret: Data("DO_NOT_EXPORT_LOCAL_SECRET".utf8)
            ),
            readLimitBytes: readLimitBytes,
            clockMS: { 1_800_000_000_000 },
            afterProviderRead: afterProviderRead
        )
    }

    func makeHistoricalFiles(count: Int) throws -> [URL] {
        try (0..<count).map { index in
            let file = providerRoot.appendingPathComponent(
                String(format: "rollout-%04d.jsonl", index)
            )
            try desktopHistoricalRun(index: index).write(to: file)
            return file
        }
    }

    func appendDesktopCompletion(to file: URL) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: lines([
            #"{"timestamp":"2026-01-01T00:00:05Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-01-01T00:00:06Z","type":"turn_context","payload":{"turn_id":"post-boundary-desktop","model":"synthetic"}}"#,
            #"{"timestamp":"2026-01-01T00:00:07Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}"#,
            #"{"timestamp":"2026-01-01T00:00:08Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]))
    }

    private func desktopHistoricalRun(index: Int) -> Data {
        lines([
            "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"desktop-session-\(index)\",\"originator\":\"originator\",\"source\":\"vscode\",\"cli_version\":\"0.146.0-alpha.3.1\"}}",
            #"{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"DO_NOT_EXPORT_HISTORICAL_\(index)\",\"model\":\"synthetic\"}}",
            #"{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":3,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}}}"#,
            #"{"timestamp":"2026-01-01T00:00:04Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ])
    }

    private func lines(_ values: [String]) -> Data {
        Data((values.joined(separator: "\n") + "\n").utf8)
    }
}

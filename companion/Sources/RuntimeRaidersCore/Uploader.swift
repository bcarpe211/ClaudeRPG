import Foundation

public struct UploadHTTPResponse: Equatable, Sendable {
    public let statusCode: Int
    public let body: Data

    public init(statusCode: Int, body: Data) {
        self.statusCode = statusCode
        self.body = body
    }
}

public struct UploadConfiguration: Equatable, Sendable {
    public let origin: URL
    public let deviceToken: String
    let allowsTestOrigin: Bool

    public init(origin: URL, deviceToken: String) {
        self.origin = origin
        self.deviceToken = deviceToken
        allowsTestOrigin = false
    }

    init(origin: URL, deviceToken: String, allowsTestOrigin: Bool) {
        self.origin = origin
        self.deviceToken = deviceToken
        self.allowsTestOrigin = allowsTestOrigin
    }
}

public enum UploaderError: Error, Equatable {
    case invalidOrigin
    case invalidToken
    case invalidCompanionVersion
}

enum UploadBatchWire {
    static func request(
        records: [OutboxRecord],
        configuration: UploadConfiguration
    ) throws -> URLRequest {
        var request = URLRequest(
            url: configuration.origin.appendingPathComponent("api/runs/events")
        )
        request.httpMethod = "POST"
        request.timeoutInterval = 2
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            "Bearer \(configuration.deviceToken)",
            forHTTPHeaderField: "Authorization"
        )
        request.httpBody = try batchBody(records)
        return request
    }

    static func accepts(_ response: UploadHTTPResponse, expectedCount: Int) -> Bool {
        response.statusCode == 200
            && validAcknowledgement(response.body, expectedCount: expectedCount)
    }

    private static func batchBody(_ records: [OutboxRecord]) throws -> Data {
        let events = try records.map { record -> Any in
            try JSONSerialization.jsonObject(with: record.encodedEvent)
        }
        return try JSONSerialization.data(withJSONObject: ["events": events], options: [.sortedKeys])
    }

    private static func validAcknowledgement(_ body: Data, expectedCount: Int) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              Set(object.keys) == ["accepted", "duplicate", "ignored"] else { return false }
        var total: Int64 = 0
        for key in ["accepted", "duplicate", "ignored"] {
            guard let number = object[key] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            let value = number.doubleValue
            guard value >= 0,
                  value <= 9_007_199_254_740_991,
                  value.rounded(.towardZero) == value else { return false }
            let integer = number.int64Value
            guard total <= Int64.max - integer else { return false }
            total += integer
        }
        return total == Int64(expectedCount)
    }
}

public final class RequestCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var handler: (@Sendable () -> Void)?

    public var isCancelled: Bool { lock.withLock { cancelled } }

    public func register(_ handler: @escaping @Sendable () -> Void) {
        let callImmediately = lock.withLock { () -> Bool in
            if cancelled { return true }
            self.handler = handler
            return false
        }
        if callImmediately { handler() }
    }

    public func cancel() {
        let action = lock.withLock { () -> (@Sendable () -> Void)? in
            guard !cancelled else { return nil }
            cancelled = true
            let action = handler
            handler = nil
            return action
        }
        action?()
    }
}

public final class Heartbeat: @unchecked Sendable {
    public typealias Scheduler = @Sendable (
        _ delayMS: Int64,
        _ action: @escaping @Sendable () -> Void
    ) -> Void

    private let configuration: UploadConfiguration
    private let companionVersion: String
    private let transport: Uploader.CancellableTransport
    private let clockMS: Uploader.Clock
    private let intervalMS: Int64
    private let scheduler: Scheduler
    private let queue = DispatchQueue(
        label: "com.redlattice.runtime-raiders.heartbeat",
        qos: .utility
    )
    private let lock = NSLock()
    private var enabled = false
    private var generation: UInt64 = 0
    private var activeRequest: RequestCancellation?
    private var storedLastSuccessfulHeartbeatMS: Int64?

    public var lastSuccessfulHeartbeatMS: Int64? {
        lock.withLock { storedLastSuccessfulHeartbeatMS }
    }

    public convenience init(
        configuration: UploadConfiguration,
        companionVersion: String,
        transport: @escaping Uploader.Transport,
        clockMS: @escaping Uploader.Clock = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) throws {
        try self.init(
            configuration: configuration,
            companionVersion: companionVersion,
            cancellableTransport: { request, _ in try transport(request) },
            clockMS: clockMS,
            intervalMS: 300_000,
            scheduler: { delayMS, action in
                DispatchQueue.global(qos: .utility).asyncAfter(
                    deadline: .now() + .milliseconds(Int(min(delayMS, Int64(Int.max)))),
                    execute: action
                )
            }
        )
    }


    public convenience init(
        configuration: UploadConfiguration,
        companionVersion: String,
        cancellableTransport: @escaping Uploader.CancellableTransport,
        clockMS: @escaping Uploader.Clock = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) throws {
        try self.init(
            configuration: configuration,
            companionVersion: companionVersion,
            cancellableTransport: cancellableTransport,
            clockMS: clockMS,
            intervalMS: 300_000,
            scheduler: { delayMS, action in
                DispatchQueue.global(qos: .utility).asyncAfter(
                    deadline: .now() + .milliseconds(Int(min(delayMS, Int64(Int.max)))),
                    execute: action
                )
            }
        )
    }

    init(
        configuration: UploadConfiguration,
        companionVersion: String,
        cancellableTransport: @escaping Uploader.CancellableTransport,
        clockMS: @escaping Uploader.Clock = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        },
        intervalMS: Int64 = 300_000,
        scheduler: @escaping Scheduler
    ) throws {
        guard !configuration.deviceToken.isEmpty,
              configuration.deviceToken.utf8.count <= 4_096 else {
            throw UploaderError.invalidToken
        }
        guard configuration.allowsTestOrigin || Uploader.isProductionOrigin(configuration.origin) else {
            throw UploaderError.invalidOrigin
        }
        guard !companionVersion.isEmpty, companionVersion.utf8.count <= 100 else {
            throw UploaderError.invalidCompanionVersion
        }
        precondition(intervalMS > 0)
        self.configuration = configuration
        self.companionVersion = companionVersion
        transport = cancellableTransport
        self.clockMS = clockMS
        self.intervalMS = intervalMS
        self.scheduler = scheduler
    }

    public func setEnabled(_ newValue: Bool) {
        var cancellation: RequestCancellation?
        let activeGeneration: UInt64? = lock.withLock {
            guard enabled != newValue else { return nil }
            enabled = newValue
            generation &+= 1
            if !newValue {
                cancellation = activeRequest
                activeRequest = nil
            }
            return newValue ? generation : nil
        }
        cancellation?.cancel()
        guard let activeGeneration else { return }
        queue.async { [weak self] in
            self?.send(generation: activeGeneration)
        }
    }

    private func send(generation activeGeneration: UInt64) {
        guard isActive(generation: activeGeneration) else { return }
        var request = URLRequest(
            url: configuration.origin.appendingPathComponent("api/runs/heartbeat")
        )
        request.httpMethod = "POST"
        request.timeoutInterval = 2
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(configuration.deviceToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["companion_version": companionVersion],
            options: [.sortedKeys]
        )
        let cancellation = RequestCancellation()
        let maySend = lock.withLock { () -> Bool in
            guard enabled, generation == activeGeneration else { return false }
            activeRequest = cancellation
            return true
        }
        guard maySend else { return }
        let response = try? transport(request, cancellation)
        let mayContinue = lock.withLock { () -> Bool in
            if activeRequest === cancellation { activeRequest = nil }
            return enabled && generation == activeGeneration
        }
        guard mayContinue else { return }
        if response?.statusCode == 204, response?.body.isEmpty == true {
            lock.withLock {
                guard enabled, generation == activeGeneration else { return }
                storedLastSuccessfulHeartbeatMS = clockMS()
            }
        }
        scheduler(intervalMS) { [weak self] in
            guard let self else { return }
            self.queue.async { [weak self] in
                self?.send(generation: activeGeneration)
            }
        }
    }

    private func isActive(generation activeGeneration: UInt64) -> Bool {
        lock.withLock { enabled && generation == activeGeneration }
    }
}

public enum UploadAttemptResult: Equatable, Sendable {
    case disabled
    case empty
    case waiting(untilMS: Int64)
    case uploaded(Int)
    case retryScheduled(atMS: Int64)
}

public final class Uploader: @unchecked Sendable {
    public typealias Transport = (URLRequest) throws -> UploadHTTPResponse
    public typealias CancellableTransport = (
        URLRequest,
        RequestCancellation
    ) throws -> UploadHTTPResponse
    public typealias Clock = () -> Int64
    public typealias Jitter = (_ baseDelayMS: Int64) -> Int64
    public typealias RetryScheduler = @Sendable (
        _ delayMS: Int64,
        _ action: @escaping @Sendable () -> Void
    ) -> Void

    private let outbox: Outbox
    private let configuration: UploadConfiguration
    private let transport: CancellableTransport
    private let clockMS: Clock
    private let jitterMS: Jitter
    private let retryScheduler: RetryScheduler
    private let idleHook: @Sendable () -> Void
    private let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.uploader", qos: .utility)
    private let lock = NSLock()
    private var failureCount = 0
    private var nextAttemptAtMS: Int64?
    private var deliveryEnabled = true
    private var generation: UInt64 = 0
    private var loopRunning = false
    private var wakeRequested = false
    private var activeRequest: RequestCancellation?
    private var storedLastSuccessfulUploadMS: Int64?
    public var lastSuccessfulUploadMS: Int64? {
        lock.withLock { storedLastSuccessfulUploadMS }
    }

    public convenience init(
        outbox: Outbox,
        configuration: UploadConfiguration,
        transport: @escaping Transport,
        clockMS: @escaping Clock = { Int64(Date().timeIntervalSince1970 * 1_000) },
        jitterMS: @escaping Jitter = { base in
            let lower = max(1, base * 8 / 10)
            let upper = max(lower, base * 12 / 10)
            return Int64.random(in: lower...upper)
        },
        retryScheduler: @escaping RetryScheduler = { delayMS, action in
            DispatchQueue.global(qos: .utility).asyncAfter(
                deadline: .now() + .milliseconds(Int(min(delayMS, Int64(Int.max)))),
                execute: action
            )
        },
        idleHook: @escaping @Sendable () -> Void = {}
    ) throws {
        try self.init(
            outbox: outbox,
            configuration: configuration,
            cancellableTransport: { request, _ in try transport(request) },
            clockMS: clockMS,
            jitterMS: jitterMS,
            retryScheduler: retryScheduler,
            idleHook: idleHook
        )
    }

    public init(
        outbox: Outbox,
        configuration: UploadConfiguration,
        cancellableTransport: @escaping CancellableTransport,
        clockMS: @escaping Clock = { Int64(Date().timeIntervalSince1970 * 1_000) },
        jitterMS: @escaping Jitter = { base in
            let lower = max(1, base * 8 / 10)
            let upper = max(lower, base * 12 / 10)
            return Int64.random(in: lower...upper)
        },
        retryScheduler: @escaping RetryScheduler = { delayMS, action in
            DispatchQueue.global(qos: .utility).asyncAfter(
                deadline: .now() + .milliseconds(Int(min(delayMS, Int64(Int.max)))),
                execute: action
            )
        },
        idleHook: @escaping @Sendable () -> Void = {}
    ) throws {
        guard !configuration.deviceToken.isEmpty,
              configuration.deviceToken.utf8.count <= 4_096 else {
            throw UploaderError.invalidToken
        }
        guard configuration.allowsTestOrigin || Self.isProductionOrigin(configuration.origin) else {
            throw UploaderError.invalidOrigin
        }
        self.outbox = outbox
        self.configuration = configuration
        transport = cancellableTransport
        self.clockMS = clockMS
        self.jitterMS = jitterMS
        self.retryScheduler = retryScheduler
        self.idleHook = idleHook
    }

    public static func liveTransport(_ request: URLRequest) throws -> UploadHTTPResponse {
        try liveCancellableTransport(request, cancellation: RequestCancellation())
    }

    public static func liveCancellableTransport(
        _ request: URLRequest,
        cancellation: RequestCancellation
    ) throws -> UploadHTTPResponse {
        let collector = BoundedURLSessionDelegate(maximumBytes: 64 * 1_024)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = request.timeoutInterval
        configuration.timeoutIntervalForResource = request.timeoutInterval
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpMaximumConnectionsPerHost = 1
        let session = URLSession(
            configuration: configuration,
            delegate: collector,
            delegateQueue: nil
        )
        let task = session.dataTask(with: request)
        cancellation.register {
            task.cancel()
            session.invalidateAndCancel()
        }
        guard !cancellation.isCancelled else { throw URLError(.cancelled) }
        task.resume()
        guard collector.wait(timeout: request.timeoutInterval + 0.25) else {
            task.cancel()
            session.invalidateAndCancel()
            throw URLError(.timedOut)
        }
        session.finishTasksAndInvalidate()
        return try collector.value()
    }

    public func schedule(
        enabled: Bool,
        completion: (@Sendable (UploadAttemptResult) -> Void)? = nil
    ) {
        setEnabled(enabled)
        guard enabled else {
            completion?(.disabled)
            return
        }
        let activeGeneration: UInt64? = lock.withLock {
            guard deliveryEnabled else { return nil }
            if loopRunning {
                wakeRequested = true
                return nil
            }
            loopRunning = true
            wakeRequested = false
            return generation
        }
        guard let activeGeneration else { return }
        queue.async { [self] in
            runLoop(generation: activeGeneration, completion: completion)
        }
    }

    public func setEnabled(_ enabled: Bool) {
        let cancellation = lock.withLock { () -> RequestCancellation? in
            guard deliveryEnabled != enabled else { return nil }
            deliveryEnabled = enabled
            generation &+= 1
            if !enabled {
                loopRunning = false
                wakeRequested = false
                nextAttemptAtMS = nil
                failureCount = 0
                let active = activeRequest
                activeRequest = nil
                return active
            }
            return nil
        }
        cancellation?.cancel()
    }

    public func performAttempt(enabled: Bool) throws -> UploadAttemptResult {
        let currentGeneration = lock.withLock { generation }
        return try performAttempt(enabled: enabled, generation: currentGeneration)
    }

    private func performAttempt(enabled: Bool, generation attemptGeneration: UInt64) throws -> UploadAttemptResult {
        guard enabled,
              lock.withLock({ deliveryEnabled && generation == attemptGeneration }) else {
            return .disabled
        }
        let now = clockMS()
        if let due = lock.withLock({ nextAttemptAtMS }), now < due {
            return .waiting(untilMS: due)
        }
        try outbox.prune(nowMS: now)
        let records = try outbox.records(limit: 100)
        guard !records.isEmpty else { return .empty }

        let request = try UploadBatchWire.request(records: records, configuration: configuration)

        let cancellation = RequestCancellation()
        let maySend = lock.withLock { () -> Bool in
            guard deliveryEnabled, generation == attemptGeneration else { return false }
            activeRequest = cancellation
            return true
        }
        guard maySend else { return .disabled }
        let response: UploadHTTPResponse
        do {
            response = try transport(request, cancellation)
        } catch {
            lock.withLock {
                if activeRequest === cancellation { activeRequest = nil }
            }
            return scheduleFailure(now: now, generation: attemptGeneration)
        }
        lock.withLock {
            if activeRequest === cancellation { activeRequest = nil }
        }
        guard lock.withLock({ deliveryEnabled && generation == attemptGeneration }) else {
            return .disabled
        }
        guard UploadBatchWire.accepts(response, expectedCount: records.count) else {
            return scheduleFailure(now: now, generation: attemptGeneration)
        }
        return try lock.withLock {
            guard deliveryEnabled, generation == attemptGeneration else { return .disabled }
            try outbox.acknowledge(records)
            failureCount = 0
            nextAttemptAtMS = nil
            storedLastSuccessfulUploadMS = now
            return .uploaded(records.count)
        }
    }

    private func scheduleFailure(now: Int64, generation attemptGeneration: UInt64) -> UploadAttemptResult {
        lock.withLock {
            guard deliveryEnabled, generation == attemptGeneration else { return .disabled }
            let exponent = min(failureCount, 6)
            let base = min(Int64(300_000), Int64(5_000) << exponent)
            let lower = base * 8 / 10
            let upper = min(Int64(300_000), base * 12 / 10)
            let delay = min(upper, max(lower, jitterMS(base)))
            failureCount = min(failureCount + 1, 63)
            let due = now > Int64.max - delay ? Int64.max : now + delay
            nextAttemptAtMS = due
            return .retryScheduled(atMS: due)
        }
    }

    private func runLoop(
        generation activeGeneration: UInt64,
        completion: (@Sendable (UploadAttemptResult) -> Void)?
    ) {
        guard lock.withLock({ deliveryEnabled && generation == activeGeneration }) else {
            finishLoop(generation: activeGeneration)
            completion?(.disabled)
            return
        }
        let result: UploadAttemptResult
        do {
            result = try performAttempt(enabled: true, generation: activeGeneration)
        } catch {
            result = scheduleFailure(now: clockMS(), generation: activeGeneration)
        }
        completion?(result)
        switch result {
        case .uploaded:
            queue.async { [self] in runLoop(generation: activeGeneration, completion: completion) }
        case let .retryScheduled(atMS), let .waiting(atMS):
            let delay = max(0, atMS - clockMS())
            retryScheduler(delay) { [weak self] in
                self?.queue.async { [weak self] in
                    self?.runLoop(generation: activeGeneration, completion: completion)
                }
            }
        case .empty:
            idleHook()
            if finishOrRestartLoop(generation: activeGeneration) {
                queue.async { [self] in
                    runLoop(generation: activeGeneration, completion: completion)
                }
            }
        case .disabled:
            finishLoop(generation: activeGeneration)
        }
    }

    private func finishLoop(generation activeGeneration: UInt64) {
        lock.withLock {
            if generation == activeGeneration { loopRunning = false }
        }
    }

    private func finishOrRestartLoop(generation activeGeneration: UInt64) -> Bool {
        lock.withLock {
            guard generation == activeGeneration, deliveryEnabled else {
                loopRunning = false
                wakeRequested = false
                return false
            }
            if wakeRequested {
                wakeRequested = false
                return true
            }
            loopRunning = false
            return false
        }
    }

    static func isProductionOrigin(_ url: URL) -> Bool {
        url.absoluteString == "https://raiders.redlattice.com"
    }
}

private final class BoundedURLSessionDelegate: NSObject, URLSessionDataDelegate,
    URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private let maximumBytes: Int
    private var data = Data()
    private var response: HTTPURLResponse?
    private var error: Error?
    private var finished = false

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        lock.withLock { self.response = response as? HTTPURLResponse }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let shouldCancel = lock.withLock { () -> Bool in
            guard data.count <= maximumBytes - self.data.count else {
                error = URLError(.dataLengthExceedsMaximum)
                return true
            }
            self.data.append(data)
            return false
        }
        if shouldCancel { dataTask.cancel() }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError completionError: Error?
    ) {
        let signal = lock.withLock { () -> Bool in
            if error == nil { error = completionError }
            guard !finished else { return false }
            finished = true
            return true
        }
        if signal { semaphore.signal() }
    }

    func wait(timeout: TimeInterval) -> Bool {
        semaphore.wait(timeout: .now() + timeout) == .success
    }

    func value() throws -> UploadHTTPResponse {
        try lock.withLock {
            if let error { throw error }
            guard let response else {
                throw URLError(.badServerResponse)
            }
            return UploadHTTPResponse(statusCode: response.statusCode, body: data)
        }
    }
}

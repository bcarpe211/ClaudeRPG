import Darwin
import Foundation

public struct UpdateStateV1: Codable, Equatable, Sendable {
    public let version: Int
    public var lastCheckAttemptMS: Int64?
    public var lastObservedReleaseSequence: Int64?
    public var lastNotifiedReleaseSequence: Int64?
    public var cachedManifest: ReleaseManifestV1?

    public init(
        lastCheckAttemptMS: Int64? = nil,
        lastObservedReleaseSequence: Int64? = nil,
        lastNotifiedReleaseSequence: Int64? = nil,
        cachedManifest: ReleaseManifestV1? = nil
    ) {
        version = 1
        self.lastCheckAttemptMS = lastCheckAttemptMS
        self.lastObservedReleaseSequence = lastObservedReleaseSequence
        self.lastNotifiedReleaseSequence = lastNotifiedReleaseSequence
        self.cachedManifest = cachedManifest
    }
}

public final class UpdateStateStore: @unchecked Sendable {
    private static let maximumBytes = 16 * 1_024
    private static let allowedKeys: Set<String> = [
        "version",
        "lastCheckAttemptMS",
        "lastObservedReleaseSequence",
        "lastNotifiedReleaseSequence",
        "cachedManifest",
    ]

    private let file: URL
    private let directoryDescriptor: Int32
    private let atomicStore: AtomicStore
    private let lock = NSRecursiveLock()

    public init(paths: AgentPaths) throws {
        file = paths.updateState
        directoryDescriptor = try OwnerOnlyDirectory.openOrCreate(paths.stateDirectory)
        atomicStore = AtomicStore()
    }

    deinit { Darwin.close(directoryDescriptor) }

    public func load() throws -> UpdateStateV1 {
        try lock.withLock {
            do {
                guard let data = try read() else { return UpdateStateV1() }
                guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      Set(object.keys).isSubset(of: Self.allowedKeys),
                      object["version"] != nil,
                      let state = try? JSONDecoder().decode(UpdateStateV1.self, from: data),
                      Self.valid(state) else {
                    return try replaceMalformedState()
                }
                return state
            } catch {
                return try replaceMalformedState()
            }
        }
    }

    public func save(_ state: UpdateStateV1) throws {
        try lock.withLock {
            guard Self.valid(state) else { throw AgentControllerError.invalidState }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let data = try encoder.encode(state)
            guard data.count <= Self.maximumBytes else {
                throw AgentControllerError.invalidState
            }
            try atomicStore.write(
                data,
                directoryDescriptor: directoryDescriptor,
                name: file.lastPathComponent
            )
        }
    }

    private func replaceMalformedState() throws -> UpdateStateV1 {
        let empty = UpdateStateV1()
        try save(empty)
        return empty
    }

    private func read() throws -> Data? {
        let descriptor = Darwin.openat(
            directoryDescriptor,
            file.lastPathComponent,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            if errno == ENOENT { return nil }
            throw AgentControllerError.invalidState
        }
        defer { Darwin.close(descriptor) }

        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size > 0,
              metadata.st_size <= Self.maximumBytes else {
            throw AgentControllerError.invalidState
        }

        var data = Data(count: Int(metadata.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(
                    descriptor,
                    base.advanced(by: offset),
                    bytes.count - offset
                )
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw AgentControllerError.invalidState }
            }
        }
        var extra: UInt8 = 0
        while true {
            let count = Darwin.read(descriptor, &extra, 1)
            if count == 0 { break }
            if count < 0, errno == EINTR { continue }
            throw AgentControllerError.invalidState
        }
        return data
    }

    private static func valid(_ state: UpdateStateV1) -> Bool {
        guard state.version == 1,
              validAttempt(state.lastCheckAttemptMS),
              validSequence(state.lastObservedReleaseSequence),
              validSequence(state.lastNotifiedReleaseSequence) else {
            return false
        }
        if let notified = state.lastNotifiedReleaseSequence,
           let observed = state.lastObservedReleaseSequence,
           notified > observed {
            return false
        }
        if state.lastNotifiedReleaseSequence != nil,
           state.lastObservedReleaseSequence == nil {
            return false
        }
        guard let cached = state.cachedManifest else {
            return state.lastObservedReleaseSequence == nil
        }
        guard validated(cached) == cached,
              state.lastObservedReleaseSequence == cached.releaseSequence else {
            return false
        }
        return true
    }

    private static func validAttempt(_ value: Int64?) -> Bool {
        guard let value else { return true }
        return (0...ReleaseContractValidation.maximumSafeInteger).contains(value)
    }

    private static func validSequence(_ value: Int64?) -> Bool {
        guard let value else { return true }
        return (1...ReleaseContractValidation.maximumSafeInteger).contains(value)
    }

    private static func validated(_ manifest: ReleaseManifestV1) -> ReleaseManifestV1? {
        let object: [String: Any] = [
            "manifest_version": manifest.manifestVersion,
            "companion_version": manifest.companionVersion,
            "release_sequence": manifest.releaseSequence,
            "release_sha": manifest.releaseSHA,
            "update_protocol_version": manifest.updateProtocolVersion,
            "zip_sha256": manifest.zipSHA256,
            "zip_url": manifest.zipURL.absoluteString,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return nil
        }
        return try? ReleaseManifestV1.decode(data)
    }
}

public enum ReleaseCheckResult: Equatable, Sendable {
    case notDue
    case checked(CompanionUpdateAvailability?)
    case failed
}

public final class ReleaseChecker: @unchecked Sendable {
    public typealias Transport = @Sendable (URLRequest) throws -> UploadHTTPResponse
    public typealias Notifier = @Sendable () -> Bool
    public typealias Clock = @Sendable () -> Int64

    private static let checkIntervalMS: Int64 = 24 * 60 * 60 * 1_000
    private static let maximumResponseBytes = 64 * 1_024

    private let installed: CompanionReleaseIdentity
    private let store: UpdateStateStore
    private let transport: Transport
    private let notifier: Notifier
    private let clockMS: Clock
    private let lock = NSLock()

    public init(
        paths: AgentPaths,
        installed: CompanionReleaseIdentity,
        transport: @escaping Transport = ReleaseChecker.liveTransport,
        notifier: @escaping Notifier = ReleaseChecker.liveNotifier,
        clockMS: @escaping Clock = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        }
    ) throws {
        self.installed = installed
        store = try UpdateStateStore(paths: paths)
        self.transport = transport
        self.notifier = notifier
        self.clockMS = clockMS
    }

    public func checkIfDue() -> ReleaseCheckResult {
        lock.withLock {
            do {
                var state = try store.load()
                let now = clockMS()
                if let lastAttempt = state.lastCheckAttemptMS,
                   now < lastAttempt || now - lastAttempt < Self.checkIntervalMS {
                    return .notDue
                }

                state.lastCheckAttemptMS = now
                try store.save(state)

                let manifest = try fetchNowUnlocked()
                _ = merge(manifest, into: &state)

                var shouldNotify = false
                if let cachedManifest = state.cachedManifest,
                   cachedManifest.availability(from: installed) != nil,
                   cachedManifest.releaseSequence > (state.lastNotifiedReleaseSequence ?? 0) {
                    state.lastNotifiedReleaseSequence = cachedManifest.releaseSequence
                    shouldNotify = true
                }
                try store.save(state)
                if shouldNotify { _ = notifier() }
                return .checked(Self.availability(state: state, installed: installed))
            } catch {
                return .failed
            }
        }
    }

    public func fetchNow() throws -> ReleaseManifestV1 {
        try lock.withLock {
            var state = try store.load()
            let now = clockMS()
            guard now >= 0 else { throw URLError(.badServerResponse) }
            state.lastCheckAttemptMS = max(state.lastCheckAttemptMS ?? 0, now)
            try store.save(state)
            let fetched = try fetchNowUnlocked()
            let selected = merge(fetched, into: &state)
            try store.save(state)
            return selected
        }
    }

    public func availability() -> CompanionUpdateAvailability? {
        lock.withLock {
            guard let state = try? store.load() else { return nil }
            return Self.availability(state: state, installed: installed)
        }
    }

    public static func liveTransport(_ request: URLRequest) throws -> UploadHTTPResponse {
        try liveTransport(request, allowedURL: ReleaseManifestV1.manifestURL)
    }

    static func liveTransport(
        _ request: URLRequest,
        allowedURL: URL
    ) throws -> UploadHTTPResponse {
        guard request.url == allowedURL,
              request.httpMethod == "GET",
              request.httpBody == nil,
              request.allHTTPHeaderFields?.isEmpty ?? true else {
            throw URLError(.unsupportedURL)
        }

        var anonymousRequest = request
        anonymousRequest.setValue("anonymous", forHTTPHeaderField: "User-Agent")
        anonymousRequest.setValue("*", forHTTPHeaderField: "Accept-Language")
        let collector = ReleaseResponseCollector(maximumBytes: maximumResponseBytes)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 2
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.httpAdditionalHeaders = [
            "User-Agent": "anonymous",
            "Accept-Language": "*",
        ]
        let session = URLSession(
            configuration: configuration,
            delegate: collector,
            delegateQueue: nil
        )
        let task = session.dataTask(with: anonymousRequest)
        task.resume()
        guard collector.wait(timeout: 2) else {
            task.cancel()
            session.invalidateAndCancel()
            throw URLError(.timedOut)
        }
        session.finishTasksAndInvalidate()
        return try collector.value()
    }

    public static func liveNotifier() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = [
            "-e",
            "display notification \"Run raiders update.\" with title \"Runtime Raiders update available\"",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }
        do {
            try process.run()
        } catch {
            return false
        }
        guard completed.wait(timeout: .now() + 2) == .success else {
            process.terminate()
            return false
        }
        return process.terminationStatus == 0
    }

    private func fetchNowUnlocked() throws -> ReleaseManifestV1 {
        var request = URLRequest(url: ReleaseManifestV1.manifestURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 2
        request.httpBody = nil
        let response = try transport(request)
        guard response.statusCode == 200,
              response.body.count <= Self.maximumResponseBytes else {
            throw URLError(.badServerResponse)
        }
        return try ReleaseManifestV1.decode(response.body)
    }

    private func merge(
        _ fetched: ReleaseManifestV1,
        into state: inout UpdateStateV1
    ) -> ReleaseManifestV1 {
        if let cached = state.cachedManifest,
           cached.releaseSequence >= fetched.releaseSequence {
            return cached
        }
        guard fetched.releaseSequence > installed.releaseSequence,
              fetched.availability(from: installed) != nil else {
            return fetched
        }
        state.cachedManifest = fetched
        state.lastObservedReleaseSequence = fetched.releaseSequence
        return fetched
    }

    private static func availability(
        state: UpdateStateV1,
        installed: CompanionReleaseIdentity
    ) -> CompanionUpdateAvailability? {
        state.cachedManifest?.availability(from: installed)
    }
}

private final class ReleaseResponseCollector: NSObject, URLSessionDataDelegate,
    URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private let maximumBytes: Int
    private var data = Data()
    private var response: HTTPURLResponse?
    private var error: Error?
    private var finished = false

    init(maximumBytes: Int) { self.maximumBytes = maximumBytes }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let shouldCancel = lock.withLock { () -> Bool in
            self.response = response as? HTTPURLResponse
            let length = response.expectedContentLength
            if length > maximumBytes {
                error = URLError(.dataLengthExceedsMaximum)
                return true
            }
            return false
        }
        completionHandler(shouldCancel ? .cancel : .allow)
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
        let shouldSignal = lock.withLock { () -> Bool in
            if error == nil { error = completionError }
            guard !finished else { return false }
            finished = true
            return true
        }
        if shouldSignal { semaphore.signal() }
    }

    func wait(timeout: TimeInterval) -> Bool {
        semaphore.wait(timeout: .now() + timeout) == .success
    }

    func value() throws -> UploadHTTPResponse {
        try lock.withLock {
            if let error { throw error }
            guard let response else { throw URLError(.badServerResponse) }
            return UploadHTTPResponse(statusCode: response.statusCode, body: data)
        }
    }
}

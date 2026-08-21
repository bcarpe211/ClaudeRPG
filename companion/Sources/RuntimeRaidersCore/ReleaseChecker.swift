import Darwin
import Foundation

@_silgen_name("flock")
private func updateStateFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

public struct UpdateStateV1: Codable, Equatable, Sendable {
    public var version = 1
    public var lastCheckAttemptMS: Int64?
    public var lastNotifiedVersion: String?
    public var availableVersion: String?

    public init(
        lastCheckAttemptMS: Int64? = nil,
        lastNotifiedVersion: String? = nil,
        availableVersion: String? = nil
    ) {
        self.lastCheckAttemptMS = lastCheckAttemptMS
        self.lastNotifiedVersion = lastNotifiedVersion
        self.availableVersion = availableVersion
    }
}

public final class UpdateStateStore: @unchecked Sendable {
    private static let maximumBytes = 16 * 1_024
    private static let allowedKeys: Set<String> = [
        "version", "lastCheckAttemptMS", "lastNotifiedVersion", "availableVersion",
    ]

    private let file: URL
    private let directoryDescriptor: Int32
    private let lockDescriptor: Int32
    private let atomicStore: AtomicStore
    private let lock = NSLock()

    public init(paths: AgentPaths) throws {
        file = paths.updateState
        directoryDescriptor = try OwnerOnlyDirectory.openOrCreate(paths.stateDirectory)
        lockDescriptor = Darwin.openat(
            directoryDescriptor, "update-state.lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            mode_t(0o600)
        )
        guard lockDescriptor >= 0 else {
            Darwin.close(directoryDescriptor)
            throw AgentControllerError.invalidState
        }
        var metadata = stat()
        guard Darwin.fstat(lockDescriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            Darwin.close(lockDescriptor)
            Darwin.close(directoryDescriptor)
            throw AgentControllerError.invalidState
        }
        atomicStore = AtomicStore()
    }

    deinit {
        Darwin.close(lockDescriptor)
        Darwin.close(directoryDescriptor)
    }

    public func load() throws -> UpdateStateV1 { try withFileLock { try loadUnlocked() } }

    public func save(_ state: UpdateStateV1) throws {
        try withFileLock { try saveUnlocked(state) }
    }

    func withExclusiveState<Result>(
        _ body: (inout UpdateStateV1) throws -> Result
    ) throws -> Result {
        try withFileLock {
            var state = try loadUnlocked()
            let result = try body(&state)
            try saveUnlocked(state)
            return result
        }
    }

    private func withFileLock<Result>(_ body: () throws -> Result) throws -> Result {
        try lock.withLock {
            while updateStateFlock(lockDescriptor, LOCK_EX) != 0 {
                guard errno == EINTR else { throw AgentControllerError.invalidState }
            }
            defer { _ = updateStateFlock(lockDescriptor, LOCK_UN) }
            return try body()
        }
    }

    private func loadUnlocked() throws -> UpdateStateV1 {
        do {
            guard let data = try read() else { return UpdateStateV1() }
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys).isSubset(of: Self.allowedKeys),
                  object["version"] != nil,
                  let state = try? JSONDecoder().decode(UpdateStateV1.self, from: data),
                  Self.valid(state) else {
                return try replaceMalformedStateUnlocked()
            }
            return state
        } catch {
            return try replaceMalformedStateUnlocked()
        }
    }

    private func saveUnlocked(_ state: UpdateStateV1) throws {
        guard Self.valid(state) else { throw AgentControllerError.invalidState }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(state)
        guard data.count <= Self.maximumBytes else { throw AgentControllerError.invalidState }
        try atomicStore.write(data, directoryDescriptor: directoryDescriptor, name: file.lastPathComponent)
    }

    private func replaceMalformedStateUnlocked() throws -> UpdateStateV1 {
        let empty = UpdateStateV1()
        try saveUnlocked(empty)
        return empty
    }

    private func read() throws -> Data? {
        let descriptor = Darwin.openat(
            directoryDescriptor, file.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_CLOEXEC
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
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
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
              state.lastCheckAttemptMS.map({ (0...9_007_199_254_740_991).contains($0) }) ?? true,
              state.lastNotifiedVersion.map(validVersion) ?? true,
              state.availableVersion.map(validVersion) ?? true else {
            return false
        }
        return true
    }

    private static func validVersion(_ value: String) -> Bool {
        (try? SemanticVersion(value)) != nil
    }
}

public enum VersionCheckResult: Equatable, Sendable {
    case notDue
    case checked(availableVersion: String?)
    case failed
}

public final class ReleaseChecker: @unchecked Sendable {
    public typealias Transport = @Sendable (URLRequest) throws -> UploadHTTPResponse
    public typealias Notifier = @Sendable () -> Bool
    public typealias Clock = @Sendable () -> Int64

    private static let checkIntervalMS: Int64 = 24 * 60 * 60 * 1_000
    private static let maximumResponseBytes = 64 * 1_024

    private let installedVersion: SemanticVersion
    private let store: UpdateStateStore
    private let transport: Transport
    private let notifier: Notifier
    private let clockMS: Clock
    private let lock = NSLock()

    public init(
        paths: AgentPaths,
        installedVersion: String,
        transport: @escaping Transport = ReleaseChecker.liveTransport,
        notifier: @escaping Notifier = ReleaseChecker.liveNotifier,
        clockMS: @escaping Clock = { Int64(Date().timeIntervalSince1970 * 1_000) }
    ) throws {
        self.installedVersion = try SemanticVersion(installedVersion)
        store = try UpdateStateStore(paths: paths)
        self.transport = transport
        self.notifier = notifier
        self.clockMS = clockMS
    }

    public func checkIfDue() -> VersionCheckResult {
        lock.withLock {
            do {
                let now = clockMS()
                let due = try store.withExclusiveState { state -> Bool in
                    if let lastAttempt = state.lastCheckAttemptMS,
                       now < lastAttempt || now - lastAttempt < Self.checkIntervalMS {
                        return false
                    }
                    state.lastCheckAttemptMS = max(state.lastCheckAttemptMS ?? 0, now)
                    return true
                }
                guard due else { return .notDue }

                let fetched = try fetchDocument()
                var shouldNotify = false
                let available = try store.withExclusiveState { state -> String? in
                    let available = availableVersion(from: fetched)
                    state.availableVersion = available
                    if let available, let availableSemantic = try? SemanticVersion(available) {
                        let lastNotified = state.lastNotifiedVersion.flatMap {
                            try? SemanticVersion($0)
                        }
                        if lastNotified == nil || lastNotified! < availableSemantic {
                            state.lastNotifiedVersion = available
                            shouldNotify = true
                        }
                    }
                    return available
                }
                if shouldNotify { _ = notifier() }
                return .checked(availableVersion: available)
            } catch {
                return .failed
            }
        }
    }

    public func fetchNow() throws -> String {
        try lock.withLock {
            let now = clockMS()
            guard now >= 0 else { throw URLError(.badServerResponse) }
            try store.withExclusiveState { state in
                state.lastCheckAttemptMS = max(state.lastCheckAttemptMS ?? 0, now)
            }
            let fetched = try fetchDocument()
            return try store.withExclusiveState { state in
                let available = availableVersion(from: fetched)
                state.availableVersion = available
                return fetched.version
            }
        }
    }

    public func availability() -> String? {
        lock.withLock {
            guard let cachedVersion = try? store.load().availableVersion else { return nil }
            return Self.availableVersion(
                installedVersion: installedVersion.rawValue,
                cachedVersion: cachedVersion
            )
        }
    }

    public static func availableVersion(
        installedVersion: String,
        cachedVersion: String?
    ) -> String? {
        guard let cachedVersion,
              let installed = try? SemanticVersion(installedVersion),
              let available = try? SemanticVersion(cachedVersion),
              installed < available else {
            return nil
        }
        return cachedVersion
    }

    public static func liveTransport(_ request: URLRequest) throws -> UploadHTTPResponse {
        try liveTransport(request, allowedURL: VersionDocument.url)
    }

    /// This seam is absent from the installed LaunchAgent and installer environment. When the
    /// exact opt-in key is unset, callers retain the live HTTPS transport unchanged. A verifier
    /// can use an owner-only local response for the informational update command without network.
    public static func verificationTransport(
        environment: [String: String]
    ) throws -> Transport? {
        guard let path = environment["RUNTIME_RAIDERS_VERIFY_VERSION_RESPONSE_FILE"] else {
            return nil
        }
        guard path.hasPrefix("/"), !path.contains("\n") else {
            throw URLError(.badURL)
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw URLError(.cannotOpenFile) }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size > 0,
              metadata.st_size <= maximumResponseBytes else {
            throw URLError(.noPermissionsToReadFile)
        }
        var body = Data(count: Int(metadata.st_size))
        var offset = 0
        try body.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw URLError(.cannotOpenFile) }
            }
        }
        var extra: UInt8 = 0
        while true {
            let count = Darwin.read(descriptor, &extra, 1)
            if count == 0 { break }
            if count < 0, errno == EINTR { continue }
            throw URLError(.cannotOpenFile)
        }
        let capturedBody = body
        return { request in
            guard request.url == VersionDocument.url,
                  request.httpMethod == "GET",
                  request.httpBody == nil,
                  request.allHTTPHeaderFields?.isEmpty ?? true else {
                throw URLError(.unsupportedURL)
            }
            return UploadHTTPResponse(statusCode: 200, body: capturedBody)
        }
    }

    static func liveTransport(_ request: URLRequest, allowedURL: URL) throws -> UploadHTTPResponse {
        guard request.url == allowedURL,
              request.httpMethod == "GET",
              request.httpBody == nil,
              request.allHTTPHeaderFields?.isEmpty ?? true else {
            throw URLError(.unsupportedURL)
        }
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
        let session = URLSession(configuration: configuration, delegate: collector, delegateQueue: nil)
        let task = session.dataTask(with: request)
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
            "-e", "display notification \"Run raiders update.\" with title \"Runtime Raiders update available\"",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }
        do { try process.run() } catch { return false }
        guard completed.wait(timeout: .now() + 2) == .success else {
            process.terminate()
            return false
        }
        return process.terminationStatus == 0
    }

    private func fetchDocument() throws -> VersionDocument {
        var request = URLRequest(url: VersionDocument.url)
        request.httpMethod = "GET"
        request.timeoutInterval = 2
        request.httpBody = nil
        let response = try transport(request)
        guard response.statusCode == 200, response.body.count <= Self.maximumResponseBytes else {
            throw URLError(.badServerResponse)
        }
        return try VersionDocument.decode(response.body)
    }

    private func availableVersion(from document: VersionDocument) -> String? {
        Self.availableVersion(
            installedVersion: installedVersion.rawValue,
            cachedVersion: document.version
        )
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
            if response.expectedContentLength > maximumBytes {
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
    ) { completionHandler(nil) }

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

    func wait(timeout: TimeInterval) -> Bool { semaphore.wait(timeout: .now() + timeout) == .success }

    func value() throws -> UploadHTTPResponse {
        try lock.withLock {
            if let error { throw error }
            guard let response else { throw URLError(.badServerResponse) }
            return UploadHTTPResponse(statusCode: response.statusCode, body: data)
        }
    }
}

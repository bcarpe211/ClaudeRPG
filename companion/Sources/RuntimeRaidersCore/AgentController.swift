import Darwin
import Foundation

public struct AgentConfiguration: Equatable, Sendable {
    public let companionVersion: String
    public let deviceID: String
    public let dedupeSecret: Data

    public init(companionVersion: String, deviceID: String, dedupeSecret: Data) {
        self.companionVersion = companionVersion
        self.deviceID = deviceID
        self.dedupeSecret = dedupeSecret
    }
}

public enum AdapterHealth: String, Codable, Equatable, Sendable {
    case available
    case disabled
    case unavailable
}

public struct AgentStatus: Codable, Equatable, CustomStringConvertible, Sendable {
    public let enabled: Bool
    public let daemonRunning: Bool
    public let serverEnabledSurfaces: [RunSurface]
    public let compiledAdapters: [RunSurface: AdapterHealth]
    public let queuedEventCount: Int
    public let lastSuccessfulUploadMS: Int64?
    public let activeRunCount: Int

    public init(
        enabled: Bool,
        daemonRunning: Bool,
        serverEnabledSurfaces: [RunSurface],
        compiledAdapters: [RunSurface: AdapterHealth],
        queuedEventCount: Int,
        lastSuccessfulUploadMS: Int64?,
        activeRunCount: Int
    ) {
        self.enabled = enabled
        self.daemonRunning = daemonRunning
        self.serverEnabledSurfaces = serverEnabledSurfaces
        self.compiledAdapters = compiledAdapters
        self.queuedEventCount = queuedEventCount
        self.lastSuccessfulUploadMS = lastSuccessfulUploadMS
        self.activeRunCount = activeRunCount
    }

    public var description: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? String(decoding: encoder.encode(self), as: UTF8.self)) ?? "{}"
    }
}

public struct DoctorReport: Codable, Equatable, CustomStringConvertible, Sendable {
    public let codexRootReadable: Bool
    public let serverHealthy: Bool
    public let signingValid: Bool
    public let enrollmentMatchesCompiledAdapters: Bool
    public let claudeOTelEnvironmentPresent: Bool

    public init(
        codexRootReadable: Bool,
        serverHealthy: Bool,
        signingValid: Bool,
        enrollmentMatchesCompiledAdapters: Bool,
        claudeOTelEnvironmentPresent: Bool
    ) {
        self.codexRootReadable = codexRootReadable
        self.serverHealthy = serverHealthy
        self.signingValid = signingValid
        self.enrollmentMatchesCompiledAdapters = enrollmentMatchesCompiledAdapters
        self.claudeOTelEnvironmentPresent = claudeOTelEnvironmentPresent
    }

    public var description: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? String(decoding: encoder.encode(self), as: UTF8.self)) ?? "{}"
    }
}

public enum AgentControllerError: Error, Equatable {
    case invalidConfiguration
    case invalidReadLimit
    case invalidState
}

public enum EnrollmentConfigurationError: Error, Equatable {
    case invalidFile
    case invalidConfiguration
}

public struct EnrollmentConfiguration: Equatable, Sendable {
    public let deviceID: String
    public let deviceToken: String
    public let dedupeSecret: Data
    public let serverURL: URL
    public let cutoverAtMS: Int64
    public let enabledSurfaces: [RunSurface]

    public static func load(from file: URL) throws -> EnrollmentConfiguration {
        try load(from: file, allowsTestOrigin: false)
    }

    public static func loadExisting(from file: URL) throws -> EnrollmentConfiguration {
        guard let parentDescriptor = try OwnerOnlyDirectory.openExisting(
            file.deletingLastPathComponent()
        ) else { throw EnrollmentConfigurationError.invalidFile }
        defer { Darwin.close(parentDescriptor) }
        return try load(
            from: file,
            parentDescriptor: parentDescriptor,
            allowsTestOrigin: false
        )
    }

    static func load(
        from file: URL,
        allowsTestOrigin: Bool
    ) throws -> EnrollmentConfiguration {
        let parentDescriptor = try OwnerOnlyDirectory.openOrCreate(
            file.deletingLastPathComponent()
        )
        defer { Darwin.close(parentDescriptor) }
        return try load(
            from: file,
            parentDescriptor: parentDescriptor,
            allowsTestOrigin: allowsTestOrigin
        )
    }

    private static func load(
        from file: URL,
        parentDescriptor: Int32,
        allowsTestOrigin: Bool
    ) throws -> EnrollmentConfiguration {
        let descriptor = Darwin.openat(
            parentDescriptor,
            file.lastPathComponent,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw EnrollmentConfigurationError.invalidFile }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_size > 0,
              metadata.st_size <= 65_536 else {
            throw EnrollmentConfigurationError.invalidFile
        }
        var data = Data(count: Int(metadata.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw EnrollmentConfigurationError.invalidFile }
            }
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == [
                "version", "device_id", "device_token", "dedupe_secret",
                "server_url", "cutover_at", "enabled_surfaces",
              ],
              let wire = try? JSONDecoder().decode(EnrollmentWire.self, from: data),
              wire.version == 1,
              UUID(uuidString: wire.deviceID) != nil,
              wire.deviceToken.range(
                of: #"^[A-Za-z0-9_-]{43}$"#,
                options: .regularExpression
              ) != nil,
              let secret = decodeLowerHex(wire.dedupeSecret),
              secret.count == 32,
              let serverURL = URL(string: wire.serverURL),
              allowsTestOrigin || serverURL.absoluteString == "https://raiders.redlattice.com",
              (0...9_007_199_254_740_991).contains(wire.cutoverAtMS),
              !wire.enabledSurfaces.isEmpty,
              Set(wire.enabledSurfaces).count == wire.enabledSurfaces.count,
              wire.enabledSurfaces.allSatisfy({
                  $0 == .codexDesktop || $0 == .codexCLI
              }) else {
            throw EnrollmentConfigurationError.invalidConfiguration
        }
        return EnrollmentConfiguration(
            deviceID: wire.deviceID,
            deviceToken: wire.deviceToken,
            dedupeSecret: secret,
            serverURL: serverURL,
            cutoverAtMS: wire.cutoverAtMS,
            enabledSurfaces: wire.enabledSurfaces
        )
    }

    private struct EnrollmentWire: Decodable {
        let version: Int
        let deviceID: String
        let deviceToken: String
        let dedupeSecret: String
        let serverURL: String
        let cutoverAtMS: Int64
        let enabledSurfaces: [RunSurface]

        enum CodingKeys: String, CodingKey {
            case version
            case deviceID = "device_id"
            case deviceToken = "device_token"
            case dedupeSecret = "dedupe_secret"
            case serverURL = "server_url"
            case cutoverAtMS = "cutover_at"
            case enabledSurfaces = "enabled_surfaces"
        }
    }

    private static func decodeLowerHex(_ value: String) -> Data? {
        let bytes = Array(value.utf8)
        guard bytes.count == 64 else { return nil }
        var output = Data()
        output.reserveCapacity(32)
        for index in stride(from: 0, to: bytes.count, by: 2) {
            guard let high = nibble(bytes[index]), let low = nibble(bytes[index + 1]) else {
                return nil
            }
            output.append((high << 4) | low)
        }
        return output
    }

    private static func nibble(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: byte - 48
        case 97...102: byte - 87
        default: nil
        }
    }
}

public final class AgentController: @unchecked Sendable {
    private struct PersistedFileState: Codable {
        var cursor: JSONLCursor
        var nextOrdinal: Int64
        var adapterSnapshots: [String: Data]
        var seeding: Bool
        var seedTargetOffset: Int64?
        var seedFileIdentity: JSONLFileIdentity?
    }

    private struct PersistedState: Codable {
        var version: Int
        var enabled: Bool
        var files: [String: PersistedFileState]
    }

    public typealias Clock = () -> Int64

    private let registry: AdapterRegistry
    private let paths: AgentPaths
    private let outbox: Outbox
    private let configuration: AgentConfiguration
    private let readLimitBytes: Int
    private let clockMS: Clock
    private let afterProviderRead: @Sendable () -> Void
    private let stateDirectoryDescriptor: Int32
    private let lock = NSRecursiveLock()
    private let acceptanceLock = NSLock()
    private var state: PersistedState
    private var acceptingCollection = false
    private var runRegistry = RunRegistry()
    private var pendingPaths: Set<String> = []
    public private(set) var lastCallbackBytesRead = 0

    public init(
        registry: AdapterRegistry,
        paths: AgentPaths,
        outbox: Outbox,
        configuration: AgentConfiguration,
        readLimitBytes: Int = JSONLReader.maximumReadBytes,
        clockMS: @escaping Clock = { Int64(Date().timeIntervalSince1970 * 1_000) },
        afterProviderRead: @escaping @Sendable () -> Void = {}
    ) throws {
        guard !configuration.companionVersion.isEmpty,
              UUID(uuidString: configuration.deviceID) != nil,
              !configuration.dedupeSecret.isEmpty else {
            throw AgentControllerError.invalidConfiguration
        }
        guard (1...JSONLReader.maximumReadBytes).contains(readLimitBytes) else {
            throw AgentControllerError.invalidReadLimit
        }
        self.registry = registry
        self.paths = paths
        self.outbox = outbox
        self.configuration = configuration
        self.readLimitBytes = readLimitBytes
        self.clockMS = clockMS
        self.afterProviderRead = afterProviderRead
        try Self.createPrivateDirectory(paths.supportDirectory)
        let stateDirectoryDescriptor = try OwnerOnlyDirectory.openOrCreate(paths.stateDirectory)
        do {
            if let data = try Self.readState(
                directoryDescriptor: stateDirectoryDescriptor,
                name: "collector-state.json",
                maximumBytes: 4 * 1_024 * 1_024
            ) {
                guard let decoded = try? JSONDecoder().decode(PersistedState.self, from: data),
                      Self.valid(decoded, surfaces: registry.surfaces) else {
                    throw AgentControllerError.invalidState
                }
                state = decoded
            } else {
                state = PersistedState(version: 1, enabled: true, files: [:])
            }
            self.stateDirectoryDescriptor = stateDirectoryDescriptor
            acceptingCollection = state.enabled
        } catch {
            Darwin.close(stateDirectoryDescriptor)
            throw error
        }
    }

    deinit { Darwin.close(stateDirectoryDescriptor) }

    public var enabled: Bool { lock.withLock { state.enabled } }
    public var isAcceptingCollection: Bool { acceptanceLock.withLock { acceptingCollection } }
    public var activeRunCount: Int { lock.withLock { runRegistry.activeRunCount } }
    public var hasPendingSeedWork: Bool {
        lock.withLock { state.enabled && state.files.values.contains(where: \.seeding) }
    }
    public var hasPendingReadWork: Bool {
        lock.withLock { state.enabled && !pendingPaths.isEmpty }
    }

    public static func persistedEnabled(
        paths: AgentPaths,
        surfaces: [RunSurface]
    ) throws -> Bool? {
        guard let descriptor = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) else {
            return nil
        }
        defer { Darwin.close(descriptor) }
        guard let data = try readState(
            directoryDescriptor: descriptor,
            name: "collector-state.json",
            maximumBytes: 4 * 1_024 * 1_024
        ) else { return nil }
        guard let decoded = try? JSONDecoder().decode(PersistedState.self, from: data),
              valid(decoded, surfaces: surfaces) else {
            throw AgentControllerError.invalidState
        }
        return decoded.enabled
    }

    public func install(existingFiles: [URL]) throws {
        try lock.withLock {
            for file in normalized(existingFiles) where state.files[file.path] == nil {
                state.files[file.path] = initialFileState(seeding: true)
            }
            try persist()
            guard state.enabled else {
                lastCallbackBytesRead = 0
                return
            }
            try process(files: normalized(existingFiles))
        }
    }

    public func pauseCollection() {
        acceptanceLock.withLock { acceptingCollection = false }
    }

    public func turnOff() throws {
        pauseCollection()
        try lock.withLock {
            state.enabled = false
            runRegistry = RunRegistry()
            pendingPaths.removeAll()
            for path in state.files.keys {
                guard var fileState = state.files[path] else { continue }
                fileState.seeding = true
                fileState.adapterSnapshots = try snapshotsPreparedForSeeding(
                    from: fileState.adapterSnapshots
                )
                fileState.seedTargetOffset = nil
                fileState.seedFileIdentity = nil
                state.files[path] = fileState
            }
            lastCallbackBytesRead = 0
            try persist()
        }
    }

    public func turnOn(existingFiles: [URL]) throws {
        try lock.withLock {
            guard !state.enabled else {
                lastCallbackBytesRead = 0
                acceptanceLock.withLock { acceptingCollection = true }
                return
            }
            state.enabled = true
            runRegistry = RunRegistry()
            pendingPaths.removeAll()
            for path in state.files.keys {
                guard var fileState = state.files[path] else { continue }
                fileState.seeding = true
                fileState.adapterSnapshots = try snapshotsPreparedForSeeding(
                    from: fileState.adapterSnapshots
                )
                fileState.seedTargetOffset = nil
                fileState.seedFileIdentity = nil
                state.files[path] = fileState
            }
            for file in normalized(existingFiles) {
                if var fileState = state.files[file.path] {
                    fileState.seeding = true
                    fileState.adapterSnapshots = try snapshotsPreparedForSeeding(
                        from: fileState.adapterSnapshots
                    )
                    fileState.seedTargetOffset = nil
                    fileState.seedFileIdentity = nil
                    state.files[file.path] = fileState
                } else {
                    state.files[file.path] = initialFileState(seeding: true)
                }
            }
            try persist()
            try process(files: normalized(existingFiles), bypassAcceptance: true)
            acceptanceLock.withLock { acceptingCollection = true }
        }
    }

    public func processChangedFiles(_ files: [URL]) throws {
        try lock.withLock {
            guard state.enabled, isAcceptingCollection else {
                lastCallbackBytesRead = 0
                return
            }
            for file in normalized(files) where state.files[file.path] == nil {
                state.files[file.path] = initialFileState(seeding: true)
            }
            try persist()
            try process(files: normalized(files))
        }
    }

    public func continueSeeding() throws {
        try continuePendingWork()
    }

    public func continuePendingWork() throws {
        try lock.withLock {
            guard state.enabled, isAcceptingCollection else {
                lastCallbackBytesRead = 0
                return
            }
            let files = pendingPaths
                .map { URL(fileURLWithPath: $0) }
            try process(files: normalized(files))
        }
    }

    public func status(
        daemonRunning: Bool,
        serverEnabledSurfaces: [RunSurface],
        lastSuccessfulUploadMS: Int64?
    ) throws -> AgentStatus {
        try lock.withLock {
            var health: [RunSurface: AdapterHealth] = [
                .claudeCode: .unavailable,
                .omp: .unavailable,
                .codexDesktop: .disabled,
                .codexCLI: .disabled,
            ]
            for surface in registry.surfaces { health[surface] = .available }
            return AgentStatus(
                enabled: state.enabled,
                daemonRunning: daemonRunning,
                serverEnabledSurfaces: serverEnabledSurfaces.sorted { $0.rawValue < $1.rawValue },
                compiledAdapters: health,
                queuedEventCount: try outbox.queuedCount(),
                lastSuccessfulUploadMS: lastSuccessfulUploadMS,
                activeRunCount: runRegistry.activeRunCount
            )
        }
    }

    public func doctor(
        codexRootReadable: Bool,
        serverHealthy: Bool,
        signingValid: Bool,
        enrollmentAllowedSurfaces: [RunSurface],
        environment: [String: String]
    ) -> DoctorReport {
        doctor(
            codexRootReadable: codexRootReadable,
            serverHealthy: serverHealthy,
            signingValid: signingValid,
            enrollmentAllowedSurfaces: enrollmentAllowedSurfaces,
            claudeOTelEnvironmentPresent: DoctorEnvironment.claudeOTelPresent(
                in: environment
            )
        )
    }

    public func doctor(
        codexRootReadable: Bool,
        serverHealthy: Bool,
        signingValid: Bool,
        enrollmentAllowedSurfaces: [RunSurface],
        claudeOTelEnvironmentPresent: Bool
    ) -> DoctorReport {
        return DoctorReport(
            codexRootReadable: codexRootReadable,
            serverHealthy: serverHealthy,
            signingValid: signingValid,
            enrollmentMatchesCompiledAdapters: Set(enrollmentAllowedSurfaces) == Set(registry.surfaces),
            claudeOTelEnvironmentPresent: claudeOTelEnvironmentPresent
        )
    }

    private func process(files: [URL], bypassAcceptance: Bool = false) throws {
        guard bypassAcceptance || isAcceptingCollection else {
            lastCallbackBytesRead = 0
            return
        }
        pendingPaths.formUnion(files.map(\.path))
        var remaining = readLimitBytes
        lastCallbackBytesRead = 0
        for file in files where remaining > 0 {
            guard bypassAcceptance || isAcceptingCollection else { return }
            guard var fileState = state.files[file.path] else { continue }
            let approved: ApprovedProviderFile
            do {
                approved = try registry.approveProviderFile(file)
            } catch {
                pendingPaths.remove(file.path)
                continue
            }
            let snapshot: (identity: JSONLFileIdentity, size: Int64)
            do {
                snapshot = try approved.snapshot()
            } catch {
                pendingPaths.remove(file.path)
                continue
            }
            let trackedIdentity = fileState.cursor.fileIdentity
            if fileState.seeding {
                if fileState.seedTargetOffset == nil
                    || fileState.seedFileIdentity != snapshot.identity {
                    if fileState.seedFileIdentity != nil
                        || (trackedIdentity != nil && trackedIdentity != snapshot.identity) {
                        fileState.cursor = JSONLCursor()
                        fileState.nextOrdinal = 0
                        fileState.adapterSnapshots = initialSnapshots()
                    }
                    fileState.seedTargetOffset = snapshot.size
                    fileState.seedFileIdentity = snapshot.identity
                    state.files[file.path] = fileState
                    try persist()
                }
            } else if let trackedIdentity, trackedIdentity != snapshot.identity {
                fileState = initialFileState(seeding: true)
                fileState.seedTargetOffset = snapshot.size
                fileState.seedFileIdentity = snapshot.identity
                state.files[file.path] = fileState
                try persist()
            }

            let priorCursor = fileState.cursor
            let priorIdentity = priorCursor.fileIdentity
            let priorOffset = priorCursor.offset
            let seedTarget = fileState.seedTargetOffset
            if fileState.seeding, seedTarget == 0, priorOffset == 0 {
                fileState.cursor = JSONLCursor(fileIdentity: snapshot.identity)
                finishSeeding(&fileState)
                state.files[file.path] = fileState
                try persist()
                continue
            }
            let requestedBytes: Int
            if fileState.seeding, let seedTarget, seedTarget > priorOffset {
                requestedBytes = min(remaining, Int(seedTarget - priorOffset))
            } else if fileState.seeding {
                requestedBytes = min(remaining, 1)
            } else {
                requestedBytes = remaining
            }
            let result: JSONLReadResult
            do {
                result = try approved.readAppended(
                    cursor: fileState.cursor,
                    maxBytes: requestedBytes
                )
            } catch {
                pendingPaths.remove(file.path)
                continue
            }
            afterProviderRead()
            guard bypassAcceptance || isAcceptingCollection else { return }
            remaining -= result.bytesRead
            lastCallbackBytesRead += result.bytesRead
            if fileState.seeding {
                guard result.cursor.fileIdentity == fileState.seedFileIdentity,
                      let seedTarget else {
                    fileState = initialFileState(seeding: true)
                    state.files[file.path] = fileState
                    try persist()
                    continue
                }
                let readerReset = result.cursor.offset != priorOffset + Int64(result.bytesRead)
                if readerReset {
                    fileState = initialFileState(seeding: true)
                    fileState.seedTargetOffset = snapshot.size
                    fileState.seedFileIdentity = snapshot.identity
                    state.files[file.path] = fileState
                    try persist()
                    continue
                }
                if priorOffset >= seedTarget {
                    fileState.cursor = priorCursor
                    finishSeeding(&fileState)
                } else {
                    var adapters = try restoredAdapters(from: fileState.adapterSnapshots)
                    for line in result.lines {
                        let source = ProviderRecordSource(ordinal: fileState.nextOrdinal)
                        fileState.nextOrdinal += 1
                        for index in adapters.indices {
                            adapters[index].consumeDuringSeeding(
                                line: line,
                                source: source,
                                observedAt: clockMS()
                            )
                        }
                    }
                    fileState.cursor = result.cursor
                    fileState.adapterSnapshots = try snapshots(of: adapters)
                    if result.cursor.offset >= seedTarget || result.bytesRead < requestedBytes {
                        finishSeeding(&fileState)
                    }
                }
                guard bypassAcceptance || isAcceptingCollection else { return }
                state.files[file.path] = fileState
                try persist()
                continue
            }

            if result.bytesRead < requestedBytes {
                pendingPaths.remove(file.path)
            }

            var adapters = try restoredAdapters(from: fileState.adapterSnapshots)
            let readerReset = result.cursor.offset != priorOffset + Int64(result.bytesRead)
            if readerReset || (priorIdentity != nil && priorIdentity != result.cursor.fileIdentity) {
                adapters = freshAdapters()
                fileState.nextOrdinal = 0
            }
            for line in result.lines {
                guard bypassAcceptance || isAcceptingCollection else { return }
                let source = ProviderRecordSource(ordinal: fileState.nextOrdinal)
                fileState.nextOrdinal += 1
                for index in adapters.indices {
                    let observations = adapters[index].consume(
                        line: line,
                        source: source,
                        observedAt: clockMS()
                    )
                    for observation in observations {
                        guard bypassAcceptance || isAcceptingCollection else { return }
                        let event = try registry.event(
                            from: observation,
                            dedupeSecret: configuration.dedupeSecret,
                            companionVersion: configuration.companionVersion,
                            deviceID: configuration.deviceID
                        )
                        _ = try PrivacyEncoder().encode(event)
                        try outbox.enqueue(event)
                        runRegistry.observe(event)
                    }
                }
            }
            guard bypassAcceptance || isAcceptingCollection else { return }
            fileState.cursor = result.cursor
            fileState.adapterSnapshots = try snapshots(of: adapters)
            state.files[file.path] = fileState
            try persist()
        }
    }

    private func initialFileState(seeding: Bool) -> PersistedFileState {
        PersistedFileState(
            cursor: JSONLCursor(),
            nextOrdinal: 0,
            adapterSnapshots: initialSnapshots(),
            seeding: seeding,
            seedTargetOffset: nil,
            seedFileIdentity: nil
        )
    }

    private func finishSeeding(_ fileState: inout PersistedFileState) {
        if !fileState.cursor.partialLine.isEmpty { fileState.nextOrdinal += 1 }
        fileState.cursor.partialLine = Data()
        fileState.seeding = false
        fileState.seedTargetOffset = nil
        fileState.seedFileIdentity = nil
    }

    private func freshAdapters() -> [CodexAdapter] {
        registry.surfaces.map { CodexAdapter(expectedSurface: $0) }
    }

    private func initialSnapshots() -> [String: Data] {
        (try? snapshots(of: freshAdapters())) ?? [:]
    }

    private func snapshotsPreparedForSeeding(
        from snapshots: [String: Data]
    ) throws -> [String: Data] {
        var adapters = try restoredAdapters(from: snapshots)
        for index in adapters.indices { adapters[index].prepareForSeeding() }
        return try self.snapshots(of: adapters)
    }

    private func restoredAdapters(from snapshots: [String: Data]) throws -> [CodexAdapter] {
        try registry.surfaces.map { surface in
            guard let snapshot = snapshots[surface.rawValue] else {
                throw AgentControllerError.invalidState
            }
            return try CodexAdapter(snapshot: snapshot)
        }
    }

    private func snapshots(of adapters: [CodexAdapter]) throws -> [String: Data] {
        var output: [String: Data] = [:]
        for adapter in adapters { output[adapter.expectedSurface.rawValue] = try adapter.snapshot() }
        return output
    }

    private func normalized(_ files: [URL]) -> [URL] {
        Array(Set(files.map { URL(fileURLWithPath: $0.path) }))
            .sorted { $0.path < $1.path }
    }

    private func persist() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try Self.writeStateAtomically(
            try encoder.encode(state),
            directoryDescriptor: stateDirectoryDescriptor,
            name: "collector-state.json"
        )
    }

    private static func valid(_ state: PersistedState, surfaces: [RunSurface]) -> Bool {
        guard state.version == 1, state.files.count <= 16_384 else { return false }
        let expected = Set(surfaces.map(\.rawValue))
        return state.files.allSatisfy { path, file in
            path.utf8.count <= 16_384
                && file.nextOrdinal >= 0
                && ((file.seedTargetOffset == nil && file.seedFileIdentity == nil)
                    || (file.seeding
                        && file.seedFileIdentity != nil
                        && file.seedTargetOffset.map { $0 >= 0 } == true))
                && Set(file.adapterSnapshots.keys) == expected
                && file.adapterSnapshots.values.allSatisfy { $0.count <= 65_536 }
        }
    }

    private static func createPrivateDirectory(_ directory: URL) throws {
        let descriptor = try OwnerOnlyDirectory.openOrCreate(directory)
        Darwin.close(descriptor)
    }

    private static func readState(
        directoryDescriptor: Int32,
        name: String,
        maximumBytes: Int
    ) throws -> Data? {
        let descriptor = Darwin.openat(
            directoryDescriptor,
            name,
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
              metadata.st_size <= maximumBytes else {
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

    private static func writeStateAtomically(
        _ data: Data,
        directoryDescriptor: Int32,
        name: String
    ) throws {
        let temporary = ".\(name).runtime-raiders-tmp-\(UUID().uuidString)"
        let descriptor = Darwin.openat(
            directoryDescriptor,
            temporary,
            O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else { throw currentPOSIXError() }
        var open = true
        defer {
            if open { Darwin.close(descriptor) }
            _ = Darwin.unlinkat(directoryDescriptor, temporary, 0)
        }
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
                else { throw currentPOSIXError() }
            }
        }
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw currentPOSIXError()
        }
        guard Darwin.close(descriptor) == 0 else { throw currentPOSIXError() }
        open = false
        guard Darwin.renameat(
            directoryDescriptor,
            temporary,
            directoryDescriptor,
            name
        ) == 0 else { throw currentPOSIXError() }
        while Darwin.fsync(directoryDescriptor) != 0 {
            if errno == EINTR { continue }
            throw currentPOSIXError()
        }
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

enum OwnerOnlyDirectory {
    static func openOrCreate(_ url: URL) throws -> Int32 {
        guard url.isFileURL, url.path.hasPrefix("/") else {
            throw AgentControllerError.invalidState
        }
        var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { throw currentPOSIXError() }
        let components = url.pathComponents.filter { $0 != "/" }
        guard !components.isEmpty else {
            Darwin.close(descriptor)
            throw AgentControllerError.invalidState
        }
        for component in components {
            var next = Darwin.openat(
                descriptor,
                component,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            if next < 0, errno == ENOENT {
                guard Darwin.mkdirat(descriptor, component, 0o700) == 0 || errno == EEXIST else {
                    Darwin.close(descriptor)
                    throw currentPOSIXError()
                }
                next = Darwin.openat(
                    descriptor,
                    component,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
            }
            guard next >= 0 else {
                Darwin.close(descriptor)
                throw AgentControllerError.invalidState
            }
            Darwin.close(descriptor)
            descriptor = next
        }
        guard Darwin.fchmod(descriptor, 0o700) == 0 else {
            Darwin.close(descriptor)
            throw currentPOSIXError()
        }
        return descriptor
    }

    static func openExisting(_ url: URL) throws -> Int32? {
        guard url.isFileURL, url.path.hasPrefix("/") else {
            throw AgentControllerError.invalidState
        }
        var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { throw currentPOSIXError() }
        let components = url.pathComponents.filter { $0 != "/" }
        guard !components.isEmpty else {
            Darwin.close(descriptor)
            throw AgentControllerError.invalidState
        }
        for component in components {
            let next = Darwin.openat(
                descriptor,
                component,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            if next < 0 {
                let openError = errno
                Darwin.close(descriptor)
                if openError == ENOENT { return nil }
                throw AgentControllerError.invalidState
            }
            Darwin.close(descriptor)
            descriptor = next
        }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o700 else {
            Darwin.close(descriptor)
            throw AgentControllerError.invalidState
        }
        return descriptor
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

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

public enum PersistedCollectorState: String, Codable, Equatable, Sendable {
    case missing
    case invalid
    case enabled
    case disabled
}

public enum CollectorActivationState: String, Codable, Equatable, Sendable {
    case disabled
    case preparing
    case ready
}

public struct AgentStatus: Codable, Equatable, CustomStringConvertible, Sendable {
    public let enabled: Bool
    public let activationState: CollectorActivationState
    public let daemonRunning: Bool
    public let persistedState: PersistedCollectorState
    public let serverEnabledSurfaces: [RunSurface]
    public let compiledAdapters: [RunSurface: AdapterHealth]
    public let queuedEventCount: Int
    public let lastSuccessfulUploadMS: Int64?
    public let activeRunCount: Int
    public let installedCompanionVersion: String
    public let installedReleaseSequence: Int64
    public let availableCompanionVersion: String?
    public let availableReleaseSequence: Int64?
    public let updateCommand: String?
    public let preparedForUpdate: Bool
    public let preparedReleaseStateGeneration: Int64?

    public init(
        enabled: Bool,
        activationState: CollectorActivationState? = nil,
        daemonRunning: Bool,
        persistedState: PersistedCollectorState,
        serverEnabledSurfaces: [RunSurface],
        compiledAdapters: [RunSurface: AdapterHealth],
        queuedEventCount: Int,
        lastSuccessfulUploadMS: Int64?,
        activeRunCount: Int,
        installedCompanionVersion: String,
        installedReleaseSequence: Int64,
        availableCompanionVersion: String?,
        availableReleaseSequence: Int64?,
        updateCommand: String?,
        preparedReleaseStateGeneration: Int64? = nil
    ) {
        self.enabled = enabled
        self.activationState = activationState ?? (enabled ? .ready : .disabled)
        self.daemonRunning = daemonRunning
        self.persistedState = persistedState
        self.serverEnabledSurfaces = serverEnabledSurfaces
        self.compiledAdapters = compiledAdapters
        self.queuedEventCount = queuedEventCount
        self.lastSuccessfulUploadMS = lastSuccessfulUploadMS
        self.activeRunCount = activeRunCount
        self.installedCompanionVersion = installedCompanionVersion
        self.installedReleaseSequence = installedReleaseSequence
        self.availableCompanionVersion = availableCompanionVersion
        self.availableReleaseSequence = availableReleaseSequence
        self.updateCommand = updateCommand
        self.preparedForUpdate = preparedReleaseStateGeneration != nil
        self.preparedReleaseStateGeneration = preparedReleaseStateGeneration
    }

    public init(
        enabled: Bool,
        activationState: CollectorActivationState? = nil,
        daemonRunning: Bool,
        persistedState: PersistedCollectorState,
        serverEnabledSurfaces: [RunSurface],
        compiledAdapters: [RunSurface: AdapterHealth],
        queuedEventCount: Int,
        lastSuccessfulUploadMS: Int64?,
        activeRunCount: Int
    ) {
        self.init(
            enabled: enabled,
            activationState: activationState,
            daemonRunning: daemonRunning,
            persistedState: persistedState,
            serverEnabledSurfaces: serverEnabledSurfaces,
            compiledAdapters: compiledAdapters,
            queuedEventCount: queuedEventCount,
            lastSuccessfulUploadMS: lastSuccessfulUploadMS,
            activeRunCount: activeRunCount,
            installedCompanionVersion: "unknown",
            installedReleaseSequence: 0,
            availableCompanionVersion: nil,
            availableReleaseSequence: nil,
            updateCommand: nil,
            preparedReleaseStateGeneration: nil
        )
    }

    public var description: String {
        let encoder = JSONEncoder()
        guard let encoded = try? encoder.encode(self),
              var object = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        else { return "{}" }
        for key in [
            "availableCompanionVersion",
            "availableReleaseSequence",
            "lastSuccessfulUploadMS",
            "preparedReleaseStateGeneration",
            "updateCommand",
        ] where object[key] == nil {
            object[key] = NSNull()
        }
        guard let wire = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ) else { return "{}" }
        return String(decoding: wire, as: UTF8.self)
    }
}

public struct DoctorReport: Codable, Equatable, CustomStringConvertible, Sendable {
    public let codexRootReadable: Bool
    public let serverHealthy: Bool
    public let signingValid: Bool
    public let enrollmentMatchesCompiledAdapters: Bool
    public let claudeOTelEnvironmentPresent: Bool
    public let compatibilityNeedsReview: Bool
    public let compatibilityReasons: [CodexCompatibilityIssue]

    public init(
        codexRootReadable: Bool,
        serverHealthy: Bool,
        signingValid: Bool,
        enrollmentMatchesCompiledAdapters: Bool,
        claudeOTelEnvironmentPresent: Bool,
        compatibilityNeedsReview: Bool = false,
        compatibilityReasons: [CodexCompatibilityIssue] = []
    ) {
        self.codexRootReadable = codexRootReadable
        self.serverHealthy = serverHealthy
        self.signingValid = signingValid
        self.enrollmentMatchesCompiledAdapters = enrollmentMatchesCompiledAdapters
        self.claudeOTelEnvironmentPresent = claudeOTelEnvironmentPresent
        self.compatibilityNeedsReview = compatibilityNeedsReview
        self.compatibilityReasons = compatibilityReasons.sorted { $0.rawValue < $1.rawValue }
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

public enum CollectorDiagnostic: String, Equatable, Sendable {
    case deterministicRecordRejected = "deterministic_record_rejected"
}

public struct PersistedAdapterFacts: Equatable, Sendable {
    public let activeRunCount: Int
    public let compatibilityReasons: [CodexCompatibilityIssue]

    public init(activeRunCount: Int, compatibilityReasons: [CodexCompatibilityIssue]) {
        self.activeRunCount = activeRunCount
        self.compatibilityReasons = compatibilityReasons.sorted { $0.rawValue < $1.rawValue }
    }
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
    private static let maximumProvenanceBytes = 65_536

    private struct PersistedFileState: Codable {
        var cursor: JSONLCursor
        var nextOrdinal: Int64
        var adapterSnapshots: [String: Data]
        var seeding: Bool
        var seedTargetOffset: Int64?
        var seedFileIdentity: JSONLFileIdentity?
        var seedTargetCheckpoint: JSONLContinuityCheckpoint?
    }

    private struct PersistedState: Codable {
        var version: Int
        var enabled: Bool
        var files: [String: PersistedFileState]
        var deferredSeedPaths: Set<String>

        private enum CodingKeys: String, CodingKey {
            case version, enabled, files, deferredSeedPaths
        }

        init(
            version: Int,
            enabled: Bool,
            files: [String: PersistedFileState],
            deferredSeedPaths: Set<String> = []
        ) {
            self.version = version
            self.enabled = enabled
            self.files = files
            self.deferredSeedPaths = deferredSeedPaths
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            version = try container.decode(Int.self, forKey: .version)
            enabled = try container.decode(Bool.self, forKey: .enabled)
            files = try container.decode([String: PersistedFileState].self, forKey: .files)
            deferredSeedPaths = try container.decodeIfPresent(
                Set<String>.self,
                forKey: .deferredSeedPaths
            ) ?? []
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(version, forKey: .version)
            try container.encode(enabled, forKey: .enabled)
            try container.encode(files, forKey: .files)
            if !deferredSeedPaths.isEmpty {
                try container.encode(deferredSeedPaths, forKey: .deferredSeedPaths)
            }
        }
    }

    public typealias Clock = () -> Int64

    private let registry: AdapterRegistry
    private let paths: AgentPaths
    private let outbox: Outbox
    private let configuration: AgentConfiguration
    private let readLimitBytes: Int
    private let clockMS: Clock
    private let afterProviderRead: @Sendable () -> Void
    private let diagnosticHandler: (CollectorDiagnostic) -> Void
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
        afterProviderRead: @escaping @Sendable () -> Void = {},
        diagnosticHandler: @escaping (CollectorDiagnostic) -> Void = { _ in }
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
        self.diagnosticHandler = diagnosticHandler
        try Self.createPrivateDirectory(paths.supportDirectory)
        let stateDirectoryDescriptor = try OwnerOnlyDirectory.openOrCreate(paths.stateDirectory)
        do {
            let stateWasMissing: Bool
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
                stateWasMissing = false
            } else {
                state = PersistedState(version: 1, enabled: false, files: [:])
                stateWasMissing = true
            }
            self.stateDirectoryDescriptor = stateDirectoryDescriptor
            _ = try migrateLegacyAdapterSnapshots()
            acceptingCollection = state.enabled
                && !state.files.values.contains(where: \.seeding)
            if stateWasMissing { try persist() }
        } catch {
            Darwin.close(stateDirectoryDescriptor)
            throw error
        }
    }

    deinit { Darwin.close(stateDirectoryDescriptor) }

    public var enabled: Bool { lock.withLock { state.enabled } }
    public var isAcceptingCollection: Bool { acceptanceLock.withLock { acceptingCollection } }
    public var activationState: CollectorActivationState {
        guard enabled else { return .disabled }
        return isAcceptingCollection ? .ready : .preparing
    }
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
        switch try persistedCollectorState(paths: paths, surfaces: surfaces) {
        case .missing: return nil
        case .invalid: throw AgentControllerError.invalidState
        case .enabled: return true
        case .disabled: return false
        }
    }

    public static func persistDisabledForRecovery(
        paths: AgentPaths,
        surfaces: [RunSurface]
    ) throws {
        guard let descriptor = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) else {
            throw AgentControllerError.invalidState
        }
        defer { Darwin.close(descriptor) }
        guard let data = try readState(
            directoryDescriptor: descriptor,
            name: "collector-state.json",
            maximumBytes: 4 * 1_024 * 1_024
        ),
        let decoded = try? JSONDecoder().decode(PersistedState.self, from: data),
        valid(decoded, surfaces: surfaces) else {
            throw AgentControllerError.invalidState
        }
        let disabled = try replacingTopLevelEnabledWithFalse(in: data)
        guard let verified = try? JSONDecoder().decode(PersistedState.self, from: disabled),
              !verified.enabled,
              valid(verified, surfaces: surfaces) else {
            throw AgentControllerError.invalidState
        }
        guard decoded.enabled else {
            guard disabled == data else { throw AgentControllerError.invalidState }
            return
        }
        try writeStateAtomically(
            disabled,
            directoryDescriptor: descriptor,
            name: "collector-state.json"
        )
    }

    public static func persistedCollectorState(
        paths: AgentPaths,
        surfaces: [RunSurface]
    ) throws -> PersistedCollectorState {
        let descriptor: Int32
        do {
            guard let existing = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) else {
                return .missing
            }
            descriptor = existing
        } catch {
            return .invalid
        }
        defer { Darwin.close(descriptor) }
        let data: Data?
        do {
            data = try readState(
                directoryDescriptor: descriptor,
                name: "collector-state.json",
                maximumBytes: 4 * 1_024 * 1_024
            )
        } catch {
            return .invalid
        }
        guard let data else { return .missing }
        guard let decoded = try? JSONDecoder().decode(PersistedState.self, from: data),
              valid(decoded, surfaces: surfaces) else { return .invalid }
        return decoded.enabled ? .enabled : .disabled
    }

    public static func persistedAdapterFacts(
        paths: AgentPaths,
        surfaces: [RunSurface]
    ) throws -> PersistedAdapterFacts {
        guard let descriptor = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) else {
            return PersistedAdapterFacts(activeRunCount: 0, compatibilityReasons: [])
        }
        defer { Darwin.close(descriptor) }
        guard let data = try readState(
            directoryDescriptor: descriptor,
            name: "collector-state.json",
            maximumBytes: 4 * 1_024 * 1_024
        ),
        let decoded = try? JSONDecoder().decode(PersistedState.self, from: data),
        valid(decoded, surfaces: surfaces) else {
            throw AgentControllerError.invalidState
        }
        return snapshotFacts(in: decoded)
    }

    public func install(existingFiles: [URL]) throws {
        try lock.withLock {
            guard state.enabled else {
                lastCallbackBytesRead = 0
                return
            }
            let files = normalized(existingFiles)
            let existingPaths = Set(files.map(\.path))
            for path in Array(state.files.keys)
                where state.files[path]?.seeding == true && !existingPaths.contains(path) {
                state.deferredSeedPaths.insert(path)
                state.files.removeValue(forKey: path)
                pendingPaths.remove(path)
            }
            state.deferredSeedPaths.subtract(existingPaths)
            for file in files where state.files[file.path] == nil {
                state.files[file.path] = initialFileState(seeding: true)
            }
            pauseCollection()
            try captureSeedBoundaries(files)
            try persist()
            try process(files: files, bypassAcceptance: true, boundaryOnly: true)
            finishBoundarySetupIfReady()
        }
    }

    public func pauseCollection() {
        acceptanceLock.withLock { acceptingCollection = false }
    }

    public func resumeCollectionAfterUpdate() {
        lock.withLock { finishBoundarySetupIfReady() }
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
                fileState.cursor = JSONLCursor()
                fileState.nextOrdinal = 0
                fileState.seedTargetOffset = nil
                fileState.seedFileIdentity = nil
                fileState.seedTargetCheckpoint = nil
                state.files[path] = fileState
            }
            lastCallbackBytesRead = 0
            try persist()
        }
    }

    public func beginTurnOn() throws {
        pauseCollection()
        try lock.withLock {
            guard !state.enabled else { return }
            state.enabled = true
            runRegistry = RunRegistry()
            pendingPaths.removeAll()
            for path in state.files.keys {
                guard var file = state.files[path] else { continue }
                file.seeding = true
                file.adapterSnapshots = try snapshotsPreparedForSeeding(
                    from: file.adapterSnapshots
                )
                file.cursor = JSONLCursor()
                file.nextOrdinal = 0
                file.seedTargetOffset = nil
                file.seedFileIdentity = nil
                file.seedTargetCheckpoint = nil
                state.files[path] = file
            }
            lastCallbackBytesRead = 0
            try persist()
        }
    }

    public func turnOn(existingFiles: [URL]) throws {
        let wasEnabled = enabled
        try beginTurnOn()
        guard !wasEnabled else {
            lock.withLock {
                lastCallbackBytesRead = 0
                finishBoundarySetupIfReady()
            }
            return
        }
        try install(existingFiles: existingFiles)
    }

    public func processChangedFiles(_ files: [URL]) throws {
        try lock.withLock {
            guard state.enabled else {
                lastCallbackBytesRead = 0
                return
            }
            let files = normalized(files)
            for file in files where state.files[file.path] == nil {
                let deferred = state.deferredSeedPaths.remove(file.path) != nil
                state.files[file.path] = initialFileState(
                    seeding: deferred || !isAcceptingCollection
                )
            }
            if !isAcceptingCollection {
                pendingPaths.formUnion(files.map(\.path))
                try captureSeedBoundaries(files)
                try persist()
                lastCallbackBytesRead = 0
                return
            }
            try persist()
            try process(files: files)
        }
    }

    public func continueSeeding() throws {
        try continuePendingWork()
    }

    public func continuePendingWork() throws {
        try lock.withLock {
            guard state.enabled else {
                lastCallbackBytesRead = 0
                return
            }
            let paths = isAcceptingCollection
                ? pendingPaths
                : pendingPaths.filter { state.files[$0]?.seeding == true }
            let files = paths
                .map { URL(fileURLWithPath: $0) }
            if isAcceptingCollection {
                try process(files: normalized(files))
            } else {
                try process(
                    files: normalized(files),
                    bypassAcceptance: true,
                    boundaryOnly: true
                )
                finishBoundarySetupIfReady()
            }
        }
    }

    public func status(
        daemonRunning: Bool,
        serverEnabledSurfaces: [RunSurface],
        lastSuccessfulUploadMS: Int64?
    ) throws -> AgentStatus {
        try status(
            daemonRunning: daemonRunning,
            serverEnabledSurfaces: serverEnabledSurfaces,
            lastSuccessfulUploadMS: lastSuccessfulUploadMS,
            installedRelease: CompanionReleaseIdentity(
                releaseSequence: 1,
                releaseSHA: String(repeating: "0", count: 40),
                companionVersion: configuration.companionVersion,
                updateProtocolVersion: 1
            ),
            updateAvailability: nil
        )
    }

    public func status(
        daemonRunning: Bool,
        serverEnabledSurfaces: [RunSurface],
        lastSuccessfulUploadMS: Int64?,
        installedRelease: CompanionReleaseIdentity,
        updateAvailability: CompanionUpdateAvailability?,
        preparedReleaseStateGeneration: Int64? = nil
    ) throws -> AgentStatus {
        try lock.withLock {
            var health: [RunSurface: AdapterHealth] = [
                .claudeCode: .unavailable,
                .omp: .unavailable,
                .codexDesktop: .disabled,
                .codexCLI: .disabled,
            ]
            for surface in registry.surfaces { health[surface] = .available }
            let persistedActiveRunCount = Self.snapshotFacts(in: state).activeRunCount
            return AgentStatus(
                enabled: state.enabled,
                activationState: activationState,
                daemonRunning: daemonRunning,
                persistedState: state.enabled ? .enabled : .disabled,
                serverEnabledSurfaces: serverEnabledSurfaces.sorted { $0.rawValue < $1.rawValue },
                compiledAdapters: health,
                queuedEventCount: try outbox.queuedCount(),
                lastSuccessfulUploadMS: lastSuccessfulUploadMS,
                activeRunCount: max(runRegistry.activeRunCount, persistedActiveRunCount),
                installedCompanionVersion: installedRelease.companionVersion,
                installedReleaseSequence: installedRelease.releaseSequence,
                availableCompanionVersion: updateAvailability?.availableVersion,
                availableReleaseSequence: updateAvailability?.availableSequence,
                updateCommand: updateAvailability?.updateCommand,
                preparedReleaseStateGeneration: preparedReleaseStateGeneration
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
        lock.withLock {
            let facts = Self.snapshotFacts(in: state)
            return DoctorReport(
                codexRootReadable: codexRootReadable,
                serverHealthy: serverHealthy,
                signingValid: signingValid,
                enrollmentMatchesCompiledAdapters: Set(enrollmentAllowedSurfaces) == Set(registry.surfaces),
                claudeOTelEnvironmentPresent: claudeOTelEnvironmentPresent,
                compatibilityNeedsReview: !facts.compatibilityReasons.isEmpty,
                compatibilityReasons: facts.compatibilityReasons
            )
        }
    }

    private static func snapshotFacts(in state: PersistedState) -> PersistedAdapterFacts {
        var reasons: [CodexCompatibilityIssue] = []
        var activeRunCount = 0
        for file in state.files.values {
            for snapshot in file.adapterSnapshots.values {
                guard let adapter = try? CodexAdapter(snapshot: snapshot) else { continue }
                if let issue = adapter.compatibilityIssue, !reasons.contains(issue) {
                    reasons.append(issue)
                }
                if adapter.hasActiveRun { activeRunCount += 1 }
            }
        }
        return PersistedAdapterFacts(
            activeRunCount: activeRunCount,
            compatibilityReasons: reasons
        )
    }

    private func process(
        files: [URL],
        bypassAcceptance: Bool = false,
        boundaryOnly: Bool = false
    ) throws {
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
            if boundaryOnly, !fileState.seeding { continue }
            let approved: ApprovedProviderFile
            do {
                approved = try registry.approveProviderFile(file)
            } catch {
                pendingPaths.remove(file.path)
                if boundaryOnly { try discardBoundaryFile(file.path) }
                continue
            }
            let snapshot: (identity: JSONLFileIdentity, size: Int64)
            do {
                snapshot = try approved.snapshot()
            } catch {
                pendingPaths.remove(file.path)
                if boundaryOnly { try discardBoundaryFile(file.path) }
                continue
            }
            let trackedIdentity = fileState.cursor.fileIdentity
            if fileState.seeding {
                if fileState.seedTargetOffset == nil
                    || fileState.seedFileIdentity != snapshot.identity {
                    do {
                        try pinSeedBoundary(
                            &fileState,
                            approved: approved,
                            snapshot: snapshot
                        )
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                    state.files[file.path] = fileState
                    try persist()
                }
            } else if let trackedIdentity, trackedIdentity != snapshot.identity {
                do {
                    try pinSeedBoundary(
                        &fileState,
                        approved: approved,
                        snapshot: snapshot
                    )
                } catch {
                    continue
                }
                state.files[file.path] = fileState
                try persist()
            }

            if fileState.seeding {
                guard let seedTarget = fileState.seedTargetOffset,
                      let seedIdentity = fileState.seedFileIdentity else {
                    continue
                }
                if seedTarget == 0 {
                    do {
                        guard try validateCapturedBoundaryOrRepin(
                            &fileState,
                            approved: approved
                        ) else {
                            state.files[file.path] = fileState
                            try persist()
                            continue
                        }
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                    finishSeeding(&fileState)
                    state.files[file.path] = fileState
                    try persist()
                    continue
                }

                let provenanceTarget = min(
                    seedTarget,
                    Int64(Self.maximumProvenanceBytes)
                )
                if fileState.cursor.offset >= provenanceTarget {
                    do {
                        guard try validateCapturedBoundaryOrRepin(
                            &fileState,
                            approved: approved
                        ) else {
                            state.files[file.path] = fileState
                            try persist()
                            continue
                        }
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                    finishSeeding(&fileState)
                    state.files[file.path] = fileState
                    try persist()
                    continue
                }
                let requestedBytes = min(
                    remaining,
                    Int(provenanceTarget - fileState.cursor.offset)
                )
                let provenance: JSONLReadResult
                do {
                    provenance = try approved.readAppended(
                        cursor: fileState.cursor,
                        maxBytes: requestedBytes
                    )
                } catch {
                    pendingPaths.remove(file.path)
                    if boundaryOnly { try discardBoundaryFile(file.path) }
                    continue
                }
                afterProviderRead()
                guard bypassAcceptance || isAcceptingCollection else { return }
                remaining -= provenance.bytesRead
                lastCallbackBytesRead += provenance.bytesRead
                let readerReset = provenance.cursor.offset
                    != fileState.cursor.offset + Int64(provenance.bytesRead)
                let prefixStable: Bool
                do {
                    prefixStable = try !readerReset
                        && provenance.cursor.fileIdentity == seedIdentity
                        && approved.isCurrent(provenance.cursor)
                } catch {
                    if boundaryOnly { try discardBoundaryFile(file.path) }
                    continue
                }
                if !prefixStable {
                    let latest: (identity: JSONLFileIdentity, size: Int64)
                    do {
                        latest = try approved.snapshot()
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                    do {
                        try pinSeedBoundary(
                            &fileState,
                            approved: approved,
                            snapshot: latest
                        )
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                    state.files[file.path] = fileState
                    try persist()
                    continue
                }

                var adapters = try restoredAdapters(from: fileState.adapterSnapshots)
                for (line, endOffset) in zip(
                    provenance.lines,
                    provenance.lineEndOffsets
                ) {
                    let source = ProviderRecordSource(ordinal: endOffset)
                    fileState.nextOrdinal = endOffset
                    for index in adapters.indices {
                        adapters[index].consumeDuringSeeding(
                            line: line,
                            source: source,
                            observedAt: clockMS()
                        )
                    }
                }
                fileState.cursor = provenance.cursor
                fileState.adapterSnapshots = try snapshots(of: adapters)
                if provenance.cursor.offset >= provenanceTarget {
                    do {
                        guard try validateCapturedBoundaryOrRepin(
                            &fileState,
                            approved: approved
                        ) else {
                            state.files[file.path] = fileState
                            try persist()
                            continue
                        }
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                    finishSeeding(&fileState)
                } else if provenance.bytesRead < requestedBytes {
                    let latest: (identity: JSONLFileIdentity, size: Int64)
                    do {
                        latest = try approved.snapshot()
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                    do {
                        try pinSeedBoundary(
                            &fileState,
                            approved: approved,
                            snapshot: latest
                        )
                    } catch {
                        if boundaryOnly { try discardBoundaryFile(file.path) }
                        continue
                    }
                }
                state.files[file.path] = fileState
                try persist()
                continue
            }

            let priorCursor = fileState.cursor
            let priorIdentity = priorCursor.fileIdentity
            let priorOffset = priorCursor.offset
            let requestedBytes = remaining
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
            if result.bytesRead < requestedBytes {
                pendingPaths.remove(file.path)
            }

            var adapters = try restoredAdapters(from: fileState.adapterSnapshots)
            let readerReset = result.cursor.offset != priorOffset + Int64(result.bytesRead)
            if readerReset || (priorIdentity != nil && priorIdentity != result.cursor.fileIdentity) {
                adapters = freshAdapters()
                fileState.nextOrdinal = 0
            }
            for (line, endOffset) in zip(result.lines, result.lineEndOffsets) {
                guard bypassAcceptance || isAcceptingCollection else { return }
                let source = ProviderRecordSource(ordinal: endOffset)
                fileState.nextOrdinal = endOffset
                for index in adapters.indices {
                    let observations = adapters[index].consume(
                        line: line,
                        source: source,
                        observedAt: clockMS()
                    )
                    for observation in observations {
                        guard bypassAcceptance || isAcceptingCollection else { return }
                        do {
                            let event = try registry.event(
                                from: observation,
                                dedupeSecret: configuration.dedupeSecret,
                                companionVersion: configuration.companionVersion,
                                deviceID: configuration.deviceID
                            )
                            _ = try PrivacyEncoder().encode(event)
                            try outbox.enqueue(event)
                            runRegistry.observe(event)
                        } catch {
                            guard Self.isDeterministicRecordRejection(error) else {
                                throw error
                            }
                            diagnosticHandler(.deterministicRecordRejected)
                        }
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

    private func discardBoundaryFile(_ path: String) throws {
        state.files.removeValue(forKey: path)
        pendingPaths.remove(path)
        try persist()
    }

    private func pinSeedBoundary(
        _ fileState: inout PersistedFileState,
        approved: ApprovedProviderFile,
        snapshot: (identity: JSONLFileIdentity, size: Int64)
    ) throws {
        let targetCursor = try approved.cursor(
            atOffset: snapshot.size,
            expectedIdentity: snapshot.identity
        )
        fileState = initialFileState(seeding: true)
        fileState.seedTargetOffset = snapshot.size
        fileState.seedFileIdentity = snapshot.identity
        fileState.seedTargetCheckpoint = targetCursor.continuityCheckpoint
    }

    private func capturedSeedCursor(_ fileState: PersistedFileState) -> JSONLCursor? {
        guard let offset = fileState.seedTargetOffset,
              let identity = fileState.seedFileIdentity else { return nil }
        return JSONLCursor(
            offset: offset,
            fileIdentity: identity,
            continuityCheckpoint: fileState.seedTargetCheckpoint
        )
    }

    private func validateCapturedBoundaryOrRepin(
        _ fileState: inout PersistedFileState,
        approved: ApprovedProviderFile
    ) throws -> Bool {
        guard let capturedCursor = capturedSeedCursor(fileState) else { return false }
        if try approved.isCurrent(capturedCursor) {
            fileState.cursor = capturedCursor
            return true
        }
        let latest = try approved.snapshot()
        try pinSeedBoundary(
            &fileState,
            approved: approved,
            snapshot: latest
        )
        return false
    }

    private func captureSeedBoundaries(_ files: [URL]) throws {
        for file in files {
            guard var fileState = state.files[file.path], fileState.seeding else { continue }
            let approved: ApprovedProviderFile
            let snapshot: (identity: JSONLFileIdentity, size: Int64)
            do {
                approved = try registry.approveProviderFile(file)
                snapshot = try approved.snapshot()
            } catch {
                state.files.removeValue(forKey: file.path)
                pendingPaths.remove(file.path)
                continue
            }
            if fileState.seedTargetOffset == nil
                || fileState.seedFileIdentity != snapshot.identity {
                do {
                    try pinSeedBoundary(
                        &fileState,
                        approved: approved,
                        snapshot: snapshot
                    )
                } catch {
                    state.files.removeValue(forKey: file.path)
                    pendingPaths.remove(file.path)
                    continue
                }
                state.files[file.path] = fileState
            }
        }
    }

    private func finishBoundarySetupIfReady() {
        guard state.enabled,
              !state.files.values.contains(where: \.seeding) else { return }
        acceptanceLock.withLock { acceptingCollection = true }
    }

    private func initialFileState(seeding: Bool) -> PersistedFileState {
        PersistedFileState(
            cursor: JSONLCursor(),
            nextOrdinal: 0,
            adapterSnapshots: initialSnapshots(),
            seeding: seeding,
            seedTargetOffset: nil,
            seedFileIdentity: nil,
            seedTargetCheckpoint: nil
        )
    }

    private func finishSeeding(_ fileState: inout PersistedFileState) {
        fileState.cursor.partialLine = Data()
        fileState.seeding = false
        fileState.seedTargetOffset = nil
        fileState.seedFileIdentity = nil
        fileState.seedTargetCheckpoint = nil
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

    private func migrateLegacyAdapterSnapshots() throws -> Bool {
        var migrated = false
        for path in state.files.keys {
            guard var fileState = state.files[path] else { continue }
            let adapters = try restoredAdapters(from: fileState.adapterSnapshots)
            guard adapters.contains(where: \.requiresReseeding) else { continue }
            fileState.seeding = true
            fileState.adapterSnapshots = try snapshotsPreparedForSeeding(
                from: fileState.adapterSnapshots
            )
            fileState.cursor = JSONLCursor()
            fileState.nextOrdinal = 0
            fileState.seedTargetOffset = nil
            fileState.seedFileIdentity = nil
            fileState.seedTargetCheckpoint = nil
            state.files[path] = fileState
            migrated = true
        }
        return migrated
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

    private static func isDeterministicRecordRejection(_ error: Error) -> Bool {
        if error is PrivacyEncoderError { return true }
        if error as? AdapterRegistryError == .invalidObservation { return true }
        switch error as? RunIdentityError {
        case .invalidNativeID, .invalidRunKey, .invalidSequence:
            return true
        case .invalidDedupeSecret, .none:
            return false
        }
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
        guard state.version == 1,
              state.files.count + state.deferredSeedPaths.count <= 16_384,
              state.deferredSeedPaths.isDisjoint(with: state.files.keys),
              state.deferredSeedPaths.allSatisfy({ $0.utf8.count <= 16_384 }) else {
            return false
        }
        let expected = Set(surfaces.map(\.rawValue))
        return state.files.allSatisfy { path, file in
            path.utf8.count <= 16_384
                && file.nextOrdinal >= 0
                && validSeedBoundary(file)
                && Set(file.adapterSnapshots.keys) == expected
                && file.adapterSnapshots.allSatisfy { surface, snapshot in
                    guard snapshot.count <= 65_536,
                          let adapter = try? CodexAdapter(snapshot: snapshot) else {
                        return false
                    }
                    return adapter.expectedSurface.rawValue == surface
                }
        }
    }

    private static func validSeedBoundary(_ file: PersistedFileState) -> Bool {
        guard let offset = file.seedTargetOffset else {
            return file.seedFileIdentity == nil && file.seedTargetCheckpoint == nil
        }
        guard file.seeding, offset >= 0, file.seedFileIdentity != nil else { return false }
        if offset == 0 { return file.seedTargetCheckpoint == nil }
        guard let checkpoint = file.seedTargetCheckpoint else { return false }
        return checkpoint.byteCount == Int(
            min(offset, Int64(JSONLReader.continuityWindowBytes))
        ) && checkpoint.digest.count == 32
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

    private static func replacingTopLevelEnabledWithFalse(in data: Data) throws -> Data {
        let bytes = [UInt8](data)
        var index = 0
        var match: Range<Int>?
        var enabledValue: Bool?

        func skipWhitespace(_ cursor: inout Int) {
            while cursor < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[cursor]) {
                cursor += 1
            }
        }

        func parseString(_ cursor: inout Int) throws -> Range<Int> {
            guard cursor < bytes.count, bytes[cursor] == 0x22 else {
                throw AgentControllerError.invalidState
            }
            let start = cursor
            cursor += 1
            var escaped = false
            while cursor < bytes.count {
                let byte = bytes[cursor]
                cursor += 1
                if escaped {
                    escaped = false
                } else if byte == 0x5c {
                    escaped = true
                } else if byte == 0x22 {
                    return start..<cursor
                }
            }
            throw AgentControllerError.invalidState
        }

        func skipValue(_ cursor: inout Int) throws {
            skipWhitespace(&cursor)
            guard cursor < bytes.count else { throw AgentControllerError.invalidState }
            if bytes[cursor] == 0x22 {
                _ = try parseString(&cursor)
                return
            }
            if bytes[cursor] == 0x7b {
                cursor += 1
                skipWhitespace(&cursor)
                if cursor < bytes.count, bytes[cursor] == 0x7d {
                    cursor += 1
                    return
                }
                while true {
                    _ = try parseString(&cursor)
                    skipWhitespace(&cursor)
                    guard cursor < bytes.count, bytes[cursor] == 0x3a else {
                        throw AgentControllerError.invalidState
                    }
                    cursor += 1
                    try skipValue(&cursor)
                    skipWhitespace(&cursor)
                    guard cursor < bytes.count else { throw AgentControllerError.invalidState }
                    if bytes[cursor] == 0x7d {
                        cursor += 1
                        return
                    }
                    guard bytes[cursor] == 0x2c else { throw AgentControllerError.invalidState }
                    cursor += 1
                    skipWhitespace(&cursor)
                }
            }
            if bytes[cursor] == 0x5b {
                cursor += 1
                skipWhitespace(&cursor)
                if cursor < bytes.count, bytes[cursor] == 0x5d {
                    cursor += 1
                    return
                }
                while true {
                    try skipValue(&cursor)
                    skipWhitespace(&cursor)
                    guard cursor < bytes.count else { throw AgentControllerError.invalidState }
                    if bytes[cursor] == 0x5d {
                        cursor += 1
                        return
                    }
                    guard bytes[cursor] == 0x2c else { throw AgentControllerError.invalidState }
                    cursor += 1
                }
            }
            let start = cursor
            while cursor < bytes.count,
                  ![0x20, 0x09, 0x0a, 0x0d, 0x2c, 0x5d, 0x7d].contains(bytes[cursor]) {
                cursor += 1
            }
            guard cursor > start else { throw AgentControllerError.invalidState }
        }

        skipWhitespace(&index)
        guard index < bytes.count, bytes[index] == 0x7b else {
            throw AgentControllerError.invalidState
        }
        index += 1
        while true {
            skipWhitespace(&index)
            guard index < bytes.count else { throw AgentControllerError.invalidState }
            if bytes[index] == 0x7d {
                index += 1
                break
            }
            let encodedKeyRange = try parseString(&index)
            skipWhitespace(&index)
            guard index < bytes.count, bytes[index] == 0x3a else {
                throw AgentControllerError.invalidState
            }
            let encodedKey = Data(bytes[encodedKeyRange])
            guard let key = try? JSONDecoder().decode(String.self, from: encodedKey) else {
                throw AgentControllerError.invalidState
            }
            index += 1
            skipWhitespace(&index)
            if key == "enabled" {
                guard encodedKey == Data(#""enabled""#.utf8) else {
                    throw AgentControllerError.invalidState
                }
                guard enabledValue == nil else { throw AgentControllerError.invalidState }
                let trueBytes = Array("true".utf8)
                let falseBytes = Array("false".utf8)
                if index < bytes.count, bytes[index...].starts(with: trueBytes) {
                    enabledValue = true
                    match = index..<(index + trueBytes.count)
                } else if index < bytes.count, bytes[index...].starts(with: falseBytes) {
                    enabledValue = false
                } else {
                    throw AgentControllerError.invalidState
                }
            }
            try skipValue(&index)
            skipWhitespace(&index)
            guard index < bytes.count else { throw AgentControllerError.invalidState }
            if bytes[index] == 0x7d {
                index += 1
                break
            }
            guard bytes[index] == 0x2c else { throw AgentControllerError.invalidState }
            index += 1
        }

        skipWhitespace(&index)
        guard index == bytes.count, let enabledValue else {
            throw AgentControllerError.invalidState
        }
        guard enabledValue, let match else { return data }
        var output = data
        output.replaceSubrange(match, with: Data("false".utf8))
        return output
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

import Darwin
import Foundation

@_silgen_name("flock")
private func releaseStateFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

public struct ReleaseReference: Codable, Equatable, Sendable {
    public let releaseSequence: Int64
    public let releaseSHA: String
    public let companionVersion: String
    public let updateProtocolVersion: Int

    public init(
        releaseSequence: Int64,
        releaseSHA: String,
        companionVersion: String,
        updateProtocolVersion: Int
    ) {
        self.releaseSequence = releaseSequence
        self.releaseSHA = releaseSHA
        self.companionVersion = companionVersion
        self.updateProtocolVersion = updateProtocolVersion
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case releaseSequence = "release_sequence"
        case releaseSHA = "release_sha"
        case companionVersion = "companion_version"
        case updateProtocolVersion = "update_protocol_version"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard Set(container.allKeys) == Set(CodingKeys.allCases) else {
            throw ReleaseContractError.invalidReleaseState
        }
        self.init(
            releaseSequence: try container.decode(Int64.self, forKey: .releaseSequence),
            releaseSHA: try container.decode(String.self, forKey: .releaseSHA),
            companionVersion: try container.decode(String.self, forKey: .companionVersion),
            updateProtocolVersion: try container.decode(Int.self, forKey: .updateProtocolVersion)
        )
        guard Self.isValid(self) else { throw ReleaseContractError.invalidReleaseState }
    }

    static func isValid(_ reference: ReleaseReference) -> Bool {
        (1...ReleaseContractValidation.maximumSafeInteger).contains(reference.releaseSequence) &&
            ReleaseContractValidation.isLowercaseHex(reference.releaseSHA, count: 40) &&
            ReleaseContractValidation.isVersion(reference.companionVersion) &&
            reference.updateProtocolVersion == 2
    }

    static func sameIdentity(_ lhs: ReleaseReference, _ rhs: ReleaseReference) -> Bool {
        lhs.releaseSequence == rhs.releaseSequence && lhs.releaseSHA == rhs.releaseSHA
    }
}

public struct ReleaseStateV1: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let generation: Int64
    public let active: ReleaseReference
    public let fallback: ReleaseReference?
    public let trial: ReleaseReference?

    public init(
        schemaVersion: Int,
        generation: Int64,
        active: ReleaseReference,
        fallback: ReleaseReference?,
        trial: ReleaseReference?
    ) {
        self.schemaVersion = schemaVersion
        self.generation = generation
        self.active = active
        self.fallback = fallback
        self.trial = trial
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion = "schema_version"
        case generation, active, fallback, trial
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard Set(container.allKeys) == Set(CodingKeys.allCases) else {
            throw ReleaseContractError.invalidReleaseState
        }
        self.init(
            schemaVersion: try container.decode(Int.self, forKey: .schemaVersion),
            generation: try container.decode(Int64.self, forKey: .generation),
            active: try container.decode(ReleaseReference.self, forKey: .active),
            fallback: try container.decodeIfPresent(ReleaseReference.self, forKey: .fallback),
            trial: try container.decodeIfPresent(ReleaseReference.self, forKey: .trial)
        )
        guard Self.isValid(self) else { throw ReleaseContractError.invalidReleaseState }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(generation, forKey: .generation)
        try container.encode(active, forKey: .active)
        try container.encode(fallback, forKey: .fallback)
        try container.encode(trial, forKey: .trial)
    }

    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= ReleaseFilesystem.maximumRecordBytes,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(CodingKeys.allCases.map(\.rawValue)),
              isExactJSONObject(object) else {
            throw ReleaseContractError.invalidReleaseState
        }
        let state = try JSONDecoder().decode(Self.self, from: data)
        guard isValid(state) else { throw ReleaseContractError.invalidReleaseState }
        return state
    }

    private static func isExactJSONObject(_ object: [String: Any]) -> Bool {
        guard let active = object["active"] as? [String: Any],
              isExactReferenceJSONObject(active),
              isExactOptionalReferenceJSONObject(object["fallback"]),
              isExactOptionalReferenceJSONObject(object["trial"]) else {
            return false
        }
        return true
    }

    private static func isExactOptionalReferenceJSONObject(_ value: Any?) -> Bool {
        value is NSNull || (value as? [String: Any]).map(isExactReferenceJSONObject) == true
    }

    private static func isExactReferenceJSONObject(_ object: [String: Any]) -> Bool {
        Set(object.keys) == Set(ReleaseReference.CodingKeys.allCases.map(\.rawValue))
    }

    static func isValid(_ state: ReleaseStateV1) -> Bool {
        guard state.schemaVersion == 1,
              (1...ReleaseContractValidation.maximumSafeInteger).contains(state.generation),
              ReleaseReference.isValid(state.active) else {
            return false
        }
        if let fallback = state.fallback {
            guard ReleaseReference.isValid(fallback),
                  fallback.releaseSequence < state.active.releaseSequence,
                  !ReleaseReference.sameIdentity(fallback, state.active) else {
                return false
            }
        }
        if let trial = state.trial {
            guard ReleaseReference.isValid(trial),
                  trial.releaseSequence > state.active.releaseSequence,
                  !ReleaseReference.sameIdentity(trial, state.active),
                  state.fallback.map({ !ReleaseReference.sameIdentity(trial, $0) }) ?? true else {
                return false
            }
        }
        return true
    }
}

public final class ReleaseStateStore: @unchecked Sendable {
    private let fileName: String
    private let directoryDescriptor: Int32
    private let lockDescriptor: Int32
    private let beforeRename: () throws -> Void
    private let lock = NSLock()

    public convenience init(paths: AgentPaths) throws {
        try self.init(paths: paths, beforeRename: {})
    }

    init(paths: AgentPaths, beforeRename: @escaping () throws -> Void) throws {
        fileName = paths.releaseState.lastPathComponent
        directoryDescriptor = try ReleaseFilesystem.openOrCreateOwnerOnlyDirectory(
            paths.installationDirectory
        )
        lockDescriptor = Darwin.openat(
            directoryDescriptor,
            ".release-state.lock",
            O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            mode_t(0o600)
        )
        guard lockDescriptor >= 0 else {
            Darwin.close(directoryDescriptor)
            throw ReleaseContractError.invalidReleaseState
        }
        var metadata = stat()
        guard Darwin.fstat(lockDescriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            Darwin.close(lockDescriptor)
            Darwin.close(directoryDescriptor)
            throw ReleaseContractError.invalidReleaseState
        }
        self.beforeRename = beforeRename
    }

    deinit {
        Darwin.close(lockDescriptor)
        Darwin.close(directoryDescriptor)
    }

    public func load() throws -> ReleaseStateV1 {
        try withStateLock {
            guard let data = try ReleaseFilesystem.readRegularRecord(
                directoryDescriptor: directoryDescriptor,
                name: fileName
            ) else {
                throw ReleaseContractError.invalidReleaseState
            }
            return try ReleaseStateV1.decode(data)
        }
    }

    public func createInitial(_ state: ReleaseStateV1) throws {
        try withStateLock {
            guard state.generation == 1,
                  state.fallback == nil,
                  state.trial == nil,
                  ReleaseStateV1.isValid(state),
                  try ReleaseFilesystem.readRegularRecord(
                    directoryDescriptor: directoryDescriptor,
                    name: fileName
                  ) == nil else {
                throw ReleaseContractError.invalidReleaseState
            }
            try create(state)
        }
    }

    public func replace(expectedGeneration: Int64, with state: ReleaseStateV1) throws {
        try withStateLock {
            let current = try loadUnlocked()
            guard current.generation == expectedGeneration,
                  expectedGeneration < ReleaseContractValidation.maximumSafeInteger,
                  state.generation == expectedGeneration + 1,
                  ReleaseStateV1.isValid(state) else {
                throw ReleaseContractError.invalidReleaseState
            }
            try write(state)
        }
    }

    private func loadUnlocked() throws -> ReleaseStateV1 {
        guard let data = try ReleaseFilesystem.readRegularRecord(
            directoryDescriptor: directoryDescriptor,
            name: fileName
        ) else {
            throw ReleaseContractError.invalidReleaseState
        }
        return try ReleaseStateV1.decode(data)
    }

    private func withStateLock<Result>(_ body: () throws -> Result) throws -> Result {
        try lock.withLock {
            while releaseStateFlock(lockDescriptor, LOCK_EX) != 0 {
                guard errno == EINTR else { throw ReleaseContractError.invalidReleaseState }
            }
            defer { _ = releaseStateFlock(lockDescriptor, LOCK_UN) }
            return try body()
        }
    }

    private func write(_ state: ReleaseStateV1) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(state)
        guard data.count <= ReleaseFilesystem.maximumRecordBytes else {
            throw ReleaseContractError.invalidReleaseState
        }
        try ReleaseFilesystem.writeAtomically(
            data,
            directoryDescriptor: directoryDescriptor,
            name: fileName,
            beforeRename: beforeRename
        )
    }

    private func create(_ state: ReleaseStateV1) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(state)
        guard data.count <= ReleaseFilesystem.maximumRecordBytes else {
            throw ReleaseContractError.invalidReleaseState
        }
        try ReleaseFilesystem.createExclusively(
            data,
            directoryDescriptor: directoryDescriptor,
            name: fileName,
            beforeCommit: beforeRename
        )
    }
}

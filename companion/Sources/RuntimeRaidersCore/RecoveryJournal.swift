import Darwin
import Foundation

@_silgen_name("flock")
private func runtimeRaidersFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

func isExactBase64URLCredential(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 43 else { return false }
    return bytes.allSatisfy { byte in
        (0x41...0x5a).contains(byte)
            || (0x61...0x7a).contains(byte)
            || (0x30...0x39).contains(byte)
            || byte == 0x5f
            || byte == 0x2d
    }
}

public enum LifecycleStorageError: Error, Equatable {
    case invalidPath
    case invalidState
    case busy
}

public enum ReEnrollmentPhase: String, Codable, Sendable {
    case replacementPrepared
    case serverCommitted
    case configurationInstalled
    case collectorReset
    case agentRegistered
}

public enum RecordedQueueDisposition: String, Codable, Sendable {
    case delivered
    case discarded
    case empty
}

public struct RecoveryJournal: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible {
    public let version: Int
    public let operationID: UUID
    public let replacementDeviceID: UUID
    public let replacementDeviceToken: String
    public let companionVersion: String
    public let queueDisposition: RecordedQueueDisposition
    public var phase: ReEnrollmentPhase

    public init(
        version: Int,
        operationID: UUID,
        replacementDeviceID: UUID,
        replacementDeviceToken: String,
        companionVersion: String,
        queueDisposition: RecordedQueueDisposition,
        phase: ReEnrollmentPhase
    ) {
        self.version = version
        self.operationID = operationID
        self.replacementDeviceID = replacementDeviceID
        self.replacementDeviceToken = replacementDeviceToken
        self.companionVersion = companionVersion
        self.queueDisposition = queueDisposition
        self.phase = phase
    }

    public var description: String {
        "RecoveryJournal(version: \(version), queueDisposition: "
            + "\(queueDisposition.rawValue), phase: \(phase.rawValue), secret: <redacted>)"
    }

    public var debugDescription: String { description }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case version
        case operationID = "operation_id"
        case replacementDeviceID = "replacement_device_id"
        case replacementDeviceToken = "replacement_device_token"
        case companionVersion = "companion_version"
        case queueDisposition = "queue_disposition"
        case phase
    }
}

final class VerifiedStateDirectory: @unchecked Sendable {
    typealias MetadataTransform = (stat) -> stat

    let url: URL
    let descriptor: Int32
    private let device: dev_t
    private let inode: ino_t
    private let atomicStore: AtomicStore
    private let metadataTransform: MetadataTransform

    init(
        url: URL,
        atomicStore: AtomicStore = AtomicStore(),
        metadataTransform: @escaping MetadataTransform = { $0 }
    ) throws {
        guard url.isFileURL,
              url.path.hasPrefix("/"),
              url.standardized.path == url.path,
              let descriptor = try OwnerOnlyDirectory.openExisting(url) else {
            throw LifecycleStorageError.invalidPath
        }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0 else {
            Darwin.close(descriptor)
            throw LifecycleStorageError.invalidState
        }
        self.url = URL(fileURLWithPath: url.path, isDirectory: true)
        self.descriptor = descriptor
        self.atomicStore = atomicStore
        self.metadataTransform = metadataTransform
        device = metadata.st_dev
        inode = metadata.st_ino
    }

    deinit {
        Darwin.close(descriptor)
    }

    func verifyPathIdentity() throws {
        let current: Int32
        do {
            guard let opened = try OwnerOnlyDirectory.openExisting(url) else {
                throw LifecycleStorageError.invalidState
            }
            current = opened
        } catch {
            throw LifecycleStorageError.invalidState
        }
        defer { Darwin.close(current) }
        var metadata = stat()
        guard Darwin.fstat(current, &metadata) == 0,
              metadata.st_dev == device,
              metadata.st_ino == inode else {
            throw LifecycleStorageError.invalidState
        }
    }

    func readPrivateFile(name: String, maximumBytes: Int) throws -> Data? {
        try verifyPathIdentity()
        let file = Darwin.openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard file >= 0 else {
            if errno == ENOENT { return nil }
            throw LifecycleStorageError.invalidState
        }
        defer { Darwin.close(file) }
        var metadata = stat()
        guard Darwin.fstat(file, &metadata) == 0 else {
            throw LifecycleStorageError.invalidState
        }
        metadata = metadataTransform(metadata)
        guard
              Self.validPrivateFile(metadata, maximumBytes: maximumBytes) else {
            throw LifecycleStorageError.invalidState
        }
        var data = Data(count: Int(metadata.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(file, base.advanced(by: offset), bytes.count - offset)
                if count > 0 {
                    offset += count
                } else if count < 0, errno == EINTR {
                    continue
                } else {
                    throw LifecycleStorageError.invalidState
                }
            }
        }
        var trailing: UInt8 = 0
        while true {
            let count = Darwin.read(file, &trailing, 1)
            if count == 0 { break }
            if count < 0, errno == EINTR { continue }
            throw LifecycleStorageError.invalidState
        }
        return data
    }

    func writePrivateFile(
        _ data: Data,
        name: String,
        maximumExistingBytes: Int
    ) throws {
        try verifyPathIdentity()
        try validateExistingFileIfPresent(name: name, maximumBytes: maximumExistingBytes)
        do {
            try atomicStore.write(data, directoryDescriptor: descriptor, name: name)
        } catch {
            throw LifecycleStorageError.invalidState
        }
        guard let written = try readPrivateFile(name: name, maximumBytes: max(data.count, 1)),
              written == data else {
            throw LifecycleStorageError.invalidState
        }
    }

    func removePrivateFile(name: String, maximumBytes: Int) throws {
        try verifyPathIdentity()
        let existing = try readPrivateFile(name: name, maximumBytes: maximumBytes)
        guard existing != nil else { return }
        guard Darwin.unlinkat(descriptor, name, 0) == 0 else {
            throw LifecycleStorageError.invalidState
        }
        try synchronize()
    }

    private func validateExistingFileIfPresent(name: String, maximumBytes: Int) throws {
        var metadata = stat()
        guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else {
            if errno == ENOENT { return }
            throw LifecycleStorageError.invalidState
        }
        metadata = metadataTransform(metadata)
        guard Self.validPrivateFile(metadata, maximumBytes: maximumBytes) else {
            throw LifecycleStorageError.invalidState
        }
    }

    private func synchronize() throws {
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw LifecycleStorageError.invalidState
        }
    }

    static func validPrivateFile(
        _ metadata: stat,
        maximumBytes: Int,
        allowsEmpty: Bool = false
    ) -> Bool {
        metadata.st_mode & S_IFMT == S_IFREG
            && metadata.st_uid == Darwin.geteuid()
            && metadata.st_mode & 0o7777 == 0o600
            && metadata.st_nlink == 1
            && (allowsEmpty ? metadata.st_size >= 0 : metadata.st_size > 0)
            && metadata.st_size <= maximumBytes
    }
}

public struct RecoveryJournalStore: @unchecked Sendable {
    private static let maximumBytes = 16 * 1_024
    private let stateDirectory: VerifiedStateDirectory
    private let name: String

    public init(paths: CompanionLifecyclePaths) throws {
        stateDirectory = try VerifiedStateDirectory(url: paths.agent.stateDirectory)
        name = paths.recoveryJournal.lastPathComponent
    }

    init(paths: CompanionLifecyclePaths, atomicStore: AtomicStore) throws {
        stateDirectory = try VerifiedStateDirectory(
            url: paths.agent.stateDirectory,
            atomicStore: atomicStore
        )
        name = paths.recoveryJournal.lastPathComponent
    }

    init(
        paths: CompanionLifecyclePaths,
        metadataTransform: @escaping VerifiedStateDirectory.MetadataTransform
    ) throws {
        stateDirectory = try VerifiedStateDirectory(
            url: paths.agent.stateDirectory,
            metadataTransform: metadataTransform
        )
        name = paths.recoveryJournal.lastPathComponent
    }

    public func load() throws -> RecoveryJournal? {
        guard let data = try stateDirectory.readPrivateFile(
            name: name,
            maximumBytes: Self.maximumBytes
        ) else { return nil }
        var keyScanner = StrictTopLevelJSONKeys(data: data)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let scannedKeys = try? keyScanner.parse(),
              scannedKeys == Set(RecoveryJournal.CodingKeys.allCases.map(\.rawValue)),
              Set(object.keys) == scannedKeys,
              let journal = try? JSONDecoder().decode(RecoveryJournal.self, from: data),
              Self.valid(journal) else {
            throw LifecycleStorageError.invalidState
        }
        return journal
    }

    public func write(_ journal: RecoveryJournal) throws {
        guard Self.valid(journal) else { throw LifecycleStorageError.invalidState }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(journal),
              !data.isEmpty,
              data.count <= Self.maximumBytes else {
            throw LifecycleStorageError.invalidState
        }
        try stateDirectory.writePrivateFile(
            data,
            name: name,
            maximumExistingBytes: Self.maximumBytes
        )
    }

    public func remove() throws {
        guard try load() != nil else { return }
        try stateDirectory.removePrivateFile(name: name, maximumBytes: Self.maximumBytes)
    }

    private static func valid(_ journal: RecoveryJournal) -> Bool {
        journal.version == 1
            && (1...100).contains(journal.companionVersion.utf8.count)
            && isExactBase64URLCredential(journal.replacementDeviceToken)
    }
}

private struct StrictTopLevelJSONKeys {
    private let bytes: [UInt8]
    private var index = 0

    init(data: Data) {
        bytes = Array(data)
    }

    mutating func parse() throws -> Set<String> {
        skipWhitespace()
        guard consume(0x7b) else { throw LifecycleStorageError.invalidState }
        skipWhitespace()
        var keys = Set<String>()
        if consume(0x7d) {
            skipWhitespace()
            guard index == bytes.count else { throw LifecycleStorageError.invalidState }
            return keys
        }
        while true {
            let key = try parseString()
            guard keys.insert(key).inserted else { throw LifecycleStorageError.invalidState }
            skipWhitespace()
            guard consume(0x3a) else { throw LifecycleStorageError.invalidState }
            skipWhitespace()
            try skipValue(depth: 0)
            skipWhitespace()
            if consume(0x7d) { break }
            guard consume(0x2c) else { throw LifecycleStorageError.invalidState }
            skipWhitespace()
        }
        skipWhitespace()
        guard index == bytes.count else { throw LifecycleStorageError.invalidState }
        return keys
    }

    private mutating func skipValue(depth: Int) throws {
        guard depth <= 32, index < bytes.count else {
            throw LifecycleStorageError.invalidState
        }
        switch bytes[index] {
        case 0x22:
            _ = try parseString()
        case 0x7b:
            index += 1
            skipWhitespace()
            if consume(0x7d) { return }
            while true {
                _ = try parseString()
                skipWhitespace()
                guard consume(0x3a) else { throw LifecycleStorageError.invalidState }
                skipWhitespace()
                try skipValue(depth: depth + 1)
                skipWhitespace()
                if consume(0x7d) { return }
                guard consume(0x2c) else { throw LifecycleStorageError.invalidState }
                skipWhitespace()
            }
        case 0x5b:
            index += 1
            skipWhitespace()
            if consume(0x5d) { return }
            while true {
                try skipValue(depth: depth + 1)
                skipWhitespace()
                if consume(0x5d) { return }
                guard consume(0x2c) else { throw LifecycleStorageError.invalidState }
                skipWhitespace()
            }
        case 0x74:
            try consumeLiteral(Array("true".utf8))
        case 0x66:
            try consumeLiteral(Array("false".utf8))
        case 0x6e:
            try consumeLiteral(Array("null".utf8))
        case 0x2d, 0x30...0x39:
            let start = index
            while index < bytes.count,
                  bytes[index] == 0x2d
                    || bytes[index] == 0x2b
                    || bytes[index] == 0x2e
                    || bytes[index] == 0x45
                    || bytes[index] == 0x65
                    || (0x30...0x39).contains(bytes[index]) {
                index += 1
            }
            guard index > start else { throw LifecycleStorageError.invalidState }
        default:
            throw LifecycleStorageError.invalidState
        }
    }

    private mutating func parseString() throws -> String {
        let start = index
        guard consume(0x22) else { throw LifecycleStorageError.invalidState }
        while index < bytes.count {
            let byte = bytes[index]
            index += 1
            if byte == 0x22 {
                let encoded = Data(bytes[start..<index])
                guard let decoded = try? JSONDecoder().decode(String.self, from: encoded) else {
                    throw LifecycleStorageError.invalidState
                }
                return decoded
            }
            guard byte >= 0x20 else { throw LifecycleStorageError.invalidState }
            if byte == 0x5c {
                guard index < bytes.count else { throw LifecycleStorageError.invalidState }
                index += 1
            }
        }
        throw LifecycleStorageError.invalidState
    }

    private mutating func consumeLiteral(_ literal: [UInt8]) throws {
        guard index + literal.count <= bytes.count,
              Array(bytes[index..<(index + literal.count)]) == literal else {
            throw LifecycleStorageError.invalidState
        }
        index += literal.count
    }

    private mutating func skipWhitespace() {
        while index < bytes.count,
              bytes[index] == 0x20
                || bytes[index] == 0x09
                || bytes[index] == 0x0a
                || bytes[index] == 0x0d {
            index += 1
        }
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        guard index < bytes.count, bytes[index] == byte else { return false }
        index += 1
        return true
    }
}

public final class LifecycleLock: @unchecked Sendable {
    typealias AnchorParentMetadataTransform = (stat) -> stat

    private let stateDirectory: VerifiedStateDirectory
    private let anchorDescriptor: Int32
    private let markerDescriptor: Int32

    private init(
        stateDirectory: VerifiedStateDirectory,
        anchorDescriptor: Int32,
        markerDescriptor: Int32
    ) {
        self.stateDirectory = stateDirectory
        self.anchorDescriptor = anchorDescriptor
        self.markerDescriptor = markerDescriptor
    }

    deinit {
        _ = runtimeRaidersFlock(markerDescriptor, LOCK_UN)
        Darwin.close(markerDescriptor)
        _ = runtimeRaidersFlock(anchorDescriptor, LOCK_UN)
        Darwin.close(anchorDescriptor)
        _ = stateDirectory
    }

    public static func acquire(at url: URL) throws -> LifecycleLock {
        try acquire(at: url, anchorParentMetadataTransform: { $0 })
    }

    static func acquire(
        at url: URL,
        anchorParentMetadataTransform: @escaping AnchorParentMetadataTransform
    ) throws -> LifecycleLock {
        guard url.isFileURL,
              url.path.hasPrefix("/"),
              url.standardized.path == url.path,
              !url.lastPathComponent.isEmpty else {
            throw LifecycleStorageError.invalidPath
        }
        let anchorDescriptor = try openAndLockHomeAnchor(
            for: url,
            parentMetadataTransform: anchorParentMetadataTransform
        )
        var retainsAnchor = false
        defer {
            if !retainsAnchor {
                _ = runtimeRaidersFlock(anchorDescriptor, LOCK_UN)
                Darwin.close(anchorDescriptor)
            }
        }
        let stateDirectory = try VerifiedStateDirectory(url: url.deletingLastPathComponent())
        try stateDirectory.verifyPathIdentity()
        let markerDescriptor = Darwin.openat(
            stateDirectory.descriptor,
            url.lastPathComponent,
            O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard markerDescriptor >= 0 else { throw LifecycleStorageError.invalidState }
        var metadata = stat()
        guard Darwin.fstat(markerDescriptor, &metadata) == 0,
              VerifiedStateDirectory.validPrivateFile(
                metadata,
                maximumBytes: 0,
                allowsEmpty: true
              ) else {
            Darwin.close(markerDescriptor)
            throw LifecycleStorageError.invalidState
        }
        guard runtimeRaidersFlock(markerDescriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockError = errno
            Darwin.close(markerDescriptor)
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                throw LifecycleStorageError.busy
            }
            throw LifecycleStorageError.invalidState
        }
        retainsAnchor = true
        return LifecycleLock(
            stateDirectory: stateDirectory,
            anchorDescriptor: anchorDescriptor,
            markerDescriptor: markerDescriptor
        )
    }

    private static func openAndLockHomeAnchor(
        for marker: URL,
        parentMetadataTransform: AnchorParentMetadataTransform
    ) throws -> Int32 {
        let applicationSupport = marker.deletingLastPathComponent()
        let library = applicationSupport.deletingLastPathComponent()
        let home = library.deletingLastPathComponent()
        guard applicationSupport.lastPathComponent == "Application Support",
              library.lastPathComponent == "Library",
              !home.lastPathComponent.isEmpty,
              home.path != "/" else {
            throw LifecycleStorageError.invalidPath
        }

        let parent = home.deletingLastPathComponent()
        let parentDescriptor = Darwin.open(
            parent.path,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard parentDescriptor >= 0 else { throw LifecycleStorageError.invalidState }
        defer { Darwin.close(parentDescriptor) }

        var parentMetadata = stat()
        guard Darwin.fstat(parentDescriptor, &parentMetadata) == 0 else {
            throw LifecycleStorageError.invalidState
        }
        parentMetadata = parentMetadataTransform(parentMetadata)
        guard parentMetadata.st_mode & S_IFMT == S_IFDIR,
              parentMetadata.st_uid == 0,
              parentMetadata.st_mode & mode_t(S_IWGRP | S_IWOTH) == 0 else {
            throw LifecycleStorageError.invalidState
        }

        let homeDescriptor = Darwin.openat(
            parentDescriptor,
            home.lastPathComponent,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard homeDescriptor >= 0 else { throw LifecycleStorageError.invalidState }
        var retainsHome = false
        defer {
            if !retainsHome { Darwin.close(homeDescriptor) }
        }

        var homeMetadata = stat()
        guard Darwin.fstat(homeDescriptor, &homeMetadata) == 0,
              homeMetadata.st_mode & S_IFMT == S_IFDIR,
              homeMetadata.st_uid == Darwin.geteuid(),
              homeMetadata.st_mode & mode_t(S_IWGRP | S_IWOTH) == 0,
              homeMatchesPath(
                parentDescriptor: parentDescriptor,
                name: home.lastPathComponent,
                metadata: homeMetadata
              ) else {
            throw LifecycleStorageError.invalidState
        }

        guard runtimeRaidersFlock(homeDescriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockError = errno
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                throw LifecycleStorageError.busy
            }
            throw LifecycleStorageError.invalidState
        }
        guard homeMatchesPath(
            parentDescriptor: parentDescriptor,
            name: home.lastPathComponent,
            metadata: homeMetadata
        ) else {
            _ = runtimeRaidersFlock(homeDescriptor, LOCK_UN)
            throw LifecycleStorageError.invalidState
        }
        retainsHome = true
        return homeDescriptor
    }

    private static func homeMatchesPath(
        parentDescriptor: Int32,
        name: String,
        metadata: stat
    ) -> Bool {
        var pathMetadata = stat()
        return Darwin.fstatat(
            parentDescriptor,
            name,
            &pathMetadata,
            AT_SYMLINK_NOFOLLOW
        ) == 0
            && pathMetadata.st_mode & S_IFMT == S_IFDIR
            && pathMetadata.st_dev == metadata.st_dev
            && pathMetadata.st_ino == metadata.st_ino
    }
}

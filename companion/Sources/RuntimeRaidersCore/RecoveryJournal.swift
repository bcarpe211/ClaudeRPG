import Darwin
import Foundation

@_silgen_name("flock")
private func runtimeRaidersFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

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
    let url: URL
    let descriptor: Int32
    private let device: dev_t
    private let inode: ino_t

    init(url: URL) throws {
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
        guard Darwin.fstat(file, &metadata) == 0,
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
            try AtomicStore().write(data, directoryDescriptor: descriptor, name: name)
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
            && metadata.st_mode & 0o777 == 0o600
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

    public func load() throws -> RecoveryJournal? {
        guard let data = try stateDirectory.readPrivateFile(
            name: name,
            maximumBytes: Self.maximumBytes
        ) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(RecoveryJournal.CodingKeys.allCases.map(\.rawValue)),
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
            && journal.replacementDeviceToken.range(
                of: #"^[A-Za-z0-9_-]{43}$"#,
                options: .regularExpression
            ) != nil
    }
}

public final class LifecycleLock: @unchecked Sendable {
    private let stateDirectory: VerifiedStateDirectory
    private let descriptor: Int32

    private init(stateDirectory: VerifiedStateDirectory, descriptor: Int32) {
        self.stateDirectory = stateDirectory
        self.descriptor = descriptor
    }

    deinit {
        _ = runtimeRaidersFlock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
        _ = stateDirectory
    }

    public static func acquire(at url: URL) throws -> LifecycleLock {
        guard url.isFileURL,
              url.path.hasPrefix("/"),
              url.standardized.path == url.path,
              !url.lastPathComponent.isEmpty else {
            throw LifecycleStorageError.invalidPath
        }
        let stateDirectory = try VerifiedStateDirectory(url: url.deletingLastPathComponent())
        try stateDirectory.verifyPathIdentity()
        let descriptor = Darwin.openat(
            stateDirectory.descriptor,
            url.lastPathComponent,
            O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else { throw LifecycleStorageError.invalidState }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              VerifiedStateDirectory.validPrivateFile(
                metadata,
                maximumBytes: 0,
                allowsEmpty: true
              ) else {
            Darwin.close(descriptor)
            throw LifecycleStorageError.invalidState
        }
        guard runtimeRaidersFlock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockError = errno
            Darwin.close(descriptor)
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                throw LifecycleStorageError.busy
            }
            throw LifecycleStorageError.invalidState
        }
        return LifecycleLock(stateDirectory: stateDirectory, descriptor: descriptor)
    }
}

import Darwin
import Foundation

public enum OutboxError: Error, Equatable {
    case invalidLimit
    case invalidDirectory
    case invalidRecord
}

public struct OutboxRecord: Equatable, Sendable {
    public let url: URL
    public let event: RunEventV1
    public let encodedEvent: Data

    public var idempotencyKey: String { event.idempotencyKey }
}

public final class Outbox: @unchecked Sendable {
    public static let defaultMaximumBytes = 50 * 1_024 * 1_024
    public static let defaultMaximumAgeMS: Int64 = 7 * 24 * 60 * 60 * 1_000
    private static let maximumRecordBytes = 64 * 1_024

    public let directory: URL
    private let maximumBytes: Int
    private let maximumAgeMS: Int64
    private let directoryDescriptor: Int32
    private let directoryDevice: dev_t
    private let directoryInode: ino_t
    private let expectedRecordOwnerID: uid_t
    private let directorySynchronizationObserver: () -> Void
    private let lock = NSLock()

    public convenience init(
        directory: URL,
        maximumBytes: Int = Outbox.defaultMaximumBytes,
        maximumAgeMS: Int64 = Outbox.defaultMaximumAgeMS
    ) throws {
        try self.init(
            directory: directory,
            maximumBytes: maximumBytes,
            maximumAgeMS: maximumAgeMS,
            expectedRecordOwnerID: geteuid()
        )
    }

    convenience init(
        directory: URL,
        directorySynchronizationObserver: @escaping () -> Void
    ) throws {
        try self.init(
            directory: directory,
            maximumBytes: Self.defaultMaximumBytes,
            maximumAgeMS: Self.defaultMaximumAgeMS,
            expectedRecordOwnerID: geteuid(),
            directorySynchronizationObserver: directorySynchronizationObserver
        )
    }

    init(
        directory: URL,
        maximumBytes: Int = Outbox.defaultMaximumBytes,
        maximumAgeMS: Int64 = Outbox.defaultMaximumAgeMS,
        expectedRecordOwnerID: uid_t,
        directorySynchronizationObserver: @escaping () -> Void = {}
    ) throws {
        guard directory.isFileURL, directory.path.hasPrefix("/"),
              maximumBytes >= 0, maximumAgeMS >= 0 else {
            throw OutboxError.invalidDirectory
        }
        self.directory = URL(fileURLWithPath: directory.path, isDirectory: true)
        self.maximumBytes = maximumBytes
        self.maximumAgeMS = maximumAgeMS
        directoryDescriptor = try Self.openOrCreatePrivateDirectory(self.directory)
        var metadata = stat()
        guard Darwin.fstat(directoryDescriptor, &metadata) == 0 else {
            Darwin.close(directoryDescriptor)
            throw Self.currentPOSIXError()
        }
        directoryDevice = metadata.st_dev
        directoryInode = metadata.st_ino
        self.expectedRecordOwnerID = expectedRecordOwnerID
        self.directorySynchronizationObserver = directorySynchronizationObserver
    }

    private init(
        directory: URL,
        maximumBytes: Int,
        maximumAgeMS: Int64,
        directoryDescriptor: Int32
    ) {
        self.directory = directory
        self.maximumBytes = maximumBytes
        self.maximumAgeMS = maximumAgeMS
        self.directoryDescriptor = directoryDescriptor
        var metadata = stat()
        precondition(Darwin.fstat(directoryDescriptor, &metadata) == 0)
        directoryDevice = metadata.st_dev
        directoryInode = metadata.st_ino
        expectedRecordOwnerID = geteuid()
        directorySynchronizationObserver = {}
    }

    deinit { Darwin.close(directoryDescriptor) }

    public static func queuedCount(inExistingDirectory directory: URL) throws -> Int {
        guard let descriptor = try OwnerOnlyDirectory.openExisting(directory) else { return 0 }
        let outbox = Outbox(
            directory: URL(fileURLWithPath: directory.path, isDirectory: true),
            maximumBytes: defaultMaximumBytes,
            maximumAgeMS: defaultMaximumAgeMS,
            directoryDescriptor: descriptor
        )
        return try outbox.queuedCount()
    }

    public func enqueue(_ event: RunEventV1) throws {
        let encoded = try PrivacyEncoder().encode(event)
        guard encoded.count <= Self.maximumRecordBytes else { throw OutboxError.invalidRecord }
        let name = Self.fileName(for: event)
        try lock.withLock {
            if Darwin.faccessat(directoryDescriptor, name, F_OK, AT_SYMLINK_NOFOLLOW) == 0 {
                guard let existing = try decodedRecord(name: name) else {
                    throw OutboxError.invalidRecord
                }
                var replayed = event
                replayed.observedAtMS = existing.event.observedAtMS
                replayed.surface = existing.event.surface
                guard replayed == existing.event else { throw OutboxError.invalidRecord }
                return
            } else if errno != ENOENT {
                throw Self.currentPOSIXError()
            }
            try atomicWrite(encoded, name: name)
        }
    }

    public func records(limit: Int) throws -> [OutboxRecord] {
        guard (0...100).contains(limit) else { throw OutboxError.invalidLimit }
        return try lock.withLock { Array(try unlockedRecords().prefix(limit)) }
    }

    public func queuedCount() throws -> Int {
        try lock.withLock { try unlockedRecords().count }
    }

    public func validatedQueuedCount() throws -> Int {
        try lock.withLock {
            try ensureDirectoryIdentity()
            let validated = try validatedOwnedRecords()
            defer { validated.forEach { Darwin.close($0.descriptor) } }
            try revalidateAll(validated)
            return validated.count
        }
    }

    public func totalBytes() throws -> Int {
        try lock.withLock { try unlockedRecords().reduce(0) { $0 + $1.encodedEvent.count } }
    }

    public func discardAllValidated() throws -> Int {
        try lock.withLock {
            try ensureDirectoryIdentity()
            let validated = try validatedOwnedRecords()
            defer { validated.forEach { Darwin.close($0.descriptor) } }

            try revalidateAll(validated)
            for item in validated {
                try ensureDirectoryIdentity()
                guard try pathStillIdentifies(item) else { throw OutboxError.invalidRecord }
                guard Darwin.unlinkat(directoryDescriptor, item.name, 0) == 0 else {
                    throw Self.currentPOSIXError()
                }
            }
            try synchronizeDirectory()
            return validated.count
        }
    }

    final class ValidatedDeliveryBatch {
        fileprivate let outboxIdentity: ObjectIdentifier
        fileprivate let validated: [ValidatedRecord]
        fileprivate var wasAcknowledged = false

        var records: [OutboxRecord] { validated.map(\.record) }

        fileprivate init(outbox: Outbox, validated: [ValidatedRecord]) {
            outboxIdentity = ObjectIdentifier(outbox)
            self.validated = validated
        }

        deinit { validated.forEach { Darwin.close($0.descriptor) } }
    }

    func validatedDeliveryBatch(limit: Int) throws -> ValidatedDeliveryBatch {
        guard (0...100).contains(limit) else { throw OutboxError.invalidLimit }
        return try lock.withLock {
            try ensureDirectoryIdentity()
            let validated = try validatedOwnedRecords()
            do {
                try revalidateAll(validated)
                let ordered = validated.sorted { Self.recordsPrecede($0.record, $1.record) }
                let selected = Array(ordered.prefix(limit))
                ordered.dropFirst(selected.count).forEach { Darwin.close($0.descriptor) }
                return ValidatedDeliveryBatch(outbox: self, validated: selected)
            } catch {
                validated.forEach { Darwin.close($0.descriptor) }
                throw error
            }
        }
    }

    func acknowledge(_ batch: ValidatedDeliveryBatch) throws {
        try lock.withLock {
            guard batch.outboxIdentity == ObjectIdentifier(self),
                  !batch.wasAcknowledged else {
                throw OutboxError.invalidRecord
            }
            try ensureDirectoryIdentity()
            for item in batch.validated {
                try revalidateForAcknowledgement(item)
            }
            for item in batch.validated {
                try ensureDirectoryIdentity()
                try revalidateForAcknowledgement(item)
                guard Darwin.unlinkat(directoryDescriptor, item.name, 0) == 0 else {
                    throw OutboxError.invalidRecord
                }
            }
            try synchronizeDirectory()
            batch.wasAcknowledged = true
        }
    }

    public func acknowledge(_ records: [OutboxRecord]) throws {
        try lock.withLock {
            for record in records {
                let name = record.url.lastPathComponent
                guard record.url.deletingLastPathComponent().path == directory.path,
                      Self.isOwnedRecordName(name) else { throw OutboxError.invalidRecord }
                if Darwin.unlinkat(directoryDescriptor, name, 0) != 0, errno != ENOENT {
                    throw Self.currentPOSIXError()
                }
            }
            try synchronizeDirectory()
        }
    }

    public func prune(nowMS: Int64) throws {
        try lock.withLock {
            let entries = try physicalOwnedEntries()
            var retained: [(entry: PhysicalEntry, oldestAtMS: Int64)] = []
            for entry in entries {
                let event = try? decodedRecord(name: entry.name)?.event
                let oldestAtMS = event?.eventTimeMS ?? entry.storageTimestampMS
                if nowMS >= oldestAtMS, nowMS - oldestAtMS > maximumAgeMS {
                    try unlink(entry.name)
                } else {
                    retained.append((entry, oldestAtMS))
                }
            }
            retained.sort {
                ($0.oldestAtMS, $0.entry.name) < ($1.oldestAtMS, $1.entry.name)
            }
            var bytes = retained.reduce(0) { $0 + $1.entry.size }
            for item in retained where bytes > maximumBytes {
                let entry = item.entry
                try unlink(entry.name)
                bytes -= entry.size
            }
            try synchronizeDirectory()
        }
    }

    private func unlockedRecords() throws -> [OutboxRecord] {
        let names = try directoryNames()
            .filter(Self.isOwnedRecordName)
            .sorted()
        return names.compactMap { try? decodedRecord(name: $0) }.compactMap { $0 }
            .sorted(by: Self.recordsPrecede)
    }

    fileprivate struct ValidatedRecord {
        let name: String
        let descriptor: Int32
        let metadata: stat
        let record: OutboxRecord
    }

    private func validatedOwnedRecords() throws -> [ValidatedRecord] {
        let names = try directoryNames().filter(Self.isOwnedRecordName).sorted()
        var validated: [ValidatedRecord] = []
        do {
            for name in names {
                let descriptor = Darwin.openat(
                    directoryDescriptor,
                    name,
                    O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
                )
                guard descriptor >= 0 else { throw OutboxError.invalidRecord }
                do {
                    let result = try validateRecord(
                        name: name,
                        descriptor: descriptor,
                        expectedMetadata: nil
                    )
                    validated.append(ValidatedRecord(
                        name: name,
                        descriptor: descriptor,
                        metadata: result.metadata,
                        record: result.record
                    ))
                } catch {
                    Darwin.close(descriptor)
                    throw error
                }
            }
            return validated
        } catch {
            validated.forEach { Darwin.close($0.descriptor) }
            throw error
        }
    }

    private func revalidateAll(_ validated: [ValidatedRecord]) throws {
        try ensureDirectoryIdentity()
        let currentNames = try directoryNames().filter(Self.isOwnedRecordName).sorted()
        guard currentNames == validated.map(\.name) else { throw OutboxError.invalidRecord }
        for item in validated {
            guard try pathStillIdentifies(item) else { throw OutboxError.invalidRecord }
            _ = try validateRecord(
                name: item.name,
                descriptor: item.descriptor,
                expectedMetadata: item.metadata
            )
        }
    }

    private func revalidateForAcknowledgement(_ item: ValidatedRecord) throws {
        guard try pathStillIdentifies(item) else { throw OutboxError.invalidRecord }
        _ = try validateRecord(
            name: item.name,
            descriptor: item.descriptor,
            expectedMetadata: item.metadata,
            expectedContent: item.record.encodedEvent
        )
    }

    private func validateRecord(
        name: String,
        descriptor: Int32,
        expectedMetadata: stat?,
        expectedContent: Data? = nil
    ) throws -> (metadata: stat, record: OutboxRecord) {
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == expectedRecordOwnerID,
              metadata.st_mode & 0o7777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size >= 0,
              metadata.st_size <= Self.maximumRecordBytes else {
            throw OutboxError.invalidRecord
        }
        if let expectedMetadata {
            guard Self.sameIdentityAndMetadata(metadata, expectedMetadata) else {
                throw OutboxError.invalidRecord
            }
        }
        guard Darwin.lseek(descriptor, 0, SEEK_SET) == 0 else {
            throw Self.currentPOSIXError()
        }
        let data = try Self.readAll(descriptor: descriptor, size: Int(metadata.st_size))
        guard let event = try? JSONDecoder().decode(RunEventV1.self, from: data),
              let canonical = try? PrivacyEncoder().encode(event),
              canonical == data,
              expectedContent == nil || expectedContent == data,
              name == Self.fileName(for: event) else {
            throw OutboxError.invalidRecord
        }
        return (
            metadata,
            OutboxRecord(
                url: directory.appendingPathComponent(name),
                event: event,
                encodedEvent: data
            )
        )
    }

    private func pathStillIdentifies(_ item: ValidatedRecord) throws -> Bool {
        var metadata = stat()
        guard Darwin.fstatat(
            directoryDescriptor,
            item.name,
            &metadata,
            AT_SYMLINK_NOFOLLOW
        ) == 0 else { return false }
        return Self.sameIdentityAndMetadata(metadata, item.metadata)
    }

    private func ensureDirectoryIdentity() throws {
        var descriptorMetadata = stat()
        var pathMetadata = stat()
        guard Darwin.fstat(directoryDescriptor, &descriptorMetadata) == 0,
              Darwin.lstat(directory.path, &pathMetadata) == 0,
              descriptorMetadata.st_mode & S_IFMT == S_IFDIR,
              pathMetadata.st_mode & S_IFMT == S_IFDIR,
              descriptorMetadata.st_uid == geteuid(),
              pathMetadata.st_uid == geteuid(),
              descriptorMetadata.st_mode & 0o7777 == 0o700,
              pathMetadata.st_mode & 0o7777 == 0o700,
              descriptorMetadata.st_dev == directoryDevice,
              descriptorMetadata.st_ino == directoryInode,
              pathMetadata.st_dev == directoryDevice,
              pathMetadata.st_ino == directoryInode else {
            throw OutboxError.invalidDirectory
        }
    }

    private func decodedRecord(name: String) throws -> OutboxRecord? {
        let data = try readData(name: name)
        guard let event = try? JSONDecoder().decode(RunEventV1.self, from: data),
              let canonical = try? PrivacyEncoder().encode(event),
              canonical == data,
              name == Self.fileName(for: event) else { return nil }
        return OutboxRecord(
            url: directory.appendingPathComponent(name),
            event: event,
            encodedEvent: data
        )
    }

    private func directoryNames() throws -> [String] {
        let duplicate = Darwin.openat(
            directoryDescriptor,
            ".",
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard duplicate >= 0, let stream = Darwin.fdopendir(duplicate) else {
            if duplicate >= 0 { Darwin.close(duplicate) }
            throw Self.currentPOSIXError()
        }
        defer { Darwin.closedir(stream) }
        var names: [String] = []
        while let entry = Darwin.readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            if name != "." && name != ".." { names.append(name) }
        }
        return names
    }

    private struct PhysicalEntry {
        let name: String
        let size: Int
        let storageTimestampMS: Int64
    }

    private func physicalOwnedEntries() throws -> [PhysicalEntry] {
        try directoryNames()
            .filter(Self.isOwnedRecordName)
            .sorted()
            .compactMap { name in
                let descriptor = Darwin.openat(
                    directoryDescriptor,
                    name,
                    O_RDONLY | O_NOFOLLOW | O_CLOEXEC
                )
                guard descriptor >= 0 else { return nil }
                defer { Darwin.close(descriptor) }
                var metadata = stat()
                guard Darwin.fstat(descriptor, &metadata) == 0,
                      metadata.st_mode & S_IFMT == S_IFREG,
                      metadata.st_size >= 0 else { return nil }
                let size = metadata.st_size > Int.max ? Int.max : Int(metadata.st_size)
                return PhysicalEntry(
                    name: name,
                    size: size,
                    storageTimestampMS: Self.storageTimestampMS(metadata)
                )
            }
    }

    private func readData(name: String) throws -> Data {
        let descriptor = Darwin.openat(
            directoryDescriptor,
            name,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            throw Self.currentPOSIXError()
        }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_size >= 0,
              metadata.st_size <= Self.maximumRecordBytes else {
            throw OutboxError.invalidRecord
        }
        var data = Data(count: Int(metadata.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else if count == 0 { throw OutboxError.invalidRecord }
                else { throw Self.currentPOSIXError() }
            }
        }
        return data
    }

    private static func readAll(descriptor: Int32, size: Int) throws -> Data {
        var data = Data(count: size)
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw OutboxError.invalidRecord }
            }
        }
        var extra: UInt8 = 0
        while true {
            let count = Darwin.read(descriptor, &extra, 1)
            if count == 0 { break }
            if count < 0, errno == EINTR { continue }
            throw OutboxError.invalidRecord
        }
        return data
    }

    private func atomicWrite(_ data: Data, name: String) throws {
        let temporary = ".\(name).runtime-raiders-tmp-\(UUID().uuidString)"
        let descriptor = Darwin.openat(
            directoryDescriptor,
            temporary,
            O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else { throw Self.currentPOSIXError() }
        var open = true
        defer {
            if open { Darwin.close(descriptor) }
            _ = Darwin.unlinkat(directoryDescriptor, temporary, 0)
        }
        try Self.writeAll(data, descriptor: descriptor)
        guard Darwin.fsync(descriptor) == 0 else { throw Self.currentPOSIXError() }
        guard Darwin.close(descriptor) == 0 else { throw Self.currentPOSIXError() }
        open = false
        guard Darwin.renameat(directoryDescriptor, temporary, directoryDescriptor, name) == 0 else {
            throw Self.currentPOSIXError()
        }
        try synchronizeDirectory()
    }

    private func unlink(_ name: String) throws {
        guard Self.isOwnedRecordName(name),
              Darwin.unlinkat(directoryDescriptor, name, 0) == 0 || errno == ENOENT else {
            throw Self.currentPOSIXError()
        }
    }

    private func synchronizeDirectory() throws {
        while Darwin.fsync(directoryDescriptor) != 0 {
            if errno == EINTR { continue }
            throw Self.currentPOSIXError()
        }
        directorySynchronizationObserver()
    }

    private static func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw currentPOSIXError() }
            }
        }
    }

    private static func openOrCreatePrivateDirectory(_ url: URL) throws -> Int32 {
        var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { throw currentPOSIXError() }
        let components = url.pathComponents.filter { $0 != "/" }
        guard !components.isEmpty else {
            Darwin.close(descriptor)
            throw OutboxError.invalidDirectory
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
                throw OutboxError.invalidDirectory
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

    private static func fileName(for event: RunEventV1) -> String {
        event.idempotencyKey + ".json"
    }

    private static func isOwnedRecordName(_ name: String) -> Bool {
        name.range(
            of: #"^[0-9a-f]{64}\.json$"#,
            options: .regularExpression
        ) != nil
    }

    private static func recordsPrecede(_ lhs: OutboxRecord, _ rhs: OutboxRecord) -> Bool {
        let left = (
            lhs.event.runKey,
            lhs.event.sequence,
            lhs.event.idempotencyKey,
            lhs.event.observedAtMS
        )
        let right = (
            rhs.event.runKey,
            rhs.event.sequence,
            rhs.event.idempotencyKey,
            rhs.event.observedAtMS
        )
        return left < right
    }

    private static func sameIdentityAndMetadata(_ lhs: stat, _ rhs: stat) -> Bool {
        lhs.st_dev == rhs.st_dev
            && lhs.st_ino == rhs.st_ino
            && lhs.st_mode == rhs.st_mode
            && lhs.st_uid == rhs.st_uid
            && lhs.st_nlink == rhs.st_nlink
            && lhs.st_size == rhs.st_size
    }

    private static func storageTimestampMS(_ metadata: stat) -> Int64 {
        let modified = milliseconds(metadata.st_mtimespec)
        let created = milliseconds(metadata.st_birthtimespec)
        let candidates = [modified, created].filter { $0 > 0 }
        return candidates.min() ?? 0
    }

    private static func milliseconds(_ value: timespec) -> Int64 {
        guard value.tv_sec > 0 else { return 0 }
        let seconds = min(Int64(value.tv_sec), Int64.max / 1_000)
        let nanoseconds = max(0, min(Int64(value.tv_nsec), 999_999_999))
        return seconds * 1_000 + nanoseconds / 1_000_000
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

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
    private let lock = NSLock()

    public init(
        directory: URL,
        maximumBytes: Int = Outbox.defaultMaximumBytes,
        maximumAgeMS: Int64 = Outbox.defaultMaximumAgeMS
    ) throws {
        guard directory.isFileURL, directory.path.hasPrefix("/"),
              maximumBytes >= 0, maximumAgeMS >= 0 else {
            throw OutboxError.invalidDirectory
        }
        self.directory = URL(fileURLWithPath: directory.path, isDirectory: true)
        self.maximumBytes = maximumBytes
        self.maximumAgeMS = maximumAgeMS
        directoryDescriptor = try Self.openOrCreatePrivateDirectory(self.directory)
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

    public func totalBytes() throws -> Int {
        try lock.withLock { try unlockedRecords().reduce(0) { $0 + $1.encodedEvent.count } }
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
        return names.compactMap { try? decodedRecord(name: $0) }.compactMap { $0 }.sorted { lhs, rhs in
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

import Darwin
import Foundation

enum ReleaseFilesystem {
    static let maximumRecordBytes = 16 * 1_024

    enum FaultPhase: Equatable {
        case afterPartialTemporaryWrite
        case beforeRename
        case afterRenameBeforeDirectorySync
    }

    static func openOrCreateOwnerOnlyDirectory(_ url: URL) throws -> Int32 {
        let descriptor = try OwnerOnlyDirectory.openOrCreate(url)
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o700 else {
            Darwin.close(descriptor)
            throw ReleaseContractError.invalidReleaseState
        }
        return descriptor
    }

    static func readRegularRecord(
        directoryDescriptor: Int32,
        name: String
    ) throws -> Data? {
        let descriptor = Darwin.openat(
            directoryDescriptor,
            name,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            if errno == ENOENT { return nil }
            throw ReleaseContractError.invalidReleaseState
        }
        defer { Darwin.close(descriptor) }

        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size > 0,
              metadata.st_size <= maximumRecordBytes else {
            throw ReleaseContractError.invalidReleaseState
        }

        var data = Data(count: Int(metadata.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw ReleaseContractError.invalidReleaseState }
            }
        }
        var extra: UInt8 = 0
        while true {
            let count = Darwin.read(descriptor, &extra, 1)
            if count == 0 { break }
            if count < 0, errno == EINTR { continue }
            throw ReleaseContractError.invalidReleaseState
        }
        return data
    }

    static func writeAtomically(
        _ data: Data,
        directoryDescriptor: Int32,
        name: String,
        fault: ((FaultPhase) throws -> Void)?
    ) throws {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"),
              !data.isEmpty, data.count <= maximumRecordBytes else {
            throw ReleaseContractError.invalidReleaseState
        }
        let temporary = ".\(name).runtime-raiders-tmp-\(UUID().uuidString)"
        let descriptor = Darwin.openat(
            directoryDescriptor,
            temporary,
            O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC,
            mode_t(0o600)
        )
        guard descriptor >= 0 else { throw currentError() }
        var needsClose = true
        defer {
            if needsClose { _ = Darwin.close(descriptor) }
            _ = Darwin.unlinkat(directoryDescriptor, temporary, 0)
        }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            throw ReleaseContractError.invalidReleaseState
        }
        if let fault {
            let split = max(1, data.count / 2)
            try writeAll(Data(data.prefix(split)), descriptor: descriptor)
            try fault(.afterPartialTemporaryWrite)
            try writeAll(Data(data.dropFirst(split)), descriptor: descriptor)
        } else {
            try writeAll(data, descriptor: descriptor)
        }
        try synchronize(descriptor)
        try close(descriptor)
        needsClose = false
        try fault?(.beforeRename)
        guard Darwin.renameat(directoryDescriptor, temporary, directoryDescriptor, name) == 0 else {
            throw currentError()
        }
        try fault?(.afterRenameBeforeDirectorySync)
        try synchronize(directoryDescriptor)
    }

    static func createExclusively(
        _ data: Data,
        directoryDescriptor: Int32,
        name: String,
        fault: ((FaultPhase) throws -> Void)?
    ) throws {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"),
              !data.isEmpty, data.count <= maximumRecordBytes else {
            throw ReleaseContractError.invalidReleaseState
        }
        let temporary = ".\(name).runtime-raiders-tmp-\(UUID().uuidString)"
        let descriptor = Darwin.openat(
            directoryDescriptor,
            temporary,
            O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC,
            mode_t(0o600)
        )
        guard descriptor >= 0 else { throw currentError() }
        var needsClose = true
        defer {
            if needsClose { _ = Darwin.close(descriptor) }
            _ = Darwin.unlinkat(directoryDescriptor, temporary, 0)
        }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            throw ReleaseContractError.invalidReleaseState
        }
        if let fault {
            let split = max(1, data.count / 2)
            try writeAll(Data(data.prefix(split)), descriptor: descriptor)
            try fault(.afterPartialTemporaryWrite)
            try writeAll(Data(data.dropFirst(split)), descriptor: descriptor)
        } else {
            try writeAll(data, descriptor: descriptor)
        }
        try synchronize(descriptor)
        try close(descriptor)
        needsClose = false
        try fault?(.beforeRename)
        guard Darwin.linkat(directoryDescriptor, temporary, directoryDescriptor, name, 0) == 0 else {
            throw currentError()
        }
        guard Darwin.unlinkat(directoryDescriptor, temporary, 0) == 0 else {
            throw currentError()
        }
        try synchronize(directoryDescriptor)
    }

    private static func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if written > 0 { offset += written }
                else if written < 0, errno == EINTR { continue }
                else { throw currentError() }
            }
        }
    }

    private static func synchronize(_ descriptor: Int32) throws {
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw currentError()
        }
    }

    private static func close(_ descriptor: Int32) throws {
        while Darwin.close(descriptor) != 0 {
            if errno == EINTR { continue }
            throw currentError()
        }
    }

    private static func currentError() -> Error {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

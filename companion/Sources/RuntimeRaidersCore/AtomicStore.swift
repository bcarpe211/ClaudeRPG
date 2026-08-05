import Darwin
import Foundation

public struct AtomicStore {
    typealias Replace = (_ temporary: URL, _ destination: URL) throws -> Void

    private let replace: Replace

    public init() {
        replace = Self.atomicReplace
    }

    init(replace: @escaping Replace) {
        self.replace = replace
    }

    public func write(_ data: Data, to destination: URL) throws {
        let parent = destination.deletingLastPathComponent()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: parent.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw CocoaError(.fileNoSuchFile)
        }

        let temporary = parent.appendingPathComponent(
            ".\(destination.lastPathComponent).runtime-raiders-tmp-\(UUID().uuidString)",
            isDirectory: false
        )
        defer { try? FileManager.default.removeItem(at: temporary) }

        try Self.createPrivateTemporaryFile(at: temporary, contents: data)

        try replace(temporary, destination)
        try Self.synchronizeDirectory(parent)
    }

    func write(
        _ data: Data,
        directoryDescriptor: Int32,
        name: String
    ) throws {
        guard !name.isEmpty,
              name != ".",
              name != "..",
              !name.contains("/") else {
            throw POSIXError(.EINVAL)
        }
        let temporary = ".\(name).runtime-raiders-tmp-\(UUID().uuidString)"
        let descriptor = Darwin.openat(
            directoryDescriptor,
            temporary,
            O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else { throw Self.currentPOSIXError() }
        var needsClose = true
        defer {
            if needsClose { try? Self.closeDescriptor(descriptor) }
            _ = Darwin.unlinkat(directoryDescriptor, temporary, 0)
        }
        try Self.writeAll(data, to: descriptor)
        try Self.synchronizeDescriptor(descriptor)
        try Self.closeDescriptor(descriptor)
        needsClose = false
        guard Darwin.renameat(
            directoryDescriptor,
            temporary,
            directoryDescriptor,
            name
        ) == 0 else {
            throw Self.currentPOSIXError()
        }
        try Self.synchronizeDescriptor(directoryDescriptor)
    }

    private static func createPrivateTemporaryFile(at temporary: URL, contents: Data) throws {
        let descriptor = Darwin.open(
            temporary.path,
            O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else {
            throw currentPOSIXError()
        }

        var needsClose = true
        defer {
            if needsClose {
                try? closeDescriptor(descriptor)
            }
        }

        try writeAll(contents, to: descriptor)
        try synchronizeDescriptor(descriptor)
        try closeDescriptor(descriptor)
        needsClose = false
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { buffer in
            guard let baseAddress = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let count = min(buffer.count - offset, Int(Int32.max))
                let written = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    count
                )
                if written > 0 {
                    offset += written
                } else if written < 0, errno == EINTR {
                    continue
                } else {
                    throw written == 0 ? POSIXError(.EIO) : currentPOSIXError()
                }
            }
        }
    }

    private static func synchronizeDescriptor(_ descriptor: Int32) throws {
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw currentPOSIXError()
        }
    }

    private static func closeDescriptor(_ descriptor: Int32) throws {
        while Darwin.close(descriptor) != 0 {
            if errno == EINTR { continue }
            throw currentPOSIXError()
        }
    }

    private static func atomicReplace(temporary: URL, destination: URL) throws {
        guard Darwin.rename(temporary.path, destination.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private static func synchronizeDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw currentPOSIXError()
        }
        var needsClose = true
        defer {
            if needsClose {
                try? closeDescriptor(descriptor)
            }
        }
        try synchronizeDescriptor(descriptor)
        try closeDescriptor(descriptor)
        needsClose = false
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

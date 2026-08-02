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

        try data.write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o600))],
            ofItemAtPath: temporary.path
        )
        let handle = try FileHandle(forWritingTo: temporary)
        do {
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }

        try replace(temporary, destination)
        try Self.synchronizeDirectory(parent)
    }

    private static func atomicReplace(temporary: URL, destination: URL) throws {
        guard Darwin.rename(temporary.path, destination.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private static func synchronizeDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}

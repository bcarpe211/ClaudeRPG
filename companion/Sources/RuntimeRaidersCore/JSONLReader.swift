import Darwin
import Foundation

public struct JSONLFileIdentity: Codable, Equatable, Sendable {
    public let device: UInt64
    public let inode: UInt64

    public init(device: UInt64, inode: UInt64) {
        self.device = device
        self.inode = inode
    }
}

public struct JSONLCursor: Codable, Equatable, Sendable {
    public var offset: Int64
    public var fileIdentity: JSONLFileIdentity?
    public var partialLine: Data

    public init(
        offset: Int64 = 0,
        fileIdentity: JSONLFileIdentity? = nil,
        partialLine: Data = Data()
    ) {
        self.offset = offset
        self.fileIdentity = fileIdentity
        self.partialLine = partialLine
    }
}

public struct JSONLReadResult: Equatable, Sendable {
    public let lines: [Data]
    public let cursor: JSONLCursor
    public let bytesRead: Int

    public init(lines: [Data], cursor: JSONLCursor, bytesRead: Int) {
        self.lines = lines
        self.cursor = cursor
        self.bytesRead = bytesRead
    }
}

public enum JSONLReaderError: Error, Equatable {
    case invalidMaximumBytes
    case invalidCursor
    case unsupportedFile
    case lineTooLong
}

public enum JSONLReader {
    public static let maximumReadBytes = 1_048_576
    public static let maximumBufferedLineBytes = 1_048_576

    public static func readAppended(
        file: URL,
        cursor: JSONLCursor,
        maxBytes: Int
    ) throws -> JSONLReadResult {
        guard (1...maximumReadBytes).contains(maxBytes) else {
            throw JSONLReaderError.invalidMaximumBytes
        }
        guard cursor.offset >= 0,
              cursor.partialLine.count <= maximumBufferedLineBytes,
              Int64(cursor.partialLine.count) <= cursor.offset else {
            throw JSONLReaderError.invalidCursor
        }
        if cursor.fileIdentity == nil,
           cursor.offset != 0 || !cursor.partialLine.isEmpty {
            throw JSONLReaderError.invalidCursor
        }

        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let metadata = try fileMetadata(handle: handle)

        var effectiveCursor = cursor
        if let priorIdentity = cursor.fileIdentity {
            if priorIdentity != metadata.identity || metadata.size < cursor.offset {
                effectiveCursor = JSONLCursor(fileIdentity: metadata.identity)
            }
        } else {
            effectiveCursor.fileIdentity = metadata.identity
        }

        try handle.seek(toOffset: UInt64(effectiveCursor.offset))
        let appended = try handle.read(upToCount: maxBytes) ?? Data()
        var buffered = effectiveCursor.partialLine
        buffered.append(appended)

        var lines: [Data] = []
        var lineStart = buffered.startIndex
        while lineStart < buffered.endIndex,
              let newline = buffered[lineStart...].firstIndex(of: 0x0A) {
            let line = Data(buffered[lineStart..<newline])
            guard line.count <= maximumBufferedLineBytes else {
                throw JSONLReaderError.lineTooLong
            }
            lines.append(line)
            lineStart = buffered.index(after: newline)
        }

        let partial = Data(buffered[lineStart...])
        guard partial.count <= maximumBufferedLineBytes else {
            throw JSONLReaderError.lineTooLong
        }
        let newOffset = effectiveCursor.offset + Int64(appended.count)
        let nextCursor = JSONLCursor(
            offset: newOffset,
            fileIdentity: metadata.identity,
            partialLine: partial
        )
        return JSONLReadResult(lines: lines, cursor: nextCursor, bytesRead: appended.count)
    }

    private static func fileMetadata(handle: FileHandle) throws -> (
        identity: JSONLFileIdentity,
        size: Int64
    ) {
        var information = stat()
        guard Darwin.fstat(handle.fileDescriptor, &information) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard information.st_mode & S_IFMT == S_IFREG else {
            throw JSONLReaderError.unsupportedFile
        }
        return (
            JSONLFileIdentity(
                device: UInt64(information.st_dev),
                inode: UInt64(information.st_ino)
            ),
            Int64(information.st_size)
        )
    }
}

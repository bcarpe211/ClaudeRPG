import Darwin
import CryptoKit
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
    public var continuityCheckpoint: JSONLContinuityCheckpoint?
    public var discardingOversizedLine: Bool

    private enum CodingKeys: String, CodingKey {
        case offset
        case fileIdentity
        case partialLine
        case continuityCheckpoint
        case discardingOversizedLine
    }

    public init(
        offset: Int64 = 0,
        fileIdentity: JSONLFileIdentity? = nil,
        partialLine: Data = Data(),
        continuityCheckpoint: JSONLContinuityCheckpoint? = nil,
        discardingOversizedLine: Bool = false
    ) {
        self.offset = offset
        self.fileIdentity = fileIdentity
        self.partialLine = partialLine
        self.continuityCheckpoint = continuityCheckpoint
        self.discardingOversizedLine = discardingOversizedLine
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        offset = try container.decode(Int64.self, forKey: .offset)
        fileIdentity = try container.decodeIfPresent(
            JSONLFileIdentity.self,
            forKey: .fileIdentity
        )
        partialLine = try container.decode(Data.self, forKey: .partialLine)
        continuityCheckpoint = try container.decodeIfPresent(
            JSONLContinuityCheckpoint.self,
            forKey: .continuityCheckpoint
        )
        discardingOversizedLine = try container.decodeIfPresent(
            Bool.self,
            forKey: .discardingOversizedLine
        ) ?? false
    }
}

public struct JSONLContinuityCheckpoint: Codable, Equatable, Sendable {
    public let byteCount: Int
    public let digest: Data

    public init(byteCount: Int, digest: Data) {
        self.byteCount = byteCount
        self.digest = digest
    }
}

public struct JSONLReadResult: Equatable, Sendable {
    public let lines: [Data]
    public let lineEndOffsets: [Int64]
    public let cursor: JSONLCursor
    public let bytesRead: Int

    public init(
        lines: [Data],
        lineEndOffsets: [Int64],
        cursor: JSONLCursor,
        bytesRead: Int
    ) {
        self.lines = lines
        self.lineEndOffsets = lineEndOffsets
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
    public static let continuityWindowBytes = 4_096

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
              Int64(cursor.partialLine.count) <= cursor.offset,
              !cursor.discardingOversizedLine || cursor.partialLine.isEmpty,
              !cursor.discardingOversizedLine || cursor.offset > 0 else {
            throw JSONLReaderError.invalidCursor
        }
        if let checkpoint = cursor.continuityCheckpoint {
            let expectedByteCount = min(cursor.offset, Int64(continuityWindowBytes))
            guard cursor.offset > 0,
                  checkpoint.byteCount == Int(expectedByteCount),
                  checkpoint.digest.count == SHA256.byteCount else {
                throw JSONLReaderError.invalidCursor
            }
        }
        if cursor.fileIdentity == nil,
           cursor.offset != 0
            || !cursor.partialLine.isEmpty
            || cursor.continuityCheckpoint != nil
            || cursor.discardingOversizedLine {
            throw JSONLReaderError.invalidCursor
        }

        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw currentPOSIXError()
        }
        defer { closeDescriptor(descriptor) }
        let metadata = try fileMetadata(descriptor: descriptor)

        var effectiveCursor = cursor
        if let priorIdentity = cursor.fileIdentity {
            if priorIdentity != metadata.identity || metadata.size < cursor.offset {
                effectiveCursor = JSONLCursor(fileIdentity: metadata.identity)
            } else if cursor.offset > 0 {
                let matches = try cursor.continuityCheckpoint.map {
                    try continuityMatches($0, before: cursor.offset, descriptor: descriptor)
                } ?? false
                if !matches {
                    effectiveCursor = JSONLCursor(fileIdentity: metadata.identity)
                }
            }
        } else {
            effectiveCursor.fileIdentity = metadata.identity
        }

        let appended = try readUpTo(
            maxBytes,
            from: descriptor,
            offset: effectiveCursor.offset
        )
        let newOffset = effectiveCursor.offset + Int64(appended.count)
        var buffered: Data
        var bufferedStartOffset: Int64
        var discardingOversizedLine = effectiveCursor.discardingOversizedLine
        if discardingOversizedLine {
            if let newline = appended.firstIndex(of: 0x0A) {
                let afterNewline = appended.index(after: newline)
                buffered = Data(appended[afterNewline...])
                bufferedStartOffset = effectiveCursor.offset + Int64(afterNewline)
                discardingOversizedLine = false
            } else {
                buffered = Data()
                bufferedStartOffset = newOffset
            }
        } else {
            buffered = effectiveCursor.partialLine
            buffered.append(appended)
            bufferedStartOffset = effectiveCursor.offset
                - Int64(effectiveCursor.partialLine.count)
        }

        var lines: [Data] = []
        var lineEndOffsets: [Int64] = []
        var lineStart = buffered.startIndex
        while lineStart < buffered.endIndex,
              let newline = buffered[lineStart...].firstIndex(of: 0x0A) {
            let line = Data(buffered[lineStart..<newline])
            if line.count <= maximumBufferedLineBytes {
                lines.append(line)
                lineEndOffsets.append(bufferedStartOffset + Int64(newline + 1))
            }
            lineStart = buffered.index(after: newline)
        }

        var partial = Data(buffered[lineStart...])
        if partial.count > maximumBufferedLineBytes {
            partial = Data()
            discardingOversizedLine = true
        }
        let nextCursor = JSONLCursor(
            offset: newOffset,
            fileIdentity: metadata.identity,
            partialLine: partial,
            continuityCheckpoint: try continuityCheckpoint(
                before: newOffset,
                descriptor: descriptor
            ),
            discardingOversizedLine: discardingOversizedLine
        )
        return JSONLReadResult(
            lines: lines,
            lineEndOffsets: lineEndOffsets,
            cursor: nextCursor,
            bytesRead: appended.count
        )
    }

    static func cursor(
        file: URL,
        atOffset offset: Int64,
        expectedIdentity: JSONLFileIdentity
    ) throws -> JSONLCursor {
        guard offset >= 0 else { throw JSONLReaderError.invalidCursor }
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw currentPOSIXError() }
        defer { closeDescriptor(descriptor) }
        let metadata = try fileMetadata(descriptor: descriptor)
        guard metadata.identity == expectedIdentity, metadata.size >= offset else {
            throw JSONLReaderError.invalidCursor
        }
        return JSONLCursor(
            offset: offset,
            fileIdentity: metadata.identity,
            continuityCheckpoint: try continuityCheckpoint(
                before: offset,
                descriptor: descriptor
            )
        )
    }

    static func isCurrent(file: URL, cursor: JSONLCursor) throws -> Bool {
        guard cursor.offset >= 0,
              let identity = cursor.fileIdentity else { return false }
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw currentPOSIXError() }
        defer { closeDescriptor(descriptor) }
        let metadata = try fileMetadata(descriptor: descriptor)
        guard metadata.identity == identity,
              metadata.size >= cursor.offset else { return false }
        guard cursor.offset > 0 else { return true }
        guard let checkpoint = cursor.continuityCheckpoint else { return false }
        return try continuityMatches(checkpoint, before: cursor.offset, descriptor: descriptor)
    }

    private static func fileMetadata(descriptor: Int32) throws -> (
        identity: JSONLFileIdentity,
        size: Int64
    ) {
        var information = stat()
        guard Darwin.fstat(descriptor, &information) == 0 else {
            throw currentPOSIXError()
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

    private static func continuityMatches(
        _ checkpoint: JSONLContinuityCheckpoint,
        before offset: Int64,
        descriptor: Int32
    ) throws -> Bool {
        guard let tail = try readExactly(
            checkpoint.byteCount,
            from: descriptor,
            offset: offset - Int64(checkpoint.byteCount)
        ) else {
            return false
        }
        return Data(SHA256.hash(data: tail)) == checkpoint.digest
    }

    private static func continuityCheckpoint(
        before offset: Int64,
        descriptor: Int32
    ) throws -> JSONLContinuityCheckpoint? {
        guard offset > 0 else { return nil }
        let byteCount = Int(min(offset, Int64(continuityWindowBytes)))
        guard let tail = try readExactly(
            byteCount,
            from: descriptor,
            offset: offset - Int64(byteCount)
        ) else {
            throw JSONLReaderError.invalidCursor
        }
        return JSONLContinuityCheckpoint(
            byteCount: byteCount,
            digest: Data(SHA256.hash(data: tail))
        )
    }

    private static func readUpTo(
        _ count: Int,
        from descriptor: Int32,
        offset: Int64
    ) throws -> Data {
        var data = Data(count: count)
        var total = 0
        try data.withUnsafeMutableBytes { buffer in
            guard let baseAddress = buffer.baseAddress else { return }
            while total < count {
                let readCount = Darwin.pread(
                    descriptor,
                    baseAddress.advanced(by: total),
                    count - total,
                    off_t(offset + Int64(total))
                )
                if readCount > 0 {
                    total += readCount
                } else if readCount == 0 {
                    break
                } else if errno == EINTR {
                    continue
                } else {
                    throw currentPOSIXError()
                }
            }
        }
        data.removeSubrange(total..<data.count)
        return data
    }

    private static func readExactly(
        _ count: Int,
        from descriptor: Int32,
        offset: Int64
    ) throws -> Data? {
        let data = try readUpTo(count, from: descriptor, offset: offset)
        return data.count == count ? data : nil
    }

    private static func closeDescriptor(_ descriptor: Int32) {
        while Darwin.close(descriptor) != 0, errno == EINTR {}
    }

    private static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

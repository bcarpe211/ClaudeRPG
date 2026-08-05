import Darwin
import Foundation

public struct ZipArchiveSummary: Equatable, Sendable {
    public let entryCount: Int
    public let totalUncompressedSize: Int64

    public init(entryCount: Int, totalUncompressedSize: Int64) {
        self.entryCount = entryCount
        self.totalUncompressedSize = totalUncompressedSize
    }
}

public enum ZipArchiveValidationError: Error {
    case invalidArchive
}

public enum ZipArchiveValidator {
    public static let maximumEntryCount = 4_096
    public static let maximumUncompressedSize: Int64 = 256 * 1_024 * 1_024
    public static let applicationRoot = "Runtime Raiders Agent.app/"

    public static func validate(_ archive: URL) throws -> ZipArchiveSummary {
        let attributes = try FileManager.default.attributesOfItem(atPath: archive.path)
        guard let fileSize = attributes[.size] as? NSNumber,
              fileSize.int64Value <= ArtifactDownloader.maximumByteCount else {
            throw ZipArchiveValidationError.invalidArchive
        }
        let data = try Data(contentsOf: archive, options: [.mappedIfSafe])
        return try Parser(data: data).validate()
    }

    public static func validateExtractedTree(_ stagingDirectory: URL) throws {
        guard try fileType(at: stagingDirectory) == S_IFDIR else {
            throw ZipArchiveValidationError.invalidArchive
        }
        let children = try FileManager.default.contentsOfDirectory(
            at: stagingDirectory,
            includingPropertiesForKeys: nil,
            options: []
        )
        guard children.count == 1,
              children[0].lastPathComponent == String(applicationRoot.dropLast()),
              try fileType(at: children[0]) == S_IFDIR else {
            throw ZipArchiveValidationError.invalidArchive
        }
        try auditDirectory(children[0])
    }

    private static func auditDirectory(_ directory: URL) throws {
        for child in try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: []
        ) {
            let type = try fileType(at: child)
            if type == S_IFDIR {
                try auditDirectory(child)
            } else if type != S_IFREG {
                throw ZipArchiveValidationError.invalidArchive
            }
        }
    }

    private static func fileType(at url: URL) throws -> mode_t {
        var info = stat()
        let result = url.path.withCString { Darwin.lstat($0, &info) }
        guard result == 0 else { throw ZipArchiveValidationError.invalidArchive }
        return info.st_mode & S_IFMT
    }
}

private struct Parser {
    private let data: Data
    private let eocdLength = 22

    init(data: Data) {
        self.data = data
    }

    func validate() throws -> ZipArchiveSummary {
        guard data.count >= eocdLength else { throw invalid }
        let eocd = data.count - eocdLength
        guard try u32(eocd) == 0x06054b50,
              try u16(eocd + 4) == 0,
              try u16(eocd + 6) == 0,
              try u16(eocd + 20) == 0 else {
            throw invalid
        }
        let diskCount = try u16(eocd + 8)
        let totalCount = try u16(eocd + 10)
        let centralSize = try u32(eocd + 12)
        let centralOffset = try u32(eocd + 16)
        guard diskCount == totalCount,
              totalCount != UInt16.max,
              centralSize != UInt32.max,
              centralOffset != UInt32.max,
              totalCount > 0,
              totalCount <= ZipArchiveValidator.maximumEntryCount,
              add(Int(centralOffset), Int(centralSize)) == eocd else {
            throw invalid
        }

        var cursor = Int(centralOffset)
        var paths = Set<String>()
        var foldedPaths = Set<String>()
        var ranges: [Range<Int>] = []
        var totalSize: Int64 = 0
        var rootCount = 0

        for _ in 0..<Int(totalCount) {
            guard try u32(cursor) == 0x02014b50 else { throw invalid }
            let madeBy = try u16(cursor + 4)
            let needed = try u16(cursor + 6)
            let flags = try u16(cursor + 8)
            let method = try u16(cursor + 10)
            let crc = try u32(cursor + 16)
            let compressed = try u32(cursor + 20)
            let uncompressed = try u32(cursor + 24)
            let nameLength = Int(try u16(cursor + 28))
            let extraLength = Int(try u16(cursor + 30))
            let commentLength = Int(try u16(cursor + 32))
            let diskStart = try u16(cursor + 34)
            let externalAttributes = try u32(cursor + 38)
            let localOffset = try u32(cursor + 42)
            guard needed < 45,
                  flags == 0,
                  method == 0 || method == 8,
                  compressed != UInt32.max,
                  uncompressed != UInt32.max,
                  localOffset != UInt32.max,
                  diskStart == 0,
                  nameLength > 0,
                  commentLength == 0 else {
                throw invalid
            }
            let nameStart = try checked(cursor, plus: 46)
            let extraStart = try checked(nameStart, plus: nameLength)
            let next = try checked(extraStart, plus: extraLength + commentLength)
            guard next <= eocd, next <= Int(centralOffset) + Int(centralSize) else { throw invalid }
            try rejectZip64Extra(range: extraStart..<next)
            let nameBytes = data[nameStart..<extraStart]
            let path = try validatePath(nameBytes)
            guard paths.insert(path).inserted,
                  foldedPaths.insert(path.lowercased()).inserted else {
                throw invalid
            }

            let mode = mode_t(externalAttributes >> 16)
            let fileType = mode & S_IFMT
            guard madeBy >> 8 == 3,
                  mode & 0o7000 == 0,
                  (path.hasSuffix("/") ? fileType == S_IFDIR : fileType == S_IFREG) else {
                throw invalid
            }
            if method == 0, compressed != uncompressed { throw invalid }
            if path == ZipArchiveValidator.applicationRoot {
                rootCount += 1
            } else if !path.hasPrefix(ZipArchiveValidator.applicationRoot) {
                throw invalid
            }

            guard totalSize <= ZipArchiveValidator.maximumUncompressedSize - Int64(uncompressed) else {
                throw invalid
            }
            totalSize += Int64(uncompressed)
            let recordRange = try validateLocalHeader(
                offset: Int(localOffset),
                expectedName: nameBytes,
                flags: flags,
                method: method,
                crc: crc,
                compressed: compressed,
                uncompressed: uncompressed,
                centralOffset: Int(centralOffset)
            )
            ranges.append(recordRange)
            cursor = next
        }

        guard cursor == eocd,
              rootCount == 1,
              totalSize <= ZipArchiveValidator.maximumUncompressedSize else {
            throw invalid
        }
        let sorted = ranges.sorted { $0.lowerBound < $1.lowerBound }
        guard sorted.first?.lowerBound == 0,
              sorted.last?.upperBound == Int(centralOffset) else {
            throw invalid
        }
        for index in 1..<sorted.count {
            guard sorted[index - 1].upperBound == sorted[index].lowerBound else {
                throw invalid
            }
        }
        return ZipArchiveSummary(entryCount: Int(totalCount), totalUncompressedSize: totalSize)
    }

    private func validateLocalHeader(
        offset: Int,
        expectedName: Data.SubSequence,
        flags: UInt16,
        method: UInt16,
        crc: UInt32,
        compressed: UInt32,
        uncompressed: UInt32,
        centralOffset: Int
    ) throws -> Range<Int> {
        guard try u32(offset) == 0x04034b50,
              try u16(offset + 6) == flags,
              try u16(offset + 8) == method,
              try u32(offset + 14) == crc,
              try u32(offset + 18) == compressed,
              try u32(offset + 22) == uncompressed else {
            throw invalid
        }
        let nameLength = Int(try u16(offset + 26))
        let extraLength = Int(try u16(offset + 28))
        let nameStart = try checked(offset, plus: 30)
        let extraStart = try checked(nameStart, plus: nameLength)
        let dataStart = try checked(extraStart, plus: extraLength)
        let dataEnd = try checked(dataStart, plus: Int(compressed))
        guard dataEnd <= centralOffset,
              data[nameStart..<extraStart].elementsEqual(expectedName) else {
            throw invalid
        }
        try rejectZip64Extra(range: extraStart..<dataStart)
        return offset..<dataEnd
    }

    private func validatePath(_ bytes: Data.SubSequence) throws -> String {
        guard bytes.allSatisfy({ (0x20...0x7e).contains($0) && $0 != 0x5c }) else {
            throw invalid
        }
        let path = String(decoding: bytes, as: UTF8.self)
        guard !path.hasPrefix("/"), !path.isEmpty else { throw invalid }
        let withoutTrailingSlash = path.hasSuffix("/") ? String(path.dropLast()) : path
        let components = withoutTrailingSlash.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw invalid
        }
        return path
    }

    private func rejectZip64Extra(range: Range<Int>) throws {
        var cursor = range.lowerBound
        while cursor < range.upperBound {
            guard cursor + 4 <= range.upperBound else { throw invalid }
            let identifier = try u16(cursor)
            let length = Int(try u16(cursor + 2))
            cursor = try checked(cursor, plus: 4 + length)
            guard cursor <= range.upperBound, identifier != 0x0001 else { throw invalid }
        }
    }

    private func u16(_ offset: Int) throws -> UInt16 {
        guard offset >= 0, offset <= data.count - 2 else { throw invalid }
        return UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
    }

    private func u32(_ offset: Int) throws -> UInt32 {
        guard offset >= 0, offset <= data.count - 4 else { throw invalid }
        return UInt32(data[offset]) |
            UInt32(data[offset + 1]) << 8 |
            UInt32(data[offset + 2]) << 16 |
            UInt32(data[offset + 3]) << 24
    }

    private func checked(_ value: Int, plus addition: Int) throws -> Int {
        let (result, overflow) = value.addingReportingOverflow(addition)
        guard !overflow, result >= value, result <= data.count else { throw invalid }
        return result
    }

    private func add(_ lhs: Int, _ rhs: Int) -> Int? {
        let (result, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? nil : result
    }

    private var invalid: ZipArchiveValidationError { .invalidArchive }
}

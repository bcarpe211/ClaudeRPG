import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ZipArchiveValidatorTests: XCTestCase {
    func testAcceptsExactReleaseContainerWithAgentAndLauncherApplications() throws {
        try withArchive(entries: validEntries()) { archive in
            XCTAssertEqual(
                try ZipArchiveValidator.validate(archive),
                ZipArchiveSummary(entryCount: 5, totalUncompressedSize: 6)
            )
        }
    }

    func testAcceptsExactSignedDataDescriptorForm() throws {
        var entries = validEntries()
        entries[2] = ZipEntry(
                name: agentInfoPlist,
                flags: 0x0008,
                data: Data("abc".utf8)
            )
        try withArchive(entries: entries) { archive in
            XCTAssertEqual(
                try ZipArchiveValidator.validate(archive),
                ZipArchiveSummary(entryCount: 5, totalUncompressedSize: 6)
            )
        }
    }

    func testAcceptsArchiveCreatedByMacOSDitto() throws {
        let staging = temporaryURL(prefix: "rr-ditto-source")
        let archive = temporaryURL(prefix: "rr-ditto-archive").appendingPathExtension("zip")
        defer {
            try? FileManager.default.removeItem(at: staging)
            try? FileManager.default.removeItem(at: archive)
        }
        let release = staging.appendingPathComponent("Runtime Raiders Release", isDirectory: true)
        for applicationName in ["Runtime Raiders Agent.app", "Runtime Raiders Launcher.app"] {
            let contents = release
                .appendingPathComponent(applicationName, isDirectory: true)
                .appendingPathComponent("Contents", isDirectory: true)
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            try Data("plist".utf8).write(to: contents.appendingPathComponent("Info.plist"))
        }

        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = [
            "-c", "-k", "--sequesterRsrc", "--keepParent", release.path, archive.path,
        ]
        try ditto.run()
        ditto.waitUntilExit()
        XCTAssertEqual(ditto.terminationStatus, 0)

        XCTAssertEqual(
            try ZipArchiveValidator.validate(archive),
            ZipArchiveSummary(entryCount: 7, totalUncompressedSize: 10)
        )
    }

    func testRejectsUnsupportedGeneralPurposeFlagBitsAndCombinations() throws {
        for flags: UInt16 in [0x0001, 0x0002, 0x0004, 0x0009, 0x0800] {
            var entries = validEntries()
            entries[2] = ZipEntry(
                    name: agentInfoPlist,
                    flags: flags,
                    data: Data("abc".utf8)
                )
            try assertInvalid(entries: entries)
        }
    }

    func testRejectsDescriptorEntriesWithoutExactZeroLocalPlaceholders() throws {
        for placeholders in [
            (crc: UInt32(1), compressed: UInt32(0), uncompressed: UInt32(0)),
            (crc: UInt32(0), compressed: UInt32(1), uncompressed: UInt32(0)),
            (crc: UInt32(0), compressed: UInt32(0), uncompressed: UInt32(1)),
        ] {
            var entries = validEntries()
            entries[2] = ZipEntry(
                    name: agentInfoPlist,
                    flags: 0x0008,
                    data: Data("abc".utf8),
                    localCRC: placeholders.crc,
                    localCompressedSize: placeholders.compressed,
                    localUncompressedSize: placeholders.uncompressed
                )
            try assertInvalid(entries: entries)
        }
    }

    func testRejectsCentralAndLocalDescriptorFlagMismatch() throws {
        var centralDescriptor = validEntries()
        centralDescriptor[2] = ZipEntry(
                name: agentInfoPlist,
                flags: 0x0008,
                localFlags: 0,
                data: Data("abc".utf8)
            )
        try assertInvalid(entries: centralDescriptor)
        var localDescriptor = validEntries()
        localDescriptor[2] = ZipEntry(
                name: agentInfoPlist,
                flags: 0,
                localFlags: 0x0008,
                data: Data("abc".utf8)
            )
        try assertInvalid(entries: localDescriptor)
    }

    func testRejectsMissingTruncatedOrUnsignedDataDescriptors() throws {
        for descriptor in [
            Data(),
            Data(repeating: 0, count: 15),
            dataDescriptor(signature: nil, crc: 0, compressedSize: 3, uncompressedSize: 3),
        ] {
            var entries = validEntries()
            entries[2] = ZipEntry(
                    name: agentInfoPlist,
                    flags: 0x0008,
                    data: Data("abc".utf8),
                    dataDescriptor: descriptor
                )
            try assertInvalid(entries: entries)
        }
    }

    func testRejectsWrongSignatureAndMismatchedDescriptorValues() throws {
        for descriptor in [
            dataDescriptor(signature: 0x08074b51, crc: 0, compressedSize: 3, uncompressedSize: 3),
            dataDescriptor(signature: 0x08074b50, crc: 1, compressedSize: 3, uncompressedSize: 3),
            dataDescriptor(signature: 0x08074b50, crc: 0, compressedSize: 2, uncompressedSize: 3),
            dataDescriptor(signature: 0x08074b50, crc: 0, compressedSize: 3, uncompressedSize: 2),
        ] {
            var entries = validEntries()
            entries[2] = ZipEntry(
                    name: agentInfoPlist,
                    flags: 0x0008,
                    data: Data("abc".utf8),
                    dataDescriptor: descriptor
                )
            try assertInvalid(entries: entries)
        }
    }

    func testRejectsZip64LengthDataDescriptor() throws {
        var descriptor = dataDescriptor(
            signature: 0x08074b50,
            crc: 0,
            compressedSize: 3,
            uncompressedSize: 3
        )
        descriptor.append(Data(repeating: 0, count: 8))
        var entries = validEntries()
        entries[2] = ZipEntry(
                name: agentInfoPlist,
                flags: 0x0008,
                data: Data("abc".utf8),
                dataDescriptor: descriptor
            )
        try assertInvalid(entries: entries)
    }

    func testRejectsEitherMissingRequiredApplication() throws {
        try assertInvalid(entries: Array(validEntries()[0...0]) + Array(validEntries()[3...4]))
        try assertInvalid(entries: Array(validEntries()[0...2]))
    }

    func testRejectsAnyThirdTopLevelRootOrReleaseChild() throws {
        try assertInvalid(entries: validEntries() + [ZipEntry(name: "Other.app/", directory: true)])
        try assertInvalid(entries: validEntries() + [
            ZipEntry(name: "Runtime Raiders Release/Other.app/", directory: true),
        ])
    }

    func testRejectsUnsafePathForms() throws {
        let unsafeNames = [
            "/Runtime Raiders Release/Runtime Raiders Agent.app/file",
            "Runtime Raiders Release/Runtime Raiders Agent.app/../file",
            "Runtime Raiders Release/Runtime Raiders Agent.app/./file",
            "Runtime Raiders Release/Runtime Raiders Agent.app//file",
            "Runtime Raiders Release/Runtime Raiders Agent.app\\file",
            "Runtime Raiders Release/Runtime Raiders Agent.app/bad\u{7f}",
        ]
        for name in unsafeNames {
            try assertInvalid(entries: validEntries() + [ZipEntry(name: name, data: Data())])
        }
    }

    func testRejectsDuplicatePaths() throws {
        try assertInvalid(entries: validEntries() + [validEntries()[1]])
    }

    func testRejectsCaseInsensitiveCollidingPaths() throws {
        try assertInvalid(entries: validEntries() + [
            ZipEntry(name: "runtime raiders release/RUNTIME RAIDERS AGENT.APP/", directory: true),
        ])
    }

    func testRejectsArchiveFileLargerThanDownloadLimit() throws {
        let archive = temporaryURL(prefix: "rr-oversized-archive").appendingPathExtension("zip")
        defer { try? FileManager.default.removeItem(at: archive) }
        XCTAssertTrue(FileManager.default.createFile(atPath: archive.path, contents: nil))
        let handle = try FileHandle(forWritingTo: archive)
        try handle.truncate(atOffset: UInt64(ArtifactDownloader.maximumByteCount + 1))
        try handle.close()

        XCTAssertThrowsError(try ZipArchiveValidator.validate(archive))
    }

    func testRejectsNonASCIIPathBytesAndCentralLocalNameMismatch() throws {
        try assertInvalid(entries: [
            validEntries()[0], validEntries()[1], validEntries()[3], validEntries()[4],
            ZipEntry(nameBytes: Array("Runtime Raiders Release/Runtime Raiders Agent.app/caf".utf8) + [0xe9], data: Data()),
        ])
        try assertInvalid(entries: [
            validEntries()[0], validEntries()[1], validEntries()[3], validEntries()[4],
            ZipEntry(
                name: agentInfoPlist,
                localName: "Runtime Raiders Release/Runtime Raiders Agent.app/Contents/Other.plist",
                data: Data()
            ),
        ])
    }

    func testRejectsSymlinkAndSpecialFileUnixModes() throws {
        for mode in [UInt32(S_IFLNK | 0o777), UInt32(S_IFSOCK | 0o600), UInt32(S_IFCHR | 0o600)] {
            try assertInvalid(entries: [
                validEntries()[0], validEntries()[1], validEntries()[2], validEntries()[3], validEntries()[4],
                ZipEntry(
                    name: "Runtime Raiders Release/Runtime Raiders Agent.app/Contents/item",
                    data: Data(),
                    unixMode: mode
                ),
            ])
        }
    }

    func testRejectsGroupOrWorldWritableRegularFilesAndDirectories() throws {
        try assertInvalid(entries: [
            validEntries()[0], validEntries()[1], validEntries()[2], validEntries()[3], validEntries()[4],
            ZipEntry(
                name: "Runtime Raiders Release/Runtime Raiders Agent.app/Contents/writable",
                data: Data(),
                unixMode: UInt32(S_IFREG | 0o666)
            ),
        ])
        var writableDirectory = validEntries()
        writableDirectory[1] = ZipEntry(
                name: agentRoot,
                directory: true,
                unixMode: UInt32(S_IFDIR | 0o777)
            )
        try assertInvalid(entries: writableDirectory)
    }

    func testRejectsEncryptedUnsupportedCompressionAndMultiDiskArchives() throws {
        try assertInvalid(entries: validEntries() + [ZipEntry(
            name: "Runtime Raiders Release/Runtime Raiders Agent.app/file", flags: 1, data: Data()
        )])
        try assertInvalid(entries: validEntries() + [ZipEntry(
            name: "Runtime Raiders Release/Runtime Raiders Agent.app/file", method: 99, data: Data()
        )])
        try assertInvalid(entries: validEntries(), options: .init(diskNumber: 1))
    }

    func testRejectsZip64SentinelsInDirectoryAndEntries() throws {
        try assertInvalid(entries: validEntries(), options: .init(entryCount: UInt16.max))
        try assertInvalid(entries: validEntries() + [ZipEntry(
            name: "Runtime Raiders Release/Runtime Raiders Agent.app/file",
            data: Data(),
            centralCompressedSize: UInt32.max
        )])
    }

    func testRejectsTruncationTrailingGarbageAndInconsistentOrOverlappingOffsets() throws {
        let valid = ZipBuilder(entries: validEntries()).data()
        try withRawArchive(Data(valid.dropLast())) { XCTAssertThrowsError(try ZipArchiveValidator.validate($0)) }
        try withRawArchive(valid + Data([0])) { XCTAssertThrowsError(try ZipArchiveValidator.validate($0)) }
        try assertInvalid(entries: validEntries(), options: .init(centralDirectoryOffset: 0))
        var overlapping = validEntries()
        overlapping[2] = ZipEntry(
                name: agentInfoPlist,
                data: Data("abc".utf8),
                localHeaderOffset: 1
            )
        try assertInvalid(entries: overlapping)
        try assertInvalid(entries: validEntries(), options: .init(undeclaredBytesBeforeCentralDirectory: 1))
    }

    func testRejectsMoreThan4096Entries() throws {
        var entries = validEntries()
        for index in 0..<4_092 {
            entries.append(ZipEntry(
                name: "Runtime Raiders Release/Runtime Raiders Agent.app/Contents/file-\(index)",
                method: 8,
                data: Data()
            ))
        }
        try assertInvalid(entries: entries)
    }

    func testRejectsTotalUncompressedSizeAbove256MiB() throws {
        try assertInvalid(entries: [
            validEntries()[0], validEntries()[1], validEntries()[2], validEntries()[3], validEntries()[4],
            ZipEntry(
                name: "Runtime Raiders Release/Runtime Raiders Agent.app/Contents/one",
                method: 8,
                data: Data(),
                uncompressedSize: 134_217_729
            ),
            ZipEntry(
                name: "Runtime Raiders Release/Runtime Raiders Agent.app/Contents/two",
                method: 8,
                data: Data(),
                uncompressedSize: 134_217_728
            ),
        ])
    }

    func testExtractedTreeAuditRejectsSymlinksAndUnexpectedRoots() throws {
        let staging = temporaryURL(prefix: "rr-extracted-tree")
        defer { try? FileManager.default.removeItem(at: staging) }
        let release = staging.appendingPathComponent("Runtime Raiders Release", isDirectory: true)
        let agent = release.appendingPathComponent("Runtime Raiders Agent.app", isDirectory: true)
        let launcher = release.appendingPathComponent("Runtime Raiders Launcher.app", isDirectory: true)
        let agentContents = agent.appendingPathComponent("Contents", isDirectory: true)
        let launcherContents = launcher.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: agentContents, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: launcherContents, withIntermediateDirectories: true)
        try Data("agent".utf8).write(to: agentContents.appendingPathComponent("Info.plist"))
        try Data("launcher".utf8).write(to: launcherContents.appendingPathComponent("Info.plist"))

        XCTAssertNoThrow(try ZipArchiveValidator.validateExtractedTree(staging))

        try FileManager.default.removeItem(at: launcher)
        XCTAssertThrowsError(try ZipArchiveValidator.validateExtractedTree(staging))
        try FileManager.default.createDirectory(at: launcherContents, withIntermediateDirectories: true)
        try Data("launcher".utf8).write(to: launcherContents.appendingPathComponent("Info.plist"))

        let link = agentContents.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: "/private/tmp")
        XCTAssertThrowsError(try ZipArchiveValidator.validateExtractedTree(staging))
        try FileManager.default.removeItem(at: link)

        try Data().write(to: release.appendingPathComponent("extra"))
        XCTAssertThrowsError(try ZipArchiveValidator.validateExtractedTree(staging))
    }

    private func validEntries() -> [ZipEntry] {
        [
            ZipEntry(name: releaseRoot, directory: true),
            ZipEntry(name: agentRoot, directory: true),
            ZipEntry(name: agentInfoPlist, data: Data("abc".utf8)),
            ZipEntry(name: launcherRoot, directory: true),
            ZipEntry(name: launcherInfoPlist, data: Data("abc".utf8)),
        ]
    }

    private var releaseRoot: String { "Runtime Raiders Release/" }
    private var agentRoot: String { "Runtime Raiders Release/Runtime Raiders Agent.app/" }
    private var launcherRoot: String { "Runtime Raiders Release/Runtime Raiders Launcher.app/" }
    private var agentInfoPlist: String { "\(agentRoot)Contents/Info.plist" }
    private var launcherInfoPlist: String { "\(launcherRoot)Contents/Info.plist" }

    private func assertInvalid(
        entries: [ZipEntry],
        options: ZipOptions = .init(),
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        try withArchive(entries: entries, options: options) { archive in
            XCTAssertThrowsError(try ZipArchiveValidator.validate(archive), file: file, line: line)
        }
    }

    private func withArchive<T>(
        entries: [ZipEntry],
        options: ZipOptions = .init(),
        body: (URL) throws -> T
    ) throws -> T {
        try withRawArchive(ZipBuilder(entries: entries, options: options).data(), body: body)
    }

    private func withRawArchive<T>(_ data: Data, body: (URL) throws -> T) throws -> T {
        let archive = temporaryURL(prefix: "rr-zip-validator").appendingPathExtension("zip")
        try data.write(to: archive)
        defer { try? FileManager.default.removeItem(at: archive) }
        return try body(archive)
    }

    private func temporaryURL(prefix: String) -> URL {
        URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }

    private func dataDescriptor(
        signature: UInt32?,
        crc: UInt32,
        compressedSize: UInt32,
        uncompressedSize: UInt32
    ) -> Data {
        var data = Data()
        if let signature { data.appendLE(signature) }
        data.appendLE(crc)
        data.appendLE(compressedSize)
        data.appendLE(uncompressedSize)
        return data
    }
}

private struct ZipEntry {
    let nameBytes: [UInt8]
    let localNameBytes: [UInt8]
    let method: UInt16
    let flags: UInt16
    let localFlags: UInt16
    let data: Data
    let crc32: UInt32
    let uncompressedSize: UInt32
    let unixMode: UInt32
    let centralCompressedSize: UInt32?
    let localHeaderOffset: UInt32?
    let localCRC: UInt32
    let localCompressedSize: UInt32
    let localUncompressedSize: UInt32
    let dataDescriptor: Data?

    init(
        name: String,
        localName: String? = nil,
        method: UInt16 = 0,
        flags: UInt16 = 0,
        localFlags: UInt16? = nil,
        data: Data = Data(),
        crc32: UInt32 = 0,
        uncompressedSize: UInt32? = nil,
        directory: Bool = false,
        unixMode: UInt32? = nil,
        centralCompressedSize: UInt32? = nil,
        localHeaderOffset: UInt32? = nil,
        localCRC: UInt32? = nil,
        localCompressedSize: UInt32? = nil,
        localUncompressedSize: UInt32? = nil,
        dataDescriptor: Data? = nil
    ) {
        let resolvedUncompressedSize = uncompressedSize ?? UInt32(data.count)
        let resolvedCentralCompressedSize = centralCompressedSize ?? UInt32(data.count)
        let usesDataDescriptor = flags == 0x0008
        self.init(
            nameBytes: Array(name.utf8),
            localNameBytes: Array((localName ?? name).utf8),
            method: method,
            flags: flags,
            localFlags: localFlags ?? flags,
            data: data,
            crc32: crc32,
            uncompressedSize: resolvedUncompressedSize,
            unixMode: unixMode ?? UInt32((directory ? S_IFDIR | 0o755 : S_IFREG | 0o644)),
            centralCompressedSize: centralCompressedSize,
            localHeaderOffset: localHeaderOffset,
            localCRC: localCRC ?? (usesDataDescriptor ? 0 : crc32),
            localCompressedSize: localCompressedSize ?? (usesDataDescriptor ? 0 : UInt32(data.count)),
            localUncompressedSize: localUncompressedSize ?? (usesDataDescriptor ? 0 : resolvedUncompressedSize),
            dataDescriptor: dataDescriptor ?? (usesDataDescriptor ? Self.dataDescriptor(
                crc: crc32,
                compressedSize: resolvedCentralCompressedSize,
                uncompressedSize: resolvedUncompressedSize
            ) : nil)
        )
    }

    init(nameBytes: [UInt8], data: Data) {
        self.init(
            nameBytes: nameBytes,
            localNameBytes: nameBytes,
            method: 0,
            flags: 0,
            localFlags: 0,
            data: data,
            crc32: 0,
            uncompressedSize: UInt32(data.count),
            unixMode: UInt32(S_IFREG | 0o644),
            centralCompressedSize: nil,
            localHeaderOffset: nil,
            localCRC: 0,
            localCompressedSize: UInt32(data.count),
            localUncompressedSize: UInt32(data.count),
            dataDescriptor: nil
        )
    }

    private init(
        nameBytes: [UInt8],
        localNameBytes: [UInt8],
        method: UInt16,
        flags: UInt16,
        localFlags: UInt16,
        data: Data,
        crc32: UInt32,
        uncompressedSize: UInt32,
        unixMode: UInt32,
        centralCompressedSize: UInt32?,
        localHeaderOffset: UInt32?,
        localCRC: UInt32,
        localCompressedSize: UInt32,
        localUncompressedSize: UInt32,
        dataDescriptor: Data?
    ) {
        self.nameBytes = nameBytes
        self.localNameBytes = localNameBytes
        self.method = method
        self.flags = flags
        self.localFlags = localFlags
        self.data = data
        self.crc32 = crc32
        self.uncompressedSize = uncompressedSize
        self.unixMode = unixMode
        self.centralCompressedSize = centralCompressedSize
        self.localHeaderOffset = localHeaderOffset
        self.localCRC = localCRC
        self.localCompressedSize = localCompressedSize
        self.localUncompressedSize = localUncompressedSize
        self.dataDescriptor = dataDescriptor
    }

    private static func dataDescriptor(
        crc: UInt32,
        compressedSize: UInt32,
        uncompressedSize: UInt32
    ) -> Data {
        var data = Data()
        data.appendLE(UInt32(0x08074b50))
        data.appendLE(crc)
        data.appendLE(compressedSize)
        data.appendLE(uncompressedSize)
        return data
    }
}

private struct ZipOptions {
    var diskNumber: UInt16 = 0
    var entryCount: UInt16?
    var centralDirectoryOffset: UInt32?
    var undeclaredBytesBeforeCentralDirectory = 0
}

private struct ZipBuilder {
    let entries: [ZipEntry]
    var options = ZipOptions()

    func data() -> Data {
        var archive = Data()
        var actualOffsets: [UInt32] = []
        for entry in entries {
            actualOffsets.append(UInt32(archive.count))
            archive.appendLE(UInt32(0x04034b50))
            archive.appendLE(UInt16(20))
            archive.appendLE(entry.localFlags)
            archive.appendLE(entry.method)
            archive.appendLE(UInt16(0))
            archive.appendLE(UInt16(0))
            archive.appendLE(entry.localCRC)
            archive.appendLE(entry.localCompressedSize)
            archive.appendLE(entry.localUncompressedSize)
            archive.appendLE(UInt16(entry.localNameBytes.count))
            archive.appendLE(UInt16(0))
            archive.append(contentsOf: entry.localNameBytes)
            archive.append(entry.data)
            if let dataDescriptor = entry.dataDescriptor {
                archive.append(dataDescriptor)
            }
        }

        archive.append(Data(repeating: 0xa5, count: options.undeclaredBytesBeforeCentralDirectory))

        let centralOffset = UInt32(archive.count)
        for (index, entry) in entries.enumerated() {
            archive.appendLE(UInt32(0x02014b50))
            archive.appendLE(UInt16(0x0314))
            archive.appendLE(UInt16(20))
            archive.appendLE(entry.flags)
            archive.appendLE(entry.method)
            archive.appendLE(UInt16(0))
            archive.appendLE(UInt16(0))
            archive.appendLE(entry.crc32)
            archive.appendLE(entry.centralCompressedSize ?? UInt32(entry.data.count))
            archive.appendLE(entry.uncompressedSize)
            archive.appendLE(UInt16(entry.nameBytes.count))
            archive.appendLE(UInt16(0))
            archive.appendLE(UInt16(0))
            archive.appendLE(UInt16(0))
            archive.appendLE(UInt16(0))
            archive.appendLE(entry.unixMode << 16)
            archive.appendLE(entry.localHeaderOffset ?? actualOffsets[index])
            archive.append(contentsOf: entry.nameBytes)
        }
        let centralSize = UInt32(archive.count) - centralOffset
        let count = options.entryCount ?? UInt16(entries.count)
        archive.appendLE(UInt32(0x06054b50))
        archive.appendLE(options.diskNumber)
        archive.appendLE(UInt16(0))
        archive.appendLE(count)
        archive.appendLE(count)
        archive.appendLE(centralSize)
        archive.appendLE(options.centralDirectoryOffset ?? centralOffset)
        archive.appendLE(UInt16(0))
        return archive
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

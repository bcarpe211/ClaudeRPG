import Darwin
import Foundation

/// The deliberately narrow exception for the single sequence-8 canary whose
/// legacy installer put `raiders` inside Homebrew's libpq keg. This is not a
/// general command-path policy and must never be used to select a destination.
public struct SequenceEightCanaryCommandLink {
    public enum RetirementFault: CaseIterable, Sendable {
        case beforeUnlink
        case afterUnlinkBeforeSync
    }

    public struct Proof: Equatable, Sendable {
        fileprivate let expectedShim: String
        fileprivate let commandDevice: dev_t
        fileprivate let commandInode: ino_t
        fileprivate let commandUID: uid_t
        fileprivate let commandGID: gid_t
    }

    private enum ValidationError: Error {
        case invalidLayout
    }

    private static let recordedPath = "/opt/homebrew/opt/libpq/bin/raiders"
    private static let optTarget = "../Cellar/libpq/18.4"
    private static let physicalBin = "/opt/homebrew/Cellar/libpq/18.4/bin"

    private let filesystemRoot: URL
    private let expectedRootUID: uid_t
    private let expectedHomebrewUID: uid_t
    private let retirementFault: (RetirementFault) throws -> Void

    private struct LayoutContext {
        let bin: URL
        let homebrewGID: gid_t
    }

    public init() {
        self.init(
            filesystemRoot: URL(fileURLWithPath: "/", isDirectory: true),
            expectedRootUID: 0,
            expectedHomebrewUID: Darwin.geteuid(),
            retirementFault: { _ in }
        )
    }

    init(
        filesystemRoot: URL,
        expectedRootUID: uid_t,
        expectedHomebrewUID: uid_t,
        retirementFault: @escaping (RetirementFault) throws -> Void = { _ in }
    ) {
        self.filesystemRoot = filesystemRoot.standardizedFileURL
        self.expectedRootUID = expectedRootUID
        self.expectedHomebrewUID = expectedHomebrewUID
        self.retirementFault = retirementFault
    }

    public func validate(recordedCommandPath: String, expectedShim: URL) throws -> Proof {
        guard recordedCommandPath == Self.recordedPath,
              expectedShim.isFileURL,
              expectedShim.path.hasPrefix("/"),
              !expectedShim.path.contains("\n") else {
            throw ValidationError.invalidLayout
        }

        let context = try validateContext(expectedShim: expectedShim)
        let command = context.bin.appendingPathComponent("raiders", isDirectory: false)
        let commandMetadata = try requireSymlink(
            command,
            uid: expectedHomebrewUID,
            gid: context.homebrewGID,
            target: expectedShim.path
        )
        return Proof(
            expectedShim: expectedShim.path,
            commandDevice: commandMetadata.st_dev,
            commandInode: commandMetadata.st_ino,
            commandUID: commandMetadata.st_uid,
            commandGID: commandMetadata.st_gid
        )
    }

    public func validate(commandRecord: URL, expectedShim: URL) throws -> Proof {
        try validate(
            recordedCommandPath: readCommandRecord(commandRecord),
            expectedShim: expectedShim
        )
    }

    /// Idempotent only for the exact already-retired leaf. Every parent and
    /// the archived command record are still revalidated on retry.
    public func retireIfPresent(commandRecord: URL, expectedShim: URL) throws {
        let recorded = try readCommandRecord(commandRecord)
        guard recorded == Self.recordedPath else { throw ValidationError.invalidLayout }
        let context = try validateContext(expectedShim: expectedShim)
        let command = context.bin.appendingPathComponent("raiders", isDirectory: false)
        var metadata = stat()
        if command.path.withCString({ Darwin.lstat($0, &metadata) }) != 0 {
            guard errno == ENOENT else { throw ValidationError.invalidLayout }
            return
        }
        let proof = try validate(recordedCommandPath: recorded, expectedShim: expectedShim)
        try retire(proof)
    }

    private func readCommandRecord(_ commandRecord: URL) throws -> String {
        var metadata = stat()
        guard commandRecord.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o7777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size >= 2,
              metadata.st_size <= 4_096 else {
            throw ValidationError.invalidLayout
        }
        let descriptor = commandRecord.path.withCString {
            Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else { throw ValidationError.invalidLayout }
        defer { Darwin.close(descriptor) }
        var opened = stat()
        guard Darwin.fstat(descriptor, &opened) == 0,
              opened.st_dev == metadata.st_dev,
              opened.st_ino == metadata.st_ino,
              opened.st_mode == metadata.st_mode,
              opened.st_uid == metadata.st_uid,
              opened.st_nlink == metadata.st_nlink,
              opened.st_size == metadata.st_size else {
            throw ValidationError.invalidLayout
        }
        var data = Data(count: Int(opened.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { throw ValidationError.invalidLayout }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw ValidationError.invalidLayout }
            }
        }
        guard data.last == 0x0A,
              !data.dropLast().contains(where: { $0 < 0x20 || $0 == 0x7F }),
              let recorded = String(data: data.dropLast(), encoding: .utf8) else {
            throw ValidationError.invalidLayout
        }
        return recorded
    }

    /// Removes only the previously proven leaf. A post-unlink failure restores
    /// the identical symlink before returning an error.
    public func retire(_ proof: Proof) throws {
        let current = try validate(
            recordedCommandPath: Self.recordedPath,
            expectedShim: URL(fileURLWithPath: proof.expectedShim, isDirectory: false)
        )
        guard current == proof else { throw ValidationError.invalidLayout }

        let bin = mapped(Self.physicalBin)
        let descriptor = bin.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else { throw ValidationError.invalidLayout }
        defer { Darwin.close(descriptor) }
        try requireDirectoryDescriptor(descriptor, matching: bin)

        var leaf = stat()
        guard Darwin.fstatat(descriptor, "raiders", &leaf, AT_SYMLINK_NOFOLLOW) == 0,
              leaf.st_mode & S_IFMT == S_IFLNK,
              leaf.st_dev == proof.commandDevice,
              leaf.st_ino == proof.commandInode,
              leaf.st_uid == proof.commandUID,
              leaf.st_gid == proof.commandGID,
              try readLink(at: descriptor, name: "raiders") == proof.expectedShim else {
            throw ValidationError.invalidLayout
        }

        try retirementFault(.beforeUnlink)
        guard Darwin.unlinkat(descriptor, "raiders", 0) == 0 else {
            throw ValidationError.invalidLayout
        }
        do {
            try retirementFault(.afterUnlinkBeforeSync)
            guard Darwin.fsync(descriptor) == 0 else { throw ValidationError.invalidLayout }
        } catch {
            let restored = proof.expectedShim.withCString { target in
                Darwin.symlinkat(target, descriptor, "raiders")
            }
            guard restored == 0, Darwin.fsync(descriptor) == 0 else {
                throw ValidationError.invalidLayout
            }
            throw error
        }
    }

    private func mapped(_ absolutePath: String) -> URL {
        if filesystemRoot.path == "/" {
            return URL(fileURLWithPath: absolutePath, isDirectory: false)
        }
        return filesystemRoot.appendingPathComponent(
            String(absolutePath.dropFirst()),
            isDirectory: false
        )
    }

    private func validateContext(expectedShim: URL) throws -> LayoutContext {
        let opt = mapped("/opt")
        let homebrew = mapped("/opt/homebrew")
        let homebrewOpt = mapped("/opt/homebrew/opt")
        let optLink = mapped("/opt/homebrew/opt/libpq")
        let cellar = mapped("/opt/homebrew/Cellar")
        let libpq = mapped("/opt/homebrew/Cellar/libpq")
        let version = mapped("/opt/homebrew/Cellar/libpq/18.4")
        let bin = mapped(Self.physicalBin)

        _ = try requireDirectory(opt, uid: expectedRootUID, gid: nil, mode: 0o755)
        let homebrewMetadata = try requireDirectory(
            homebrew,
            uid: expectedHomebrewUID,
            gid: nil,
            mode: 0o755
        )
        let homebrewGID = homebrewMetadata.st_gid
        _ = try requireDirectory(homebrewOpt, uid: expectedHomebrewUID, gid: homebrewGID, mode: 0o775)
        try requireSymlink(
            optLink,
            uid: expectedHomebrewUID,
            gid: homebrewGID,
            target: Self.optTarget
        )
        _ = try requireDirectory(cellar, uid: expectedHomebrewUID, gid: homebrewGID, mode: 0o775)
        _ = try requireDirectory(libpq, uid: expectedHomebrewUID, gid: homebrewGID, mode: 0o755)
        _ = try requireDirectory(version, uid: expectedHomebrewUID, gid: homebrewGID, mode: 0o755)
        _ = try requireDirectory(bin, uid: expectedHomebrewUID, gid: homebrewGID, mode: 0o755)
        _ = try requireRegularFile(expectedShim, uid: expectedHomebrewUID, mode: 0o700)
        return LayoutContext(bin: bin, homebrewGID: homebrewGID)
    }

    private func requireDirectory(
        _ url: URL,
        uid: uid_t,
        gid: gid_t?,
        mode: mode_t
    ) throws -> stat {
        let metadata = try metadata(at: url)
        guard metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == uid,
              gid.map({ metadata.st_gid == $0 }) ?? true,
              metadata.st_mode & 0o7777 == mode else {
            throw ValidationError.invalidLayout
        }
        return metadata
    }

    private func requireRegularFile(_ url: URL, uid: uid_t, mode: mode_t) throws -> stat {
        let metadata = try metadata(at: url)
        guard metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == uid,
              metadata.st_mode & 0o7777 == mode,
              metadata.st_nlink == 1 else {
            throw ValidationError.invalidLayout
        }
        return metadata
    }

    @discardableResult
    private func requireSymlink(
        _ url: URL,
        uid: uid_t,
        gid: gid_t,
        target: String
    ) throws -> stat {
        let metadata = try metadata(at: url)
        guard metadata.st_mode & S_IFMT == S_IFLNK,
              metadata.st_uid == uid,
              metadata.st_gid == gid,
              metadata.st_nlink == 1,
              try FileManager.default.destinationOfSymbolicLink(atPath: url.path) == target else {
            throw ValidationError.invalidLayout
        }
        return metadata
    }

    private func metadata(at url: URL) throws -> stat {
        var metadata = stat()
        guard url.path.withCString({ Darwin.lstat($0, &metadata) }) == 0 else {
            throw ValidationError.invalidLayout
        }
        return metadata
    }

    private func requireDirectoryDescriptor(_ descriptor: Int32, matching url: URL) throws {
        var opened = stat()
        let expected = try metadata(at: url)
        guard Darwin.fstat(descriptor, &opened) == 0,
              opened.st_mode & S_IFMT == S_IFDIR,
              opened.st_dev == expected.st_dev,
              opened.st_ino == expected.st_ino,
              opened.st_uid == expected.st_uid,
              opened.st_gid == expected.st_gid,
              opened.st_mode & 0o7777 == expected.st_mode & 0o7777 else {
            throw ValidationError.invalidLayout
        }
    }

    private func readLink(at descriptor: Int32, name: String) throws -> String {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
        let limit = Int(PATH_MAX)
        let length = name.withCString { Darwin.readlinkat(descriptor, $0, &buffer, limit) }
        guard length > 0, length < limit else { throw ValidationError.invalidLayout }
        return String(decoding: buffer[..<Int(length)].map {
            UInt8(bitPattern: $0)
        }, as: UTF8.self)
    }
}

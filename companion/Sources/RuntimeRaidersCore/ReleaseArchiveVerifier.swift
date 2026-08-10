import CryptoKit
import Darwin
import Foundation

public struct VerifiedReleaseAgent: Equatable, Sendable {
    public let application: URL
    public let identity: ReleaseReference

    public init(application: URL, identity: ReleaseReference) {
        self.application = application
        self.identity = identity
    }
}

public struct VerifiedReleaseArchive: Equatable, Sendable {
    public let agent: VerifiedReleaseAgent
    public let launcher: URL

    public init(agent: VerifiedReleaseAgent, launcher: URL) {
        self.agent = agent
        self.launcher = launcher
    }
}

public enum ReleaseArchiveVerificationError: Error, Equatable {
    case untrustedArchive
}

public struct ReleaseArchiveVerifier {
    private let signatureInspector: (URL) throws -> CandidateSignatureFacts
    private let agentIdentityLoader: (URL) throws -> CompanionReleaseIdentity
    private let launcherProtocolLoader: (URL) throws -> Int

    public init() {
        signatureInspector = { try SignedBundleTrustInspector().inspect(candidate: $0) }
        agentIdentityLoader = { application in
            guard let bundle = Bundle(url: application) else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
            return try CompanionReleaseIdentity.load(from: bundle)
        }
        launcherProtocolLoader = { application in
            try Self.loadLauncherProtocol(from: application)
        }
    }

    init(
        signatureInspector: @escaping (URL) throws -> CandidateSignatureFacts,
        agentIdentityLoader: @escaping (URL) throws -> CompanionReleaseIdentity,
        launcherProtocolLoader: @escaping (URL) throws -> Int
    ) {
        self.signatureInspector = signatureInspector
        self.agentIdentityLoader = agentIdentityLoader
        self.launcherProtocolLoader = launcherProtocolLoader
    }

    public func verify(
        extractedRoot: URL,
        manifest: ReleaseManifestV1,
        installed: CompanionReleaseIdentity,
        installedTeamIdentifier: String
    ) throws -> VerifiedReleaseArchive {
        do {
            try ZipArchiveValidator.validateExtractedTree(extractedRoot)
            guard manifest.updateProtocolVersion == 2,
                  installed.updateProtocolVersion == 2,
                  manifest.releaseSequence > installed.releaseSequence else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }

            let release = extractedRoot.appendingPathComponent(
                String(ZipArchiveValidator.releaseRoot.dropLast()),
                isDirectory: true
            )
            let agent = extractedRoot.appendingPathComponent(
                String(ZipArchiveValidator.agentApplicationRoot.dropLast()),
                isDirectory: true
            )
            let launcher = extractedRoot.appendingPathComponent(
                String(ZipArchiveValidator.launcherApplicationRoot.dropLast()),
                isDirectory: true
            )
            guard agent.deletingLastPathComponent() == release,
                  launcher.deletingLastPathComponent() == release else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
            let agentSeal = try ReleaseApplicationSeal.capture(agent)
            let launcherSeal = try ReleaseApplicationSeal.capture(launcher)

            let agentFacts = try signatureInspector(agent)
            let launcherFacts = try signatureInspector(launcher)
            guard trusted(
                agentFacts,
                bundleIdentifier: "com.redlattice.runtime-raiders-agent",
                teamIdentifier: installedTeamIdentifier
            ), trusted(
                launcherFacts,
                bundleIdentifier: "com.redlattice.runtime-raiders-launcher",
                teamIdentifier: installedTeamIdentifier
            ) else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }

            let identity = try agentIdentityLoader(agent)
            guard identity.releaseSequence == manifest.releaseSequence,
                  identity.releaseSHA == manifest.releaseSHA,
                  identity.companionVersion == manifest.companionVersion,
                  identity.updateProtocolVersion == manifest.updateProtocolVersion,
                  try launcherProtocolLoader(launcher) == 1 else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
            let reference = try identity.releaseReference()

            try ZipArchiveValidator.validateExtractedTree(extractedRoot)
            guard try ReleaseApplicationSeal.capture(agent) == agentSeal,
                  try ReleaseApplicationSeal.capture(launcher) == launcherSeal else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
            return VerifiedReleaseArchive(
                agent: VerifiedReleaseAgent(application: agent, identity: reference),
                launcher: launcher
            )
        } catch {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
    }

    public func verifyPackagedLauncher(
        _ launcher: URL,
        installedTeamIdentifier: String
    ) throws {
        do {
            let facts = try signatureInspector(launcher)
            guard trusted(
                facts,
                bundleIdentifier: "com.redlattice.runtime-raiders-launcher",
                teamIdentifier: installedTeamIdentifier
            ), try launcherProtocolLoader(launcher) == 1 else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
        } catch {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
    }

    private func trusted(
        _ facts: CandidateSignatureFacts,
        bundleIdentifier: String,
        teamIdentifier: String
    ) -> Bool {
        facts.bundleIdentifier == bundleIdentifier &&
            facts.teamIdentifier == teamIdentifier &&
            facts.signatureValid &&
            facts.allArchitecturesValid &&
            facts.hardenedRuntime &&
            facts.secureTimestampPresent &&
            facts.gatekeeperNotarized
    }

    private static func loadLauncherProtocol(from application: URL) throws -> Int {
        let infoURL = application.appendingPathComponent("Contents/Info.plist", isDirectory: false)
        let data = try Data(contentsOf: infoURL)
        guard data.count <= ReleaseFilesystem.maximumRecordBytes,
              let dictionary = try PropertyListSerialization.propertyList(
                  from: data,
                  options: [],
                  format: nil
              ) as? [String: Any],
              let protocolVersion = ReleaseContractValidation.positiveSafeInteger(
                  dictionary["RuntimeRaidersLauncherProtocolVersion"]
              ) else {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
        return Int(protocolVersion)
    }
}

private struct ReleaseApplicationSeal: Equatable {
    private struct Entry: Equatable {
        let path: String
        let kind: UInt16
        let device: UInt64
        let inode: UInt64
        let mode: UInt16
        let owner: UInt32
        let group: UInt32
        let linkCount: UInt64
        let size: Int64
        let modifiedSeconds: Int64
        let modifiedNanoseconds: Int64
        let contentSHA256: Data
    }

    private let entries: [Entry]

    static func capture(_ application: URL) throws -> Self {
        let descriptor = application.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else { throw ReleaseArchiveVerificationError.untrustedArchive }
        defer { Darwin.close(descriptor) }
        var entries: [Entry] = []
        try captureDirectory(descriptor, relativePath: ".", entries: &entries)
        return Self(entries: entries.sorted { $0.path < $1.path })
    }

    private static func captureDirectory(
        _ descriptor: Int32,
        relativePath: String,
        entries: inout [Entry]
    ) throws {
        var initial = stat()
        guard Darwin.fstat(descriptor, &initial) == 0,
              initial.st_mode & S_IFMT == S_IFDIR,
              initial.st_uid == Darwin.geteuid(),
              initial.st_mode & 0o022 == 0 else {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
        entries.append(entry(relativePath, initial, contentSHA256: Data()))

        for name in try directoryNames(descriptor) {
            var metadata = stat()
            guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_uid == Darwin.geteuid(),
                  metadata.st_mode & 0o022 == 0 else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
            let type = metadata.st_mode & S_IFMT
            let path = relativePath == "." ? name : relativePath + "/" + name
            if type == S_IFDIR {
                let child = Darwin.openat(
                    descriptor,
                    name,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
                guard child >= 0 else {
                    throw ReleaseArchiveVerificationError.untrustedArchive
                }
                defer { Darwin.close(child) }
                try captureDirectory(child, relativePath: path, entries: &entries)
            } else if type == S_IFREG, metadata.st_nlink == 1 {
                let file = Darwin.openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                guard file >= 0 else {
                    throw ReleaseArchiveVerificationError.untrustedArchive
                }
                defer { Darwin.close(file) }
                entries.append(try captureFile(file, relativePath: path, expected: metadata))
            } else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
        }

        var current = stat()
        guard Darwin.fstat(descriptor, &current) == 0,
              sameMetadata(current, initial) else {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
    }

    private static func captureFile(
        _ descriptor: Int32,
        relativePath: String,
        expected: stat
    ) throws -> Entry {
        guard expected.st_mode & S_IFMT == S_IFREG,
              expected.st_uid == Darwin.geteuid(),
              expected.st_mode & 0o022 == 0,
              expected.st_nlink == 1,
              expected.st_size >= 0 else {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
        var total: Int64 = 0
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count > 0 {
                hasher.update(data: Data(buffer[0..<count]))
                let (next, overflow) = total.addingReportingOverflow(Int64(count))
                guard !overflow else {
                    throw ReleaseArchiveVerificationError.untrustedArchive
                }
                total = next
            } else if count == 0 {
                break
            } else if errno == EINTR {
                continue
            } else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
        }
        var current = stat()
        guard Darwin.fstat(descriptor, &current) == 0,
              sameMetadata(current, expected),
              total == expected.st_size else {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
        return entry(relativePath, current, contentSHA256: Data(hasher.finalize()))
    }

    private static func sameMetadata(_ lhs: stat, _ rhs: stat) -> Bool {
        lhs.st_mode == rhs.st_mode &&
            lhs.st_uid == rhs.st_uid &&
            lhs.st_gid == rhs.st_gid &&
            lhs.st_nlink == rhs.st_nlink &&
            lhs.st_dev == rhs.st_dev &&
            lhs.st_ino == rhs.st_ino &&
            lhs.st_size == rhs.st_size &&
            lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec &&
            lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec
    }

    private static func entry(
        _ path: String,
        _ metadata: stat,
        contentSHA256: Data
    ) -> Entry {
        Entry(
            path: path,
            kind: UInt16(metadata.st_mode & S_IFMT),
            device: UInt64(metadata.st_dev),
            inode: UInt64(metadata.st_ino),
            mode: UInt16(metadata.st_mode & 0o7777),
            owner: UInt32(metadata.st_uid),
            group: UInt32(metadata.st_gid),
            linkCount: UInt64(metadata.st_nlink),
            size: Int64(metadata.st_size),
            modifiedSeconds: Int64(metadata.st_mtimespec.tv_sec),
            modifiedNanoseconds: Int64(metadata.st_mtimespec.tv_nsec),
            contentSHA256: contentSHA256
        )
    }

    private static func directoryNames(_ descriptor: Int32) throws -> [String] {
        let duplicate = Darwin.openat(
            descriptor,
            ".",
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard duplicate >= 0, let stream = Darwin.fdopendir(duplicate) else {
            if duplicate >= 0 { Darwin.close(duplicate) }
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
        defer { Darwin.closedir(stream) }
        var names: [String] = []
        while let item = Darwin.readdir(stream) {
            let name = withUnsafePointer(to: &item.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            if name != "." && name != ".." { names.append(name) }
        }
        return names.sorted()
    }
}

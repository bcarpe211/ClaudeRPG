import Darwin
import Foundation

enum VersionedReleaseTransactionFault: Hashable {
    case journalWrite
    case workspaceCleanup
    case beforePromotion
    case afterPromotion
    case beforeStateReplacement
    case afterStateReplacement
}

public final class VersionedReleaseTransaction {
    public let workspaceDirectory: URL
    public let stagingDirectory: URL
    public let archive: URL

    private let paths: AgentPaths
    private let stateStore: ReleaseStateStore
    private let priorSelection: ReleaseStateV1
    private let fault: (VersionedReleaseTransactionFault) throws -> Void
    private var candidate: ReleaseReference?

    public convenience init(paths: AgentPaths) throws {
        try self.init(paths: paths, fault: { _ in })
    }

    init(
        paths: AgentPaths,
        fault: @escaping (VersionedReleaseTransactionFault) throws -> Void
    ) throws {
        self.paths = paths
        self.fault = fault
        stateStore = try ReleaseStateStore(paths: paths)
        priorSelection = try stateStore.load()
        guard ReleaseStateV1.isValid(priorSelection) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }

        let support = try OwnerOnlyDirectory.openOrCreate(paths.supportDirectory)
        defer { Darwin.close(support) }
        let name = "update-\(UUID().uuidString.lowercased())"
        guard Darwin.mkdirat(support, name, mode_t(0o700)) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        workspaceDirectory = paths.supportDirectory.appendingPathComponent(name, isDirectory: true)
        stagingDirectory = workspaceDirectory.appendingPathComponent("staging", isDirectory: true)
        archive = workspaceDirectory.appendingPathComponent("candidate.zip", isDirectory: false)
        do {
            try Self.makeOwnerOnlyDirectory(stagingDirectory)
            try Self.synchronize(support)
        } catch {
            try? FileManager.default.removeItem(at: workspaceDirectory)
            throw error
        }
    }

    public func promoteVerifiedCandidate(_ verified: VerifiedReleaseArchive) throws -> ReleaseReference {
        let release = verified.agent.identity
        guard ReleaseReference.isValid(release),
              verified.agent.application.standardizedFileURL == expectedAgentApplication.standardizedFileURL,
              verified.launcher.standardizedFileURL == expectedLauncherApplication.standardizedFileURL,
              try stateStore.load() == priorSelection else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        try fault(.beforePromotion)

        let releases = try OwnerOnlyDirectory.openOrCreate(paths.releasesDirectory)
        defer { Darwin.close(releases) }
        let finalName = try paths.releaseDirectory(for: release).lastPathComponent
        try Self.requireMissing(parent: releases, name: finalName)

        let temporaryName = ".promoting-\(UUID().uuidString.lowercased())"
        guard Darwin.mkdirat(releases, temporaryName, mode_t(0o700)) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        var temporaryExists = true
        defer {
            if temporaryExists { _ = Darwin.unlinkat(releases, temporaryName, AT_REMOVEDIR) }
        }
        let temporary = Darwin.openat(
            releases,
            temporaryName,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard temporary >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(temporary) }

        let releaseRoot = expectedAgentApplication.deletingLastPathComponent()
        let releaseRootDescriptor = releaseRoot.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard releaseRootDescriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(releaseRootDescriptor) }
        try Self.requireOwnedDirectory(releaseRootDescriptor)
        try Self.requireOwnedApplication(verified.agent.application)
        guard (try? verified.verifiesAgentPromotion(at: verified.agent.application)) == true else {
            throw CompanionUpdaterError.unsafeFilesystem
        }

        let appName = "Runtime Raiders Agent.app"
        guard Darwin.renameat(
            releaseRootDescriptor,
            appName,
            temporary,
            appName
        ) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        try Self.synchronizeTree(
            parent: temporary,
            name: appName
        )
        try Self.synchronize(temporary)
        guard Darwin.renameat(releases, temporaryName, releases, finalName) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        temporaryExists = false
        try Self.synchronize(releases)
        guard try Self.isOwnedDirectory(try paths.releaseDirectory(for: release)),
              try Self.isOwnedDirectory(try paths.application(for: release)) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        guard (try? verified.verifiesAgentPromotion(
            at: try paths.application(for: release)
        )) == true else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        candidate = release
        try fault(.afterPromotion)
        journalBestEffort(phase: "promoted", state: priorSelection, candidate: release)
        return release
    }

    public func recordTrial(_ candidate: ReleaseReference) throws -> ReleaseStateV1 {
        guard self.candidate == candidate,
              FileManager.default.fileExists(atPath: try paths.application(for: candidate).path) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        let current = try stateStore.load()
        guard current == priorSelection,
              current.trial == nil,
              candidate.releaseSequence > current.active.releaseSequence else {
            throw CompanionUpdaterError.invalidStatus
        }
        let next = ReleaseStateV1(
            schemaVersion: 1,
            generation: try nextGeneration(after: current.generation),
            active: current.active,
            fallback: current.fallback,
            trial: candidate
        )
        try replace(current: current, with: next)
        journalBestEffort(phase: "trial", state: next, candidate: candidate)
        return next
    }

    public func commitTrial(expectedGeneration: Int64) throws -> ReleaseStateV1 {
        let current = try stateStore.load()
        guard current.generation == expectedGeneration,
              let trial = current.trial,
              trial == candidate,
              current.active == priorSelection.active,
              current.fallback == priorSelection.fallback else {
            throw CompanionUpdaterError.invalidStatus
        }
        let next = ReleaseStateV1(
            schemaVersion: 1,
            generation: try nextGeneration(after: current.generation),
            active: trial,
            fallback: current.active,
            trial: nil
        )
        try replace(current: current, with: next)
        journalBestEffort(phase: "committed", state: next, candidate: trial)
        return next
    }

    public func clearTrial(expectedGeneration: Int64) throws -> ReleaseStateV1 {
        let current = try stateStore.load()
        guard current.generation == expectedGeneration,
              current.trial != nil,
              current.active == priorSelection.active,
              current.fallback == priorSelection.fallback else {
            throw CompanionUpdaterError.invalidStatus
        }
        let next = ReleaseStateV1(
            schemaVersion: 1,
            generation: try nextGeneration(after: current.generation),
            active: current.active,
            fallback: current.fallback,
            trial: nil
        )
        try replace(current: current, with: next)
        journalBestEffort(phase: "trial-cleared", state: next, candidate: current.trial)
        return next
    }

    public func restorePriorSelection(expectedGeneration: Int64) throws -> ReleaseStateV1 {
        let current = try stateStore.load()
        guard current.generation == expectedGeneration,
              current.trial == nil,
              current.active == candidate,
              current.fallback == priorSelection.active else {
            throw CompanionUpdaterError.invalidStatus
        }
        let next = ReleaseStateV1(
            schemaVersion: 1,
            generation: try nextGeneration(after: current.generation),
            active: priorSelection.active,
            fallback: priorSelection.fallback,
            trial: nil
        )
        try replace(current: current, with: next)
        journalBestEffort(phase: "reverted", state: next, candidate: current.active)
        return next
    }

    public func cleanupBestEffort() {
        do {
            try fault(.workspaceCleanup)
            try FileManager.default.removeItem(at: workspaceDirectory)
        } catch {
            // Workspaces are diagnostic residue. They never drive selection or later updates.
        }
    }

    private var expectedReleaseRoot: URL {
        stagingDirectory.appendingPathComponent("Runtime Raiders Release", isDirectory: true)
    }

    private var expectedAgentApplication: URL {
        expectedReleaseRoot.appendingPathComponent("Runtime Raiders Agent.app", isDirectory: true)
    }

    private var expectedLauncherApplication: URL {
        expectedReleaseRoot.appendingPathComponent("Runtime Raiders Launcher.app", isDirectory: true)
    }

    private func replace(current: ReleaseStateV1, with next: ReleaseStateV1) throws {
        try fault(.beforeStateReplacement)
        try stateStore.replace(expectedGeneration: current.generation, with: next)
        try fault(.afterStateReplacement)
    }

    private func nextGeneration(after generation: Int64) throws -> Int64 {
        guard generation < ReleaseContractValidation.maximumSafeInteger else {
            throw CompanionUpdaterError.invalidStatus
        }
        return generation + 1
    }

    private func journalBestEffort(
        phase: String,
        state: ReleaseStateV1,
        candidate: ReleaseReference?
    ) {
        do {
            try fault(.journalWrite)
            let journal: [String: Any] = [
                "schema_version": 1,
                "phase": phase,
                "generation": state.generation,
                "active_sequence": state.active.releaseSequence,
                "candidate_sequence": candidate?.releaseSequence as Any,
            ]
            let data = try JSONSerialization.data(withJSONObject: journal, options: [.sortedKeys])
            guard data.count <= ReleaseFilesystem.maximumRecordBytes else { return }
            let descriptor = try ReleaseFilesystem.openOrCreateOwnerOnlyDirectory(
                paths.installationDirectory
            )
            defer { Darwin.close(descriptor) }
            let existing = try ReleaseFilesystem.readRegularRecord(
                directoryDescriptor: descriptor,
                name: paths.updateJournal.lastPathComponent
            )
            if existing == nil {
                try ReleaseFilesystem.createExclusively(
                    data,
                    directoryDescriptor: descriptor,
                    name: paths.updateJournal.lastPathComponent,
                    fault: nil
                )
            } else {
                try ReleaseFilesystem.writeAtomically(
                    data,
                    directoryDescriptor: descriptor,
                    name: paths.updateJournal.lastPathComponent,
                    fault: nil
                )
            }
        } catch {
            // The journal is optional evidence and never an input to state transitions.
        }
    }

    private static func makeOwnerOnlyDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        guard try isOwnedDirectory(url) else { throw CompanionUpdaterError.unsafeFilesystem }
    }

    private static func requireOwnedApplication(_ url: URL) throws {
        guard try isOwnedDirectory(url) else { throw CompanionUpdaterError.unsafeFilesystem }
    }

    private static func isOwnedDirectory(_ url: URL) throws -> Bool {
        var metadata = stat()
        return Darwin.lstat(url.path, &metadata) == 0 &&
            metadata.st_mode & S_IFMT == S_IFDIR &&
            metadata.st_uid == Darwin.geteuid() &&
            metadata.st_mode & 0o022 == 0
    }

    private static func requireOwnedDirectory(_ descriptor: Int32) throws {
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o022 == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private static func requireMissing(parent: Int32, name: String) throws {
        var metadata = stat()
        guard Darwin.fstatat(parent, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0,
              errno == ENOENT else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private static func synchronize(_ descriptor: Int32) throws {
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private static func synchronizeTree(parent: Int32, name: String) throws {
        let descriptor = Darwin.openat(
            parent,
            name,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(descriptor) }
        try synchronizeDirectoryContents(descriptor)
    }

    private static func synchronizeDirectoryContents(_ descriptor: Int32) throws {
        for name in try directoryNames(descriptor) {
            var metadata = stat()
            guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_uid == Darwin.geteuid(),
                  metadata.st_mode & 0o022 == 0 else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            switch metadata.st_mode & S_IFMT {
            case S_IFDIR:
                try withOpenedDescriptor(
                    parent: descriptor,
                    name: name,
                    flags: O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                ) { child in
                    try synchronizeDirectoryContents(child)
                }
            case S_IFREG where metadata.st_nlink == 1:
                try withOpenedDescriptor(
                    parent: descriptor,
                    name: name,
                    flags: O_RDONLY | O_NOFOLLOW | O_CLOEXEC
                ) { file in
                    try synchronize(file)
                }
            default:
                throw CompanionUpdaterError.unsafeFilesystem
            }
        }
        try synchronize(descriptor)
    }

    private static func withOpenedDescriptor(
        parent: Int32,
        name: String,
        flags: Int32,
        operation: (Int32) throws -> Void
    ) throws {
        let descriptor = Darwin.openat(parent, name, flags)
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(descriptor) }
        try operation(descriptor)
    }

    private static func directoryNames(_ descriptor: Int32) throws -> [String] {
        let duplicate = Darwin.dup(descriptor)
        guard duplicate >= 0, let directory = fdopendir(duplicate) else {
            if duplicate >= 0 { Darwin.close(duplicate) }
            throw CompanionUpdaterError.unsafeFilesystem
        }
        defer { closedir(directory) }
        var names: [String] = []
        errno = 0
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            if name != "." && name != ".." { names.append(name) }
            errno = 0
        }
        guard errno == 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        return names.sorted()
    }
}

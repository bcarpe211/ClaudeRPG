import Darwin
import Foundation

@_silgen_name("flock")
private func companionUpdaterFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

public enum CompanionUpdateResult: Equatable, Sendable {
    case alreadyCurrent
    case updated(from: CompanionReleaseIdentity, to: CompanionReleaseIdentity)
}

public enum CompanionUpdaterError: Error, Equatable {
    case updateInProgress
    case unsafeFilesystem
    case activeRun
    case invalidStatus
    case digestMismatch
    case extractionFailed
    case candidateRejected
    case selfCheckFailed
    case insufficientSpace
    case protectedStateChanged
    case healthCheckFailed
    case updateRolledBack
    case rollbackFailed(recoveryCommand: String)
}

public struct VerifiedCompanionApplication: Equatable, Sendable {
    public let identity: CompanionReleaseIdentity
    public let teamIdentifier: String

    public init(identity: CompanionReleaseIdentity, teamIdentifier: String) {
        self.identity = identity
        self.teamIdentifier = teamIdentifier
    }
}

public struct CompanionUpdateStatus: Equatable, Sendable {
    public let verifiedApplication: VerifiedCompanionApplication
    public let daemonRunning: Bool
    public let enabled: Bool
    public let enrollmentValid: Bool
    public let collectorStateValid: Bool
    public let activeRunCount: Int
    public let queuedEventCount: Int

    public init(
        verifiedApplication: VerifiedCompanionApplication,
        daemonRunning: Bool,
        enabled: Bool,
        enrollmentValid: Bool,
        collectorStateValid: Bool,
        activeRunCount: Int,
        queuedEventCount: Int
    ) {
        self.verifiedApplication = verifiedApplication
        self.daemonRunning = daemonRunning
        self.enabled = enabled
        self.enrollmentValid = enrollmentValid
        self.collectorStateValid = collectorStateValid
        self.activeRunCount = activeRunCount
        self.queuedEventCount = queuedEventCount
    }
}

public enum CompanionUpdaterStage: String, Sendable {
    case lock
    case status
    case fetch
    case download
    case archiveValidate = "archive-validate"
    case extract
    case candidateVerify = "candidate-verify"
    case selfCheck = "self-check"
    case statusRecheck = "status-recheck"
    case prepareDaemon = "prepare-daemon"
    case bootout
    case swap
    case bootstrap
    case healthVerify = "health-verify"
    case cleanup
    case unlock
}

public struct CompanionUpdaterOperations {
    public typealias Status = () throws -> CompanionUpdateStatus
    public typealias ManifestFetch = () throws -> ReleaseManifestV1
    public typealias Download = (URL, URL, String) throws -> DownloadReceipt
    public typealias Command = (URL, [String], TimeInterval) throws -> SystemCommandResult
    public typealias CandidateVerification = (
        URL,
        ReleaseManifestV1,
        VerifiedCompanionApplication
    ) throws -> CompanionReleaseIdentity

    let status: Status
    let fetchManifest: ManifestFetch
    let downloadArchive: Download
    let runCommand: Command
    let verifyCandidate: CandidateVerification
    let availableCapacity: (URL) throws -> Int64
    let prepareDaemon: Status
    let bootout: () throws -> Void
    let bootstrap: () throws -> Void
    let healthStatus: Status
    let emitRecoveryCommand: (String) -> Void
    let observe: (CompanionUpdaterStage) -> Void
    let monotonicNow: () -> TimeInterval
    let sleep: (TimeInterval) -> Void

    public init(
        status: @escaping Status,
        fetchManifest: @escaping ManifestFetch,
        downloadArchive: @escaping Download,
        runCommand: @escaping Command,
        verifyCandidate: @escaping CandidateVerification,
        availableCapacity: @escaping (URL) throws -> Int64,
        prepareDaemon: @escaping Status,
        bootout: @escaping () throws -> Void,
        bootstrap: @escaping () throws -> Void,
        healthStatus: @escaping Status,
        emitRecoveryCommand: @escaping (String) -> Void,
        observe: @escaping (CompanionUpdaterStage) -> Void = { _ in },
        monotonicNow: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        sleep: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) {
        self.status = status
        self.fetchManifest = fetchManifest
        self.downloadArchive = downloadArchive
        self.runCommand = runCommand
        self.verifyCandidate = verifyCandidate
        self.availableCapacity = availableCapacity
        self.prepareDaemon = prepareDaemon
        self.bootout = bootout
        self.bootstrap = bootstrap
        self.healthStatus = healthStatus
        self.emitRecoveryCommand = emitRecoveryCommand
        self.observe = observe
        self.monotonicNow = monotonicNow
        self.sleep = sleep
    }
}

public final class CompanionUpdater {
    public static let recoveryCommand = #""$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.rollback.app/Contents/MacOS/runtime-raiders-agent" __recover-update"#

    private static let capacitySafetyMargin: Int64 = 64 * 1_024 * 1_024
    private static let selfCheckTimeout: TimeInterval = 5
    private static let extractionTimeout: TimeInterval = 120
    private static let healthTimeout: TimeInterval = 10
    private static let healthPollInterval: TimeInterval = 0.1

    private let paths: AgentPaths
    private let surfaces: [RunSurface]
    private let operations: CompanionUpdaterOperations

    public init(
        paths: AgentPaths,
        surfaces: [RunSurface],
        operations: CompanionUpdaterOperations
    ) {
        self.paths = paths
        self.surfaces = surfaces
        self.operations = operations
    }

    public func run() throws -> CompanionUpdateResult {
        operations.observe(.lock)
        let updateLock = try CompanionUpdateLock(paths: paths)
        defer {
            updateLock.unlock()
            operations.observe(.unlock)
        }

        operations.observe(.status)
        let initial = try operations.status()
        try validateInitialStatus(initial)
        guard initial.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }
        let beforeFetch = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: false)

        operations.observe(.fetch)
        let manifest = try operations.fetchManifest()
        let afterFetch = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: false)
        guard beforeFetch == afterFetch else { throw CompanionUpdaterError.protectedStateChanged }
        let frozen = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: true)

        let installed = initial.verifiedApplication.identity
        guard manifest.releaseSequence > installed.releaseSequence else {
            return .alreadyCurrent
        }
        guard manifest.availability(from: installed) != nil else {
            throw CompanionUpdaterError.candidateRejected
        }

        let transaction = try UpdateFileTransaction(paths: paths)
        var prepared = false
        do {
            operations.observe(.download)
            let receipt = try operations.downloadArchive(
                manifest.zipURL,
                transaction.archive,
                manifest.zipSHA256
            )
            guard receipt.sha256 == manifest.zipSHA256 else {
                throw CompanionUpdaterError.digestMismatch
            }
            try transaction.validateDownloadedArchive(receipt: receipt)
            try assertFrozen(frozen)

            operations.observe(.archiveValidate)
            let archiveSummary = try ZipArchiveValidator.validate(transaction.archive)
            try transaction.validateDownloadedArchive(receipt: receipt)

            operations.observe(.extract)
            let extraction = try operations.runCommand(
                URL(fileURLWithPath: "/usr/bin/ditto"),
                ["-x", "-k", transaction.archive.path, transaction.stagingDirectory.path],
                Self.extractionTimeout
            )
            guard extraction.exitStatus == .exited(0) else {
                throw CompanionUpdaterError.extractionFailed
            }
            try ZipArchiveValidator.validateExtractedTree(transaction.stagingDirectory)
            try transaction.sealValidatedCandidate()
            try assertFrozen(frozen)

            operations.observe(.candidateVerify)
            let candidateIdentity = try operations.verifyCandidate(
                transaction.candidateApplication,
                manifest,
                initial.verifiedApplication
            )
            guard candidateIdentity == manifest.identity else {
                throw CompanionUpdaterError.candidateRejected
            }
            try transaction.assertCandidateUnchanged()

            let requiredCapacity = try transaction.requiredCapacity(
                candidateUncompressedSize: archiveSummary.totalUncompressedSize,
                safetyMargin: Self.capacitySafetyMargin
            )
            let availableCapacity = try operations.availableCapacity(paths.supportDirectory)
            guard availableCapacity >= requiredCapacity else {
                throw CompanionUpdaterError.insufficientSpace
            }

            operations.observe(.selfCheck)
            let selfCheck = try operations.runCommand(
                transaction.candidateExecutable,
                ["__self-check"],
                Self.selfCheckTimeout
            )
            guard selfCheck.exitStatus == .exited(0),
                  selfCheck.stderr.isEmpty,
                  try Self.decodeSelfCheck(selfCheck.stdout) == candidateIdentity else {
                throw CompanionUpdaterError.selfCheckFailed
            }
            try transaction.assertCandidateUnchanged()
            try assertFrozen(frozen)

            operations.observe(.statusRecheck)
            let rechecked = try operations.status()
            try validatePriorStatus(rechecked, initial: initial)
            guard rechecked.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }
            try assertFrozen(frozen)

            operations.observe(.prepareDaemon)
            let preparedStatus = try operations.prepareDaemon()
            try validatePriorStatus(preparedStatus, initial: initial)
            guard preparedStatus.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }
            prepared = true
            try assertFrozen(frozen)

            operations.observe(.bootout)
            try operations.bootout()
            try assertFrozen(frozen)

            operations.observe(.swap)
            try transaction.swap()
            try assertFrozen(frozen)

            operations.observe(.bootstrap)
            try operations.bootstrap()
            try assertFrozen(frozen, allowNewOutboxEntries: true)

            operations.observe(.healthVerify)
            _ = try waitForHealth(
                identity: candidateIdentity,
                teamIdentifier: initial.verifiedApplication.teamIdentifier,
                enabled: initial.enabled,
                minimumQueuedEventCount: initial.queuedEventCount
            )
            try assertFrozen(frozen, allowNewOutboxEntries: true)

            operations.observe(.cleanup)
            // Health has committed the new bundle. Cleanup is best-effort from
            // this point so an unsafe or substituted rollback tree cannot turn
            // a verified installation into a destructive second transaction.
            try? transaction.cleanupAfterSuccess()
            return .updated(from: installed, to: candidateIdentity)
        } catch {
            guard prepared else {
                try? transaction.cleanupBeforeSwap()
                throw error
            }
            return try recover(
                from: error,
                transaction: transaction,
                initial: initial,
                frozen: frozen
            )
        }
    }

    private func recover(
        from updateError: Error,
        transaction: UpdateFileTransaction,
        initial: CompanionUpdateStatus,
        frozen: ProtectedStateSnapshot
    ) throws -> CompanionUpdateResult {
        do {
            try operations.bootout()
            if transaction.hasSwapped { try transaction.rollback() }
            try operations.bootstrap()
            _ = try waitForHealth(
                identity: initial.verifiedApplication.identity,
                teamIdentifier: initial.verifiedApplication.teamIdentifier,
                enabled: initial.enabled,
                minimumQueuedEventCount: initial.queuedEventCount
            )
            try assertFrozen(frozen, allowNewOutboxEntries: true)
            try transaction.cleanupAfterRollback()
            throw CompanionUpdaterError.updateRolledBack
        } catch let recoveryError as CompanionUpdaterError where recoveryError == .updateRolledBack {
            throw recoveryError
        } catch {
            try? AgentController.persistDisabledForRecovery(paths: paths, surfaces: surfaces)
            operations.emitRecoveryCommand(Self.recoveryCommand)
            throw CompanionUpdaterError.rollbackFailed(recoveryCommand: Self.recoveryCommand)
        }
    }

    private func waitForHealth(
        identity: CompanionReleaseIdentity,
        teamIdentifier: String,
        enabled: Bool,
        minimumQueuedEventCount: Int
    ) throws -> CompanionUpdateStatus {
        let start = operations.monotonicNow()
        guard start.isFinite else { throw CompanionUpdaterError.healthCheckFailed }
        let deadline = start + Self.healthTimeout
        repeat {
            if let status = try? operations.healthStatus(),
               status.daemonRunning,
               status.verifiedApplication.identity == identity,
               status.verifiedApplication.teamIdentifier == teamIdentifier,
               status.enabled == enabled,
               status.enrollmentValid,
               status.collectorStateValid,
               status.activeRunCount == 0,
               status.queuedEventCount >= minimumQueuedEventCount {
                return status
            }
            let now = operations.monotonicNow()
            guard now.isFinite, now < deadline else {
                throw CompanionUpdaterError.healthCheckFailed
            }
            operations.sleep(min(Self.healthPollInterval, deadline - now))
        } while true
    }

    private func validateInitialStatus(_ status: CompanionUpdateStatus) throws {
        guard status.daemonRunning,
              status.enrollmentValid,
              status.collectorStateValid,
              status.activeRunCount >= 0,
              status.queuedEventCount >= 0,
              !status.verifiedApplication.teamIdentifier.isEmpty else {
            throw CompanionUpdaterError.invalidStatus
        }
    }

    private func validatePriorStatus(
        _ status: CompanionUpdateStatus,
        initial: CompanionUpdateStatus
    ) throws {
        guard status.daemonRunning,
              status.verifiedApplication == initial.verifiedApplication,
              status.enabled == initial.enabled,
              status.enrollmentValid,
              status.collectorStateValid,
              status.queuedEventCount >= initial.queuedEventCount else {
            throw CompanionUpdaterError.invalidStatus
        }
    }

    private func assertFrozen(
        _ frozen: ProtectedStateSnapshot,
        allowNewOutboxEntries: Bool = false
    ) throws {
        let current = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: true)
        guard frozen.isPreserved(by: current, allowNewOutboxEntries: allowNewOutboxEntries) else {
            throw CompanionUpdaterError.protectedStateChanged
        }
    }

    private static func decodeSelfCheck(_ data: Data) throws -> CompanionReleaseIdentity {
        guard !data.isEmpty, data.count <= 16 * 1_024,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == [
                  "release_sequence",
                  "release_sha",
                  "companion_version",
                  "update_protocol_version",
              ],
              let releaseSequence = ReleaseContractValidation.positiveSafeInteger(
                  object["release_sequence"]
              ),
              let releaseSHA = object["release_sha"] as? String,
              ReleaseContractValidation.isLowercaseHex(releaseSHA, count: 40),
              let companionVersion = object["companion_version"] as? String,
              ReleaseContractValidation.isVersion(companionVersion),
              let updateProtocolVersion = ReleaseContractValidation.positiveSafeInteger(
                  object["update_protocol_version"]
              ) else {
            throw CompanionUpdaterError.selfCheckFailed
        }
        return CompanionReleaseIdentity(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: Int(updateProtocolVersion)
        )
    }
}

private extension ReleaseManifestV1 {
    var identity: CompanionReleaseIdentity {
        CompanionReleaseIdentity(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: updateProtocolVersion
        )
    }
}

public final class UpdateFileTransaction {
    public let workspaceDirectory: URL
    public let stagingDirectory: URL
    public let archive: URL
    public let candidateApplication: URL
    public let candidateExecutable: URL
    public let promotedCandidateApplication: URL

    public private(set) var hasSwapped = false

    private let paths: AgentPaths
    private let workspaceName: String
    private let promotedName: String
    private var supportDescriptor: Int32
    private var workspaceDescriptor: Int32
    private var stagingDescriptor: Int32
    private var candidateSeal: [SealedEntry]?

    public init(paths: AgentPaths) throws {
        self.paths = paths
        supportDescriptor = try OwnerOnlyDirectory.openOrCreate(paths.supportDirectory)
        workspaceName = ".runtime-raiders-update-\(UUID().uuidString)"
        promotedName = ".Runtime Raiders Agent.candidate-\(UUID().uuidString).app"
        workspaceDirectory = paths.supportDirectory.appendingPathComponent(
            workspaceName,
            isDirectory: true
        )
        stagingDirectory = workspaceDirectory.appendingPathComponent("staging", isDirectory: true)
        archive = workspaceDirectory.appendingPathComponent("candidate.zip", isDirectory: false)
        candidateApplication = stagingDirectory.appendingPathComponent(
            "Runtime Raiders Agent.app",
            isDirectory: true
        )
        candidateExecutable = candidateApplication.appendingPathComponent(
            "Contents/MacOS/runtime-raiders-agent",
            isDirectory: false
        )
        promotedCandidateApplication = paths.supportDirectory.appendingPathComponent(
            promotedName,
            isDirectory: true
        )
        workspaceDescriptor = -1
        stagingDescriptor = -1

        do {
            try Self.requireOwnedDirectory(
                descriptor: supportDescriptor,
                name: paths.installedApplication.lastPathComponent
            )
            try Self.requireMissing(descriptor: supportDescriptor, name: paths.rollbackApplication.lastPathComponent)
            try Self.requireMissing(descriptor: supportDescriptor, name: paths.failedApplication.lastPathComponent)
            try Self.requireMissing(descriptor: supportDescriptor, name: promotedName)
            guard Darwin.mkdirat(supportDescriptor, workspaceName, 0o700) == 0 else {
                throw Self.posixError()
            }
            workspaceDescriptor = Darwin.openat(
                supportDescriptor,
                workspaceName,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            guard workspaceDescriptor >= 0,
                  Darwin.fchmod(workspaceDescriptor, 0o700) == 0,
                  Darwin.mkdirat(workspaceDescriptor, "staging", 0o700) == 0 else {
                throw Self.posixError()
            }
            stagingDescriptor = Darwin.openat(
                workspaceDescriptor,
                "staging",
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            guard stagingDescriptor >= 0, Darwin.fchmod(stagingDescriptor, 0o700) == 0 else {
                throw Self.posixError()
            }
        } catch {
            closeDescriptors()
            throw error
        }
    }

    deinit { closeDescriptors() }

    public func validateDownloadedArchive(receipt: DownloadReceipt) throws {
        let descriptor = Darwin.openat(
            workspaceDescriptor,
            archive.lastPathComponent,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size == receipt.byteCount,
              receipt.byteCount > 0,
              receipt.byteCount <= ArtifactDownloader.maximumByteCount else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    public func sealValidatedCandidate() throws {
        try ZipArchiveValidator.validateExtractedTree(stagingDirectory)
        candidateSeal = try Self.sealTree(parentDescriptor: stagingDescriptor, name: candidateApplication.lastPathComponent)
    }

    public func assertCandidateUnchanged() throws {
        guard let candidateSeal,
              try Self.sealTree(
                  parentDescriptor: stagingDescriptor,
                  name: candidateApplication.lastPathComponent
              ) == candidateSeal else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    public func requiredCapacity(
        candidateUncompressedSize: Int64,
        safetyMargin: Int64
    ) throws -> Int64 {
        guard candidateUncompressedSize >= 0, safetyMargin >= 0 else {
            throw CompanionUpdaterError.insufficientSpace
        }
        let installedSize = try Self.treeSize(
            parentDescriptor: supportDescriptor,
            name: paths.installedApplication.lastPathComponent
        )
        let (first, overflow1) = installedSize.addingReportingOverflow(candidateUncompressedSize)
        let (total, overflow2) = first.addingReportingOverflow(safetyMargin)
        guard !overflow1, !overflow2 else { throw CompanionUpdaterError.insufficientSpace }
        return total
    }

    public func swap() throws {
        try assertCandidateUnchanged()
        try Self.requireMissing(descriptor: supportDescriptor, name: paths.rollbackApplication.lastPathComponent)
        try Self.requireMissing(descriptor: supportDescriptor, name: promotedName)
        guard Darwin.renameat(
            stagingDescriptor,
            candidateApplication.lastPathComponent,
            supportDescriptor,
            promotedName
        ) == 0 else { throw Self.posixError() }
        do {
            try Self.requireOwnedDirectory(descriptor: supportDescriptor, name: promotedName)
            try Self.setOwnerOnlyMode(descriptor: supportDescriptor, name: promotedName)
            guard Darwin.renameat(
                supportDescriptor,
                paths.installedApplication.lastPathComponent,
                supportDescriptor,
                paths.rollbackApplication.lastPathComponent
            ) == 0 else { throw Self.posixError() }
            do {
                try Self.setOwnerOnlyMode(
                    descriptor: supportDescriptor,
                    name: paths.rollbackApplication.lastPathComponent
                )
            } catch {
                _ = Darwin.renameat(
                    supportDescriptor,
                    paths.rollbackApplication.lastPathComponent,
                    supportDescriptor,
                    paths.installedApplication.lastPathComponent
                )
                throw error
            }
            guard Darwin.renameat(
                supportDescriptor,
                promotedName,
                supportDescriptor,
                paths.installedApplication.lastPathComponent
            ) == 0 else {
                _ = Darwin.renameat(
                    supportDescriptor,
                    paths.rollbackApplication.lastPathComponent,
                    supportDescriptor,
                    paths.installedApplication.lastPathComponent
                )
                throw Self.posixError()
            }
            try Self.synchronize(supportDescriptor)
            hasSwapped = true
        } catch {
            throw error
        }
    }

    public func rollback() throws {
        guard hasSwapped else { return }
        try Self.requireOwnedDirectory(
            descriptor: supportDescriptor,
            name: paths.installedApplication.lastPathComponent
        )
        try Self.requireOwnedDirectory(
            descriptor: supportDescriptor,
            name: paths.rollbackApplication.lastPathComponent
        )
        try Self.requireMissing(descriptor: supportDescriptor, name: paths.failedApplication.lastPathComponent)
        guard Darwin.renameat(
            supportDescriptor,
            paths.installedApplication.lastPathComponent,
            supportDescriptor,
            paths.failedApplication.lastPathComponent
        ) == 0 else { throw Self.posixError() }
        guard Darwin.renameat(
            supportDescriptor,
            paths.rollbackApplication.lastPathComponent,
            supportDescriptor,
            paths.installedApplication.lastPathComponent
        ) == 0 else {
            throw Self.posixError()
        }
        try Self.synchronize(supportDescriptor)
        hasSwapped = false
    }

    public func cleanupAfterSuccess() throws {
        try Self.requireOwnedDirectory(
            descriptor: supportDescriptor,
            name: paths.installedApplication.lastPathComponent
        )
        _ = try Self.sealTree(
            parentDescriptor: supportDescriptor,
            name: paths.rollbackApplication.lastPathComponent
        )
        try Self.removeTree(
            parentDescriptor: supportDescriptor,
            name: paths.rollbackApplication.lastPathComponent
        )
        try removeWorkspace()
    }

    public func cleanupAfterRollback() throws {
        try Self.requireOwnedDirectory(
            descriptor: supportDescriptor,
            name: paths.installedApplication.lastPathComponent
        )
        try Self.requireMissing(descriptor: supportDescriptor, name: paths.rollbackApplication.lastPathComponent)
        try removeWorkspace()
    }

    public func cleanupBeforeSwap() throws {
        try Self.requireOwnedDirectory(
            descriptor: supportDescriptor,
            name: paths.installedApplication.lastPathComponent
        )
        guard !hasSwapped else { throw CompanionUpdaterError.unsafeFilesystem }
        if Self.exists(descriptor: supportDescriptor, name: promotedName) {
            try Self.removeTree(parentDescriptor: supportDescriptor, name: promotedName)
        }
        try removeWorkspace()
    }

    private func removeWorkspace() throws {
        closeWorkspaceDescriptors()
        if Self.exists(descriptor: supportDescriptor, name: workspaceName) {
            try Self.removeTree(parentDescriptor: supportDescriptor, name: workspaceName)
        }
        try Self.synchronize(supportDescriptor)
    }

    private func closeWorkspaceDescriptors() {
        if stagingDescriptor >= 0 {
            Darwin.close(stagingDescriptor)
            stagingDescriptor = -1
        }
        if workspaceDescriptor >= 0 {
            Darwin.close(workspaceDescriptor)
            workspaceDescriptor = -1
        }
    }

    private func closeDescriptors() {
        closeWorkspaceDescriptors()
        if supportDescriptor >= 0 {
            Darwin.close(supportDescriptor)
            supportDescriptor = -1
        }
    }

    private struct SealedEntry: Equatable {
        let path: String
        let device: UInt64
        let inode: UInt64
        let mode: UInt16
        let size: Int64
        let modifiedSeconds: Int64
        let modifiedNanoseconds: Int64
    }

    private static func sealTree(parentDescriptor: Int32, name: String) throws -> [SealedEntry] {
        let descriptor = Darwin.openat(
            parentDescriptor,
            name,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(descriptor) }
        var entries: [SealedEntry] = []
        try sealDirectory(descriptor, relativePath: name, entries: &entries)
        return entries.sorted { $0.path < $1.path }
    }

    private static func sealDirectory(
        _ descriptor: Int32,
        relativePath: String,
        entries: inout [SealedEntry]
    ) throws {
        var directoryMetadata = stat()
        guard Darwin.fstat(descriptor, &directoryMetadata) == 0,
              directoryMetadata.st_mode & S_IFMT == S_IFDIR,
              directoryMetadata.st_uid == Darwin.geteuid(),
              directoryMetadata.st_mode & 0o022 == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        entries.append(sealedEntry(relativePath, directoryMetadata))
        for name in try directoryNames(descriptor) {
            var metadata = stat()
            guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_uid == Darwin.geteuid(),
                  metadata.st_mode & 0o022 == 0 else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            let type = metadata.st_mode & S_IFMT
            let path = relativePath + "/" + name
            if type == S_IFDIR {
                let child = Darwin.openat(
                    descriptor,
                    name,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
                guard child >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
                defer { Darwin.close(child) }
                try sealDirectory(child, relativePath: path, entries: &entries)
            } else if type == S_IFREG, metadata.st_nlink == 1 {
                entries.append(sealedEntry(path, metadata))
            } else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
        }
    }

    private static func sealedEntry(_ path: String, _ metadata: stat) -> SealedEntry {
        SealedEntry(
            path: path,
            device: UInt64(metadata.st_dev),
            inode: UInt64(metadata.st_ino),
            mode: UInt16(metadata.st_mode & 0o7777),
            size: Int64(metadata.st_size),
            modifiedSeconds: Int64(metadata.st_mtimespec.tv_sec),
            modifiedNanoseconds: Int64(metadata.st_mtimespec.tv_nsec)
        )
    }

    private static func treeSize(parentDescriptor: Int32, name: String) throws -> Int64 {
        try sealTree(parentDescriptor: parentDescriptor, name: name).reduce(0) { total, entry in
            let (next, overflow) = total.addingReportingOverflow(max(0, entry.size))
            guard !overflow else { throw CompanionUpdaterError.insufficientSpace }
            return next
        }
    }

    private static func removeTree(parentDescriptor: Int32, name: String) throws {
        var metadata = stat()
        guard Darwin.fstatat(parentDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
              metadata.st_uid == Darwin.geteuid() else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        if metadata.st_mode & S_IFMT == S_IFREG {
            guard metadata.st_nlink == 1, Darwin.unlinkat(parentDescriptor, name, 0) == 0 else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            return
        }
        guard metadata.st_mode & S_IFMT == S_IFDIR else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        let descriptor = Darwin.openat(
            parentDescriptor,
            name,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        var descriptorIsOpen = true
        defer { if descriptorIsOpen { Darwin.close(descriptor) } }
        do {
            for child in try directoryNames(descriptor) {
                try removeTree(parentDescriptor: descriptor, name: child)
            }
            Darwin.close(descriptor)
            descriptorIsOpen = false
            guard Darwin.unlinkat(parentDescriptor, name, AT_REMOVEDIR) == 0 else {
                throw Self.posixError()
            }
        } catch {
            throw error
        }
    }

    private static func directoryNames(_ descriptor: Int32) throws -> [String] {
        let duplicate = Darwin.openat(
            descriptor,
            ".",
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard duplicate >= 0, let stream = Darwin.fdopendir(duplicate) else {
            if duplicate >= 0 { Darwin.close(duplicate) }
            throw Self.posixError()
        }
        defer { Darwin.closedir(stream) }
        var names: [String] = []
        while let entry = Darwin.readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            if name != "." && name != ".." { names.append(name) }
        }
        return names.sorted()
    }

    private static func requireOwnedDirectory(descriptor: Int32, name: String) throws {
        var metadata = stat()
        guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o022 == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private static func setOwnerOnlyMode(descriptor: Int32, name: String) throws {
        let child = Darwin.openat(
            descriptor,
            name,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard child >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(child) }
        var metadata = stat()
        guard Darwin.fstat(child, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid(),
              Darwin.fchmod(child, 0o700) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private static func requireMissing(descriptor: Int32, name: String) throws {
        var metadata = stat()
        guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0,
              errno == ENOENT else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private static func exists(descriptor: Int32, name: String) -> Bool {
        var metadata = stat()
        return Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0
    }

    private static func synchronize(_ descriptor: Int32) throws {
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw posixError()
        }
    }

    private static func posixError() -> Error {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

private final class CompanionUpdateLock {
    private var descriptor: Int32

    init(paths: AgentPaths) throws {
        let stateDescriptor: Int32
        do {
            stateDescriptor = try OwnerOnlyDirectory.openOrCreate(paths.stateDirectory)
        } catch {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        defer { Darwin.close(stateDescriptor) }
        descriptor = Darwin.openat(
            stateDescriptor,
            paths.updateLock.lastPathComponent,
            O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            Darwin.close(descriptor)
            descriptor = -1
            throw CompanionUpdaterError.unsafeFilesystem
        }
        guard companionUpdaterFlock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockError = errno
            Darwin.close(descriptor)
            descriptor = -1
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                throw CompanionUpdaterError.updateInProgress
            }
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    deinit { unlock() }

    func unlock() {
        guard descriptor >= 0 else { return }
        _ = companionUpdaterFlock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
        descriptor = -1
    }
}

private struct ProtectedStateSnapshot: Equatable {
    private let entries: [String: Data]

    static func capture(paths: AgentPaths, includeUpdateState: Bool) throws -> Self {
        var entries: [String: Data] = [:]
        if let stateDescriptor = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) {
            defer { Darwin.close(stateDescriptor) }
            try captureDirectory(
                stateDescriptor,
                prefix: "state",
                excludedNames: includeUpdateState
                    ? [paths.updateLock.lastPathComponent]
                    : [paths.updateLock.lastPathComponent, paths.updateState.lastPathComponent],
                entries: &entries
            )
        }
        if let outboxDescriptor = try OwnerOnlyDirectory.openExisting(paths.outboxDirectory) {
            defer { Darwin.close(outboxDescriptor) }
            try captureDirectory(
                outboxDescriptor,
                prefix: "outbox",
                excludedNames: [],
                entries: &entries
            )
        }
        return Self(entries: entries)
    }

    func isPreserved(by current: Self, allowNewOutboxEntries: Bool) -> Bool {
        for (path, data) in entries where current.entries[path] != data { return false }
        if current.entries.count == entries.count { return true }
        guard allowNewOutboxEntries else { return false }
        return current.entries
            .filter { entries[$0.key] == nil }
            .allSatisfy { validNewOutboxEntry(path: $0.key, data: $0.value) }
    }

    private func validNewOutboxEntry(path: String, data: Data) -> Bool {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count == 2,
              components[0] == "outbox",
              components[1].range(
                  of: #"^[0-9a-f]{64}\.json$"#,
                  options: .regularExpression
              ) != nil,
              let event = try? JSONDecoder().decode(RunEventV1.self, from: data),
              components[1] == Substring(event.idempotencyKey + ".json"),
              let canonical = try? PrivacyEncoder().encode(event),
              canonical == data else {
            return false
        }
        return true
    }

    private static func captureDirectory(
        _ descriptor: Int32,
        prefix: String,
        excludedNames: Set<String>,
        entries: inout [String: Data]
    ) throws {
        for name in try UpdateFileTransaction.directoryNamesForSnapshot(descriptor)
            where !excludedNames.contains(name) {
            var metadata = stat()
            guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_uid == Darwin.geteuid() else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            let path = prefix + "/" + name
            let type = metadata.st_mode & S_IFMT
            if type == S_IFDIR {
                let child = Darwin.openat(
                    descriptor,
                    name,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
                guard child >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
                defer { Darwin.close(child) }
                try captureDirectory(
                    child,
                    prefix: path,
                    excludedNames: [],
                    entries: &entries
                )
            } else if type == S_IFREG, metadata.st_nlink == 1,
                      metadata.st_size >= 0, metadata.st_size <= 64 * 1_024 * 1_024 {
                entries[path] = try readFile(descriptor, name: name, expected: metadata)
            } else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
        }
    }

    private static func readFile(_ parent: Int32, name: String, expected: stat) throws -> Data {
        let descriptor = Darwin.openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_dev == expected.st_dev,
              metadata.st_ino == expected.st_ino,
              metadata.st_size == expected.st_size else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        var data = Data(count: Int(metadata.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw CompanionUpdaterError.unsafeFilesystem }
            }
        }
        return data
    }
}

private extension UpdateFileTransaction {
    static func directoryNamesForSnapshot(_ descriptor: Int32) throws -> [String] {
        try directoryNames(descriptor)
    }
}

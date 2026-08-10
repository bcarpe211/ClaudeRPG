import CryptoKit
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
    case rollbackFailed
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
    public let preparedReleaseStateGeneration: Int64?

    public var preparedForUpdate: Bool { preparedReleaseStateGeneration != nil }

    public init(
        verifiedApplication: VerifiedCompanionApplication,
        daemonRunning: Bool,
        enabled: Bool,
        enrollmentValid: Bool,
        collectorStateValid: Bool,
        activeRunCount: Int,
        queuedEventCount: Int,
        preparedReleaseStateGeneration: Int64? = nil
    ) {
        self.verifiedApplication = verifiedApplication
        self.daemonRunning = daemonRunning
        self.enabled = enabled
        self.enrollmentValid = enrollmentValid
        self.collectorStateValid = collectorStateValid
        self.activeRunCount = activeRunCount
        self.queuedEventCount = queuedEventCount
        self.preparedReleaseStateGeneration = preparedReleaseStateGeneration
    }
}

public enum CompanionDaemonPreparationResult: Equatable, Sendable {
    case prepared(CompanionUpdateStatus)
    case refusedActiveRun
}

public enum CompanionUpdaterStage: String, Sendable {
    case lock
    case status
    case staleTrialReconciliation = "stale-trial-reconciliation"
    case fetch
    case download
    case archiveValidate = "archive-validate"
    case extract
    case candidateVerify = "candidate-verify"
    case selfCheck = "self-check"
    case statusRecheck = "status-recheck"
    case promote
    case recordTrial = "record-trial"
    case lease
    case prepareDaemon = "prepare-daemon"
    case kickstart
    case healthVerify = "health-verify"
    case commit
    case resume
    case revert
    case priorHealth = "prior-health"
    case cleanup
    case unlock
}

public enum CompanionUpdaterCheckpoint: String, CaseIterable, Sendable {
    case beforeDownload, afterDownload
    case beforeArchiveValidation, afterArchiveValidation
    case beforeExtraction, afterExtraction
    case beforeCandidateVerification, afterCandidateVerification
    case beforePromotion, afterPromotion
    case beforeTrialRecord, afterTrialRecord
    case beforeLease, afterLease
    case beforePrepare, afterPrepare
    case beforeKickstart, afterKickstart
    case beforeTrialHealth, afterTrialHealth
    case beforeCommit, afterCommit
    case beforeResume, afterResume
    case beforeRevert, afterRevert
    case beforePriorHealth, afterPriorHealth
}

public struct CompanionUpdaterOperations {
    public typealias Status = (ReleaseReference, Int64) throws -> CompanionUpdateStatus
    public typealias ManifestFetch = () throws -> ReleaseManifestV1
    public typealias Download = (URL, URL, String) throws -> DownloadReceipt
    public typealias Command = (URL, [String], TimeInterval) throws -> SystemCommandResult
    public typealias ArchiveVerification = (
        URL,
        ReleaseManifestV1,
        VerifiedCompanionApplication
    ) throws -> VerifiedReleaseArchive
    public typealias DaemonPreparation = (Int64) throws -> CompanionDaemonPreparationResult

    let status: Status
    let fetchManifest: ManifestFetch
    let downloadArchive: Download
    let runCommand: Command
    let verifyArchive: ArchiveVerification
    let availableCapacity: (URL) throws -> Int64
    let acquirePreparedLease: () throws -> CompanionPreparedStartupLease
    let prepareDaemon: DaemonPreparation
    let kickstartDaemon: () throws -> Void
    let resumePreparedDaemon: (Int64) throws -> Void
    let healthStatus: Status
    let observe: (CompanionUpdaterStage) -> Void
    let checkpoint: (CompanionUpdaterCheckpoint) throws -> Void
    let monotonicNow: () -> TimeInterval
    let sleep: (TimeInterval) -> Void

    public init(
        status: @escaping Status,
        fetchManifest: @escaping ManifestFetch,
        downloadArchive: @escaping Download,
        runCommand: @escaping Command,
        verifyArchive: @escaping ArchiveVerification,
        availableCapacity: @escaping (URL) throws -> Int64,
        acquirePreparedLease: @escaping () throws -> CompanionPreparedStartupLease,
        prepareDaemon: @escaping DaemonPreparation,
        kickstartDaemon: @escaping () throws -> Void,
        resumePreparedDaemon: @escaping (Int64) throws -> Void,
        healthStatus: @escaping Status,
        observe: @escaping (CompanionUpdaterStage) -> Void = { _ in },
        checkpoint: @escaping (CompanionUpdaterCheckpoint) throws -> Void = { _ in },
        monotonicNow: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        sleep: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) {
        self.status = status
        self.fetchManifest = fetchManifest
        self.downloadArchive = downloadArchive
        self.runCommand = runCommand
        self.verifyArchive = verifyArchive
        self.availableCapacity = availableCapacity
        self.acquirePreparedLease = acquirePreparedLease
        self.prepareDaemon = prepareDaemon
        self.kickstartDaemon = kickstartDaemon
        self.resumePreparedDaemon = resumePreparedDaemon
        self.healthStatus = healthStatus
        self.observe = observe
        self.checkpoint = checkpoint
        self.monotonicNow = monotonicNow
        self.sleep = sleep
    }
}

public final class CompanionUpdater {
    private static let capacitySafetyMargin: Int64 = 64 * 1_024 * 1_024
    private static let selfCheckTimeout: TimeInterval = 5
    private static let extractionTimeout: TimeInterval = 120
    private static let healthTimeout: TimeInterval = 10
    private static let healthPollInterval: TimeInterval = 0.1

    private let paths: AgentPaths
    private let operations: CompanionUpdaterOperations
    private let transactionFactory: () throws -> VersionedReleaseTransaction

    public convenience init(
        paths: AgentPaths,
        surfaces: [RunSurface],
        operations: CompanionUpdaterOperations
    ) {
        self.init(
            paths: paths,
            surfaces: surfaces,
            operations: operations,
            transactionFactory: { try VersionedReleaseTransaction(paths: paths) }
        )
    }

    init(
        paths: AgentPaths,
        surfaces: [RunSurface],
        operations: CompanionUpdaterOperations,
        transactionFactory: @escaping () throws -> VersionedReleaseTransaction
    ) {
        self.paths = paths
        self.operations = operations
        self.transactionFactory = transactionFactory
        _ = surfaces
    }

    public func run() throws -> CompanionUpdateResult {
        operations.observe(.lock)
        let updateLock = try CompanionUpdateLock(paths: paths)
        defer {
            updateLock.unlock()
            operations.observe(.unlock)
        }

        let stateStore = try ReleaseStateStore(paths: paths)
        var state = try stateStore.load()
        var initial = try readHealthyCommittedStatus(state: state)
        guard initial.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }

        if state.trial != nil {
            operations.observe(.staleTrialReconciliation)
            guard try CompanionPreparedStartupLease.observe(paths: paths) == nil else {
                throw CompanionUpdaterError.updateInProgress
            }
            let stale = try transactionFactory()
            state = try stale.clearTrial(expectedGeneration: state.generation)
            stale.cleanupBestEffort()
            initial = try readHealthyCommittedStatus(state: state)
            guard initial.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }
        }

        let beforeFetch = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: false)
        operations.observe(.fetch)
        let manifest = try withProtectedBoundary(beforeFetch, includeUpdateState: false) {
            try operations.fetchManifest()
        }
        let frozen = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: true)

        let installedIdentity = try state.active.companionReleaseIdentity()
        guard initial.verifiedApplication.identity == installedIdentity else {
            throw CompanionUpdaterError.invalidStatus
        }
        guard manifest.releaseSequence > state.active.releaseSequence else {
            return .alreadyCurrent
        }
        guard manifest.updateProtocolVersion == 2,
              state.active.updateProtocolVersion == 2,
              manifest.availability(from: installedIdentity) != nil else {
            throw CompanionUpdaterError.candidateRejected
        }

        let transaction = try transactionFactory()
        var lease: CompanionPreparedStartupLease?
        defer {
            lease?.unlock()
            transaction.cleanupBestEffort()
        }

        do {
            operations.observe(.download)
            try operations.checkpoint(.beforeDownload)
            let receipt = try withFrozenBoundary(frozen) {
                try operations.downloadArchive(manifest.zipURL, transaction.archive, manifest.zipSHA256)
            }
            try operations.checkpoint(.afterDownload)
            guard receipt.sha256 == manifest.zipSHA256 else {
                throw CompanionUpdaterError.digestMismatch
            }
            try validateArchiveReceipt(receipt, at: transaction.archive, digest: manifest.zipSHA256)

            operations.observe(.archiveValidate)
            try operations.checkpoint(.beforeArchiveValidation)
            let archiveSummary = try withFrozenBoundary(frozen) {
                try ZipArchiveValidator.validate(transaction.archive)
            }
            try operations.checkpoint(.afterArchiveValidation)

            operations.observe(.extract)
            try operations.checkpoint(.beforeExtraction)
            let extraction = try withFrozenBoundary(frozen) {
                try operations.runCommand(
                    URL(fileURLWithPath: "/usr/bin/ditto"),
                    ["-x", "-k", transaction.archive.path, transaction.stagingDirectory.path],
                    Self.extractionTimeout
                )
            }
            guard extraction.exitStatus == .exited(0) else {
                throw CompanionUpdaterError.extractionFailed
            }
            try ZipArchiveValidator.validateExtractedTree(transaction.stagingDirectory)
            try operations.checkpoint(.afterExtraction)

            operations.observe(.candidateVerify)
            try operations.checkpoint(.beforeCandidateVerification)
            let verified = try withFrozenBoundary(frozen) {
                try operations.verifyArchive(
                    transaction.stagingDirectory,
                    manifest,
                    initial.verifiedApplication
                )
            }
            let candidate = verified.agent.identity
            guard candidate == manifest.releaseReference else {
                throw CompanionUpdaterError.candidateRejected
            }
            try operations.checkpoint(.afterCandidateVerification)

            let required = archiveSummary.totalUncompressedSize.addingReportingOverflow(
                Self.capacitySafetyMargin
            )
            guard !required.overflow,
                  try operations.availableCapacity(paths.supportDirectory) >= required.partialValue else {
                throw CompanionUpdaterError.insufficientSpace
            }

            operations.observe(.selfCheck)
            let selfCheck = try withFrozenBoundary(frozen) {
                try operations.runCommand(
                    verified.agent.application.appendingPathComponent(
                        "Contents/MacOS/runtime-raiders-agent",
                        isDirectory: false
                    ),
                    ["__self-check"],
                    Self.selfCheckTimeout
                )
            }
            let selfCheckedIdentity = try Self.decodeSelfCheck(selfCheck.stdout)
            let candidateIdentity = try candidate.companionReleaseIdentity()
            guard selfCheck.exitStatus == .exited(0),
                  selfCheck.stderr.isEmpty,
                  selfCheckedIdentity == candidateIdentity else {
                throw CompanionUpdaterError.selfCheckFailed
            }

            operations.observe(.statusRecheck)
            let rechecked = try withFrozenBoundary(frozen) {
                try operations.status(state.active, state.generation)
            }
            try validateStatus(
                rechecked,
                expected: state.active,
                generation: nil,
                initial: initial
            )
            guard rechecked.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }

            operations.observe(.promote)
            try operations.checkpoint(.beforePromotion)
            guard try transaction.promoteVerifiedCandidate(verified) == candidate else {
                throw CompanionUpdaterError.candidateRejected
            }
            try operations.checkpoint(.afterPromotion)

            operations.observe(.recordTrial)
            try operations.checkpoint(.beforeTrialRecord)
            let trialState = try transaction.recordTrial(candidate)
            try operations.checkpoint(.afterTrialRecord)

            operations.observe(.lease)
            try operations.checkpoint(.beforeLease)
            lease = try operations.acquirePreparedLease()
            try operations.checkpoint(.afterLease)

            operations.observe(.prepareDaemon)
            try operations.checkpoint(.beforePrepare)
            let preparation = try operations.prepareDaemon(trialState.generation)
            switch preparation {
            case .refusedActiveRun:
                throw CompanionUpdaterError.activeRun
            case let .prepared(status):
                try validateStatus(
                    status,
                    expected: state.active,
                    generation: trialState.generation,
                    initial: initial
                )
                guard status.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }
            }
            try operations.checkpoint(.afterPrepare)

            operations.observe(.kickstart)
            try operations.checkpoint(.beforeKickstart)
            try withFrozenBoundary(frozen) { try operations.kickstartDaemon() }
            try operations.checkpoint(.afterKickstart)

            operations.observe(.healthVerify)
            try operations.checkpoint(.beforeTrialHealth)
            _ = try waitForHealth(
                release: candidate,
                generation: trialState.generation,
                initial: initial,
                frozen: frozen
            )
            try operations.checkpoint(.afterTrialHealth)

            operations.observe(.commit)
            try operations.checkpoint(.beforeCommit)
            let committed = try transaction.commitTrial(expectedGeneration: trialState.generation)
            try operations.checkpoint(.afterCommit)

            operations.observe(.resume)
            try operations.checkpoint(.beforeResume)
            try operations.resumePreparedDaemon(committed.generation)
            try? operations.checkpoint(.afterResume)
            lease?.unlock()
            lease = nil

            operations.observe(.cleanup)
            transaction.cleanupBestEffort()
            return .updated(
                from: installedIdentity,
                to: try candidate.companionReleaseIdentity()
            )
        } catch {
            try recoverIfNeeded(
                from: error,
                transaction: transaction,
                initial: initial,
                frozen: frozen,
                lease: &lease
            )
        }
    }

    private func recoverIfNeeded(
        from updateError: Error,
        transaction: VersionedReleaseTransaction,
        initial: CompanionUpdateStatus,
        frozen: ProtectedStateSnapshot,
        lease: inout CompanionPreparedStartupLease?
    ) throws -> Never {
        let current: ReleaseStateV1
        do {
            current = try ReleaseStateStore(paths: paths).load()
        } catch {
            throw CompanionUpdaterError.rollbackFailed
        }

        if current.trial != nil {
            do {
                if lease == nil { lease = try operations.acquirePreparedLease() }
                let cleared = try transaction.clearTrial(expectedGeneration: current.generation)
                try restartAndResumePrior(
                    state: cleared,
                    initial: initial,
                    frozen: frozen
                )
                lease?.unlock()
                lease = nil
            } catch {
                throw CompanionUpdaterError.rollbackFailed
            }
            if updateError as? CompanionUpdaterError == .activeRun {
                throw CompanionUpdaterError.activeRun
            }
            throw CompanionUpdaterError.updateRolledBack
        }

        let initialReference = try? initial.verifiedApplication.identity.releaseReference()
        if current.active != initialReference {
            do {
                if lease == nil { lease = try operations.acquirePreparedLease() }
                operations.observe(.revert)
                try operations.checkpoint(.beforeRevert)
                let restored = try transaction.restorePriorSelection(
                    expectedGeneration: current.generation
                )
                try operations.checkpoint(.afterRevert)
                try restartAndResumePrior(
                    state: restored,
                    initial: initial,
                    frozen: frozen
                )
                lease?.unlock()
                lease = nil
            } catch {
                throw CompanionUpdaterError.rollbackFailed
            }
            throw CompanionUpdaterError.updateRolledBack
        }

        throw updateError
    }

    private func restartAndResumePrior(
        state: ReleaseStateV1,
        initial: CompanionUpdateStatus,
        frozen: ProtectedStateSnapshot
    ) throws {
        operations.observe(.kickstart)
        try operations.kickstartDaemon()
        operations.observe(.priorHealth)
        try operations.checkpoint(.beforePriorHealth)
        _ = try waitForHealth(
            release: state.active,
            generation: state.generation,
            initial: initial,
            frozen: frozen
        )
        try operations.checkpoint(.afterPriorHealth)
        try operations.resumePreparedDaemon(state.generation)
    }

    private func readHealthyCommittedStatus(state: ReleaseStateV1) throws -> CompanionUpdateStatus {
        operations.observe(.status)
        let status = try operations.status(state.active, state.generation)
        try validateStatus(status, expected: state.active, generation: nil, initial: nil)
        return status
    }

    private func waitForHealth(
        release: ReleaseReference,
        generation: Int64,
        initial: CompanionUpdateStatus,
        frozen: ProtectedStateSnapshot
    ) throws -> CompanionUpdateStatus {
        let start = operations.monotonicNow()
        guard start.isFinite else { throw CompanionUpdaterError.healthCheckFailed }
        let deadline = start + Self.healthTimeout
        repeat {
            do {
                let status = try withFrozenBoundary(frozen) {
                    try operations.healthStatus(release, generation)
                }
                do {
                    try validateStatus(
                        status,
                        expected: release,
                        generation: generation,
                        initial: initial
                    )
                    guard status.activeRunCount == 0 else {
                        throw CompanionUpdaterError.healthCheckFailed
                    }
                    return status
                } catch {
                    throw CompanionUpdaterError.healthCheckFailed
                }
            } catch let error as CompanionUpdaterError where error == .healthCheckFailed {
                throw error
            } catch {
                // A transient connection failure is retryable until the fixed deadline.
            }
            let now = operations.monotonicNow()
            guard now.isFinite, now < deadline else {
                throw CompanionUpdaterError.healthCheckFailed
            }
            operations.sleep(min(Self.healthPollInterval, deadline - now))
        } while true
    }

    private func validateStatus(
        _ status: CompanionUpdateStatus,
        expected: ReleaseReference,
        generation: Int64?,
        initial: CompanionUpdateStatus?
    ) throws {
        guard status.daemonRunning,
              status.verifiedApplication.identity == (try? expected.companionReleaseIdentity()),
              status.enrollmentValid,
              status.collectorStateValid,
              status.activeRunCount >= 0,
              status.queuedEventCount >= 0,
              status.preparedReleaseStateGeneration == generation,
              !status.verifiedApplication.teamIdentifier.isEmpty else {
            throw CompanionUpdaterError.invalidStatus
        }
        if let initial {
            guard status.enabled == initial.enabled,
                  status.verifiedApplication.teamIdentifier ==
                    initial.verifiedApplication.teamIdentifier,
                  status.queuedEventCount == initial.queuedEventCount else {
                throw CompanionUpdaterError.invalidStatus
            }
        }
    }

    private func withProtectedBoundary<Value>(
        _ snapshot: ProtectedStateSnapshot,
        includeUpdateState: Bool,
        operation: () throws -> Value
    ) throws -> Value {
        try assertProtected(snapshot, includeUpdateState: includeUpdateState)
        do {
            let value = try operation()
            try assertProtected(snapshot, includeUpdateState: includeUpdateState)
            return value
        } catch {
            let operationError = error
            try assertProtected(snapshot, includeUpdateState: includeUpdateState)
            throw operationError
        }
    }

    private func withFrozenBoundary<Value>(
        _ frozen: ProtectedStateSnapshot,
        operation: () throws -> Value
    ) throws -> Value {
        try assertFrozen(frozen)
        do {
            let value = try operation()
            try assertFrozen(frozen)
            return value
        } catch {
            let operationError = error
            try assertFrozen(frozen)
            throw operationError
        }
    }

    private func assertProtected(
        _ snapshot: ProtectedStateSnapshot,
        includeUpdateState: Bool
    ) throws {
        guard (try? ProtectedStateSnapshot.capture(
            paths: paths,
            includeUpdateState: includeUpdateState
        )) == snapshot else {
            throw CompanionUpdaterError.protectedStateChanged
        }
    }

    private func assertFrozen(_ snapshot: ProtectedStateSnapshot) throws {
        try assertProtected(snapshot, includeUpdateState: true)
    }

    private func validateArchiveReceipt(
        _ receipt: DownloadReceipt,
        at archive: URL,
        digest: String
    ) throws {
        var metadata = stat()
        guard Darwin.lstat(archive.path, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1,
              metadata.st_size == receipt.byteCount,
              let data = try? Data(contentsOf: archive),
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == digest else {
            throw CompanionUpdaterError.digestMismatch
        }
    }

    private static func decodeSelfCheck(_ data: Data) throws -> CompanionReleaseIdentity {
        guard !data.isEmpty, data.count <= ReleaseFilesystem.maximumRecordBytes,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == [
                  "release_sequence", "release_sha", "companion_version", "update_protocol_version",
              ],
              let releaseSequence = ReleaseContractValidation.positiveSafeInteger(
                  object["release_sequence"]
              ),
              let releaseSHA = object["release_sha"] as? String,
              ReleaseContractValidation.isLowercaseHex(releaseSHA, count: 40),
              let companionVersion = object["companion_version"] as? String,
              ReleaseContractValidation.isVersion(companionVersion),
              let protocolVersion = ReleaseContractValidation.positiveSafeInteger(
                  object["update_protocol_version"]
              ) else {
            throw CompanionUpdaterError.selfCheckFailed
        }
        return CompanionReleaseIdentity(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: Int(protocolVersion)
        )
    }
}

private extension ReleaseManifestV1 {
    var releaseReference: ReleaseReference {
        ReleaseReference(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: updateProtocolVersion
        )
    }
}

public final class CompanionUpdateLock {
    private var descriptor: Int32

    public init(paths: AgentPaths) throws {
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
            mode_t(0o600)
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

    public static func isHeldByAnotherProcess(paths: AgentPaths) throws -> Bool {
        guard let stateDescriptor = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) else {
            return false
        }
        defer { Darwin.close(stateDescriptor) }
        let descriptor = Darwin.openat(
            stateDescriptor,
            paths.updateLock.lastPathComponent,
            O_RDWR | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            if errno == ENOENT { return false }
            throw CompanionUpdaterError.unsafeFilesystem
        }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        if companionUpdaterFlock(descriptor, LOCK_EX | LOCK_NB) == 0 {
            _ = companionUpdaterFlock(descriptor, LOCK_UN)
            return false
        }
        if errno == EWOULDBLOCK || errno == EAGAIN { return true }
        throw CompanionUpdaterError.unsafeFilesystem
    }

    deinit { unlock() }

    public func unlock() {
        guard descriptor >= 0 else { return }
        _ = companionUpdaterFlock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
        descriptor = -1
    }
}

struct ProtectedStateSnapshot: Equatable {
    let entries: [String: Data]

    static func capture(
        paths: AgentPaths,
        includeUpdateState: Bool,
        additionalStateExclusions: Set<String> = [],
        maximumCapturedBytes: Int? = nil,
        maximumEntryCount: Int? = nil
    ) throws -> Self {
        var entries: [String: Data] = [:]
        var capturedBytes = 0
        if let state = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) {
            defer { Darwin.close(state) }
            var exclusions: Set<String> = [
                paths.updateLock.lastPathComponent,
                paths.preparedStartupLease.lastPathComponent,
            ]
            exclusions.formUnion(additionalStateExclusions)
            if !includeUpdateState { exclusions.insert(paths.updateState.lastPathComponent) }
            try captureDirectory(
                state,
                prefix: "state",
                excludedNames: exclusions,
                entries: &entries,
                capturedBytes: &capturedBytes,
                maximumCapturedBytes: maximumCapturedBytes,
                maximumEntryCount: maximumEntryCount
            )
        } else {
            try insert(
                path: "state",
                value: Data("absent\n".utf8),
                entries: &entries,
                capturedBytes: &capturedBytes,
                maximumCapturedBytes: maximumCapturedBytes,
                maximumEntryCount: maximumEntryCount
            )
        }
        if let outbox = try OwnerOnlyDirectory.openExisting(paths.outboxDirectory) {
            defer { Darwin.close(outbox) }
            try captureDirectory(
                outbox,
                prefix: "outbox",
                excludedNames: [],
                entries: &entries,
                capturedBytes: &capturedBytes,
                maximumCapturedBytes: maximumCapturedBytes,
                maximumEntryCount: maximumEntryCount
            )
        } else {
            try insert(
                path: "outbox",
                value: Data("absent\n".utf8),
                entries: &entries,
                capturedBytes: &capturedBytes,
                maximumCapturedBytes: maximumCapturedBytes,
                maximumEntryCount: maximumEntryCount
            )
        }
        return Self(entries: entries)
    }

    private static func captureDirectory(
        _ descriptor: Int32,
        prefix: String,
        excludedNames: Set<String>,
        entries: inout [String: Data],
        capturedBytes: inout Int,
        maximumCapturedBytes: Int?,
        maximumEntryCount: Int?
    ) throws {
        var initialDirectory = stat()
        guard Darwin.fstat(descriptor, &initialDirectory) == 0,
              initialDirectory.st_mode & S_IFMT == S_IFDIR,
              initialDirectory.st_uid == Darwin.geteuid(),
              initialDirectory.st_mode & 0o077 == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        for name in try directoryNames(descriptor) where !excludedNames.contains(name) {
            var metadata = stat()
            guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_uid == Darwin.geteuid(),
                  metadata.st_mode & 0o077 == 0 else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            let path = prefix + "/" + name
            switch metadata.st_mode & S_IFMT {
            case S_IFDIR:
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
                    entries: &entries,
                    capturedBytes: &capturedBytes,
                    maximumCapturedBytes: maximumCapturedBytes,
                    maximumEntryCount: maximumEntryCount
                )
            case S_IFREG where metadata.st_nlink == 1 &&
                metadata.st_mode & 0o777 == 0o600 &&
                metadata.st_size >= 0 && metadata.st_size <= 64 * 1_024 * 1_024:
                var value = metadataRecord("file", metadata, includeSize: true)
                try requireCapacity(
                    path: path,
                    valueBytes: value.count + Int(metadata.st_size),
                    entries: entries,
                    capturedBytes: capturedBytes,
                    maximumCapturedBytes: maximumCapturedBytes,
                    maximumEntryCount: maximumEntryCount
                )
                value.append(try readFile(descriptor, name: name, expected: metadata))
                try insert(
                    path: path,
                    value: value,
                    entries: &entries,
                    capturedBytes: &capturedBytes,
                    maximumCapturedBytes: maximumCapturedBytes,
                    maximumEntryCount: maximumEntryCount
                )
            default:
                throw CompanionUpdaterError.unsafeFilesystem
            }
        }
        var finalDirectory = stat()
        guard Darwin.fstat(descriptor, &finalDirectory) == 0,
              sameMetadata(finalDirectory, initialDirectory) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        try insert(
            path: prefix,
            value: metadataRecord("directory", initialDirectory, includeSize: false),
            entries: &entries,
            capturedBytes: &capturedBytes,
            maximumCapturedBytes: maximumCapturedBytes,
            maximumEntryCount: maximumEntryCount
        )
    }

    private static func insert(
        path: String,
        value: Data,
        entries: inout [String: Data],
        capturedBytes: inout Int,
        maximumCapturedBytes: Int?,
        maximumEntryCount: Int?
    ) throws {
        try requireCapacity(
            path: path,
            valueBytes: value.count,
            entries: entries,
            capturedBytes: capturedBytes,
            maximumCapturedBytes: maximumCapturedBytes,
            maximumEntryCount: maximumEntryCount
        )
        guard entries.updateValue(value, forKey: path) == nil else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        capturedBytes += path.utf8.count + value.count
    }

    private static func requireCapacity(
        path: String,
        valueBytes: Int,
        entries: [String: Data],
        capturedBytes: Int,
        maximumCapturedBytes: Int?,
        maximumEntryCount: Int?
    ) throws {
        guard valueBytes >= 0,
              maximumEntryCount.map({ entries.count < $0 }) ?? true else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        let (entryBytes, entryOverflow) = path.utf8.count.addingReportingOverflow(valueBytes)
        let (totalBytes, totalOverflow) = capturedBytes.addingReportingOverflow(entryBytes)
        guard !entryOverflow, !totalOverflow,
              maximumCapturedBytes.map({ totalBytes <= $0 }) ?? true else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
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

    private static func readFile(_ parent: Int32, name: String, expected: stat) throws -> Data {
        let descriptor = Darwin.openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(descriptor) }
        var current = stat()
        guard Darwin.fstat(descriptor, &current) == 0,
              current.st_mode & S_IFMT == S_IFREG,
              sameMetadata(current, expected) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        var data = Data(count: Int(current.st_size))
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
        var final = stat()
        guard Darwin.fstat(descriptor, &final) == 0,
              sameMetadata(final, current) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        return data
    }

    private static func sameMetadata(_ first: stat, _ second: stat) -> Bool {
        first.st_dev == second.st_dev &&
            first.st_ino == second.st_ino &&
            first.st_mode == second.st_mode &&
            first.st_uid == second.st_uid &&
            first.st_gid == second.st_gid &&
            first.st_nlink == second.st_nlink &&
            first.st_size == second.st_size &&
            first.st_mtimespec.tv_sec == second.st_mtimespec.tv_sec &&
            first.st_mtimespec.tv_nsec == second.st_mtimespec.tv_nsec &&
            first.st_ctimespec.tv_sec == second.st_ctimespec.tv_sec &&
            first.st_ctimespec.tv_nsec == second.st_ctimespec.tv_nsec
    }

    private static func metadataRecord(
        _ kind: String,
        _ metadata: stat,
        includeSize: Bool
    ) -> Data {
        let common =
            "\(kind):\(metadata.st_dev):\(metadata.st_ino):\(metadata.st_mode):" +
            "\(metadata.st_uid):\(metadata.st_gid)"
        let detail = includeSize
            ? ":\(metadata.st_nlink):\(metadata.st_size)\n"
            : "\n"
        return Data((common + detail).utf8)
    }
}

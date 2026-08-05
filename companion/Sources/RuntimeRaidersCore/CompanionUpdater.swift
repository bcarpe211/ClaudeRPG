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
    case rollbackFailed(recoveryCommand: String)
    case terminalSafetyFailure
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
    let proveDaemonStopped: () throws -> Bool
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
        proveDaemonStopped: @escaping () throws -> Bool,
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
        self.proveDaemonStopped = proveDaemonStopped
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

        let beforeStatus = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: true)
        let priorSeal = try UpdateFileTransaction.captureInstalledSeal(paths: paths)
        operations.observe(.status)
        let initial = try withPreFreezeBoundary(
            snapshot: beforeStatus,
            includeUpdateState: true,
            installedSeal: priorSeal
        ) {
            try operations.status()
        }
        try validateInitialStatus(initial)
        guard initial.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }
        let beforeFetch = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: false)

        operations.observe(.fetch)
        let manifest = try withPreFreezeBoundary(
            snapshot: beforeFetch,
            includeUpdateState: false,
            installedSeal: priorSeal
        ) {
            try operations.fetchManifest()
        }
        let frozen = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: true)

        let installed = initial.verifiedApplication.identity
        guard manifest.releaseSequence > installed.releaseSequence else {
            return .alreadyCurrent
        }
        guard manifest.availability(from: installed) != nil else {
            throw CompanionUpdaterError.candidateRejected
        }

        let transaction = try UpdateFileTransaction(paths: paths)
        try transaction.assertPriorMatches(priorSeal)
        var preparationAttempted = false
        var quiescenceAuthorized = false
        do {
            operations.observe(.download)
            let receipt = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
            }) {
                try operations.downloadArchive(
                    manifest.zipURL,
                    transaction.archive,
                    manifest.zipSHA256
                )
            }
            guard receipt.sha256 == manifest.zipSHA256 else {
                throw CompanionUpdaterError.digestMismatch
            }
            try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
            }) {
                try transaction.validateDownloadedArchive(
                    receipt: receipt,
                    expectedSHA256: manifest.zipSHA256
                )
            }

            operations.observe(.archiveValidate)
            let archiveSummary = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertArchiveUnchanged(expectedSHA256: manifest.zipSHA256)
            }) {
                try ZipArchiveValidator.validate(transaction.archive)
            }

            operations.observe(.extract)
            let extraction = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertArchiveUnchanged(expectedSHA256: manifest.zipSHA256)
            }) {
                try operations.runCommand(
                    URL(fileURLWithPath: "/usr/bin/ditto"),
                    ["-x", "-k", transaction.archive.path, transaction.stagingDirectory.path],
                    Self.extractionTimeout
                )
            }
            guard extraction.exitStatus == .exited(0) else {
                throw CompanionUpdaterError.extractionFailed
            }
            try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertArchiveUnchanged(expectedSHA256: manifest.zipSHA256)
            }) {
                try ZipArchiveValidator.validateExtractedTree(transaction.stagingDirectory)
                try transaction.sealValidatedCandidate()
            }

            operations.observe(.candidateVerify)
            let candidateIdentity = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertCandidateUnchanged()
            }) {
                try operations.verifyCandidate(
                    transaction.candidateApplication,
                    manifest,
                    initial.verifiedApplication
                )
            }
            guard candidateIdentity == manifest.identity else {
                throw CompanionUpdaterError.candidateRejected
            }
            try transaction.bindVerifiedCandidate(identity: candidateIdentity)

            let requiredCapacity = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertCandidateUnchanged()
            }) {
                try transaction.requiredCapacity(
                    candidateUncompressedSize: archiveSummary.totalUncompressedSize,
                    safetyMargin: Self.capacitySafetyMargin
                )
            }
            let availableCapacity = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertCandidateUnchanged()
            }) {
                try operations.availableCapacity(paths.supportDirectory)
            }
            guard availableCapacity >= requiredCapacity else {
                throw CompanionUpdaterError.insufficientSpace
            }

            operations.observe(.selfCheck)
            let selfCheck = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertCandidateUnchanged()
            }) {
                try operations.runCommand(
                    transaction.candidateExecutable,
                    ["__self-check"],
                    Self.selfCheckTimeout
                )
            }
            guard selfCheck.exitStatus == .exited(0),
                  selfCheck.stderr.isEmpty,
                  try Self.decodeSelfCheck(selfCheck.stdout) == candidateIdentity else {
                throw CompanionUpdaterError.selfCheckFailed
            }

            operations.observe(.statusRecheck)
            let rechecked = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertCandidateUnchanged()
            }) {
                try operations.status()
            }
            try validatePriorStatus(rechecked, initial: initial)
            guard rechecked.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }

            operations.observe(.prepareDaemon)
            let preparedStatus = try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertCandidateUnchanged()
            }) {
                preparationAttempted = true
                return try operations.prepareDaemon()
            }
            try validatePriorStatus(preparedStatus, initial: initial)
            guard preparedStatus.activeRunCount == 0 else { throw CompanionUpdaterError.activeRun }
            quiescenceAuthorized = true

            operations.observe(.bootout)
            try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
                try transaction.assertCandidateUnchanged()
            }) {
                try operations.bootout()
            }

            operations.observe(.swap)
            try withFrozenBoundary(frozen) { try transaction.swap() }

            operations.observe(.bootstrap)
            try withFrozenBoundary(frozen, allowNewOutboxEntries: true, pathCheck: {
                try transaction.assertInstalledCandidateUnchanged()
            }) {
                try operations.bootstrap()
            }

            operations.observe(.healthVerify)
            _ = try waitForHealth(
                identity: candidateIdentity,
                teamIdentifier: initial.verifiedApplication.teamIdentifier,
                enabled: initial.enabled,
                minimumQueuedEventCount: initial.queuedEventCount,
                frozen: frozen,
                pathCheck: { try transaction.assertInstalledCandidateUnchanged() }
            )
            try transaction.markCandidateHealthPassed(identity: candidateIdentity)

            operations.observe(.cleanup)
            // Health has committed the new bundle. Cleanup is best-effort from
            // this point so an unsafe or substituted rollback tree cannot turn
            // a verified installation into a destructive second transaction.
            try? withFrozenBoundary(frozen, allowNewOutboxEntries: true, pathCheck: {
                try transaction.assertInstalledCandidateUnchanged()
            }) {
                try transaction.cleanupAfterSuccess()
            }
            return .updated(from: installed, to: candidateIdentity)
        } catch {
            if quiescenceAuthorized || transaction.hasSwapped {
                return try recover(
                    from: error,
                    transaction: transaction,
                    initial: initial,
                    frozen: frozen
                )
            }
            if preparationAttempted {
                return try resumeUnchangedApplication(
                    after: error,
                    transaction: transaction,
                    initial: initial,
                    frozen: frozen
                )
            } else {
                try? transaction.cleanupBeforeSwap()
                throw error
            }
        }
    }

    private func recover(
        from updateError: Error,
        transaction: UpdateFileTransaction,
        initial: CompanionUpdateStatus,
        frozen: ProtectedStateSnapshot
    ) throws -> CompanionUpdateResult {
        let hadSwapped = transaction.hasSwapped
        do {
            try withFrozenBoundary(frozen, allowNewOutboxEntries: true) {
                try operations.bootout()
            }
            if hadSwapped {
                try withFrozenBoundary(frozen, allowNewOutboxEntries: true) {
                    try transaction.rollback()
                }
            }
            try withFrozenBoundary(frozen, allowNewOutboxEntries: true, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
            }) {
                try operations.bootstrap()
            }
            _ = try waitForHealth(
                identity: initial.verifiedApplication.identity,
                teamIdentifier: initial.verifiedApplication.teamIdentifier,
                enabled: initial.enabled,
                minimumQueuedEventCount: initial.queuedEventCount,
                frozen: frozen,
                pathCheck: { try transaction.assertPriorInstalledUnchanged() }
            )
            try withFrozenBoundary(frozen, allowNewOutboxEntries: true, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
            }) {
                if hadSwapped {
                    try transaction.cleanupAfterRollback()
                } else {
                    try transaction.cleanupAfterNoSwap()
                }
            }
            throw CompanionUpdaterError.updateRolledBack
        } catch let recoveryError as CompanionUpdaterError where recoveryError == .updateRolledBack {
            throw recoveryError
        } catch {
            return try enterTerminalRecovery(transaction: transaction)
        }
    }

    private func resumeUnchangedApplication(
        after updateError: Error,
        transaction: UpdateFileTransaction,
        initial: CompanionUpdateStatus,
        frozen: ProtectedStateSnapshot
    ) throws -> CompanionUpdateResult {
        do {
            try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
            }) {
                try operations.bootout()
            }
            try withFrozenBoundary(frozen, pathCheck: {
                try transaction.assertPriorInstalledUnchanged()
            }) {
                try operations.bootstrap()
            }
            _ = try waitForHealth(
                identity: initial.verifiedApplication.identity,
                teamIdentifier: initial.verifiedApplication.teamIdentifier,
                enabled: initial.enabled,
                minimumQueuedEventCount: initial.queuedEventCount,
                frozen: frozen,
                pathCheck: { try transaction.assertPriorInstalledUnchanged() }
            )
            try transaction.cleanupBeforeSwap()
        } catch {
            return try enterTerminalRecovery(transaction: transaction)
        }
        throw updateError
    }

    private func enterTerminalRecovery(
        transaction: UpdateFileTransaction
    ) throws -> CompanionUpdateResult {
        let stableRecoveryAvailable: Bool
        do {
            try transaction.prepareStableRecovery()
            stableRecoveryAvailable = true
        } catch {
            stableRecoveryAvailable = false
        }
        let disabledPersisted: Bool
        do {
            try AgentController.persistDisabledForRecovery(paths: paths, surfaces: surfaces)
            disabledPersisted = true
        } catch {
            disabledPersisted = false
        }
        // A bootout response is not itself proof either way: launchd may have
        // completed the stop before the response channel failed. The separate
        // positive proof is the only condition that authorizes a recovery command.
        try? operations.bootout()
        let daemonStopped = (try? operations.proveDaemonStopped()) == true
        guard stableRecoveryAvailable, disabledPersisted, daemonStopped else {
            throw CompanionUpdaterError.terminalSafetyFailure
        }
        operations.emitRecoveryCommand(Self.recoveryCommand)
        throw CompanionUpdaterError.rollbackFailed(recoveryCommand: Self.recoveryCommand)
    }

    private func waitForHealth(
        identity: CompanionReleaseIdentity,
        teamIdentifier: String,
        enabled: Bool,
        minimumQueuedEventCount: Int,
        frozen: ProtectedStateSnapshot,
        pathCheck: () throws -> Void
    ) throws -> CompanionUpdateStatus {
        let start = operations.monotonicNow()
        guard start.isFinite else { throw CompanionUpdaterError.healthCheckFailed }
        let deadline = start + Self.healthTimeout
        repeat {
            do {
                let status = try withFrozenBoundary(
                    frozen,
                    allowNewOutboxEntries: true,
                    pathCheck: pathCheck
                ) {
                    try operations.healthStatus()
                }
                if status.daemonRunning,
                   status.verifiedApplication.identity == identity,
                   status.verifiedApplication.teamIdentifier == teamIdentifier,
                   status.enabled == enabled,
                   status.enrollmentValid,
                   status.collectorStateValid,
                   status.activeRunCount == 0,
                   status.queuedEventCount >= minimumQueuedEventCount {
                    return status
                }
            } catch CompanionUpdaterError.protectedStateChanged {
                throw CompanionUpdaterError.protectedStateChanged
            } catch CompanionUpdaterError.unsafeFilesystem {
                throw CompanionUpdaterError.unsafeFilesystem
            } catch {
                // A transient status failure is retried until the fixed deadline.
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

    private func withPreFreezeBoundary<Value>(
        snapshot: ProtectedStateSnapshot,
        includeUpdateState: Bool,
        installedSeal: UpdateFileTransaction.TreeSeal,
        operation: () throws -> Value
    ) throws -> Value {
        try verifyPreFreezeBoundary(
            snapshot: snapshot,
            includeUpdateState: includeUpdateState,
            installedSeal: installedSeal
        )
        do {
            let value = try operation()
            try verifyPreFreezeBoundary(
                snapshot: snapshot,
                includeUpdateState: includeUpdateState,
                installedSeal: installedSeal
            )
            return value
        } catch {
            let operationError = error
            try verifyPreFreezeBoundary(
                snapshot: snapshot,
                includeUpdateState: includeUpdateState,
                installedSeal: installedSeal
            )
            throw operationError
        }
    }

    private func verifyPreFreezeBoundary(
        snapshot: ProtectedStateSnapshot,
        includeUpdateState: Bool,
        installedSeal: UpdateFileTransaction.TreeSeal
    ) throws {
        let current: ProtectedStateSnapshot
        do {
            current = try ProtectedStateSnapshot.capture(
                paths: paths,
                includeUpdateState: includeUpdateState
            )
        } catch {
            throw CompanionUpdaterError.protectedStateChanged
        }
        guard current == snapshot else { throw CompanionUpdaterError.protectedStateChanged }
        guard try UpdateFileTransaction.captureInstalledSeal(paths: paths) == installedSeal else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private func withFrozenBoundary<Value>(
        _ frozen: ProtectedStateSnapshot,
        allowNewOutboxEntries: Bool = false,
        pathCheck: () throws -> Void = {},
        operation: () throws -> Value
    ) throws -> Value {
        try pathCheck()
        try assertFrozen(frozen, allowNewOutboxEntries: allowNewOutboxEntries)
        do {
            let value = try operation()
            try pathCheck()
            try assertFrozen(frozen, allowNewOutboxEntries: allowNewOutboxEntries)
            return value
        } catch {
            let operationError = error
            try pathCheck()
            try assertFrozen(frozen, allowNewOutboxEntries: allowNewOutboxEntries)
            throw operationError
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
        let current: ProtectedStateSnapshot
        do {
            current = try ProtectedStateSnapshot.capture(paths: paths, includeUpdateState: true)
        } catch {
            throw CompanionUpdaterError.protectedStateChanged
        }
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
    private var priorSeal: TreeSeal?
    private var archiveSeal: SealedEntry?
    private var candidateSeal: TreeSeal?
    private var verifiedCandidateIdentity: CompanionReleaseIdentity?
    private var candidateHealthPassed = false

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
            priorSeal = try Self.sealTree(
                parentDescriptor: supportDescriptor,
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

    fileprivate static func captureInstalledSeal(paths: AgentPaths) throws -> TreeSeal {
        guard let support = try OwnerOnlyDirectory.openExisting(paths.supportDirectory) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        defer { Darwin.close(support) }
        return try sealTree(
            parentDescriptor: support,
            name: paths.installedApplication.lastPathComponent
        )
    }

    fileprivate func assertPriorInstalledUnchanged() throws {
        guard let priorSeal,
              try Self.sealTree(
            parentDescriptor: supportDescriptor,
            name: paths.installedApplication.lastPathComponent
        ) == priorSeal else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    fileprivate func assertPriorMatches(_ expected: TreeSeal) throws {
        guard priorSeal == expected else { throw CompanionUpdaterError.unsafeFilesystem }
        try assertPriorInstalledUnchanged()
    }

    public func validateDownloadedArchive(
        receipt: DownloadReceipt,
        expectedSHA256: String? = nil
    ) throws {
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
        let sealed = try Self.sealFile(
            descriptor: descriptor,
            relativePath: archive.lastPathComponent,
            expected: metadata
        )
        let digest = sealed.contentSHA256.map { String(format: "%02x", $0) }.joined()
        guard digest == receipt.sha256,
              expectedSHA256.map({ $0 == digest }) ?? true else {
            throw CompanionUpdaterError.digestMismatch
        }
        if let archiveSeal, archiveSeal != sealed {
            throw CompanionUpdaterError.digestMismatch
        }
        archiveSeal = sealed
    }

    public func assertArchiveUnchanged(expectedSHA256: String) throws {
        guard let archiveSeal else { throw CompanionUpdaterError.digestMismatch }
        let descriptor = Darwin.openat(
            workspaceDescriptor,
            archive.lastPathComponent,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.digestMismatch }
        defer { Darwin.close(descriptor) }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0 else {
            throw CompanionUpdaterError.digestMismatch
        }
        let current = try Self.sealFile(
            descriptor: descriptor,
            relativePath: archive.lastPathComponent,
            expected: metadata
        )
        let digest = current.contentSHA256.map { String(format: "%02x", $0) }.joined()
        guard current == archiveSeal, digest == expectedSHA256 else {
            throw CompanionUpdaterError.digestMismatch
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

    public func bindVerifiedCandidate(identity: CompanionReleaseIdentity) throws {
        try assertCandidateUnchanged()
        verifiedCandidateIdentity = identity
    }

    public func markCandidateHealthPassed(identity: CompanionReleaseIdentity) throws {
        guard verifiedCandidateIdentity == identity else {
            throw CompanionUpdaterError.candidateRejected
        }
        try assertInstalledCandidateUnchanged()
        candidateHealthPassed = true
    }

    public func assertInstalledCandidateUnchanged() throws {
        guard let candidateSeal,
              try Self.sealTree(
                  parentDescriptor: supportDescriptor,
                  name: paths.installedApplication.lastPathComponent
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
        try assertPriorInstalledUnchanged()
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
            try normalizeCandidateRootMode(at: promotedName)
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
                try normalizePriorRootMode(at: paths.rollbackApplication.lastPathComponent)
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
            try assertInstalledCandidateUnchanged()
            try assertRollbackPriorUnchanged()
        } catch {
            throw error
        }
    }

    public func rollback() throws {
        guard hasSwapped else { return }
        try assertInstalledCandidateUnchanged()
        try assertRollbackPriorUnchanged()
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
        try assertPriorInstalledUnchanged()
        try assertFailedCandidateUnchanged()
    }

    public func cleanupAfterSuccess() throws {
        guard candidateHealthPassed else { throw CompanionUpdaterError.unsafeFilesystem }
        try assertInstalledCandidateUnchanged()
        try assertRollbackPriorUnchanged()
        try Self.removeTree(
            parentDescriptor: supportDescriptor,
            name: paths.rollbackApplication.lastPathComponent
        )
        try removeWorkspace()
    }

    public func cleanupAfterRollback() throws {
        try assertPriorInstalledUnchanged()
        try assertFailedCandidateUnchanged()
        try Self.requireMissing(descriptor: supportDescriptor, name: paths.rollbackApplication.lastPathComponent)
        try removeWorkspace()
    }

    public func cleanupAfterNoSwap() throws {
        guard !hasSwapped else { throw CompanionUpdaterError.unsafeFilesystem }
        try assertPriorInstalledUnchanged()
        try Self.requireMissing(
            descriptor: supportDescriptor,
            name: paths.failedApplication.lastPathComponent
        )

        let candidateIsStaged = Self.exists(
            descriptor: stagingDescriptor,
            name: candidateApplication.lastPathComponent
        )
        let candidateIsPromoted = Self.exists(
            descriptor: supportDescriptor,
            name: promotedName
        )
        guard candidateIsStaged != candidateIsPromoted else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        if candidateIsStaged {
            try assertCandidateUnchanged()
        } else {
            guard let candidateSeal,
                  try Self.sealTree(
                      parentDescriptor: supportDescriptor,
                      name: promotedName
                  ) == candidateSeal else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            try Self.removeTree(parentDescriptor: supportDescriptor, name: promotedName)
        }
        try removeWorkspace()
    }

    public func cleanupBeforeSwap() throws {
        try assertPriorInstalledUnchanged()
        guard !hasSwapped else { throw CompanionUpdaterError.unsafeFilesystem }
        if Self.exists(descriptor: supportDescriptor, name: promotedName) {
            try Self.removeTree(parentDescriptor: supportDescriptor, name: promotedName)
        }
        try removeWorkspace()
    }

    public func prepareStableRecovery() throws {
        if Self.exists(descriptor: supportDescriptor, name: paths.rollbackApplication.lastPathComponent) {
            try assertRollbackPriorUnchanged()
        } else {
            try assertPriorInstalledUnchanged()
            try Self.requireMissing(
                descriptor: supportDescriptor,
                name: paths.rollbackApplication.lastPathComponent
            )
            guard Darwin.renameat(
                supportDescriptor,
                paths.installedApplication.lastPathComponent,
                supportDescriptor,
                paths.rollbackApplication.lastPathComponent
            ) == 0 else { throw Self.posixError() }
            try Self.synchronize(supportDescriptor)
            try assertRollbackPriorUnchanged()
        }
        if Self.exists(descriptor: supportDescriptor, name: paths.failedApplication.lastPathComponent) {
            do {
                try assertFailedCandidateUnchanged()
            } catch {
                guard Self.exists(
                    descriptor: supportDescriptor,
                    name: paths.installedApplication.lastPathComponent
                ) else { throw error }
                try assertInstalledCandidateUnchanged()
            }
        } else if Self.exists(
            descriptor: supportDescriptor,
            name: paths.installedApplication.lastPathComponent
        ) {
            try assertInstalledCandidateUnchanged()
            guard Darwin.renameat(
                supportDescriptor,
                paths.installedApplication.lastPathComponent,
                supportDescriptor,
                paths.failedApplication.lastPathComponent
            ) == 0 else { throw Self.posixError() }
            try Self.synchronize(supportDescriptor)
            try assertFailedCandidateUnchanged()
        }
        guard let priorSeal,
              priorSeal.containsExecutable(relativePath: "Contents/MacOS/runtime-raiders-agent") else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private func assertRollbackPriorUnchanged() throws {
        guard let priorSeal,
              try Self.sealTree(
            parentDescriptor: supportDescriptor,
            name: paths.rollbackApplication.lastPathComponent
        ) == priorSeal else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private func assertFailedCandidateUnchanged() throws {
        guard let candidateSeal,
              try Self.sealTree(
                  parentDescriptor: supportDescriptor,
                  name: paths.failedApplication.lastPathComponent
              ) == candidateSeal else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private func normalizeCandidateRootMode(at name: String) throws {
        guard let candidateSeal else { throw CompanionUpdaterError.unsafeFilesystem }
        let normalized = candidateSeal.replacingRootMode(with: 0o700)
        guard try Self.sealTree(parentDescriptor: supportDescriptor, name: name) == normalized else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        self.candidateSeal = normalized
    }

    private func normalizePriorRootMode(at name: String) throws {
        guard let priorSeal else { throw CompanionUpdaterError.unsafeFilesystem }
        let normalized = priorSeal.replacingRootMode(with: 0o700)
        guard try Self.sealTree(parentDescriptor: supportDescriptor, name: name) == normalized else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        self.priorSeal = normalized
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

    fileprivate struct TreeSeal: Equatable {
        let entries: [SealedEntry]

        func replacingRootMode(with mode: UInt16) -> Self {
            Self(entries: entries.map { entry in
                guard entry.path == "." else { return entry }
                return SealedEntry(
                    path: entry.path,
                    kind: entry.kind,
                    device: entry.device,
                    inode: entry.inode,
                    mode: mode,
                    size: entry.size,
                    modifiedSeconds: entry.modifiedSeconds,
                    modifiedNanoseconds: entry.modifiedNanoseconds,
                    contentSHA256: entry.contentSHA256
                )
            })
        }

        func containsExecutable(relativePath: String) -> Bool {
            entries.contains {
                $0.path == relativePath && $0.kind == UInt16(S_IFREG) && $0.mode & 0o111 != 0
            }
        }
    }

    fileprivate struct SealedEntry: Equatable {
        let path: String
        let kind: UInt16
        let device: UInt64
        let inode: UInt64
        let mode: UInt16
        let size: Int64
        let modifiedSeconds: Int64
        let modifiedNanoseconds: Int64
        let contentSHA256: Data
    }

    private static func sealTree(parentDescriptor: Int32, name: String) throws -> TreeSeal {
        let descriptor = Darwin.openat(
            parentDescriptor,
            name,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(descriptor) }
        var entries: [SealedEntry] = []
        try sealDirectory(descriptor, relativePath: ".", entries: &entries)
        return TreeSeal(entries: entries.sorted { $0.path < $1.path })
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
        entries.append(sealedEntry(relativePath, directoryMetadata, contentSHA256: Data()))
        for name in try directoryNames(descriptor) {
            var metadata = stat()
            guard Darwin.fstatat(descriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_uid == Darwin.geteuid(),
                  metadata.st_mode & 0o022 == 0 else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            let type = metadata.st_mode & S_IFMT
            let path = relativePath == "." ? name : relativePath + "/" + name
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
                let file = Darwin.openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                guard file >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
                defer { Darwin.close(file) }
                entries.append(try sealFile(descriptor: file, relativePath: path, expected: metadata))
            } else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
        }
        var currentDirectoryMetadata = stat()
        guard Darwin.fstat(descriptor, &currentDirectoryMetadata) == 0,
              currentDirectoryMetadata.st_mode == directoryMetadata.st_mode,
              currentDirectoryMetadata.st_dev == directoryMetadata.st_dev,
              currentDirectoryMetadata.st_ino == directoryMetadata.st_ino,
              currentDirectoryMetadata.st_size == directoryMetadata.st_size,
              currentDirectoryMetadata.st_mtimespec.tv_sec == directoryMetadata.st_mtimespec.tv_sec,
              currentDirectoryMetadata.st_mtimespec.tv_nsec == directoryMetadata.st_mtimespec.tv_nsec else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private static func sealFile(
        descriptor: Int32,
        relativePath: String,
        expected: stat
    ) throws -> SealedEntry {
        guard expected.st_mode & S_IFMT == S_IFREG,
              expected.st_uid == Darwin.geteuid(),
              expected.st_mode & 0o022 == 0,
              expected.st_nlink == 1,
              expected.st_size >= 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
        var total: Int64 = 0
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count > 0 {
                hasher.update(data: Data(buffer[0..<count]))
                let (next, overflow) = total.addingReportingOverflow(Int64(count))
                guard !overflow else { throw CompanionUpdaterError.unsafeFilesystem }
                total = next
            } else if count == 0 {
                break
            } else if errno == EINTR {
                continue
            } else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
        }
        var current = stat()
        guard Darwin.fstat(descriptor, &current) == 0,
              current.st_mode & S_IFMT == S_IFREG,
              current.st_dev == expected.st_dev,
              current.st_ino == expected.st_ino,
              current.st_mode == expected.st_mode,
              current.st_size == expected.st_size,
              current.st_mtimespec.tv_sec == expected.st_mtimespec.tv_sec,
              current.st_mtimespec.tv_nsec == expected.st_mtimespec.tv_nsec,
              total == expected.st_size else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        return sealedEntry(
            relativePath,
            current,
            contentSHA256: Data(hasher.finalize())
        )
    }

    private static func sealedEntry(
        _ path: String,
        _ metadata: stat,
        contentSHA256: Data
    ) -> SealedEntry {
        SealedEntry(
            path: path,
            kind: UInt16(metadata.st_mode & S_IFMT),
            device: UInt64(metadata.st_dev),
            inode: UInt64(metadata.st_ino),
            mode: UInt16(metadata.st_mode & 0o7777),
            size: Int64(metadata.st_size),
            modifiedSeconds: Int64(metadata.st_mtimespec.tv_sec),
            modifiedNanoseconds: Int64(metadata.st_mtimespec.tv_nsec),
            contentSHA256: contentSHA256
        )
    }

    private static func treeSize(parentDescriptor: Int32, name: String) throws -> Int64 {
        try sealTree(parentDescriptor: parentDescriptor, name: name).entries.reduce(0) { total, entry in
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

import Darwin
import Foundation

public enum RemovalMode: Equatable, Sendable {
    case preserveState
    case everything
}

public enum RemovalOutcome: Equatable, Sendable {
    case removedPreservingState
    case removedEverything
    case cancelled
    case revocationRequired
    case assistedRecoveryRequired
}

public enum RemovalCoordinatorError: Error, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible {
    case operationFailed

    public var description: String { "Runtime Raiders removal failed" }
    public var debugDescription: String { description }
}

public protocol RemovalLock: AnyObject, Sendable {}

extension LifecycleLock: RemovalLock {}

public struct RemovalOperations: @unchecked Sendable {
    public let acquireLock: () throws -> any RemovalLock
    public let persistCollectionOff: () throws -> Void
    public let stopDaemon: () throws -> Void
    public let unregisterAgent: () throws -> Void
    public let verifyAgentUnregistered: () throws -> Bool
    public let countQueue: () throws -> Int
    public let summarize: (Int) throws -> Void
    public let confirmDiscard: (Int) throws -> Bool
    public let confirmEverything: () throws -> Bool
    public let loadEnrollment: () throws -> EnrollmentConfiguration?
    public let revoke: (EnrollmentConfiguration) throws -> Bool
    public let delayMilliseconds: (Int) throws -> Void
    public let discardQueue: () throws -> Void
    public let removeExecutableArtifacts: () throws -> Void
    public let verifyPreservedState: () throws -> Bool
    public let removeAllArtifacts: () throws -> Void
    public let revocationProof: () throws -> Void

    public init(
        acquireLock: @escaping () throws -> any RemovalLock,
        persistCollectionOff: @escaping () throws -> Void,
        stopDaemon: @escaping () throws -> Void,
        unregisterAgent: @escaping () throws -> Void,
        verifyAgentUnregistered: @escaping () throws -> Bool,
        countQueue: @escaping () throws -> Int,
        summarize: @escaping (Int) throws -> Void,
        confirmDiscard: @escaping (Int) throws -> Bool,
        confirmEverything: @escaping () throws -> Bool,
        loadEnrollment: @escaping () throws -> EnrollmentConfiguration?,
        revoke: @escaping (EnrollmentConfiguration) throws -> Bool,
        delayMilliseconds: @escaping (Int) throws -> Void,
        discardQueue: @escaping () throws -> Void,
        removeExecutableArtifacts: @escaping () throws -> Void,
        verifyPreservedState: @escaping () throws -> Bool,
        removeAllArtifacts: @escaping () throws -> Void,
        revocationProof: @escaping () throws -> Void
    ) {
        self.acquireLock = acquireLock
        self.persistCollectionOff = persistCollectionOff
        self.stopDaemon = stopDaemon
        self.unregisterAgent = unregisterAgent
        self.verifyAgentUnregistered = verifyAgentUnregistered
        self.countQueue = countQueue
        self.summarize = summarize
        self.confirmDiscard = confirmDiscard
        self.confirmEverything = confirmEverything
        self.loadEnrollment = loadEnrollment
        self.revoke = revoke
        self.delayMilliseconds = delayMilliseconds
        self.discardQueue = discardQueue
        self.removeExecutableArtifacts = removeExecutableArtifacts
        self.verifyPreservedState = verifyPreservedState
        self.removeAllArtifacts = removeAllArtifacts
        self.revocationProof = revocationProof
    }

    public static func live(
        paths: CompanionLifecyclePaths,
        managedAgent: ManagedAgentServiceController = .live,
        outbox: Outbox,
        enrollmentClient: EnrollmentClient,
        persistCollectionOff: @escaping () throws -> Void,
        stopDaemon: @escaping () throws -> Void,
        summarize: @escaping (Int) throws -> Void,
        confirmDiscard: @escaping (Int) throws -> Bool,
        confirmEverything: @escaping () throws -> Bool,
        delayMilliseconds: @escaping (Int) throws -> Void,
        acquireLock: (() throws -> any RemovalLock)? = nil
    ) -> RemovalOperations {
        let remover = OwnedInstallationRemover(paths: paths)
        return RemovalOperations(
            acquireLock: acquireLock ?? { try LifecycleLock.acquire(at: paths.lifecycleLock) },
            persistCollectionOff: persistCollectionOff,
            stopDaemon: stopDaemon,
            unregisterAgent: { _ = try managedAgent.perform(.unregister) },
            verifyAgentUnregistered: {
                switch try managedAgent.perform(.status) {
                case .notRegistered, .notFound: true
                case .enabled, .requiresApproval: false
                }
            },
            countQueue: { try outbox.queuedCount() },
            summarize: summarize,
            confirmDiscard: confirmDiscard,
            confirmEverything: confirmEverything,
            loadEnrollment: {
                try remover.prevalidateAllArtifacts()
                return try loadVerifiedEnrollmentIfPresent(paths: paths)
            },
            revoke: { try enrollmentClient.revoke(token: $0.deviceToken) },
            delayMilliseconds: delayMilliseconds,
            discardQueue: {
                _ = try outbox.discardAllValidated()
                guard try outbox.queuedCount() == 0 else {
                    throw RemovalCoordinatorError.operationFailed
                }
            },
            removeExecutableArtifacts: { try remover.removeExecutableArtifacts() },
            verifyPreservedState: {
                guard let state = try OwnerOnlyDirectory.openExisting(
                    paths.agent.stateDirectory
                ) else {
                    return false
                }
                defer { Darwin.close(state) }
                guard let outbox = try OwnerOnlyDirectory.openExisting(
                    paths.agent.outboxDirectory
                ) else { return false }
                Darwin.close(outbox)
                return true
            },
            removeAllArtifacts: {
                try remover.removeAllArtifacts(authorization: CompleteRemovalAuthorization())
            },
            revocationProof: {}
        )
    }
}

public struct RemovalCoordinator: Sendable {
    private static let retryDelaysMilliseconds = [100, 250, 500, 1_000]
    private let operations: RemovalOperations

    public init(operations: RemovalOperations) {
        self.operations = operations
    }

    public func run(mode: RemovalMode) throws -> RemovalOutcome {
        do {
            return try runLocked(mode: mode)
        } catch is RemovalCoordinatorError {
            throw RemovalCoordinatorError.operationFailed
        } catch {
            throw RemovalCoordinatorError.operationFailed
        }
    }

    private func runLocked(mode: RemovalMode) throws -> RemovalOutcome {
        let lock = try operations.acquireLock()
        defer { _ = lock }
        try operations.persistCollectionOff()
        try operations.stopDaemon()
        try operations.unregisterAgent()
        guard try operations.verifyAgentUnregistered() else {
            throw RemovalCoordinatorError.operationFailed
        }

        switch mode {
        case .preserveState:
            try operations.removeExecutableArtifacts()
            guard try operations.verifyPreservedState() else {
                throw RemovalCoordinatorError.operationFailed
            }
            return .removedPreservingState
        case .everything:
            return try removeEverything()
        }
    }

    private func removeEverything() throws -> RemovalOutcome {
        let queueCount = try operations.countQueue()
        guard queueCount >= 0 else { throw RemovalCoordinatorError.operationFailed }
        try operations.summarize(queueCount)
        if queueCount > 0, try !operations.confirmDiscard(queueCount) {
            return .cancelled
        }
        guard try operations.confirmEverything() else { return .cancelled }

        let enrollment: EnrollmentConfiguration?
        do {
            enrollment = try operations.loadEnrollment()
        } catch {
            return .assistedRecoveryRequired
        }

        if let enrollment {
            guard try proveRevoked(enrollment) else { return .revocationRequired }
        }
        if queueCount > 0 { try operations.discardQueue() }
        try operations.removeAllArtifacts()
        return .removedEverything
    }

    private func proveRevoked(_ enrollment: EnrollmentConfiguration) throws -> Bool {
        for attempt in 0...Self.retryDelaysMilliseconds.count {
            let revoked: Bool
            do {
                revoked = try operations.revoke(enrollment)
            } catch {
                if attempt == Self.retryDelaysMilliseconds.count { return false }
                try operations.delayMilliseconds(Self.retryDelaysMilliseconds[attempt])
                continue
            }
            if revoked {
                do {
                    try operations.revocationProof()
                    return true
                } catch {
                    return false
                }
            }
            if attempt == Self.retryDelaysMilliseconds.count { return false }
            try operations.delayMilliseconds(Self.retryDelaysMilliseconds[attempt])
        }
        return false
    }
}

private func loadVerifiedEnrollmentIfPresent(
    paths: CompanionLifecyclePaths
) throws -> EnrollmentConfiguration? {
    guard let stateDescriptor = try OwnerOnlyDirectory.openExisting(
        paths.agent.stateDirectory
    ) else { return nil }
    defer { Darwin.close(stateDescriptor) }
    var directoryMetadata = stat()
    var enrollmentMetadata = stat()
    guard Darwin.fstat(stateDescriptor, &directoryMetadata) == 0 else {
        throw EnrollmentConfigurationError.invalidFile
    }
    guard Darwin.fstatat(
        stateDescriptor,
        paths.enrollment.lastPathComponent,
        &enrollmentMetadata,
        AT_SYMLINK_NOFOLLOW
    ) == 0 else {
        if errno == ENOENT { return nil }
        throw EnrollmentConfigurationError.invalidFile
    }
    guard enrollmentMetadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          enrollmentMetadata.st_uid == Darwin.geteuid(),
          enrollmentMetadata.st_mode & 0o7777 == 0o600,
          enrollmentMetadata.st_nlink == 1,
          enrollmentMetadata.st_dev == directoryMetadata.st_dev else {
        throw EnrollmentConfigurationError.invalidFile
    }
    return try EnrollmentConfiguration.loadExisting(from: paths.enrollment)
}

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

protocol RemovalSession: AnyObject, Sendable {}

struct RemovalQueueSnapshot: @unchecked Sendable {
    let sessionIdentifier: ObjectIdentifier
    let names: [String]
    var count: Int { names.count }

    func belongs(to session: any RemovalSession) -> Bool {
        sessionIdentifier == ObjectIdentifier(session)
    }
}

struct CompleteRemovalAuthorization: @unchecked Sendable {
    private let sessionIdentifier: ObjectIdentifier

    fileprivate init(session: any RemovalSession) {
        sessionIdentifier = ObjectIdentifier(session)
    }

    func authorizes(_ session: any RemovalSession) -> Bool {
        sessionIdentifier == ObjectIdentifier(session)
    }
}

public struct RemovalOperations: @unchecked Sendable {
    let acquireLock: () throws -> any RemovalLock
    let persistCollectionOff: () throws -> Void
    let stopDaemon: () throws -> Void
    let unregisterAgent: () throws -> Void
    let verifyAgentUnregistered: () throws -> Bool
    let prepareSession: () throws -> any RemovalSession
    let queueSnapshot: (any RemovalSession) throws -> RemovalQueueSnapshot
    let summarize: (Int) throws -> Void
    let confirmDiscard: (Int) throws -> Bool
    let confirmEverything: () throws -> Bool
    let loadEnrollment: (any RemovalSession) throws -> EnrollmentConfiguration?
    let revoke: (EnrollmentConfiguration) throws -> Bool
    let delayMilliseconds: (Int) throws -> Void
    let discardQueue: (any RemovalSession, RemovalQueueSnapshot) throws -> Void
    let verifyQueueEmpty: (any RemovalSession, RemovalQueueSnapshot) throws -> Bool
    let removeExecutableArtifacts: (any RemovalSession) throws -> Void
    let verifyPreservedState: (any RemovalSession) throws -> Bool
    let removeAllArtifacts: (
        any RemovalSession,
        CompleteRemovalAuthorization
    ) throws -> Void
    let revocationProof: () throws -> Void

    init(
        acquireLock: @escaping () throws -> any RemovalLock,
        persistCollectionOff: @escaping () throws -> Void,
        stopDaemon: @escaping () throws -> Void,
        unregisterAgent: @escaping () throws -> Void,
        verifyAgentUnregistered: @escaping () throws -> Bool,
        prepareSession: @escaping () throws -> any RemovalSession,
        queueSnapshot: @escaping (any RemovalSession) throws -> RemovalQueueSnapshot,
        summarize: @escaping (Int) throws -> Void,
        confirmDiscard: @escaping (Int) throws -> Bool,
        confirmEverything: @escaping () throws -> Bool,
        loadEnrollment: @escaping (any RemovalSession) throws -> EnrollmentConfiguration?,
        revoke: @escaping (EnrollmentConfiguration) throws -> Bool,
        delayMilliseconds: @escaping (Int) throws -> Void,
        discardQueue: @escaping (
            any RemovalSession,
            RemovalQueueSnapshot
        ) throws -> Void,
        verifyQueueEmpty: @escaping (
            any RemovalSession,
            RemovalQueueSnapshot
        ) throws -> Bool,
        removeExecutableArtifacts: @escaping (any RemovalSession) throws -> Void,
        verifyPreservedState: @escaping (any RemovalSession) throws -> Bool,
        removeAllArtifacts: @escaping (
            any RemovalSession,
            CompleteRemovalAuthorization
        ) throws -> Void,
        revocationProof: @escaping () throws -> Void
    ) {
        self.acquireLock = acquireLock
        self.persistCollectionOff = persistCollectionOff
        self.stopDaemon = stopDaemon
        self.unregisterAgent = unregisterAgent
        self.verifyAgentUnregistered = verifyAgentUnregistered
        self.prepareSession = prepareSession
        self.queueSnapshot = queueSnapshot
        self.summarize = summarize
        self.confirmDiscard = confirmDiscard
        self.confirmEverything = confirmEverything
        self.loadEnrollment = loadEnrollment
        self.revoke = revoke
        self.delayMilliseconds = delayMilliseconds
        self.discardQueue = discardQueue
        self.verifyQueueEmpty = verifyQueueEmpty
        self.removeExecutableArtifacts = removeExecutableArtifacts
        self.verifyPreservedState = verifyPreservedState
        self.removeAllArtifacts = removeAllArtifacts
        self.revocationProof = revocationProof
    }

    public static func live(
        paths: CompanionLifecyclePaths,
        managedAgent: ManagedAgentServiceController = .live,
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
            prepareSession: { try remover.prepareSession() },
            queueSnapshot: { session in
                guard let session = session as? OwnedInstallationRemovalSession else {
                    throw RemovalCoordinatorError.operationFailed
                }
                return try session.validatedQueueSnapshot()
            },
            summarize: summarize,
            confirmDiscard: confirmDiscard,
            confirmEverything: confirmEverything,
            loadEnrollment: { session in
                guard let session = session as? OwnedInstallationRemovalSession else {
                    throw RemovalCoordinatorError.operationFailed
                }
                return try session.loadEnrollment()
            },
            revoke: { try enrollmentClient.revoke(token: $0.deviceToken) },
            delayMilliseconds: delayMilliseconds,
            discardQueue: { session, snapshot in
                guard let session = session as? OwnedInstallationRemovalSession else {
                    throw RemovalCoordinatorError.operationFailed
                }
                try session.discardValidatedQueue(snapshot)
            },
            verifyQueueEmpty: { session, snapshot in
                guard let session = session as? OwnedInstallationRemovalSession else {
                    throw RemovalCoordinatorError.operationFailed
                }
                return try session.verifyQueueEmpty(snapshot)
            },
            removeExecutableArtifacts: { session in
                guard let session = session as? OwnedInstallationRemovalSession else {
                    throw RemovalCoordinatorError.operationFailed
                }
                try session.removeExecutableArtifacts()
            },
            verifyPreservedState: { session in
                guard let session = session as? OwnedInstallationRemovalSession else {
                    throw RemovalCoordinatorError.operationFailed
                }
                return try session.verifyPreservedState()
            },
            removeAllArtifacts: { session, authorization in
                guard let session = session as? OwnedInstallationRemovalSession else {
                    throw RemovalCoordinatorError.operationFailed
                }
                try session.removeAllArtifacts(authorization: authorization)
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
        let session = try operations.prepareSession()

        switch mode {
        case .preserveState:
            try operations.removeExecutableArtifacts(session)
            guard try operations.verifyPreservedState(session) else {
                throw RemovalCoordinatorError.operationFailed
            }
            return .removedPreservingState
        case .everything:
            return try removeEverything(session: session)
        }
    }

    private func removeEverything(session: any RemovalSession) throws -> RemovalOutcome {
        let snapshot = try operations.queueSnapshot(session)
        guard snapshot.belongs(to: session) else {
            throw RemovalCoordinatorError.operationFailed
        }
        let queueCount = snapshot.count
        try operations.summarize(queueCount)
        if queueCount > 0, try !operations.confirmDiscard(queueCount) {
            return .cancelled
        }
        guard try operations.confirmEverything() else { return .cancelled }

        let enrollment: EnrollmentConfiguration?
        do {
            enrollment = try operations.loadEnrollment(session)
        } catch {
            return .assistedRecoveryRequired
        }

        if let enrollment {
            guard try proveRevoked(enrollment) else { return .revocationRequired }
        }
        let authorization = CompleteRemovalAuthorization(session: session)
        if queueCount > 0 { try operations.discardQueue(session, snapshot) }
        guard try operations.verifyQueueEmpty(session, snapshot) else {
            throw RemovalCoordinatorError.operationFailed
        }
        try operations.removeAllArtifacts(session, authorization)
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

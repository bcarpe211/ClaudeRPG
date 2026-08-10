import Darwin
import Foundation

@_silgen_name("flock")
private func preparedStartupFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

public final class CompanionPreparedStartupLease {
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
            paths.preparedStartupLease.lastPathComponent,
            O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        do {
            try Self.validate(descriptor)
        } catch {
            Darwin.close(descriptor)
            descriptor = -1
            throw error
        }
        guard preparedStartupFlock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockError = errno
            Darwin.close(descriptor)
            descriptor = -1
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                throw CompanionUpdaterError.updateInProgress
            }
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    public static func observe(paths: AgentPaths) throws -> CompanionPreparedStartupObservation? {
        let stateDescriptor: Int32
        do {
            guard let existing = try OwnerOnlyDirectory.openExisting(paths.stateDirectory) else {
                return nil
            }
            stateDescriptor = existing
        } catch {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        defer { Darwin.close(stateDescriptor) }
        let descriptor = Darwin.openat(
            stateDescriptor,
            paths.preparedStartupLease.lastPathComponent,
            O_RDWR | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            if errno == ENOENT { return nil }
            throw CompanionUpdaterError.unsafeFilesystem
        }
        do {
            try validate(descriptor)
        } catch {
            Darwin.close(descriptor)
            throw error
        }
        if preparedStartupFlock(descriptor, LOCK_SH | LOCK_NB) == 0 {
            _ = preparedStartupFlock(descriptor, LOCK_UN)
            Darwin.close(descriptor)
            return nil
        }
        if errno == EWOULDBLOCK || errno == EAGAIN {
            return CompanionPreparedStartupObservation(descriptor: descriptor)
        }
        Darwin.close(descriptor)
        throw CompanionUpdaterError.unsafeFilesystem
    }

    deinit { unlock() }

    public func unlock() {
        guard descriptor >= 0 else { return }
        _ = preparedStartupFlock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
        descriptor = -1
    }

    private static func validate(_ descriptor: Int32) throws {
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }
}

public final class CompanionPreparedStartupObservation: @unchecked Sendable {
    private let stateLock = NSLock()
    private var descriptor: Int32

    fileprivate init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    deinit { close() }

    fileprivate func waitUntilReleased() throws {
        let observedDescriptor = stateLock.withLock { descriptor }
        guard observedDescriptor >= 0 else { return }
        while preparedStartupFlock(observedDescriptor, LOCK_SH) != 0 {
            if errno == EINTR { continue }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        stateLock.withLock {
            guard descriptor == observedDescriptor else { return }
            _ = preparedStartupFlock(observedDescriptor, LOCK_UN)
            Darwin.close(observedDescriptor)
            descriptor = -1
        }
    }

    private func close() {
        stateLock.withLock {
            guard descriptor >= 0 else { return }
            Darwin.close(descriptor)
            descriptor = -1
        }
    }
}

public enum InstallerPreparedLeaseKeeper {
    public static let readinessLine = "runtime-raiders-installer-lease-ready\n"

    public static func run(
        paths: AgentPaths,
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput
    ) throws {
        try run(paths: paths, input: input, output: output, onReady: {})
    }

    static func run(
        paths: AgentPaths,
        input: FileHandle,
        output: FileHandle,
        onReady: () throws -> Void
    ) throws {
        let lease = try CompanionPreparedStartupLease(paths: paths)
        try output.write(contentsOf: Data(readinessLine.utf8))
        try onReady()
        while let data = try input.read(upToCount: 4_096), !data.isEmpty {}
        withExtendedLifetime(lease) {}
    }
}

public enum PreparedReleaseDisposition: Equatable, Sendable {
    case resumeCommittedActive
    case exitUncommittedTrial
    case failClosed
}

public enum PreparedDaemonStartupError: Error, Equatable {
    case invalidReleaseState
}

public final class PreparedDaemonStartupCoordinator: @unchecked Sendable {
    private enum State {
        case pending
        case starting
        case started
    }

    private let paths: AgentPaths
    private let releaseIdentity: CompanionReleaseIdentity?
    private let startedAsTrial: Bool
    private let loadReleaseState: @Sendable () throws -> ReleaseStateV1
    private let observationLock = NSLock()
    private var observation: CompanionPreparedStartupObservation?
    private let deferredStart: () throws -> Void
    private let stateLock = NSLock()
    private var state = State.pending

    public let startsPrepared: Bool
    public let initiallyPreparedGeneration: Int64?

    public init(
        paths: AgentPaths,
        trialGeneration: Int64? = nil,
        releaseIdentity: CompanionReleaseIdentity? = nil,
        loadReleaseState: (@Sendable () throws -> ReleaseStateV1)? = nil,
        deferredStart: @escaping () throws -> Void
    ) throws {
        self.paths = paths
        self.releaseIdentity = releaseIdentity
        startedAsTrial = trialGeneration != nil
        self.loadReleaseState = loadReleaseState ?? {
            try ReleaseStateStore.loadExisting(paths: paths)
        }
        let observed = try CompanionPreparedStartupLease.observe(paths: paths)
        observation = observed
        startsPrepared = observed != nil
        if let releaseIdentity, observed != nil {
            let state = try self.loadReleaseState()
            guard ReleaseStateV1.isValid(state) else {
                throw PreparedDaemonStartupError.invalidReleaseState
            }
            if let trialGeneration {
                guard state.generation == trialGeneration,
                      state.trial.flatMap({ try? $0.companionReleaseIdentity() }) == releaseIdentity else {
                    throw PreparedDaemonStartupError.invalidReleaseState
                }
            } else {
                guard (try? state.active.companionReleaseIdentity()) == releaseIdentity else {
                    throw PreparedDaemonStartupError.invalidReleaseState
                }
            }
            initiallyPreparedGeneration = state.generation
        } else {
            guard trialGeneration == nil else {
                throw PreparedDaemonStartupError.invalidReleaseState
            }
            initiallyPreparedGeneration = nil
        }
        self.deferredStart = deferredStart
    }

    public static func validatePreparation(
        generation: Int64,
        releaseIdentity: CompanionReleaseIdentity,
        releaseState: ReleaseStateV1,
        leaseHeld: Bool
    ) throws {
        guard ReleaseStateV1.isValid(releaseState),
              releaseState.generation == generation,
              (try? releaseState.active.companionReleaseIdentity()) == releaseIdentity,
              releaseState.trial != nil,
              leaseHeld else {
            throw PreparedDaemonStartupError.invalidReleaseState
        }
    }

    public static func disposition(
        preparedGeneration: Int64,
        startedAsTrial: Bool,
        releaseIdentity: CompanionReleaseIdentity,
        releaseState: ReleaseStateV1
    ) -> PreparedReleaseDisposition {
        guard ReleaseStateV1.isValid(releaseState),
              releaseState.generation >= preparedGeneration else {
            return .failClosed
        }
        if (try? releaseState.active.companionReleaseIdentity()) == releaseIdentity {
            return .resumeCommittedActive
        }
        if startedAsTrial,
           releaseState.generation == preparedGeneration,
           releaseState.trial.flatMap({ try? $0.companionReleaseIdentity() }) == releaseIdentity {
            return .exitUncommittedTrial
        }
        return .failClosed
    }

    public func validatePreparation(generation: Int64) throws {
        guard let releaseIdentity else { throw PreparedDaemonStartupError.invalidReleaseState }
        let observed = try CompanionPreparedStartupLease.observe(paths: paths)
        guard let observed else { throw PreparedDaemonStartupError.invalidReleaseState }
        do {
            try Self.validatePreparation(
                generation: generation,
                releaseIdentity: releaseIdentity,
                releaseState: try loadReleaseState(),
                leaseHeld: true
            )
            observationLock.withLock { observation = observed }
        } catch {
            throw PreparedDaemonStartupError.invalidReleaseState
        }
    }

    public func validateResume(generation: Int64) throws {
        guard let releaseIdentity,
              let state = try? loadReleaseState(),
              ReleaseStateV1.isValid(state),
              state.generation == generation,
              (try? state.active.companionReleaseIdentity()) == releaseIdentity,
              state.trial == nil else {
            throw PreparedDaemonStartupError.invalidReleaseState
        }
    }

    public func start() throws {
        if !startsPrepared { try resume() }
    }

    public func resume() throws {
        let shouldStart = stateLock.withLock { () -> Bool in
            guard state == .pending else { return false }
            state = .starting
            return true
        }
        guard shouldStart else { return }
        do {
            try deferredStart()
            stateLock.withLock { state = .started }
        } catch {
            stateLock.withLock { state = .pending }
            throw error
        }
    }

    public func monitorAbandonment(
        on queue: DispatchQueue,
        whenReleased: @escaping @Sendable () -> Void
    ) {
        guard let observation = observationLock.withLock({ observation }) else { return }
        queue.async {
            guard (try? observation.waitUntilReleased()) != nil else { return }
            whenReleased()
        }
    }

    public func monitorReleaseAbandonment(
        generation: Int64,
        on queue: DispatchQueue,
        whenReleased: @escaping @Sendable (PreparedReleaseDisposition) -> Void
    ) {
        guard let observation = observationLock.withLock({ observation }),
              let releaseIdentity else { return }
        let loadReleaseState = self.loadReleaseState
        let startedAsTrial = self.startedAsTrial
        queue.async {
            guard (try? observation.waitUntilReleased()) != nil else {
                whenReleased(.failClosed)
                return
            }
            guard let state = try? loadReleaseState() else {
                whenReleased(.failClosed)
                return
            }
            whenReleased(Self.disposition(
                preparedGeneration: generation,
                startedAsTrial: startedAsTrial,
                releaseIdentity: releaseIdentity,
                releaseState: state
            ))
        }
    }
}

public final class PreparedReleaseAbandonmentOrchestrator: @unchecked Sendable {
    private let coordinator: PreparedDaemonStartupCoordinator
    private let queue: DispatchQueue
    private let preparedGeneration: @Sendable () -> Int64?
    private let resumeAfterAbandonment: @Sendable (Int64) -> ControlResponse
    private let exitUncommittedTrial: @Sendable () -> Void
    private let failClosed: @Sendable () -> Void

    public init(
        coordinator: PreparedDaemonStartupCoordinator,
        queue: DispatchQueue,
        preparedGeneration: @escaping @Sendable () -> Int64?,
        resumeAfterAbandonment: @escaping @Sendable (Int64) -> ControlResponse,
        exitUncommittedTrial: @escaping @Sendable () -> Void,
        failClosed: @escaping @Sendable () -> Void
    ) {
        self.coordinator = coordinator
        self.queue = queue
        self.preparedGeneration = preparedGeneration
        self.resumeAfterAbandonment = resumeAfterAbandonment
        self.exitUncommittedTrial = exitUncommittedTrial
        self.failClosed = failClosed
    }

    public func start(generation: Int64) {
        coordinator.monitorReleaseAbandonment(
            generation: generation,
            on: queue
        ) { [preparedGeneration, resumeAfterAbandonment, exitUncommittedTrial, failClosed] disposition in
            guard preparedGeneration() == generation else { return }
            switch disposition {
            case .resumeCommittedActive:
                let response = resumeAfterAbandonment(generation)
                guard !response.ok else { return }
                // Explicit resume may have held the serialized work queue after
                // the check above and completed before this call acquired it.
                guard preparedGeneration() == generation else { return }
                failClosed()
            case .exitUncommittedTrial:
                exitUncommittedTrial()
            case .failClosed:
                failClosed()
            }
        }
    }
}

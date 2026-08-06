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

public final class PreparedDaemonStartupCoordinator: @unchecked Sendable {
    private enum State {
        case pending
        case starting
        case started
    }

    private let observation: CompanionPreparedStartupObservation?
    private let deferredStart: () throws -> Void
    private let stateLock = NSLock()
    private var state = State.pending

    public let startsPrepared: Bool

    public init(paths: AgentPaths, deferredStart: @escaping () throws -> Void) throws {
        observation = try CompanionPreparedStartupLease.observe(paths: paths)
        startsPrepared = observation != nil
        self.deferredStart = deferredStart
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
        guard let observation else { return }
        queue.async {
            guard (try? observation.waitUntilReleased()) != nil else { return }
            whenReleased()
        }
    }
}

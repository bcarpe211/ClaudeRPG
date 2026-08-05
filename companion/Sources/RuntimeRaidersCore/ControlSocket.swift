import Darwin
import Foundation

@_silgen_name("flock")
private func runtimeRaidersFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

public enum ControlCommand: String, CaseIterable, Codable, Sendable {
    case daemon
    case on
    case off
    case status
    case doctor
    case uninstall
    case prepareUpdate = "prepare_update"
    case resumeUpdate = "resume_update"
}

public enum CompanionCommandRoute: Equatable, Sendable {
    case daemon
    case control(ControlCommand)
    case foregroundUpdate
    case selfCheck
    case recoverUpdate
}

public enum CompanionCommandRouter {
    public static func route(
        arguments: [String],
        executableURL: URL,
        paths: AgentPaths
    ) -> CompanionCommandRoute? {
        guard arguments.count == 1, let argument = arguments.first else { return nil }
        switch argument {
        case "on", "off", "status", "doctor", "uninstall":
            guard let command = ControlCommand(rawValue: argument) else { return nil }
            return .control(command)
        case "update":
            return .foregroundUpdate
        case "daemon":
            return exactExecutable(executableURL, equals: installedExecutable(paths))
                ? .daemon : nil
        case "__self-check":
            return .selfCheck
        case "__recover-update":
            return exactExecutable(executableURL, equals: rollbackExecutable(paths))
                ? .recoverUpdate : nil
        default:
            return nil
        }
    }

    private static func installedExecutable(_ paths: AgentPaths) -> URL {
        paths.installedApplication.appendingPathComponent(
            "Contents/MacOS/runtime-raiders-agent",
            isDirectory: false
        )
    }

    private static func rollbackExecutable(_ paths: AgentPaths) -> URL {
        paths.rollbackApplication.appendingPathComponent(
            "Contents/MacOS/runtime-raiders-agent",
            isDirectory: false
        )
    }

    private static func exactExecutable(_ first: URL, equals second: URL) -> Bool {
        first.isFileURL &&
            second.isFileURL &&
            first.standardizedFileURL.path == second.standardizedFileURL.path
    }
}

public enum CompanionSelfCheck {
    public static func encode(_ identity: CompanionReleaseIdentity) throws -> Data {
        struct Payload: Encodable {
            let companionVersion: String
            let releaseSequence: Int64
            let releaseSHA: String
            let updateProtocolVersion: Int

            enum CodingKeys: String, CodingKey {
                case companionVersion = "companion_version"
                case releaseSequence = "release_sequence"
                case releaseSHA = "release_sha"
                case updateProtocolVersion = "update_protocol_version"
            }
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(Payload(
            companionVersion: identity.companionVersion,
            releaseSequence: identity.releaseSequence,
            releaseSHA: identity.releaseSHA,
            updateProtocolVersion: identity.updateProtocolVersion
        ))
        data.append(0x0A)
        return data
    }
}

public final class SerializedUpdatePreparation: @unchecked Sendable {
    private let workQueue: DispatchQueue
    private let activeRunCount: () throws -> Int
    private let pauseAcceptance: () -> Void
    private let pauseUploader: () -> Void
    private let pauseHeartbeat: () -> Void
    private let pauseWatcher: () -> Void
    private let resumeAction: () throws -> Void
    private let acceptedResponse: () throws -> ControlResponse
    private let stateLock = NSLock()
    private var prepared = false

    public var isPrepared: Bool { stateLock.withLock { prepared } }

    public init(
        workQueue: DispatchQueue,
        activeRunCount: @escaping () throws -> Int,
        pauseAcceptance: @escaping () -> Void,
        pauseUploader: @escaping () -> Void,
        pauseHeartbeat: @escaping () -> Void,
        pauseWatcher: @escaping () -> Void,
        resume: @escaping () throws -> Void = {},
        acceptedResponse: @escaping () throws -> ControlResponse = {
            ControlResponse(ok: true, message: "prepared for update")
        }
    ) {
        self.workQueue = workQueue
        self.activeRunCount = activeRunCount
        self.pauseAcceptance = pauseAcceptance
        self.pauseUploader = pauseUploader
        self.pauseHeartbeat = pauseHeartbeat
        self.pauseWatcher = pauseWatcher
        resumeAction = resume
        self.acceptedResponse = acceptedResponse
    }

    public func prepare() -> ControlResponse {
        workQueue.sync {
            do {
                guard try activeRunCount() == 0 else {
                    return ControlResponse(ok: false, message: "active Run prevents update")
                }
                pauseAcceptance()
                pauseUploader()
                pauseHeartbeat()
                pauseWatcher()
                stateLock.withLock { prepared = true }
                return try acceptedResponse()
            } catch {
                return ControlResponse(ok: false, message: "unable to prepare update")
            }
        }
    }

    public func resume() -> ControlResponse {
        workQueue.sync {
            do {
                guard isPrepared else { return try acceptedResponse() }
                try resumeAction()
                stateLock.withLock { prepared = false }
                return try acceptedResponse()
            } catch {
                return ControlResponse(ok: false, message: "unable to resume after update")
            }
        }
    }
}

public enum LaunchdJobControllerError: Error, Equatable {
    case unsafeLaunchAgent
    case commandFailed
}

public struct LaunchdJobController {
    public typealias Command = (
        _ executable: URL,
        _ arguments: [String],
        _ timeout: TimeInterval
    ) throws -> SystemCommandResult

    private static let label = "com.redlattice.runtime-raiders-agent"
    private static let executable = URL(fileURLWithPath: "/bin/launchctl")
    private let userIdentifier: uid_t
    private let plistURL: URL
    private let runCommand: Command

    public init(
        userIdentifier: uid_t = Darwin.geteuid(),
        plistURL: URL,
        runCommand: @escaping Command
    ) {
        self.userIdentifier = userIdentifier
        self.plistURL = plistURL.standardizedFileURL
        self.runCommand = runCommand
    }

    public func bootout() throws {
        let result = try runCommand(
            Self.executable,
            ["bootout", jobTarget],
            10
        )
        guard result.exitStatus == .exited(0) else {
            throw LaunchdJobControllerError.commandFailed
        }
    }

    public func bootstrap() throws {
        try validateLaunchAgent()
        let result = try runCommand(
            Self.executable,
            ["bootstrap", domainTarget, plistURL.path],
            10
        )
        guard result.exitStatus == .exited(0) else {
            throw LaunchdJobControllerError.commandFailed
        }
    }

    public func restart() throws {
        let result = try runCommand(
            Self.executable,
            ["kickstart", "-k", jobTarget],
            10
        )
        guard result.exitStatus == .exited(0) else {
            throw LaunchdJobControllerError.commandFailed
        }
    }

    public func proveStopped() -> Bool {
        guard let result = try? runCommand(
            Self.executable,
            ["print", jobTarget],
            5
        ),
        result.exitStatus == .exited(113),
        result.stdout.isEmpty,
        String(decoding: result.stderr, as: UTF8.self).contains("Could not find service") else {
            return false
        }
        return true
    }

    private var domainTarget: String { "gui/\(userIdentifier)" }
    private var jobTarget: String { "\(domainTarget)/\(Self.label)" }

    private func validateLaunchAgent() throws {
        guard plistURL.isFileURL,
              plistURL.path.hasPrefix("/"),
              plistURL.lastPathComponent == "\(Self.label).plist" else {
            throw LaunchdJobControllerError.unsafeLaunchAgent
        }
        var metadata = stat()
        guard Darwin.lstat(plistURL.path, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            throw LaunchdJobControllerError.unsafeLaunchAgent
        }
    }
}

public enum StableUpdateRecoveryError: Error, Equatable {
    case daemonNotProvenStopped
    case healthVerificationFailed
    case retrySafetyFailure
}

public enum StableRecoveryPhase: Equatable, Sendable {
    case rollbackOnly
    case rollbackAndFailed
}

enum StableRecoveryRestoreFault {
    case parentSynchronize
    case installedPostcheck
    case failedCandidatePostcheck
}

public final class StableRecoveryFileTransaction {
    private struct Entry: Equatable {
        let device: UInt64
        let inode: UInt64
        let mode: UInt16
    }

    private struct Snapshot {
        let phase: StableRecoveryPhase
        let rollback: Entry
        let failed: Entry?
    }

    private let paths: AgentPaths
    private let supportDescriptor: Int32
    private let restoreFault: (StableRecoveryRestoreFault) throws -> Void
    private var snapshot: Snapshot?

    public convenience init(paths: AgentPaths) throws {
        try self.init(paths: paths, restoreFault: { _ in })
    }

    init(
        paths: AgentPaths,
        restoreFault: @escaping (StableRecoveryRestoreFault) throws -> Void
    ) throws {
        self.paths = paths
        guard let descriptor = try OwnerOnlyDirectory.openExisting(paths.supportDirectory) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        supportDescriptor = descriptor
        self.restoreFault = restoreFault
    }

    deinit { Darwin.close(supportDescriptor) }

    public func inspectAndNormalize() throws -> StableRecoveryPhase {
        try requireMissing(paths.installedApplication.lastPathComponent)
        let rollbackName = paths.rollbackApplication.lastPathComponent
        let rollbackBefore = try ownedDirectory(rollbackName, allowSafeReadableMode: true)
        let failedName = paths.failedApplication.lastPathComponent
        let failed: Entry?
        let phase: StableRecoveryPhase
        if exists(failedName) {
            failed = try ownedDirectory(failedName, allowSafeReadableMode: false)
            phase = .rollbackAndFailed
        } else {
            try requireMissing(failedName)
            failed = nil
            phase = .rollbackOnly
        }
        let rollbackDescriptor = Darwin.openat(
            supportDescriptor,
            rollbackName,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard rollbackDescriptor >= 0 else { throw CompanionUpdaterError.unsafeFilesystem }
        defer { Darwin.close(rollbackDescriptor) }
        var rollbackMetadata = stat()
        guard Darwin.fstat(rollbackDescriptor, &rollbackMetadata) == 0,
              UInt64(rollbackMetadata.st_dev) == rollbackBefore.device,
              UInt64(rollbackMetadata.st_ino) == rollbackBefore.inode,
              Darwin.fchmod(rollbackDescriptor, 0o700) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        let rollback = try ownedDirectory(rollbackName, allowSafeReadableMode: false)
        guard rollback.device == rollbackBefore.device,
              rollback.inode == rollbackBefore.inode else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        snapshot = Snapshot(phase: phase, rollback: rollback, failed: failed)
        return phase
    }

    public func restore(phase: StableRecoveryPhase) throws {
        guard let snapshot, snapshot.phase == phase,
              try ownedDirectory(
                  paths.rollbackApplication.lastPathComponent,
                  allowSafeReadableMode: false
              ) == snapshot.rollback else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        try requireMissing(paths.installedApplication.lastPathComponent)
        switch (phase, snapshot.failed) {
        case (.rollbackOnly, nil):
            try requireMissing(paths.failedApplication.lastPathComponent)
        case let (.rollbackAndFailed, failed?):
            guard try ownedDirectory(
                paths.failedApplication.lastPathComponent,
                allowSafeReadableMode: false
            ) == failed else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
        default:
            throw CompanionUpdaterError.unsafeFilesystem
        }
        guard Darwin.renameat(
            supportDescriptor,
            paths.rollbackApplication.lastPathComponent,
            supportDescriptor,
            paths.installedApplication.lastPathComponent
        ) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        do {
            try restoreFault(.parentSynchronize)
            try synchronize()
            try restoreFault(.installedPostcheck)
            guard try ownedDirectory(
                paths.installedApplication.lastPathComponent,
                allowSafeReadableMode: false
            ) == snapshot.rollback else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
            if let failed = snapshot.failed {
                try restoreFault(.failedCandidatePostcheck)
                guard try ownedDirectory(
                    paths.failedApplication.lastPathComponent,
                    allowSafeReadableMode: false
                ) == failed else {
                    throw CompanionUpdaterError.unsafeFilesystem
                }
            } else {
                try requireMissing(paths.failedApplication.lastPathComponent)
            }
        } catch {
            let postRenameError = error
            do {
                try revertRestore(phase: phase)
            } catch {
                throw StableUpdateRecoveryError.retrySafetyFailure
            }
            throw postRenameError
        }
    }

    public func revertRestore(phase: StableRecoveryPhase) throws {
        guard let snapshot, snapshot.phase == phase,
              try ownedDirectory(
                  paths.installedApplication.lastPathComponent,
                  allowSafeReadableMode: false
              ) == snapshot.rollback else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        try requireMissing(paths.rollbackApplication.lastPathComponent)
        switch (phase, snapshot.failed) {
        case (.rollbackOnly, nil):
            try requireMissing(paths.failedApplication.lastPathComponent)
        case let (.rollbackAndFailed, failed?):
            guard try ownedDirectory(
                paths.failedApplication.lastPathComponent,
                allowSafeReadableMode: false
            ) == failed else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
        default:
            throw CompanionUpdaterError.unsafeFilesystem
        }
        guard Darwin.renameat(
            supportDescriptor,
            paths.installedApplication.lastPathComponent,
            supportDescriptor,
            paths.rollbackApplication.lastPathComponent
        ) == 0 else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        try synchronize()
        try requireMissing(paths.installedApplication.lastPathComponent)
        guard try ownedDirectory(
            paths.rollbackApplication.lastPathComponent,
            allowSafeReadableMode: false
        ) == snapshot.rollback else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        if let failed = snapshot.failed {
            guard try ownedDirectory(
                paths.failedApplication.lastPathComponent,
                allowSafeReadableMode: false
            ) == failed else {
                throw CompanionUpdaterError.unsafeFilesystem
            }
        } else {
            try requireMissing(paths.failedApplication.lastPathComponent)
        }
    }

    private func ownedDirectory(
        _ name: String,
        allowSafeReadableMode: Bool
    ) throws -> Entry {
        var metadata = stat()
        let mode: mode_t
        guard Darwin.fstatat(supportDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid() else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        mode = metadata.st_mode & 0o777
        guard mode == 0o700 || (allowSafeReadableMode && mode == 0o755) else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
        return Entry(
            device: UInt64(metadata.st_dev),
            inode: UInt64(metadata.st_ino),
            mode: UInt16(mode)
        )
    }

    private func requireMissing(_ name: String) throws {
        var metadata = stat()
        guard Darwin.fstatat(supportDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0,
              errno == ENOENT else {
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }

    private func exists(_ name: String) -> Bool {
        var metadata = stat()
        return Darwin.fstatat(supportDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0
    }

    private func synchronize() throws {
        while Darwin.fsync(supportDescriptor) != 0 {
            if errno == EINTR { continue }
            throw CompanionUpdaterError.unsafeFilesystem
        }
    }
}

public struct StableUpdateRecoveryOperations {
    let phase: () throws -> StableRecoveryPhase
    let verifyBundles: (StableRecoveryPhase) throws -> Void
    let persistDisabled: () throws -> Void
    let bootout: () throws -> Void
    let proveStopped: () -> Bool
    let restore: (StableRecoveryPhase) throws -> Void
    let revertRestored: (StableRecoveryPhase) throws -> Void
    let verifyRestoredBundle: (StableRecoveryPhase) throws -> Void
    let bootstrap: () throws -> Void
    let verifyDisabledHealth: () throws -> Bool
    let monotonicNow: () -> TimeInterval
    let sleep: (TimeInterval) -> Void

    public init(
        phase: @escaping () throws -> StableRecoveryPhase,
        verifyBundles: @escaping (StableRecoveryPhase) throws -> Void,
        persistDisabled: @escaping () throws -> Void,
        bootout: @escaping () throws -> Void,
        proveStopped: @escaping () -> Bool,
        restore: @escaping (StableRecoveryPhase) throws -> Void,
        revertRestored: @escaping (StableRecoveryPhase) throws -> Void,
        verifyRestoredBundle: @escaping (StableRecoveryPhase) throws -> Void,
        bootstrap: @escaping () throws -> Void,
        verifyDisabledHealth: @escaping () throws -> Bool,
        monotonicNow: @escaping () -> TimeInterval = {
            ProcessInfo.processInfo.systemUptime
        },
        sleep: @escaping (TimeInterval) -> Void = {
            Thread.sleep(forTimeInterval: $0)
        }
    ) {
        self.phase = phase
        self.verifyBundles = verifyBundles
        self.persistDisabled = persistDisabled
        self.bootout = bootout
        self.proveStopped = proveStopped
        self.restore = restore
        self.revertRestored = revertRestored
        self.verifyRestoredBundle = verifyRestoredBundle
        self.bootstrap = bootstrap
        self.verifyDisabledHealth = verifyDisabledHealth
        self.monotonicNow = monotonicNow
        self.sleep = sleep
    }
}

public final class StableUpdateRecovery {
    private static let healthTimeout: TimeInterval = 10
    private static let healthPollInterval: TimeInterval = 0.1
    private let paths: AgentPaths
    private let operations: StableUpdateRecoveryOperations

    public init(paths: AgentPaths, operations: StableUpdateRecoveryOperations) {
        self.paths = paths
        self.operations = operations
    }

    public func run() throws {
        let updateLock = try CompanionUpdateLock(paths: paths)
        defer { updateLock.unlock() }
        let phase = try operations.phase()
        try operations.verifyBundles(phase)
        try operations.persistDisabled()
        try? operations.bootout()
        guard operations.proveStopped() else {
            throw StableUpdateRecoveryError.daemonNotProvenStopped
        }
        try operations.verifyBundles(phase)
        try operations.restore(phase)
        do {
            try operations.verifyRestoredBundle(phase)
            try operations.bootstrap()
            let start = operations.monotonicNow()
            guard start.isFinite else {
                throw StableUpdateRecoveryError.healthVerificationFailed
            }
            let deadline = start + Self.healthTimeout
            repeat {
                if (try? operations.verifyDisabledHealth()) == true { return }
                let now = operations.monotonicNow()
                guard now.isFinite, now < deadline else {
                    throw StableUpdateRecoveryError.healthVerificationFailed
                }
                operations.sleep(min(Self.healthPollInterval, deadline - now))
            } while true
        } catch {
            let postRestoreError = error
            try? operations.bootout()
            guard operations.proveStopped() else {
                throw StableUpdateRecoveryError.retrySafetyFailure
            }
            do {
                try operations.revertRestored(phase)
                try operations.verifyBundles(phase)
            } catch {
                throw StableUpdateRecoveryError.retrySafetyFailure
            }
            throw postRestoreError
        }
    }
}

public struct ControlRequest: Codable, Equatable, Sendable {
    public let command: ControlCommand
    public let claudeOTelEnvironmentPresent: Bool?

    public init(
        command: ControlCommand,
        claudeOTelEnvironmentPresent: Bool? = nil
    ) {
        self.command = command
        self.claudeOTelEnvironmentPresent = claudeOTelEnvironmentPresent
    }

    public static func invocation(
        command: ControlCommand,
        environment: [String: String]
    ) -> ControlRequest {
        ControlRequest(
            command: command,
            claudeOTelEnvironmentPresent: command == .doctor
                ? DoctorEnvironment.claudeOTelPresent(in: environment)
                : nil
        )
    }

    private enum CodingKeys: String, CodingKey {
        case command
        case claudeOTelEnvironmentPresent = "claude_otel_environment_present"
    }
}

public struct ControlResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let message: String

    public init(ok: Bool, message: String) {
        self.ok = ok
        self.message = message
    }
}

public enum ControlSocketError: Error, Equatable {
    case invalidFrame
    case frameTooLarge
    case unsafeSocketPath
    case connectionClosed
    case liveSocket
}

public enum ControlSocketProtocol {
    public static func encode(_ command: ControlCommand, maximumFrameBytes: Int) throws -> Data {
        try encode(
            ControlRequest(
                command: command,
                claudeOTelEnvironmentPresent: command == .doctor ? false : nil
            ),
            maximumFrameBytes: maximumFrameBytes
        )
    }

    public static func encode(_ request: ControlRequest, maximumFrameBytes: Int) throws -> Data {
        guard valid(request) else { throw ControlSocketError.invalidFrame }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard var data = try? encoder.encode(request) else {
            throw ControlSocketError.invalidFrame
        }
        data.append(0x0A)
        guard data.count <= maximumFrameBytes else { throw ControlSocketError.frameTooLarge }
        return data
    }

    public static func decode(_ frame: Data, maximumFrameBytes: Int) throws -> ControlRequest {
        guard !frame.isEmpty, frame.count <= maximumFrameBytes else {
            throw frame.count > maximumFrameBytes
                ? ControlSocketError.frameTooLarge : ControlSocketError.invalidFrame
        }
        var body = frame
        if body.last == 0x0A { body.removeLast() }
        guard !body.isEmpty,
              !body.contains(0x0A),
              let object = try? JSONSerialization.jsonObject(with: body),
              let fields = object as? [String: Any],
              let request = try? JSONDecoder().decode(ControlRequest.self, from: body),
              valid(request) else {
            throw ControlSocketError.invalidFrame
        }
        let expectedFields: Set<String> = request.command == .doctor
            ? ["command", "claude_otel_environment_present"]
            : ["command"]
        guard Set(fields.keys) == expectedFields else {
            throw ControlSocketError.invalidFrame
        }
        return request
    }

    private static func valid(_ request: ControlRequest) -> Bool {
        request.command == .doctor
            ? request.claudeOTelEnvironmentPresent != nil
            : request.claudeOTelEnvironmentPresent == nil
    }
}

public final class ControlSocketServer: @unchecked Sendable {
    public typealias Handler = @Sendable (ControlCommand) -> ControlResponse
    public typealias RequestHandler = @Sendable (ControlRequest) -> ControlResponse

    private let socketURL: URL
    private let maximumFrameBytes: Int
    private let queue = DispatchQueue(label: "com.redlattice.runtime-raiders.control", qos: .utility)
    private let lock = NSLock()
    private var descriptor: Int32 = -1
    private var lifetimeLockDescriptor: Int32 = -1
    private var handler: RequestHandler?

    public init(socketURL: URL, maximumFrameBytes: Int = 4_096) {
        self.socketURL = socketURL.standardizedFileURL
        self.maximumFrameBytes = max(1, min(maximumFrameBytes, 64 * 1_024))
    }

    public func start(handler: @escaping Handler) throws {
        try startRequests { request in handler(request.command) }
    }

    public func startRequests(handler: @escaping RequestHandler) throws {
        let parent = socketURL.deletingLastPathComponent()
        try Self.createPrivateDirectory(parent)
        let lifetimeLock = try Self.acquireLifetimeLock(
            parent: parent,
            socketName: socketURL.lastPathComponent
        )
        do {
            try Self.prepareSocketPath(socketURL)
        } catch {
            _ = runtimeRaidersFlock(lifetimeLock, LOCK_UN)
            Darwin.close(lifetimeLock)
            throw error
        }
        let socketDescriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else {
            _ = runtimeRaidersFlock(lifetimeLock, LOCK_UN)
            Darwin.close(lifetimeLock)
            throw Self.currentPOSIXError()
        }
        var bound = false
        do {
            try Self.disableSIGPIPE(socketDescriptor)
            try Self.withAddress(socketURL.path) { address, length in
                guard Darwin.bind(socketDescriptor, address, length) == 0 else {
                    throw Self.currentPOSIXError()
                }
            }
            bound = true
            guard Darwin.chmod(socketURL.path, 0o600) == 0 else {
                throw Self.currentPOSIXError()
            }
            guard Darwin.listen(socketDescriptor, 8) == 0 else {
                throw Self.currentPOSIXError()
            }
        } catch {
            Darwin.close(socketDescriptor)
            if bound { _ = Darwin.unlink(socketURL.path) }
            _ = runtimeRaidersFlock(lifetimeLock, LOCK_UN)
            Darwin.close(lifetimeLock)
            throw error
        }
        lock.withLock {
            self.handler = handler
            descriptor = socketDescriptor
            lifetimeLockDescriptor = lifetimeLock
        }
        queue.async { [self] in acceptLoop(socketDescriptor) }
    }

    public func stop() {
        let old = lock.withLock { () -> (socket: Int32, lifetimeLock: Int32) in
            let value = (descriptor, lifetimeLockDescriptor)
            descriptor = -1
            lifetimeLockDescriptor = -1
            handler = nil
            return value
        }
        if old.socket >= 0 {
            _ = Darwin.shutdown(old.socket, SHUT_RDWR)
            Darwin.close(old.socket)
            try? Self.prepareSocketPath(socketURL)
        }
        if old.lifetimeLock >= 0 {
            _ = runtimeRaidersFlock(old.lifetimeLock, LOCK_UN)
            Darwin.close(old.lifetimeLock)
        }
    }

    private func acceptLoop(_ listening: Int32) {
        while lock.withLock({ descriptor == listening }) {
            let client = Darwin.accept(listening, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                break
            }
            try? Self.disableSIGPIPE(client)
            try? Self.setClientTimeouts(client)
            autoreleasepool { handle(client) }
            Darwin.close(client)
        }
    }

    private func handle(_ client: Int32) {
        let response: ControlResponse
        do {
            let frame = try Self.readFrame(client, maximumFrameBytes: maximumFrameBytes)
            let request = try ControlSocketProtocol.decode(
                frame,
                maximumFrameBytes: maximumFrameBytes
            )
            guard let handler = lock.withLock({ self.handler }) else {
                throw ControlSocketError.connectionClosed
            }
            response = handler(request)
        } catch {
            response = ControlResponse(ok: false, message: "invalid control request")
        }
        guard var data = try? JSONEncoder().encode(response) else { return }
        data.append(0x0A)
        guard data.count <= maximumFrameBytes else { return }
        try? Self.writeAll(data, to: client)
    }

    private static func createPrivateDirectory(_ directory: URL) throws {
        let descriptor = try OwnerOnlyDirectory.openOrCreate(directory)
        Darwin.close(descriptor)
    }

    private static func acquireLifetimeLock(parent: URL, socketName: String) throws -> Int32 {
        let parentDescriptor = try OwnerOnlyDirectory.openOrCreate(parent)
        defer { Darwin.close(parentDescriptor) }
        let name = ".\(socketName).runtime-raiders.lock"
        let descriptor = Darwin.openat(
            parentDescriptor,
            name,
            O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard descriptor >= 0 else { throw currentPOSIXError() }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o777 == 0o600,
              metadata.st_nlink == 1 else {
            Darwin.close(descriptor)
            throw ControlSocketError.unsafeSocketPath
        }
        guard runtimeRaidersFlock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockError = errno
            Darwin.close(descriptor)
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                throw ControlSocketError.liveSocket
            }
            errno = lockError
            throw currentPOSIXError()
        }
        return descriptor
    }

    private static func prepareSocketPath(_ url: URL) throws {
        var metadata = stat()
        guard Darwin.lstat(url.path, &metadata) == 0 else {
            if errno == ENOENT { return }
            throw currentPOSIXError()
        }
        guard metadata.st_mode & S_IFMT == S_IFSOCK,
              metadata.st_uid == Darwin.geteuid() else {
            throw ControlSocketError.unsafeSocketPath
        }
        let probe = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard probe >= 0 else { throw currentPOSIXError() }
        defer { Darwin.close(probe) }
        try disableSIGPIPE(probe)
        let connected = try withAddress(url.path) { address, length in
            Darwin.connect(probe, address, length) == 0
        }
        if connected { throw ControlSocketError.liveSocket }
        guard errno == ECONNREFUSED || errno == ENOENT else {
            throw currentPOSIXError()
        }
        guard Darwin.unlink(url.path) == 0 else { throw currentPOSIXError() }
    }

    fileprivate static func disableSIGPIPE(_ descriptor: Int32) throws {
        var enabled: Int32 = 1
        guard Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &enabled,
            socklen_t(MemoryLayout<Int32>.size)
        ) == 0 else { throw currentPOSIXError() }
    }

    fileprivate static func setClientTimeouts(
        _ descriptor: Int32,
        seconds: Int = 2
    ) throws {
        var timeout = timeval(tv_sec: seconds, tv_usec: 0)
        for option in [SO_RCVTIMEO, SO_SNDTIMEO] {
            guard Darwin.setsockopt(
                descriptor,
                SOL_SOCKET,
                option,
                &timeout,
                socklen_t(MemoryLayout<timeval>.size)
            ) == 0 else { throw currentPOSIXError() }
        }
    }

    fileprivate static func readFrame(_ descriptor: Int32, maximumFrameBytes: Int) throws -> Data {
        var output = Data()
        var byte: UInt8 = 0
        while output.count <= maximumFrameBytes {
            let count = Darwin.read(descriptor, &byte, 1)
            if count == 1 {
                output.append(byte)
                if byte == 0x0A { return output }
            } else if count == 0 {
                throw ControlSocketError.connectionClosed
            } else if errno == EINTR {
                continue
            } else {
                throw currentPOSIXError()
            }
        }
        throw ControlSocketError.frameTooLarge
    }

    fileprivate static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw currentPOSIXError() }
            }
        }
    }

    fileprivate static func withAddress<T>(
        _ path: String,
        _ body: (UnsafePointer<sockaddr>, socklen_t) throws -> T
    ) throws -> T {
        let pathBytes = Array(path.utf8CString)
        var address = sockaddr_un()
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw ControlSocketError.unsafeSocketPath
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
                _ = pathBytes.withUnsafeBufferPointer { source in
                    memcpy(destination, source.baseAddress!, pathBytes.count)
                }
            }
        }
        return try withUnsafePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                try body(socketAddress, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }

    fileprivate static func currentPOSIXError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

public enum ControlSocketClient {
    static func timeoutSeconds(for command: ControlCommand) -> Int {
        switch command {
        case .on, .off, .uninstall, .prepareUpdate, .resumeUpdate:
            30
        case .daemon, .status, .doctor:
            2
        }
    }

    public static func send(
        _ command: ControlCommand,
        to socketURL: URL,
        maximumFrameBytes: Int = 4_096
    ) throws -> ControlResponse {
        try send(
            request: ControlRequest(
                command: command,
                claudeOTelEnvironmentPresent: command == .doctor ? false : nil
            ),
            to: socketURL,
            maximumFrameBytes: maximumFrameBytes
        )
    }

    public static func send(
        request: ControlRequest,
        to socketURL: URL,
        maximumFrameBytes: Int = 4_096
    ) throws -> ControlResponse {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ControlSocketServer.currentPOSIXError() }
        try ControlSocketServer.disableSIGPIPE(descriptor)
        try ControlSocketServer.setClientTimeouts(
            descriptor,
            seconds: timeoutSeconds(for: request.command)
        )
        defer { Darwin.close(descriptor) }
        try ControlSocketServer.withAddress(socketURL.standardizedFileURL.path) { address, length in
            guard Darwin.connect(descriptor, address, length) == 0 else {
                throw ControlSocketServer.currentPOSIXError()
            }
        }
        try ControlSocketServer.writeAll(
            ControlSocketProtocol.encode(request, maximumFrameBytes: maximumFrameBytes),
            to: descriptor
        )
        let data = try ControlSocketServer.readFrame(
            descriptor,
            maximumFrameBytes: maximumFrameBytes
        )
        return try JSONDecoder().decode(ControlResponse.self, from: data.dropLast())
    }
}

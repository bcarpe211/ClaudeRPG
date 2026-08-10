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
    case daemon(trialGeneration: Int64?)
    case control(ControlCommand)
    case foregroundUpdate
    case selfCheck
    case installerLease
    case legacyPrepare
    case installerResume(generation: Int64)
    case installerValidateLegacy
    case installerLegacyStatus(prepared: Bool, expectedEnabled: Bool?)
    case installerCandidateStatus(generation: Int64, prepared: Bool, expectedEnabled: Bool)
    case installerProtectedState
    case legacyResume
}

public enum CompanionCommandRouter {
    public static func route(
        arguments: [String],
        executableURL: URL,
        paths: AgentPaths
    ) -> CompanionCommandRoute? {
        switch arguments {
        case ["on"], ["off"], ["status"], ["doctor"], ["uninstall"]:
            guard let argument = arguments.first,
                  let command = ControlCommand(rawValue: argument) else { return nil }
            return .control(command)
        case ["update"]:
            return .foregroundUpdate
        case ["__self-check"]:
            return .selfCheck
        case let values where installerStandaloneCommand(values):
            guard let identity = try? CompanionReleaseIdentity.load(from: .main) else { return nil }
            return installerRoute(
                arguments: arguments,
                executableURL: executableURL,
                paths: paths,
                releaseState: nil,
                releaseIdentity: identity
            )
        case let values where values.count == 2 &&
            values[0] == "__runtime-raiders-installer-resume":
            guard let state = try? ReleaseStateStore.loadExisting(paths: paths),
                  let identity = try? CompanionReleaseIdentity.load(from: .main) else { return nil }
            return installerRoute(
                arguments: arguments,
                executableURL: executableURL,
                paths: paths,
                releaseState: state,
                releaseIdentity: identity
            )
        case ["daemon"]:
            guard let state = try? ReleaseStateStore.loadExisting(paths: paths),
                  let identity = try? CompanionReleaseIdentity.load(from: .main) else { return nil }
            let leaseHeld = (try? CompanionPreparedStartupLease.observe(paths: paths)) != nil
            return route(
                arguments: arguments,
                executableURL: executableURL,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: leaseHeld,
                releaseIdentity: identity
            )
        case let values where values.count == 3 &&
            values[0] == "daemon" &&
            values[1] == "__runtime-raiders-trial-generation":
            guard let state = try? ReleaseStateStore.loadExisting(paths: paths),
                  let identity = try? CompanionReleaseIdentity.load(from: .main) else { return nil }
            let leaseHeld = (try? CompanionPreparedStartupLease.observe(paths: paths)) != nil
            return route(
                arguments: arguments,
                executableURL: executableURL,
                paths: paths,
                releaseState: state,
                preparedStartupLeaseHeld: leaseHeld,
                releaseIdentity: identity
            )
        default:
            return nil
        }
    }

    static func route(
        arguments: [String],
        executableURL: URL,
        paths: AgentPaths,
        releaseState: ReleaseStateV1,
        preparedStartupLeaseHeld: Bool,
        releaseIdentity: CompanionReleaseIdentity
    ) -> CompanionCommandRoute? {
        guard ReleaseStateV1.isValid(releaseState) else { return nil }
        switch arguments {
        case ["daemon"]:
            guard let activeExecutable = try? paths.executable(for: releaseState.active),
                  releaseIdentity == (try? releaseState.active.companionReleaseIdentity()),
                  exactExecutable(executableURL, equals: activeExecutable) else {
                return nil
            }
            return .daemon(trialGeneration: nil)
        case let values where values.count == 3 &&
            values[0] == "daemon" &&
            values[1] == "__runtime-raiders-trial-generation":
            let rawGeneration = values[2]
            guard rawGeneration.first != "+",
                  let generation = Int64(rawGeneration),
                  String(generation) == rawGeneration,
                  (1...ReleaseContractValidation.maximumSafeInteger).contains(generation),
                  generation == releaseState.generation,
                  let trial = releaseState.trial,
                  releaseIdentity == (try? trial.companionReleaseIdentity()),
                  preparedStartupLeaseHeld,
                  let trialExecutable = try? paths.executable(for: trial),
                  exactExecutable(executableURL, equals: trialExecutable) else {
                return nil
            }
            return .daemon(trialGeneration: generation)
        default:
            return nil
        }
    }

    static func installerRoute(
        arguments: [String],
        executableURL: URL,
        paths: AgentPaths,
        releaseState: ReleaseStateV1?,
        releaseIdentity: CompanionReleaseIdentity
    ) -> CompanionCommandRoute? {
        guard releaseIdentity.updateProtocolVersion == 2,
              directAgentExecutable(executableURL, paths: paths) else { return nil }
        switch arguments {
        case ["__runtime-raiders-installer-lease"]:
            return .installerLease
        case ["__runtime-raiders-legacy-prepare"]:
            return .legacyPrepare
        case ["__runtime-raiders-installer-validate-legacy"]:
            return .installerValidateLegacy
        case ["__runtime-raiders-installer-status", "legacy-running"]:
            return .installerLegacyStatus(prepared: false, expectedEnabled: nil)
        case let values where values.count == 3 &&
            values[0] == "__runtime-raiders-installer-status" &&
            values[1] == "legacy-prepared":
            guard let enabled = canonicalEnabled(values[2]) else { return nil }
            return .installerLegacyStatus(prepared: true, expectedEnabled: enabled)
        case let values where values.count == 4 &&
            values[0] == "__runtime-raiders-installer-status" &&
            ["candidate-prepared", "candidate-resumed"].contains(values[1]):
            guard let generation = canonicalGeneration(values[2]),
                  let enabled = canonicalEnabled(values[3]) else { return nil }
            return .installerCandidateStatus(
                generation: generation,
                prepared: values[1] == "candidate-prepared",
                expectedEnabled: enabled
            )
        case ["__runtime-raiders-installer-protected-state"]:
            return .installerProtectedState
        case ["__runtime-raiders-legacy-resume"]:
            return .legacyResume
        case let values where values.count == 2 &&
            values[0] == "__runtime-raiders-installer-resume":
            guard let state = releaseState,
                  ReleaseStateV1.isValid(state),
                  state.trial == nil,
                  state.fallback == nil,
                  state.active == (try? releaseIdentity.releaseReference()),
                  let generation = canonicalGeneration(values[1]),
                  generation == state.generation,
                  let activeExecutable = try? paths.executable(for: state.active),
                  exactExecutable(executableURL, equals: activeExecutable) else {
                return nil
            }
            return .installerResume(generation: generation)
        default:
            return nil
        }
    }

    private static func canonicalGeneration(_ raw: String) -> Int64? {
        guard raw.first != "+",
              let generation = Int64(raw),
              String(generation) == raw,
              (1...ReleaseContractValidation.maximumSafeInteger).contains(generation) else {
            return nil
        }
        return generation
    }

    private static func canonicalEnabled(_ raw: String) -> Bool? {
        switch raw {
        case "enabled": true
        case "disabled": false
        default: nil
        }
    }

    private static func installerStandaloneCommand(_ arguments: [String]) -> Bool {
        guard let command = arguments.first else { return false }
        return [
            "__runtime-raiders-installer-lease",
            "__runtime-raiders-legacy-prepare",
            "__runtime-raiders-installer-validate-legacy",
            "__runtime-raiders-installer-status",
            "__runtime-raiders-installer-protected-state",
            "__runtime-raiders-legacy-resume",
        ].contains(command)
    }

    private static func directAgentExecutable(_ executable: URL, paths: AgentPaths) -> Bool {
        guard executable.isFileURL,
              executable.lastPathComponent == "runtime-raiders-agent" else { return false }
        let application = executable
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        guard application.lastPathComponent == "Runtime Raiders Agent.app" else { return false }
        let standardized = application.standardizedFileURL.path
        return standardized != paths.legacyFlatApplication.standardizedFileURL.path &&
            !standardized.hasPrefix(paths.launcherDirectory.standardizedFileURL.path + "/")
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
    public static let activeRunRefusalMessage = "active Run prevents update"

    private let workQueue: DispatchQueue
    private let activeRunCount: () throws -> Int
    private let validatePreparation: (Int64) throws -> Void
    private let pauseAcceptance: () -> Void
    private let pauseUploader: () -> Void
    private let pauseHeartbeat: () -> Void
    private let pauseWatcher: () -> Void
    private let startAbandonmentObserver: (Int64) -> Void
    private let validateResume: (Int64) throws -> Void
    private let resumeAction: (Int64) throws -> Void
    private let acceptedResponse: () throws -> ControlResponse
    private let stateLock = NSLock()
    private var preparedGenerationStorage: Int64?
    private var resumedGeneration: Int64?

    public var isPrepared: Bool { preparedGeneration != nil }
    public var preparedGeneration: Int64? { stateLock.withLock { preparedGenerationStorage } }

    public init(
        workQueue: DispatchQueue,
        activeRunCount: @escaping () throws -> Int,
        validatePreparation: @escaping (Int64) throws -> Void = { _ in },
        pauseAcceptance: @escaping () -> Void,
        pauseUploader: @escaping () -> Void,
        pauseHeartbeat: @escaping () -> Void,
        pauseWatcher: @escaping () -> Void,
        startAbandonmentObserver: @escaping (Int64) -> Void = { _ in },
        initiallyPreparedGeneration: Int64? = nil,
        validateResume: @escaping (Int64) throws -> Void = { _ in },
        resume: @escaping (Int64) throws -> Void = { _ in },
        acceptedResponse: @escaping () throws -> ControlResponse = {
            ControlResponse(ok: true, message: "prepared for update")
        }
    ) {
        self.workQueue = workQueue
        self.activeRunCount = activeRunCount
        self.validatePreparation = validatePreparation
        self.pauseAcceptance = pauseAcceptance
        self.pauseUploader = pauseUploader
        self.pauseHeartbeat = pauseHeartbeat
        self.pauseWatcher = pauseWatcher
        self.startAbandonmentObserver = startAbandonmentObserver
        preparedGenerationStorage = initiallyPreparedGeneration
        self.validateResume = validateResume
        resumeAction = resume
        self.acceptedResponse = acceptedResponse
    }

    public func prepare(generation: Int64) -> ControlResponse {
        workQueue.sync {
            do {
                guard Self.validGeneration(generation) else {
                    return ControlResponse(ok: false, message: "unable to prepare update")
                }
                if let current = preparedGeneration {
                    guard current == generation else {
                        return ControlResponse(ok: false, message: "unable to prepare update")
                    }
                    return try acceptedResponse()
                }
                guard try activeRunCount() == 0 else {
                    return ControlResponse(ok: false, message: Self.activeRunRefusalMessage)
                }
                try validatePreparation(generation)
                pauseAcceptance()
                pauseUploader()
                pauseHeartbeat()
                pauseWatcher()
                stateLock.withLock { preparedGenerationStorage = generation }
                startAbandonmentObserver(generation)
                return try acceptedResponse()
            } catch {
                return ControlResponse(ok: false, message: "unable to prepare update")
            }
        }
    }

    public func resume(generation: Int64) -> ControlResponse {
        workQueue.sync {
            do {
                guard Self.validGeneration(generation) else {
                    return ControlResponse(ok: false, message: "unable to resume after update")
                }
                guard preparedGeneration != nil else {
                    guard stateLock.withLock({ resumedGeneration == generation }) else {
                        return ControlResponse(ok: false, message: "unable to resume after update")
                    }
                    try validateResume(generation)
                    return try acceptedResponse()
                }
                try validateResume(generation)
                try resumeAction(generation)
                stateLock.withLock {
                    preparedGenerationStorage = nil
                    resumedGeneration = generation
                }
                return try acceptedResponse()
            } catch {
                return ControlResponse(ok: false, message: "unable to resume after update")
            }
        }
    }

    public func resumeAfterAbandonment(generation: Int64) -> ControlResponse {
        workQueue.sync {
            do {
                guard preparedGeneration == generation else {
                    return ControlResponse(ok: false, message: "unable to resume after update")
                }
                try resumeAction(generation)
                stateLock.withLock {
                    preparedGenerationStorage = nil
                    resumedGeneration = generation
                }
                return try acceptedResponse()
            } catch {
                return ControlResponse(ok: false, message: "unable to resume after update")
            }
        }
    }

    private static func validGeneration(_ generation: Int64) -> Bool {
        (1...ReleaseContractValidation.maximumSafeInteger).contains(generation)
    }
}

public enum LaunchdJobControllerError: Error, Equatable {
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
    private let runCommand: Command

    public init(
        userIdentifier: uid_t = Darwin.geteuid(),
        runCommand: @escaping Command
    ) {
        self.userIdentifier = userIdentifier
        self.runCommand = runCommand
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

    private var domainTarget: String { "gui/\(userIdentifier)" }
    private var jobTarget: String { "\(domainTarget)/\(Self.label)" }
}

public struct ControlRequest: Codable, Equatable, Sendable {
    public let command: ControlCommand
    public let claudeOTelEnvironmentPresent: Bool?
    public let releaseStateGeneration: Int64?

    public init(
        command: ControlCommand,
        claudeOTelEnvironmentPresent: Bool? = nil,
        releaseStateGeneration: Int64? = nil
    ) {
        self.command = command
        self.claudeOTelEnvironmentPresent = claudeOTelEnvironmentPresent
        self.releaseStateGeneration = releaseStateGeneration
    }

    public static func invocation(
        command: ControlCommand,
        environment: [String: String]
    ) -> ControlRequest {
        ControlRequest(
            command: command,
            claudeOTelEnvironmentPresent: command == .doctor
                ? DoctorEnvironment.claudeOTelPresent(in: environment)
                : nil,
            releaseStateGeneration: nil
        )
    }

    private enum CodingKeys: String, CodingKey {
        case command
        case claudeOTelEnvironmentPresent = "claude_otel_environment_present"
        case releaseStateGeneration = "release_state_generation"
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
        let expectedFields: Set<String>
        switch request.command {
        case .doctor:
            expectedFields = ["command", "claude_otel_environment_present"]
        case .prepareUpdate, .resumeUpdate:
            expectedFields = ["command", "release_state_generation"]
        default:
            expectedFields = ["command"]
        }
        guard Set(fields.keys) == expectedFields else {
            throw ControlSocketError.invalidFrame
        }
        return request
    }

    private static func valid(_ request: ControlRequest) -> Bool {
        switch request.command {
        case .doctor:
            return request.claudeOTelEnvironmentPresent != nil &&
                request.releaseStateGeneration == nil
        case .prepareUpdate, .resumeUpdate:
            guard let generation = request.releaseStateGeneration else { return false }
            return request.claudeOTelEnvironmentPresent == nil &&
                (1...ReleaseContractValidation.maximumSafeInteger).contains(generation)
        default:
            return request.claudeOTelEnvironmentPresent == nil &&
                request.releaseStateGeneration == nil
        }
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

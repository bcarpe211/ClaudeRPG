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
}

public enum StatusOutputFormat: Equatable, Sendable {
    case pretty
    case json
}

public enum CompanionCommandRoute: Equatable, Sendable {
    case daemon
    case managedAgent(ManagedAgentAction)
    case control(ControlCommand)
    case status(StatusOutputFormat)
    case updateCheck
    case reEnroll
    case uninstall(RemovalMode)
    case help
}

public func outputStyle(isTTY: Bool, environment: [String: String]) -> OutputStyle {
    isTTY && environment["NO_COLOR"] == nil ? .ansi : .plain
}

public enum CompanionCommandRouter {
    public static func route(
        arguments: [String],
        executableURL: URL,
        paths: AgentPaths
    ) -> CompanionCommandRoute? {
        switch arguments {
        case []:
            return .status(.pretty)
        case ["status"]:
            return .status(.pretty)
        case ["status", "--json"]:
            return .status(.json)
        case ["help"], ["--help"]:
            return .help
        case ["on"], ["off"], ["doctor"]:
            guard let argument = arguments.first,
                  let command = ControlCommand(rawValue: argument) else { return nil }
            return .control(command)
        case ["re-enroll"]:
            return .reEnroll
        case ["uninstall"]:
            return .uninstall(.preserveState)
        case ["uninstall", "--everything"]:
            return .uninstall(.everything)
        case ["update"]:
            return .updateCheck
        case ["daemon"]:
            guard exactExecutable(executableURL, equals: paths.agentExecutable) else { return nil }
            return .daemon
        case let arguments where arguments.count == 2 &&
            arguments.first == "__runtime-raiders-managed-agent":
            guard exactExecutable(executableURL, equals: paths.agentExecutable) else { return nil }
            guard let action = ManagedAgentAction(rawValue: arguments[1]) else { return nil }
            return .managedAgent(action)
        default:
            return nil
        }
    }

    private static func exactExecutable(_ first: URL, equals second: URL) -> Bool {
        first.isFileURL &&
            second.isFileURL &&
            first.standardizedFileURL.path == second.standardizedFileURL.path
    }
}

public enum LifecycleTerminalError: Error, Equatable, Sendable {
    case unavailable
    case invalidInput
    case endOfFile
    case interrupted
}

typealias TerminalSetAttributes = (
    Int32,
    Int32,
    UnsafePointer<termios>
) -> Int32
typealias TerminalWriteBytes = (
    Int32,
    UnsafeRawPointer?,
    Int
) -> Int

private let lifecycleTerminalSignalLock = NSLock()

private struct LifecycleTerminalSignalPipe {
    let readDescriptor: Int32
    let writeDescriptor: Int32

    init() throws {
        var descriptors = [Int32](repeating: -1, count: 2)
        guard descriptors.withUnsafeMutableBufferPointer({ Darwin.pipe($0.baseAddress!) }) == 0 else {
            throw LifecycleTerminalError.unavailable
        }
        let readDescriptor = descriptors[0]
        let writeDescriptor = descriptors[1]
        guard Self.configure(readDescriptor), Self.configure(writeDescriptor) else {
            Darwin.close(readDescriptor)
            Darwin.close(writeDescriptor)
            throw LifecycleTerminalError.unavailable
        }
        self.readDescriptor = readDescriptor
        self.writeDescriptor = writeDescriptor
    }

    private static func configure(_ descriptor: Int32) -> Bool {
        let descriptorFlags = Darwin.fcntl(descriptor, F_GETFD)
        guard descriptorFlags >= 0,
              Darwin.fcntl(descriptor, F_SETFD, descriptorFlags | FD_CLOEXEC) == 0 else {
            return false
        }
        let statusFlags = Darwin.fcntl(descriptor, F_GETFL)
        return statusFlags >= 0 &&
            Darwin.fcntl(descriptor, F_SETFL, statusFlags | O_NONBLOCK) == 0
    }

    func drain() {
        var bytes = [UInt8](repeating: 0, count: 64)
        while bytes.withUnsafeMutableBytes({
            Darwin.read(readDescriptor, $0.baseAddress, $0.count)
        }) > 0 {}
    }
}

private let lifecycleTerminalSignalPipe = try? LifecycleTerminalSignalPipe()
private let lifecycleTerminalSignalWriteDescriptor =
    lifecycleTerminalSignalPipe?.writeDescriptor ?? -1

private func lifecycleTerminalSignalHandler(_ signal: Int32) {
    let descriptor = lifecycleTerminalSignalWriteDescriptor
    guard descriptor >= 0 else { return }
    var byte = UInt8(truncatingIfNeeded: signal)
    _ = Darwin.write(descriptor, &byte, 1)
}

public struct LifecycleTerminalReader: @unchecked Sendable {
    private let path: String
    private let setAttributes: TerminalSetAttributes
    private let writeBytes: TerminalWriteBytes
    private let transitionHook: @Sendable (LifecycleTerminalTransition) -> Void

    public init(path: String = "/dev/tty") {
        self.path = path
        setAttributes = { Darwin.tcsetattr($0, $1, $2) }
        writeBytes = { Darwin.write($0, $1, $2) }
        transitionHook = { _ in }
    }

    init(
        testPath path: String,
        setAttributes: @escaping TerminalSetAttributes = { Darwin.tcsetattr($0, $1, $2) },
        writeBytes: @escaping TerminalWriteBytes = { Darwin.write($0, $1, $2) },
        transitionHook: @escaping @Sendable (LifecycleTerminalTransition) -> Void = { _ in }
    ) {
        self.path = path
        self.setAttributes = setAttributes
        self.writeBytes = writeBytes
        self.transitionHook = transitionHook
    }

    public func validate() throws {
        let descriptor = try openValidatedTerminal()
        defer { Darwin.close(descriptor) }
        var attributes = termios()
        guard Darwin.tcgetattr(descriptor, &attributes) == 0 else {
            throw LifecycleTerminalError.unavailable
        }
    }

    public func readLine(prompt: String, maximumBytes: Int) throws -> String {
        guard (1...64).contains(maximumBytes) else {
            throw LifecycleTerminalError.invalidInput
        }
        let descriptor = try openValidatedTerminal()
        defer { Darwin.close(descriptor) }

        var original = termios()
        guard Darwin.tcgetattr(descriptor, &original) == 0 else {
            throw LifecycleTerminalError.unavailable
        }
        let signalTrap = try LifecycleTerminalSignalTrap()
        defer { signalTrap.restore() }
        transitionHook(.signalProtectionInstalled)

        var privateInput = original
        privateInput.c_lflag &= ~tcflag_t(ECHO)
        guard setAttributes(descriptor, TCSANOW, &privateInput) == 0 else {
            throw LifecycleTerminalError.unavailable
        }
        defer {
            _ = setAttributes(descriptor, TCSANOW, &original)
            transitionHook(.echoRestored)
        }
        let originalFlags = Darwin.fcntl(descriptor, F_GETFL)
        guard originalFlags >= 0,
              Darwin.fcntl(descriptor, F_SETFL, originalFlags | O_NONBLOCK) == 0 else {
            throw LifecycleTerminalError.unavailable
        }
        defer { _ = Darwin.fcntl(descriptor, F_SETFL, originalFlags) }
        try write(prompt, to: descriptor)

        var bytes = [UInt8]()
        var oversized = false
        while true {
            if signalTrap.consumeSignal() { throw LifecycleTerminalError.interrupted }
            var byte: UInt8 = 0
            let count = withUnsafeMutablePointer(to: &byte) {
                Darwin.read(descriptor, $0, 1)
            }
            if count == 0 {
                throw oversized ? LifecycleTerminalError.invalidInput : .endOfFile
            }
            if count < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK {
                    Darwin.usleep(10_000)
                    continue
                }
                throw LifecycleTerminalError.unavailable
            }
            if byte == 0x0A || byte == 0x0D {
                try write("\n", to: descriptor)
                if oversized { throw LifecycleTerminalError.invalidInput }
                break
            }
            if oversized { continue }
            if bytes.count == maximumBytes {
                oversized = true
                continue
            }
            bytes.append(byte)
        }
        guard !bytes.isEmpty, let line = String(bytes: bytes, encoding: .utf8) else {
            throw LifecycleTerminalError.invalidInput
        }
        return line
    }

    private func openValidatedTerminal() throws -> Int32 {
        let descriptor = Darwin.open(path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw LifecycleTerminalError.unavailable }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFCHR,
              metadata.st_uid == 0 || metadata.st_uid == Darwin.geteuid() else {
            Darwin.close(descriptor)
            throw LifecycleTerminalError.unavailable
        }
        return descriptor
    }

    private func write(_ value: String, to descriptor: Int32) throws {
        let data = Data(value.utf8)
        var offset = 0
        while offset < data.count {
            let count = data.withUnsafeBytes { bytes in
                writeBytes(
                    descriptor,
                    bytes.baseAddress?.advanced(by: offset),
                    data.count - offset
                )
            }
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw LifecycleTerminalError.unavailable }
            offset += count
        }
    }
}

enum LifecycleTerminalTransition: Equatable, Sendable {
    case signalProtectionInstalled
    case echoRestored
}

private final class LifecycleTerminalSignalTrap {
    private static let signals = [SIGINT, SIGTERM, SIGHUP, SIGQUIT]
    private let readDescriptor: Int32
    private var previousHandlers: [(Int32, sig_t?)] = []
    private var restored = false

    init() throws {
        lifecycleTerminalSignalLock.lock()
        let signalWriteDescriptor = lifecycleTerminalSignalWriteDescriptor
        guard let signalPipe = lifecycleTerminalSignalPipe,
              signalWriteDescriptor == signalPipe.writeDescriptor,
              signalWriteDescriptor >= 0 else {
            lifecycleTerminalSignalLock.unlock()
            throw LifecycleTerminalError.unavailable
        }
        readDescriptor = signalPipe.readDescriptor
        signalPipe.drain()
        for signalValue in Self.signals {
            let previous = Darwin.signal(signalValue, lifecycleTerminalSignalHandler)
            previousHandlers.append((signalValue, previous))
        }
    }

    deinit { restore() }

    func consumeSignal() -> Bool {
        var signalByte: UInt8 = 0
        return Darwin.read(readDescriptor, &signalByte, 1) == 1
    }

    func restore() {
        guard !restored else { return }
        restored = true
        for (signalValue, previous) in previousHandlers.reversed() {
            _ = Darwin.signal(signalValue, previous)
        }
        lifecycleTerminalSignalLock.unlock()
    }
}

private final class DeferredInitialJournalState: @unchecked Sendable {
    private let lock = NSLock()
    private var resuming = false
    private var pending: RecoveryJournal?
    private var flushed = false

    func recordLoaded(_ journal: RecoveryJournal?) {
        lock.withLock { resuming = journal != nil }
    }

    func stageIfInitial(_ journal: RecoveryJournal) -> Bool {
        lock.withLock {
            guard !resuming,
                  !flushed,
                  pending == nil,
                  journal.phase == .replacementPrepared else {
                return false
            }
            pending = journal
            return true
        }
    }

    func takePending() -> RecoveryJournal? {
        lock.withLock {
            let journal = pending
            pending = nil
            if journal != nil { flushed = true }
            return journal
        }
    }
}

public extension ReEnrollmentOperations {
    func validatingCodeBeforeInitialJournal(
        _ validate: @escaping (String) throws -> Void
    ) -> ReEnrollmentOperations {
        let base = self
        let state = DeferredInitialJournalState()
        return ReEnrollmentOperations(
            companionVersion: companionVersion,
            acquireLock: acquireLock,
            loadJournal: {
                let journal = try base.loadJournal()
                state.recordLoaded(journal)
                return journal
            },
            readEnrollment: readEnrollment,
            proveCollectionOff: proveCollectionOff,
            unregisterAgent: unregisterAgent,
            verifyAgentUnregistered: verifyAgentUnregistered,
            countQueue: countQueue,
            summarize: summarize,
            confirmReEnrollment: confirmReEnrollment,
            resolveQueue: resolveQueue,
            deliverQueue: deliverQueue,
            discardQueue: discardQueue,
            generateMaterial: generateMaterial,
            writeJournal: { journal in
                if !state.stageIfInitial(journal) { try base.writeJournal(journal) }
            },
            requestCode: {
                let code = try base.requestCode()
                try validate(code)
                if let journal = state.takePending() { try base.writeJournal(journal) }
                return code
            },
            replace: replace,
            recover: recover,
            persistEnrollment: persistEnrollment,
            resetCollector: resetCollector,
            registerAgent: registerAgent,
            verifyEnrollmentAndOff: verifyEnrollmentAndOff,
            delayMilliseconds: delayMilliseconds,
            removeJournal: removeJournal,
            interruptionPoint: interruptionPoint
        )
    }
}

private final class LifecycleVerificationRemovalLock: RemovalLock, @unchecked Sendable {}
private final class LifecycleVerificationRemovalSession: RemovalSession, @unchecked Sendable {}
private final class LifecycleVerificationRemovalState: @unchecked Sendable {
    private let lock = NSLock()
    private var queueCount: Int

    init(queueCount: Int) {
        self.queueCount = queueCount
    }

    func snapshot(for session: any RemovalSession) -> RemovalQueueSnapshot {
        lock.withLock {
            RemovalQueueSnapshot(
                sessionIdentifier: ObjectIdentifier(session),
                names: (0..<queueCount).map { "event-\($0)" }
            )
        }
    }

    func discard() {
        lock.withLock { queueCount = 0 }
    }

    func isEmpty() -> Bool {
        lock.withLock { queueCount == 0 }
    }
}

public extension RemovalOperations {
    static func lifecycleVerification(
        queueCount: Int,
        enrollment: EnrollmentConfiguration?,
        enrollmentLoadFails: Bool,
        record: @escaping (String) throws -> Void,
        summarize: @escaping (Int) throws -> Void,
        confirmDiscard: @escaping (Int) throws -> Bool,
        confirmEverything: @escaping () throws -> Bool,
        revoke: @escaping (EnrollmentConfiguration) throws -> Bool
    ) -> RemovalOperations {
        let state = LifecycleVerificationRemovalState(queueCount: queueCount)
        return RemovalOperations(
            acquireLock: {
                try record("coordinator:lock")
                return LifecycleVerificationRemovalLock()
            },
            persistCollectionOff: { try record("coordinator:persist-off") },
            stopDaemon: { try record("control:uninstall") },
            unregisterAgent: { try record("coordinator:unregister-agent") },
            verifyAgentUnregistered: {
                try record("coordinator:verify-agent-unregistered")
                return true
            },
            prepareSession: {
                try record("coordinator:prepare-session")
                return LifecycleVerificationRemovalSession()
            },
            queueSnapshot: { session in
                try record("coordinator:queue-snapshot")
                return state.snapshot(for: session)
            },
            summarize: summarize,
            confirmDiscard: confirmDiscard,
            confirmEverything: confirmEverything,
            loadEnrollment: { _ in
                try record("coordinator:load-enrollment")
                if enrollmentLoadFails { throw RemovalCoordinatorError.operationFailed }
                return enrollment
            },
            revoke: revoke,
            delayMilliseconds: { _ in },
            discardQueue: { _, _ in
                state.discard()
                try record("queue:discard")
            },
            verifyQueueEmpty: { _, _ in
                try record("coordinator:verify-queue-empty")
                return state.isEmpty()
            },
            removeExecutableArtifacts: { _ in
                try record("coordinator:remove-preserving-state")
            },
            verifyPreservedState: { _ in
                try record("coordinator:verify-preserved-state")
                return true
            },
            removeAllArtifacts: { _, _ in try record("remove:everything") },
            revocationProof: { try record("coordinator:revocation-proof") }
        )
    }
}

public struct DaemonStartupOperations: @unchecked Sendable {
    public let startControl: () throws -> Void
    public let prepareLocalState: () throws -> Void
    public let activatePersistedEnabled: () throws -> Void
    public let scheduleVersionCheck: () -> Void

    public init(
        startControl: @escaping () throws -> Void,
        prepareLocalState: @escaping () throws -> Void,
        activatePersistedEnabled: @escaping () throws -> Void,
        scheduleVersionCheck: @escaping () -> Void
    ) {
        self.startControl = startControl
        self.prepareLocalState = prepareLocalState
        self.activatePersistedEnabled = activatePersistedEnabled
        self.scheduleVersionCheck = scheduleVersionCheck
    }
}

public struct NormalDaemonStartupCoordinator: Sendable {
    private let operations: DaemonStartupOperations

    public init(operations: DaemonStartupOperations) {
        self.operations = operations
    }

    public func start(persistedEnabled: Bool) throws {
        try operations.startControl()
        try operations.prepareLocalState()
        if persistedEnabled {
            try operations.activatePersistedEnabled()
        }
        operations.scheduleVersionCheck()
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
    case enableCompletionUnverified
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
            return request.claudeOTelEnvironmentPresent != nil
        default:
            return request.claudeOTelEnvironmentPresent == nil
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
    private static let enableCompletionTimeoutSeconds = 5 * 60
    private static let maximumInjectedTimeoutSeconds = 60 * 60

    struct PeerIdentity: Equatable, Sendable {
        let executableURL: URL
        let auditToken: Data
    }

    static func timeoutSeconds(for command: ControlCommand) -> Int {
        switch command {
        case .on, .off, .uninstall:
            30
        case .doctor:
            5
        case .daemon, .status:
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
        try send(
            request: request,
            to: socketURL,
            maximumFrameBytes: maximumFrameBytes,
            initialTimeoutSeconds: timeoutSeconds(for: request.command),
            enableCompletionTimeoutSeconds: enableCompletionTimeoutSeconds
        )
    }

    static func send(
        request: ControlRequest,
        to socketURL: URL,
        maximumFrameBytes: Int = 4_096,
        initialTimeoutSeconds: Int,
        enableCompletionTimeoutSeconds: Int
    ) throws -> ControlResponse {
        guard (1...maximumInjectedTimeoutSeconds).contains(initialTimeoutSeconds),
              (1...maximumInjectedTimeoutSeconds).contains(enableCompletionTimeoutSeconds) else {
            throw ControlSocketError.invalidFrame
        }
        do {
            return try exchange(
                request: request,
                to: socketURL,
                maximumFrameBytes: maximumFrameBytes,
                attestPeer: false,
                timeoutSeconds: initialTimeoutSeconds
            ).response
        } catch {
            guard request.command == .on, isSocketTimeout(error) else { throw error }
            return try completeTimedOutEnable(
                socketURL: socketURL,
                maximumFrameBytes: maximumFrameBytes,
                timeoutSeconds: enableCompletionTimeoutSeconds
            )
        }
    }

    static func sendAttested(
        request: ControlRequest,
        to socketURL: URL,
        maximumFrameBytes: Int = 4_096
    ) throws -> (ControlResponse, PeerIdentity) {
        let result = try exchange(
            request: request,
            to: socketURL,
            maximumFrameBytes: maximumFrameBytes,
            attestPeer: true,
            timeoutSeconds: timeoutSeconds(for: request.command)
        )
        guard let peerIdentity = result.peerIdentity else {
            throw ControlSocketError.unsafeSocketPath
        }
        return (result.response, peerIdentity)
    }

    private static func exchange(
        request: ControlRequest,
        to socketURL: URL,
        maximumFrameBytes: Int,
        attestPeer: Bool,
        timeoutSeconds: Int
    ) throws -> (response: ControlResponse, peerIdentity: PeerIdentity?) {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ControlSocketServer.currentPOSIXError() }
        try ControlSocketServer.disableSIGPIPE(descriptor)
        try ControlSocketServer.setClientTimeouts(
            descriptor,
            seconds: timeoutSeconds
        )
        defer { Darwin.close(descriptor) }
        try ControlSocketServer.withAddress(socketURL.standardizedFileURL.path) { address, length in
            guard Darwin.connect(descriptor, address, length) == 0 else {
                throw ControlSocketServer.currentPOSIXError()
            }
        }
        let peerIdentity = attestPeer ? try peerIdentity(descriptor) : nil
        try ControlSocketServer.writeAll(
            ControlSocketProtocol.encode(request, maximumFrameBytes: maximumFrameBytes),
            to: descriptor
        )
        let data = try ControlSocketServer.readFrame(
            descriptor,
            maximumFrameBytes: maximumFrameBytes
        )
        return (
            try JSONDecoder().decode(ControlResponse.self, from: data.dropLast()),
            peerIdentity
        )
    }

    private static func completeTimedOutEnable(
        socketURL: URL,
        maximumFrameBytes: Int,
        timeoutSeconds: Int
    ) throws -> ControlResponse {
        // The daemon handles one control client at a time. A status response therefore
        // proves that the timed-out enable handler has returned before readiness is read.
        let statusResponse: ControlResponse
        do {
            statusResponse = try exchange(
                request: ControlRequest(command: .status),
                to: socketURL,
                maximumFrameBytes: maximumFrameBytes,
                attestPeer: false,
                timeoutSeconds: timeoutSeconds
            ).response
        } catch {
            return try failClosedAfterTimedOutEnable(
                socketURL: socketURL,
                maximumFrameBytes: maximumFrameBytes,
                timeoutSeconds: timeoutSeconds
            )
        }
        guard statusResponse.ok,
              let statusData = statusResponse.message.data(using: .utf8),
              let status = try? JSONDecoder().decode(AgentStatus.self, from: statusData),
              status.daemonRunning,
              status.enabled,
              status.persistedState == .enabled,
              status.activationState == .preparing || status.activationState == .ready else {
            return try failClosedAfterTimedOutEnable(
                socketURL: socketURL,
                maximumFrameBytes: maximumFrameBytes,
                timeoutSeconds: timeoutSeconds
            )
        }
        return ControlResponse(ok: true, message: status.activationState.rawValue)
    }

    private static func failClosedAfterTimedOutEnable(
        socketURL: URL,
        maximumFrameBytes: Int,
        timeoutSeconds: Int
    ) throws -> ControlResponse {
        // This request is serialized after the uncertain enable/status work. An OK
        // response proves the persisted collector state was turned back off.
        let offResponse: ControlResponse
        do {
            offResponse = try exchange(
                request: ControlRequest(command: .off),
                to: socketURL,
                maximumFrameBytes: maximumFrameBytes,
                attestPeer: false,
                timeoutSeconds: timeoutSeconds
            ).response
        } catch {
            throw ControlSocketError.enableCompletionUnverified
        }
        guard offResponse.ok else {
            throw ControlSocketError.enableCompletionUnverified
        }
        return ControlResponse(ok: false, message: "unable to enable")
    }

    private static func isSocketTimeout(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == NSPOSIXErrorDomain &&
            (nsError.code == Int(EAGAIN) || nsError.code == Int(EWOULDBLOCK))
    }

    private static func peerIdentity(_ descriptor: Int32) throws -> PeerIdentity {
        var auditToken = audit_token_t()
        var auditTokenSize = socklen_t(MemoryLayout<audit_token_t>.size)
        guard Darwin.getsockopt(
            descriptor,
            SOL_LOCAL,
            LOCAL_PEERTOKEN,
            &auditToken,
            &auditTokenSize
        ) == 0,
        auditTokenSize == MemoryLayout<audit_token_t>.size else {
            throw ControlSocketError.unsafeSocketPath
        }
        let auditTokenData = withUnsafeBytes(of: &auditToken) { Data($0) }
        guard auditTokenData.count == MemoryLayout<audit_token_t>.size,
              auditTokenData.contains(where: { $0 != 0 }) else {
            throw ControlSocketError.unsafeSocketPath
        }
        var path = [CChar](repeating: 0, count: Int(PATH_MAX) * 4)
        let count = proc_pidpath_audittoken(&auditToken, &path, UInt32(path.count))
        guard count > 0,
              Int(count) < path.count,
              path[Int(count)] == 0 else {
            throw ControlSocketError.unsafeSocketPath
        }
        let value = String(
            decoding: path.prefix(Int(count)).map { UInt8(bitPattern: $0) },
            as: UTF8.self
        )
        guard value.hasPrefix("/"), !value.contains("\n") else {
            throw ControlSocketError.unsafeSocketPath
        }
        return PeerIdentity(
            executableURL: URL(fileURLWithPath: value, isDirectory: false),
            auditToken: auditTokenData
        )
    }
}

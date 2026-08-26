import Darwin
import Foundation
import RuntimeRaidersCore
import Security

private let runtimeInputsVerificationArgument = "__runtime-raiders-verify-runtime-inputs"
private let managedAgentArgument = "__runtime-raiders-managed-agent"
private let runtimeInputsVerificationEnvironment = "RUNTIME_RAIDERS_VERIFY_RUNTIME_INPUTS"
private let applicationSupportVerificationEnvironment =
    "RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY"

private struct RuntimeInputs {
    let codexRoot: URL
    let surfaces: [RunSurface]
    let deviceID: String
    let dedupeSecret: Data
    let deviceToken: String
    let companionVersion: String
    let serverURL: URL

    init(enrollment: EnrollmentConfiguration) throws {
        let defaultRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/sessions", isDirectory: true)
        codexRoot = defaultRoot
        surfaces = enrollment.enabledSurfaces
        deviceID = enrollment.deviceID
        dedupeSecret = enrollment.dedupeSecret
        deviceToken = enrollment.deviceToken
        serverURL = enrollment.serverURL
        companionVersion = try InstalledCompanionVersion.load(from: .main)
    }
}

private enum CLIError: Error, CustomStringConvertible {
    case usage
    case invalidRuntimeConfiguration
    case updateCheckUnavailable
    case invalidStatusResponse
    case invalidControlResponse

    var description: String {
        switch self {
        case .usage: "usage: raiders on|off|status|doctor|uninstall|update"
        case .invalidRuntimeConfiguration: "Runtime Raiders enrollment configuration is invalid"
        case .updateCheckUnavailable: "Unable to check for a Runtime Raiders update."
        case .invalidStatusResponse: "Runtime Raiders status response was invalid."
        case .invalidControlResponse: "Runtime Raiders control response was invalid."
        }
    }
}

private let helpText = """
Usage: raiders <command>

Commands:
  on                       Turn collection on
  off                      Turn collection off
  status                   Show collection and agent status
  status --json            Show machine-readable status
  doctor                   Run content-free health checks
  update                   Check for a companion update
  uninstall                Stop the agent and preserve installed state
  help                     Show this help
"""

private final class CancellableDispatchTimer: @unchecked Sendable {
    private let workItem: DispatchWorkItem

    init(action: @escaping @Sendable () -> Void) {
        workItem = DispatchWorkItem(block: action)
    }

    func schedule(on queue: DispatchQueue, after delay: TimeInterval) {
        queue.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    func cancel() {
        workItem.cancel()
    }
}

private final class DaemonRuntime: @unchecked Sendable {
    private static let providerReconciliationInterval: TimeInterval = 5
    private let inputs: RuntimeInputs
    private let paths = AgentPaths()
    private let registry: AdapterRegistry
    private let outbox: Outbox
    private let controller: AgentController
    private let uploader: Uploader
    private let heartbeat: Heartbeat
    private var releaseChecker: ReleaseChecker?
    private var providerReconciliationTimer: DispatchSourceTimer?
    private let workQueue = DispatchQueue(
        label: "com.redlattice.runtime-raiders.daemon",
        qos: .utility
    )
    private let updateQueue = DispatchQueue(
        label: "com.redlattice.runtime-raiders.updates",
        qos: .utility
    )
    private let stopLock = NSLock()
    private var stopping = false
    private lazy var watcher = FileWatcher(
        registry: registry,
        processingQueue: workQueue
    ) { [weak self] files in
        self?.handleChangedFiles(files)
    }
    private lazy var activation = ActivationCoordinator(
        controller: controller,
        workerQueue: workQueue,
        operations: ActivationOperations(
            startWatching: { [weak self] in
                guard let self else { throw CLIError.invalidRuntimeConfiguration }
                try watcher.start(scanExistingFiles: false)
            },
            stopWatching: { [weak self] in self?.watcher.stop() },
            discoverProviderFiles: { [weak self] in
                guard let self else { throw CLIError.invalidRuntimeConfiguration }
                return try watcher.discoverProviderFiles()
            },
            scheduleUpload: { [weak self] in self?.uploader.schedule(enabled: true) },
            becameReady: { [weak self] in
                guard let self else { return }
                uploader.schedule(enabled: true)
                heartbeat.setEnabled(true)
            },
            becameDisabled: { [weak self] in
                self?.uploader.setEnabled(false)
                self?.heartbeat.setEnabled(false)
            }
        )
    )
    private lazy var control = ControlSocketServer(socketURL: paths.controlSocket)
    private lazy var versionCheckScheduler = RecurringVersionCheckScheduler(
        operations: VersionCheckScheduleOperations(
            checkIfDue: { [weak self] in
                _ = self?.releaseChecker?.checkIfDue()
            },
            execute: { [weak self] action in
                self?.updateQueue.async(execute: action)
            },
            scheduleAfter: { [weak self] delay, action in
                let timer = CancellableDispatchTimer(action: action)
                if let self {
                    timer.schedule(on: updateQueue, after: delay)
                } else {
                    timer.cancel()
                }
                return ScheduledVersionCheck {
                    timer.cancel()
                }
            }
        )
    )
    private lazy var startup = NormalDaemonStartupCoordinator(
        operations: DaemonStartupOperations(
            startControl: { [weak self] in
                guard let self else { throw CLIError.invalidRuntimeConfiguration }
                try control.startRequests { [weak self] request in
                    self?.handle(request) ?? ControlResponse(
                        ok: false,
                        message: "daemon unavailable"
                    )
                }
            },
            prepareLocalState: { [weak self] in
                guard let self else { throw CLIError.invalidRuntimeConfiguration }
                try outbox.prune(nowMS: Int64(Date().timeIntervalSince1970 * 1_000))
                releaseChecker = try? ReleaseChecker(
                    paths: paths,
                    installedVersion: inputs.companionVersion
                )
            },
            activatePersistedEnabled: { [weak self] in
                guard let self else { throw CLIError.invalidRuntimeConfiguration }
                _ = try activation.turnOn()
            },
            scheduleVersionCheck: { [weak self] in
                self?.versionCheckScheduler.start()
            }
        )
    )

    init(inputs: RuntimeInputs) throws {
        self.inputs = inputs
        registry = try AdapterRegistry.enabled(surfaces: inputs.surfaces, codexRoot: inputs.codexRoot)
        outbox = try Outbox(directory: paths.outboxDirectory)
        controller = try AgentController(
            registry: registry,
            paths: paths,
            outbox: outbox,
            configuration: AgentConfiguration(
                companionVersion: inputs.companionVersion,
                deviceID: inputs.deviceID,
                dedupeSecret: inputs.dedupeSecret
            ),
            diagnosticHandler: { diagnostic in
                FileHandle.standardError.write(
                    Data("Runtime Raiders collector: \(diagnostic.rawValue)\n".utf8)
                )
            }
        )
        let uploadConfiguration = UploadConfiguration(
            origin: inputs.serverURL,
            deviceToken: inputs.deviceToken
        )
        uploader = try Uploader(
            outbox: outbox,
            configuration: uploadConfiguration,
            cancellableTransport: Uploader.liveCancellableTransport
        )
        heartbeat = try Heartbeat(
            configuration: uploadConfiguration,
            companionVersion: inputs.companionVersion,
            cancellableTransport: Uploader.liveCancellableTransport
        )
    }

    func run() throws {
        do {
            try startup.start(persistedEnabled: controller.enabled)
            startProviderReconciliation()
            while !stopLock.withLock({ stopping }) {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
            }
            versionCheckScheduler.stop()
            stopProviderReconciliation()
            controller.pauseCollection()
            uploader.setEnabled(false)
            watcher.stop()
            heartbeat.setEnabled(false)
            control.stop()
        } catch {
            versionCheckScheduler.stop()
            stopProviderReconciliation()
            controller.pauseCollection()
            uploader.setEnabled(false)
            watcher.stop()
            heartbeat.setEnabled(false)
            control.stop()
            throw error
        }
    }

    private func handleChangedFiles(_ files: [URL]) {
        activation.processChangedFiles(files)
    }

    private func startProviderReconciliation() {
        guard providerReconciliationTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: workQueue)
        timer.schedule(
            deadline: .now() + Self.providerReconciliationInterval,
            repeating: Self.providerReconciliationInterval,
            leeway: .milliseconds(500)
        )
        timer.setEventHandler { [weak self] in
            guard let self, controller.enabled,
                  let files = try? watcher.discoverProviderFiles() else { return }
            activation.reconcileProviderFiles(files)
        }
        providerReconciliationTimer = timer
        timer.resume()
    }

    private func stopProviderReconciliation() {
        providerReconciliationTimer?.cancel()
        providerReconciliationTimer = nil
    }

    private func handle(_ request: ControlRequest) -> ControlResponse {
        switch request.command {
        case .daemon:
            return ControlResponse(ok: false, message: "daemon is already running")
        case .on:
            do {
                let state = try activation.turnOn()
                return ControlResponse(ok: true, message: state.rawValue)
            } catch {
                return ControlResponse(ok: false, message: "unable to enable")
            }
        case .off:
            do {
                try activation.turnOff()
                return ControlResponse(ok: true, message: "disabled")
            } catch {
                return ControlResponse(ok: false, message: "unable to turn off")
            }
        case .status:
            do {
                let status = try currentStatus()
                return ControlResponse(ok: true, message: status.description)
            } catch {
                return ControlResponse(ok: false, message: "status unavailable")
            }
        case .doctor:
            let report = controller.doctor(
                codexRootReadable: Self.codexRootReadable(inputs.codexRoot),
                serverHealthy: Self.serverHealthy(),
                signingValid: Self.processSigningValid(),
                enrollmentAllowedSurfaces: inputs.surfaces,
                claudeOTelEnvironmentPresent: DoctorEnvironment.combinedPresence(
                    invocationPresent: request.claudeOTelEnvironmentPresent == true,
                    daemonEnvironment: ProcessInfo.processInfo.environment
                )
            )
            return ControlResponse(ok: true, message: report.description)
        case .uninstall:
            controller.pauseCollection()
            uploader.setEnabled(false)
            heartbeat.setEnabled(false)
            watcher.stop()
            return workQueue.sync {
                do {
                    try controller.turnOff()
                    stopLock.withLock { stopping = true }
                    return ControlResponse(
                        ok: true,
                        message: "daemon stopped; installed files and queued state preserved"
                    )
                } catch {
                    return ControlResponse(ok: false, message: "unable to persist off state")
                }
            }
        }
    }

    private func currentStatus() throws -> AgentStatus {
        try controller.status(
            daemonRunning: true,
            serverEnabledSurfaces: inputs.surfaces,
            lastSuccessfulUploadMS: uploader.lastSuccessfulUploadMS,
            installedCompanionVersion: inputs.companionVersion,
            availableCompanionVersion: releaseChecker?.availability()
        )
    }

    fileprivate static func serverHealthy() -> Bool {
        var request = URLRequest(url: URL(string: "https://raiders.redlattice.com/health")!)
        request.httpMethod = "GET"
        request.timeoutInterval = 2
        guard let response = try? Uploader.liveTransport(request) else { return false }
        return (200..<300).contains(response.statusCode)
    }

    fileprivate static func codexRootReadable(_ root: URL) -> Bool {
        Darwin.access(root.path, R_OK | X_OK) == 0
    }

    fileprivate static func processSigningValid() -> Bool {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return false }
        return SecCodeCheckValidity(code, SecCSFlags(), nil) == errSecSuccess
    }
}

private func runUpdateCheck(
    paths: AgentPaths,
    environment: [String: String],
    verificationReadOnly: Bool = false
) throws {
    let installed = try InstalledCompanionVersion.load(from: .main)
    let verificationTransport: ReleaseChecker.Transport?
    do {
        verificationTransport = try ReleaseChecker.verificationTransport(environment: environment)
    } catch {
        if verificationReadOnly { throw CLIError.usage }
        throw error
    }
    if verificationReadOnly {
        guard let verificationTransport else { throw CLIError.usage }
        var request = URLRequest(url: VersionDocument.url)
        request.httpMethod = "GET"
        let response: UploadHTTPResponse
        do {
            response = try verificationTransport(request)
        } catch {
            throw CLIError.updateCheckUnavailable
        }
        guard response.statusCode == 200,
              let fetched = try? VersionDocument.decode(response.body),
              let installedVersion = try? SemanticVersion(installed),
              let fetchedVersion = try? SemanticVersion(fetched.version) else {
            throw CLIError.updateCheckUnavailable
        }
        if installedVersion < fetchedVersion {
            print("Runtime Raiders \(fetched.version) is available.")
            print("Run:")
            print("curl -fsSL https://raiders.redlattice.com/install.sh | sh")
        } else {
            print("Runtime Raiders \(installed) is current.")
        }
        return
    }
    let checker = try ReleaseChecker(
        paths: paths,
        installedVersion: installed,
        transport: verificationTransport ?? ReleaseChecker.liveTransport
    )
    do {
        _ = try checker.fetchNow()
    } catch {
        throw CLIError.updateCheckUnavailable
    }
    if let available = checker.availability() {
        print("Runtime Raiders \(available) is available.")
        print("Run:")
        print("curl -fsSL https://raiders.redlattice.com/install.sh | sh")
    } else {
        print("Runtime Raiders \(installed) is current.")
    }
}

private func run() throws {
    let environment = ProcessInfo.processInfo.environment
    let arguments = Array(CommandLine.arguments.dropFirst())
    let style = outputStyle(
        isTTY: Darwin.isatty(STDOUT_FILENO) == 1,
        environment: environment
    )
    if let verificationPaths = try verificationPaths(environment: environment) {
        switch arguments {
        case ["status"]:
            try printLocalStatus(
                paths: verificationPaths,
                format: .pretty,
                style: style,
                readCachedUpdateState: false,
                daemonRunning: true
            )
        case ["status", "--json"]:
            try printLocalStatus(
                paths: verificationPaths,
                format: .json,
                style: style,
                readCachedUpdateState: false,
                daemonRunning: true
            )
        case ["help"], ["--help"]:
            print(helpText)
        case ["update"]:
            try runUpdateCheck(
                paths: verificationPaths,
                environment: environment,
                verificationReadOnly: true
            )
        case [runtimeInputsVerificationArgument]:
            let enrollment = try EnrollmentConfiguration.loadExisting(
                from: verificationPaths.stateDirectory.appendingPathComponent("enrollment.json")
            )
            print(try RuntimeInputs(enrollment: enrollment).companionVersion)
        case let arguments where arguments.count == 2 && arguments.first == managedAgentArgument:
            guard let executableURL = Bundle.main.executableURL,
                  executableURL.standardizedFileURL.path ==
                    verificationPaths.agentExecutable.standardizedFileURL.path,
                  let action = ManagedAgentAction(rawValue: arguments[1]) else {
                throw CLIError.usage
            }
            print(verificationManagedAgentStatus(for: action).rawValue)
        default:
            throw CLIError.usage
        }
        return
    }
    guard arguments != [runtimeInputsVerificationArgument] else { throw CLIError.usage }
    let paths = AgentPaths()
    guard let executableURL = Bundle.main.executableURL,
          let route = CompanionCommandRouter.route(
              arguments: arguments,
              executableURL: executableURL,
              paths: paths
          ) else {
        throw CLIError.usage
    }

    switch route {
    case .daemon:
        let enrollment = try EnrollmentConfiguration.load(
            from: paths.stateDirectory.appendingPathComponent("enrollment.json")
        )
        try DaemonRuntime(inputs: RuntimeInputs(enrollment: enrollment)).run()
        return
    case let .managedAgent(action):
        print(try ManagedAgentServiceController.live.perform(action).rawValue)
        return
    case .updateCheck:
        try runUpdateCheck(paths: paths, environment: environment)
        return
    case .help:
        print(helpText)
        return
    case let .status(format):
        try runStatusCommand(paths: paths, format: format, style: style)
        return
    case let .control(command):
        try runUserControlCommand(command, paths: paths, style: style)
    }
}

private func verificationManagedAgentStatus(
    for action: ManagedAgentAction
) -> ManagedAgentStatus {
    switch action {
    case .register, .status:
        return .enabled
    case .unregister:
        return .notRegistered
    }
}

private func verificationPaths(environment: [String: String]) throws -> AgentPaths? {
    guard let path = environment[applicationSupportVerificationEnvironment] else {
        return nil
    }
    guard environment[runtimeInputsVerificationEnvironment] == "1",
          let root = verificationRoot(forApplicationSupportPath: path) else {
        throw CLIError.usage
    }
    let home = root.appendingPathComponent("home", isDirectory: true)
    let library = home.appendingPathComponent("Library", isDirectory: true)
    let applicationSupport = library.appendingPathComponent("Application Support", isDirectory: true)
    let paths = AgentPaths(applicationSupportDirectory: applicationSupport)
    for directory in [
        root,
        home,
        library,
        applicationSupport,
        paths.supportDirectory,
        paths.stateDirectory,
        paths.outboxDirectory,
    ] {
        guard isExactOwnerOnlyPhysicalDirectory(directory) else { throw CLIError.usage }
    }
    return paths
}

private func verificationRoot(forApplicationSupportPath path: String) -> URL? {
    let prefix = "/private/tmp/rrv."
    let suffix = "/home/Library/Application Support"
    guard path.hasPrefix(prefix), path.hasSuffix(suffix) else { return nil }
    let tokenStart = path.index(path.startIndex, offsetBy: prefix.count)
    let tokenEnd = path.index(path.endIndex, offsetBy: -suffix.count)
    guard tokenStart <= tokenEnd else { return nil }
    let token = path[tokenStart..<tokenEnd]
    guard token.utf8.count == 6,
          token.utf8.allSatisfy({ byte in
              (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
          }) else {
        return nil
    }
    let rootPath = prefix + String(token)
    guard path == rootPath + suffix else { return nil }
    return URL(fileURLWithPath: rootPath, isDirectory: true)
}

private func isExactOwnerOnlyPhysicalDirectory(_ directory: URL) -> Bool {
    var pathMetadata = stat()
    guard Darwin.lstat(directory.path, &pathMetadata) == 0,
          pathMetadata.st_mode & S_IFMT == S_IFDIR,
          pathMetadata.st_uid == Darwin.geteuid(),
          pathMetadata.st_mode & 0o777 == 0o700 else {
        return false
    }
    let descriptor = Darwin.open(
        directory.path,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard descriptor >= 0 else { return false }
    defer { Darwin.close(descriptor) }
    var openedMetadata = stat()
    return Darwin.fstat(descriptor, &openedMetadata) == 0 &&
        openedMetadata.st_mode & S_IFMT == S_IFDIR &&
        openedMetadata.st_uid == Darwin.geteuid() &&
        openedMetadata.st_mode & 0o777 == 0o700 &&
        openedMetadata.st_dev == pathMetadata.st_dev &&
        openedMetadata.st_ino == pathMetadata.st_ino
}

private func runStatusCommand(
    paths: AgentPaths,
    format: StatusOutputFormat,
    style: OutputStyle
) throws {
    do {
        let request = ControlRequest(command: .status)
        let response = try ControlSocketClient.send(
            request: request,
            to: paths.controlSocket
        )
        guard response.ok,
              let data = response.message.data(using: .utf8),
              let status = try? JSONDecoder().decode(AgentStatus.self, from: data) else {
            throw CLIError.invalidStatusResponse
        }
        print(renderStatus(status, format: format, style: style))
    } catch {
        guard daemonIsUnavailable(error) else { throw error }
        try printLocalStatus(paths: paths, format: format, style: style)
    }
}

private func runUserControlCommand(
    _ command: ControlCommand,
    paths: AgentPaths,
    style: OutputStyle
) throws {
    do {
        let request = ControlRequest.invocation(
            command: command,
            environment: ProcessInfo.processInfo.environment
        )
        let response = try ControlSocketClient.send(request: request, to: paths.controlSocket)
        if !response.ok {
            print(response.message)
            Foundation.exit(EXIT_FAILURE)
        }
        switch command {
        case .on:
            let state: CollectorActivationState
            switch response.message {
            case "preparing": state = .preparing
            case "ready": state = .ready
            default: throw CLIError.invalidControlResponse
            }
            print(CollectionCommandRenderer.render(enabled: true, activationState: state, style: style))
        case .off:
            guard response.message == "disabled" else { throw CLIError.invalidControlResponse }
            print(CollectionCommandRenderer.render(
                enabled: false,
                activationState: .disabled,
                style: style
            ))
        case .doctor, .uninstall:
            print(response.message)
        case .daemon, .status:
            throw CLIError.invalidControlResponse
        }
    } catch {
        guard daemonIsUnavailable(error) else { throw error }
        switch command {
        case .doctor:
            print(localDoctor(paths: paths).description)
        case .on, .off, .daemon, .status, .uninstall:
            throw error
        }
    }
}

private func printLocalStatus(
    paths: AgentPaths,
    format: StatusOutputFormat,
    style: OutputStyle,
    readCachedUpdateState: Bool = true,
    daemonRunning: Bool = false
) throws {
    let status = try localStatus(
        paths: paths,
        readCachedUpdateState: readCachedUpdateState,
        daemonRunning: daemonRunning
    )
    print(renderStatus(status, format: format, style: style))
}

private func renderStatus(
    _ status: AgentStatus,
    format: StatusOutputFormat,
    style: OutputStyle
) -> String {
    switch format {
    case .json:
        return status.description
    case .pretty:
        return StatusRenderer.render(
            status,
            nowMS: Int64(Date().timeIntervalSince1970 * 1_000),
            style: style
        )
    }
}

private func daemonIsUnavailable(_ error: Error) -> Bool {
    guard let posix = error as? POSIXError else { return false }
    return posix.code == .ENOENT || posix.code == .ECONNREFUSED
}

private func localStatus(
    paths: AgentPaths,
    readCachedUpdateState: Bool = true,
    daemonRunning: Bool = false
) throws -> AgentStatus {
    let enrollment = try? EnrollmentConfiguration.loadExisting(
        from: paths.stateDirectory.appendingPathComponent("enrollment.json")
    )
    let surfaces = enrollment?.enabledSurfaces ?? []
    let codexRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".codex/sessions", isDirectory: true)
    let registry = try? AdapterRegistry.enabled(surfaces: surfaces, codexRoot: codexRoot)
    var health: [RunSurface: AdapterHealth] = [
        .claudeCode: .unavailable,
        .omp: .unavailable,
        .codexDesktop: .disabled,
        .codexCLI: .disabled,
    ]
    for surface in surfaces { health[surface] = .unavailable }
    for surface in registry?.surfaces ?? [] { health[surface] = .available }
    let persistedState = (try? AgentController.persistedCollectorState(
        paths: paths,
        surfaces: surfaces
    )) ?? .invalid
    let queuedCount = (try? Outbox.queuedCount(
        inExistingDirectory: paths.outboxDirectory
    )) ?? 0
    let installedVersion = try InstalledCompanionVersion.load(from: .main)
    let cachedVersion = readCachedUpdateState
        ? (try? UpdateStateStore(paths: paths).load())?.availableVersion
        : nil
    let updateAvailability = ReleaseChecker.availableVersion(
        installedVersion: installedVersion,
        cachedVersion: cachedVersion
    )
    let adapterFacts = (try? AgentController.persistedAdapterFacts(
        paths: paths,
        surfaces: surfaces
    )) ?? PersistedAdapterFacts(activeRunCount: 0, compatibilityReasons: [])
    return AgentStatus(
        enabled: persistedState == .enabled,
        daemonRunning: daemonRunning,
        persistedState: persistedState,
        serverEnabledSurfaces: surfaces.sorted { $0.rawValue < $1.rawValue },
        compiledAdapters: health,
        queuedEventCount: queuedCount,
        lastSuccessfulUploadMS: nil,
        activeRunCount: adapterFacts.activeRunCount,
        installedCompanionVersion: installedVersion,
        availableCompanionVersion: updateAvailability,
        updateCommand: updateAvailability == nil ? nil : "raiders update"
    )
}

private func localDoctor(paths: AgentPaths) -> DoctorReport {
    let enrollment = try? EnrollmentConfiguration.loadExisting(
        from: paths.stateDirectory.appendingPathComponent("enrollment.json")
    )
    let environment = ProcessInfo.processInfo.environment
    let codexRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".codex/sessions", isDirectory: true)
    let adapterFacts = (try? AgentController.persistedAdapterFacts(
        paths: paths,
        surfaces: enrollment?.enabledSurfaces ?? []
    )) ?? PersistedAdapterFacts(activeRunCount: 0, compatibilityReasons: [])
    return DoctorReport(
        codexRootReadable: DaemonRuntime.codexRootReadable(codexRoot),
        serverHealthy: DaemonRuntime.serverHealthy(),
        signingValid: DaemonRuntime.processSigningValid(),
        enrollmentMatchesCompiledAdapters: enrollment != nil,
        claudeOTelEnvironmentPresent: DoctorEnvironment.claudeOTelPresent(
            in: environment
        ),
        compatibilityNeedsReview: !adapterFacts.compatibilityReasons.isEmpty,
        compatibilityReasons: adapterFacts.compatibilityReasons
    )
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    Foundation.exit(EXIT_FAILURE)
}

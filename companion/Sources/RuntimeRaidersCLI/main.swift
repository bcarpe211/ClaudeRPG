import Darwin
import Foundation
import RuntimeRaidersCore
import Security

private let runtimeInputsVerificationArgument = "__runtime-raiders-verify-runtime-inputs"
private let managedAgentArgument = "__runtime-raiders-managed-agent"
private let runtimeInputsVerificationEnvironment = "RUNTIME_RAIDERS_VERIFY_RUNTIME_INPUTS"
private let applicationSupportVerificationEnvironment =
    "RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY"
private let lifecycleVerificationEnvironment = "RUNTIME_RAIDERS_VERIFY_LIFECYCLE_SCENARIO"

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
    case lifecycleRequiresTerminal
    case invalidLifecycleConfirmation
    case lifecycleInputEnded
    case lifecycleInputInterrupted
    case lifecycleInputUnavailable
    case collectionMustBeOff
    case invalidEnrollment
    case recoveryRequired
    case revocationRequired
    case assistedRecoveryRequired
    case lifecycleFailed

    var description: String {
        switch self {
        case .usage: "usage: raiders on|off|status|status --json|doctor|re-enroll|uninstall|uninstall --everything|update|help"
        case .invalidRuntimeConfiguration: "Runtime Raiders enrollment configuration is invalid"
        case .updateCheckUnavailable: "Unable to check for a Runtime Raiders update."
        case .invalidStatusResponse: "Runtime Raiders status response was invalid."
        case .invalidControlResponse: "Runtime Raiders control response was invalid."
        case .lifecycleRequiresTerminal:
            "Runtime Raiders lifecycle commands require an interactive terminal.\n" +
            "Next: run the command again from an interactive terminal."
        case .invalidLifecycleConfirmation:
            "Lifecycle confirmation was not exact. No lifecycle change was authorized.\n" +
            "Next: review the prompt and run the command again."
        case .lifecycleInputEnded:
            "Private lifecycle input ended before confirmation. No lifecycle change was authorized.\n" +
            "Next: run the command again from an interactive terminal."
        case .lifecycleInputInterrupted:
            "Lifecycle input was interrupted. No lifecycle change was authorized.\n" +
            "Next: run the command again from an interactive terminal."
        case .lifecycleInputUnavailable:
            "Private lifecycle input could not be controlled safely. No lifecycle change was authorized.\n" +
            "Next: run the command again from an interactive terminal."
        case .collectionMustBeOff:
            "Collection is ON. No enrollment change was made.\n" +
            "Next: run raiders off, then run raiders re-enroll again."
        case .invalidEnrollment:
            "The enrollment code was not accepted. Collection remains OFF.\n" +
            "Next: create a fresh code and run raiders re-enroll again."
        case .recoveryRequired:
            "Runtime Raiders needs assisted recovery. Collection remains OFF.\n" +
            "Next: run raiders re-enroll again; if it still fails, seek assisted recovery."
        case .revocationRequired:
            "Device revocation could not be confirmed. No local data was deleted.\n" +
            "Next: reconnect and run raiders uninstall --everything again."
        case .assistedRecoveryRequired:
            "Local enrollment needs assisted recovery. No local data was deleted.\n" +
            "Next: seek assisted recovery before removing local state."
        case .lifecycleFailed:
            "Runtime Raiders lifecycle operation could not be completed safely.\n" +
            "Next: run raiders status, then retry the lifecycle command."
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
  re-enroll                Change this device's Raider enrollment
  uninstall                Remove the app and preserve local state
  uninstall --everything   Revoke and remove all local Runtime Raiders data
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
        if let rawScenario = environment[lifecycleVerificationEnvironment] {
            guard let scenario = LifecycleVerificationScenario(rawValue: rawScenario),
                  let executableURL = Bundle.main.executableURL,
                  let route = CompanionCommandRouter.route(
                      arguments: arguments,
                      executableURL: executableURL,
                      paths: verificationPaths
                  ),
                  route.isLifecycle else {
                throw CLIError.usage
            }
            let home = verificationPaths.supportDirectory
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
            try runLifecycleCommand(
                route,
                paths: verificationPaths,
                homeDirectory: home,
                scenario: scenario
            )
            return
        }
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
    case .reEnroll, .uninstall:
        try runLifecycleCommand(
            route,
            paths: paths,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            scenario: nil
        )
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

private extension CompanionCommandRoute {
    var isLifecycle: Bool {
        switch self {
        case .reEnroll, .uninstall:
            true
        case .daemon, .managedAgent, .control, .status, .updateCheck, .help:
            false
        }
    }
}

private enum LifecycleVerificationScenario: String, Sendable {
    case reEnrollCompletedEmpty = "re-enroll-completed-empty"
    case reEnrollCompletedQueued = "re-enroll-completed-queued"
    case reEnrollCollectionOn = "re-enroll-collection-on"
    case reEnrollInvalidEnrollmentEmpty = "re-enroll-invalid-enrollment-empty"
    case reEnrollRecoveryRequiredEmpty = "re-enroll-recovery-required-empty"
    case reEnrollSetupFailure = "re-enroll-setup-failure"
    case uninstallPreserveCompleted = "uninstall-preserve-completed"
    case uninstallEverythingCompletedEmpty = "uninstall-everything-completed-empty"
    case uninstallEverythingCompletedQueued = "uninstall-everything-completed-queued"
    case uninstallEverythingRevocationRequiredEmpty =
        "uninstall-everything-revocation-required-empty"
    case uninstallEverythingAssistedRecoveryEmpty =
        "uninstall-everything-assisted-recovery-empty"
    case uninstallSetupFailure = "uninstall-setup-failure"

    var queueCount: Int {
        switch self {
        case .reEnrollCompletedQueued, .uninstallEverythingCompletedQueued: 2
        default: 0
        }
    }
}

private final class LifecyclePromptErrorBox {
    private(set) var error: CLIError?

    func record<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let error as CLIError {
            self.error = error
            throw error
        }
    }
}

private func runLifecycleCommand(
    _ route: CompanionCommandRoute,
    paths: AgentPaths,
    homeDirectory: URL,
    scenario: LifecycleVerificationScenario?
) throws {
    let terminal = LifecycleTerminalReader()
    do {
        switch route {
        case .reEnroll:
            try requireLifecycleTerminal(terminal)
            if let scenario {
                try runVerificationReEnrollment(
                    scenario,
                    terminal: terminal,
                    paths: paths
                )
            } else {
                try runLiveReEnrollment(
                    terminal: terminal,
                    paths: paths,
                    homeDirectory: homeDirectory
                )
            }
        case let .uninstall(mode):
            if mode == .everything { try requireLifecycleTerminal(terminal) }
            if let scenario {
                try runVerificationRemoval(
                    scenario,
                    mode: mode,
                    terminal: terminal,
                    paths: paths
                )
            } else {
                try runLiveRemoval(
                    mode: mode,
                    terminal: terminal,
                    paths: paths,
                    homeDirectory: homeDirectory
                )
            }
        case .daemon, .managedAgent, .control, .status, .updateCheck, .help:
            throw CLIError.usage
        }
    } catch let error as CLIError {
        throw error
    } catch {
        throw CLIError.lifecycleFailed
    }
}

private func requireLifecycleTerminal(_ terminal: LifecycleTerminalReader) throws {
    do {
        try terminal.validate()
    } catch {
        throw CLIError.lifecycleRequiresTerminal
    }
}

private func privateLine(
    terminal: LifecycleTerminalReader,
    prompt: String,
    maximumBytes: Int
) throws -> String {
    do {
        return try terminal.readLine(prompt: prompt, maximumBytes: maximumBytes)
    } catch let error as LifecycleTerminalError {
        switch error {
        case .endOfFile: throw CLIError.lifecycleInputEnded
        case .interrupted: throw CLIError.lifecycleInputInterrupted
        case .invalidInput: throw CLIError.invalidLifecycleConfirmation
        case .unavailable: throw CLIError.lifecycleInputUnavailable
        }
    } catch {
        throw CLIError.lifecycleInputUnavailable
    }
}

private func isExactEnrollmentCode(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 43 else { return false }
    return bytes.allSatisfy { byte in
        (0x41...0x5A).contains(byte) ||
            (0x61...0x7A).contains(byte) ||
            (0x30...0x39).contains(byte) ||
            byte == 0x5F ||
            byte == 0x2D
    }
}

private func requireExactPrivateLine(
    _ expected: String,
    terminal: LifecycleTerminalReader,
    prompt: String,
    maximumBytes: Int
) throws {
    guard try privateLine(
        terminal: terminal,
        prompt: prompt,
        maximumBytes: maximumBytes
    ) == expected else {
        throw CLIError.invalidLifecycleConfirmation
    }
}

private func queueDisposition(
    count: Int,
    terminal: LifecycleTerminalReader
) throws -> QueueDisposition {
    guard count > 0 else { return .cancel }
    switch try privateLine(
        terminal: terminal,
        prompt: "Choose deliver, discard, or cancel: ",
        maximumBytes: 32
    ) {
    case "deliver":
        return .deliver
    case "discard":
        try requireExactPrivateLine(
            "DISCARD",
            terminal: terminal,
            prompt: "Type DISCARD to discard \(count) queued events: ",
            maximumBytes: 64
        )
        return .discard
    case "cancel":
        return .cancel
    default:
        throw CLIError.invalidLifecycleConfirmation
    }
}

private func printReEnrollmentSummary(queueCount: Int, version: String) {
    print("Runtime Raiders re-enrollment")
    print("Collection: OFF")
    print("Background agent: Stopped")
    print("Queued events: \(queueCount)")
    print("Installed version: \(version)")
    print("Runs, scores, and rewards remain with their original Raider.")
}

private func printReEnrollmentOutcome(_ outcome: ReEnrollmentOutcome) throws {
    switch outcome {
    case .completed:
        print("Runtime Raiders re-enrollment succeeded.")
        print("Collection remains OFF.")
        print("History was not transferred; Runs, scores, and rewards remain with their original Raider.")
        print("Next: run raiders status, then deliberately run raiders on.")
    case .cancelled:
        print("Runtime Raiders re-enrollment was cancelled.")
        print("Collection remains OFF; enrollment and queued events were unchanged.")
        print("Next: run raiders status.")
    case .collectionMustBeOff:
        throw CLIError.collectionMustBeOff
    case .invalidEnrollment:
        throw CLIError.invalidEnrollment
    case .recoveryRequired:
        throw CLIError.recoveryRequired
    }
}

private func runLiveReEnrollment(
    terminal: LifecycleTerminalReader,
    paths: AgentPaths,
    homeDirectory: URL
) throws {
    let lifecyclePaths = try CompanionLifecyclePaths(homeDirectory: homeDirectory)
    let enrollment = try EnrollmentConfiguration.loadExisting(from: lifecyclePaths.enrollment)
    guard try AgentController.persistedCollectorState(
        paths: lifecyclePaths.agent,
        surfaces: enrollment.enabledSurfaces
    ) == .disabled else {
        throw CLIError.collectionMustBeOff
    }
    try stopDaemonAndPersistOff(paths: paths, allowMissingEnrollment: false)

    let version = try InstalledCompanionVersion.load(from: .main)
    let outbox = try Outbox(directory: lifecyclePaths.agent.outboxDirectory)
    let client = try EnrollmentClient(origin: enrollment.serverURL) { request in
        try Uploader.liveTransport(request)
    }
    let promptErrors = LifecyclePromptErrorBox()
    let baseOperations = try ReEnrollmentOperations.live(
        paths: lifecyclePaths,
        companionVersion: version,
        managedAgent: .live,
        outbox: outbox,
        enrollmentClient: client,
        uploadTransport: Uploader.liveTransport,
        summarize: { printReEnrollmentSummary(queueCount: $0, version: version) },
        confirmReEnrollment: {
            try promptErrors.record {
                try requireExactPrivateLine(
                    "RE-ENROLL",
                    terminal: terminal,
                    prompt: "Type RE-ENROLL to continue: ",
                    maximumBytes: 64
                )
                return true
            }
        },
        resolveQueue: { count in
            try promptErrors.record { try queueDisposition(count: count, terminal: terminal) }
        },
        requestCode: {
            try promptErrors.record {
                try privateLine(
                    terminal: terminal,
                    prompt: "Enrollment code: ",
                    maximumBytes: 64
                )
            }
        },
        delayMilliseconds: {
            Thread.sleep(forTimeInterval: TimeInterval($0) / 1_000)
        }
    )
    let operations = baseOperations.validatingCodeBeforeInitialJournal { code in
        try promptErrors.record {
            guard isExactEnrollmentCode(code) else { throw CLIError.invalidEnrollment }
        }
    }
    do {
        try printReEnrollmentOutcome(try ReEnrollmentCoordinator(operations: operations).run())
    } catch {
        if let promptError = promptErrors.error { throw promptError }
        if let cliError = error as? CLIError { throw cliError }
        throw CLIError.lifecycleFailed
    }
}

private func printCompleteRemovalSummary(queueCount: Int) {
    print("Runtime Raiders complete removal")
    print("Collection: OFF")
    print("Background agent: Stopped")
    print("Queued events: \(queueCount)")
    print("Remove: app, background agent, command, enrollment, collector state, queued events, and recovery state.")
    print("Raider, account, Runs, scores, rewards, and history will remain on the server.")
}

private func printRemovalOutcome(_ outcome: RemovalOutcome) throws {
    switch outcome {
    case .removedPreservingState:
        print("Runtime Raiders was removed.")
        print("Preserved: enrollment, collector state, queued events, and recovery state.")
        print("Browser login does not change the preserved enrollment.")
        print("Raider, account, Runs, scores, rewards, and history were preserved.")
        print("Next: reinstall Runtime Raiders to restore the companion; collection will remain OFF.")
    case .removedEverything:
        print("Runtime Raiders was removed and this device enrollment was revoked.")
        print("Removed: app, background agent, command, enrollment, collector state, queued events, and recovery state.")
        print("Raider, account, Runs, scores, rewards, and history were preserved.")
        print("Next: reinstall Runtime Raiders if you want to enroll this device again.")
    case .cancelled:
        print("Runtime Raiders removal was cancelled.")
        print("Collection remains OFF; no local data was deleted.")
        print("Next: run raiders status.")
    case .revocationRequired:
        throw CLIError.revocationRequired
    case .assistedRecoveryRequired:
        throw CLIError.assistedRecoveryRequired
    }
}

private func runLiveRemoval(
    mode: RemovalMode,
    terminal: LifecycleTerminalReader,
    paths: AgentPaths,
    homeDirectory: URL
) throws {
    let lifecyclePaths = try CompanionLifecyclePaths(homeDirectory: homeDirectory)
    let client = try EnrollmentClient(
        origin: URL(string: "https://raiders.redlattice.com")!
    ) { request in
        try Uploader.liveTransport(request)
    }
    let promptErrors = LifecyclePromptErrorBox()
    let operations = RemovalOperations.live(
        paths: lifecyclePaths,
        managedAgent: .live,
        enrollmentClient: client,
        persistCollectionOff: {
            var metadata = stat()
            if Darwin.lstat(lifecyclePaths.enrollment.path, &metadata) != 0, errno == ENOENT {
                return
            }
            let enrollment = try EnrollmentConfiguration.loadExisting(
                from: lifecyclePaths.enrollment
            )
            try AgentController.persistDisabledForRecovery(
                paths: lifecyclePaths.agent,
                surfaces: enrollment.enabledSurfaces
            )
        },
        stopDaemon: {
            try stopDaemonAndPersistOff(paths: paths, allowMissingEnrollment: true)
        },
        summarize: { printCompleteRemovalSummary(queueCount: $0) },
        confirmDiscard: { count in
            try promptErrors.record {
                try requireExactPrivateLine(
                    "DISCARD",
                    terminal: terminal,
                    prompt: "Type DISCARD to discard \(count) queued events: ",
                    maximumBytes: 64
                )
                return true
            }
        },
        confirmEverything: {
            try promptErrors.record {
                try requireExactPrivateLine(
                    "UNINSTALL EVERYTHING",
                    terminal: terminal,
                    prompt: "Type UNINSTALL EVERYTHING to continue: ",
                    maximumBytes: 64
                )
                return true
            }
        },
        delayMilliseconds: {
            Thread.sleep(forTimeInterval: TimeInterval($0) / 1_000)
        }
    )
    do {
        try printRemovalOutcome(try RemovalCoordinator(operations: operations).run(mode: mode))
    } catch {
        if let promptError = promptErrors.error { throw promptError }
        if let cliError = error as? CLIError { throw cliError }
        throw CLIError.lifecycleFailed
    }
}

private final class LifecycleVerificationReEnrollmentLock:
    ReEnrollmentLock, @unchecked Sendable {}

private final class LifecycleVerificationReEnrollmentState: @unchecked Sendable {
    var installed: EnrollmentConfiguration
    var queueCount: Int
    var agentRegistered = true

    init(installed: EnrollmentConfiguration, queueCount: Int) {
        self.installed = installed
        self.queueCount = queueCount
    }
}

private func lifecycleVerificationEnrollment() throws -> EnrollmentConfiguration {
    try EnrollmentConfiguration(
        deviceID: "00000000-0000-4000-8000-000000000001",
        deviceToken: String(repeating: "A", count: 43),
        dedupeSecret: Data(repeating: 0xBB, count: 32),
        serverURL: URL(string: "https://raiders.redlattice.com")!,
        cutoverAtMS: 1,
        enabledSurfaces: [.codexCLI]
    )
}

private func captureLifecycleVerificationRequest(
    _ request: URLRequest,
    paths: AgentPaths
) throws {
    guard let path = request.url?.path,
          ["/api/raiders/re-enroll", "/api/raiders/devices/revoke-current"].contains(path),
          request.value(forHTTPHeaderField: "Authorization") != nil else {
        throw CLIError.lifecycleFailed
    }
    let capture =
        #"{"path":"\#(path)","authorization":"[REDACTED]","body":"[REDACTED]"}"#
    try writeLifecycleVerificationCapture(
        capture,
        named: "lifecycle-request-capture.json",
        paths: paths
    )
    try appendLifecycleVerificationAction("network:request", paths: paths)
}

private func verificationReplacementResponse(for request: URLRequest) throws -> Data {
    guard let body = request.httpBody,
          let object = try JSONSerialization.jsonObject(with: body) as? [String: Any],
          let deviceID = object["replacement_device_id"] as? String else {
        throw CLIError.lifecycleFailed
    }
    return try JSONSerialization.data(withJSONObject: [
        "device_id": deviceID,
        "dedupe_secret": String(repeating: "cc", count: 32),
        "server_url": "https://raiders.redlattice.com",
        "cutover_at": 2,
        "enabled_surfaces": ["codex_cli"],
    ], options: [.sortedKeys])
}

private func runVerificationReEnrollment(
    _ scenario: LifecycleVerificationScenario,
    terminal: LifecycleTerminalReader,
    paths: AgentPaths
) throws {
    guard scenario.rawValue.hasPrefix("re-enroll-") else { throw CLIError.usage }
    if scenario == .reEnrollSetupFailure { throw POSIXError(.EIO) }
    let oldEnrollment = try lifecycleVerificationEnrollment()
    let state = LifecycleVerificationReEnrollmentState(
        installed: oldEnrollment,
        queueCount: scenario.queueCount
    )
    let promptErrors = LifecyclePromptErrorBox()
    let client = try EnrollmentClient(origin: oldEnrollment.serverURL) { request in
        try captureLifecycleVerificationRequest(request, paths: paths)
        switch scenario {
        case .reEnrollCompletedEmpty, .reEnrollCompletedQueued:
            return UploadHTTPResponse(
                statusCode: 200,
                body: try verificationReplacementResponse(for: request)
            )
        case .reEnrollInvalidEnrollmentEmpty:
            return UploadHTTPResponse(
                statusCode: 401,
                body: Data(#"{"reason":"invalid_enrollment"}"#.utf8)
            )
        case .reEnrollRecoveryRequiredEmpty:
            throw POSIXError(.EIO)
        default:
            throw CLIError.usage
        }
    }
    try appendLifecycleVerificationAction("control:uninstall", paths: paths)
    let baseOperations = ReEnrollmentOperations(
        companionVersion: "1.2.3",
        acquireLock: {
            try appendLifecycleVerificationAction("coordinator:lock", paths: paths)
            return LifecycleVerificationReEnrollmentLock()
        },
        loadJournal: { nil },
        readEnrollment: {
            try appendLifecycleVerificationAction("coordinator:read-enrollment", paths: paths)
            return oldEnrollment
        },
        proveCollectionOff: {
            try appendLifecycleVerificationAction("coordinator:prove-collection-off", paths: paths)
            return scenario != .reEnrollCollectionOn
        },
        unregisterAgent: {
            state.agentRegistered = false
            try appendLifecycleVerificationAction("coordinator:unregister-agent", paths: paths)
        },
        verifyAgentUnregistered: {
            try appendLifecycleVerificationAction(
                "coordinator:verify-agent-unregistered",
                paths: paths
            )
            return !state.agentRegistered
        },
        countQueue: {
            try appendLifecycleVerificationAction("coordinator:count-queue", paths: paths)
            return state.queueCount
        },
        summarize: { printReEnrollmentSummary(queueCount: $0, version: "1.2.3") },
        confirmReEnrollment: {
            try appendLifecycleVerificationAction("coordinator:confirm-re-enrollment", paths: paths)
            return try promptErrors.record {
                try requireExactPrivateLine(
                    "RE-ENROLL",
                    terminal: terminal,
                    prompt: "Type RE-ENROLL to continue: ",
                    maximumBytes: 64
                )
                return true
            }
        },
        resolveQueue: { count in
            let disposition = try promptErrors.record {
                try queueDisposition(count: count, terminal: terminal)
            }
            if count > 0 {
                try appendLifecycleVerificationAction("queue:\(disposition)", paths: paths)
            }
            return disposition
        },
        deliverQueue: { _ in state.queueCount = 0 },
        discardQueue: { state.queueCount = 0 },
        generateMaterial: {
            ReplacementMaterial(
                operationID: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!,
                deviceID: UUID(uuidString: "00000000-0000-4000-8000-000000000003")!,
                deviceToken: String(repeating: "D", count: 43)
            )
        },
        writeJournal: { journal in
            try writeLifecycleVerificationCapture(
                #"{"phase":"\#(journal.phase.rawValue)","replacement_device_token":"[REDACTED]"}"#,
                named: "lifecycle-journal-capture.json",
                paths: paths
            )
            try appendLifecycleVerificationAction("coordinator:write-journal", paths: paths)
        },
        requestCode: {
            try promptErrors.record {
                try privateLine(
                    terminal: terminal,
                    prompt: "Enrollment code: ",
                    maximumBytes: 64
                )
            }
        },
        replace: { old, code, material, version in
            try client.replace(
                oldToken: old.deviceToken,
                code: code,
                material: material,
                companionVersion: version
            )
        },
        recover: { _ in throw POSIXError(.EIO) },
        persistEnrollment: {
            state.installed = $0
            try appendLifecycleVerificationAction("coordinator:persist-enrollment", paths: paths)
        },
        resetCollector: { _ in
            try appendLifecycleVerificationAction("coordinator:reset-collector", paths: paths)
        },
        registerAgent: {
            state.agentRegistered = true
            try appendLifecycleVerificationAction("coordinator:register-agent", paths: paths)
        },
        verifyEnrollmentAndOff: { expected, requireEmptyQueue in
            try appendLifecycleVerificationAction("coordinator:verify-enrollment-off", paths: paths)
            return state.installed == expected &&
                state.agentRegistered &&
                (!requireEmptyQueue || state.queueCount == 0)
        },
        delayMilliseconds: { _ in },
        removeJournal: {
            try appendLifecycleVerificationAction("coordinator:remove-journal", paths: paths)
        }
    )
    let operations = baseOperations.validatingCodeBeforeInitialJournal { code in
        try promptErrors.record {
            guard isExactEnrollmentCode(code) else { throw CLIError.invalidEnrollment }
        }
    }
    do {
        try printReEnrollmentOutcome(try ReEnrollmentCoordinator(operations: operations).run())
    } catch {
        if let promptError = promptErrors.error { throw promptError }
        if let cliError = error as? CLIError { throw cliError }
        throw CLIError.lifecycleFailed
    }
}

private func runVerificationRemoval(
    _ scenario: LifecycleVerificationScenario,
    mode: RemovalMode,
    terminal: LifecycleTerminalReader,
    paths: AgentPaths
) throws {
    guard scenario.rawValue.hasPrefix("uninstall-") else { throw CLIError.usage }
    if scenario == .uninstallSetupFailure { throw POSIXError(.EIO) }
    guard (mode == .preserveState) == (scenario == .uninstallPreserveCompleted) else {
        throw CLIError.usage
    }
    let enrollment = try lifecycleVerificationEnrollment()
    let promptErrors = LifecyclePromptErrorBox()
    let client = try EnrollmentClient(origin: enrollment.serverURL) { request in
        try captureLifecycleVerificationRequest(request, paths: paths)
        if scenario == .uninstallEverythingRevocationRequiredEmpty {
            return UploadHTTPResponse(
                statusCode: 401,
                body: Data(#"{"reason":"unauthorized"}"#.utf8)
            )
        }
        return UploadHTTPResponse(statusCode: 200, body: Data(#"{"revoked":true}"#.utf8))
    }
    let operations = RemovalOperations.lifecycleVerification(
        queueCount: scenario.queueCount,
        enrollment: enrollment,
        enrollmentLoadFails: scenario == .uninstallEverythingAssistedRecoveryEmpty,
        record: { try appendLifecycleVerificationAction($0, paths: paths) },
        summarize: { printCompleteRemovalSummary(queueCount: $0) },
        confirmDiscard: { count in
            try appendLifecycleVerificationAction("coordinator:confirm-discard", paths: paths)
            return try promptErrors.record {
                try requireExactPrivateLine(
                    "DISCARD",
                    terminal: terminal,
                    prompt: "Type DISCARD to discard \(count) queued events: ",
                    maximumBytes: 64
                )
                return true
            }
        },
        confirmEverything: {
            try appendLifecycleVerificationAction("coordinator:confirm-everything", paths: paths)
            return try promptErrors.record {
                try requireExactPrivateLine(
                    "UNINSTALL EVERYTHING",
                    terminal: terminal,
                    prompt: "Type UNINSTALL EVERYTHING to continue: ",
                    maximumBytes: 64
                )
                return true
            }
        },
        revoke: { try client.revoke(token: $0.deviceToken) }
    )
    do {
        try printRemovalOutcome(try RemovalCoordinator(operations: operations).run(mode: mode))
    } catch {
        if let promptError = promptErrors.error { throw promptError }
        if let cliError = error as? CLIError { throw cliError }
        throw CLIError.lifecycleFailed
    }
}

private func appendLifecycleVerificationAction(_ action: String, paths: AgentPaths) throws {
    let file = paths.stateDirectory.appendingPathComponent(
        "lifecycle-actions.log",
        isDirectory: false
    )
    let existing = (try? Data(contentsOf: file)) ?? Data()
    var data = existing
    data.append(Data((action + "\n").utf8))
    try data.write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
}

private func writeLifecycleVerificationCapture(
    _ value: String,
    named name: String,
    paths: AgentPaths
) throws {
    let file = paths.stateDirectory.appendingPathComponent(name, isDirectory: false)
    try Data(value.utf8).write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
}

private func stopDaemonAndPersistOff(
    paths: AgentPaths,
    allowMissingEnrollment: Bool
) throws {
    do {
        let response = try ControlSocketClient.send(.uninstall, to: paths.controlSocket)
        guard response.ok else { throw CLIError.lifecycleFailed }
    } catch {
        guard daemonIsUnavailable(error) else { throw error }
        let enrollmentFile = paths.stateDirectory.appendingPathComponent(
            "enrollment.json",
            isDirectory: false
        )
        var metadata = stat()
        if Darwin.lstat(enrollmentFile.path, &metadata) != 0,
           errno == ENOENT,
           allowMissingEnrollment {
            return
        }
        let enrollment = try EnrollmentConfiguration.loadExisting(from: enrollmentFile)
        try AgentController.persistDisabledForRecovery(
            paths: paths,
            surfaces: enrollment.enabledSurfaces
        )
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

import Darwin
import Foundation
import RuntimeRaidersCore
import Security

private struct RuntimeInputs {
    let codexRoot: URL
    let surfaces: [RunSurface]
    let deviceID: String
    let dedupeSecret: Data
    let deviceToken: String
    let companionVersion: String
    let releaseIdentity: CompanionReleaseIdentity
    let serverURL: URL

    init(enrollment: EnrollmentConfiguration, environment: [String: String]) {
        let defaultRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/sessions", isDirectory: true)
        codexRoot = defaultRoot
        surfaces = enrollment.enabledSurfaces
        deviceID = enrollment.deviceID
        dedupeSecret = enrollment.dedupeSecret
        deviceToken = enrollment.deviceToken
        serverURL = enrollment.serverURL
        releaseIdentity = compiledReleaseIdentity(environment: environment)
        companionVersion = releaseIdentity.companionVersion
    }
}

private enum CLIError: Error, CustomStringConvertible {
    case usage
    case missingRuntimeConfiguration
    case invalidRuntimeConfiguration

    var description: String {
        switch self {
        case .usage: "usage: raiders daemon|on|off|status|doctor|uninstall"
        case .missingRuntimeConfiguration: "Runtime Raiders enrollment configuration is unavailable"
        case .invalidRuntimeConfiguration: "Runtime Raiders enrollment configuration is invalid"
        }
    }
}

private final class DaemonRuntime: @unchecked Sendable {
    private let inputs: RuntimeInputs
    private let paths = AgentPaths()
    private let registry: AdapterRegistry
    private let outbox: Outbox
    private let controller: AgentController
    private let uploader: Uploader
    private let heartbeat: Heartbeat
    private let releaseChecker: ReleaseChecker?
    private let workQueue = DispatchQueue(
        label: "com.redlattice.runtime-raiders.daemon",
        qos: .utility
    )
    private let updateQueue = DispatchQueue(
        label: "com.redlattice.runtime-raiders.updates",
        qos: .utility
    )
    private let stopLock = NSLock()
    private let continuationLock = NSLock()
    private var stopping = false
    private var continuationScheduled = false
    private lazy var watcher = FileWatcher(
        registry: registry,
        processingQueue: workQueue
    ) { [weak self] files in
        self?.handleChangedFiles(files)
    }
    private lazy var control = ControlSocketServer(socketURL: paths.controlSocket)

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
        releaseChecker = try? ReleaseChecker(
            paths: paths,
            installed: inputs.releaseIdentity
        )
    }

    func run() throws {
        try control.startRequests { [weak self] request in
            self?.handle(request) ?? ControlResponse(ok: false, message: "daemon unavailable")
        }
        do {
            let files = try watcher.discoverProviderFiles()
            try controller.install(existingFiles: files)
            updateQueue.async { [releaseChecker] in
                _ = releaseChecker?.checkIfDue()
            }
            try outbox.prune(nowMS: Int64(Date().timeIntervalSince1970 * 1_000))
            scheduleReadContinuationIfNeeded()
            uploader.schedule(enabled: controller.enabled)
            heartbeat.setEnabled(controller.enabled)
            if controller.enabled { try watcher.start() }
            while !stopLock.withLock({ stopping }) {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
            }
            controller.pauseCollection()
            uploader.setEnabled(false)
            watcher.stop()
            heartbeat.setEnabled(false)
            control.stop()
        } catch {
            controller.pauseCollection()
            uploader.setEnabled(false)
            watcher.stop()
            heartbeat.setEnabled(false)
            control.stop()
            throw error
        }
    }

    private func handleChangedFiles(_ files: [URL]) {
        do {
            try controller.processChangedFiles(files)
            scheduleReadContinuationIfNeeded()
            guard controller.isAcceptingCollection else { return }
            try outbox.prune(nowMS: Int64(Date().timeIntervalSince1970 * 1_000))
            uploader.schedule(enabled: true)
        } catch {
            // Provider/user work is never impeded by collection failures.
        }
    }

    private func scheduleReadContinuationIfNeeded() {
        guard controller.hasPendingReadWork else { return }
        let shouldSchedule = continuationLock.withLock { () -> Bool in
            guard !continuationScheduled else { return false }
            continuationScheduled = true
            return true
        }
        guard shouldSchedule else { return }
        workQueue.asyncAfter(deadline: .now() + .milliseconds(150)) { [weak self] in
            guard let self else { return }
            continuationLock.withLock { continuationScheduled = false }
            do {
                try controller.continuePendingWork()
                scheduleReadContinuationIfNeeded()
            } catch {
                // A later file event or daemon restart resumes the persisted seed boundary.
            }
        }
    }

    private func handle(_ request: ControlRequest) -> ControlResponse {
        switch request.command {
        case .daemon:
            return ControlResponse(ok: false, message: "daemon is already running")
        case .on:
            return workQueue.sync {
                do {
                    let files = try watcher.discoverProviderFiles()
                    try controller.turnOn(existingFiles: files)
                    scheduleReadContinuationIfNeeded()
                    try watcher.start()
                    uploader.schedule(enabled: true)
                    heartbeat.setEnabled(true)
                    return ControlResponse(ok: true, message: "enabled")
                } catch {
                    uploader.setEnabled(false)
                    heartbeat.setEnabled(false)
                    watcher.stop()
                    try? controller.turnOff()
                    return ControlResponse(ok: false, message: "unable to enable")
                }
            }
        case .off:
            controller.pauseCollection()
            uploader.setEnabled(false)
            heartbeat.setEnabled(false)
            watcher.stop()
            return workQueue.sync {
                do {
                    try controller.turnOff()
                    uploader.setEnabled(false)
                    heartbeat.setEnabled(false)
                    return ControlResponse(ok: true, message: "off")
                } catch {
                    return ControlResponse(ok: false, message: "unable to turn off")
                }
            }
        case .status:
            do {
                let status = try controller.status(
                    daemonRunning: true,
                    serverEnabledSurfaces: inputs.surfaces,
                    lastSuccessfulUploadMS: uploader.lastSuccessfulUploadMS,
                    installedRelease: inputs.releaseIdentity,
                    updateAvailability: releaseChecker?.availability()
                )
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

private func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 1, let command = ControlCommand(rawValue: arguments[0]) else {
        throw CLIError.usage
    }
    if command == .daemon {
        let paths = AgentPaths()
        let enrollment = try EnrollmentConfiguration.load(
            from: paths.stateDirectory.appendingPathComponent("enrollment.json")
        )
        try DaemonRuntime(
            inputs: RuntimeInputs(
                enrollment: enrollment,
                environment: ProcessInfo.processInfo.environment
            )
        ).run()
        return
    }
    let paths = AgentPaths()
    do {
        let request = ControlRequest.invocation(
            command: command,
            environment: ProcessInfo.processInfo.environment
        )
        let response = try ControlSocketClient.send(
            request: request,
            to: paths.controlSocket
        )
        print(response.message)
        if !response.ok { Foundation.exit(EXIT_FAILURE) }
    } catch {
        guard daemonIsUnavailable(error) else { throw error }
        switch command {
        case .status:
            print(localStatus(paths: paths).description)
        case .doctor:
            print(localDoctor(paths: paths).description)
        default:
            throw error
        }
    }
}

private func daemonIsUnavailable(_ error: Error) -> Bool {
    guard let posix = error as? POSIXError else { return false }
    return posix.code == .ENOENT || posix.code == .ECONNREFUSED
}

private func localStatus(paths: AgentPaths) -> AgentStatus {
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
    let installed = localReleaseIdentity()
    let updateAvailability = (try? UpdateStateStore(paths: paths).load())?
        .cachedManifest?.availability(from: installed)
    let adapterFacts = (try? AgentController.persistedAdapterFacts(
        paths: paths,
        surfaces: surfaces
    )) ?? PersistedAdapterFacts(activeRunCount: 0, compatibilityReasons: [])
    return AgentStatus(
        enabled: persistedState == .enabled,
        daemonRunning: false,
        persistedState: persistedState,
        serverEnabledSurfaces: surfaces.sorted { $0.rawValue < $1.rawValue },
        compiledAdapters: health,
        queuedEventCount: queuedCount,
        lastSuccessfulUploadMS: nil,
        activeRunCount: adapterFacts.activeRunCount,
        installedCompanionVersion: installed.companionVersion,
        installedReleaseSequence: installed.releaseSequence,
        availableCompanionVersion: updateAvailability?.availableVersion,
        availableReleaseSequence: updateAvailability?.availableSequence,
        updateCommand: updateAvailability?.updateCommand
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

private func localReleaseIdentity() -> CompanionReleaseIdentity {
    compiledReleaseIdentity(environment: ProcessInfo.processInfo.environment)
}

private func compiledReleaseIdentity(
    environment: [String: String]
) -> CompanionReleaseIdentity {
    let dictionary: [String: Any] = [
        "CFBundleIdentifier": "com.redlattice.runtime-raiders-agent",
        "CFBundleShortVersionString": environment[
            "RUNTIME_RAIDERS_COMPANION_VERSION"
        ] ?? "0.1.0",
        "RuntimeRaidersReleaseSequence": 1,
        "RuntimeRaidersReleaseSHA": String(repeating: "0", count: 40),
        "RuntimeRaidersUpdateProtocolVersion": 1,
    ]
    if let identity = try? CompanionReleaseIdentity.parse(infoDictionary: dictionary) {
        return identity
    }
    return try! CompanionReleaseIdentity.parse(infoDictionary: [
        "CFBundleIdentifier": "com.redlattice.runtime-raiders-agent",
        "CFBundleShortVersionString": "0.1.0",
        "RuntimeRaidersReleaseSequence": 1,
        "RuntimeRaidersReleaseSHA": String(repeating: "0", count: 40),
        "RuntimeRaidersUpdateProtocolVersion": 1,
    ])
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    Foundation.exit(EXIT_FAILURE)
}

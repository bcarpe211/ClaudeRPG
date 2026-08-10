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

    init(enrollment: EnrollmentConfiguration) throws {
        let defaultRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/sessions", isDirectory: true)
        codexRoot = defaultRoot
        surfaces = enrollment.enabledSurfaces
        deviceID = enrollment.deviceID
        dedupeSecret = enrollment.dedupeSecret
        deviceToken = enrollment.deviceToken
        serverURL = enrollment.serverURL
        releaseIdentity = try CompanionReleaseIdentity.load(from: .main)
        companionVersion = releaseIdentity.companionVersion
    }
}

private enum CLIError: Error, CustomStringConvertible {
    case usage
    case missingRuntimeConfiguration
    case invalidRuntimeConfiguration
    case invalidUpdateState
    case updateOperationFailed

    var description: String {
        switch self {
        case .usage: "usage: raiders on|off|status|doctor|uninstall|update"
        case .missingRuntimeConfiguration: "Runtime Raiders enrollment configuration is unavailable"
        case .invalidRuntimeConfiguration: "Runtime Raiders enrollment configuration is invalid"
        case .invalidUpdateState: "Runtime Raiders update state is invalid"
        case .updateOperationFailed: "Runtime Raiders update operation failed"
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
    private var releaseChecker: ReleaseChecker?
    private var startupCoordinator: PreparedDaemonStartupCoordinator!
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
    private lazy var abandonmentOrchestrator = PreparedReleaseAbandonmentOrchestrator(
        coordinator: startupCoordinator,
        queue: updateQueue,
        preparedGeneration: { [weak self] in self?.updatePreparation.preparedGeneration },
        resumeAfterAbandonment: { [weak self] generation in
            self?.updatePreparation.resumeAfterAbandonment(generation: generation) ??
                ControlResponse(ok: false, message: "daemon unavailable")
        },
        exitUncommittedTrial: { [weak self] in self?.stopPreparedDaemon() },
        failClosed: { [weak self] in self?.stopPreparedDaemon() }
    )
    private lazy var updatePreparation = SerializedUpdatePreparation(
        workQueue: workQueue,
        activeRunCount: { [weak self] in
            guard let self else { throw CLIError.invalidRuntimeConfiguration }
            return try self.currentStatus().activeRunCount
        },
        validatePreparation: { [weak self] generation in
            guard let self else { throw CLIError.invalidRuntimeConfiguration }
            try startupCoordinator.validatePreparation(generation: generation)
        },
        pauseAcceptance: { [weak self] in self?.controller.pauseCollection() },
        pauseUploader: { [weak self] in self?.uploader.setEnabled(false) },
        pauseHeartbeat: { [weak self] in self?.heartbeat.setEnabled(false) },
        pauseWatcher: { [weak self] in self?.watcher.stop() },
        startAbandonmentObserver: { [weak self] generation in
            self?.startAbandonmentObserver(generation: generation)
        },
        initiallyPreparedGeneration: startupCoordinator.initiallyPreparedGeneration,
        validateResume: { [weak self] generation in
            guard let self else { throw CLIError.invalidRuntimeConfiguration }
            try startupCoordinator.validateResume(generation: generation)
        },
        resume: { [weak self] _ in
            guard let self else { throw CLIError.invalidRuntimeConfiguration }
            do {
                try startupCoordinator.resume()
            } catch {
                controller.pauseCollection()
                uploader.setEnabled(false)
                heartbeat.setEnabled(false)
                watcher.stop()
                throw error
            }
        },
        acceptedResponse: { [weak self] in
            guard let self else {
                return ControlResponse(ok: false, message: "daemon unavailable")
            }
            return ControlResponse(ok: true, message: try self.currentStatus().description)
        }
    )

    init(inputs: RuntimeInputs, trialGeneration: Int64?) throws {
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
        startupCoordinator = try PreparedDaemonStartupCoordinator(
            paths: paths,
            trialGeneration: trialGeneration,
            releaseIdentity: inputs.releaseIdentity
        ) { [weak self] in
            guard let self else { throw CLIError.invalidRuntimeConfiguration }
            let files = try watcher.discoverProviderFiles()
            try controller.install(existingFiles: files)
            try outbox.prune(nowMS: Int64(Date().timeIntervalSince1970 * 1_000))
            if controller.enabled { try watcher.start() }
            releaseChecker = try? ReleaseChecker(
                paths: paths,
                installed: inputs.releaseIdentity
            )
            updateQueue.async { [weak self] in
                _ = self?.releaseChecker?.checkIfDue()
            }
            scheduleReadContinuationIfNeeded()
            uploader.schedule(enabled: controller.enabled)
            heartbeat.setEnabled(controller.enabled)
        }
    }

    func run() throws {
        if startupCoordinator.startsPrepared { controller.pauseCollection() }
        try control.startRequests { [weak self] request in
            self?.handle(request) ?? ControlResponse(ok: false, message: "daemon unavailable")
        }
        do {
            try startupCoordinator.start()
            if let generation = startupCoordinator.initiallyPreparedGeneration {
                startAbandonmentObserver(generation: generation)
            }
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
        if updatePreparation.isPrepared,
           request.command != .status,
           request.command != .prepareUpdate,
           request.command != .resumeUpdate {
            return ControlResponse(ok: false, message: "daemon prepared for update")
        }
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
        case .prepareUpdate:
            guard let generation = request.releaseStateGeneration else {
                return ControlResponse(ok: false, message: "invalid update generation")
            }
            return updatePreparation.prepare(generation: generation)
        case .resumeUpdate:
            guard let generation = request.releaseStateGeneration else {
                return ControlResponse(ok: false, message: "invalid update generation")
            }
            return updatePreparation.resume(generation: generation)
        }
    }

    private func currentStatus() throws -> AgentStatus {
        try controller.status(
            daemonRunning: true,
            serverEnabledSurfaces: inputs.surfaces,
            lastSuccessfulUploadMS: uploader.lastSuccessfulUploadMS,
            installedRelease: inputs.releaseIdentity,
            updateAvailability: releaseChecker?.availability(),
            preparedReleaseStateGeneration: updatePreparation.preparedGeneration
        )
    }

    private func startAbandonmentObserver(generation: Int64) {
        abandonmentOrchestrator.start(generation: generation)
    }

    private func stopPreparedDaemon() {
        controller.pauseCollection()
        uploader.setEnabled(false)
        heartbeat.setEnabled(false)
        watcher.stop()
        stopLock.withLock { stopping = true }
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

private final class BlockingDownloadResult: @unchecked Sendable {
    private let lock = NSLock()
    private let completed = DispatchSemaphore(value: 0)
    private var result: Result<DownloadReceipt, Error>?

    func finish(_ result: Result<DownloadReceipt, Error>) {
        lock.withLock { self.result = result }
        completed.signal()
    }

    func wait() throws -> DownloadReceipt {
        guard completed.wait(timeout: .now() + 125) == .success,
              let result = lock.withLock({ self.result }) else {
            throw CLIError.updateOperationFailed
        }
        return try result.get()
    }
}

private struct InstalledTrustRoot {
    private static let validationFlags = SecCSFlags(rawValue:
        UInt32(kSecCSCheckAllArchitectures) |
            UInt32(kSecCSStrictValidate) |
            UInt32(kSecCSCheckNestedCode) |
            UInt32(kSecCSRestrictSymlinks)
    )

    let verifiedSelf: VerifiedCompanionApplication
    private let designatedRequirement: SecRequirement

    init(expectedBundleURL: URL) throws {
        guard Bundle.main.bundleURL.standardizedFileURL.path ==
                expectedBundleURL.standardizedFileURL.path else {
            throw CLIError.invalidUpdateState
        }
        let code = try Self.staticCode(at: expectedBundleURL)
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess,
              let requirement,
              SecStaticCodeCheckValidity(code, Self.validationFlags, requirement) == errSecSuccess else {
            throw CLIError.invalidUpdateState
        }
        designatedRequirement = requirement
        verifiedSelf = try Self.verifiedApplication(
            at: expectedBundleURL,
            requirement: requirement
        )
    }

    func verifyApplication(at application: URL) throws -> VerifiedCompanionApplication {
        try Self.verifiedApplication(at: application, requirement: designatedRequirement)
    }

    private static func verifiedApplication(
        at application: URL,
        requirement: SecRequirement
    ) throws -> VerifiedCompanionApplication {
        let code = try staticCode(at: application)
        guard SecStaticCodeCheckValidity(code, validationFlags, requirement) == errSecSuccess else {
            throw CLIError.invalidUpdateState
        }
        var signingInformation: CFDictionary?
        guard SecCodeCopySigningInformation(
            code,
            SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)),
            &signingInformation
        ) == errSecSuccess,
        let information = signingInformation as? [String: Any],
        information[kSecCodeInfoIdentifier as String] as? String ==
            "com.redlattice.runtime-raiders-agent",
        let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
        teamIdentifier.utf8.count == 10,
        teamIdentifier.utf8.allSatisfy({ byte in
            (48...57).contains(byte) || (65...90).contains(byte)
        }),
        let bundle = Bundle(url: application) else {
            throw CLIError.invalidUpdateState
        }
        return VerifiedCompanionApplication(
            identity: try CompanionReleaseIdentity.load(from: bundle),
            teamIdentifier: teamIdentifier
        )
    }

    private static func staticCode(at application: URL) throws -> SecStaticCode {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(application as CFURL, [], &code) == errSecSuccess,
              let code else {
            throw CLIError.invalidUpdateState
        }
        return code
    }
}

private struct LiveUpdateStatusProvider {
    let paths: AgentPaths
    let surfaces: [RunSurface]
    let enrollment: EnrollmentConfiguration
    let trustRoot: InstalledTrustRoot
    let expectedReleaseStateGeneration: Int64

    func status(command: ControlCommand) throws -> CompanionUpdateStatus {
        guard command == .status || command == .prepareUpdate || command == .resumeUpdate else {
            throw CLIError.invalidUpdateState
        }
        let response = try ControlSocketClient.send(
            request: ControlRequest(
                command: command,
                releaseStateGeneration: command == .prepareUpdate || command == .resumeUpdate
                    ? expectedReleaseStateGeneration : nil
            ),
            to: paths.controlSocket
        )
        return try validatedStatus(response)
    }

    func prepareForUpdate() throws -> CompanionDaemonPreparationResult {
        let response = try ControlSocketClient.send(
            request: ControlRequest(
                command: .prepareUpdate,
                releaseStateGeneration: expectedReleaseStateGeneration
            ),
            to: paths.controlSocket
        )
        if !response.ok,
           response.message == SerializedUpdatePreparation.activeRunRefusalMessage {
            return .refusedActiveRun
        }
        return .prepared(try validatedStatus(response))
    }

    private func validatedStatus(_ response: ControlResponse) throws -> CompanionUpdateStatus {
        guard response.ok,
              let data = response.message.data(using: .utf8),
              let status = try? JSONDecoder().decode(AgentStatus.self, from: data) else {
            throw CLIError.invalidUpdateState
        }
        let verified = try trustRoot.verifyApplication(at: legacyProtocolOne(paths).installedApplication)
        let persistedState = try AgentController.persistedCollectorState(
            paths: paths,
            surfaces: surfaces
        )
        let currentEnrollment = try EnrollmentConfiguration.loadExisting(
            from: paths.stateDirectory.appendingPathComponent("enrollment.json")
        )
        let queuedCount = try Outbox.queuedCount(inExistingDirectory: paths.outboxDirectory)
        guard status.daemonRunning,
              status.installedReleaseSequence == verified.identity.releaseSequence,
              status.installedCompanionVersion == verified.identity.companionVersion,
              status.serverEnabledSurfaces == surfaces.sorted(by: { $0.rawValue < $1.rawValue }),
              currentEnrollment == enrollment,
              queuedCount == status.queuedEventCount,
              (persistedState == .enabled || persistedState == .disabled),
              status.persistedState == persistedState,
              status.enabled == (persistedState == .enabled),
              status.activeRunCount >= 0,
              status.queuedEventCount >= 0,
              status.preparedForUpdate == (status.preparedReleaseStateGeneration != nil),
              !status.preparedForUpdate ||
                status.preparedReleaseStateGeneration == expectedReleaseStateGeneration else {
            throw CLIError.invalidUpdateState
        }
        return CompanionUpdateStatus(
            verifiedApplication: verified,
            daemonRunning: status.daemonRunning,
            enabled: status.enabled,
            enrollmentValid: true,
            collectorStateValid: true,
            activeRunCount: status.activeRunCount,
            queuedEventCount: status.queuedEventCount,
            preparedForUpdate: status.preparedForUpdate
        )
    }
}

private func launchAgentURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        .appendingPathComponent("com.redlattice.runtime-raiders-agent.plist", isDirectory: false)
}

private struct LegacyProtocolOneCLIPaths {
    let installedApplication: URL
    let rollbackApplication: URL
    let failedApplication: URL

    init(paths: AgentPaths) {
        installedApplication = paths.legacyFlatApplication
        rollbackApplication = paths.supportDirectory.appendingPathComponent(
            "Runtime Raiders Agent.rollback.app",
            isDirectory: true
        )
        failedApplication = paths.supportDirectory.appendingPathComponent(
            "Runtime Raiders Agent.failed.app",
            isDirectory: true
        )
    }
}

private func legacyProtocolOne(_ paths: AgentPaths) -> LegacyProtocolOneCLIPaths {
    LegacyProtocolOneCLIPaths(paths: paths)
}

private func downloadSynchronously(
    downloader: ArtifactDownloader,
    source: URL,
    destination: URL,
    expectedSHA256: String
) throws -> DownloadReceipt {
    let box = BlockingDownloadResult()
    Task.detached {
        do {
            box.finish(.success(try await downloader.download(
                from: source,
                to: destination,
                expectedSHA256: expectedSHA256
            )))
        } catch {
            box.finish(.failure(error))
        }
    }
    return try box.wait()
}

private func availableCapacity(at directory: URL) throws -> Int64 {
    let values = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    guard let capacity = values.volumeAvailableCapacityForImportantUsage, capacity >= 0 else {
        throw CLIError.invalidUpdateState
    }
    return capacity
}

private func runForegroundUpdate(paths: AgentPaths) throws {
    let expectedReleaseStateGeneration = try ReleaseStateStore.loadExisting(paths: paths).generation
    let enrollment = try EnrollmentConfiguration.loadExisting(
        from: paths.stateDirectory.appendingPathComponent("enrollment.json")
    )
    let trustRoot = try InstalledTrustRoot(expectedBundleURL: legacyProtocolOne(paths).installedApplication)
    let statusProvider = LiveUpdateStatusProvider(
        paths: paths,
        surfaces: enrollment.enabledSurfaces,
        enrollment: enrollment,
        trustRoot: trustRoot,
        expectedReleaseStateGeneration: expectedReleaseStateGeneration
    )
    let releaseChecker = try ReleaseChecker(
        paths: paths,
        installed: trustRoot.verifiedSelf.identity
    )
    let downloader = ArtifactDownloader()
    let commandRunner = SystemCommandRunner()
    let candidateVerifier = CandidateVerifier()
    let releaseArchiveVerifier = ReleaseArchiveVerifier()
    let launchd = LaunchdJobController(
        plistURL: launchAgentURL(),
        runCommand: commandRunner.run
    )
    let updater = CompanionUpdater(
        paths: paths,
        surfaces: enrollment.enabledSurfaces,
        operations: CompanionUpdaterOperations(
            status: { try statusProvider.status(command: .status) },
            fetchManifest: { try releaseChecker.fetchNow() },
            downloadArchive: { source, destination, digest in
                try downloadSynchronously(
                    downloader: downloader,
                    source: source,
                    destination: destination,
                    expectedSHA256: digest
                )
            },
            runCommand: commandRunner.run,
            verifyCandidate: { candidate, launcher, manifest, installed in
                try releaseArchiveVerifier.verifyPackagedLauncher(
                    launcher,
                    installedTeamIdentifier: installed.teamIdentifier
                )
                return try candidateVerifier.verify(
                    candidate: candidate,
                    manifest: manifest,
                    installed: installed.identity,
                    installedTeamIdentifier: installed.teamIdentifier
                )
            },
            availableCapacity: availableCapacity,
            prepareDaemon: { try statusProvider.prepareForUpdate() },
            bootout: launchd.bootout,
            bootstrap: launchd.bootstrap,
            proveDaemonStopped: launchd.proveStopped,
            resumePreparedDaemon: {
                let response = try ControlSocketClient.send(
                    request: ControlRequest(
                        command: .resumeUpdate,
                        releaseStateGeneration: expectedReleaseStateGeneration
                    ),
                    to: paths.controlSocket
                )
                guard response.ok else { throw CLIError.updateOperationFailed }
            },
            restartDaemon: launchd.restart,
            healthStatus: { try statusProvider.status(command: .status) }
        )
    )

    switch try updater.run() {
    case .alreadyCurrent:
        print("Runtime Raiders is already current.")
    case let .updated(from, to):
        print("Runtime Raiders updated from \(from.companionVersion) to \(to.companionVersion).")
    }
}

private func runStableRecovery(paths: AgentPaths) throws {
    let expectedReleaseStateGeneration = try ReleaseStateStore.loadExisting(paths: paths).generation
    let enrollment = try EnrollmentConfiguration.loadExisting(
        from: paths.stateDirectory.appendingPathComponent("enrollment.json")
    )
    let trustRoot = try InstalledTrustRoot(expectedBundleURL: legacyProtocolOne(paths).rollbackApplication)
    let verifier = CandidateVerifier()
    let layout = try StableRecoveryFileTransaction(paths: paths)
    var boundManifest: ReleaseManifestV1?
    let verifyBundles: (StableRecoveryPhase) throws -> Void = { phase in
        guard try AgentController.persistedCollectorState(
            paths: paths,
            surfaces: enrollment.enabledSurfaces
        ) == .disabled,
        try trustRoot.verifyApplication(at: legacyProtocolOne(paths).rollbackApplication) ==
            trustRoot.verifiedSelf else {
            throw CLIError.invalidUpdateState
        }
        guard phase == .rollbackAndFailed else { return }
        let currentManifest = try UpdateStateStore(paths: paths).load().cachedManifest
        if let boundManifest {
            guard currentManifest == boundManifest else { throw CLIError.invalidUpdateState }
        } else {
            guard let currentManifest else { throw CLIError.invalidUpdateState }
            boundManifest = currentManifest
        }
        guard let manifest = boundManifest else { throw CLIError.invalidUpdateState }
        let failedIdentity = try verifier.verify(
            candidate: legacyProtocolOne(paths).failedApplication,
            manifest: manifest,
            installed: trustRoot.verifiedSelf.identity,
            installedTeamIdentifier: trustRoot.verifiedSelf.teamIdentifier
        )
        guard failedIdentity.releaseSequence > trustRoot.verifiedSelf.identity.releaseSequence else {
            throw CLIError.invalidUpdateState
        }
    }
    let runner = SystemCommandRunner()
    let launchd = LaunchdJobController(
        plistURL: launchAgentURL(),
        runCommand: runner.run
    )
    let recovery = StableUpdateRecovery(paths: paths, operations: StableUpdateRecoveryOperations(
        phase: { try layout.inspectAndNormalize() },
        verifyBundles: verifyBundles,
        persistDisabled: {
            try AgentController.persistDisabledForRecovery(
                paths: paths,
                surfaces: enrollment.enabledSurfaces
            )
        },
        bootout: launchd.bootout,
        proveStopped: launchd.proveStopped,
        restore: { try layout.restore(phase: $0) },
        revertRestored: { try layout.revertRestore(phase: $0) },
        verifyRestoredBundle: { _ in
            guard try trustRoot.verifyApplication(at: legacyProtocolOne(paths).installedApplication) ==
                    trustRoot.verifiedSelf else {
                throw CLIError.invalidUpdateState
            }
        },
        bootstrap: launchd.bootstrap,
        verifyDisabledHealth: {
            let statusProvider = LiveUpdateStatusProvider(
                paths: paths,
                surfaces: enrollment.enabledSurfaces,
                enrollment: enrollment,
                trustRoot: trustRoot,
                expectedReleaseStateGeneration: expectedReleaseStateGeneration
            )
            let observed = try statusProvider.status(command: .status)
            let status = observed.preparedForUpdate
                ? try statusProvider.status(command: .resumeUpdate)
                : observed
            return status.verifiedApplication == trustRoot.verifiedSelf &&
                !status.enabled && !status.preparedForUpdate && status.activeRunCount == 0
        }
    ))
    try recovery.run()
    print("Runtime Raiders restored \(trustRoot.verifiedSelf.identity.companionVersion) with collection off.")
}

private func run() throws {
    let paths = AgentPaths()
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let executableURL = Bundle.main.executableURL,
          let route = CompanionCommandRouter.route(
              arguments: arguments,
              executableURL: executableURL,
              paths: paths
          ) else {
        throw CLIError.usage
    }

    switch route {
    case let .daemon(trialGeneration):
        let enrollment = try EnrollmentConfiguration.load(
            from: paths.stateDirectory.appendingPathComponent("enrollment.json")
        )
        try DaemonRuntime(
            inputs: RuntimeInputs(
                enrollment: enrollment
            ),
            trialGeneration: trialGeneration
        ).run()
        return
    case .foregroundUpdate:
        try runForegroundUpdate(paths: paths)
        return
    case .selfCheck:
        FileHandle.standardOutput.write(
            try CompanionSelfCheck.encode(CompanionReleaseIdentity.load(from: .main))
        )
        return
    case let .control(command):
        try runUserControlCommand(command, paths: paths)
    }
}

private func runUserControlCommand(_ command: ControlCommand, paths: AgentPaths) throws {
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
            print(try localStatus(paths: paths).description)
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

private func localStatus(paths: AgentPaths) throws -> AgentStatus {
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
    let installed = try CompanionReleaseIdentity.load(from: .main)
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

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    Foundation.exit(EXIT_FAILURE)
}

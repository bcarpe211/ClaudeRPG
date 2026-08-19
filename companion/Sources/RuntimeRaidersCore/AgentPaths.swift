import Foundation

public struct AgentPaths: Equatable, Sendable {
    public let supportDirectory: URL
    public let stateDirectory: URL
    public let outboxDirectory: URL
    public let controlSocket: URL
    public let updateState: URL
    public let updateLock: URL
    public let agentApplication: URL
    public let agentExecutable: URL

    // Deprecated compatibility paths keep the obsolete updater and migration
    // sources compiling until Task 8 removes that source. Live routing and the
    // installer must use agentApplication and agentExecutable.
    let preparedStartupLease: URL
    let legacyFlatApplication: URL
    let launcherDirectory: URL
    let launcherApplication: URL
    let launcherExecutable: URL
    let releasesDirectory: URL
    let installationDirectory: URL
    let releaseState: URL
    let updateJournal: URL

    public init(applicationSupportDirectory: URL) {
        supportDirectory = applicationSupportDirectory
            .appendingPathComponent("Runtime Raiders", isDirectory: true)
        stateDirectory = supportDirectory.appendingPathComponent("state", isDirectory: true)
        outboxDirectory = supportDirectory.appendingPathComponent("outbox", isDirectory: true)
        controlSocket = supportDirectory.appendingPathComponent("agent.sock", isDirectory: false)
        updateState = stateDirectory.appendingPathComponent("update-state.json", isDirectory: false)
        updateLock = stateDirectory.appendingPathComponent("update.lock", isDirectory: false)
        agentApplication = supportDirectory.appendingPathComponent(
            "Runtime Raiders Agent.app",
            isDirectory: true
        )
        agentExecutable = agentApplication.appendingPathComponent(
            "Contents/MacOS/runtime-raiders-agent",
            isDirectory: false
        )
        preparedStartupLease = stateDirectory.appendingPathComponent(
            "prepared-startup.lock",
            isDirectory: false
        )
        legacyFlatApplication = agentApplication
        launcherDirectory = supportDirectory.appendingPathComponent("launcher", isDirectory: true)
        launcherApplication = launcherDirectory.appendingPathComponent(
            "Runtime Raiders Launcher.app",
            isDirectory: true
        )
        launcherExecutable = launcherApplication.appendingPathComponent(
            "Contents/MacOS/runtime-raiders-launcher",
            isDirectory: false
        )
        releasesDirectory = supportDirectory.appendingPathComponent("releases", isDirectory: true)
        installationDirectory = supportDirectory.appendingPathComponent(
            "installation",
            isDirectory: true
        )
        releaseState = installationDirectory.appendingPathComponent(
            "release-state.json",
            isDirectory: false
        )
        updateJournal = installationDirectory.appendingPathComponent(
            "update-journal.json",
            isDirectory: false
        )
    }

    public init() {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        self.init(applicationSupportDirectory: applicationSupport)
    }

    func releaseDirectory(for release: ReleaseReference) throws -> URL {
        guard ReleaseReference.isValid(release) else {
            throw ReleaseContractError.invalidReleaseState
        }
        return releasesDirectory.appendingPathComponent(
            "sequence-\(release.releaseSequence)-\(release.releaseSHA)",
            isDirectory: true
        )
    }

    func application(for release: ReleaseReference) throws -> URL {
        try releaseDirectory(for: release).appendingPathComponent(
            "Runtime Raiders Agent.app",
            isDirectory: true
        )
    }

    func executable(for release: ReleaseReference) throws -> URL {
        try application(for: release).appendingPathComponent(
            "Contents/MacOS/runtime-raiders-agent",
            isDirectory: false
        )
    }
}

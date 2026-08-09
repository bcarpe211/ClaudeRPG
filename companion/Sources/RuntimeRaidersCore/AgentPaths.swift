import Foundation

public struct AgentPaths: Equatable, Sendable {
    public let supportDirectory: URL
    public let stateDirectory: URL
    public let outboxDirectory: URL
    public let controlSocket: URL
    public let updateState: URL
    public let updateLock: URL
    public let preparedStartupLease: URL
    public let legacyFlatApplication: URL
    public let launcherDirectory: URL
    public let launcherApplication: URL
    public let launcherExecutable: URL
    public let releasesDirectory: URL
    public let installationDirectory: URL
    public let releaseState: URL
    public let updateJournal: URL

    public init(applicationSupportDirectory: URL) {
        supportDirectory = applicationSupportDirectory
            .appendingPathComponent("Runtime Raiders", isDirectory: true)
        stateDirectory = supportDirectory.appendingPathComponent("state", isDirectory: true)
        outboxDirectory = supportDirectory.appendingPathComponent("outbox", isDirectory: true)
        controlSocket = supportDirectory.appendingPathComponent("agent.sock", isDirectory: false)
        updateState = stateDirectory.appendingPathComponent("update-state.json", isDirectory: false)
        updateLock = stateDirectory.appendingPathComponent("update.lock", isDirectory: false)
        preparedStartupLease = stateDirectory.appendingPathComponent(
            "prepared-startup.lock",
            isDirectory: false
        )
        legacyFlatApplication = supportDirectory.appendingPathComponent(
            "Runtime Raiders Agent.app",
            isDirectory: true
        )
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

    public func releaseDirectory(for release: ReleaseReference) throws -> URL {
        guard ReleaseReference.isValid(release) else {
            throw ReleaseContractError.invalidReleaseState
        }
        return releasesDirectory.appendingPathComponent(
            "sequence-\(release.releaseSequence)-\(release.releaseSHA)",
            isDirectory: true
        )
    }

    public func application(for release: ReleaseReference) throws -> URL {
        try releaseDirectory(for: release).appendingPathComponent(
            "Runtime Raiders Agent.app",
            isDirectory: true
        )
    }

    public func executable(for release: ReleaseReference) throws -> URL {
        try application(for: release).appendingPathComponent(
            "Contents/MacOS/runtime-raiders-agent",
            isDirectory: false
        )
    }
}

/// Compatibility-only fixed slots for the protocol-1 updater and recovery code.
/// Protocol-2 selection uses `ReleaseReference` and `release-state.json` only.
struct LegacyProtocolOnePaths: Sendable {
    let installedApplication: URL
    let rollbackApplication: URL
    let failedApplication: URL

    init(supportDirectory: URL) {
        installedApplication = supportDirectory.appendingPathComponent(
            "Runtime Raiders Agent.app",
            isDirectory: true
        )
        rollbackApplication = supportDirectory.appendingPathComponent(
            "Runtime Raiders Agent.rollback.app",
            isDirectory: true
        )
        failedApplication = supportDirectory.appendingPathComponent(
            "Runtime Raiders Agent.failed.app",
            isDirectory: true
        )
    }
}

extension AgentPaths {
    var legacyProtocolOne: LegacyProtocolOnePaths {
        LegacyProtocolOnePaths(supportDirectory: supportDirectory)
    }
}

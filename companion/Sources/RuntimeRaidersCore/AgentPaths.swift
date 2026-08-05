import Foundation

public struct AgentPaths: Equatable, Sendable {
    public let supportDirectory: URL
    public let stateDirectory: URL
    public let outboxDirectory: URL
    public let controlSocket: URL
    public let updateState: URL
    public let updateLock: URL
    public let installedApplication: URL
    public let rollbackApplication: URL
    public let failedApplication: URL

    public init(applicationSupportDirectory: URL) {
        supportDirectory = applicationSupportDirectory
            .appendingPathComponent("Runtime Raiders", isDirectory: true)
        stateDirectory = supportDirectory.appendingPathComponent("state", isDirectory: true)
        outboxDirectory = supportDirectory.appendingPathComponent("outbox", isDirectory: true)
        controlSocket = supportDirectory.appendingPathComponent("agent.sock", isDirectory: false)
        updateState = stateDirectory.appendingPathComponent("update-state.json", isDirectory: false)
        updateLock = stateDirectory.appendingPathComponent("update.lock", isDirectory: false)
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

    public init() {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        self.init(applicationSupportDirectory: applicationSupport)
    }
}

import Foundation

public struct AgentPaths: Equatable, Sendable {
    public let supportDirectory: URL
    public let stateDirectory: URL
    public let outboxDirectory: URL
    public let controlSocket: URL

    public init(applicationSupportDirectory: URL) {
        supportDirectory = applicationSupportDirectory
            .appendingPathComponent("Runtime Raiders", isDirectory: true)
        stateDirectory = supportDirectory.appendingPathComponent("state", isDirectory: true)
        outboxDirectory = supportDirectory.appendingPathComponent("outbox", isDirectory: true)
        controlSocket = supportDirectory.appendingPathComponent("agent.sock", isDirectory: false)
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

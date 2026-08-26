import Foundation

public enum CompanionLifecyclePathsError: Error, Equatable {
    case invalidHomeDirectory
}

public struct CompanionLifecyclePaths: Equatable, Sendable {
    public let homeDirectory: URL
    public let agent: AgentPaths
    public let supportShim: URL
    public let commandShim: URL
    public let managedPlist: URL
    public let legacyPlist: URL
    public let enrollment: URL
    public let recoveryJournal: URL
    public let lifecycleLock: URL

    public init(homeDirectory: URL) throws {
        guard homeDirectory.isFileURL,
              homeDirectory.path.hasPrefix("/"),
              homeDirectory.path != "/",
              homeDirectory.standardized.path == homeDirectory.path else {
            throw CompanionLifecyclePathsError.invalidHomeDirectory
        }
        let home = URL(fileURLWithPath: homeDirectory.path, isDirectory: true)
        let applicationSupport = home.appendingPathComponent(
            "Library/Application Support",
            isDirectory: true
        )
        let agent = AgentPaths(applicationSupportDirectory: applicationSupport)
        let launchAgents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)

        self.homeDirectory = home
        self.agent = agent
        supportShim = agent.supportDirectory.appendingPathComponent("raiders", isDirectory: false)
        commandShim = home.appendingPathComponent(".local/bin/raiders", isDirectory: false)
        managedPlist = launchAgents.appendingPathComponent(
            "com.redlattice.runtime-raiders.agent.plist",
            isDirectory: false
        )
        legacyPlist = launchAgents.appendingPathComponent(
            "com.redlattice.runtime-raiders-agent.plist",
            isDirectory: false
        )
        enrollment = agent.stateDirectory.appendingPathComponent(
            "enrollment.json",
            isDirectory: false
        )
        recoveryJournal = agent.stateDirectory.appendingPathComponent(
            "re-enrollment.json",
            isDirectory: false
        )
        lifecycleLock = agent.stateDirectory.appendingPathComponent(
            "lifecycle.lock",
            isDirectory: false
        )
    }
}

import Darwin
import Foundation
import RuntimeRaidersCore

private enum LauncherMainError: Error {
    case invalidInvocation
    case executionReturned
}

#if DEBUG
private struct DebugLauncherContext {
    let operations: LauncherSelectionOperations
    let execution: LauncherExecutionAdapter

    static func load(environment: [String: String]) throws -> Self? {
        let supportKey = "RUNTIME_RAIDERS_LAUNCHER_DEBUG_SUPPORT_ROOT"
        let recordKey = "RUNTIME_RAIDERS_LAUNCHER_DEBUG_EXEC_RECORD"
        let supportPath = environment[supportKey]
        let recordPath = environment[recordKey]
        guard supportPath != nil || recordPath != nil else { return nil }
        guard let supportPath, supportPath.hasPrefix("/"),
              let recordPath, recordPath.hasPrefix("/") else {
            throw LauncherMainError.invalidInvocation
        }

        let paths = AgentPaths(
            applicationSupportDirectory: URL(fileURLWithPath: supportPath, isDirectory: true)
        )
        let teamIdentifier = "RUNTIME RAIDERS DEBUG TEAM"
        let operations = LauncherSelectionOperations(
            paths: paths,
            loadReleaseState: { try ReleaseStateStore.loadExisting(paths: paths) },
            preparedStartupLeaseIsHeld: { false },
            inspectLauncher: {
                LauncherBundleValidation(
                    bundle: paths.launcherApplication,
                    executable: paths.launcherExecutable,
                    bundleIdentifier: "com.redlattice.runtime-raiders-launcher",
                    teamIdentifier: teamIdentifier,
                    hardenedRuntime: true,
                    allArchitecturesValid: true,
                    launcherProtocolVersion: 1,
                    releaseIdentity: nil
                )
            },
            inspectAgent: { application in
                let state = try ReleaseStateStore.loadExisting(paths: paths)
                let candidates = [state.active, state.trial].compactMap { $0 }
                guard let release = try candidates.first(where: {
                    try paths.application(for: $0) == application
                }) else {
                    throw LauncherSelectionError.untrustedSelection
                }
                return LauncherBundleValidation(
                    bundle: application,
                    executable: try paths.executable(for: release),
                    bundleIdentifier: "com.redlattice.runtime-raiders-agent",
                    teamIdentifier: teamIdentifier,
                    hardenedRuntime: true,
                    allArchitecturesValid: true,
                    launcherProtocolVersion: nil,
                    releaseIdentity: try release.companionReleaseIdentity()
                )
            }
        )
        let recordURL = URL(fileURLWithPath: recordPath, isDirectory: false)
        let execution = LauncherExecutionAdapter { request in
            struct Record: Encodable {
                let executable: String
                let arguments: [String]
            }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(Record(
                executable: request.executable.path,
                arguments: request.arguments
            )).write(to: recordURL, options: .atomic)
        }
        return Self(operations: operations, execution: execution)
    }
}
#endif

private func replaceProcess(_ request: LauncherExecutionRequest) throws {
    let values = [request.executable.path] + request.arguments
    let strings = values.map { strdup($0) }
    defer { strings.forEach { free($0) } }
    var pointers = strings + [nil]
    let result = pointers.withUnsafeMutableBufferPointer { buffer in
        Darwin.execv(request.executable.path, buffer.baseAddress)
    }
    guard result == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    throw LauncherMainError.executionReturned
}

private func run() throws {
    guard let invocation = LauncherInvocation(
        arguments: Array(CommandLine.arguments.dropFirst())
    ) else {
        throw LauncherMainError.invalidInvocation
    }
#if DEBUG
    if let context = try DebugLauncherContext.load(
        environment: ProcessInfo.processInfo.environment
    ) {
        let selection = try LauncherSelector(operations: context.operations)
            .select(invocation: invocation)
        try context.execution.execute(
            selection: selection,
            environment: ProcessInfo.processInfo.environment
        )
        return
    }
#endif
    let paths = AgentPaths()
    let selection = try LauncherSelector(operations: .live(
        paths: paths,
        launcherBundle: .main
    )).select(invocation: invocation)
    try LauncherExecutionAdapter(replaceProcess: replaceProcess).execute(
        selection: selection,
        environment: ProcessInfo.processInfo.environment
    )
}

do {
    try run()
} catch {
    Foundation.exit(EXIT_FAILURE)
}

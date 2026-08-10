import Darwin
import Foundation
import RuntimeRaidersCore

private enum LauncherMainError: Error {
    case invalidInvocation
    case executionReturned
}

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

import Darwin
import Foundation

public enum SystemCommandExitStatus: Equatable, Sendable {
    case exited(Int32)
    case signaled(Int32)
    case timedOut
}

public struct SystemCommandResult: Equatable, Sendable {
    public let exitStatus: SystemCommandExitStatus
    public let stdout: Data
    public let stderr: Data

    public init(exitStatus: SystemCommandExitStatus, stdout: Data, stderr: Data) {
        self.exitStatus = exitStatus
        self.stdout = stdout
        self.stderr = stderr
    }
}

public enum SystemCommandRunnerError: Error, Equatable {
    case executableMustBeAbsolute
    case invalidTimeout
    case launchFailed
}

public struct SystemCommandRunner: Sendable {
    public static let maximumOutputBytes = 64 * 1_024

    public init() {}

    public func run(
        executable: URL,
        arguments: [String],
        timeout: TimeInterval
    ) throws -> SystemCommandResult {
        guard executable.isFileURL, executable.path.hasPrefix("/") else {
            throw SystemCommandRunnerError.executableMustBeAbsolute
        }
        guard timeout.isFinite, timeout > 0 else {
            throw SystemCommandRunnerError.invalidTimeout
        }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let stdout = BoundedProcessOutput()
        let stderr = BoundedProcessOutput()
        let readers = DispatchGroup()
        startReader(stdoutPipe.fileHandleForReading, into: stdout, group: readers)
        startReader(stderrPipe.fileHandleForReading, into: stderr, group: readers)

        let terminated = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in terminated.signal() }
        do {
            try process.run()
        } catch {
            try? stdoutPipe.fileHandleForReading.close()
            try? stderrPipe.fileHandleForReading.close()
            throw SystemCommandRunnerError.launchFailed
        }

        let timedOut = terminated.wait(timeout: .now() + timeout) == .timedOut
        if timedOut {
            process.terminate()
            if terminated.wait(timeout: .now() + 0.2) == .timedOut {
                Darwin.kill(process.processIdentifier, SIGKILL)
                _ = terminated.wait(timeout: .now() + 1)
            }
        }
        process.waitUntilExit()
        readers.wait()

        let status: SystemCommandExitStatus
        if timedOut {
            status = .timedOut
        } else if process.terminationReason == .exit {
            status = .exited(process.terminationStatus)
        } else {
            status = .signaled(process.terminationStatus)
        }
        return SystemCommandResult(exitStatus: status, stdout: stdout.data, stderr: stderr.data)
    }

    private func startReader(
        _ handle: FileHandle,
        into output: BoundedProcessOutput,
        group: DispatchGroup
    ) {
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { group.leave() }
            while true {
                do {
                    guard let chunk = try handle.read(upToCount: 8_192), !chunk.isEmpty else { return }
                    output.append(chunk)
                } catch {
                    return
                }
            }
        }
    }
}

private final class BoundedProcessOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    var data: Data { lock.withLock { storage } }

    func append(_ chunk: Data) {
        lock.withLock {
            let remaining = SystemCommandRunner.maximumOutputBytes - storage.count
            if remaining > 0 {
                storage.append(chunk.prefix(remaining))
            }
        }
    }
}

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

    private static let terminationGraceNanoseconds: UInt64 = 100_000_000
    private static let killDrainNanoseconds: UInt64 = 300_000_000
    private static let maximumPollMilliseconds: Int32 = 20
    private static let maximumReadsPerPipePerPump = 8

    public init() {}

    public func run(
        executable: URL,
        arguments: [String],
        timeout: TimeInterval
    ) throws -> SystemCommandResult {
        guard executable.isFileURL, executable.path.hasPrefix("/") else {
            throw SystemCommandRunnerError.executableMustBeAbsolute
        }
        guard timeout.isFinite, timeout > 0,
              timeout <= TimeInterval(UInt64.max / 1_000_000_000) else {
            throw SystemCommandRunnerError.invalidTimeout
        }

        let spawned = try spawn(executable: executable, arguments: arguments)
        var stdout = BoundedPipe(fd: spawned.stdout)
        var stderr = BoundedPipe(fd: spawned.stderr)
        var waitStatus: Int32?
        let runDeadline = deadline(afterNanoseconds: UInt64(timeout * 1_000_000_000))

        if pump(
            pid: spawned.pid,
            stdout: &stdout,
            stderr: &stderr,
            waitStatus: &waitStatus,
            until: runDeadline
        ) {
            return SystemCommandResult(
                exitStatus: decodedStatus(waitStatus!),
                stdout: stdout.data,
                stderr: stderr.data
            )
        }

        terminateProcessGroup(spawned.pid, signal: SIGTERM)
        let terminatedDuringGrace = pump(
            pid: spawned.pid,
            stdout: &stdout,
            stderr: &stderr,
            waitStatus: &waitStatus,
            until: deadline(afterNanoseconds: Self.terminationGraceNanoseconds)
        )
        if !terminatedDuringGrace {
            terminateProcessGroup(spawned.pid, signal: SIGKILL)
            _ = pump(
                pid: spawned.pid,
                stdout: &stdout,
                stderr: &stderr,
                waitStatus: &waitStatus,
                until: deadline(afterNanoseconds: Self.killDrainNanoseconds)
            )
        }

        stdout.close()
        stderr.close()
        if waitStatus == nil {
            scheduleReap(spawned.pid)
        }
        return SystemCommandResult(exitStatus: .timedOut, stdout: stdout.data, stderr: stderr.data)
    }

    private func spawn(executable: URL, arguments: [String]) throws -> SpawnedProcess {
        var stdoutPipe = [Int32](repeating: -1, count: 2)
        var stderrPipe = [Int32](repeating: -1, count: 2)
        guard Darwin.pipe(&stdoutPipe) == 0 else {
            throw SystemCommandRunnerError.launchFailed
        }
        guard Darwin.pipe(&stderrPipe) == 0 else {
            closePair(stdoutPipe)
            throw SystemCommandRunnerError.launchFailed
        }
        let nullInput = Darwin.open("/dev/null", O_RDONLY | O_CLOEXEC)
        guard nullInput > STDERR_FILENO,
              stdoutPipe.allSatisfy({ $0 > STDERR_FILENO && makeCloseOnExec($0) }),
              stderrPipe.allSatisfy({ $0 > STDERR_FILENO && makeCloseOnExec($0) }) else {
            closePair(stdoutPipe)
            closePair(stderrPipe)
            if nullInput >= 0 { Darwin.close(nullInput) }
            throw SystemCommandRunnerError.launchFailed
        }

        var fileActions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&fileActions) == 0 else {
            closePair(stdoutPipe)
            closePair(stderrPipe)
            Darwin.close(nullInput)
            throw SystemCommandRunnerError.launchFailed
        }
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else {
            closePair(stdoutPipe)
            closePair(stderrPipe)
            Darwin.close(nullInput)
            throw SystemCommandRunnerError.launchFailed
        }
        defer {
            posix_spawnattr_destroy(&attributes)
        }

        let actionResults = [
            posix_spawn_file_actions_adddup2(&fileActions, stdoutPipe[1], STDOUT_FILENO),
            posix_spawn_file_actions_adddup2(&fileActions, stderrPipe[1], STDERR_FILENO),
            posix_spawn_file_actions_adddup2(&fileActions, nullInput, STDIN_FILENO),
            posix_spawn_file_actions_addclose(&fileActions, stdoutPipe[0]),
            posix_spawn_file_actions_addclose(&fileActions, stdoutPipe[1]),
            posix_spawn_file_actions_addclose(&fileActions, stderrPipe[0]),
            posix_spawn_file_actions_addclose(&fileActions, stderrPipe[1]),
            posix_spawn_file_actions_addclose(&fileActions, nullInput),
        ]
        let spawnFlags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)
        guard actionResults.allSatisfy({ $0 == 0 }),
              posix_spawnattr_setpgroup(&attributes, 0) == 0,
              posix_spawnattr_setflags(&attributes, spawnFlags) == 0 else {
            closePair(stdoutPipe)
            closePair(stderrPipe)
            Darwin.close(nullInput)
            throw SystemCommandRunnerError.launchFailed
        }

        let strings = [executable.path] + arguments
        var argv = strings.map { strdup($0) }
        argv.append(nil)
        defer { argv.forEach { free($0) } }
        let environmentStrings: [String] = ProcessInfo.processInfo.environment
            .map { "\($0.key)=\($0.value)" }
            .sorted()
        var environment: [UnsafeMutablePointer<CChar>?] = environmentStrings.map { strdup($0) }
        environment.append(nil)
        defer { environment.forEach { free($0) } }

        var pid: pid_t = 0
        let spawnResult = executable.path.withCString { path in
            argv.withUnsafeMutableBufferPointer { argumentBuffer in
                environment.withUnsafeMutableBufferPointer { environmentBuffer in
                    posix_spawn(
                        &pid,
                        path,
                        &fileActions,
                        &attributes,
                        argumentBuffer.baseAddress!,
                        environmentBuffer.baseAddress!
                    )
                }
            }
        }
        guard spawnResult == 0, pid > 0 else {
            closePair(stdoutPipe)
            closePair(stderrPipe)
            Darwin.close(nullInput)
            throw SystemCommandRunnerError.launchFailed
        }

        Darwin.close(nullInput)
        Darwin.close(stdoutPipe[1])
        Darwin.close(stderrPipe[1])
        guard makeNonblocking(stdoutPipe[0]), makeNonblocking(stderrPipe[0]) else {
            terminateProcessGroup(pid, signal: SIGKILL)
            Darwin.close(stdoutPipe[0])
            Darwin.close(stderrPipe[0])
            scheduleReap(pid)
            throw SystemCommandRunnerError.launchFailed
        }
        return SpawnedProcess(pid: pid, stdout: stdoutPipe[0], stderr: stderrPipe[0])
    }

    private func pump(
        pid: pid_t,
        stdout: inout BoundedPipe,
        stderr: inout BoundedPipe,
        waitStatus: inout Int32?,
        until deadline: UInt64
    ) -> Bool {
        while true {
            stdout.drain(
                until: deadline,
                maximumReads: Self.maximumReadsPerPipePerPump
            )
            stderr.drain(
                until: deadline,
                maximumReads: Self.maximumReadsPerPipePerPump
            )
            reap(pid, status: &waitStatus)
            if waitStatus != nil,
               stdout.isClosed,
               stderr.isClosed,
               !processGroupExists(pid) {
                return true
            }

            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { return false }
            var descriptors = [stdout.pollDescriptor, stderr.pollDescriptor].compactMap { $0 }
            let remainingMilliseconds = min(
                UInt64(Self.maximumPollMilliseconds),
                max(UInt64(1), (deadline - now) / 1_000_000)
            )
            let milliseconds = Int32(remainingMilliseconds)
            if descriptors.isEmpty {
                _ = Darwin.poll(nil, 0, milliseconds)
            } else {
                descriptors.withUnsafeMutableBufferPointer { buffer in
                    _ = Darwin.poll(buffer.baseAddress, nfds_t(buffer.count), milliseconds)
                }
            }
        }
    }

    private func reap(_ pid: pid_t, status: inout Int32?) {
        guard status == nil else { return }
        var rawStatus: Int32 = 0
        let result = Darwin.waitpid(pid, &rawStatus, WNOHANG)
        if result == pid {
            status = rawStatus
        }
    }

    private func processGroupExists(_ pid: pid_t) -> Bool {
        if Darwin.kill(-pid, 0) == 0 { return true }
        return errno == EPERM
    }

    private func terminateProcessGroup(_ pid: pid_t, signal: Int32) {
        guard pid > 0 else { return }
        _ = Darwin.kill(-pid, signal)
    }

    private func decodedStatus(_ status: Int32) -> SystemCommandExitStatus {
        let terminatingSignal = status & 0x7f
        if terminatingSignal == 0 {
            return .exited((status >> 8) & 0xff)
        }
        return .signaled(terminatingSignal)
    }

    private func deadline(afterNanoseconds duration: UInt64) -> UInt64 {
        let now = DispatchTime.now().uptimeNanoseconds
        let (result, overflow) = now.addingReportingOverflow(duration)
        return overflow ? UInt64.max : result
    }

    private func makeNonblocking(_ descriptor: Int32) -> Bool {
        let flags = Darwin.fcntl(descriptor, F_GETFL)
        return flags >= 0 && Darwin.fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0
    }

    private func makeCloseOnExec(_ descriptor: Int32) -> Bool {
        let flags = Darwin.fcntl(descriptor, F_GETFD)
        return flags >= 0 && Darwin.fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0
    }

    private func closePair(_ descriptors: [Int32]) {
        for descriptor in descriptors where descriptor >= 0 {
            Darwin.close(descriptor)
        }
    }

    private func scheduleReap(_ pid: pid_t) {
        let source = DispatchSource.makeProcessSource(
            identifier: pid,
            eventMask: .exit,
            queue: .global(qos: .utility)
        )
        source.setEventHandler {
            var status: Int32 = 0
            _ = Darwin.waitpid(pid, &status, WNOHANG)
            source.cancel()
        }
        source.resume()
    }
}

private struct SpawnedProcess {
    let pid: pid_t
    let stdout: Int32
    let stderr: Int32
}

private struct BoundedPipe {
    private(set) var descriptor: Int32?
    private(set) var data = Data()

    init(fd: Int32) {
        descriptor = fd
    }

    var isClosed: Bool { descriptor == nil }

    var pollDescriptor: pollfd? {
        descriptor.map { pollfd(fd: $0, events: Int16(POLLIN | POLLHUP | POLLERR), revents: 0) }
    }

    mutating func drain(until deadline: UInt64, maximumReads: Int) {
        guard let descriptor else { return }
        var bytes = [UInt8](repeating: 0, count: 8_192)
        var reads = 0
        while reads < maximumReads,
              DispatchTime.now().uptimeNanoseconds < deadline {
            let count = Darwin.read(descriptor, &bytes, bytes.count)
            if count > 0 {
                reads += 1
                let remaining = SystemCommandRunner.maximumOutputBytes - data.count
                if remaining > 0 {
                    data.append(contentsOf: bytes.prefix(min(remaining, count)))
                }
            } else if count == 0 {
                close()
                return
            } else if errno == EINTR {
                continue
            } else if errno == EAGAIN || errno == EWOULDBLOCK {
                return
            } else {
                close()
                return
            }
        }
    }

    mutating func close() {
        if let descriptor {
            Darwin.close(descriptor)
            self.descriptor = nil
        }
    }
}

import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class SystemCommandRunnerTests: XCTestCase {
    func testArgumentsArePassedLiterallyWithoutAShell() throws {
        let literal = "$(printf compromised); echo still-an-argument"
        let result = try SystemCommandRunner().run(
            executable: URL(fileURLWithPath: "/usr/bin/printf"),
            arguments: ["%s", literal],
            timeout: 2
        )

        XCTAssertEqual(result.exitStatus, .exited(0))
        XCTAssertEqual(String(decoding: result.stdout, as: UTF8.self), literal)
        XCTAssertTrue(result.stderr.isEmpty)
    }

    func testExecutableMustBeAnAbsoluteFileURL() throws {
        XCTAssertThrowsError(
            try SystemCommandRunner().run(
                executable: URL(string: "relative-tool")!,
                arguments: [],
                timeout: 1
            )
        ) { error in
            XCTAssertEqual(error as? SystemCommandRunnerError, .executableMustBeAbsolute)
        }
    }

    func testStdoutAndStderrAreIndependentlyCappedAt64KiBWhilePipesAreDrained() throws {
        let result = try SystemCommandRunner().run(
            executable: URL(fileURLWithPath: "/usr/bin/awk"),
            arguments: [
                "BEGIN { for (i = 0; i < 70000; i++) { printf \"o\"; printf \"e\" > \"/dev/stderr\" } }",
            ],
            timeout: 5
        )

        XCTAssertEqual(result.exitStatus, .exited(0))
        XCTAssertEqual(result.stdout.count, 65_536)
        XCTAssertEqual(result.stderr.count, 65_536)
        XCTAssertEqual(Set(result.stdout), Set([Character("o").asciiValue!]))
        XCTAssertEqual(Set(result.stderr), Set([Character("e").asciiValue!]))
    }

    func testTimeoutTerminatesTheProcessAndReturnsTypedStatus() throws {
        let start = Date()
        let result = try SystemCommandRunner().run(
            executable: URL(fileURLWithPath: "/usr/bin/yes"),
            arguments: [],
            timeout: 0.05
        )

        XCTAssertEqual(result.exitStatus, .timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
        XCTAssertLessThanOrEqual(result.stdout.count, 65_536)
        XCTAssertLessThanOrEqual(result.stderr.count, 65_536)
    }

    func testTimeoutKillsOwnedProcessGroupWhenDescendantInheritsPipes() throws {
        try withDescendantPipeFixture { executable, directory in
            let pidFile = directory.appendingPathComponent("descendant.pid")
            let start = Date()
            let result = try SystemCommandRunner().run(
                executable: executable,
                arguments: ["3", pidFile.path],
                timeout: 0.1
            )

            XCTAssertEqual(result.exitStatus, .timedOut)
            XCTAssertLessThan(Date().timeIntervalSince(start), 1)
            let descendantPID = try XCTUnwrap(
                pid_t(String(decoding: Data(contentsOf: pidFile), as: UTF8.self))
            )
            XCTAssertTrue(waitUntilProcessIsGone(descendantPID, timeout: 0.5))
        }
    }

    func testNonzeroExitIsReturnedAsTypedExitStatus() throws {
        let result = try SystemCommandRunner().run(
            executable: URL(fileURLWithPath: "/usr/bin/false"),
            arguments: [],
            timeout: 1
        )

        XCTAssertEqual(result.exitStatus, .exited(1))
    }
}

private func withDescendantPipeFixture<T>(_ body: (URL, URL) throws -> T) throws -> T {
    let directory = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
        .appendingPathComponent("rr-process-group-fixture-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }

    let source = directory.appendingPathComponent("descendant.c")
    let executable = directory.appendingPathComponent("descendant-fixture")
    let program = #"""
    #include <fcntl.h>
    #include <signal.h>
    #include <stdio.h>
    #include <stdlib.h>
    #include <unistd.h>

    int main(int argc, char **argv) {
        if (argc != 3) return 1;
        unsigned int seconds = (unsigned int)strtoul(argv[1], NULL, 10);
        int ready[2];
        if (pipe(ready) != 0) return 2;
        pid_t child = fork();
        if (child < 0) return 3;
        if (child == 0) {
            close(ready[0]);
            signal(SIGTERM, SIG_IGN);
            int pid_file = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
            if (pid_file < 0) _exit(4);
            if (dprintf(pid_file, "%d", getpid()) < 0) _exit(5);
            if (fsync(pid_file) != 0) _exit(6);
            close(pid_file);
            char marker = 'x';
            if (write(ready[1], &marker, 1) != 1) _exit(7);
            close(ready[1]);
            sleep(seconds);
            _exit(0);
        }
        close(ready[1]);
        char marker;
        if (read(ready[0], &marker, 1) != 1) return 8;
        close(ready[0]);
        _exit(0);
    }
    """#
    try Data(program.utf8).write(to: source)

    let compiler = Process()
    compiler.executableURL = URL(fileURLWithPath: "/usr/bin/clang")
    compiler.arguments = [source.path, "-o", executable.path]
    let diagnostics = Pipe()
    compiler.standardError = diagnostics
    try compiler.run()
    compiler.waitUntilExit()
    let diagnosticData = diagnostics.fileHandleForReading.readDataToEndOfFile()
    XCTAssertEqual(
        compiler.terminationStatus,
        0,
        String(decoding: diagnosticData, as: UTF8.self)
    )
    return try body(executable, directory)
}

private func waitUntilProcessIsGone(_ pid: pid_t, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if Darwin.kill(pid, 0) != 0, errno == ESRCH { return true }
        usleep(5_000)
    } while Date() < deadline
    return false
}

private extension Character {
    var asciiValue: UInt8? { String(self).utf8.first }
}

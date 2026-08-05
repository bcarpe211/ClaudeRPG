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

    func testNonzeroExitIsReturnedAsTypedExitStatus() throws {
        let result = try SystemCommandRunner().run(
            executable: URL(fileURLWithPath: "/usr/bin/false"),
            arguments: [],
            timeout: 1
        )

        XCTAssertEqual(result.exitStatus, .exited(1))
    }
}

private extension Character {
    var asciiValue: UInt8? { String(self).utf8.first }
}

import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class RuntimeRaidersCLIIntegrationTests: XCTestCase {
    func testActualVersionOnlyAppRunsStatusUpdateAndRuntimeInputVersionLoad() throws {
        try withActualVersionOnlyApp { fixture in
            let status = try runCLI(fixture, arguments: ["status"])
            XCTAssertEqual(status.exitStatus, 0, status.stderr)
            let statusObject = (try? JSONSerialization.jsonObject(
                with: Data(status.stdout.utf8)
            )) as? [String: Any]
            XCTAssertEqual(statusObject?["installedCompanionVersion"] as? String, "1.2.3")
            XCTAssertNil(statusObject?["installedReleaseSequence"])

            let update = try runCLI(fixture, arguments: ["update"])
            XCTAssertEqual(update.exitStatus, 0, update.stderr)
            XCTAssertEqual(update.stdout, "Runtime Raiders 1.2.3 is current.\n")

            let runtimeInputs = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"]
            )
            XCTAssertEqual(runtimeInputs.exitStatus, 0, runtimeInputs.stderr)
            XCTAssertEqual(runtimeInputs.stdout, "1.2.3\n")

            let ungated = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                includeVerificationGate: false
            )
            XCTAssertNotEqual(ungated.exitStatus, 0)
        }
    }

    func testActualCLIRejectsMissingAndWrongVersionOnlyPlists() throws {
        try withActualVersionOnlyApp { fixture in
            for invalid in [
                versionInfo(removing: "CFBundleVersion"),
                versionInfo(replacing: "CFBundleIdentifier", with: "com.example.other"),
                versionInfo(replacing: "CFBundleVersion", with: "1.2.4"),
            ] {
                try writeInfo(invalid, to: fixture.info)
                let result = try runCLI(
                    fixture,
                    arguments: ["__runtime-raiders-verify-runtime-inputs"]
                )
                XCTAssertNotEqual(result.exitStatus, 0, "accepted invalid plist \(invalid)")
            }
        }
    }

    private struct Fixture {
        let home: URL
        let applicationSupport: URL
        let executable: URL
        let info: URL
        let versionResponse: URL
    }

    private struct ProcessResult {
        let exitStatus: Int32
        let stdout: String
        let stderr: String
    }

    private enum FixtureError: Error {
        case builtExecutableMissing
        case processTimedOut
    }

    private func withActualVersionOnlyApp(_ body: (Fixture) throws -> Void) throws {
        let suffix = UUID().uuidString.prefix(8)
        let home = URL(fileURLWithPath: "/private/tmp/rrc.\(suffix)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let applicationSupport = home.appendingPathComponent(
            "Library/Application Support",
            isDirectory: true
        )
        let paths = AgentPaths(applicationSupportDirectory: applicationSupport)
        XCTAssertLessThan(paths.controlSocket.path.utf8.count, 104)

        let contents = paths.agentApplication.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        for directory in [
            home,
            home.appendingPathComponent("Library", isDirectory: true),
            applicationSupport,
            paths.supportDirectory,
            paths.stateDirectory,
            paths.outboxDirectory,
            paths.agentApplication,
            contents,
            macOS,
        ] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
        }

        let builtExecutable = Bundle(for: Self.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("raiders", isDirectory: false)
        guard FileManager.default.isExecutableFile(atPath: builtExecutable.path) else {
            throw FixtureError.builtExecutableMissing
        }
        try FileManager.default.copyItem(at: builtExecutable, to: paths.agentExecutable)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: paths.agentExecutable.path
        )

        let info = contents.appendingPathComponent("Info.plist", isDirectory: false)
        try writeInfo(versionInfo(), to: info)
        let enrollment = paths.stateDirectory.appendingPathComponent(
            "enrollment.json",
            isDirectory: false
        )
        try Data((
            #"{"version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dedupe_secret":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","server_url":"https://raiders.redlattice.com","cutover_at":1700000000000,"enabled_surfaces":["codex_desktop","codex_cli"]}"#
        ).utf8).write(to: enrollment)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: enrollment.path
        )
        let versionResponse = paths.stateDirectory.appendingPathComponent(
            "version-response.json",
            isDirectory: false
        )
        try Data(#"{"version":"1.2.3"}"#.utf8).write(to: versionResponse)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: versionResponse.path
        )

        try body(Fixture(
            home: home,
            applicationSupport: applicationSupport,
            executable: paths.agentExecutable,
            info: info,
            versionResponse: versionResponse
        ))
    }

    private func runCLI(
        _ fixture: Fixture,
        arguments: [String],
        includeVerificationGate: Bool = true
    ) throws -> ProcessResult {
        let process = Process()
        process.executableURL = fixture.executable
        process.arguments = arguments
        var environment = [
            "PATH": "/usr/bin:/bin",
            "HOME": fixture.home.path,
            "CFFIXED_USER_HOME": fixture.home.path,
            "RUNTIME_RAIDERS_VERIFY_VERSION_RESPONSE_FILE": fixture.versionResponse.path,
            "RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY":
                fixture.applicationSupport.path,
        ]
        if includeVerificationGate {
            environment["RUNTIME_RAIDERS_VERIFY_RUNTIME_INPUTS"] = "1"
        }
        process.environment = environment
        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }

        try process.run()
        guard completed.wait(timeout: .now() + 5) == .success else {
            Darwin.kill(process.processIdentifier, SIGKILL)
            _ = completed.wait(timeout: .now() + 1)
            throw FixtureError.processTimedOut
        }
        return ProcessResult(
            exitStatus: process.terminationStatus,
            stdout: String(
                decoding: output.fileHandleForReading.readDataToEndOfFile(),
                as: UTF8.self
            ),
            stderr: String(
                decoding: error.fileHandleForReading.readDataToEndOfFile(),
                as: UTF8.self
            )
        )
    }

    private func versionInfo() -> [String: Any] {
        [
            "CFBundleExecutable": "runtime-raiders-agent",
            "CFBundleIdentifier": "com.redlattice.runtime-raiders-agent",
            "CFBundleName": "Runtime Raiders Agent",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.2.3",
            "CFBundleVersion": "1.2.3",
        ]
    }

    private func versionInfo(removing key: String) -> [String: Any] {
        var info = versionInfo()
        info.removeValue(forKey: key)
        return info
    }

    private func versionInfo(replacing key: String, with value: Any) -> [String: Any] {
        var info = versionInfo()
        info[key] = value
        return info
    }

    private func writeInfo(_ info: [String: Any], to url: URL) throws {
        try PropertyListSerialization.data(
            fromPropertyList: info,
            format: .xml,
            options: 0
        ).write(to: url)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: url.path
        )
    }
}

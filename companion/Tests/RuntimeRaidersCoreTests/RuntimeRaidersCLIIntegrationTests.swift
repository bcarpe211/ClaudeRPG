import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class RuntimeRaidersCLIIntegrationTests: XCTestCase {
    func testActualVersionOnlyAppRunsStatusUpdateAndRuntimeInputVersionLoad() throws {
        try withActualVersionOnlyApp { fixture in
            let before = try treeFingerprint(fixture.paths.supportDirectory)
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
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)

            let ungated = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                includeVerificationGate: false
            )
            XCTAssertNotEqual(ungated.exitStatus, 0)
        }
    }

    func testVerificationModeRejectsNormalRoutesBeforeSocketOrStateBehavior() throws {
        try withActualVersionOnlyApp { fixture in
            let recorder = RequestRecorder()
            let server = ControlSocketServer(socketURL: fixture.paths.controlSocket)
            try server.startRequests { request in
                recorder.record(request.command)
                return ControlResponse(ok: true, message: "verification reached socket")
            }
            defer { server.stop() }
            let before = try treeFingerprint(fixture.paths.supportDirectory)

            for arguments in [
                ["on"], ["off"], ["doctor"], ["uninstall"], ["unknown"], [],
            ] {
                let result = try runCLI(fixture, arguments: arguments)
                XCTAssertNotEqual(result.exitStatus, 0, "accepted \(arguments)")
                XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
            }

            XCTAssertEqual(recorder.commands, [])
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)

            let status = try runCLI(fixture, arguments: ["status"])
            XCTAssertEqual(status.exitStatus, 0, status.stderr)
            XCTAssertTrue(status.stdout.contains(#""installedCompanionVersion":"1.2.3""#))
            XCTAssertEqual(recorder.commands, [])
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)
        }
    }

    func testVerificationModeRejectsDaemonBeforeEnrollmentOrRuntimeStartup() throws {
        try withActualVersionOnlyApp { fixture in
            let enrollment = fixture.paths.stateDirectory.appendingPathComponent(
                "enrollment.json",
                isDirectory: false
            )
            try FileManager.default.removeItem(at: enrollment)
            let before = try treeFingerprint(fixture.paths.supportDirectory)

            let result = try runCLI(fixture, arguments: ["daemon"])

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
            XCTAssertEqual(try treeFingerprint(fixture.paths.supportDirectory), before)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.paths.controlSocket.path))
        }
    }

    func testVerificationModeRejectsUpdateWithoutAValidOfflineResponse() throws {
        try withActualVersionOnlyApp { fixture in
            let result = try runCLI(
                fixture,
                arguments: ["update"],
                versionResponsePath: ""
            )

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.paths.updateLock.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.paths.updateState.path))
        }
    }

    func testVerificationSupportPathRejectsNoncanonicalSymlinkedAndLooseDirectories() throws {
        try withActualVersionOnlyApp { fixture in
            let noncanonical = fixture.applicationSupport.path.replacingOccurrences(
                of: "/Library/Application Support",
                with: "/Library/../Library/Application Support"
            )
            var result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                supportOverridePath: noncanonical
            )
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)

            let aliasRoot = URL(
                fileURLWithPath: "/private/tmp/rrv.\(UUID().uuidString.prefix(6))",
                isDirectory: true
            )
            try FileManager.default.createSymbolicLink(
                at: aliasRoot,
                withDestinationURL: fixture.root
            )
            defer { try? FileManager.default.removeItem(at: aliasRoot) }
            result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                supportOverridePath: aliasRoot
                    .appendingPathComponent("home/Library/Application Support", isDirectory: true)
                    .path
            )
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)

            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: fixture.applicationSupport.path
            )
            defer {
                try? FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: fixture.applicationSupport.path
                )
            }
            result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"]
            )
            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
        }
    }

    func testHiddenVerificationRouteIsUnavailableWithoutTheSupportOverride() throws {
        try withActualVersionOnlyApp { fixture in
            let result = try runCLI(
                fixture,
                arguments: ["__runtime-raiders-verify-runtime-inputs"],
                includeVerificationGate: false,
                includeSupportOverride: false,
                versionResponsePath: ""
            )

            XCTAssertNotEqual(result.exitStatus, 0)
            XCTAssertTrue(result.stderr.contains("usage:"), result.stderr)
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
        let root: URL
        let home: URL
        let applicationSupport: URL
        let paths: AgentPaths
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
        case cannotCreateVerificationRoot
        case processTimedOut
    }

    private final class RequestRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [ControlCommand] = []

        var commands: [ControlCommand] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }

        func record(_ command: ControlCommand) {
            lock.lock()
            storage.append(command)
            lock.unlock()
        }
    }

    private func withActualVersionOnlyApp(_ body: (Fixture) throws -> Void) throws {
        var template = Array("/private/tmp/rrv.XXXXXX".utf8CString)
        let created = template.withUnsafeMutableBufferPointer { pointer -> String? in
            guard let path = Darwin.mkdtemp(pointer.baseAddress) else { return nil }
            return String(cString: path)
        }
        guard let created else { throw FixtureError.cannotCreateVerificationRoot }
        let root = URL(fileURLWithPath: created, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home", isDirectory: true)
        let applicationSupport = home.appendingPathComponent(
            "Library/Application Support",
            isDirectory: true
        )
        let paths = AgentPaths(applicationSupportDirectory: applicationSupport)
        XCTAssertLessThan(paths.controlSocket.path.utf8.count, 104)

        let contents = paths.agentApplication.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        for directory in [
            root,
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
            root: root,
            home: home,
            applicationSupport: applicationSupport,
            paths: paths,
            executable: paths.agentExecutable,
            info: info,
            versionResponse: versionResponse
        ))
    }

    private func runCLI(
        _ fixture: Fixture,
        arguments: [String],
        includeVerificationGate: Bool = true,
        includeSupportOverride: Bool = true,
        supportOverridePath: String? = nil,
        versionResponsePath: String? = nil
    ) throws -> ProcessResult {
        let process = Process()
        process.executableURL = fixture.executable
        process.arguments = arguments
        var environment: [String: String] = [
            "PATH": "/usr/bin:/bin",
            "HOME": fixture.home.path,
            "CFFIXED_USER_HOME": fixture.home.path,
        ]
        environment["RUNTIME_RAIDERS_VERIFY_VERSION_RESPONSE_FILE"] =
            versionResponsePath ?? fixture.versionResponse.path
        if includeSupportOverride {
            environment["RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY"] =
                supportOverridePath ?? fixture.applicationSupport.path
        }
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

    private func treeFingerprint(_ root: URL) throws -> [String: Data] {
        let manager = FileManager.default
        guard let enumerator = manager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: []
        ) else { return [:] }
        var fingerprint: [String: Data] = [:]
        for case let url as URL in enumerator {
            let relative = String(url.path.dropFirst(root.path.count))
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            fingerprint[relative] = values.isRegularFile == true ? try Data(contentsOf: url) : Data()
        }
        return fingerprint
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

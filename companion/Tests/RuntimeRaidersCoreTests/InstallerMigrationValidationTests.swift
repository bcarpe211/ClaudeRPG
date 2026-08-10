import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class InstallerMigrationValidationTests: XCTestCase {
    func testStrictLegacyStatusAcceptsOnlyExactSchemaAndConsistentIntent() throws {
        XCTAssertTrue(try InstallerStatusValidator.validateLegacy(
            legacyStatus(enabled: true, prepared: false),
            prepared: false,
            expectedEnabled: nil
        ))
        XCTAssertNoThrow(try InstallerStatusValidator.validateLegacy(
            legacyStatus(enabled: true, prepared: true),
            prepared: true,
            expectedEnabled: true
        ))

        for invalid in [
            legacyStatus(enabled: true, prepared: false) + Data("x".utf8),
            replacing(legacyStatus(enabled: true, prepared: false),
                      #""activeRunCount":0"#, with: #""activeRunCount":1"#),
            replacing(legacyStatus(enabled: true, prepared: false),
                      #""installedCompanionVersion":"0.2.6""#,
                      with: #""installedCompanionVersion":"0.2.5""#),
            replacing(legacyStatus(enabled: true, prepared: false),
                      #""installedReleaseSequence":8"#,
                      with: #""installedReleaseSequence":7"#),
            replacing(legacyStatus(enabled: true, prepared: false),
                      #""persistedState":"enabled""#,
                      with: #""persistedState":"disabled""#),
            replacing(legacyStatus(enabled: true, prepared: false),
                      #""enabled":true"#,
                      with: #""enabled":false,"enabled":true"#),
            replacing(legacyStatus(enabled: true, prepared: false),
                      #""preparedForUpdate":false"#,
                      with: #""preparedForUpdate":true"#),
            insertingExtraKey(into: legacyStatus(enabled: true, prepared: false)),
            Data(repeating: 0x61, count: 16_385),
        ] {
            XCTAssertThrowsError(try InstallerStatusValidator.validateLegacy(
                invalid,
                prepared: false,
                expectedEnabled: nil
            ))
        }
    }

    func testStrictCandidateStatusBindsIdentityGenerationPreparedStateAndIntent() throws {
        let identity = CompanionReleaseIdentity(
            releaseSequence: 9,
            releaseSHA: String(repeating: "a", count: 40),
            companionVersion: "0.3.0",
            updateProtocolVersion: 2
        )
        XCTAssertNoThrow(try InstallerStatusValidator.validateCandidate(
            candidateStatus(enabled: false, preparedGeneration: 1),
            identity: identity,
            generation: 1,
            prepared: true,
            expectedEnabled: false
        ))
        XCTAssertNoThrow(try InstallerStatusValidator.validateCandidate(
            candidateStatus(enabled: false, preparedGeneration: nil),
            identity: identity,
            generation: 1,
            prepared: false,
            expectedEnabled: false
        ))

        let wrongIdentity = CompanionReleaseIdentity(
            releaseSequence: 10,
            releaseSHA: String(repeating: "b", count: 40),
            companionVersion: "0.3.1",
            updateProtocolVersion: 2
        )
        XCTAssertThrowsError(try InstallerStatusValidator.validateCandidate(
            candidateStatus(enabled: false, preparedGeneration: 1),
            identity: wrongIdentity,
            generation: 1,
            prepared: true,
            expectedEnabled: false
        ))
        for invalid in [
            candidateStatus(enabled: false, preparedGeneration: 2),
            replacing(candidateStatus(enabled: false, preparedGeneration: 1),
                      #""preparedForUpdate":true"#,
                      with: #""preparedForUpdate":false"#),
            replacing(candidateStatus(enabled: false, preparedGeneration: 1),
                      #""installedReleaseSequence":9"#,
                      with: #""installedReleaseSequence":8"#),
            replacing(candidateStatus(enabled: false, preparedGeneration: 1),
                      #""installedCompanionVersion":"0.3.0""#,
                      with: #""installedCompanionVersion":"stale""#),
            insertingExtraKey(into: candidateStatus(enabled: false, preparedGeneration: 1)),
        ] {
            XCTAssertThrowsError(try InstallerStatusValidator.validateCandidate(
                invalid,
                identity: identity,
                generation: 1,
                prepared: true,
                expectedEnabled: false
            ))
        }
    }

    func testProtectedSnapshotChangesForEveryProtectedStateAndOutboxSurface() throws {
        try withTemporaryHome { home, paths in
            let protected: [URL: Data] = [
                paths.stateDirectory.appendingPathComponent("collector-state.json"):
                    Data(#"{"enabled":false,"files":{},"version":1}"#.utf8),
                paths.stateDirectory.appendingPathComponent("enrollment.json"):
                    Data(#"{"version":1}"#.utf8),
                paths.stateDirectory.appendingPathComponent("update-state.json"):
                    Data(#"{"version":1}"#.utf8),
                paths.stateDirectory.appendingPathComponent("providers/codex/cursor.json"):
                    Data(#"{"offset":1}"#.utf8),
                paths.stateDirectory.appendingPathComponent("providers/codex/adapter.snapshot"):
                    Data(#"{"active":false}"#.utf8),
                paths.outboxDirectory.appendingPathComponent(String(repeating: "e", count: 64) + ".json"):
                    Data(#"{"event":"queued"}"#.utf8),
            ]
            for (url, data) in protected {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                var directory = url.deletingLastPathComponent()
                while directory.path.hasPrefix(paths.stateDirectory.path),
                      directory != paths.stateDirectory {
                    try FileManager.default.setAttributes(
                        [.posixPermissions: 0o700],
                        ofItemAtPath: directory.path
                    )
                    directory.deleteLastPathComponent()
                }
                try data.write(to: url)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            }
            let baseline = try InstallerProtectedStateSnapshot.capture(paths: paths)
            XCTAssertTrue(baseline.starts(with: Data("runtime-raiders-protected-state-v1\n".utf8)))

            for (url, original) in protected {
                try Data(original + Data("mutated".utf8)).write(to: url)
                XCTAssertNotEqual(
                    try InstallerProtectedStateSnapshot.capture(paths: paths),
                    baseline,
                    "mutation was not observed for \(url.path.replacingOccurrences(of: home.path, with: "$HOME"))"
                )
                try original.write(to: url)
            }
            XCTAssertEqual(try InstallerProtectedStateSnapshot.capture(paths: paths), baseline)
        }
    }

    func testProtectedSnapshotRejectsSymlinkHardlinkAndUnsafeMode() throws {
        try withTemporaryHome { _, paths in
            let state = paths.stateDirectory.appendingPathComponent("collector-state.json")
            try Data("state".utf8).write(to: state)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: state.path)
            let other = paths.stateDirectory.appendingPathComponent("other")

            try FileManager.default.createSymbolicLink(at: other, withDestinationURL: state)
            XCTAssertThrowsError(try InstallerProtectedStateSnapshot.capture(paths: paths))
            try FileManager.default.removeItem(at: other)

            XCTAssertEqual(link(state.path, other.path), 0)
            XCTAssertThrowsError(try InstallerProtectedStateSnapshot.capture(paths: paths))
            try FileManager.default.removeItem(at: other)

            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: state.path)
            XCTAssertThrowsError(try InstallerProtectedStateSnapshot.capture(paths: paths))
        }
    }

    func testExactSequenceEightValidatorAcceptsCanonicalDiscoveredHomeSurfaces() throws {
        try withLegacyInstallation { fixture in
            let validator = makeLegacyValidator(fixture: fixture)
            XCTAssertNoThrow(try validator.validate(
                homeDirectory: fixture.home,
                paths: fixture.paths,
                expectedTeamIdentifier: "ABCDE12345"
            ))
        }
    }

    func testExactSequenceEightValidatorRejectsExtraBytesLinksModesAndWrongTarget() throws {
        enum Mutation: CaseIterable {
            case extraPlist, extraShim, symlinkPlist, hardlinkShim, unsafePlistMode
            case unsafeDirectoryMode, wrongCommandTarget, extraCommandRecordLine
        }
        for mutation in Mutation.allCases {
            try withLegacyInstallation { fixture in
                switch mutation {
                case .extraPlist:
                    try append(Data("extra\n".utf8), to: fixture.plist)
                case .extraShim:
                    try append(Data("extra\n".utf8), to: fixture.shim)
                case .symlinkPlist:
                    let copy = fixture.plist.appendingPathExtension("copy")
                    try FileManager.default.copyItem(at: fixture.plist, to: copy)
                    try FileManager.default.removeItem(at: fixture.plist)
                    try FileManager.default.createSymbolicLink(at: fixture.plist, withDestinationURL: copy)
                case .hardlinkShim:
                    XCTAssertEqual(link(fixture.shim.path, fixture.shim.appendingPathExtension("hard").path), 0)
                case .unsafePlistMode:
                    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: fixture.plist.path)
                case .unsafeDirectoryMode:
                    try FileManager.default.setAttributes(
                        [.posixPermissions: 0o755],
                        ofItemAtPath: fixture.paths.stateDirectory.path
                    )
                case .wrongCommandTarget:
                    try FileManager.default.removeItem(at: fixture.command)
                    try FileManager.default.createSymbolicLink(
                        atPath: fixture.command.path,
                        withDestinationPath: fixture.plist.path
                    )
                case .extraCommandRecordLine:
                    try append(Data("/tmp/other\n".utf8), to: fixture.commandRecord)
                }
                XCTAssertThrowsError(try makeLegacyValidator(fixture: fixture).validate(
                    homeDirectory: fixture.home,
                    paths: fixture.paths,
                    expectedTeamIdentifier: "ABCDE12345"
                ), "accepted mutation \(mutation)")
            }
        }
    }

    private func legacyStatus(enabled: Bool, prepared: Bool) -> Data {
        let enabledValue = enabled ? "true" : "false"
        let persisted = enabled ? "enabled" : "disabled"
        let preparedValue = prepared ? "true" : "false"
        return Data((
            #"{"activeRunCount":0,"availableCompanionVersion":null,"availableReleaseSequence":null,"compiledAdapters":["claude_code","unavailable","codex_cli","available","codex_desktop","available","omp","unavailable"],"daemonRunning":true,"enabled":"# +
            enabledValue +
            #", "installedCompanionVersion":"0.2.6","installedReleaseSequence":8,"lastSuccessfulUploadMS":null,"persistedState":""# +
            persisted +
            #"","preparedForUpdate":"# + preparedValue +
            #", "queuedEventCount":0,"serverEnabledSurfaces":["codex_cli","codex_desktop"],"updateCommand":null}"# +
            "\n"
        ).replacingOccurrences(of: ", ", with: ",").utf8)
    }

    private func candidateStatus(enabled: Bool, preparedGeneration: Int64?) -> Data {
        let generation = preparedGeneration.map(String.init) ?? "null"
        let enabledValue = enabled ? "true" : "false"
        let persisted = enabled ? "enabled" : "disabled"
        let preparedValue = preparedGeneration == nil ? "false" : "true"
        return Data((
            #"{"activeRunCount":0,"availableCompanionVersion":null,"availableReleaseSequence":null,"compiledAdapters":["claude_code","unavailable","codex_cli","available","codex_desktop","available","omp","unavailable"],"daemonRunning":true,"enabled":"# +
            enabledValue +
            #", "installedCompanionVersion":"0.3.0","installedReleaseSequence":9,"lastSuccessfulUploadMS":null,"persistedState":""# +
            persisted +
            #"","preparedForUpdate":"# + preparedValue +
            #", "preparedReleaseStateGeneration":"# + generation +
            #", "queuedEventCount":0,"serverEnabledSurfaces":["codex_cli","codex_desktop"],"updateCommand":null}"# +
            "\n"
        ).replacingOccurrences(of: ", ", with: ",").utf8)
    }

    private func replacing(_ data: Data, _ old: String, with new: String) -> Data {
        Data(String(decoding: data, as: UTF8.self).replacingOccurrences(of: old, with: new).utf8)
    }

    private func insertingExtraKey(into data: Data) -> Data {
        var value = String(decoding: data, as: UTF8.self)
        value.insert(contentsOf: #""extra":true,"#, at: value.index(after: value.startIndex))
        return Data(value.utf8)
    }

    private func withTemporaryHome(
        _ body: (URL, AgentPaths) throws -> Void
    ) throws {
        let home = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-installer-validation-\(UUID().uuidString)", isDirectory: true)
        let applicationSupport = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        let paths = AgentPaths(applicationSupportDirectory: applicationSupport)
        try FileManager.default.createDirectory(at: paths.stateDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: paths.outboxDirectory, withIntermediateDirectories: true)
        for directory in [home, home.appendingPathComponent("Library"), applicationSupport,
                          paths.supportDirectory, paths.stateDirectory, paths.outboxDirectory] {
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
        defer { try? FileManager.default.removeItem(at: home) }
        try body(home, paths)
    }

    private struct LegacyFixture {
        let home: URL
        let paths: AgentPaths
        let plist: URL
        let shim: URL
        let commandRecord: URL
        let command: URL
        let identity: CompanionReleaseIdentity
    }

    private func withLegacyInstallation(_ body: (LegacyFixture) throws -> Void) throws {
        try withTemporaryHome { home, paths in
            let launchAgents = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
            let bin = home.appendingPathComponent("bin", isDirectory: true)
            try FileManager.default.createDirectory(at: launchAgents, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bin.path)
            let app = paths.legacyFlatApplication
            let contents = app.appendingPathComponent("Contents", isDirectory: true)
            let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
            try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
            for directory in [app, contents, macOS] {
                try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
            }
            let executable = macOS.appendingPathComponent("runtime-raiders-agent")
            try Data("legacy executable".utf8).write(to: executable)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
            let identity = CompanionReleaseIdentity(
                releaseSequence: 8,
                releaseSHA: "dec88d4f6ff600f2be92bed3b12dcfce85f84a51",
                companionVersion: "0.2.6",
                updateProtocolVersion: 1
            )
            let info = contents.appendingPathComponent("Info.plist")
            try PropertyListSerialization.data(fromPropertyList: [
                "CFBundleIdentifier": "com.redlattice.runtime-raiders-agent",
                "CFBundleShortVersionString": identity.companionVersion,
                "RuntimeRaidersReleaseSequence": identity.releaseSequence,
                "RuntimeRaidersReleaseSHA": identity.releaseSHA,
                "RuntimeRaidersUpdateProtocolVersion": identity.updateProtocolVersion,
            ], format: .xml, options: 0).write(to: info)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: info.path)

            let plist = launchAgents.appendingPathComponent("com.redlattice.runtime-raiders-agent.plist")
            try Data(canonicalLegacyPlist(executable: executable.path).utf8).write(to: plist)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plist.path)
            let shim = paths.supportDirectory.appendingPathComponent("raiders")
            let commandRecord = paths.stateDirectory.appendingPathComponent("command-link")
            let command = bin.appendingPathComponent("raiders")
            try Data(canonicalLegacyShim(
                home: home.path,
                support: paths.supportDirectory.path,
                executable: executable.path,
                commandRecord: commandRecord.path
            ).utf8).write(to: shim)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: shim.path)
            try Data((command.path + "\n").utf8).write(to: commandRecord)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: commandRecord.path)
            try FileManager.default.createSymbolicLink(atPath: command.path, withDestinationPath: shim.path)
            try body(LegacyFixture(
                home: home,
                paths: paths,
                plist: plist,
                shim: shim,
                commandRecord: commandRecord,
                command: command,
                identity: identity
            ))
        }
    }

    private func makeLegacyValidator(fixture: LegacyFixture) -> LegacySequenceEightInstallationValidator {
        LegacySequenceEightInstallationValidator(
            signatureInspector: { application, team in
                XCTAssertEqual(application, fixture.paths.legacyFlatApplication)
                XCTAssertEqual(team, "ABCDE12345")
                return CandidateSignatureFacts(
                    bundleIdentifier: "com.redlattice.runtime-raiders-agent",
                    teamIdentifier: team,
                    signatureValid: true,
                    allArchitecturesValid: true,
                    hardenedRuntime: true,
                    secureTimestampPresent: true,
                    gatekeeperNotarized: true
                )
            },
            identityLoader: { _ in fixture.identity }
        )
    }

    private func canonicalLegacyPlist(executable: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>com.redlattice.runtime-raiders-agent</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(executable)</string>
            <string>daemon</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>ProcessType</key>
          <string>Background</string>
        </dict>
        </plist>
        """ + "\n"
    }

    private func canonicalLegacyShim(
        home: String,
        support: String,
        executable: String,
        commandRecord: String
    ) -> String {
        let plist = home + "/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist"
        let shim = support + "/raiders"
        let markerFlag = support + "/state/path-marker-owned"
        return """
        #!/bin/sh
        set -eu
        SUPPORT='\(support)'
        PLIST='\(plist)'
        SHIM='\(shim)'
        COMMAND_LINK_FILE='\(commandRecord)'
        MARKER_FLAG='\(markerFlag)'
        MARKER='export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path'
        LABEL='com.redlattice.runtime-raiders-agent'
        binary='\(executable)'
        job_absent() {
          output="$(mktemp /tmp/runtime-raiders-launchctl.XXXXXX)"
          if launchctl print "gui/$(id -u)/$LABEL" >"$output" 2>&1; then
            rm -f "$output"
            return 1
          else
            print_status=$?
          fi
          [ "$print_status" -eq 113 ] || { rm -f "$output"; return 1; }
          grep -F 'Could not find service' "$output" >/dev/null 2>&1
          status=$?
          rm -f "$output"
          return $status
        }
        if [ "$#" -eq 0 ] || [ "$1" != uninstall ]; then
          exec "$binary" "$@"
        fi
        if "$binary" uninstall; then
          launchctl bootout "gui/$(id -u)" "$PLIST" || {
            echo "Runtime Raiders bootout failed; refusing cleanup" >&2
            exit 1
          }
          job_absent || {
            echo "Runtime Raiders launchd job still present; refusing cleanup" >&2
            exit 1
          }
        elif [ ! -S "$SUPPORT/agent.sock" ] && job_absent; then
          :
        else
          echo "Runtime Raiders daemon did not safely stop; refusing cleanup" >&2
          exit 1
        fi
        if [ -f "$COMMAND_LINK_FILE" ]; then
          command_path="$(cat "$COMMAND_LINK_FILE")"
          if [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ]; then
            rm -f "$command_path"
          fi
        fi
        profile="$HOME/.zprofile"
        if [ -f "$MARKER_FLAG" ] && [ -f "$profile" ]; then
          temporary="$(mktemp "$profile.runtime-raiders.XXXXXX")"
          awk -v marker="$MARKER" 'seen == 0 && $0 == marker { seen = 1; next } { print }' "$profile" > "$temporary"
          mv "$temporary" "$profile"
        fi
        rm -f "$PLIST"
        rm -rf "$SUPPORT"
        """ + "\n"
    }

    private func append(_ data: Data, to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.close()
    }
}

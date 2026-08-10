import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class LauncherSelectionTests: XCTestCase {
    private let teamIdentifier = "RUNTIME RAIDERS TEAM"

    func testParserAcceptsOnlyOnePublicLauncherCommand() {
        for command in ["daemon", "on", "off", "status", "doctor", "update", "uninstall"] {
            XCTAssertEqual(
                LauncherInvocation(arguments: [command])?.arguments,
                [command]
            )
        }

        for rejected in [
            [],
            ["__self-check"],
            ["prepare_update"],
            ["resume_update"],
            ["__runtime-raiders-trial-generation"],
            ["daemon", "status"],
            ["daemon", "__runtime-raiders-trial-generation", "7"],
        ] {
            XCTAssertNil(LauncherInvocation(arguments: rejected), "accepted \(rejected)")
        }
    }

    func testPublicCommandsAlwaysSelectActiveRelease() throws {
        let fixture = Fixture(trial: reference(sequence: 10, sha: "b"), leaseHeld: true)

        for command in ["on", "off", "status", "doctor", "update", "uninstall"] {
            let selection = try fixture.selector.select(
                invocation: try XCTUnwrap(LauncherInvocation(arguments: [command]))
            )
            XCTAssertEqual(selection.release, fixture.active)
            XCTAssertEqual(selection.executable, try fixture.paths.executable(for: fixture.active))
            XCTAssertEqual(selection.arguments, [command])
            XCTAssertEqual(selection.releaseStateGeneration, 7)
        }
    }

    func testPublicCommandSelectionDoesNotConsultTrialLease() throws {
        let fixture = Fixture(
            trial: reference(sequence: 10, sha: "b"),
            leaseError: FixtureError.leaseUnavailable
        )

        let selection = try fixture.selector.select(invocation: .status)

        XCTAssertEqual(selection.release, fixture.active)
        XCTAssertEqual(selection.arguments, ["status"])
    }

    func testDaemonSelectsActiveWithoutTrialOrHeldLease() throws {
        for fixture in [
            Fixture(trial: nil, leaseHeld: true),
            Fixture(trial: reference(sequence: 10, sha: "b"), leaseHeld: false),
        ] {
            let selection = try fixture.selector.select(invocation: .daemon)
            XCTAssertEqual(selection.release, fixture.active)
            XCTAssertEqual(selection.arguments, ["daemon"])
        }
    }

    func testDaemonSelectsTrialOnlyWithHeldLeaseAndForwardsExactGeneration() throws {
        let trial = reference(sequence: 10, sha: "b")
        let fixture = Fixture(trial: trial, leaseHeld: true)

        let selection = try fixture.selector.select(invocation: .daemon)

        XCTAssertEqual(selection.release, trial)
        XCTAssertEqual(selection.executable, try fixture.paths.executable(for: trial))
        XCTAssertEqual(
            selection.arguments,
            ["daemon", "__runtime-raiders-trial-generation", "7"]
        )
        XCTAssertEqual(selection.releaseStateGeneration, 7)
    }

    func testLauncherIdentitySignatureTeamAndProtocolMismatchesFailClosed() {
        let valid = Fixture()
        let mutations: [LauncherBundleValidation] = [
            valid.launcherFacts.replacing(bundleIdentifier: "com.example.substitute"),
            valid.launcherFacts.replacing(teamIdentifier: "OTHER TEAM"),
            valid.launcherFacts.replacing(hardenedRuntime: false),
            valid.launcherFacts.replacing(allArchitecturesValid: false),
            valid.launcherFacts.replacing(launcherProtocolVersion: 2),
            valid.launcherFacts.replacing(bundle: URL(fileURLWithPath: "/private/tmp/Other.app")),
            valid.launcherFacts.replacing(executable: URL(fileURLWithPath: "/private/tmp/other-launcher")),
        ]

        for facts in mutations {
            let fixture = Fixture(launcherFacts: facts)
            XCTAssertThrowsError(try fixture.selector.select(invocation: .status))
        }
    }

    func testAgentBundleSignatureTeamProtocolIdentityAndPathMismatchesFailClosed() {
        let valid = Fixture()
        let wrongIdentity = reference(sequence: 11, sha: "c")
        let mutations: [LauncherBundleValidation] = [
            valid.agentFacts.replacing(bundleIdentifier: "com.example.substitute"),
            valid.agentFacts.replacing(teamIdentifier: "OTHER TEAM"),
            valid.agentFacts.replacing(hardenedRuntime: false),
            valid.agentFacts.replacing(allArchitecturesValid: false),
            valid.agentFacts.replacing(releaseIdentity: try! wrongIdentity.companionReleaseIdentity()),
            valid.agentFacts.replacing(
                releaseIdentity: CompanionReleaseIdentity(
                    releaseSequence: valid.active.releaseSequence,
                    releaseSHA: valid.active.releaseSHA,
                    companionVersion: valid.active.companionVersion,
                    updateProtocolVersion: 1
                )
            ),
            valid.agentFacts.replacing(bundle: URL(fileURLWithPath: "/private/tmp/Substitute.app")),
            valid.agentFacts.replacing(executable: URL(fileURLWithPath: "/private/tmp/substitute-agent")),
        ]

        for facts in mutations {
            let fixture = Fixture(agentFacts: facts)
            XCTAssertThrowsError(try fixture.selector.select(invocation: .status))
        }
    }

    func testRecordAndBundleSubstitutionAtFinalBoundaryFailClosed() {
        let original = Fixture()
        let changedState = ReleaseStateV1(
            schemaVersion: 1,
            generation: 8,
            active: original.active,
            fallback: nil,
            trial: nil
        )
        let stateFixture = Fixture(states: [original.state, changedState])
        XCTAssertThrowsError(try stateFixture.selector.select(invocation: .status))

        let changedFacts = original.agentFacts.replacing(hardenedRuntime: false)
        let bundleFixture = Fixture(agentFactsSequence: [original.agentFacts, changedFacts])
        XCTAssertThrowsError(try bundleFixture.selector.select(invocation: .status))
    }

    func testDaemonRejectsLeaseSubstitutionAtFinalBoundary() {
        let fixture = Fixture(
            trial: reference(sequence: 10, sha: "b"),
            leaseValues: [false, true]
        )

        XCTAssertThrowsError(try fixture.selector.select(invocation: .daemon))
    }

    func testExecutionAdapterReceivesValidatedExecutableLiteralArgumentsAndEnvironment() throws {
        let fixture = Fixture(trial: reference(sequence: 10, sha: "b"), leaseHeld: true)
        let selection = try fixture.selector.select(invocation: .daemon)
        var recorded: LauncherExecutionRequest?
        let adapter = LauncherExecutionAdapter { request in recorded = request }
        let environment = ["PATH": "/usr/bin", "RUNTIME_RAIDERS_TEST": "literal value"]

        try adapter.execute(selection: selection, environment: environment)

        XCTAssertEqual(recorded, LauncherExecutionRequest(
            executable: selection.executable,
            arguments: ["daemon", "__runtime-raiders-trial-generation", "7"],
            environment: environment
        ))
    }

    func testSelectionAndRecordedExecLeaveTemporarySupportTreeUnchanged() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        let active = reference(sequence: 9, sha: "a")
        let application = try paths.application(for: active)
        let executable = try paths.executable(for: active)
        let state = ReleaseStateV1(
            schemaVersion: 1,
            generation: 7,
            active: active,
            fallback: nil,
            trial: nil
        )
        let store = try ReleaseStateStore(paths: paths)
        try store.createInitial(ReleaseStateV1(
            schemaVersion: 1,
            generation: 1,
            active: active,
            fallback: nil,
            trial: nil
        ))
        for generation in 2...state.generation {
            try store.replace(
                expectedGeneration: generation - 1,
                with: ReleaseStateV1(
                    schemaVersion: 1,
                    generation: generation,
                    active: active,
                    fallback: nil,
                    trial: nil
                )
            )
        }
        try FileManager.default.createDirectory(
            at: executable.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try Data("agent fixture".utf8).write(to: executable)
        let launcherFacts = LauncherBundleValidation(
            bundle: paths.launcherApplication,
            executable: paths.launcherExecutable,
            bundleIdentifier: "com.redlattice.runtime-raiders-launcher",
            teamIdentifier: teamIdentifier,
            hardenedRuntime: true,
            allArchitecturesValid: true,
            launcherProtocolVersion: 1,
            releaseIdentity: nil
        )
        let facts = LauncherBundleValidation(
            bundle: application,
            executable: executable,
            bundleIdentifier: "com.redlattice.runtime-raiders-agent",
            teamIdentifier: teamIdentifier,
            hardenedRuntime: true,
            allArchitecturesValid: true,
            launcherProtocolVersion: nil,
            releaseIdentity: try active.companionReleaseIdentity()
        )
        let selector = LauncherSelector(operations: LauncherSelectionOperations(
            paths: paths,
            loadReleaseState: { try ReleaseStateStore.loadExisting(paths: paths) },
            preparedStartupLeaseIsHeld: { false },
            inspectLauncher: { launcherFacts },
            inspectAgent: { _ in facts }
        ))
        let before = try treeFingerprint(root)
        var executed = false

        let selection = try selector.select(invocation: .status)
        try LauncherExecutionAdapter { _ in executed = true }.execute(
            selection: selection,
            environment: [:]
        )

        XCTAssertTrue(executed)
        XCTAssertEqual(try treeFingerprint(root), before)
    }

    func testDebugLauncherProcessRecordsExecWithoutWritingSupportTreeOrExposingForbiddenOperations() throws {
        struct RecordedExecution: Decodable, Equatable {
            let executable: String
            let arguments: [String]
        }

        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = AgentPaths(applicationSupportDirectory: root)
        let active = reference(sequence: 9, sha: "a")
        let store = try ReleaseStateStore(paths: paths)
        try store.createInitial(ReleaseStateV1(
            schemaVersion: 1,
            generation: 1,
            active: active,
            fallback: nil,
            trial: nil
        ))
        let executable = try paths.executable(for: active)
        try FileManager.default.createDirectory(
            at: executable.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try Data("debug agent fixture".utf8).write(to: executable)
        let record = root.appendingPathComponent("launcher-exec-record.json")
        let before = try treeFingerprint(paths.supportDirectory)
        let process = Process()
        process.executableURL = try debugLauncherExecutable()
        process.arguments = ["status"]
        process.environment = [
            "PATH": "/usr/bin:/bin",
            "RUNTIME_RAIDERS_LAUNCHER_DEBUG_SUPPORT_ROOT": root.path,
            "RUNTIME_RAIDERS_LAUNCHER_DEBUG_EXEC_RECORD": record.path,
        ]
        let errorOutput = Pipe()
        process.standardError = errorOutput

        try process.run()
        process.waitUntilExit()

        let stderr = String(
            data: errorOutput.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        XCTAssertEqual(process.terminationStatus, 0, stderr)
        XCTAssertEqual(try treeFingerprint(paths.supportDirectory), before)
        XCTAssertEqual(
            try JSONDecoder().decode(RecordedExecution.self, from: Data(contentsOf: record)),
            RecordedExecution(executable: executable.path, arguments: ["status"])
        )

        let operations = LauncherSelectionOperations(
            paths: paths,
            loadReleaseState: { throw FixtureError.exhausted },
            preparedStartupLeaseIsHeld: { false },
            inspectLauncher: { throw FixtureError.exhausted },
            inspectAgent: { _ in throw FixtureError.exhausted }
        )
        XCTAssertEqual(
            Set(Mirror(reflecting: operations).children.compactMap(\.label)),
            [
                "paths",
                "loadReleaseState",
                "preparedStartupLeaseIsHeld",
                "inspectLauncher",
                "inspectAgent",
            ]
        )
    }

    private final class Fixture {
        let paths: AgentPaths
        let active: ReleaseReference
        let state: ReleaseStateV1
        let launcherFacts: LauncherBundleValidation
        let agentFacts: LauncherBundleValidation
        let selector: LauncherSelector

        init(
            paths: AgentPaths = AgentPaths(
                applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/rr-launcher-selection")
            ),
            trial: ReleaseReference? = nil,
            leaseHeld: Bool = false,
            leaseError: Error? = nil,
            leaseValues suppliedLeaseValues: [Bool]? = nil,
            launcherFacts suppliedLauncherFacts: LauncherBundleValidation? = nil,
            states suppliedStates: [ReleaseStateV1]? = nil,
            agentFacts suppliedAgentFacts: LauncherBundleValidation? = nil,
            agentFactsSequence suppliedAgentFactsSequence: [LauncherBundleValidation]? = nil
        ) {
            self.paths = paths
            active = LauncherSelectionTests.reference(sequence: 9, sha: "a")
            state = suppliedStates?.first ?? ReleaseStateV1(
                schemaVersion: 1,
                generation: 7,
                active: active,
                fallback: nil,
                trial: trial
            )
            launcherFacts = suppliedLauncherFacts ?? LauncherBundleValidation(
                bundle: paths.launcherApplication,
                executable: paths.launcherExecutable,
                bundleIdentifier: "com.redlattice.runtime-raiders-launcher",
                teamIdentifier: "RUNTIME RAIDERS TEAM",
                hardenedRuntime: true,
                allArchitecturesValid: true,
                launcherProtocolVersion: 1,
                releaseIdentity: nil
            )
            agentFacts = suppliedAgentFacts ?? LauncherBundleValidation(
                bundle: try! paths.application(for: active),
                executable: try! paths.executable(for: active),
                bundleIdentifier: "com.redlattice.runtime-raiders-agent",
                teamIdentifier: "RUNTIME RAIDERS TEAM",
                hardenedRuntime: true,
                allArchitecturesValid: true,
                launcherProtocolVersion: nil,
                releaseIdentity: try! active.companionReleaseIdentity()
            )

            var states = suppliedStates ?? []
            var leaseValues = suppliedLeaseValues ?? []
            var agentFactsSequence = suppliedAgentFactsSequence ?? []
            let launcherFacts = self.launcherFacts
            let stableState = state
            let stableAgentFacts = agentFacts
            let trialAgentFacts = trial.map { release in
                LauncherBundleValidation(
                    bundle: try! paths.application(for: release),
                    executable: try! paths.executable(for: release),
                    bundleIdentifier: "com.redlattice.runtime-raiders-agent",
                    teamIdentifier: "RUNTIME RAIDERS TEAM",
                    hardenedRuntime: true,
                    allArchitecturesValid: true,
                    launcherProtocolVersion: nil,
                    releaseIdentity: try! release.companionReleaseIdentity()
                )
            }
            let operations = LauncherSelectionOperations(
                paths: paths,
                loadReleaseState: {
                    suppliedStates == nil ? stableState : try states.removeRequiredFirst()
                },
                preparedStartupLeaseIsHeld: {
                    if let leaseError { throw leaseError }
                    return suppliedLeaseValues == nil
                        ? leaseHeld
                        : try leaseValues.removeRequiredFirst()
                },
                inspectLauncher: { launcherFacts },
                inspectAgent: { application in
                    if suppliedAgentFactsSequence != nil {
                        return try agentFactsSequence.removeRequiredFirst()
                    }
                    if let trial, let trialAgentFacts,
                       application == (try? paths.application(for: trial)) {
                        return trialAgentFacts
                    }
                    return stableAgentFacts
                }
            )
            selector = LauncherSelector(operations: operations)
        }
    }

    fileprivate enum FixtureError: Error {
        case exhausted
        case leaseUnavailable
        case launcherMissing
    }

    private static func reference(sequence: Int64, sha: Character) -> ReleaseReference {
        ReleaseReference(
            releaseSequence: sequence,
            releaseSHA: String(repeating: String(sha), count: 40),
            companionVersion: "0.3.\(sequence)",
            updateProtocolVersion: 2
        )
    }

    private func reference(sequence: Int64, sha: Character) -> ReleaseReference {
        Self.reference(sequence: sequence, sha: sha)
    }

    private func temporaryDirectory() -> URL {
        URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-launcher-smoke-\(UUID().uuidString)", isDirectory: true)
    }

    private func treeFingerprint(_ root: URL) throws -> [String: Data] {
        let manager = FileManager.default
        guard let enumerator = manager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
            options: []
        ) else { return [:] }
        var fingerprint: [String: Data] = [:]
        for case let url as URL in enumerator {
            let relative = String(url.path.dropFirst(root.path.count))
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
            fingerprint[relative] = values.isRegularFile == true ? try Data(contentsOf: url) : Data()
        }
        return fingerprint
    }

    private func debugLauncherExecutable() throws -> URL {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let buildRoot = packageRoot.appendingPathComponent(".build", isDirectory: true)
        guard let enumerator = FileManager.default.enumerator(
            at: buildRoot,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            throw FixtureError.launcherMissing
        }
        for case let url as URL in enumerator where
            url.lastPathComponent == "runtime-raiders-launcher" &&
            url.path.contains("/debug/") {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            if values.isRegularFile == true,
               FileManager.default.isExecutableFile(atPath: url.path) {
                return url
            }
        }
        throw FixtureError.launcherMissing
    }
}

private extension Array {
    mutating func removeRequiredFirst() throws -> Element {
        guard !isEmpty else { throw LauncherSelectionTests.FixtureError.exhausted }
        return removeFirst()
    }
}

private extension LauncherBundleValidation {
    func replacing(
        bundle: URL? = nil,
        executable: URL? = nil,
        bundleIdentifier: String? = nil,
        teamIdentifier: String? = nil,
        hardenedRuntime: Bool? = nil,
        allArchitecturesValid: Bool? = nil,
        launcherProtocolVersion: Int?? = nil,
        releaseIdentity: CompanionReleaseIdentity?? = nil
    ) -> Self {
        Self(
            bundle: bundle ?? self.bundle,
            executable: executable ?? self.executable,
            bundleIdentifier: bundleIdentifier ?? self.bundleIdentifier,
            teamIdentifier: teamIdentifier ?? self.teamIdentifier,
            hardenedRuntime: hardenedRuntime ?? self.hardenedRuntime,
            allArchitecturesValid: allArchitecturesValid ?? self.allArchitecturesValid,
            launcherProtocolVersion: launcherProtocolVersion ?? self.launcherProtocolVersion,
            releaseIdentity: releaseIdentity ?? self.releaseIdentity
        )
    }
}

import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ReleaseArchiveVerifierTests: XCTestCase {
    func testReturnsManifestBoundAgentAndPackagedLauncher() throws {
        try withExtractedRelease { paths in
            let verifier = makeVerifier(paths: paths)

            let verified = try verifier.verify(
                extractedRoot: paths.staging,
                manifest: manifest,
                installed: installedIdentity,
                installedTeamIdentifier: teamIdentifier
            )

            XCTAssertEqual(verified.agent, VerifiedReleaseAgent(
                application: paths.agent,
                identity: try manifestIdentity.releaseReference()
            ))
            XCTAssertEqual(verified.launcher, paths.launcher)
            XCTAssertTrue(try verified.verifiesAgentPromotion(at: paths.agent))
        }
    }

    func testRejectsAgentBundleIdentifierMismatch() throws {
        try assertRejected(agentFacts: agentFacts(bundleIdentifier: "com.example.agent"))
    }

    func testRejectsAgentTeamMismatch() throws {
        try assertRejected(agentFacts: agentFacts(teamIdentifier: "OTHERTEAM1"))
    }

    func testRejectsInvalidAgentSignature() throws {
        try assertRejected(agentFacts: agentFacts(signatureValid: false))
    }

    func testRejectsInvalidAgentArchitecture() throws {
        try assertRejected(agentFacts: agentFacts(allArchitecturesValid: false))
    }

    func testRejectsAgentWithoutHardenedRuntime() throws {
        try assertRejected(agentFacts: agentFacts(hardenedRuntime: false))
    }

    func testRejectsAgentWithoutSecureTimestamp() throws {
        try assertRejected(agentFacts: agentFacts(secureTimestampPresent: false))
    }

    func testRejectsAgentWithoutNotarizationAndGatekeeperAcceptance() throws {
        try assertRejected(agentFacts: agentFacts(gatekeeperNotarized: false))
    }

    func testRejectsLauncherBundleIdentifierMismatch() throws {
        try assertRejected(launcherFacts: launcherFacts(bundleIdentifier: "com.example.launcher"))
    }

    func testRejectsLauncherTeamMismatch() throws {
        try assertRejected(launcherFacts: launcherFacts(teamIdentifier: "OTHERTEAM1"))
    }

    func testRejectsInvalidLauncherSignature() throws {
        try assertRejected(launcherFacts: launcherFacts(signatureValid: false))
    }

    func testRejectsInvalidLauncherArchitecture() throws {
        try assertRejected(launcherFacts: launcherFacts(allArchitecturesValid: false))
    }

    func testRejectsLauncherWithoutHardenedRuntime() throws {
        try assertRejected(launcherFacts: launcherFacts(hardenedRuntime: false))
    }

    func testRejectsLauncherWithoutSecureTimestamp() throws {
        try assertRejected(launcherFacts: launcherFacts(secureTimestampPresent: false))
    }

    func testRejectsLauncherWithoutNotarizationAndGatekeeperAcceptance() throws {
        try assertRejected(launcherFacts: launcherFacts(gatekeeperNotarized: false))
    }

    func testRejectsEveryAgentIdentityFieldThatDiffersFromManifest() throws {
        let mismatches = [
            CompanionReleaseIdentity(
                releaseSequence: manifest.releaseSequence + 1,
                releaseSHA: manifest.releaseSHA,
                companionVersion: manifest.companionVersion,
                updateProtocolVersion: manifest.updateProtocolVersion
            ),
            CompanionReleaseIdentity(
                releaseSequence: manifest.releaseSequence,
                releaseSHA: String(repeating: "d", count: 40),
                companionVersion: manifest.companionVersion,
                updateProtocolVersion: manifest.updateProtocolVersion
            ),
            CompanionReleaseIdentity(
                releaseSequence: manifest.releaseSequence,
                releaseSHA: manifest.releaseSHA,
                companionVersion: "0.3.0",
                updateProtocolVersion: manifest.updateProtocolVersion
            ),
        ]

        for identity in mismatches {
            try assertRejected(agentIdentity: identity)
        }
    }

    func testRejectsProtocolOneManifest() throws {
        try assertRejected(manifest: manifestWithProtocol(1))
    }

    func testRejectsAgentProtocolOtherThanTwo() throws {
        try assertRejected(agentIdentity: CompanionReleaseIdentity(
            releaseSequence: manifest.releaseSequence,
            releaseSHA: manifest.releaseSHA,
            companionVersion: manifest.companionVersion,
            updateProtocolVersion: 1
        ))
    }

    func testRejectsProtocolOneInstalledAgent() throws {
        try assertRejected(installed: CompanionReleaseIdentity(
            releaseSequence: installedIdentity.releaseSequence,
            releaseSHA: installedIdentity.releaseSHA,
            companionVersion: installedIdentity.companionVersion,
            updateProtocolVersion: 1
        ))
    }

    func testRejectsCandidateThatIsNotNewerThanInstalledAgent() throws {
        try assertRejected(installed: CompanionReleaseIdentity(
            releaseSequence: manifest.releaseSequence,
            releaseSHA: installedIdentity.releaseSHA,
            companionVersion: installedIdentity.companionVersion,
            updateProtocolVersion: 2
        ))
    }

    func testRejectsLauncherProtocolOtherThanOne() throws {
        try assertRejected(launcherProtocolVersion: 2)
    }

    func testRejectsExtractedTreeSubstitutionDuringTrustInspection() throws {
        try withExtractedRelease { paths in
            let verifier = ReleaseArchiveVerifier(
                signatureInspector: { application in
                    if application == paths.agent { return self.agentFacts() }
                    try FileManager.default.removeItem(at: paths.agent)
                    try FileManager.default.createSymbolicLink(
                        atPath: paths.agent.path,
                        withDestinationPath: "/private/tmp"
                    )
                    return self.launcherFacts()
                },
                agentIdentityLoader: { _ in self.manifestIdentity },
                launcherProtocolLoader: { _ in 1 }
            )

            XCTAssertThrowsError(try verifier.verify(
                extractedRoot: paths.staging,
                manifest: manifest,
                installed: installedIdentity,
                installedTeamIdentifier: teamIdentifier
            )) { error in
                XCTAssertEqual(error as? ReleaseArchiveVerificationError, .untrustedArchive)
            }
        }
    }

    func testRejectsAgentRegularFileSubstitutionDuringLauncherTrustInspection() throws {
        try assertSubstitutionRejected(.agentPayloadDuringLauncherTrust)
    }

    func testRejectsLauncherRegularFileSubstitutionAfterTrustInspection() throws {
        try assertSubstitutionRejected(.launcherPayloadDuringAgentIdentity)
    }

    func testRejectsAgentInfoPlistSubstitutionDuringIdentityInspection() throws {
        try assertSubstitutionRejected(.agentInfoDuringAgentIdentity)
    }

    func testRejectsLauncherInfoPlistSubstitutionDuringProtocolInspection() throws {
        try assertSubstitutionRejected(.launcherInfoDuringProtocolLoad)
    }

    func testInstallerVerificationReturnsExactIdentityAndBothTrustedApplications() throws {
        try withExtractedRelease { paths in
            let verified = try makeVerifier(paths: paths).verifyInstallerRelease(
                extractedRoot: paths.staging,
                expected: manifestIdentity,
                expectedTeamIdentifier: teamIdentifier
            )
            XCTAssertEqual(verified.agent, VerifiedReleaseAgent(
                application: paths.agent,
                identity: try manifestIdentity.releaseReference()
            ))
            XCTAssertEqual(verified.launcher, paths.launcher)
        }
    }

    func testInstallerVerificationRejectsEveryIncompleteBundleTrustFact() throws {
        let badAgentFacts = [
            agentFacts(bundleIdentifier: "com.example.agent"),
            agentFacts(teamIdentifier: "OTHERTEAM1"),
            agentFacts(signatureValid: false),
            agentFacts(allArchitecturesValid: false),
            agentFacts(hardenedRuntime: false),
            agentFacts(secureTimestampPresent: false),
            agentFacts(gatekeeperNotarized: false),
        ]
        let badLauncherFacts = [
            launcherFacts(bundleIdentifier: "com.example.launcher"),
            launcherFacts(teamIdentifier: "OTHERTEAM1"),
            launcherFacts(signatureValid: false),
            launcherFacts(allArchitecturesValid: false),
            launcherFacts(hardenedRuntime: false),
            launcherFacts(secureTimestampPresent: false),
            launcherFacts(gatekeeperNotarized: false),
        ]
        for facts in badAgentFacts {
            try assertInstallerRejected(agentFacts: facts)
        }
        for facts in badLauncherFacts {
            try assertInstallerRejected(launcherFacts: facts)
        }
    }

    func testInstallerVerificationRejectsWrongIdentityProtocolAndSubstitution() throws {
        for identity in [
            CompanionReleaseIdentity(
                releaseSequence: manifestIdentity.releaseSequence + 1,
                releaseSHA: manifestIdentity.releaseSHA,
                companionVersion: manifestIdentity.companionVersion,
                updateProtocolVersion: 2
            ),
            CompanionReleaseIdentity(
                releaseSequence: manifestIdentity.releaseSequence,
                releaseSHA: String(repeating: "f", count: 40),
                companionVersion: manifestIdentity.companionVersion,
                updateProtocolVersion: 2
            ),
            CompanionReleaseIdentity(
                releaseSequence: manifestIdentity.releaseSequence,
                releaseSHA: manifestIdentity.releaseSHA,
                companionVersion: "0.0.0",
                updateProtocolVersion: 2
            ),
            CompanionReleaseIdentity(
                releaseSequence: manifestIdentity.releaseSequence,
                releaseSHA: manifestIdentity.releaseSHA,
                companionVersion: manifestIdentity.companionVersion,
                updateProtocolVersion: 1
            ),
        ] {
            try assertInstallerRejected(agentIdentity: identity)
        }
        try assertInstallerRejected(launcherProtocolVersion: 2)

        try withExtractedRelease { paths in
            let verifier = ReleaseArchiveVerifier(
                signatureInspector: { application in
                    if application == paths.agent { return self.agentFacts() }
                    try FileManager.default.removeItem(at: paths.agent)
                    try FileManager.default.createSymbolicLink(
                        atPath: paths.agent.path,
                        withDestinationPath: "/private/tmp"
                    )
                    return self.launcherFacts()
                },
                agentIdentityLoader: { _ in self.manifestIdentity },
                launcherProtocolLoader: { _ in 1 }
            )
            XCTAssertThrowsError(try verifier.verifyInstallerRelease(
                extractedRoot: paths.staging,
                expected: manifestIdentity,
                expectedTeamIdentifier: teamIdentifier
            ))
        }
    }

    private let teamIdentifier = "REDLATTICE"

    private var manifest: ReleaseManifestV1 { manifestWithProtocol(2) }

    private func manifestWithProtocol(_ updateProtocolVersion: Int) -> ReleaseManifestV1 {
        try! ReleaseManifestV1.decode(Data(#"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":\#(updateProtocolVersion),"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#.utf8))
    }

    private var installedIdentity: CompanionReleaseIdentity {
        CompanionReleaseIdentity(
            releaseSequence: 1,
            releaseSHA: String(repeating: "c", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 2
        )
    }

    private var manifestIdentity: CompanionReleaseIdentity {
        CompanionReleaseIdentity(
            releaseSequence: manifest.releaseSequence,
            releaseSHA: manifest.releaseSHA,
            companionVersion: manifest.companionVersion,
            updateProtocolVersion: manifest.updateProtocolVersion
        )
    }

    private func agentFacts(
        bundleIdentifier: String = "com.redlattice.runtime-raiders-agent",
        teamIdentifier: String = "REDLATTICE",
        signatureValid: Bool = true,
        allArchitecturesValid: Bool = true,
        hardenedRuntime: Bool = true,
        secureTimestampPresent: Bool = true,
        gatekeeperNotarized: Bool = true
    ) -> CandidateSignatureFacts {
        CandidateSignatureFacts(
            bundleIdentifier: bundleIdentifier,
            teamIdentifier: teamIdentifier,
            signatureValid: signatureValid,
            allArchitecturesValid: allArchitecturesValid,
            hardenedRuntime: hardenedRuntime,
            secureTimestampPresent: secureTimestampPresent,
            gatekeeperNotarized: gatekeeperNotarized
        )
    }

    private func launcherFacts(
        bundleIdentifier: String = "com.redlattice.runtime-raiders-launcher",
        teamIdentifier: String = "REDLATTICE",
        signatureValid: Bool = true,
        allArchitecturesValid: Bool = true,
        hardenedRuntime: Bool = true,
        secureTimestampPresent: Bool = true,
        gatekeeperNotarized: Bool = true
    ) -> CandidateSignatureFacts {
        CandidateSignatureFacts(
            bundleIdentifier: bundleIdentifier,
            teamIdentifier: teamIdentifier,
            signatureValid: signatureValid,
            allArchitecturesValid: allArchitecturesValid,
            hardenedRuntime: hardenedRuntime,
            secureTimestampPresent: secureTimestampPresent,
            gatekeeperNotarized: gatekeeperNotarized
        )
    }

    private func makeVerifier(
        paths: ExtractedReleasePaths,
        agentFacts: CandidateSignatureFacts? = nil,
        launcherFacts: CandidateSignatureFacts? = nil,
        agentIdentity: CompanionReleaseIdentity? = nil,
        launcherProtocolVersion: Int = 1
    ) -> ReleaseArchiveVerifier {
        ReleaseArchiveVerifier(
            signatureInspector: { application in
                if application == paths.agent {
                    return agentFacts ?? self.agentFacts()
                }
                XCTAssertEqual(application, paths.launcher)
                return launcherFacts ?? self.launcherFacts()
            },
            agentIdentityLoader: { application in
                XCTAssertEqual(application, paths.agent)
                return agentIdentity ?? self.manifestIdentity
            },
            launcherProtocolLoader: { application in
                XCTAssertEqual(application, paths.launcher)
                return launcherProtocolVersion
            }
        )
    }

    private func assertRejected(
        agentFacts: CandidateSignatureFacts? = nil,
        launcherFacts: CandidateSignatureFacts? = nil,
        agentIdentity: CompanionReleaseIdentity? = nil,
        launcherProtocolVersion: Int = 1,
        manifest: ReleaseManifestV1? = nil,
        installed: CompanionReleaseIdentity? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        try withExtractedRelease { paths in
            let verifier = makeVerifier(
                paths: paths,
                agentFacts: agentFacts,
                launcherFacts: launcherFacts,
                agentIdentity: agentIdentity,
                launcherProtocolVersion: launcherProtocolVersion
            )
            XCTAssertThrowsError(
                try verifier.verify(
                    extractedRoot: paths.staging,
                    manifest: manifest ?? self.manifest,
                    installed: installed ?? installedIdentity,
                    installedTeamIdentifier: teamIdentifier
                ),
                file: file,
                line: line
            ) { error in
                XCTAssertEqual(
                    error as? ReleaseArchiveVerificationError,
                    .untrustedArchive,
                    file: file,
                    line: line
                )
            }
        }
    }

    private func assertInstallerRejected(
        agentFacts: CandidateSignatureFacts? = nil,
        launcherFacts: CandidateSignatureFacts? = nil,
        agentIdentity: CompanionReleaseIdentity? = nil,
        launcherProtocolVersion: Int = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        try withExtractedRelease { paths in
            let verifier = makeVerifier(
                paths: paths,
                agentFacts: agentFacts,
                launcherFacts: launcherFacts,
                agentIdentity: agentIdentity,
                launcherProtocolVersion: launcherProtocolVersion
            )
            XCTAssertThrowsError(try verifier.verifyInstallerRelease(
                extractedRoot: paths.staging,
                expected: manifestIdentity,
                expectedTeamIdentifier: teamIdentifier
            ), file: file, line: line) { error in
                XCTAssertEqual(
                    error as? ReleaseArchiveVerificationError,
                    .untrustedArchive,
                    file: file,
                    line: line
                )
            }
        }
    }

    private func assertSubstitutionRejected(_ boundary: SubstitutionBoundary) throws {
        try withExtractedRelease { paths in
            let replaceRegularFile: (URL) throws -> Void = { url in
                try FileManager.default.removeItem(at: url)
                let replacement = url.lastPathComponent == "Info.plist" ? "other" : "changed"
                try Data(replacement.utf8).write(to: url)
            }
            let verifier = ReleaseArchiveVerifier(
                signatureInspector: { application in
                    if application == paths.agent { return self.agentFacts() }
                    if boundary == .agentPayloadDuringLauncherTrust {
                        try replaceRegularFile(paths.agentPayload)
                    }
                    return self.launcherFacts()
                },
                agentIdentityLoader: { _ in
                    if boundary == .launcherPayloadDuringAgentIdentity {
                        try replaceRegularFile(paths.launcherPayload)
                    } else if boundary == .agentInfoDuringAgentIdentity {
                        try replaceRegularFile(paths.agentInfoPlist)
                    }
                    return self.manifestIdentity
                },
                launcherProtocolLoader: { _ in
                    if boundary == .launcherInfoDuringProtocolLoad {
                        try replaceRegularFile(paths.launcherInfoPlist)
                    }
                    return 1
                }
            )

            XCTAssertThrowsError(try verifier.verify(
                extractedRoot: paths.staging,
                manifest: manifest,
                installed: installedIdentity,
                installedTeamIdentifier: teamIdentifier
            )) { error in
                XCTAssertEqual(error as? ReleaseArchiveVerificationError, .untrustedArchive)
            }
        }
    }

    private func withExtractedRelease<T>(_ body: (ExtractedReleasePaths) throws -> T) throws -> T {
        let staging = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-release-verifier-\(UUID().uuidString)", isDirectory: true)
        let release = staging.appendingPathComponent("Runtime Raiders Release", isDirectory: true)
        let agent = release.appendingPathComponent("Runtime Raiders Agent.app", isDirectory: true)
        let launcher = release.appendingPathComponent("Runtime Raiders Launcher.app", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        for application in [agent, launcher] {
            let contents = application.appendingPathComponent("Contents", isDirectory: true)
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            try Data("plist".utf8).write(to: contents.appendingPathComponent("Info.plist"))
            try Data("payload".utf8).write(to: contents.appendingPathComponent("payload"))
        }
        return try body(ExtractedReleasePaths(
            staging: staging,
            agent: agent,
            launcher: launcher
        ))
    }
}

private struct ExtractedReleasePaths {
    let staging: URL
    let agent: URL
    let launcher: URL

    var agentInfoPlist: URL { agent.appendingPathComponent("Contents/Info.plist") }
    var launcherInfoPlist: URL { launcher.appendingPathComponent("Contents/Info.plist") }
    var agentPayload: URL { agent.appendingPathComponent("Contents/payload") }
    var launcherPayload: URL { launcher.appendingPathComponent("Contents/payload") }
}

private enum SubstitutionBoundary {
    case agentPayloadDuringLauncherTrust
    case launcherPayloadDuringAgentIdentity
    case agentInfoDuringAgentIdentity
    case launcherInfoDuringProtocolLoad
}

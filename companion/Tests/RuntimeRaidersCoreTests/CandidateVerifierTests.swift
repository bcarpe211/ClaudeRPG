import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class CandidateVerifierTests: XCTestCase {
    func testRejectsInvalidSignature() throws {
        try assertRejected(facts: replacingValidFacts(signatureValid: false))
    }

    func testRejectsWrongBundleIdentifier() throws {
        try assertRejected(facts: replacingValidFacts(bundleIdentifier: "com.example.agent"))
    }

    func testRejectsTeamIdentifierThatDoesNotMatchVerifiedInstalledSelf() throws {
        try assertRejected(facts: replacingValidFacts(teamIdentifier: "OTHERTEAM"))
    }

    func testRejectsAnInvalidArchitectureSlice() throws {
        try assertRejected(facts: replacingValidFacts(allArchitecturesValid: false))
    }

    func testRejectsMissingHardenedRuntime() throws {
        try assertRejected(facts: replacingValidFacts(hardenedRuntime: false))
    }

    func testRejectsMissingSecureTimestamp() throws {
        try assertRejected(facts: replacingValidFacts(secureTimestampPresent: false))
    }

    func testRejectsMissingNotarizationOrGatekeeperAcceptance() throws {
        try assertRejected(facts: replacingValidFacts(gatekeeperNotarized: false))
    }

    func testRejectsEveryEmbeddedIdentityFieldThatDiffersFromManifest() throws {
        let invalidIdentities = [
            CompanionReleaseIdentity(
                releaseSequence: 3,
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
            CompanionReleaseIdentity(
                releaseSequence: manifest.releaseSequence,
                releaseSHA: manifest.releaseSHA,
                companionVersion: manifest.companionVersion,
                updateProtocolVersion: 1
            ),
        ]

        for identity in invalidIdentities {
            try assertRejected(identity: identity)
        }
    }

    func testValidCandidateReturnsTheManifestBoundReleaseIdentity() throws {
        let candidate = URL(fileURLWithPath: "/private/tmp/Runtime Raiders Agent.app", isDirectory: true)
        let verifier = CandidateVerifier(
            signatureInspector: { inspected in
                XCTAssertEqual(inspected, candidate)
                return self.validFacts
            },
            identityLoader: { inspected in
                XCTAssertEqual(inspected, candidate)
                return self.manifestIdentity
            }
        )

        XCTAssertEqual(
            try verifier.verify(
                candidate: candidate,
                manifest: manifest,
                installed: installedIdentity,
                installedTeamIdentifier: "REDLATTICE"
            ),
            manifestIdentity
        )
    }

    private var manifest: ReleaseManifestV1 {
        try! ReleaseManifestV1.decode(Data(#"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":2,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#.utf8))
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

    private var validFacts: CandidateSignatureFacts {
        CandidateSignatureFacts(
            bundleIdentifier: "com.redlattice.runtime-raiders-agent",
            teamIdentifier: "REDLATTICE",
            signatureValid: true,
            allArchitecturesValid: true,
            hardenedRuntime: true,
            secureTimestampPresent: true,
            gatekeeperNotarized: true
        )
    }

    private func replacingValidFacts(
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

    private func assertRejected(
        facts: CandidateSignatureFacts? = nil,
        identity: CompanionReleaseIdentity? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let verifier = CandidateVerifier(
            signatureInspector: { _ in facts ?? self.validFacts },
            identityLoader: { _ in identity ?? self.manifestIdentity }
        )
        XCTAssertThrowsError(
            try verifier.verify(
                candidate: URL(fileURLWithPath: "/private/tmp/Candidate.app"),
                manifest: manifest,
                installed: installedIdentity,
                installedTeamIdentifier: "REDLATTICE"
            ),
            file: file,
            line: line
        ) { error in
            XCTAssertEqual(error as? CandidateVerificationError, .untrustedCandidate, file: file, line: line)
        }
    }
}

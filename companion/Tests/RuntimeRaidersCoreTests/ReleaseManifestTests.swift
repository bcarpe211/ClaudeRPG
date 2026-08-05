import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ReleaseManifestTests: XCTestCase {
    func testManifestAcceptsOnlyTheExactVersionOneShape() throws {
        let manifest = try ReleaseManifestV1.decode(validManifestData())

        XCTAssertEqual(manifest.manifestVersion, 1)
        XCTAssertEqual(manifest.companionVersion, "0.2.1")
        XCTAssertEqual(manifest.releaseSequence, 2)
        XCTAssertEqual(manifest.releaseSHA, String(repeating: "a", count: 40))
        XCTAssertEqual(manifest.updateProtocolVersion, 1)
        XCTAssertEqual(manifest.zipSHA256, String(repeating: "b", count: 64))
        XCTAssertEqual(manifest.zipURL, ReleaseManifestV1.archiveURL)
    }

    func testManifestRejectsExtraKeysBooleansUnsafeIntegersAndBadStrings() throws {
        let invalidDocuments = [
            #"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip","extra":true}"#,
            #"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":true,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#,
            #"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":9007199254740992,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#,
            #"{"manifest_version":1,"companion_version":"0.2.1 bad","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#,
            #"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#,
            #"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":2,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#,
            #"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#,
            #"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://example.com/runtime-raiders-agent.zip"}"#,
        ]

        for document in invalidDocuments {
            XCTAssertThrowsError(try ReleaseManifestV1.decode(Data(document.utf8)))
        }
    }

    func testManifestPinsTheExactArchiveURL() throws {
        XCTAssertEqual(
            ReleaseManifestV1.manifestURL.absoluteString,
            "https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json"
        )
        XCTAssertEqual(
            ReleaseManifestV1.archiveURL.absoluteString,
            "https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"
        )
        XCTAssertEqual(try ReleaseManifestV1.decode(validManifestData()).zipURL, ReleaseManifestV1.archiveURL)
    }

    func testAvailabilityRequiresHigherSequenceAndMatchingProtocol() throws {
        let manifest = try ReleaseManifestV1.decode(validManifestData())
        let installed = CompanionReleaseIdentity(
            releaseSequence: 1,
            releaseSHA: String(repeating: "c", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 1
        )

        XCTAssertEqual(
            manifest.availability(from: installed),
            CompanionUpdateAvailability(
                installedVersion: "0.2.0",
                installedSequence: 1,
                availableVersion: "0.2.1",
                availableSequence: 2,
                updateCommand: "raiders update"
            )
        )
        XCTAssertNil(manifest.availability(from: CompanionReleaseIdentity(
            releaseSequence: 2,
            releaseSHA: String(repeating: "c", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 1
        )))
        XCTAssertNil(manifest.availability(from: CompanionReleaseIdentity(
            releaseSequence: 1,
            releaseSHA: String(repeating: "c", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 2
        )))
    }

    private func validManifestData() -> Data {
        Data(#"{"manifest_version":1,"companion_version":"0.2.1","release_sequence":2,"release_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","update_protocol_version":1,"zip_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}"#.utf8)
    }
}

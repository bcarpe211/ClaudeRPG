import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class CompanionReleaseTests: XCTestCase {
    func testInstalledCompanionVersionLoadsVersionOnlyBundle() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-version-only-bundle-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let bundle = try makeBundle(
            at: root.appendingPathComponent("Runtime Raiders Agent.app", isDirectory: true),
            infoDictionary: installedVersionInfoDictionary()
        )

        XCTAssertEqual(try InstalledCompanionVersion.load(from: bundle), "1.2.3")
    }

    func testInstalledCompanionVersionRejectsInvalidBundleMetadata() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-invalid-version-bundles-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let invalidDictionaries: [[String: Any]] = [
            replacingInstalledVersion("CFBundleIdentifier", with: "com.example.other"),
            installedVersionInfoDictionary(version: "1.2"),
            installedVersionInfoDictionary(version: "01.2.3"),
            replacingInstalledVersion("CFBundleVersion", with: "1.2.4"),
            removingInstalledVersion("CFBundleIdentifier"),
            removingInstalledVersion("CFBundleShortVersionString"),
            removingInstalledVersion("CFBundleVersion"),
        ]

        for (index, dictionary) in invalidDictionaries.enumerated() {
            let bundle = try makeBundle(
                at: root.appendingPathComponent("Invalid-\(index).app", isDirectory: true),
                infoDictionary: dictionary
            )
            XCTAssertThrowsError(
                try InstalledCompanionVersion.load(from: bundle),
                "accepted invalid bundle metadata at index \(index)"
            )
        }
    }

    func testReleaseIdentityRequiresExactNamedInfoDictionaryValues() throws {
        let expected = CompanionReleaseIdentity(
            releaseSequence: 1,
            releaseSHA: String(repeating: "a", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 1
        )

        XCTAssertEqual(try CompanionReleaseIdentity.parse(infoDictionary: validInfoDictionary()), expected)

        for invalid in [
            replacing("CFBundleIdentifier", with: "com.example.other"),
            replacing("CFBundleShortVersionString", with: "0.2.0 beta"),
            replacing("RuntimeRaidersReleaseSequence", with: true),
            replacing("RuntimeRaidersReleaseSequence", with: 9_007_199_254_740_992),
            replacing("RuntimeRaidersReleaseSHA", with: String(repeating: "A", count: 40)),
            replacing("RuntimeRaidersUpdateProtocolVersion", with: 3),
            removing("RuntimeRaidersReleaseSHA"),
        ] {
            XCTAssertThrowsError(try CompanionReleaseIdentity.parse(infoDictionary: invalid))
        }
    }

    func testReleaseIdentityConvertsOnlyValidatedFieldsToProtocolTwoReference() throws {
        var protocolTwo = validInfoDictionary()
        protocolTwo["RuntimeRaidersUpdateProtocolVersion"] = 2
        let identity = try CompanionReleaseIdentity.parse(infoDictionary: protocolTwo)
        let reference = ReleaseReference(
            releaseSequence: 1,
            releaseSHA: String(repeating: "a", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 2
        )
        XCTAssertEqual(try identity.releaseReference(), reference)
        XCTAssertEqual(try reference.companionReleaseIdentity(), identity)

        XCTAssertThrowsError(try CompanionReleaseIdentity(
            releaseSequence: 1,
            releaseSHA: String(repeating: "A", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 2
        ).releaseReference())
        XCTAssertThrowsError(try CompanionReleaseIdentity(
            releaseSequence: 1,
            releaseSHA: String(repeating: "a", count: 40),
            companionVersion: "0.2.0",
            updateProtocolVersion: 1
        ).releaseReference())
    }

    func testSealedBundleIdentityLoadsExactMetadataAndInvalidBundleFailsClosed() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-release-bundle-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let validBundle = try makeBundle(
            at: root.appendingPathComponent("Valid.bundle", isDirectory: true),
            infoDictionary: validInfoDictionary()
        )

        XCTAssertEqual(
            try CompanionReleaseIdentity.load(from: validBundle),
            CompanionReleaseIdentity(
                releaseSequence: 1,
                releaseSHA: String(repeating: "a", count: 40),
                companionVersion: "0.2.0",
                updateProtocolVersion: 1
            )
        )

        let invalidBundle = try makeBundle(
            at: root.appendingPathComponent("Invalid.bundle", isDirectory: true),
            infoDictionary: removing("RuntimeRaidersReleaseSHA")
        )
        XCTAssertThrowsError(try CompanionReleaseIdentity.load(from: invalidBundle))
    }

    func testBundleIdentityReloadsMetadataAfterSwapAtSamePath() throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("rr-release-swap-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let installedURL = root.appendingPathComponent("Current.bundle", isDirectory: true)
        let installedBundle = try makeBundle(
            at: installedURL,
            infoDictionary: validInfoDictionary()
        )
        XCTAssertEqual(try CompanionReleaseIdentity.load(from: installedBundle).releaseSequence, 1)

        var replacementInfo = validInfoDictionary()
        replacementInfo["CFBundleShortVersionString"] = "0.2.1"
        replacementInfo["RuntimeRaidersReleaseSequence"] = 2
        replacementInfo["RuntimeRaidersReleaseSHA"] = String(repeating: "b", count: 40)
        let replacementBundle = try makeBundle(
            at: root.appendingPathComponent("Replacement.bundle", isDirectory: true),
            infoDictionary: replacementInfo
        )
        try FileManager.default.moveItem(
            at: installedURL,
            to: root.appendingPathComponent("Prior.bundle", isDirectory: true)
        )
        try FileManager.default.moveItem(at: replacementBundle.bundleURL, to: installedURL)

        let bundleAtReusedPath = try XCTUnwrap(Bundle(url: installedURL))
        XCTAssertEqual(
            try CompanionReleaseIdentity.load(from: bundleAtReusedPath),
            CompanionReleaseIdentity(
                releaseSequence: 2,
                releaseSHA: String(repeating: "b", count: 40),
                companionVersion: "0.2.1",
                updateProtocolVersion: 1
            )
        )
    }

    func testLaunchAgentTemplateRunsStableAgentExecutableAsDaemon() throws {
        let data = try Data(contentsOf: packageDirectory.appendingPathComponent(
            "packaging/com.redlattice.runtime-raiders-agent.plist.template",
            isDirectory: false
        ))
        let plist = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )

        XCTAssertEqual(
            plist["ProgramArguments"] as? [String],
            ["__RUNTIME_RAIDERS_AGENT_EXECUTABLE__", "daemon"]
        )
    }

    private var packageDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func validInfoDictionary() -> [String: Any] {
        [
            "CFBundleIdentifier": "com.redlattice.runtime-raiders-agent",
            "CFBundleShortVersionString": "0.2.0",
            "RuntimeRaidersReleaseSequence": 1,
            "RuntimeRaidersReleaseSHA": String(repeating: "a", count: 40),
            "RuntimeRaidersUpdateProtocolVersion": 1,
        ]
    }

    private func installedVersionInfoDictionary(version: String = "1.2.3") -> [String: Any] {
        [
            "CFBundleIdentifier": "com.redlattice.runtime-raiders-agent",
            "CFBundleShortVersionString": version,
            "CFBundleVersion": version,
        ]
    }

    private func replacingInstalledVersion(_ key: String, with value: Any) -> [String: Any] {
        var dictionary = installedVersionInfoDictionary()
        dictionary[key] = value
        return dictionary
    }

    private func removingInstalledVersion(_ key: String) -> [String: Any] {
        var dictionary = installedVersionInfoDictionary()
        dictionary.removeValue(forKey: key)
        return dictionary
    }

    private func replacing(_ key: String, with value: Any) -> [String: Any] {
        var dictionary = validInfoDictionary()
        dictionary[key] = value
        return dictionary
    }

    private func removing(_ key: String) -> [String: Any] {
        var dictionary = validInfoDictionary()
        dictionary.removeValue(forKey: key)
        return dictionary
    }

    private func makeBundle(
        at bundleURL: URL,
        infoDictionary: [String: Any]
    ) throws -> Bundle {
        let contents = bundleURL.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(
            fromPropertyList: infoDictionary,
            format: .xml,
            options: 0
        )
        try data.write(to: contents.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: bundleURL))
    }
}

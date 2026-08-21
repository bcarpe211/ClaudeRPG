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

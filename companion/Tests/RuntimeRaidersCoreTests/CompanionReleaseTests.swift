import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class CompanionReleaseTests: XCTestCase {
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
            replacing("RuntimeRaidersUpdateProtocolVersion", with: 2),
            removing("RuntimeRaidersReleaseSHA"),
        ] {
            XCTAssertThrowsError(try CompanionReleaseIdentity.parse(infoDictionary: invalid))
        }
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
}

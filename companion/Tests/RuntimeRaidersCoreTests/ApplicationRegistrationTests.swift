import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ApplicationRegistrationTests: XCTestCase {
    func testRegistrationForceUpdatesTheExactInstalledBundleURL() throws {
        let expectedURL = URL(
            fileURLWithPath: "/Users/example/Library/Application Support/Runtime Raiders/Runtime Raiders.app",
            isDirectory: true
        )
        var capturedURL: URL?
        var capturedUpdate = false
        let registration = ApplicationRegistration { url, update in
            capturedURL = url
            capturedUpdate = update
            return 0
        }

        try registration.register(bundleURL: expectedURL)

        XCTAssertEqual(capturedURL, expectedURL)
        XCTAssertTrue(capturedUpdate)
    }

    func testRegistrationReportsTheLaunchServicesFailureWithoutRetrying() {
        var attempts = 0
        let registration = ApplicationRegistration { _, _ in
            attempts += 1
            return -10811
        }

        XCTAssertThrowsError(try registration.register(
            bundleURL: URL(fileURLWithPath: "/private/tmp/Runtime Raiders.app")
        )) { error in
            XCTAssertEqual(error as? ApplicationRegistrationError, .failed(-10811))
        }
        XCTAssertEqual(attempts, 1)
    }
}

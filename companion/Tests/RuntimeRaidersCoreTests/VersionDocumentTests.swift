import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class VersionDocumentTests: XCTestCase {
    func testDecodesExactlyOneCanonicalVersionField() throws {
        XCTAssertEqual(
            try VersionDocument.decode(Data(#"{"version":"12.3.45"}"#.utf8)),
            VersionDocument(version: "12.3.45")
        )
    }

    func testRejectsAnythingOtherThanOneCanonicalVersionField() {
        let invalidDocuments = [
            #"{}"#,
            #"{"version":"0.4.0","extra":true}"#,
            #"{"version":"0.4.0","version":"0.4.0"}"#,
            #"{"ver\u0073ion":"0.4.0"}"#,
            #"{"Version":"0.4.0"}"#,
            #"{"version":" 0.4.0"}"#,
            #"{"version":"v0.4.0"}"#,
            #"{"version":"0.4.0-beta"}"#,
            #"{"version":"0.4.0+build"}"#,
            #"{"version":"-1.0.0"}"#,
            #"{"version":"9223372036854775808.0.0"}"#,
        ]

        for document in invalidDocuments {
            XCTAssertThrowsError(try VersionDocument.decode(Data(document.utf8)), document)
        }
    }

    func testComparesVersionComponentsNumerically() throws {
        XCTAssertLessThan(try SemanticVersion("0.4.9"), try SemanticVersion("0.4.10"))
        XCTAssertLessThan(try SemanticVersion("2.0.0"), try SemanticVersion("12.0.0"))
    }
}

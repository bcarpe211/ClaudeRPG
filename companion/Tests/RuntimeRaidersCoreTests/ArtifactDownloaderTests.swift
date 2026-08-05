import CryptoKit
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class ArtifactDownloaderTests: XCTestCase {
    override func tearDown() {
        DownloadURLProtocol.reset()
        super.tearDown()
    }

    func testSuccessfulDownloadUsesExactHTTPSRequestAndReturnsReceipt() async throws {
        let requestBox = RequestBox()
        DownloadURLProtocol.install { protocolInstance in
            requestBox.set(protocolInstance.request)
            protocolInstance.succeed(statusCode: 200, body: Data("abc".utf8))
        }

        try await withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("agent.zip")
            let receipt = try await makeDownloader().download(
                from: ReleaseManifestV1.archiveURL,
                to: destination,
                expectedSHA256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            )

            XCTAssertEqual(requestBox.value?.url, ReleaseManifestV1.archiveURL)
            XCTAssertEqual(requestBox.value?.httpMethod, "GET")
            XCTAssertEqual(requestBox.value?.cachePolicy, .reloadIgnoringLocalCacheData)
            XCTAssertEqual(receipt, DownloadReceipt(
                byteCount: 3,
                sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            ))
            XCTAssertEqual(try Data(contentsOf: destination), Data("abc".utf8))
            let permissions = try XCTUnwrap(
                FileManager.default.attributesOfItem(atPath: destination.path)[.posixPermissions] as? NSNumber
            )
            XCTAssertEqual(permissions.intValue, 0o600)
        }
    }

    func testRejectsEverySourceOtherThanPinnedHTTPSArchiveWithoutStartingTransport() async throws {
        let callCount = LockedInteger()
        DownloadURLProtocol.install { protocolInstance in
            callCount.increment()
            protocolInstance.succeed(statusCode: 200, body: Data())
        }

        try await withTemporaryDirectory { directory in
            for (index, source) in [
                "http://raiders.redlattice.com/downloads/runtime-raiders-agent.zip",
                "https://raiders.redlattice.com.evil.test/downloads/runtime-raiders-agent.zip",
                "https://raiders.redlattice.com/downloads/other.zip",
                "https://raiders.redlattice.com:444/downloads/runtime-raiders-agent.zip",
            ].enumerated() {
                await XCTAssertThrowsErrorAsync(
                    try await makeDownloader().download(
                        from: XCTUnwrap(URL(string: source)),
                        to: directory.appendingPathComponent("artifact-\(index)"),
                        expectedSHA256: String(repeating: "0", count: 64)
                    )
                ) { error in
                    XCTAssertEqual(error as? ArtifactDownloadError, .invalidSource)
                }
            }
            XCTAssertEqual(callCount.value, 0)
        }
    }

    func testRedirectIsRefusedAndPartialDestinationIsRemoved() async throws {
        DownloadURLProtocol.install { protocolInstance in
            protocolInstance.redirect(to: URL(string: "https://example.test/redirected.zip")!)
        }

        try await withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("agent.zip")
            await XCTAssertThrowsErrorAsync(
                try await makeDownloader().download(
                    from: ReleaseManifestV1.archiveURL,
                    to: destination,
                    expectedSHA256: String(repeating: "0", count: 64)
                )
            ) { error in
                XCTAssertEqual(error as? ArtifactDownloadError, .redirected)
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        }
    }

    func testNon200ResponseFailsClosedAndRemovesDestination() async throws {
        DownloadURLProtocol.install { protocolInstance in
            protocolInstance.succeed(statusCode: 503, body: Data("unavailable".utf8))
        }

        try await assertDownloadFailsAndCleansUp(expectedError: .httpStatus(503))
    }

    func testContentLengthAbove128MiBFailsBeforeWritingAndRemovesDestination() async throws {
        DownloadURLProtocol.install { protocolInstance in
            protocolInstance.succeed(
                statusCode: 200,
                headers: ["Content-Length": "134217729"],
                body: Data([0])
            )
        }

        try await assertDownloadFailsAndCleansUp(expectedError: .tooLarge)
    }

    func testStreamingOverflowWithoutContentLengthCancelsAndRemovesDestination() async throws {
        DownloadURLProtocol.install { protocolInstance in
            protocolInstance.succeed(statusCode: 200, body: Data(repeating: 0x61, count: 5))
        }

        try await withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("agent.zip")
            let downloader = ArtifactDownloader(
                protocolClasses: [DownloadURLProtocol.self],
                requestTimeout: 0.1,
                resourceTimeout: 1,
                maximumByteCount: 4
            )
            await XCTAssertThrowsErrorAsync(
                try await downloader.download(
                    from: ReleaseManifestV1.archiveURL,
                    to: destination,
                    expectedSHA256: String(repeating: "0", count: 64)
                )
            ) { error in
                XCTAssertEqual(error as? ArtifactDownloadError, .tooLarge)
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        }
    }

    func testTimeoutRemovesPartialDestination() async throws {
        DownloadURLProtocol.install { protocolInstance in
            protocolInstance.fail(after: Data("partial".utf8), with: URLError(.timedOut))
        }

        try await assertDownloadFailsAndCleansUp(expectedError: .timedOut)
    }

    func testTransportFailureAfterBytesRemovesPartialDestination() async throws {
        DownloadURLProtocol.install { protocolInstance in
            protocolInstance.fail(after: Data("partial".utf8), with: URLError(.networkConnectionLost))
        }

        try await assertDownloadFailsAndCleansUp(expectedError: .transport)
    }

    func testDigestMismatchRemovesDestination() async throws {
        DownloadURLProtocol.install { protocolInstance in
            protocolInstance.succeed(statusCode: 200, body: Data("wrong".utf8))
        }

        try await assertDownloadFailsAndCleansUp(expectedError: .digestMismatch)
    }

    func testDestinationSymlinkIsRefusedWithoutTouchingTarget() async throws {
        let callCount = LockedInteger()
        DownloadURLProtocol.install { protocolInstance in
            callCount.increment()
            protocolInstance.succeed(statusCode: 200, body: Data())
        }

        try await withTemporaryDirectory { directory in
            let target = directory.appendingPathComponent("target")
            let destination = directory.appendingPathComponent("agent.zip")
            try Data("keep".utf8).write(to: target)
            try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: target)

            await XCTAssertThrowsErrorAsync(
                try await makeDownloader().download(
                    from: ReleaseManifestV1.archiveURL,
                    to: destination,
                    expectedSHA256: String(repeating: "0", count: 64)
                )
            ) { error in
                XCTAssertEqual(error as? ArtifactDownloadError, .unsafeDestination)
            }
            XCTAssertEqual(try Data(contentsOf: target), Data("keep".utf8))
            XCTAssertEqual(callCount.value, 0)
        }
    }

    private func makeDownloader() -> ArtifactDownloader {
        ArtifactDownloader(
            protocolClasses: [DownloadURLProtocol.self],
            requestTimeout: 0.1,
            resourceTimeout: 1
        )
    }

    private func assertDownloadFailsAndCleansUp(expectedError: ArtifactDownloadError) async throws {
        try await withTemporaryDirectory { directory in
            let destination = directory.appendingPathComponent("agent.zip")
            await XCTAssertThrowsErrorAsync(
                try await makeDownloader().download(
                    from: ReleaseManifestV1.archiveURL,
                    to: destination,
                    expectedSHA256: String(repeating: "0", count: 64)
                )
            ) { error in
                XCTAssertEqual(error as? ArtifactDownloadError, expectedError)
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        }
    }
}

private final class DownloadURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (DownloadURLProtocol) -> Void
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: Handler?

    static func install(_ newHandler: @escaping Handler) {
        lock.withLock { handler = newHandler }
    }

    static func reset() {
        lock.withLock { handler = nil }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let installed = Self.lock.withLock { Self.handler }
        installed?(self)
    }

    override func stopLoading() {}

    func succeed(statusCode: Int, headers: [String: String] = [:], body: Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
        client?.urlProtocolDidFinishLoading(self)
    }

    func fail(after partial: Data, with error: Error) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: partial)
        client?.urlProtocol(self, didFailWithError: error)
    }

    func redirect(to url: URL) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 302,
            httpVersion: "HTTP/1.1",
            headerFields: ["Location": url.absoluteString]
        )!
        client?.urlProtocol(
            self,
            wasRedirectedTo: URLRequest(url: url),
            redirectResponse: response
        )
    }
}

private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: URLRequest?
    var value: URLRequest? { lock.withLock { storage } }
    func set(_ value: URLRequest) { lock.withLock { storage = value } }
}

private final class LockedInteger: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0
    var value: Int { lock.withLock { storage } }
    func increment() { lock.withLock { storage += 1 } }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("expected error")
    } catch {
        errorHandler(error)
    }
}

private func withTemporaryDirectory<T>(
    _ body: (URL) async throws -> T
) async throws -> T {
    let directory = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
        .appendingPathComponent("rr-artifact-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    return try await body(directory)
}

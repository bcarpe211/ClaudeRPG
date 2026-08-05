import CryptoKit
import Darwin
import Foundation

public struct DownloadReceipt: Equatable, Sendable {
    public let byteCount: Int64
    public let sha256: String

    public init(byteCount: Int64, sha256: String) {
        self.byteCount = byteCount
        self.sha256 = sha256
    }
}

public enum ArtifactDownloadError: Error, Equatable {
    case invalidSource
    case unsafeDestination
    case redirected
    case httpStatus(Int)
    case tooLarge
    case timedOut
    case transport
    case digestMismatch
}

public struct ArtifactDownloader: Sendable {
    public static let maximumByteCount: Int64 = 128 * 1_024 * 1_024

    private let protocolClasses: [AnyClass]?
    private let requestTimeout: TimeInterval
    private let resourceTimeout: TimeInterval
    private let maximumByteCount: Int64

    public init() {
        protocolClasses = nil
        requestTimeout = 10
        resourceTimeout = 120
        maximumByteCount = Self.maximumByteCount
    }

    init(
        protocolClasses: [AnyClass],
        requestTimeout: TimeInterval = 10,
        resourceTimeout: TimeInterval = 120,
        maximumByteCount: Int64 = ArtifactDownloader.maximumByteCount
    ) {
        self.protocolClasses = protocolClasses
        self.requestTimeout = requestTimeout
        self.resourceTimeout = resourceTimeout
        self.maximumByteCount = maximumByteCount
    }

    public func download(
        from source: URL,
        to destination: URL,
        expectedSHA256: String
    ) async throws -> DownloadReceipt {
        guard source == ReleaseManifestV1.archiveURL,
              source.scheme == "https",
              source.user == nil,
              source.password == nil,
              source.fragment == nil else {
            throw ArtifactDownloadError.invalidSource
        }

        let descriptor = destination.path.withCString {
            Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        }
        guard descriptor >= 0 else {
            throw ArtifactDownloadError.unsafeDestination
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = resourceTimeout
        if let protocolClasses {
            configuration.protocolClasses = protocolClasses
        }

        var request = URLRequest(
            url: source,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: requestTimeout
        )
        request.httpMethod = "GET"

        return try await withCheckedThrowingContinuation { continuation in
            let delegate = ArtifactDownloadSessionDelegate(
                descriptor: descriptor,
                destination: destination,
                expectedSHA256: expectedSHA256,
                maximumByteCount: maximumByteCount,
                continuation: continuation
            )
            let delegateQueue = OperationQueue()
            delegateQueue.maxConcurrentOperationCount = 1
            delegateQueue.qualityOfService = .utility
            let session = URLSession(
                configuration: configuration,
                delegate: delegate,
                delegateQueue: delegateQueue
            )
            delegate.session = session
            session.dataTask(with: request).resume()
        }
    }
}

private final class ArtifactDownloadSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let descriptor: Int32
    private let destination: URL
    private let expectedSHA256: String
    private let maximumByteCount: Int64
    private let continuation: CheckedContinuation<DownloadReceipt, Error>
    private var hasher = SHA256()
    private var byteCount: Int64 = 0
    private var failure: ArtifactDownloadError?
    private var completed = false
    var session: URLSession?

    init(
        descriptor: Int32,
        destination: URL,
        expectedSHA256: String,
        maximumByteCount: Int64,
        continuation: CheckedContinuation<DownloadReceipt, Error>
    ) {
        self.descriptor = descriptor
        self.destination = destination
        self.expectedSHA256 = expectedSHA256
        self.maximumByteCount = maximumByteCount
        self.continuation = continuation
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        failure = .redirected
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard failure == nil else {
            completionHandler(.cancel)
            return
        }
        guard let http = response as? HTTPURLResponse else {
            failure = .transport
            completionHandler(.cancel)
            return
        }
        guard http.statusCode == 200 else {
            failure = .httpStatus(http.statusCode)
            completionHandler(.cancel)
            return
        }
        if response.expectedContentLength > maximumByteCount {
            failure = .tooLarge
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        guard byteCount <= maximumByteCount - Int64(data.count) else {
            failure = .tooLarge
            dataTask.cancel()
            return
        }
        guard writeAll(data) else {
            failure = .transport
            dataTask.cancel()
            return
        }
        hasher.update(data: data)
        byteCount += Int64(data.count)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !completed else { return }
        completed = true
        _ = Darwin.close(descriptor)

        let result: Result<DownloadReceipt, Error>
        if let failure {
            result = .failure(failure)
        } else if let urlError = error as? URLError, urlError.code == .timedOut {
            result = .failure(ArtifactDownloadError.timedOut)
        } else if error != nil {
            result = .failure(ArtifactDownloadError.transport)
        } else {
            let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            if digest == expectedSHA256 {
                result = .success(DownloadReceipt(byteCount: byteCount, sha256: digest))
            } else {
                result = .failure(ArtifactDownloadError.digestMismatch)
            }
        }

        if case .failure = result {
            destination.path.withCString { _ = Darwin.unlink($0) }
        }
        self.session?.finishTasksAndInvalidate()
        self.session = nil
        continuation.resume(with: result)
    }

    private func writeAll(_ data: Data) -> Bool {
        data.withUnsafeBytes { rawBuffer in
            guard var base = rawBuffer.baseAddress else { return true }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let written = Darwin.write(descriptor, base, remaining)
                if written < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                guard written > 0 else { return false }
                remaining -= written
                base = base.advanced(by: written)
            }
            return true
        }
    }
}

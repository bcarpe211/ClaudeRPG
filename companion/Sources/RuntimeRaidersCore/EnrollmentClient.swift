import Foundation
import Security

public enum EnrollmentClientError: Error, Equatable, CustomStringConvertible,
    CustomDebugStringConvertible {
    case invalidConfiguration
    case invalidRequest
    case corruptResponse
    case transportFailure
    case secureRandomFailure

    public var description: String {
        switch self {
        case .invalidConfiguration:
            "enrollment client configuration is invalid"
        case .invalidRequest:
            "enrollment lifecycle request is invalid"
        case .corruptResponse:
            "enrollment lifecycle response is invalid"
        case .transportFailure:
            "enrollment lifecycle transport failed"
        case .secureRandomFailure:
            "secure credential generation failed"
        }
    }

    public var debugDescription: String { description }
}

public struct ReplacementMaterial: Equatable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible {
    public let operationID: UUID
    public let deviceID: UUID
    public let deviceToken: String

    public init(operationID: UUID, deviceID: UUID, deviceToken: String) {
        self.operationID = operationID
        self.deviceID = deviceID
        self.deviceToken = deviceToken
    }

    public var description: String {
        "ReplacementMaterial(credentials: <redacted>)"
    }

    public var debugDescription: String { description }
}

public struct RecoveredEnrollment: Equatable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible {
    public let deviceID: String
    public let dedupeSecret: Data
    public let serverURL: URL
    public let cutoverAtMS: Int64
    public let enabledSurfaces: [RunSurface]

    init(
        deviceID: String,
        dedupeSecret: Data,
        serverURL: URL,
        cutoverAtMS: Int64,
        enabledSurfaces: [RunSurface]
    ) {
        self.deviceID = deviceID
        self.dedupeSecret = dedupeSecret
        self.serverURL = serverURL
        self.cutoverAtMS = cutoverAtMS
        self.enabledSurfaces = enabledSurfaces
    }

    public var description: String {
        "RecoveredEnrollment(surfaces: \(enabledSurfaces.count), credentials: <redacted>)"
    }

    public var debugDescription: String { description }
}

public enum ReplacementHTTPResult: Equatable, Sendable, CustomStringConvertible,
    CustomDebugStringConvertible {
    case committed(RecoveredEnrollment)
    case invalidEnrollment
    case unauthorized
    case conflict
    case ambiguous

    public var description: String {
        switch self {
        case .committed:
            "ReplacementHTTPResult.committed(credentials: <redacted>)"
        case .invalidEnrollment:
            "ReplacementHTTPResult.invalidEnrollment"
        case .unauthorized:
            "ReplacementHTTPResult.unauthorized"
        case .conflict:
            "ReplacementHTTPResult.conflict"
        case .ambiguous:
            "ReplacementHTTPResult.ambiguous"
        }
    }

    public var debugDescription: String { description }
}

public struct SecureCredentialGenerator: Sendable {
    public typealias UUIDGenerator = @Sendable () -> UUID

    private let uuidGenerator: UUIDGenerator

    public init(uuidGenerator: @escaping UUIDGenerator = { UUID() }) {
        self.uuidGenerator = uuidGenerator
    }

    public func generate() throws -> ReplacementMaterial {
        let operationID = uuidGenerator()
        let deviceID = uuidGenerator()
        guard operationID != deviceID else {
            throw EnrollmentClientError.secureRandomFailure
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw EnrollmentClientError.secureRandomFailure
        }
        let token = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        guard isExactBase64URLCredential(token) else {
            throw EnrollmentClientError.secureRandomFailure
        }
        return ReplacementMaterial(
            operationID: operationID,
            deviceID: deviceID,
            deviceToken: token
        )
    }
}

public struct EnrollmentClient: Sendable {
    public typealias Transport = @Sendable (URLRequest) throws -> UploadHTTPResponse

    static let maximumResponseBytes = 16 * 1_024

    private let origin: URL
    private let allowsTestOrigin: Bool
    private let transport: Transport

    public init(origin: URL, transport: @escaping Transport) throws {
        try self.init(origin: origin, allowsTestOrigin: false, transport: transport)
    }

    init(
        origin: URL,
        allowsTestOrigin: Bool,
        transport: @escaping Transport
    ) throws {
        guard Self.validOrigin(origin, allowsTestOrigin: allowsTestOrigin) else {
            throw EnrollmentClientError.invalidConfiguration
        }
        self.origin = origin
        self.allowsTestOrigin = allowsTestOrigin
        self.transport = transport
    }

    public func replace(
        oldToken: String,
        code: String,
        material: ReplacementMaterial,
        companionVersion: String
    ) throws -> ReplacementHTTPResult {
        guard isExactBase64URLCredential(oldToken),
              isExactBase64URLCredential(code),
              isExactBase64URLCredential(material.deviceToken),
              material.operationID != material.deviceID,
              (1...100).contains(companionVersion.utf8.count) else {
            throw EnrollmentClientError.invalidRequest
        }
        let body: [String: Any] = [
            "code": code,
            "operation_id": material.operationID.uuidString.lowercased(),
            "replacement_device_id": material.deviceID.uuidString.lowercased(),
            "replacement_device_token": material.deviceToken,
            "companion_version": companionVersion,
        ]
        guard JSONSerialization.isValidJSONObject(body),
              let encoded = try? JSONSerialization.data(
                withJSONObject: body,
                options: [.sortedKeys, .withoutEscapingSlashes]
              ) else {
            throw EnrollmentClientError.invalidRequest
        }
        var request = request(path: "api/raiders/re-enroll", method: "POST", token: oldToken)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = encoded

        let response: UploadHTTPResponse
        do {
            response = try transport(request)
        } catch {
            return .ambiguous
        }
        if (500...599).contains(response.statusCode) { return .ambiguous }
        try Self.requireBounded(response.body)
        switch response.statusCode {
        case 200, 201:
            let configuration = try decodeConfiguration(response.body)
            guard configuration.deviceID == material.deviceID.uuidString.lowercased() else {
                throw EnrollmentClientError.corruptResponse
            }
            return .committed(configuration)
        case 401:
            switch try Self.decodeReason(response.body) {
            case "invalid_enrollment": return .invalidEnrollment
            case "unauthorized": return .unauthorized
            default: throw EnrollmentClientError.corruptResponse
            }
        case 409:
            guard try Self.decodeReason(response.body) == "replacement_conflict" else {
                throw EnrollmentClientError.corruptResponse
            }
            return .conflict
        default:
            throw EnrollmentClientError.corruptResponse
        }
    }

    public func recover(token: String) throws -> RecoveredEnrollment? {
        guard isExactBase64URLCredential(token) else {
            throw EnrollmentClientError.invalidRequest
        }
        let request = request(
            path: "api/raiders/enrollment-config",
            method: "GET",
            token: token
        )
        let response: UploadHTTPResponse
        do {
            response = try transport(request)
        } catch {
            throw EnrollmentClientError.transportFailure
        }
        try Self.requireBounded(response.body)
        switch response.statusCode {
        case 200:
            return try decodeConfiguration(response.body)
        case 401:
            guard try Self.decodeReason(response.body) == "unauthorized" else {
                throw EnrollmentClientError.corruptResponse
            }
            return nil
        default:
            throw EnrollmentClientError.corruptResponse
        }
    }

    public func revoke(token: String) throws -> Bool {
        guard isExactBase64URLCredential(token) else {
            throw EnrollmentClientError.invalidRequest
        }
        var request = request(
            path: "api/raiders/devices/revoke-current",
            method: "POST",
            token: token
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let response: UploadHTTPResponse
        do {
            response = try transport(request)
        } catch {
            throw EnrollmentClientError.transportFailure
        }
        try Self.requireBounded(response.body)
        switch response.statusCode {
        case 200:
            let object = try Self.strictObject(response.body, keys: ["revoked"])
            guard let revoked = object["revoked"] as? NSNumber,
                  CFGetTypeID(revoked) == CFBooleanGetTypeID(),
                  revoked.boolValue else {
                throw EnrollmentClientError.corruptResponse
            }
            return true
        case 401:
            guard try Self.decodeReason(response.body) == "unauthorized" else {
                throw EnrollmentClientError.corruptResponse
            }
            return false
        default:
            throw EnrollmentClientError.corruptResponse
        }
    }

    private func request(path: String, method: String, token: String) -> URLRequest {
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 2
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func decodeConfiguration(_ body: Data) throws -> RecoveredEnrollment {
        let keys: Set<String> = [
            "device_id", "dedupe_secret", "server_url", "cutover_at", "enabled_surfaces",
        ]
        let object = try Self.strictObject(body, keys: keys)
        guard let deviceID = object["device_id"] as? String,
              Self.isCanonicalUUID(deviceID),
              let encodedSecret = object["dedupe_secret"] as? String,
              let dedupeSecret = Self.decodeLowerHex(encodedSecret),
              dedupeSecret.count == 32,
              let serverURLString = object["server_url"] as? String,
              let serverURL = URL(string: serverURLString),
              Self.validOrigin(serverURL, allowsTestOrigin: allowsTestOrigin),
              let number = object["cutover_at"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero) == number.doubleValue,
              (0...9_007_199_254_740_991).contains(number.doubleValue),
              let rawSurfaces = object["enabled_surfaces"] as? [Any],
              !rawSurfaces.isEmpty else {
            throw EnrollmentClientError.corruptResponse
        }
        let cutoverAtMS = Int64(number.doubleValue)
        var enabledSurfaces: [RunSurface] = []
        for rawSurface in rawSurfaces {
            guard let value = rawSurface as? String,
                  let surface = RunSurface(rawValue: value),
                  surface == .codexCLI || surface == .codexDesktop,
                  !enabledSurfaces.contains(surface) else {
                throw EnrollmentClientError.corruptResponse
            }
            enabledSurfaces.append(surface)
        }
        return RecoveredEnrollment(
            deviceID: deviceID,
            dedupeSecret: dedupeSecret,
            serverURL: serverURL,
            cutoverAtMS: cutoverAtMS,
            enabledSurfaces: enabledSurfaces
        )
    }

    private static func decodeReason(_ body: Data) throws -> String {
        let object = try strictObject(body, keys: ["reason"])
        guard let reason = object["reason"] as? String else {
            throw EnrollmentClientError.corruptResponse
        }
        return reason
    }

    private static func strictObject(
        _ body: Data,
        keys expectedKeys: Set<String>
    ) throws -> [String: Any] {
        try requireBounded(body)
        var scanner = EnrollmentResponseJSONKeys(data: body)
        guard let scannedKeys = try? scanner.parse(),
              scannedKeys == expectedKeys,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              Set(object.keys) == expectedKeys else {
            throw EnrollmentClientError.corruptResponse
        }
        return object
    }

    private static func requireBounded(_ body: Data) throws {
        guard !body.isEmpty, body.count <= maximumResponseBytes else {
            throw EnrollmentClientError.corruptResponse
        }
    }

    private static func validOrigin(_ url: URL, allowsTestOrigin: Bool) -> Bool {
        if url.absoluteString == "https://raiders.redlattice.com" { return true }
        guard allowsTestOrigin,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "http" || components.scheme == "https",
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            return false
        }
        return true
    }

    private static func isCanonicalUUID(_ value: String) -> Bool {
        value.utf8.count == 36
            && UUID(uuidString: value)?.uuidString.lowercased() == value
    }

    private static func decodeLowerHex(_ value: String) -> Data? {
        let bytes = Array(value.utf8)
        guard bytes.count == 64 else { return nil }
        var decoded = Data(capacity: 32)
        for index in stride(from: 0, to: bytes.count, by: 2) {
            guard let high = lowerHexNibble(bytes[index]),
                  let low = lowerHexNibble(bytes[index + 1]) else { return nil }
            decoded.append((high << 4) | low)
        }
        return decoded
    }

    private static func lowerHexNibble(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 0x30...0x39: byte - 0x30
        case 0x61...0x66: byte - 0x61 + 10
        default: nil
        }
    }
}

private struct EnrollmentResponseJSONKeys {
    private let bytes: [UInt8]
    private var index = 0

    init(data: Data) {
        bytes = Array(data)
    }

    mutating func parse() throws -> Set<String> {
        skipWhitespace()
        guard consume(0x7b) else { throw EnrollmentClientError.corruptResponse }
        skipWhitespace()
        var keys = Set<String>()
        if consume(0x7d) {
            skipWhitespace()
            guard index == bytes.count else { throw EnrollmentClientError.corruptResponse }
            return keys
        }
        while true {
            let key = try parseString()
            guard keys.insert(key).inserted else {
                throw EnrollmentClientError.corruptResponse
            }
            skipWhitespace()
            guard consume(0x3a) else { throw EnrollmentClientError.corruptResponse }
            skipWhitespace()
            try skipValue(depth: 0)
            skipWhitespace()
            if consume(0x7d) { break }
            guard consume(0x2c) else { throw EnrollmentClientError.corruptResponse }
            skipWhitespace()
        }
        skipWhitespace()
        guard index == bytes.count else { throw EnrollmentClientError.corruptResponse }
        return keys
    }

    private mutating func skipValue(depth: Int) throws {
        guard depth <= 32, index < bytes.count else {
            throw EnrollmentClientError.corruptResponse
        }
        switch bytes[index] {
        case 0x22:
            _ = try parseString()
        case 0x7b:
            index += 1
            skipWhitespace()
            if consume(0x7d) { return }
            while true {
                _ = try parseString()
                skipWhitespace()
                guard consume(0x3a) else { throw EnrollmentClientError.corruptResponse }
                skipWhitespace()
                try skipValue(depth: depth + 1)
                skipWhitespace()
                if consume(0x7d) { return }
                guard consume(0x2c) else { throw EnrollmentClientError.corruptResponse }
                skipWhitespace()
            }
        case 0x5b:
            index += 1
            skipWhitespace()
            if consume(0x5d) { return }
            while true {
                try skipValue(depth: depth + 1)
                skipWhitespace()
                if consume(0x5d) { return }
                guard consume(0x2c) else { throw EnrollmentClientError.corruptResponse }
                skipWhitespace()
            }
        case 0x74:
            try consumeLiteral(Array("true".utf8))
        case 0x66:
            try consumeLiteral(Array("false".utf8))
        case 0x6e:
            try consumeLiteral(Array("null".utf8))
        case 0x2d, 0x30...0x39:
            let start = index
            while index < bytes.count,
                  bytes[index] == 0x2d
                    || bytes[index] == 0x2b
                    || bytes[index] == 0x2e
                    || bytes[index] == 0x45
                    || bytes[index] == 0x65
                    || (0x30...0x39).contains(bytes[index]) {
                index += 1
            }
            guard index > start else { throw EnrollmentClientError.corruptResponse }
        default:
            throw EnrollmentClientError.corruptResponse
        }
    }

    private mutating func parseString() throws -> String {
        let start = index
        guard consume(0x22) else { throw EnrollmentClientError.corruptResponse }
        while index < bytes.count {
            let byte = bytes[index]
            index += 1
            if byte == 0x22 {
                let encoded = Data(bytes[start..<index])
                guard let decoded = try? JSONDecoder().decode(String.self, from: encoded) else {
                    throw EnrollmentClientError.corruptResponse
                }
                return decoded
            }
            guard byte >= 0x20 else { throw EnrollmentClientError.corruptResponse }
            if byte == 0x5c {
                guard index < bytes.count else { throw EnrollmentClientError.corruptResponse }
                index += 1
            }
        }
        throw EnrollmentClientError.corruptResponse
    }

    private mutating func consumeLiteral(_ literal: [UInt8]) throws {
        guard index + literal.count <= bytes.count,
              Array(bytes[index..<(index + literal.count)]) == literal else {
            throw EnrollmentClientError.corruptResponse
        }
        index += literal.count
    }

    private mutating func skipWhitespace() {
        while index < bytes.count,
              bytes[index] == 0x20
                || bytes[index] == 0x09
                || bytes[index] == 0x0a
                || bytes[index] == 0x0d {
            index += 1
        }
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        guard index < bytes.count, bytes[index] == byte else { return false }
        index += 1
        return true
    }
}

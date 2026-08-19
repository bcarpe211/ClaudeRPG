import Foundation

public enum VersionDocumentError: Error, Equatable, Sendable {
    case invalidVersion
    case invalidDocument
}

public struct SemanticVersion: Comparable, Equatable, Sendable {
    public let rawValue: String
    private let components: (Int64, Int64, Int64)

    public init(_ rawValue: String) throws {
        let parts = rawValue.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { throw VersionDocumentError.invalidVersion }

        var parsed: [Int64] = []
        for part in parts {
            guard !part.isEmpty,
                  part.allSatisfy({ $0 >= "0" && $0 <= "9" }),
                  part.count == 1 || part.first != "0",
                  let value = Int64(part),
                  String(value) == part else {
                throw VersionDocumentError.invalidVersion
            }
            parsed.append(value)
        }
        self.rawValue = rawValue
        components = (parsed[0], parsed[1], parsed[2])
    }

    public static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        if lhs.components.0 != rhs.components.0 { return lhs.components.0 < rhs.components.0 }
        if lhs.components.1 != rhs.components.1 { return lhs.components.1 < rhs.components.1 }
        return lhs.components.2 < rhs.components.2
    }

    public static func == (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        lhs.components.0 == rhs.components.0 &&
            lhs.components.1 == rhs.components.1 &&
            lhs.components.2 == rhs.components.2
    }
}

public struct VersionDocument: Equatable, Sendable {
    public static let url = URL(string: "https://raiders.redlattice.com/version")!

    public let version: String

    public init(version: String) {
        self.version = version
    }

    public static func decode(_ data: Data) throws -> VersionDocument {
        guard let (key, version, literalKey) = decodeSingleStringField(data),
              key == "version", literalKey else {
            throw VersionDocumentError.invalidDocument
        }
        _ = try SemanticVersion(version)
        return VersionDocument(version: version)
    }

    private static func decodeSingleStringField(_ data: Data) -> (String, String, Bool)? {
        let bytes = Array(data)
        var index = 0

        func skipWhitespace() {
            while index < bytes.count, [0x09, 0x0A, 0x0D, 0x20].contains(bytes[index]) {
                index += 1
            }
        }

        func string() -> (String, Bool)? {
            guard index < bytes.count, bytes[index] == 0x22 else { return nil }
            let start = index
            index += 1
            var escaped = false
            while index < bytes.count {
                let byte = bytes[index]
                index += 1
                if escaped {
                    escaped = false
                } else if byte == 0x5C {
                    escaped = true
                } else if byte == 0x22 {
                    let wire = Data(bytes[start..<index])
                    guard let decoded = try? JSONDecoder().decode(String.self, from: wire) else {
                        return nil
                    }
                    return (decoded, wire == Data(#""version""#.utf8))
                }
            }
            return nil
        }

        skipWhitespace()
        guard index < bytes.count, bytes[index] == 0x7B else { return nil }
        index += 1
        skipWhitespace()
        guard let (key, literalKey) = string() else { return nil }
        skipWhitespace()
        guard index < bytes.count, bytes[index] == 0x3A else { return nil }
        index += 1
        skipWhitespace()
        guard let (value, _) = string() else { return nil }
        skipWhitespace()
        guard index < bytes.count, bytes[index] == 0x7D else { return nil }
        index += 1
        skipWhitespace()
        guard index == bytes.count else { return nil }
        return (key, value, literalKey)
    }
}

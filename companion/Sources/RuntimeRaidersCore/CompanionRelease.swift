import CoreFoundation
import Foundation

public struct CompanionReleaseIdentity: Codable, Equatable, Sendable {
    public let releaseSequence: Int64
    public let releaseSHA: String
    public let companionVersion: String
    public let updateProtocolVersion: Int

    public init(
        releaseSequence: Int64,
        releaseSHA: String,
        companionVersion: String,
        updateProtocolVersion: Int
    ) {
        self.releaseSequence = releaseSequence
        self.releaseSHA = releaseSHA
        self.companionVersion = companionVersion
        self.updateProtocolVersion = updateProtocolVersion
    }

    public static func load(from bundle: Bundle = .main) throws -> Self {
        let infoURL = bundle.bundleURL
            .appendingPathComponent("Contents/Info.plist", isDirectory: false)
        guard let data = try? Data(contentsOf: infoURL),
              let infoDictionary = try? PropertyListSerialization.propertyList(
                  from: data,
                  options: [],
                  format: nil
              ) as? [String: Any] else {
            throw ReleaseContractError.invalidIdentity
        }
        return try parse(infoDictionary: infoDictionary)
    }

    public static func parse(infoDictionary: [String: Any]) throws -> Self {
        guard infoDictionary["CFBundleIdentifier"] as? String == "com.redlattice.runtime-raiders-agent",
              let companionVersion = infoDictionary["CFBundleShortVersionString"] as? String,
              ReleaseContractValidation.isVersion(companionVersion),
              let releaseSequence = ReleaseContractValidation.positiveSafeInteger(
                  infoDictionary["RuntimeRaidersReleaseSequence"]
              ),
              let releaseSHA = infoDictionary["RuntimeRaidersReleaseSHA"] as? String,
              ReleaseContractValidation.isLowercaseHex(releaseSHA, count: 40),
              let updateProtocolVersion = ReleaseContractValidation.positiveSafeInteger(
                  infoDictionary["RuntimeRaidersUpdateProtocolVersion"]
              ),
              [1, 2].contains(updateProtocolVersion) else {
            throw ReleaseContractError.invalidIdentity
        }

        return Self(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: Int(updateProtocolVersion)
        )
    }

    public func releaseReference() throws -> ReleaseReference {
        let reference = ReleaseReference(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: updateProtocolVersion
        )
        guard ReleaseReference.isValid(reference) else {
            throw ReleaseContractError.invalidReleaseState
        }
        return reference
    }
}

public extension ReleaseReference {
    func companionReleaseIdentity() throws -> CompanionReleaseIdentity {
        guard Self.isValid(self) else { throw ReleaseContractError.invalidReleaseState }
        return CompanionReleaseIdentity(
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            companionVersion: companionVersion,
            updateProtocolVersion: updateProtocolVersion
        )
    }
}

enum ReleaseContractError: Error {
    case invalidIdentity
    case invalidManifest
    case invalidReleaseState
}

enum ReleaseContractValidation {
    static let maximumSafeInteger: Int64 = 9_007_199_254_740_991

    static func positiveSafeInteger(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }

        let type = String(cString: number.objCType)
        guard ["c", "s", "i", "l", "q", "C", "S", "I", "L", "Q"].contains(type) else {
            return nil
        }

        let integer = number.int64Value
        guard (1...maximumSafeInteger).contains(integer) else {
            return nil
        }
        return integer
    }

    static func isVersion(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return (1...100).contains(bytes.count) && bytes.allSatisfy { byte in
            (48...57).contains(byte) ||
                (65...90).contains(byte) ||
                (97...122).contains(byte) ||
                [46, 95, 43, 45].contains(byte)
        }
    }

    static func isLowercaseHex(_ value: String, count: Int) -> Bool {
        let bytes = Array(value.utf8)
        return bytes.count == count && bytes.allSatisfy { byte in
            (48...57).contains(byte) || (97...102).contains(byte)
        }
    }
}

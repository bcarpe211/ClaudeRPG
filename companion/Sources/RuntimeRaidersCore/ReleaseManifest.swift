import Foundation

public struct ReleaseManifestV1: Codable, Equatable, Sendable {
    public let manifestVersion: Int
    public let companionVersion: String
    public let releaseSequence: Int64
    public let releaseSHA: String
    public let updateProtocolVersion: Int
    public let zipSHA256: String
    public let zipURL: URL

    public static let manifestURL = URL(string:
        "https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json"
    )!
    public static let archiveURL = URL(string:
        "https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"
    )!

    public static func decode(_ data: Data) throws -> Self {
        guard let document = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(document.keys) == [
                  "manifest_version",
                  "companion_version",
                  "release_sequence",
                  "release_sha",
                  "update_protocol_version",
                  "zip_sha256",
                  "zip_url",
              ],
              ReleaseContractValidation.positiveSafeInteger(document["manifest_version"]) == 1,
              let companionVersion = document["companion_version"] as? String,
              ReleaseContractValidation.isVersion(companionVersion),
              let releaseSequence = ReleaseContractValidation.positiveSafeInteger(document["release_sequence"]),
              let releaseSHA = document["release_sha"] as? String,
              ReleaseContractValidation.isLowercaseHex(releaseSHA, count: 40),
              let updateProtocolVersion = ReleaseContractValidation.positiveSafeInteger(
                  document["update_protocol_version"]
              ),
              [1, 2].contains(updateProtocolVersion),
              let zipSHA256 = document["zip_sha256"] as? String,
              ReleaseContractValidation.isLowercaseHex(zipSHA256, count: 64),
              let zipURLString = document["zip_url"] as? String,
              zipURLString == archiveURL.absoluteString else {
            throw ReleaseContractError.invalidManifest
        }

        return Self(
            manifestVersion: 1,
            companionVersion: companionVersion,
            releaseSequence: releaseSequence,
            releaseSHA: releaseSHA,
            updateProtocolVersion: Int(updateProtocolVersion),
            zipSHA256: zipSHA256,
            zipURL: archiveURL
        )
    }

    public func availability(from installed: CompanionReleaseIdentity) -> CompanionUpdateAvailability? {
        guard updateProtocolVersion == installed.updateProtocolVersion,
              releaseSequence > installed.releaseSequence else {
            return nil
        }
        return CompanionUpdateAvailability(
            installedVersion: installed.companionVersion,
            installedSequence: installed.releaseSequence,
            availableVersion: companionVersion,
            availableSequence: releaseSequence,
            updateCommand: "raiders update"
        )
    }
}

public struct CompanionUpdateAvailability: Codable, Equatable, Sendable {
    public let installedVersion: String
    public let installedSequence: Int64
    public let availableVersion: String
    public let availableSequence: Int64
    public let updateCommand: String
}

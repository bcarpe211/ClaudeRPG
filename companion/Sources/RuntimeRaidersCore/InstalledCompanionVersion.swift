import Foundation

public enum InstalledCompanionVersionError: Error, Equatable, Sendable {
    case invalidBundle
}

public enum InstalledCompanionVersion {
    public static func load(from bundle: Bundle = .main) throws -> String {
        let infoURL = bundle.bundleURL
            .appendingPathComponent("Contents/Info.plist", isDirectory: false)
        guard let data = try? Data(contentsOf: infoURL),
              let infoDictionary = try? PropertyListSerialization.propertyList(
                  from: data,
                  options: [],
                  format: nil
              ) as? [String: Any],
              infoDictionary["CFBundleIdentifier"] as? String ==
                "com.redlattice.runtime-raiders-agent",
              let shortVersion = infoDictionary["CFBundleShortVersionString"] as? String,
              let bundleVersion = infoDictionary["CFBundleVersion"] as? String,
              bundleVersion == shortVersion,
              (try? SemanticVersion(shortVersion))?.rawValue == shortVersion else {
            throw InstalledCompanionVersionError.invalidBundle
        }
        return shortVersion
    }
}

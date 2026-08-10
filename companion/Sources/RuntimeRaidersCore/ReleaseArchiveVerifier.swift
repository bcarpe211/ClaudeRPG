import Foundation

public struct VerifiedReleaseAgent: Equatable, Sendable {
    public let application: URL
    public let identity: ReleaseReference

    public init(application: URL, identity: ReleaseReference) {
        self.application = application
        self.identity = identity
    }
}

public struct VerifiedReleaseArchive: Equatable, Sendable {
    public let agent: VerifiedReleaseAgent
    public let launcher: URL

    public init(agent: VerifiedReleaseAgent, launcher: URL) {
        self.agent = agent
        self.launcher = launcher
    }
}

public enum ReleaseArchiveVerificationError: Error, Equatable {
    case untrustedArchive
}

public struct ReleaseArchiveVerifier {
    private let signatureInspector: (URL) throws -> CandidateSignatureFacts
    private let agentIdentityLoader: (URL) throws -> CompanionReleaseIdentity
    private let launcherProtocolLoader: (URL) throws -> Int

    public init() {
        signatureInspector = { try SignedBundleTrustInspector().inspect(candidate: $0) }
        agentIdentityLoader = { application in
            guard let bundle = Bundle(url: application) else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
            return try CompanionReleaseIdentity.load(from: bundle)
        }
        launcherProtocolLoader = { application in
            try Self.loadLauncherProtocol(from: application)
        }
    }

    init(
        signatureInspector: @escaping (URL) throws -> CandidateSignatureFacts,
        agentIdentityLoader: @escaping (URL) throws -> CompanionReleaseIdentity,
        launcherProtocolLoader: @escaping (URL) throws -> Int
    ) {
        self.signatureInspector = signatureInspector
        self.agentIdentityLoader = agentIdentityLoader
        self.launcherProtocolLoader = launcherProtocolLoader
    }

    public func verify(
        extractedRoot: URL,
        manifest: ReleaseManifestV1,
        installed: CompanionReleaseIdentity,
        installedTeamIdentifier: String
    ) throws -> VerifiedReleaseArchive {
        do {
            try ZipArchiveValidator.validateExtractedTree(extractedRoot)
            guard manifest.updateProtocolVersion == 2,
                  installed.updateProtocolVersion == 2,
                  manifest.releaseSequence > installed.releaseSequence else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }

            let release = extractedRoot.appendingPathComponent(
                String(ZipArchiveValidator.releaseRoot.dropLast()),
                isDirectory: true
            )
            let agent = extractedRoot.appendingPathComponent(
                String(ZipArchiveValidator.agentApplicationRoot.dropLast()),
                isDirectory: true
            )
            let launcher = extractedRoot.appendingPathComponent(
                String(ZipArchiveValidator.launcherApplicationRoot.dropLast()),
                isDirectory: true
            )
            guard agent.deletingLastPathComponent() == release,
                  launcher.deletingLastPathComponent() == release else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }

            let agentFacts = try signatureInspector(agent)
            let launcherFacts = try signatureInspector(launcher)
            guard trusted(
                agentFacts,
                bundleIdentifier: "com.redlattice.runtime-raiders-agent",
                teamIdentifier: installedTeamIdentifier
            ), trusted(
                launcherFacts,
                bundleIdentifier: "com.redlattice.runtime-raiders-launcher",
                teamIdentifier: installedTeamIdentifier
            ) else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }

            let identity = try agentIdentityLoader(agent)
            guard identity.releaseSequence == manifest.releaseSequence,
                  identity.releaseSHA == manifest.releaseSHA,
                  identity.companionVersion == manifest.companionVersion,
                  identity.updateProtocolVersion == manifest.updateProtocolVersion,
                  try launcherProtocolLoader(launcher) == 1 else {
                throw ReleaseArchiveVerificationError.untrustedArchive
            }
            let reference = try identity.releaseReference()

            try ZipArchiveValidator.validateExtractedTree(extractedRoot)
            return VerifiedReleaseArchive(
                agent: VerifiedReleaseAgent(application: agent, identity: reference),
                launcher: launcher
            )
        } catch {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
    }

    private func trusted(
        _ facts: CandidateSignatureFacts,
        bundleIdentifier: String,
        teamIdentifier: String
    ) -> Bool {
        facts.bundleIdentifier == bundleIdentifier &&
            facts.teamIdentifier == teamIdentifier &&
            facts.signatureValid &&
            facts.allArchitecturesValid &&
            facts.hardenedRuntime &&
            facts.secureTimestampPresent &&
            facts.gatekeeperNotarized
    }

    private static func loadLauncherProtocol(from application: URL) throws -> Int {
        let infoURL = application.appendingPathComponent("Contents/Info.plist", isDirectory: false)
        let data = try Data(contentsOf: infoURL)
        guard data.count <= ReleaseFilesystem.maximumRecordBytes,
              let dictionary = try PropertyListSerialization.propertyList(
                  from: data,
                  options: [],
                  format: nil
              ) as? [String: Any],
              let protocolVersion = ReleaseContractValidation.positiveSafeInteger(
                  dictionary["RuntimeRaidersLauncherProtocolVersion"]
              ) else {
            throw ReleaseArchiveVerificationError.untrustedArchive
        }
        return Int(protocolVersion)
    }
}

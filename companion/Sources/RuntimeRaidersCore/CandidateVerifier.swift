import Foundation
import Security

public struct CandidateSignatureFacts: Equatable, Sendable {
    public let bundleIdentifier: String
    public let teamIdentifier: String
    public let allArchitecturesValid: Bool
    public let hardenedRuntime: Bool
    public let secureTimestampPresent: Bool
    public let gatekeeperNotarized: Bool

    public init(
        bundleIdentifier: String,
        teamIdentifier: String,
        allArchitecturesValid: Bool,
        hardenedRuntime: Bool,
        secureTimestampPresent: Bool,
        gatekeeperNotarized: Bool
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.teamIdentifier = teamIdentifier
        self.allArchitecturesValid = allArchitecturesValid
        self.hardenedRuntime = hardenedRuntime
        self.secureTimestampPresent = secureTimestampPresent
        self.gatekeeperNotarized = gatekeeperNotarized
    }
}

public enum CandidateVerificationError: Error, Equatable {
    case untrustedCandidate
}

public struct CandidateVerifier {
    private let signatureInspector: (URL) throws -> CandidateSignatureFacts
    private let identityLoader: (URL) throws -> CompanionReleaseIdentity

    public init() {
        signatureInspector = { try CandidateTrustInspector().inspect(candidate: $0) }
        identityLoader = { candidate in
            guard let bundle = Bundle(url: candidate) else {
                throw CandidateVerificationError.untrustedCandidate
            }
            return try CompanionReleaseIdentity.load(from: bundle)
        }
    }

    init(
        signatureInspector: @escaping (URL) throws -> CandidateSignatureFacts,
        identityLoader: @escaping (URL) throws -> CompanionReleaseIdentity
    ) {
        self.signatureInspector = signatureInspector
        self.identityLoader = identityLoader
    }

    public func verify(
        candidate: URL,
        manifest: ReleaseManifestV1,
        installed: CompanionReleaseIdentity,
        installedTeamIdentifier: String
    ) throws -> CompanionReleaseIdentity {
        do {
            let facts = try signatureInspector(candidate)
            guard facts.bundleIdentifier == "com.redlattice.runtime-raiders-agent",
                  facts.teamIdentifier == installedTeamIdentifier,
                  facts.allArchitecturesValid,
                  facts.hardenedRuntime,
                  facts.secureTimestampPresent,
                  facts.gatekeeperNotarized,
                  manifest.updateProtocolVersion == installed.updateProtocolVersion,
                  manifest.releaseSequence > installed.releaseSequence else {
                throw CandidateVerificationError.untrustedCandidate
            }
            let identity = try identityLoader(candidate)
            guard identity.releaseSequence == manifest.releaseSequence,
                  identity.releaseSHA == manifest.releaseSHA,
                  identity.companionVersion == manifest.companionVersion,
                  identity.updateProtocolVersion == manifest.updateProtocolVersion else {
                throw CandidateVerificationError.untrustedCandidate
            }
            return identity
        } catch {
            throw CandidateVerificationError.untrustedCandidate
        }
    }
}

private struct CandidateTrustInspector {
    private static let hardenedRuntimeSigningFlag: UInt32 = 0x0001_0000
    private let runner = SystemCommandRunner()

    func inspect(candidate: URL) throws -> CandidateSignatureFacts {
        let candidateCode = try staticCode(at: candidate)
        let installedCode = try staticCode(at: Bundle.main.bundleURL)
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(installedCode, [], &requirement) == errSecSuccess,
              let requirement else {
            throw CandidateVerificationError.untrustedCandidate
        }

        let validationFlags = SecCSFlags(rawValue:
            UInt32(kSecCSCheckAllArchitectures) |
                UInt32(kSecCSStrictValidate) |
                UInt32(kSecCSCheckNestedCode) |
                UInt32(kSecCSRestrictSymlinks)
        )
        let installedSelfValid = SecStaticCodeCheckValidity(installedCode, validationFlags, requirement) == errSecSuccess
        let frameworkValid = SecStaticCodeCheckValidity(candidateCode, validationFlags, requirement) == errSecSuccess

        var requirementText: CFString?
        guard SecRequirementCopyString(requirement, [], &requirementText) == errSecSuccess,
              let requirementString = requirementText as String? else {
            throw CandidateVerificationError.untrustedCandidate
        }
        let candidatePath = candidate.path
        let codesign = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--verify", "--strict", "--all-architectures", "-R=\(requirementString)", candidatePath],
            timeout: 30
        )

        var signingInformation: CFDictionary?
        guard SecCodeCopySigningInformation(
            candidateCode,
            SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)),
            &signingInformation
        ) == errSecSuccess,
            let information = signingInformation as? [String: Any],
            let identifier = information[kSecCodeInfoIdentifier as String] as? String,
            let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
            let flags = information[kSecCodeInfoFlags as String] as? NSNumber else {
            throw CandidateVerificationError.untrustedCandidate
        }
        var installedSigningInformation: CFDictionary?
        guard SecCodeCopySigningInformation(
            installedCode,
            SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)),
            &installedSigningInformation
        ) == errSecSuccess,
            let installedInformation = installedSigningInformation as? [String: Any],
            let installedTeamIdentifier = installedInformation[kSecCodeInfoTeamIdentifier as String] as? String else {
            throw CandidateVerificationError.untrustedCandidate
        }

        let notarization = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--verify", "--strict", "--check-notarization", "-R=notarized", candidatePath],
            timeout: 30
        )
        let gatekeeper = try runner.run(
            executable: URL(fileURLWithPath: "/usr/sbin/spctl"),
            arguments: ["--assess", "--type", "execute", "--verbose=4", candidatePath],
            timeout: 30
        )

        return CandidateSignatureFacts(
            bundleIdentifier: identifier,
            teamIdentifier: teamIdentifier,
            allArchitecturesValid: installedSelfValid &&
                frameworkValid &&
                teamIdentifier == installedTeamIdentifier &&
                codesign.exitStatus == .exited(0),
            hardenedRuntime: flags.uint32Value & Self.hardenedRuntimeSigningFlag != 0,
            secureTimestampPresent: information[kSecCodeInfoTimestamp as String] is Date,
            gatekeeperNotarized: notarization.exitStatus == .exited(0) && gatekeeper.exitStatus == .exited(0)
        )
    }

    private func staticCode(at url: URL) throws -> SecStaticCode {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
              let code else {
            throw CandidateVerificationError.untrustedCandidate
        }
        return code
    }
}

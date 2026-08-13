import Foundation
import Security

public struct CandidateSignatureFacts: Equatable, Sendable {
    public let bundleIdentifier: String
    public let teamIdentifier: String
    public let signatureValid: Bool
    public let allArchitecturesValid: Bool
    public let requiredArchitecturesPresent: Bool
    public let hardenedRuntime: Bool
    public let secureTimestampPresent: Bool
    public let gatekeeperNotarized: Bool

    public init(
        bundleIdentifier: String,
        teamIdentifier: String,
        signatureValid: Bool,
        allArchitecturesValid: Bool,
        requiredArchitecturesPresent: Bool = true,
        hardenedRuntime: Bool,
        secureTimestampPresent: Bool,
        gatekeeperNotarized: Bool
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.teamIdentifier = teamIdentifier
        self.signatureValid = signatureValid
        self.allArchitecturesValid = allArchitecturesValid
        self.requiredArchitecturesPresent = requiredArchitecturesPresent
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
        signatureInspector = { try SignedBundleTrustInspector().inspect(candidate: $0) }
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
                  facts.signatureValid,
                  facts.allArchitecturesValid,
                  facts.requiredArchitecturesPresent,
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

struct SignedBundleTrustInspector {
    private static let hardenedRuntimeSigningFlag: UInt32 = 0x0001_0000
    private let runner = SystemCommandRunner()

    func inspect(candidate: URL) throws -> CandidateSignatureFacts {
        let candidateCode = try staticCode(at: candidate)
        let installedCode = try staticCode(at: Bundle.main.bundleURL)
        var installedRequirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(installedCode, [], &installedRequirement) == errSecSuccess,
              let installedRequirement,
              let installedInformation = try signingInformation(for: installedCode),
              let installedIdentifier = installedInformation[kSecCodeInfoIdentifier as String] as? String,
              let installedTeamIdentifier = installedInformation[kSecCodeInfoTeamIdentifier as String] as? String,
              Self.validTeamIdentifier(installedTeamIdentifier) else {
            throw CandidateVerificationError.untrustedCandidate
        }

        guard let information = try signingInformation(for: candidateCode),
              let identifier = information[kSecCodeInfoIdentifier as String] as? String,
              let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
              let flags = information[kSecCodeInfoFlags as String] as? NSNumber,
              let candidateDeveloperIDRequirement = try makeDeveloperIDRequirement(
                  bundleIdentifier: identifier,
                  teamIdentifier: installedTeamIdentifier
              ),
              let installedDeveloperIDRequirement = try makeDeveloperIDRequirement(
                  bundleIdentifier: installedIdentifier,
                  teamIdentifier: installedTeamIdentifier
              ) else {
            throw CandidateVerificationError.untrustedCandidate
        }

        let candidateRequirement = identifier == "com.redlattice.runtime-raiders-agent"
            ? installedRequirement
            : candidateDeveloperIDRequirement
        let installedSignatureValid = SecStaticCodeCheckValidity(
            installedCode,
            Self.validationFlags,
            installedRequirement
        ) == errSecSuccess && SecStaticCodeCheckValidity(
            installedCode,
            Self.validationFlags,
            installedDeveloperIDRequirement
        ) == errSecSuccess
        let candidateSignatureValid = SecStaticCodeCheckValidity(
            candidateCode,
            Self.validationFlags,
            candidateRequirement
        ) == errSecSuccess
        let installedArchitecturesValid = SecStaticCodeCheckValidity(
            installedCode,
            Self.allArchitectureValidationFlags,
            installedRequirement
        ) == errSecSuccess && SecStaticCodeCheckValidity(
            installedCode,
            Self.allArchitectureValidationFlags,
            installedDeveloperIDRequirement
        ) == errSecSuccess
        let candidateArchitecturesValid = SecStaticCodeCheckValidity(
            candidateCode,
            Self.allArchitectureValidationFlags,
            candidateRequirement
        ) == errSecSuccess

        var requirementText: CFString?
        guard SecRequirementCopyString(candidateRequirement, [], &requirementText) == errSecSuccess,
              let requirementString = requirementText as String? else {
            throw CandidateVerificationError.untrustedCandidate
        }
        let candidatePath = candidate.path
        let codesign = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--verify", "--strict", "-R=\(requirementString)", candidatePath],
            timeout: 30
        )
        let allArchitectureCodesign = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--verify", "--strict", "--all-architectures", "-R=\(requirementString)", candidatePath],
            timeout: 30
        )

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
        let requiredArchitecturesPresent = try containsRequiredArchitectures(candidate)

        return CandidateSignatureFacts(
            bundleIdentifier: identifier,
            teamIdentifier: teamIdentifier,
            signatureValid: installedSignatureValid &&
                candidateSignatureValid &&
                teamIdentifier == installedTeamIdentifier &&
                codesign.exitStatus == .exited(0),
            allArchitecturesValid: installedArchitecturesValid &&
                candidateArchitecturesValid &&
                teamIdentifier == installedTeamIdentifier &&
                allArchitectureCodesign.exitStatus == .exited(0),
            requiredArchitecturesPresent: requiredArchitecturesPresent,
            hardenedRuntime: flags.uint32Value & Self.hardenedRuntimeSigningFlag != 0,
            secureTimestampPresent: information[kSecCodeInfoTimestamp as String] is Date,
            gatekeeperNotarized: notarization.exitStatus == .exited(0) && gatekeeper.exitStatus == .exited(0)
        )
    }

    func inspect(
        candidate: URL,
        expectedTeamIdentifier: String
    ) throws -> CandidateSignatureFacts {
        guard Self.validTeamIdentifier(expectedTeamIdentifier) else {
            throw CandidateVerificationError.untrustedCandidate
        }
        let candidateCode = try staticCode(at: candidate)
        guard let information = try signingInformation(for: candidateCode),
              let identifier = information[kSecCodeInfoIdentifier as String] as? String,
              let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
              let flags = information[kSecCodeInfoFlags as String] as? NSNumber,
              let requirement = try makeDeveloperIDRequirement(
                  bundleIdentifier: identifier,
                  teamIdentifier: expectedTeamIdentifier
              ) else {
            throw CandidateVerificationError.untrustedCandidate
        }

        var requirementText: CFString?
        guard SecRequirementCopyString(requirement, [], &requirementText) == errSecSuccess,
              let requirementString = requirementText as String? else {
            throw CandidateVerificationError.untrustedCandidate
        }
        let candidatePath = candidate.path
        let codesign = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--verify", "--strict", "-R=\(requirementString)", candidatePath],
            timeout: 30
        )
        let allArchitectureCodesign = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: [
                "--verify", "--strict", "--all-architectures",
                "-R=\(requirementString)", candidatePath,
            ],
            timeout: 30
        )
        let notarization = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: [
                "--verify", "--strict", "--check-notarization", "-R=notarized", candidatePath,
            ],
            timeout: 30
        )
        let gatekeeper = try runner.run(
            executable: URL(fileURLWithPath: "/usr/sbin/spctl"),
            arguments: ["--assess", "--type", "execute", "--verbose=4", candidatePath],
            timeout: 30
        )
        let requiredArchitecturesPresent = try containsRequiredArchitectures(candidate)
        return CandidateSignatureFacts(
            bundleIdentifier: identifier,
            teamIdentifier: teamIdentifier,
            signatureValid: teamIdentifier == expectedTeamIdentifier &&
                SecStaticCodeCheckValidity(candidateCode, Self.validationFlags, requirement) == errSecSuccess &&
                codesign.exitStatus == .exited(0),
            allArchitecturesValid: teamIdentifier == expectedTeamIdentifier &&
                SecStaticCodeCheckValidity(
                    candidateCode,
                    Self.allArchitectureValidationFlags,
                    requirement
                ) == errSecSuccess && allArchitectureCodesign.exitStatus == .exited(0),
            requiredArchitecturesPresent: requiredArchitecturesPresent,
            hardenedRuntime: flags.uint32Value & Self.hardenedRuntimeSigningFlag != 0,
            secureTimestampPresent: information[kSecCodeInfoTimestamp as String] is Date,
            gatekeeperNotarized: notarization.exitStatus == .exited(0) &&
                gatekeeper.exitStatus == .exited(0)
        )
    }

    private static let validationFlags = SecCSFlags(rawValue:
        UInt32(kSecCSStrictValidate) |
            UInt32(kSecCSCheckNestedCode) |
            UInt32(kSecCSRestrictSymlinks)
    )

    private func containsRequiredArchitectures(_ application: URL) throws -> Bool {
        guard let executable = Bundle(url: application)?.executableURL,
              executable.path.hasPrefix(application.path + "/") else {
            throw CandidateVerificationError.untrustedCandidate
        }
        let result = try runner.run(
            executable: URL(fileURLWithPath: "/usr/bin/lipo"),
            arguments: ["-verify_arch", "arm64", "x86_64", executable.path],
            timeout: 30
        )
        return result.exitStatus == .exited(0)
    }

    private static let allArchitectureValidationFlags = SecCSFlags(rawValue:
        validationFlags.rawValue | UInt32(kSecCSCheckAllArchitectures)
    )

    private func signingInformation(for code: SecStaticCode) throws -> [String: Any]? {
        var signingInformation: CFDictionary?
        guard SecCodeCopySigningInformation(
            code,
            SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)),
            &signingInformation
        ) == errSecSuccess else {
            throw CandidateVerificationError.untrustedCandidate
        }
        return signingInformation as? [String: Any]
    }

    private func makeDeveloperIDRequirement(
        bundleIdentifier: String,
        teamIdentifier: String
    ) throws -> SecRequirement? {
        guard [
            "com.redlattice.runtime-raiders-agent",
            "com.redlattice.runtime-raiders-launcher",
        ].contains(bundleIdentifier),
            Self.validTeamIdentifier(teamIdentifier) else {
            return nil
        }
        let text = "anchor apple generic and " +
            "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and " +
            "certificate leaf[subject.OU] = \"\(teamIdentifier)\" and " +
            "identifier \"\(bundleIdentifier)\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else {
            throw CandidateVerificationError.untrustedCandidate
        }
        return requirement
    }

    private static func validTeamIdentifier(_ value: String) -> Bool {
        value.utf8.count == 10 && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte)
        }
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

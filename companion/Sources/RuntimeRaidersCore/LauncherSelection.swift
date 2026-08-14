import Darwin
import Foundation
import Security

public enum LauncherInvocation: Equatable, Sendable {
    case daemon
    case on
    case off
    case status
    case doctor
    case update
    case uninstall

    public init?(arguments: [String]) {
        guard arguments.count == 1, let argument = arguments.first else { return nil }
        switch argument {
        case "daemon": self = .daemon
        case "on": self = .on
        case "off": self = .off
        case "status": self = .status
        case "doctor": self = .doctor
        case "update": self = .update
        case "uninstall": self = .uninstall
        default: return nil
        }
    }

    public var arguments: [String] {
        switch self {
        case .daemon: ["daemon"]
        case .on: ["on"]
        case .off: ["off"]
        case .status: ["status"]
        case .doctor: ["doctor"]
        case .update: ["update"]
        case .uninstall: ["uninstall"]
        }
    }
}

public struct LauncherSelection: Equatable, Sendable {
    public let release: ReleaseReference
    public let executable: URL
    public let arguments: [String]
    public let releaseStateGeneration: Int64

    public init(
        release: ReleaseReference,
        executable: URL,
        arguments: [String],
        releaseStateGeneration: Int64
    ) {
        self.release = release
        self.executable = executable
        self.arguments = arguments
        self.releaseStateGeneration = releaseStateGeneration
    }
}

public struct LauncherBundleValidation: Equatable, Sendable {
    public let bundle: URL
    public let executable: URL
    public let bundleIdentifier: String
    public let teamIdentifier: String
    public let hardenedRuntime: Bool
    public let allArchitecturesValid: Bool
    public let launcherProtocolVersion: Int?
    public let releaseIdentity: CompanionReleaseIdentity?

    public init(
        bundle: URL,
        executable: URL,
        bundleIdentifier: String,
        teamIdentifier: String,
        hardenedRuntime: Bool,
        allArchitecturesValid: Bool,
        launcherProtocolVersion: Int?,
        releaseIdentity: CompanionReleaseIdentity?
    ) {
        self.bundle = bundle
        self.executable = executable
        self.bundleIdentifier = bundleIdentifier
        self.teamIdentifier = teamIdentifier
        self.hardenedRuntime = hardenedRuntime
        self.allArchitecturesValid = allArchitecturesValid
        self.launcherProtocolVersion = launcherProtocolVersion
        self.releaseIdentity = releaseIdentity
    }
}

public struct LauncherSelectionOperations {
    public let paths: AgentPaths
    let loadReleaseState: () throws -> ReleaseStateV1
    let preparedStartupLeaseIsHeld: () throws -> Bool
    let inspectLauncher: () throws -> LauncherBundleValidation
    let inspectAgent: (URL) throws -> LauncherBundleValidation

    public init(
        paths: AgentPaths,
        loadReleaseState: @escaping () throws -> ReleaseStateV1,
        preparedStartupLeaseIsHeld: @escaping () throws -> Bool,
        inspectLauncher: @escaping () throws -> LauncherBundleValidation,
        inspectAgent: @escaping (URL) throws -> LauncherBundleValidation
    ) {
        self.paths = paths
        self.loadReleaseState = loadReleaseState
        self.preparedStartupLeaseIsHeld = preparedStartupLeaseIsHeld
        self.inspectLauncher = inspectLauncher
        self.inspectAgent = inspectAgent
    }

    public static func live(
        paths: AgentPaths,
        launcherBundle: Bundle
    ) -> Self {
        Self(
            paths: paths,
            loadReleaseState: { try ReleaseStateStore.loadExisting(paths: paths) },
            preparedStartupLeaseIsHeld: {
                try CompanionPreparedStartupLease.observe(paths: paths) != nil
            },
            inspectLauncher: {
                try LiveLauncherTrustInspector.inspectLauncher(
                    bundle: launcherBundle,
                    paths: paths
                )
            },
            inspectAgent: {
                try LiveLauncherTrustInspector.inspectAgent(application: $0, paths: paths)
            }
        )
    }
}

public enum LauncherSelectionError: Error, Equatable {
    case untrustedSelection
}

public struct LauncherSelector {
    private let operations: LauncherSelectionOperations

    public init(operations: LauncherSelectionOperations) {
        self.operations = operations
    }

    public func select(invocation: LauncherInvocation) throws -> LauncherSelection {
        do {
            let launcher = try operations.inspectLauncher()
            guard validLauncher(launcher) else { throw LauncherSelectionError.untrustedSelection }

            let state = try operations.loadReleaseState()
            guard ReleaseStateV1.isValid(state) else {
                throw LauncherSelectionError.untrustedSelection
            }

            let release: ReleaseReference
            let arguments: [String]
            let selectedTrial: Bool
            let observesTrialLease = invocation == .daemon && state.trial != nil
            let initialLeaseHeld = observesTrialLease
                ? try operations.preparedStartupLeaseIsHeld()
                : false
            if invocation == .daemon,
               let trial = state.trial,
               initialLeaseHeld {
                release = trial
                selectedTrial = true
                arguments = [
                    "daemon",
                    "__runtime-raiders-trial-generation",
                    String(state.generation),
                ]
            } else {
                release = state.active
                selectedTrial = false
                arguments = invocation.arguments
            }

            let application = try operations.paths.application(for: release)
            let executable = try operations.paths.executable(for: release)
            let agent = try operations.inspectAgent(application)
            guard validAgent(
                agent,
                application: application,
                executable: executable,
                release: release,
                teamIdentifier: launcher.teamIdentifier
            ) else {
                throw LauncherSelectionError.untrustedSelection
            }

            let finalState = try operations.loadReleaseState()
            let finalLauncher = try operations.inspectLauncher()
            let finalAgent = try operations.inspectAgent(application)
            let finalLeaseHeld = observesTrialLease
                ? try operations.preparedStartupLeaseIsHeld()
                : false
            guard finalState == state,
                  equivalent(finalLauncher, launcher),
                  equivalent(finalAgent, agent),
                  validLauncher(finalLauncher),
                  validAgent(
                      finalAgent,
                      application: application,
                      executable: executable,
                      release: release,
                      teamIdentifier: finalLauncher.teamIdentifier
                  ),
                  (!observesTrialLease || finalLeaseHeld == initialLeaseHeld),
                  (!selectedTrial || finalLeaseHeld) else {
                throw LauncherSelectionError.untrustedSelection
            }

            return LauncherSelection(
                release: release,
                executable: executable,
                arguments: arguments,
                releaseStateGeneration: state.generation
            )
        } catch {
            throw LauncherSelectionError.untrustedSelection
        }
    }

    private func validLauncher(_ facts: LauncherBundleValidation) -> Bool {
        exact(facts.bundle, operations.paths.launcherApplication) &&
            exact(facts.executable, operations.paths.launcherExecutable) &&
            facts.bundleIdentifier == "com.redlattice.runtime-raiders-launcher" &&
            !facts.teamIdentifier.isEmpty &&
            facts.hardenedRuntime &&
            facts.allArchitecturesValid &&
            facts.launcherProtocolVersion == 1 &&
            facts.releaseIdentity == nil
    }

    private func validAgent(
        _ facts: LauncherBundleValidation,
        application: URL,
        executable: URL,
        release: ReleaseReference,
        teamIdentifier: String
    ) -> Bool {
        exact(facts.bundle, application) &&
            exact(facts.executable, executable) &&
            facts.bundleIdentifier == "com.redlattice.runtime-raiders-agent" &&
            facts.teamIdentifier == teamIdentifier &&
            facts.hardenedRuntime &&
            facts.allArchitecturesValid &&
            facts.launcherProtocolVersion == nil &&
            facts.releaseIdentity == (try? release.companionReleaseIdentity())
    }

    private func exact(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.isFileURL &&
            rhs.isFileURL &&
            lhs.standardizedFileURL.path == rhs.standardizedFileURL.path
    }

    private func equivalent(
        _ lhs: LauncherBundleValidation,
        _ rhs: LauncherBundleValidation
    ) -> Bool {
        exact(lhs.bundle, rhs.bundle) &&
            exact(lhs.executable, rhs.executable) &&
            lhs.bundleIdentifier == rhs.bundleIdentifier &&
            lhs.teamIdentifier == rhs.teamIdentifier &&
            lhs.hardenedRuntime == rhs.hardenedRuntime &&
            lhs.allArchitecturesValid == rhs.allArchitecturesValid &&
            lhs.launcherProtocolVersion == rhs.launcherProtocolVersion &&
            lhs.releaseIdentity == rhs.releaseIdentity
    }
}

public struct LauncherExecutionRequest: Equatable, Sendable {
    public let executable: URL
    public let arguments: [String]
    public let environment: [String: String]

    public init(executable: URL, arguments: [String], environment: [String: String]) {
        self.executable = executable
        self.arguments = arguments
        self.environment = environment
    }
}

public struct LauncherExecutionAdapter {
    private let replaceProcess: (LauncherExecutionRequest) throws -> Void

    public init(replaceProcess: @escaping (LauncherExecutionRequest) throws -> Void) {
        self.replaceProcess = replaceProcess
    }

    public func execute(
        selection: LauncherSelection,
        environment: [String: String]
    ) throws {
        try replaceProcess(LauncherExecutionRequest(
            executable: selection.executable,
            arguments: selection.arguments,
            environment: environment
        ))
    }
}

public extension ReleaseStateStore {
    static func loadExisting(paths: AgentPaths) throws -> ReleaseStateV1 {
        try ReleaseFilesystem.validateExistingOwnerOnlyDirectory(paths.supportDirectory)
        let descriptor = try ReleaseFilesystem.openExistingOwnerOnlyDirectory(
            paths.installationDirectory
        )
        defer { Darwin.close(descriptor) }
        guard let data = try ReleaseFilesystem.readRegularRecord(
            directoryDescriptor: descriptor,
            name: paths.releaseState.lastPathComponent
        ) else {
            throw LauncherSelectionError.untrustedSelection
        }
        return try ReleaseStateV1.decode(data)
    }
}

private extension ReleaseFilesystem {
    static func validateExistingOwnerOnlyDirectory(_ url: URL) throws {
        let descriptor = try openExistingOwnerOnlyDirectory(url)
        Darwin.close(descriptor)
    }

    static func openExistingOwnerOnlyDirectory(_ url: URL) throws -> Int32 {
        guard let descriptor = try OwnerOnlyDirectory.openExisting(url) else {
            throw LauncherSelectionError.untrustedSelection
        }
        return descriptor
    }
}

private enum LiveLauncherTrustInspector {
    private static let hardenedRuntimeSigningFlag: UInt32 = 0x0001_0000
    private static let validationFlags = SecCSFlags(rawValue:
        UInt32(kSecCSCheckAllArchitectures) |
            UInt32(kSecCSStrictValidate) |
            UInt32(kSecCSCheckNestedCode) |
            UInt32(kSecCSRestrictSymlinks)
    )

    static func inspectLauncher(
        bundle: Bundle,
        paths: AgentPaths
    ) throws -> LauncherBundleValidation {
        try ReleaseFilesystem.validateExistingOwnerOnlyDirectory(paths.supportDirectory)
        try ReleaseFilesystem.validateExistingOwnerOnlyDirectory(paths.launcherDirectory)
        guard exact(bundle.bundleURL, paths.launcherApplication),
              let executable = bundle.executableURL,
              exact(executable, paths.launcherExecutable),
              let protocolVersion = exactPositiveInteger(
                  bundle.object(forInfoDictionaryKey: "RuntimeRaidersLauncherProtocolVersion")
              ) else {
            throw LauncherSelectionError.untrustedSelection
        }
        try validateOwnedNode(bundle.bundleURL, expectedType: S_IFDIR, exactMode: nil)
        try validateOwnedNode(executable, expectedType: S_IFREG, exactMode: nil)
        let signature = try signatureFacts(at: bundle.bundleURL)
        return LauncherBundleValidation(
            bundle: bundle.bundleURL,
            executable: executable,
            bundleIdentifier: signature.bundleIdentifier,
            teamIdentifier: signature.teamIdentifier,
            hardenedRuntime: signature.hardenedRuntime,
            allArchitecturesValid: signature.allArchitecturesValid,
            launcherProtocolVersion: Int(protocolVersion),
            releaseIdentity: nil
        )
    }

    static func inspectAgent(
        application: URL,
        paths: AgentPaths
    ) throws -> LauncherBundleValidation {
        try ReleaseFilesystem.validateExistingOwnerOnlyDirectory(paths.supportDirectory)
        try ReleaseFilesystem.validateExistingOwnerOnlyDirectory(paths.releasesDirectory)
        try ReleaseFilesystem.validateExistingOwnerOnlyDirectory(
            application.deletingLastPathComponent()
        )
        guard let bundle = Bundle(url: application),
              let executable = bundle.executableURL else {
            throw LauncherSelectionError.untrustedSelection
        }
        try validateOwnedNode(application, expectedType: S_IFDIR, exactMode: nil)
        try validateOwnedNode(executable, expectedType: S_IFREG, exactMode: nil)
        let signature = try signatureFacts(at: application)
        return LauncherBundleValidation(
            bundle: application,
            executable: executable,
            bundleIdentifier: signature.bundleIdentifier,
            teamIdentifier: signature.teamIdentifier,
            hardenedRuntime: signature.hardenedRuntime,
            allArchitecturesValid: signature.allArchitecturesValid,
            launcherProtocolVersion: nil,
            releaseIdentity: try CompanionReleaseIdentity.load(from: bundle)
        )
    }

    private static func signatureFacts(at application: URL) throws -> (
        bundleIdentifier: String,
        teamIdentifier: String,
        hardenedRuntime: Bool,
        allArchitecturesValid: Bool
    ) {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(application as CFURL, [], &code) == errSecSuccess,
              let code else {
            throw LauncherSelectionError.untrustedSelection
        }
        let valid = SecStaticCodeCheckValidity(code, validationFlags, nil) == errSecSuccess
        var signingInformation: CFDictionary?
        guard SecCodeCopySigningInformation(
            code,
            SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)),
            &signingInformation
        ) == errSecSuccess,
            let information = signingInformation as? [String: Any],
            let bundleIdentifier = information[kSecCodeInfoIdentifier as String] as? String,
            let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
            let flags = information[kSecCodeInfoFlags as String] as? NSNumber else {
            throw LauncherSelectionError.untrustedSelection
        }
        return (
            bundleIdentifier,
            teamIdentifier,
            flags.uint32Value & hardenedRuntimeSigningFlag != 0,
            valid
        )
    }

    private static func validateOwnedNode(
        _ url: URL,
        expectedType: mode_t,
        exactMode: mode_t?
    ) throws {
        var metadata = stat()
        guard url.isFileURL,
              Darwin.lstat(url.path, &metadata) == 0,
              metadata.st_mode & S_IFMT == expectedType,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o022 == 0,
              exactMode.map({ metadata.st_mode & 0o777 == $0 }) ?? true,
              expectedType != S_IFREG || metadata.st_nlink == 1 else {
            throw LauncherSelectionError.untrustedSelection
        }
    }

    private static func exactPositiveInteger(_ value: Any?) -> Int64? {
        ReleaseContractValidation.positiveSafeInteger(value)
    }

    private static func exact(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.isFileURL &&
            rhs.isFileURL &&
            lhs.standardizedFileURL.path == rhs.standardizedFileURL.path
    }
}

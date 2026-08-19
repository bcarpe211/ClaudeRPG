import Darwin
import Foundation
import Security

public enum InstallerMigrationValidationError: Error, Equatable {
    case invalidStatus
    case protectedStateUnsafe
    case invalidLegacyInstallation
}

public struct InstallerLegacyStatusSnapshot: Equatable, Sendable {
    public let enabled: Bool
    public let queuedEventCount: Int
}

public enum InstallerStatusValidator {
    public static let maximumStatusBytes = 16 * 1_024

    private struct LegacyStatus: Decodable {
        let enabled: Bool
        let daemonRunning: Bool
        let persistedState: PersistedCollectorState
        let serverEnabledSurfaces: [RunSurface]
        let compiledAdapters: [RunSurface: AdapterHealth]
        let queuedEventCount: Int
        let lastSuccessfulUploadMS: Int64?
        let activeRunCount: Int
        let installedCompanionVersion: String
        let installedReleaseSequence: Int64
        let availableCompanionVersion: String?
        let availableReleaseSequence: Int64?
        let updateCommand: String?
        let preparedForUpdate: Bool
    }

    private static let legacyKeys: Set<String> = [
        "activeRunCount", "availableCompanionVersion", "availableReleaseSequence",
        "compiledAdapters", "daemonRunning", "enabled", "installedCompanionVersion",
        "installedReleaseSequence", "lastSuccessfulUploadMS", "persistedState",
        "preparedForUpdate", "queuedEventCount", "serverEnabledSurfaces", "updateCommand",
    ]
    private static let legacyOptionalKeys: Set<String> = [
        "availableCompanionVersion", "availableReleaseSequence",
        "lastSuccessfulUploadMS", "updateCommand",
    ]
    private static let legacyRequiredKeys = legacyKeys.subtracting(legacyOptionalKeys)
    private static let candidateKeys: Set<String> = [
        "activeRunCount", "activationState", "availableCompanionVersion", "compiledAdapters",
        "daemonRunning", "enabled", "installedCompanionVersion", "installedReleaseSequence",
        "lastSuccessfulUploadMS", "persistedState", "queuedEventCount",
        "serverEnabledSurfaces", "updateCommand",
    ]
    private static let expectedSurfaces: [RunSurface] = [.codexCLI, .codexDesktop]
    private static let expectedAdapters: Set<RunSurface> = [
        .claudeCode, .omp, .codexDesktop, .codexCLI,
    ]

    @discardableResult
    public static func validateLegacy(
        _ data: Data,
        prepared: Bool,
        expectedEnabled: Bool?
    ) throws -> Bool {
        try inspectLegacy(
            data,
            prepared: prepared,
            expectedEnabled: expectedEnabled
        ).enabled
    }

    public static func inspectLegacy(
        _ data: Data,
        prepared: Bool,
        expectedEnabled: Bool?
    ) throws -> InstallerLegacyStatusSnapshot {
        let body = try strictBody(
            data,
            requiredKeys: legacyRequiredKeys,
            optionalKeys: legacyOptionalKeys
        )
        guard let status = try? JSONDecoder().decode(LegacyStatus.self, from: body),
              validLegacyCommon(
                enabled: status.enabled,
                daemonRunning: status.daemonRunning,
                persistedState: status.persistedState,
                surfaces: status.serverEnabledSurfaces,
                adapters: status.compiledAdapters,
                queuedCount: status.queuedEventCount,
                lastUpload: status.lastSuccessfulUploadMS,
                activeRunCount: status.activeRunCount,
                availableVersion: status.availableCompanionVersion,
                availableSequence: status.availableReleaseSequence,
                updateCommand: status.updateCommand,
                installedSequence: status.installedReleaseSequence
              ),
              status.installedCompanionVersion == "0.2.6",
              status.installedReleaseSequence == 8,
              status.preparedForUpdate == prepared,
              expectedEnabled == nil || status.enabled == expectedEnabled else {
            throw InstallerMigrationValidationError.invalidStatus
        }
        return InstallerLegacyStatusSnapshot(
            enabled: status.enabled,
            queuedEventCount: status.queuedEventCount
        )
    }

    public static func validateCandidate(
        _ data: Data,
        identity: CompanionReleaseIdentity,
        generation: Int64,
        prepared: Bool,
        expectedEnabled: Bool,
        expectedQueuedEventCount: Int = 0
    ) throws {
        let body = try strictBody(data, requiredKeys: candidateKeys)
        guard (try? identity.releaseReference()) != nil,
              identity.updateProtocolVersion == 2,
              (1...ReleaseContractValidation.maximumSafeInteger).contains(generation),
              expectedQueuedEventCount >= 0,
              let status = try? JSONDecoder().decode(AgentStatus.self, from: body),
              validCommon(
                enabled: status.enabled,
                daemonRunning: status.daemonRunning,
                persistedState: status.persistedState,
                surfaces: status.serverEnabledSurfaces,
                adapters: status.compiledAdapters,
                queuedCount: status.queuedEventCount,
                lastUpload: status.lastSuccessfulUploadMS,
                activeRunCount: status.activeRunCount,
                availableVersion: status.availableCompanionVersion,
                updateCommand: status.updateCommand,
                installedSequence: status.installedReleaseSequence
              ),
              status.installedCompanionVersion == identity.companionVersion,
              status.installedReleaseSequence == identity.releaseSequence,
              status.enabled == expectedEnabled,
              status.enabled == (status.activationState != .disabled),
              status.queuedEventCount == expectedQueuedEventCount else {
            throw InstallerMigrationValidationError.invalidStatus
        }
    }

    private static func strictBody(
        _ data: Data,
        requiredKeys: Set<String>,
        optionalKeys: Set<String> = []
    ) throws -> Data {
        guard !data.isEmpty,
              data.count <= maximumStatusBytes,
              data.last == 0x0A else {
            throw InstallerMigrationValidationError.invalidStatus
        }
        let body = Data(data.dropLast())
        guard !body.isEmpty,
              !body.contains(0x0A),
              let text = String(data: body, encoding: .utf8),
              let object = try? JSONSerialization.jsonObject(with: body),
              let dictionary = object as? [String: Any],
              requiredKeys.isSubset(of: Set(dictionary.keys)),
              Set(dictionary.keys).isSubset(of: requiredKeys.union(optionalKeys)),
              compactAndUniqueTopLevelFields(text, keys: Set(dictionary.keys)) else {
            throw InstallerMigrationValidationError.invalidStatus
        }
        return body
    }

    private static func compactAndUniqueTopLevelFields(
        _ text: String,
        keys: Set<String>
    ) -> Bool {
        let bytes = Array(text.utf8)
        var quoted = false
        var escaped = false
        var objectDepth = 0
        var arrayDepth = 0
        var stringStart: Int?
        var topLevelFields: [String] = []
        for (index, byte) in bytes.enumerated() {
            if quoted {
                if escaped { escaped = false }
                else if byte == 0x5C { escaped = true }
                else if byte == 0x22 {
                    quoted = false
                    if objectDepth == 1,
                       arrayDepth == 0,
                       index + 1 < bytes.count,
                       bytes[index + 1] == 0x3A,
                       let start = stringStart,
                       let field = try? JSONDecoder().decode(
                           String.self,
                           from: Data(bytes[start...index])
                       ) {
                        topLevelFields.append(field)
                    }
                    stringStart = nil
                }
            } else if byte == 0x22 {
                quoted = true
                stringStart = index
            } else if [0x09, 0x0A, 0x0D, 0x20].contains(byte) {
                return false
            } else if byte == 0x7B {
                objectDepth += 1
            } else if byte == 0x7D {
                objectDepth -= 1
                if objectDepth < 0 { return false }
            } else if byte == 0x5B {
                arrayDepth += 1
            } else if byte == 0x5D {
                arrayDepth -= 1
                if arrayDepth < 0 { return false }
            }
        }
        guard !quoted, !escaped, objectDepth == 0, arrayDepth == 0 else { return false }
        return topLevelFields.count == keys.count && Set(topLevelFields) == keys
    }

    private static func validLegacyCommon(
        enabled: Bool,
        daemonRunning: Bool,
        persistedState: PersistedCollectorState,
        surfaces: [RunSurface],
        adapters: [RunSurface: AdapterHealth],
        queuedCount: Int,
        lastUpload: Int64?,
        activeRunCount: Int,
        availableVersion: String?,
        availableSequence: Int64?,
        updateCommand: String?,
        installedSequence: Int64
    ) -> Bool {
        guard validBase(
            enabled: enabled, daemonRunning: daemonRunning, persistedState: persistedState,
            surfaces: surfaces, adapters: adapters, queuedCount: queuedCount,
            lastUpload: lastUpload, activeRunCount: activeRunCount
        ) else { return false }
        switch (availableVersion, availableSequence, updateCommand) {
        case (nil, nil, nil): return true
        case let (.some(version), .some(sequence), .some(command)):
            return !version.isEmpty && sequence > installedSequence && command == "raiders update"
        default: return false
        }
    }

    private static func validCommon(
        enabled: Bool,
        daemonRunning: Bool,
        persistedState: PersistedCollectorState,
        surfaces: [RunSurface],
        adapters: [RunSurface: AdapterHealth],
        queuedCount: Int,
        lastUpload: Int64?,
        activeRunCount: Int,
        availableVersion: String?,
        updateCommand: String?,
        installedSequence: Int64
    ) -> Bool {
        guard validBase(
            enabled: enabled, daemonRunning: daemonRunning, persistedState: persistedState,
            surfaces: surfaces, adapters: adapters, queuedCount: queuedCount,
            lastUpload: lastUpload, activeRunCount: activeRunCount
        ) else { return false }
        switch (availableVersion, updateCommand) {
        case (nil, nil):
            return true
        case let (.some(version), .some(command)):
            return (try? SemanticVersion(version)) != nil && command == "raiders update"
        default:
            return false
        }
    }

    private static func validBase(
        enabled: Bool,
        daemonRunning: Bool,
        persistedState: PersistedCollectorState,
        surfaces: [RunSurface],
        adapters: [RunSurface: AdapterHealth],
        queuedCount: Int,
        lastUpload: Int64?,
        activeRunCount: Int
    ) -> Bool {
        daemonRunning &&
            activeRunCount == 0 &&
            queuedCount >= 0 &&
            persistedState == (enabled ? .enabled : .disabled) &&
            surfaces == expectedSurfaces &&
            Set(adapters.keys) == expectedAdapters &&
            adapters.values.allSatisfy({ [.available, .disabled, .unavailable].contains($0) }) &&
            (lastUpload == nil || lastUpload! >= 0)
    }
}

typealias ControlPeerIdentity = ControlSocketClient.PeerIdentity

struct InstallerDynamicCodeIdentityValidator {
    func matches(peer: ControlPeerIdentity, expectedExecutable: URL) -> Bool {
        guard peer.auditToken.count == MemoryLayout<audit_token_t>.size,
              peer.auditToken.contains(where: { $0 != 0 }) else {
            return false
        }
        var guest: SecCode?
        let attributes = [kSecGuestAttributeAudit as String: peer.auditToken] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
              let guest else {
            return false
        }
        var expectedStaticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(
            expectedExecutable.standardizedFileURL as CFURL,
            [],
            &expectedStaticCode
        ) == errSecSuccess,
        let expectedStaticCode else {
            return false
        }
        var expectedRequirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(
            expectedStaticCode,
            [],
            &expectedRequirement
        ) == errSecSuccess,
        let expectedRequirement,
        SecStaticCodeCheckValidity(
            expectedStaticCode,
            Self.staticValidationFlags,
            expectedRequirement
        ) == errSecSuccess,
        SecCodeCheckValidity(
            guest,
            Self.dynamicValidationFlags,
            expectedRequirement
        ) == errSecSuccess else {
            return false
        }
        var guestStaticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(guest, [], &guestStaticCode) == errSecSuccess,
              let guestStaticCode,
              let expectedHashes = signingHashes(for: expectedStaticCode),
              let guestHash = signingHash(for: guestStaticCode),
              expectedHashes.contains(guestHash) else {
            return false
        }
        return true
    }

    private func signingHashes(for code: SecStaticCode) -> Set<Data>? {
        guard let information = signingInformation(for: code),
              let unique = information[kSecCodeInfoUnique as String] as? Data else {
            return nil
        }
        var hashes: Set<Data> = [unique]
        if let allHashes = information[kSecCodeInfoCdHashes as String] as? [Data] {
            hashes.formUnion(allHashes)
        }
        return hashes
    }

    private func signingHash(for code: SecStaticCode) -> Data? {
        signingInformation(for: code)?[kSecCodeInfoUnique as String] as? Data
    }

    private func signingInformation(for code: SecStaticCode) -> [String: Any]? {
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(
            code,
            SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)),
            &information
        ) == errSecSuccess else {
            return nil
        }
        return information as? [String: Any]
    }

    private static let staticValidationFlags = SecCSFlags(rawValue:
        UInt32(kSecCSStrictValidate) |
            UInt32(kSecCSRestrictSymlinks)
    )

    private static let dynamicValidationFlags = SecCSFlags(rawValue: UInt32(kSecCSStrictValidate))
}

public struct InstallerDaemonStatusAttestor {
    typealias Exchange = (
        _ request: ControlRequest,
        _ socketURL: URL,
        _ maximumFrameBytes: Int
    ) throws -> (ControlResponse, ControlPeerIdentity)
    typealias DynamicIdentityValidator = (
        _ peer: ControlPeerIdentity,
        _ expectedExecutable: URL
    ) -> Bool

    private let exchange: Exchange
    private let dynamicIdentityValidator: DynamicIdentityValidator

    public init() {
        exchange = { request, socketURL, maximumFrameBytes in
            try ControlSocketClient.sendAttested(
                request: request,
                to: socketURL,
                maximumFrameBytes: maximumFrameBytes
            )
        }
        dynamicIdentityValidator = { peer, expectedExecutable in
            InstallerDynamicCodeIdentityValidator().matches(
                peer: peer,
                expectedExecutable: expectedExecutable
            )
        }
    }

    init(
        exchange: @escaping Exchange,
        dynamicIdentityValidator: @escaping DynamicIdentityValidator
    ) {
        self.exchange = exchange
        self.dynamicIdentityValidator = dynamicIdentityValidator
    }

    public func status(paths: AgentPaths, expectedExecutable: URL) throws -> Data {
        do {
            let (response, peer) = try exchange(
                ControlRequest(command: .status),
                paths.controlSocket,
                InstallerStatusValidator.maximumStatusBytes
            )
            guard response.ok,
                  peer.auditToken.count == MemoryLayout<audit_token_t>.size,
                  let admittedIdentity = exactExecutableIdentity(
                      peer.executableURL,
                      expectedExecutable
                  ),
                  dynamicIdentityValidator(peer, expectedExecutable),
                  exactExecutableIdentity(
                      peer.executableURL,
                      expectedExecutable
                  ) == admittedIdentity else {
                throw InstallerMigrationValidationError.invalidStatus
            }
            var data = Data(response.message.utf8)
            data.append(0x0A)
            guard data.count <= InstallerStatusValidator.maximumStatusBytes else {
                throw InstallerMigrationValidationError.invalidStatus
            }
            return data
        } catch {
            throw InstallerMigrationValidationError.invalidStatus
        }
    }

    private struct ExecutableIdentity: Equatable {
        let device: dev_t
        let inode: ino_t
        let mode: mode_t
        let owner: uid_t
        let linkCount: nlink_t
    }

    private func exactExecutableIdentity(
        _ observed: URL,
        _ expected: URL
    ) -> ExecutableIdentity? {
        guard observed.isFileURL,
              expected.isFileURL,
              observed.standardizedFileURL.path == expected.standardizedFileURL.path else {
            return nil
        }
        var observedMetadata = stat()
        var expectedMetadata = stat()
        guard observed.path.withCString({ Darwin.lstat($0, &observedMetadata) }) == 0 &&
            expected.path.withCString({ Darwin.lstat($0, &expectedMetadata) }) == 0 &&
            observedMetadata.st_mode & S_IFMT == S_IFREG &&
            expectedMetadata.st_mode & S_IFMT == S_IFREG &&
            observedMetadata.st_dev == expectedMetadata.st_dev &&
            observedMetadata.st_ino == expectedMetadata.st_ino &&
            observedMetadata.st_uid == Darwin.geteuid() &&
            expectedMetadata.st_uid == Darwin.geteuid() &&
            observedMetadata.st_nlink == 1 &&
            expectedMetadata.st_nlink == 1 &&
            observedMetadata.st_mode & 0o111 != 0 &&
            expectedMetadata.st_mode & 0o111 != 0 else {
            return nil
        }
        return ExecutableIdentity(
            device: observedMetadata.st_dev,
            inode: observedMetadata.st_ino,
            mode: observedMetadata.st_mode,
            owner: observedMetadata.st_uid,
            linkCount: observedMetadata.st_nlink
        )
    }
}

public enum InstallerProtectedStateSnapshot {
    private static let header = Data("runtime-raiders-protected-state-v2\n".utf8)
    private static let exclusions: Set<String> = [
        "command-link", "path-marker-owned", "update-state.lock",
    ]
    // Covers the 50 MiB production outbox plus protected state and exact framing overhead.
    public static let maximumSerializedBytes = 128 * 1_024 * 1_024
    private static let maximumEntryCount = 16_384

    public static func capture(
        paths: AgentPaths,
        maximumSerializedBytes requestedMaximum: Int = maximumSerializedBytes
    ) throws -> Data {
        do {
            guard requestedMaximum >= header.count,
                  requestedMaximum <= maximumSerializedBytes else {
                throw InstallerMigrationValidationError.protectedStateUnsafe
            }
            let snapshot = try ProtectedStateSnapshot.capture(
                paths: paths,
                includeUpdateState: true,
                additionalStateExclusions: exclusions,
                maximumCapturedBytes: requestedMaximum - header.count,
                maximumEntryCount: maximumEntryCount
            )
            var output = header
            for (path, data) in snapshot.entries.sorted(by: { $0.key < $1.key }) {
                let pathBytes = Data(path.utf8)
                let entryHeader = Data("\(pathBytes.count):\(data.count)\n".utf8)
                let (entryBytes, entryOverflow) = entryHeader.count.addingReportingOverflow(
                    pathBytes.count
                )
                let (entryAndData, dataOverflow) = entryBytes.addingReportingOverflow(data.count)
                let (serializedBytes, totalOverflow) = output.count.addingReportingOverflow(
                    entryAndData
                )
                guard !entryOverflow, !dataOverflow, !totalOverflow,
                      serializedBytes <= requestedMaximum else {
                    throw InstallerMigrationValidationError.protectedStateUnsafe
                }
                output.append(entryHeader)
                output.append(pathBytes)
                output.append(data)
            }
            return output
        } catch {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
    }
}

public enum InstallerMigrationSyncTarget: String, Sendable {
    case stagingTree = "staging-tree"
    case stagingTombstoneTree = "staging-tombstone-tree"
    case activeJournal = "active-journal"
    case activeReleaseState = "active-release-state"
    case supportDirectory = "support-directory"
}

public enum InstallerMigrationDurability {
    private static let maximumEntries = 16_384
    private static let maximumTreeBytes: Int64 = 512 * 1_024 * 1_024

    public static func synchronize(
        paths: AgentPaths,
        target: InstallerMigrationSyncTarget
    ) throws {
        let support = paths.supportDirectory
        switch target {
        case .stagingTree:
            var entries = 0
            var bytes: Int64 = 0
            try synchronizeTree(
                support.appendingPathComponent(".migration-v1.staging", isDirectory: true),
                entries: &entries,
                bytes: &bytes
            )
        case .stagingTombstoneTree:
            var entries = 0
            var bytes: Int64 = 0
            try synchronizeTree(
                support.appendingPathComponent(
                    ".migration-v1.staging-tombstone",
                    isDirectory: true
                ),
                entries: &entries,
                bytes: &bytes
            )
        case .activeJournal:
            let active = support.appendingPathComponent(".migration-v1", isDirectory: true)
            try synchronizeRegularFile(active.appendingPathComponent("journal.json"), maximumBytes: 16_384)
            try synchronizeDirectory(active)
        case .activeReleaseState:
            try synchronizeRegularFile(paths.releaseState, maximumBytes: 16_384)
            try synchronizeDirectory(paths.installationDirectory)
        case .supportDirectory:
            try synchronizeDirectory(support)
        }
    }

    private static func synchronizeTree(
        _ url: URL,
        entries: inout Int,
        bytes: inout Int64
    ) throws {
        var metadata = stat()
        guard url.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o022 == 0 else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
        entries += 1
        guard entries <= maximumEntries else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
        switch metadata.st_mode & S_IFMT {
        case S_IFREG:
            guard metadata.st_nlink == 1, metadata.st_size >= 0 else {
                throw InstallerMigrationValidationError.protectedStateUnsafe
            }
            let (newBytes, overflow) = bytes.addingReportingOverflow(metadata.st_size)
            guard !overflow, newBytes <= maximumTreeBytes else {
                throw InstallerMigrationValidationError.protectedStateUnsafe
            }
            bytes = newBytes
            try synchronizeRegularFile(url, maximumBytes: Int(maximumTreeBytes))
        case S_IFDIR:
            let children = try FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: nil,
                options: []
            ).sorted { $0.lastPathComponent < $1.lastPathComponent }
            for child in children {
                try synchronizeTree(child, entries: &entries, bytes: &bytes)
            }
            try synchronizeDirectory(url)
        default:
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
    }

    private static func synchronizeRegularFile(_ url: URL, maximumBytes: Int) throws {
        var metadata = stat()
        guard url.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o022 == 0,
              metadata.st_nlink == 1,
              metadata.st_size >= 0,
              metadata.st_size <= maximumBytes else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
    }

    private static func synchronizeDirectory(_ url: URL) throws {
        var metadata = stat()
        guard url.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o022 == 0 else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw InstallerMigrationValidationError.protectedStateUnsafe
        }
    }
}

public struct LegacySequenceEightInstallationValidator {
    public typealias SignatureInspector = (URL, String) throws -> CandidateSignatureFacts
    public typealias IdentityLoader = (URL) throws -> CompanionReleaseIdentity

    private let signatureInspector: SignatureInspector
    private let identityLoader: IdentityLoader
    private let applicationMode: mode_t
    private let canaryCommandLink: SequenceEightCanaryCommandLink?

    public init() {
        signatureInspector = { application, team in
            try SignedBundleTrustInspector().inspect(
                candidate: application,
                expectedTeamIdentifier: team
            )
        }
        identityLoader = { application in
            guard let bundle = Bundle(url: application) else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            return try CompanionReleaseIdentity.load(from: bundle)
        }
        applicationMode = 0o700
        canaryCommandLink = SequenceEightCanaryCommandLink()
    }

    init(
        signatureInspector: @escaping SignatureInspector,
        identityLoader: @escaping IdentityLoader,
        applicationMode: mode_t = 0o755,
        canaryCommandLink: SequenceEightCanaryCommandLink? = nil
    ) {
        self.signatureInspector = signatureInspector
        self.identityLoader = identityLoader
        self.applicationMode = applicationMode
        self.canaryCommandLink = canaryCommandLink
    }

    public func validate(
        homeDirectory: URL,
        paths: AgentPaths,
        expectedTeamIdentifier: String,
        pathEnvironment: String? = ProcessInfo.processInfo.environment["PATH"]
    ) throws {
        do {
            let home = homeDirectory
            let expectedSupport = home
                .appendingPathComponent("Library/Application Support", isDirectory: true)
                .appendingPathComponent("Runtime Raiders", isDirectory: true)
            guard paths.supportDirectory.standardizedFileURL == expectedSupport.standardizedFileURL,
                  validTeamIdentifier(expectedTeamIdentifier) else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            let library = home.appendingPathComponent("Library", isDirectory: true)
            let applicationSupport = library.appendingPathComponent(
                "Application Support", isDirectory: true
            )
            let launchAgents = library.appendingPathComponent("LaunchAgents", isDirectory: true)
            try requireDirectory(home, mode: nil)
            try requireDirectory(library, mode: nil)
            try requireDirectory(applicationSupport, mode: nil)
            try requireDirectory(launchAgents, mode: nil)
            try requireDirectory(paths.supportDirectory, mode: 0o700)
            try requireDirectory(paths.stateDirectory, mode: 0o700)
            try requireDirectory(paths.outboxDirectory, mode: 0o700)

            let application = paths.legacyFlatApplication
            let contents = application.appendingPathComponent("Contents", isDirectory: true)
            let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
            let executable = macOS.appendingPathComponent(
                "runtime-raiders-agent",
                isDirectory: false
            )
            let info = contents.appendingPathComponent("Info.plist", isDirectory: false)
            try requireDirectory(application, mode: applicationMode)
            try requireDirectory(contents, mode: 0o755)
            try requireDirectory(macOS, mode: 0o755)
            try requireRegularFile(executable, mode: 0o755)
            try requireRegularFile(info, mode: 0o644)
            let applicationSeal = try ReleaseApplicationSeal.capture(application)

            let expectedIdentity = CompanionReleaseIdentity(
                releaseSequence: 8,
                releaseSHA: "dec88d4f6ff600f2be92bed3b12dcfce85f84a51",
                companionVersion: "0.2.6",
                updateProtocolVersion: 1
            )
            guard try identityLoader(application) == expectedIdentity else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            let facts = try signatureInspector(application, expectedTeamIdentifier)
            guard facts.bundleIdentifier == "com.redlattice.runtime-raiders-agent",
                  facts.teamIdentifier == expectedTeamIdentifier,
                  facts.signatureValid,
                  facts.allArchitecturesValid,
                  facts.requiredArchitecturesPresent,
                  facts.hardenedRuntime,
                  facts.secureTimestampPresent,
                  facts.gatekeeperNotarized else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            guard try ReleaseApplicationSeal.capture(application) == applicationSeal else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }

            let plist = launchAgents.appendingPathComponent(
                "com.redlattice.runtime-raiders-agent.plist",
                isDirectory: false
            )
            let shim = paths.supportDirectory.appendingPathComponent("raiders", isDirectory: false)
            let commandRecord = paths.stateDirectory.appendingPathComponent(
                "command-link",
                isDirectory: false
            )
            try requireExactFile(
                plist,
                mode: 0o600,
                expected: canonicalPlist(executable: executable.path)
            )
            try requireExactFile(
                shim,
                mode: 0o700,
                expected: canonicalShim(
                    home: home.path,
                    support: paths.supportDirectory.path,
                    executable: executable.path,
                    commandRecord: commandRecord.path
                )
            )
            try requireRegularFile(commandRecord, mode: 0o600)
            let record = try readRegularFile(
                commandRecord,
                mode: 0o600,
                maximumBytes: 4_096
            )
            guard record.count >= 2,
                  record.last == 0x0A,
                  !record.dropLast().contains(where: { $0 < 0x20 || $0 == 0x7F }),
                  let commandPath = String(data: record.dropLast(), encoding: .utf8),
                  commandPath.hasPrefix("/"),
                  !commandPath.hasSuffix("/"),
                  !commandPath.contains("//"),
                  commandPath.split(separator: "/").allSatisfy({ $0 != "." && $0 != ".." }) else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            let command = URL(fileURLWithPath: commandPath, isDirectory: false)
            guard command.path == commandPath,
                  command.lastPathComponent == "raiders" else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            if let canaryCommandLink {
                _ = try canaryCommandLink.validate(
                    recordedCommandPath: commandPath,
                    expectedShim: shim
                )
            } else {
                let commandDirectory = command.deletingLastPathComponent()
                try requireCommandParentChain(commandDirectory)
                try requireCommandDirectoryInCurrentPATH(
                    commandDirectory,
                    home: home,
                    pathEnvironment: pathEnvironment
                )
                try requireSymlink(command, target: shim.path)
            }
        } catch {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
    }

    private func requireExactFile(_ url: URL, mode: mode_t, expected: String) throws {
        let actual = try readRegularFile(url, mode: mode, maximumBytes: 1_048_576)
        guard actual == Data(expected.utf8) else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
    }

    private func readRegularFile(
        _ url: URL,
        mode: mode_t,
        maximumBytes: Int
    ) throws -> Data {
        var initial = stat()
        guard url.path.withCString({ Darwin.lstat($0, &initial) }) == 0,
              initial.st_mode & S_IFMT == S_IFREG,
              initial.st_uid == Darwin.geteuid(),
              initial.st_mode & 0o7777 == mode,
              initial.st_nlink == 1,
              initial.st_size >= 0,
              initial.st_size <= maximumBytes else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        defer { Darwin.close(descriptor) }
        var current = stat()
        guard Darwin.fstat(descriptor, &current) == 0,
              current.st_dev == initial.st_dev,
              current.st_ino == initial.st_ino,
              current.st_mode == initial.st_mode,
              current.st_uid == initial.st_uid,
              current.st_nlink == initial.st_nlink,
              current.st_size == initial.st_size else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        var data = Data(count: Int(current.st_size))
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                let count = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0, errno == EINTR { continue }
                else { throw InstallerMigrationValidationError.invalidLegacyInstallation }
            }
        }
        var final = stat()
        guard Darwin.fstat(descriptor, &final) == 0,
              final.st_dev == current.st_dev,
              final.st_ino == current.st_ino,
              final.st_mode == current.st_mode,
              final.st_uid == current.st_uid,
              final.st_nlink == current.st_nlink,
              final.st_size == current.st_size else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        return data
    }

    private func requireRegularFile(_ url: URL, mode: mode_t) throws {
        var metadata = stat()
        guard url.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o7777 == mode,
              metadata.st_nlink == 1 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        Darwin.close(descriptor)
    }

    private func requireDirectory(_ url: URL, mode: mode_t?) throws {
        var metadata = stat()
        guard url.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
              metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_mode & 0o022 == 0,
              mode == nil || metadata.st_mode & 0o7777 == mode else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        let descriptor = url.path.withCString {
            Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        Darwin.close(descriptor)
    }

    private func requireCommandParentChain(_ directory: URL) throws {
        guard directory.isFileURL,
              directory.path.hasPrefix("/"),
              !directory.path.contains("//"),
              directory.path.split(separator: "/").allSatisfy({
                  $0 != "." && $0 != ".."
              }) else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        var current = URL(fileURLWithPath: "/", isDirectory: true)
        let components = directory.pathComponents.dropFirst()
        for (index, component) in components.enumerated() {
            current.appendPathComponent(component, isDirectory: true)
            var metadata = stat()
            guard current.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
                  metadata.st_mode & S_IFMT == S_IFDIR,
                  metadata.st_nlink >= 1 else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            let writableByOthers = metadata.st_mode & 0o022 != 0
            guard !writableByOthers || metadata.st_mode & S_ISVTX != 0 else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            if metadata.st_uid == Darwin.geteuid() {
                guard metadata.st_mode & 0o022 == 0,
                      metadata.st_mode & 0o100 != 0 else {
                    throw InstallerMigrationValidationError.invalidLegacyInstallation
                }
            }
            if index == components.count - 1 {
                guard metadata.st_uid == Darwin.geteuid(),
                      metadata.st_mode & 0o300 == 0o300 else {
                    throw InstallerMigrationValidationError.invalidLegacyInstallation
                }
            }
            let descriptor = current.path.withCString {
                Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard descriptor >= 0 else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            Darwin.close(descriptor)
        }
    }

    private func requireCommandDirectoryInCurrentPATH(
        _ commandDirectory: URL,
        home: URL,
        pathEnvironment: String?
    ) throws {
        let homePath = home.path
        let commandPath = commandDirectory.path
        guard commandPath.hasPrefix(homePath + "/"),
              let pathEnvironment,
              !pathEnvironment.isEmpty,
              pathEnvironment.utf8.count <= 16_384 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        let rawComponents = pathEnvironment.split(separator: ":", omittingEmptySubsequences: false)
        guard !rawComponents.isEmpty, rawComponents.count <= 256 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        var seen: Set<String> = []
        var commandMatches = 0
        for rawComponent in rawComponents {
            let component = String(rawComponent)
            guard !component.isEmpty,
                  component.hasPrefix("/"),
                  !component.hasSuffix("/"),
                  !component.contains("//"),
                  component.utf8.allSatisfy({ $0 >= 0x20 && $0 != 0x7F }),
                  component.split(separator: "/").allSatisfy({ $0 != "." && $0 != ".." }),
                  seen.insert(component).inserted else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            let directory = URL(fileURLWithPath: component, isDirectory: true)
            guard directory.path == component else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            try requireStrictPATHDirectory(directory)
            if component == commandPath { commandMatches += 1 }
        }
        guard commandMatches == 1 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
    }

    private func requireStrictPATHDirectory(_ directory: URL) throws {
        var current = URL(fileURLWithPath: "/", isDirectory: true)
        let components = directory.pathComponents.dropFirst()
        guard !components.isEmpty else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        for component in components {
            current.appendPathComponent(component, isDirectory: true)
            var metadata = stat()
            guard current.path.withCString({ Darwin.lstat($0, &metadata) }) == 0,
                  metadata.st_mode & S_IFMT == S_IFDIR,
                  metadata.st_nlink >= 1,
                  metadata.st_mode & 0o111 != 0,
                  metadata.st_uid == 0 || metadata.st_uid == Darwin.geteuid() else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            let writableByOthers = metadata.st_mode & 0o022 != 0
            guard !writableByOthers ||
                    (metadata.st_uid == 0 && metadata.st_mode & S_ISVTX != 0),
                  metadata.st_uid != Darwin.geteuid() || !writableByOthers else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            let descriptor = current.path.withCString {
                Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard descriptor >= 0 else {
                throw InstallerMigrationValidationError.invalidLegacyInstallation
            }
            Darwin.close(descriptor)
        }
    }

    private func requireSymlink(_ url: URL, target: String) throws {
        var initial = stat()
        guard url.path.withCString({ Darwin.lstat($0, &initial) }) == 0,
              initial.st_mode & S_IFMT == S_IFLNK,
              initial.st_uid == Darwin.geteuid(),
              initial.st_nlink == 1 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
        let count = url.path.withCString { path in
            Darwin.readlink(path, &buffer, buffer.count - 1)
        }
        guard count >= 0 else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
        let destination = String(
            decoding: buffer.prefix(Int(count)).map { UInt8(bitPattern: $0) },
            as: UTF8.self
        )
        var final = stat()
        guard url.path.withCString({ Darwin.lstat($0, &final) }) == 0,
              final.st_dev == initial.st_dev,
              final.st_ino == initial.st_ino,
              final.st_mode == initial.st_mode,
              final.st_uid == initial.st_uid,
              final.st_nlink == initial.st_nlink,
              destination == target else {
            throw InstallerMigrationValidationError.invalidLegacyInstallation
        }
    }

    private func validTeamIdentifier(_ value: String) -> Bool {
        value.utf8.count == 10 && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte)
        }
    }

    private func canonicalPlist(executable: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>com.redlattice.runtime-raiders-agent</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(executable)</string>
            <string>daemon</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>ProcessType</key>
          <string>Background</string>
        </dict>
        </plist>
        """ + "\n"
    }

    private func canonicalShim(
        home: String,
        support: String,
        executable: String,
        commandRecord: String
    ) -> String {
        let plist = home + "/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist"
        let shim = support + "/raiders"
        let markerFlag = support + "/state/path-marker-owned"
        return """
        #!/bin/sh
        set -eu
        SUPPORT='\(support)'
        PLIST='\(plist)'
        SHIM='\(shim)'
        COMMAND_LINK_FILE='\(commandRecord)'
        MARKER_FLAG='\(markerFlag)'
        MARKER='export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path'
        LABEL='com.redlattice.runtime-raiders-agent'
        binary='\(executable)'
        job_absent() {
          output="$(mktemp /tmp/runtime-raiders-launchctl.XXXXXX)"
          if launchctl print "gui/$(id -u)/$LABEL" >"$output" 2>&1; then
            rm -f "$output"
            return 1
          else
            print_status=$?
          fi
          [ "$print_status" -eq 113 ] || { rm -f "$output"; return 1; }
          grep -F 'Could not find service' "$output" >/dev/null 2>&1
          status=$?
          rm -f "$output"
          return $status
        }
        if [ "$#" -eq 0 ] || [ "$1" != uninstall ]; then
          exec "$binary" "$@"
        fi
        if "$binary" uninstall; then
          launchctl bootout "gui/$(id -u)" "$PLIST" || {
            echo "Runtime Raiders bootout failed; refusing cleanup" >&2
            exit 1
          }
          job_absent || {
            echo "Runtime Raiders launchd job still present; refusing cleanup" >&2
            exit 1
          }
        elif [ ! -S "$SUPPORT/agent.sock" ] && job_absent; then
          :
        else
          echo "Runtime Raiders daemon did not safely stop; refusing cleanup" >&2
          exit 1
        fi
        if [ -f "$COMMAND_LINK_FILE" ]; then
          command_path="$(cat "$COMMAND_LINK_FILE")"
          if [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ]; then
            rm -f "$command_path"
          fi
        fi
        profile="$HOME/.zprofile"
        if [ -f "$MARKER_FLAG" ] && [ -f "$profile" ]; then
          temporary="$(mktemp "$profile.runtime-raiders.XXXXXX")"
          awk -v marker="$MARKER" 'seen == 0 && $0 == marker { seen = 1; next } { print }' "$profile" > "$temporary"
          mv "$temporary" "$profile"
        fi
        rm -f "$PLIST"
        rm -rf "$SUPPORT"
        """ + "\n"
    }
}

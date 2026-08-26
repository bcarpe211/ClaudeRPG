import Darwin
import CryptoKit
import Foundation

@_silgen_name("flock")
private func removalFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

public enum OwnedInstallationRemovalError: Error, Equatable,
    CustomStringConvertible, CustomDebugStringConvertible {
    case invalidInstallation

    public var description: String { "Runtime Raiders installation removal was refused" }
    public var debugDescription: String { description }
}

public struct OwnedInstallationRemover: @unchecked Sendable {
    typealias MetadataTransform = (_ relativePath: String, _ metadata: stat) -> stat
    typealias ValidationCheckpoint = () throws -> Void
    typealias RemovalObserver = (_ relativePath: String) throws -> Void

    private static let supportNames: Set<String> = [
        "Runtime Raiders.app", "raiders", "state", "outbox", "agent.sock",
        ".agent.sock.runtime-raiders.lock",
        "releases", "installation", "launcher",
    ]
    private static let executableNames: Set<String> = [
        "Runtime Raiders.app", "raiders", "agent.sock", ".agent.sock.runtime-raiders.lock",
        "releases", "installation", "launcher",
    ]
    private static let privateFileModes: Set<mode_t> = [0o600, 0o644, 0o700, 0o755]
    private static let directoryModes: Set<mode_t> = [0o700, 0o755]
    private static let enrollmentMaximumBytes: off_t = 65_536
    private static let journalMaximumBytes: off_t = 16 * 1_024
    private static let collectorStateMaximumBytes: off_t = 4 * 1_024 * 1_024
    private static let updateStateMaximumBytes: off_t = 16 * 1_024
    private static let outboxRecordMaximumBytes: off_t = 64 * 1_024
    private static let shimMaximumBytes: off_t = 4 * 1_024 * 1_024
    private static let plistMaximumBytes: off_t = 1 * 1_024 * 1_024
    // A signed app or retained release payload may be large, but removal never
    // needs to trust an unbounded object.
    private static let ownedPayloadMaximumBytes: off_t = 512 * 1_024 * 1_024

    private let paths: CompanionLifecyclePaths
    private let metadataTransform: MetadataTransform
    private let validationCheckpoint: ValidationCheckpoint
    private let removalObserver: RemovalObserver

    public init(paths: CompanionLifecyclePaths) {
        self.init(
            paths: paths,
            metadataTransform: { _, metadata in metadata },
            validationCheckpoint: {},
            removalObserver: { _ in }
        )
    }

    init(
        paths: CompanionLifecyclePaths,
        metadataTransform: @escaping MetadataTransform = { _, metadata in metadata },
        validationCheckpoint: @escaping ValidationCheckpoint = {},
        removalObserver: @escaping RemovalObserver = { _ in }
    ) {
        self.paths = paths
        self.metadataTransform = metadataTransform
        self.validationCheckpoint = validationCheckpoint
        self.removalObserver = removalObserver
    }

    public func removeExecutableArtifacts() throws {
        try prepareSession().removeExecutableArtifacts()
    }

    func prepareSession() throws -> OwnedInstallationRemovalSession {
        let plan = try validateCompleteInstallation()
        try validationCheckpoint()
        try plan.revalidateAll(metadataTransform: metadataTransform)
        let socketLock = try acquireSocketLifetimeLock(plan: plan)
        return OwnedInstallationRemovalSession(
            socketLockDescriptor: socketLock,
            queueNames: { try validatedQueueNames(plan: plan) },
            loadEnrollment: { try loadEnrollment(plan: plan) },
            discardQueue: { names in try discardQueue(names, plan: plan) },
            verifyQueueEmpty: { names in try verifyQueueEmpty(names, plan: plan) },
            removeExecutableArtifacts: { try removeExecutableArtifacts(plan: plan) },
            verifyPreservedState: { try verifyPreservedState(plan: plan) },
            removeAllArtifacts: { try removeAllArtifacts(plan: plan) }
        )
    }

    private func acquireSocketLifetimeLock(plan: InstallationPlan) throws -> Int32? {
        guard let support = plan.support else { return nil }
        let lockName = ".agent.sock.runtime-raiders.lock"
        guard let lock = support.children[lockName] else {
            let stillExecutable = support.children.keys.contains {
                Self.executableNames.contains($0) && $0 != lockName
            }
            guard !stillExecutable else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            return nil
        }
        guard lock.kind == .regular, lock.metadata.st_size == 0 else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        while removalFlock(lock.descriptor, LOCK_EX | LOCK_NB) != 0 {
            if errno == EINTR { continue }
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        return lock.descriptor
    }

    private func removeExecutableArtifacts(plan: InstallationPlan) throws {
        try plan.revalidateAll(metadataTransform: metadataTransform)
        if let support = plan.support {
            for name in [
                "Runtime Raiders.app", "releases", "installation", "launcher", "agent.sock",
            ] {
                try removeChild(named: name, support: support, plan: plan)
            }
            try remove(plan.legacyPlist)
            try removeChild(named: "raiders", support: support, plan: plan)
            try remove(plan.command)
            try removeChild(
                named: ".agent.sock.runtime-raiders.lock",
                support: support,
                plan: plan
            )
            try synchronize(support.descriptor)
        } else {
            try remove(plan.legacyPlist)
            try remove(plan.command)
        }
    }

    private func removeAllArtifacts(plan: InstallationPlan) throws {
        try plan.revalidateAll(metadataTransform: metadataTransform)
        if let support = plan.support {
            for name in [
                "state", "outbox", "Runtime Raiders.app", "releases", "installation",
                "launcher", "agent.sock",
            ] {
                try removeChild(named: name, support: support, plan: plan)
            }
            try remove(plan.legacyPlist)
            try removeChild(named: "raiders", support: support, plan: plan)
            try removeChild(
                named: ".agent.sock.runtime-raiders.lock",
                support: support,
                plan: plan
            )
            try remove(
                support,
                from: plan.applicationSupport.descriptor,
                beforeMutation: {
                    try plan.revalidateSupportAnchor(metadataTransform: metadataTransform)
                }
            )
            try synchronize(plan.applicationSupport.descriptor)
        } else {
            try remove(plan.legacyPlist)
        }
        try remove(plan.command)
    }

    private func removeChild(
        named name: String,
        support: RetainedNode,
        plan: InstallationPlan
    ) throws {
        guard let child = support.children[name] else { return }
        try remove(
            child,
            from: support.descriptor,
            beforeMutation: {
                try plan.revalidateSupportAnchor(metadataTransform: metadataTransform)
            }
        )
        support.children.removeValue(forKey: name)
    }

    private func validatedQueueNames(plan: InstallationPlan) throws -> [String] {
        try plan.revalidateAll(metadataTransform: metadataTransform)
        guard let support = plan.support,
              let outbox = support.children["outbox"] else { return [] }
        let names = outbox.children.keys.sorted()
        for name in names {
            guard Self.isCanonicalOutboxRecordName(name),
                  let node = outbox.children[name],
                  node.kind == .regular else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            let data = try readRetainedData(
                descriptor: node.descriptor,
                expectedSize: node.metadata.st_size,
                maximumBytes: Self.outboxRecordMaximumBytes
            )
            guard let event = try? JSONDecoder().decode(RunEventV1.self, from: data),
                  let canonical = try? PrivacyEncoder().encode(event),
                  canonical == data,
                  name == Self.canonicalOutboxName(event) else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
        }
        return names
    }

    private func loadEnrollment(plan: InstallationPlan) throws -> EnrollmentConfiguration? {
        try plan.revalidateAll(metadataTransform: metadataTransform)
        guard let state = plan.support?.children["state"],
              let enrollment = state.children["enrollment.json"] else { return nil }
        let data = try readRetainedData(
            descriptor: enrollment.descriptor,
            expectedSize: enrollment.metadata.st_size,
            maximumBytes: Self.enrollmentMaximumBytes
        )
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == [
                  "version", "device_id", "device_token", "dedupe_secret",
                  "server_url", "cutover_at", "enabled_surfaces",
              ],
              let wire = try? JSONDecoder().decode(RemovalEnrollmentWire.self, from: data),
              wire.version == 1,
              let secret = decodeRemovalLowerHex(wire.dedupeSecret),
              let serverURL = URL(string: wire.serverURL) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        return try EnrollmentConfiguration(
            deviceID: wire.deviceID,
            deviceToken: wire.deviceToken,
            dedupeSecret: secret,
            serverURL: serverURL,
            cutoverAtMS: wire.cutoverAtMS,
            enabledSurfaces: wire.enabledSurfaces
        )
    }

    private func discardQueue(_ names: [String], plan: InstallationPlan) throws {
        try plan.revalidateAll(metadataTransform: metadataTransform)
        guard let support = plan.support,
              let outbox = support.children["outbox"],
              outbox.children.keys.sorted() == names else {
            if names.isEmpty, plan.support?.children["outbox"] == nil { return }
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        for name in names.sorted() {
            guard let node = outbox.children[name] else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            try remove(
                node,
                from: outbox.descriptor,
                beforeMutation: {
                    try plan.revalidateOutboxAnchor(metadataTransform: metadataTransform)
                }
            )
            outbox.children.removeValue(forKey: name)
        }
        try synchronize(outbox.descriptor)
    }

    private func verifyQueueEmpty(_ names: [String], plan: InstallationPlan) throws -> Bool {
        _ = names
        try plan.revalidateAll(metadataTransform: metadataTransform)
        guard let outbox = plan.support?.children["outbox"] else { return true }
        let physicalNames = try directoryNames(outbox.descriptor)
        return outbox.children.isEmpty && physicalNames.isEmpty
    }

    private func verifyPreservedState(plan: InstallationPlan) throws -> Bool {
        try plan.home.revalidate(metadataTransform: metadataTransform)
        try plan.applicationSupport.revalidate(metadataTransform: metadataTransform)
        guard let support = plan.support else { return false }
        try support.revalidateIdentity(
            parentDescriptor: plan.applicationSupport.descriptor,
            metadataTransform: metadataTransform
        )
        guard let state = support.children["state"],
              let outbox = support.children["outbox"] else { return false }
        try state.revalidate(
            parentDescriptor: support.descriptor,
            metadataTransform: metadataTransform
        )
        try outbox.revalidate(
            parentDescriptor: support.descriptor,
            metadataTransform: metadataTransform
        )
        return true
    }

    private static func canonicalOutboxName(_ event: RunEventV1) -> String {
        event.idempotencyKey + ".json"
    }

    private static func isCanonicalOutboxRecordName(_ name: String) -> Bool {
        name.range(of: #"^[0-9a-f]{64}\.json$"#, options: .regularExpression) != nil
    }

    private func validateCompleteInstallation() throws -> InstallationPlan {
        do {
            let home = try RetainedDirectory.open(
                paths.homeDirectory,
                relativePath: "home",
                expectedOwner: Darwin.geteuid(),
                allowedModes: Self.directoryModes,
                expectedDevice: nil,
                metadataTransform: metadataTransform
            )
            let applicationSupportURL = paths.agent.supportDirectory.deletingLastPathComponent()
            let applicationSupport = try RetainedDirectory.open(
                applicationSupportURL,
                relativePath: "Application Support parent",
                expectedOwner: Darwin.geteuid(),
                allowedModes: Self.directoryModes,
                expectedDevice: home.metadata.st_dev,
                metadataTransform: metadataTransform
            )
            let commandParent = try RetainedDirectory.openIfPresent(
                paths.commandShim.deletingLastPathComponent(),
                relativePath: ".local/bin parent",
                expectedOwner: Darwin.geteuid(),
                allowedModes: Self.directoryModes,
                expectedDevice: home.metadata.st_dev,
                metadataTransform: metadataTransform
            )
            let legacyParent = try RetainedDirectory.openIfPresent(
                paths.legacyPlist.deletingLastPathComponent(),
                relativePath: "LaunchAgents parent",
                expectedOwner: Darwin.geteuid(),
                allowedModes: Self.directoryModes,
                expectedDevice: home.metadata.st_dev,
                metadataTransform: metadataTransform
            )

            let support = try validateSupport(
                parent: applicationSupport,
                expectedDevice: home.metadata.st_dev
            )
            let command = try validateCommand(
                parent: commandParent,
                expectedDevice: home.metadata.st_dev
            )
            let legacyPlist = try validateExternalRegularFile(
                parent: legacyParent,
                name: paths.legacyPlist.lastPathComponent,
                relativePath: "legacy-plist",
                expectedDevice: home.metadata.st_dev,
                allowedModes: [0o600, 0o644]
            )
            return InstallationPlan(
                home: home,
                applicationSupport: applicationSupport,
                commandParent: commandParent,
                legacyParent: legacyParent,
                support: support,
                command: command,
                legacyPlist: legacyPlist,
                commandTarget: paths.supportShim.path
            )
        } catch is OwnedInstallationRemovalError {
            throw OwnedInstallationRemovalError.invalidInstallation
        } catch {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }

    private func validateSupport(
        parent: RetainedDirectory,
        expectedDevice: dev_t
    ) throws -> RetainedNode? {
        guard let metadata = try entryMetadata(
            parent: parent.descriptor,
            name: paths.agent.supportDirectory.lastPathComponent,
            relativePath: "support"
        ) else { return nil }
        guard fileType(metadata) == mode_t(S_IFDIR),
              validOwnerModeDevice(
                metadata,
                expectedDevice: expectedDevice,
                allowedModes: [0o700]
              ) else { throw OwnedInstallationRemovalError.invalidInstallation }
        let descriptor = Darwin.openat(
            parent.descriptor,
            paths.agent.supportDirectory.lastPathComponent,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw OwnedInstallationRemovalError.invalidInstallation }
        let node = RetainedNode(
            name: paths.agent.supportDirectory.lastPathComponent,
            relativePath: "support",
            metadata: metadata,
            descriptor: descriptor,
            kind: .directory
        )
        do {
            try requireDescriptor(metadata, descriptor: descriptor, relativePath: "support")
            let names = try directoryNames(descriptor)
            guard Set(names).isSubset(of: Self.supportNames) else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            for name in names.sorted() {
                let role: TreeRole
                switch name {
                case "Runtime Raiders.app": role = .signedApplication
                case "raiders": role = .supportShim
                case "state": role = .state
                case "outbox": role = .outbox
                case "agent.sock": role = .socket
                case ".agent.sock.runtime-raiders.lock": role = .privateRegular
                case "releases", "installation", "launcher": role = .ownedTree
                default: throw OwnedInstallationRemovalError.invalidInstallation
                }
                node.children[name] = try validateNode(
                    parentDescriptor: descriptor,
                    name: name,
                    relativePath: name,
                    expectedDevice: expectedDevice,
                    role: role
                )
            }
            return node
        } catch {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }

    private func validateNode(
        parentDescriptor: Int32,
        name: String,
        relativePath: String,
        expectedDevice: dev_t,
        role: TreeRole
    ) throws -> RetainedNode {
        guard validComponent(name),
              let metadata = try entryMetadata(
                parent: parentDescriptor,
                name: name,
                relativePath: relativePath
              ) else { throw OwnedInstallationRemovalError.invalidInstallation }
        let type = fileType(metadata)

        switch role {
        case .socket:
            guard type == mode_t(S_IFSOCK),
                  validOwnerModeDevice(
                    metadata,
                    expectedDevice: expectedDevice,
                    allowedModes: [0o600]
                  ),
                  metadata.st_nlink == 1 else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            return RetainedNode(
                name: name,
                relativePath: relativePath,
                metadata: metadata,
                descriptor: -1,
                kind: .socket
            )
        case .supportShim:
            guard type == mode_t(S_IFREG),
                  validOwnerModeDevice(
                    metadata,
                    expectedDevice: expectedDevice,
                    allowedModes: [0o700]
                  ),
                  metadata.st_nlink == 1,
                  metadata.st_size >= 0,
                  metadata.st_size <= Self.shimMaximumBytes else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            return try openRegularNode(
                parentDescriptor: parentDescriptor,
                name: name,
                relativePath: relativePath,
                metadata: metadata
            )
        case .state, .outbox, .signedApplication, .ownedTree:
            guard type == mode_t(S_IFDIR) else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            let allowedDirectoryModes: Set<mode_t> = role == .signedApplication
                ? Self.directoryModes
                : [0o700]
            guard validOwnerModeDevice(
                metadata,
                expectedDevice: expectedDevice,
                allowedModes: allowedDirectoryModes
            ) else { throw OwnedInstallationRemovalError.invalidInstallation }
            let descriptor = Darwin.openat(
                parentDescriptor,
                name,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            guard descriptor >= 0 else { throw OwnedInstallationRemovalError.invalidInstallation }
            let node = RetainedNode(
                name: name,
                relativePath: relativePath,
                metadata: metadata,
                descriptor: descriptor,
                kind: .directory
            )
            do {
                try requireDescriptor(metadata, descriptor: descriptor, relativePath: relativePath)
                for childName in try directoryNames(descriptor).sorted() {
                    let childRelative = relativePath + "/" + childName
                    let childRole: TreeRole
                    switch role {
                    case .state:
                        guard Self.validStateName(childName) else {
                            throw OwnedInstallationRemovalError.invalidInstallation
                        }
                        childRole = .privateRegular
                    case .outbox:
                        guard Self.validOutboxName(childName) else {
                            throw OwnedInstallationRemovalError.invalidInstallation
                        }
                        childRole = .privateRegular
                    case .signedApplication:
                        childRole = .applicationNode
                    case .ownedTree:
                        childRole = .ownedNode
                    default:
                        throw OwnedInstallationRemovalError.invalidInstallation
                    }
                    node.children[childName] = try validateNode(
                        parentDescriptor: descriptor,
                        name: childName,
                        relativePath: childRelative,
                        expectedDevice: expectedDevice,
                        role: childRole
                    )
                }
                return node
            } catch {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
        case .privateRegular:
            guard let maximumBytes = Self.maximumBytes(for: relativePath, role: role) else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            guard type == mode_t(S_IFREG),
                  validOwnerModeDevice(
                    metadata,
                    expectedDevice: expectedDevice,
                    allowedModes: [0o600]
                  ),
                  metadata.st_nlink == 1,
                  metadata.st_size >= 0,
                  metadata.st_size <= maximumBytes else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            return try openRegularNode(
                parentDescriptor: parentDescriptor,
                name: name,
                relativePath: relativePath,
                metadata: metadata
            )
        case .applicationNode, .ownedNode:
            if type == mode_t(S_IFDIR) {
                let directoryRole: TreeRole = role == .applicationNode
                    ? .signedApplication
                    : .ownedTree
                return try validateNode(
                    parentDescriptor: parentDescriptor,
                    name: name,
                    relativePath: relativePath,
                    expectedDevice: expectedDevice,
                    role: directoryRole
                )
            }
            guard type == mode_t(S_IFREG),
                  validOwnerModeDevice(
                    metadata,
                    expectedDevice: expectedDevice,
                    allowedModes: Self.privateFileModes
                  ),
                  metadata.st_nlink == 1,
                  metadata.st_size >= 0,
                  metadata.st_size <= Self.ownedPayloadMaximumBytes else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            return try openRegularNode(
                parentDescriptor: parentDescriptor,
                name: name,
                relativePath: relativePath,
                metadata: metadata
            )
        }
    }

    private func openRegularNode(
        parentDescriptor: Int32,
        name: String,
        relativePath: String,
        metadata: stat
    ) throws -> RetainedNode {
        let descriptor = Darwin.openat(
            parentDescriptor,
            name,
            O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw OwnedInstallationRemovalError.invalidInstallation }
        do {
            try requireDescriptor(metadata, descriptor: descriptor, relativePath: relativePath)
            return RetainedNode(
                name: name,
                relativePath: relativePath,
                metadata: metadata,
                descriptor: descriptor,
                kind: .regular,
                contentDigest: try digestRetainedDescriptor(
                    descriptor,
                    expectedSize: metadata.st_size
                )
            )
        } catch {
            Darwin.close(descriptor)
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }

    private func validateCommand(
        parent: RetainedDirectory?,
        expectedDevice: dev_t
    ) throws -> RetainedLink? {
        guard let parent else { return nil }
        let name = paths.commandShim.lastPathComponent
        guard let metadata = try entryMetadata(
            parent: parent.descriptor,
            name: name,
            relativePath: "command"
        ) else { return nil }
        guard fileType(metadata) == mode_t(S_IFLNK),
              metadata.st_uid == Darwin.geteuid(),
              metadata.st_dev == expectedDevice,
              metadata.st_nlink == 1,
              [mode_t(0o755), mode_t(0o777)].contains(metadata.st_mode & 0o7777),
              let target = try readLink(parent: parent.descriptor, name: name),
              target == paths.supportShim.path else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        return RetainedLink(
            parent: parent,
            name: name,
            relativePath: "command",
            metadata: metadata,
            target: target
        )
    }

    private func validateExternalRegularFile(
        parent: RetainedDirectory?,
        name: String,
        relativePath: String,
        expectedDevice: dev_t,
        allowedModes: Set<mode_t>
    ) throws -> RetainedExternalFile? {
        guard let parent else { return nil }
        guard let metadata = try entryMetadata(
            parent: parent.descriptor,
            name: name,
            relativePath: relativePath
        ) else { return nil }
        guard fileType(metadata) == mode_t(S_IFREG),
              validOwnerModeDevice(
                metadata,
                expectedDevice: expectedDevice,
                allowedModes: allowedModes
              ),
              metadata.st_nlink == 1,
              metadata.st_size >= 0,
              metadata.st_size <= Self.plistMaximumBytes else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        let descriptor = Darwin.openat(
            parent.descriptor,
            name,
            O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw OwnedInstallationRemovalError.invalidInstallation }
        do {
            try requireDescriptor(metadata, descriptor: descriptor, relativePath: relativePath)
            return RetainedExternalFile(
                parent: parent,
                name: name,
                relativePath: relativePath,
                metadata: metadata,
                descriptor: descriptor,
                contentDigest: try digestRetainedDescriptor(
                    descriptor,
                    expectedSize: metadata.st_size
                )
            )
        } catch {
            Darwin.close(descriptor)
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }

    private func entryMetadata(
        parent: Int32,
        name: String,
        relativePath: String
    ) throws -> stat? {
        guard validComponent(name) else { throw OwnedInstallationRemovalError.invalidInstallation }
        var metadata = stat()
        guard Darwin.fstatat(parent, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else {
            if errno == ENOENT { return nil }
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        return metadataTransform(relativePath, metadata)
    }

    private func requireDescriptor(
        _ expected: stat,
        descriptor: Int32,
        relativePath: String
    ) throws {
        var actual = stat()
        guard Darwin.fstat(descriptor, &actual) == 0,
              sameMetadata(expected, metadataTransform(relativePath, actual)) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }

    private func remove(
        _ node: RetainedNode,
        from parentDescriptor: Int32,
        beforeMutation: @escaping () throws -> Void
    ) throws {
        try node.revalidate(
            parentDescriptor: parentDescriptor,
            metadataTransform: metadataTransform
        )
        if node.kind == .directory {
            for child in node.children.values.sorted(by: { $0.name < $1.name }) {
                try remove(
                    child,
                    from: node.descriptor,
                    beforeMutation: beforeMutation
                )
            }
            try synchronize(node.descriptor)
            try removalObserver(node.relativePath)
            try beforeMutation()
            try node.revalidateIdentity(
                parentDescriptor: parentDescriptor,
                metadataTransform: metadataTransform
            )
            guard Darwin.unlinkat(parentDescriptor, node.name, AT_REMOVEDIR) == 0 else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
        } else {
            try removalObserver(node.relativePath)
            try beforeMutation()
            try node.revalidate(
                parentDescriptor: parentDescriptor,
                metadataTransform: metadataTransform
            )
            guard Darwin.unlinkat(parentDescriptor, node.name, 0) == 0 else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
        }
    }

    private func remove(_ link: RetainedLink?) throws {
        guard let link else { return }
        try link.revalidate(metadataTransform: metadataTransform)
        try removalObserver(link.relativePath)
        try link.parent.revalidate(metadataTransform: metadataTransform)
        try link.revalidate(metadataTransform: metadataTransform)
        guard Darwin.unlinkat(link.parent.descriptor, link.name, 0) == 0 else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        try synchronize(link.parent.descriptor)
    }

    private func remove(_ file: RetainedExternalFile?) throws {
        guard let file else { return }
        try file.revalidate(metadataTransform: metadataTransform)
        try removalObserver(file.relativePath)
        try file.parent.revalidate(metadataTransform: metadataTransform)
        try file.revalidate(metadataTransform: metadataTransform)
        guard Darwin.unlinkat(file.parent.descriptor, file.name, 0) == 0 else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        try synchronize(file.parent.descriptor)
    }

    private func synchronize(_ descriptor: Int32) throws {
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }

    private static func validStateName(_ name: String) -> Bool {
        let fixed: Set<String> = [
            "enrollment.json", "collector-state.json", "update-state.json",
            "update-state.lock", "re-enrollment.json",
        ]
        if fixed.contains(name) { return true }
        return name.range(
            of: #"^\.(enrollment\.json|collector-state\.json|update-state\.json|re-enrollment\.json)\.runtime-raiders-tmp-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"#,
            options: .regularExpression
        ) != nil
    }

    private static func validOutboxName(_ name: String) -> Bool {
        if name.range(of: #"^[0-9a-f]{64}\.json$"#, options: .regularExpression) != nil {
            return true
        }
        return name.range(
            of: #"^\.[0-9a-f]{64}\.json\.runtime-raiders-tmp-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"#,
            options: .regularExpression
        ) != nil
    }

    private static func maximumBytes(for relativePath: String, role: TreeRole) -> off_t? {
        if relativePath == ".agent.sock.runtime-raiders.lock" { return 0 }
        if relativePath.hasPrefix("outbox/") { return outboxRecordMaximumBytes }
        guard role == .privateRegular, relativePath.hasPrefix("state/") else {
            return nil
        }
        let name = String(relativePath.dropFirst("state/".count))
        if name == "update-state.lock" { return 0 }
        if name == "enrollment.json" || name.hasPrefix(".enrollment.json.runtime-raiders-tmp-") {
            return enrollmentMaximumBytes
        }
        if name == "collector-state.json" || name.hasPrefix(".collector-state.json.runtime-raiders-tmp-") {
            return collectorStateMaximumBytes
        }
        if name == "update-state.json" || name.hasPrefix(".update-state.json.runtime-raiders-tmp-") {
            return updateStateMaximumBytes
        }
        if name == "re-enrollment.json" || name.hasPrefix(".re-enrollment.json.runtime-raiders-tmp-") {
            return journalMaximumBytes
        }
        return nil
    }
}

final class OwnedInstallationRemovalSession: RemovalSession, @unchecked Sendable {
    private let socketLockDescriptor: Int32?
    private let queueNamesImpl: () throws -> [String]
    private let loadEnrollmentImpl: () throws -> EnrollmentConfiguration?
    private let discardQueueImpl: ([String]) throws -> Void
    private let verifyQueueEmptyImpl: ([String]) throws -> Bool
    private let removeExecutableArtifactsImpl: () throws -> Void
    private let verifyPreservedStateImpl: () throws -> Bool
    private let removeAllArtifactsImpl: () throws -> Void

    init(
        socketLockDescriptor: Int32?,
        queueNames: @escaping () throws -> [String],
        loadEnrollment: @escaping () throws -> EnrollmentConfiguration?,
        discardQueue: @escaping ([String]) throws -> Void,
        verifyQueueEmpty: @escaping ([String]) throws -> Bool,
        removeExecutableArtifacts: @escaping () throws -> Void,
        verifyPreservedState: @escaping () throws -> Bool,
        removeAllArtifacts: @escaping () throws -> Void
    ) {
        self.socketLockDescriptor = socketLockDescriptor
        queueNamesImpl = queueNames
        loadEnrollmentImpl = loadEnrollment
        discardQueueImpl = discardQueue
        verifyQueueEmptyImpl = verifyQueueEmpty
        removeExecutableArtifactsImpl = removeExecutableArtifacts
        verifyPreservedStateImpl = verifyPreservedState
        removeAllArtifactsImpl = removeAllArtifacts
    }

    deinit {
        if let socketLockDescriptor {
            _ = removalFlock(socketLockDescriptor, LOCK_UN)
        }
    }

    func validatedQueueSnapshot() throws -> RemovalQueueSnapshot {
        RemovalQueueSnapshot(
            sessionIdentifier: ObjectIdentifier(self),
            names: try queueNamesImpl()
        )
    }

    func loadEnrollment() throws -> EnrollmentConfiguration? {
        try loadEnrollmentImpl()
    }

    func discardValidatedQueue(_ snapshot: RemovalQueueSnapshot) throws {
        guard snapshot.belongs(to: self) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        try discardQueueImpl(snapshot.names)
    }

    func verifyQueueEmpty(_ snapshot: RemovalQueueSnapshot) throws -> Bool {
        guard snapshot.belongs(to: self) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        return try verifyQueueEmptyImpl(snapshot.names)
    }

    func removeExecutableArtifacts() throws {
        try removeExecutableArtifactsImpl()
    }

    func verifyPreservedState() throws -> Bool {
        try verifyPreservedStateImpl()
    }

    func removeAllArtifacts(authorization: CompleteRemovalAuthorization) throws {
        guard authorization.authorizes(self) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        try removeAllArtifactsImpl()
    }
}

private struct RemovalEnrollmentWire: Decodable {
    let version: Int
    let deviceID: String
    let deviceToken: String
    let dedupeSecret: String
    let serverURL: String
    let cutoverAtMS: Int64
    let enabledSurfaces: [RunSurface]

    enum CodingKeys: String, CodingKey {
        case version
        case deviceID = "device_id"
        case deviceToken = "device_token"
        case dedupeSecret = "dedupe_secret"
        case serverURL = "server_url"
        case cutoverAtMS = "cutover_at"
        case enabledSurfaces = "enabled_surfaces"
    }
}

private func decodeRemovalLowerHex(_ value: String) -> Data? {
    guard value.utf8.count == 64,
          value.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
        return nil
    }
    var result = Data()
    result.reserveCapacity(32)
    var index = value.startIndex
    for _ in 0..<32 {
        let end = value.index(index, offsetBy: 2)
        guard let byte = UInt8(value[index..<end], radix: 16) else { return nil }
        result.append(byte)
        index = end
    }
    return result
}

private enum TreeRole: Equatable {
    case signedApplication
    case supportShim
    case state
    case outbox
    case socket
    case ownedTree
    case privateRegular
    case applicationNode
    case ownedNode
}

private enum RetainedNodeKind: Equatable { case directory, regular, socket }

private final class RetainedNode {
    let name: String
    let relativePath: String
    let metadata: stat
    let descriptor: Int32
    let kind: RetainedNodeKind
    let contentDigest: Data?
    var children: [String: RetainedNode] = [:]

    init(
        name: String,
        relativePath: String,
        metadata: stat,
        descriptor: Int32,
        kind: RetainedNodeKind,
        contentDigest: Data? = nil
    ) {
        self.name = name
        self.relativePath = relativePath
        self.metadata = metadata
        self.descriptor = descriptor
        self.kind = kind
        self.contentDigest = contentDigest
    }

    deinit { if descriptor >= 0 { Darwin.close(descriptor) } }

    func revalidate(
        parentDescriptor: Int32,
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        var pathMetadata = stat()
        func matches(_ lhs: stat, _ rhs: stat) -> Bool {
            if kind == .directory { return sameStableDirectoryMetadata(lhs, rhs) }
            return sameMetadata(lhs, rhs)
        }
        guard Darwin.fstatat(
            parentDescriptor,
            name,
            &pathMetadata,
            AT_SYMLINK_NOFOLLOW
        ) == 0,
        matches(metadata, metadataTransform(relativePath, pathMetadata)) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        if descriptor >= 0 {
            var descriptorMetadata = stat()
            guard Darwin.fstat(descriptor, &descriptorMetadata) == 0,
                  matches(
                    metadata,
                    metadataTransform(relativePath, descriptorMetadata)
                  ) else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            if let contentDigest,
               try digestRetainedDescriptor(
                   descriptor,
                   expectedSize: metadata.st_size
               ) != contentDigest {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
        }
        if kind == .directory {
            guard Set(try directoryNames(descriptor)) == Set(children.keys) else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            for child in children.values {
                try child.revalidate(
                    parentDescriptor: descriptor,
                    metadataTransform: metadataTransform
                )
            }
        }
    }

    func revalidateIdentity(
        parentDescriptor: Int32,
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        var pathMetadata = stat()
        var descriptorMetadata = stat()
        guard Darwin.fstatat(parentDescriptor, name, &pathMetadata, AT_SYMLINK_NOFOLLOW) == 0,
              sameStableDirectoryMetadata(
                  metadata,
                  metadataTransform(relativePath, pathMetadata)
              ),
              descriptor >= 0,
              Darwin.fstat(descriptor, &descriptorMetadata) == 0,
              sameStableDirectoryMetadata(
                  metadata,
                  metadataTransform(relativePath, descriptorMetadata)
              ) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }
}

private final class RetainedDirectory {
    let url: URL
    let relativePath: String
    let descriptor: Int32
    let metadata: stat

    private init(url: URL, relativePath: String, descriptor: Int32, metadata: stat) {
        self.url = url
        self.relativePath = relativePath
        self.descriptor = descriptor
        self.metadata = metadata
    }

    deinit { Darwin.close(descriptor) }

    static func open(
        _ url: URL,
        relativePath: String,
        expectedOwner: uid_t,
        allowedModes: Set<mode_t>,
        expectedDevice: dev_t?,
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws -> RetainedDirectory {
        guard url.isFileURL,
              url.path.hasPrefix("/"),
              url.standardized.path == url.path else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        let descriptor = try openAbsoluteDirectory(url)
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0 else {
            Darwin.close(descriptor)
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        metadata = metadataTransform(relativePath, metadata)
        guard fileType(metadata) == mode_t(S_IFDIR),
              metadata.st_uid == expectedOwner,
              allowedModes.contains(metadata.st_mode & 0o7777),
              expectedDevice == nil || metadata.st_dev == expectedDevice else {
            Darwin.close(descriptor)
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        return RetainedDirectory(
            url: url,
            relativePath: relativePath,
            descriptor: descriptor,
            metadata: metadata
        )
    }

    static func openIfPresent(
        _ url: URL,
        relativePath: String,
        expectedOwner: uid_t,
        allowedModes: Set<mode_t>,
        expectedDevice: dev_t,
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws -> RetainedDirectory? {
        do {
            return try open(
                url,
                relativePath: relativePath,
                expectedOwner: expectedOwner,
                allowedModes: allowedModes,
                expectedDevice: expectedDevice,
                metadataTransform: metadataTransform
            )
        } catch let error as POSIXError where error.code == .ENOENT {
            return nil
        } catch {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }

    func revalidate(
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        let current = try openAbsoluteDirectory(url)
        defer { Darwin.close(current) }
        var currentMetadata = stat()
        var retainedMetadata = stat()
        guard Darwin.fstat(current, &currentMetadata) == 0,
              Darwin.fstat(descriptor, &retainedMetadata) == 0,
              sameMetadata(metadata, metadataTransform(relativePath, currentMetadata)),
              sameMetadata(metadata, metadataTransform(relativePath, retainedMetadata)) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }
}

private final class RetainedExternalFile {
    let parent: RetainedDirectory
    let name: String
    let relativePath: String
    let metadata: stat
    let descriptor: Int32
    let contentDigest: Data

    init(
        parent: RetainedDirectory,
        name: String,
        relativePath: String,
        metadata: stat,
        descriptor: Int32,
        contentDigest: Data
    ) {
        self.parent = parent
        self.name = name
        self.relativePath = relativePath
        self.metadata = metadata
        self.descriptor = descriptor
        self.contentDigest = contentDigest
    }

    deinit { Darwin.close(descriptor) }

    func revalidate(
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        var pathMetadata = stat()
        var descriptorMetadata = stat()
        guard Darwin.fstatat(parent.descriptor, name, &pathMetadata, AT_SYMLINK_NOFOLLOW) == 0,
              Darwin.fstat(descriptor, &descriptorMetadata) == 0,
              sameMetadata(metadata, metadataTransform(relativePath, pathMetadata)),
              sameMetadata(metadata, metadataTransform(relativePath, descriptorMetadata)),
              try digestRetainedDescriptor(
                  descriptor,
                  expectedSize: metadata.st_size
              ) == contentDigest else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }
}

private final class RetainedLink {
    let parent: RetainedDirectory
    let name: String
    let relativePath: String
    let metadata: stat
    let target: String

    init(
        parent: RetainedDirectory,
        name: String,
        relativePath: String,
        metadata: stat,
        target: String
    ) {
        self.parent = parent
        self.name = name
        self.relativePath = relativePath
        self.metadata = metadata
        self.target = target
    }

    func revalidate(
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        var current = stat()
        guard Darwin.fstatat(parent.descriptor, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
              sameMetadata(metadata, metadataTransform(relativePath, current)),
              try readLink(parent: parent.descriptor, name: name) == target else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }
}

private final class InstallationPlan {
    let home: RetainedDirectory
    let applicationSupport: RetainedDirectory
    let commandParent: RetainedDirectory?
    let legacyParent: RetainedDirectory?
    let support: RetainedNode?
    let command: RetainedLink?
    let legacyPlist: RetainedExternalFile?
    let commandTarget: String

    init(
        home: RetainedDirectory,
        applicationSupport: RetainedDirectory,
        commandParent: RetainedDirectory?,
        legacyParent: RetainedDirectory?,
        support: RetainedNode?,
        command: RetainedLink?,
        legacyPlist: RetainedExternalFile?,
        commandTarget: String
    ) {
        self.home = home
        self.applicationSupport = applicationSupport
        self.commandParent = commandParent
        self.legacyParent = legacyParent
        self.support = support
        self.command = command
        self.legacyPlist = legacyPlist
        self.commandTarget = commandTarget
    }

    func revalidateAll(
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        try home.revalidate(metadataTransform: metadataTransform)
        try applicationSupport.revalidate(metadataTransform: metadataTransform)
        try commandParent?.revalidate(metadataTransform: metadataTransform)
        try legacyParent?.revalidate(metadataTransform: metadataTransform)
        if let support {
            try support.revalidate(
                parentDescriptor: applicationSupport.descriptor,
                metadataTransform: metadataTransform
            )
        }
        try command?.revalidate(metadataTransform: metadataTransform)
        guard command == nil || command?.target == commandTarget else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        try legacyPlist?.revalidate(metadataTransform: metadataTransform)
    }

    func revalidateSupportAnchor(
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        try home.revalidate(metadataTransform: metadataTransform)
        try applicationSupport.revalidate(metadataTransform: metadataTransform)
        if let support {
            try support.revalidateIdentity(
                parentDescriptor: applicationSupport.descriptor,
                metadataTransform: metadataTransform
            )
        }
    }

    func revalidateOutboxAnchor(
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        try revalidateSupportAnchor(metadataTransform: metadataTransform)
        guard let support,
              let outbox = support.children["outbox"] else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        try outbox.revalidateIdentity(
            parentDescriptor: support.descriptor,
            metadataTransform: metadataTransform
        )
    }
}

private func openAbsoluteDirectory(_ url: URL) throws -> Int32 {
    var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard descriptor >= 0 else { throw currentRemovalPOSIXError() }
    let components = url.pathComponents.filter { $0 != "/" }
    for component in components {
        guard validComponent(component) else {
            Darwin.close(descriptor)
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        let next = Darwin.openat(
            descriptor,
            component,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        if next < 0 {
            let openError = currentRemovalPOSIXError()
            Darwin.close(descriptor)
            throw openError
        }
        Darwin.close(descriptor)
        descriptor = next
    }
    return descriptor
}

private func directoryNames(_ descriptor: Int32) throws -> [String] {
    let duplicate = Darwin.openat(
        descriptor,
        ".",
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard duplicate >= 0, let stream = Darwin.fdopendir(duplicate) else {
        if duplicate >= 0 { Darwin.close(duplicate) }
        throw OwnedInstallationRemovalError.invalidInstallation
    }
    defer { Darwin.closedir(stream) }
    var names: [String] = []
    while let entry = Darwin.readdir(stream) {
        let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                String(cString: $0)
            }
        }
        if name != "." && name != ".." {
            guard validComponent(name), names.count < 100_000 else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
            names.append(name)
        }
    }
    return names
}

private func readLink(parent: Int32, name: String) throws -> String? {
    var bytes = [UInt8](repeating: 0, count: Int(PATH_MAX) + 1)
    let count = Darwin.readlinkat(parent, name, &bytes, Int(PATH_MAX))
    guard count >= 0 else {
        if errno == ENOENT { return nil }
        throw OwnedInstallationRemovalError.invalidInstallation
    }
    guard count > 0, count < Int(PATH_MAX) else {
        throw OwnedInstallationRemovalError.invalidInstallation
    }
    return String(bytes: bytes[0..<count], encoding: .utf8)
}

private func fileType(_ metadata: stat) -> mode_t { metadata.st_mode & mode_t(S_IFMT) }

private func validOwnerModeDevice(
    _ metadata: stat,
    expectedDevice: dev_t,
    allowedModes: Set<mode_t>
) -> Bool {
    metadata.st_uid == Darwin.geteuid()
        && metadata.st_dev == expectedDevice
        && allowedModes.contains(metadata.st_mode & 0o7777)
}

private func sameMetadata(_ lhs: stat, _ rhs: stat) -> Bool {
    lhs.st_dev == rhs.st_dev
        && lhs.st_ino == rhs.st_ino
        && lhs.st_uid == rhs.st_uid
        && lhs.st_mode == rhs.st_mode
        && lhs.st_nlink == rhs.st_nlink
        && lhs.st_size == rhs.st_size
        && lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec
        && lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec
        && lhs.st_ctimespec.tv_sec == rhs.st_ctimespec.tv_sec
        && lhs.st_ctimespec.tv_nsec == rhs.st_ctimespec.tv_nsec
}

private func sameStableDirectoryMetadata(_ lhs: stat, _ rhs: stat) -> Bool {
    lhs.st_dev == rhs.st_dev
        && lhs.st_ino == rhs.st_ino
        && lhs.st_uid == rhs.st_uid
        && lhs.st_mode == rhs.st_mode
}

private func digestRetainedDescriptor(_ descriptor: Int32, expectedSize: off_t) throws -> Data {
    guard expectedSize >= 0 else { throw OwnedInstallationRemovalError.invalidInstallation }
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
    var offset: off_t = 0
    while offset < expectedSize {
        let requested = min(buffer.count, Int(expectedSize - offset))
        let count = Darwin.pread(descriptor, &buffer, requested, offset)
        if count > 0 {
            hasher.update(data: Data(buffer[0..<count]))
            offset += off_t(count)
        } else if count < 0, errno == EINTR {
            continue
        } else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
    }
    var extra: UInt8 = 0
    guard Darwin.pread(descriptor, &extra, 1, offset) == 0 else {
        throw OwnedInstallationRemovalError.invalidInstallation
    }
    return Data(hasher.finalize())
}

private func readRetainedData(
    descriptor: Int32,
    expectedSize: off_t,
    maximumBytes: off_t
) throws -> Data {
    guard expectedSize >= 0, expectedSize <= maximumBytes else {
        throw OwnedInstallationRemovalError.invalidInstallation
    }
    var data = Data(count: Int(expectedSize))
    var offset = 0
    try data.withUnsafeMutableBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        while offset < bytes.count {
            let count = Darwin.pread(
                descriptor,
                base.advanced(by: offset),
                bytes.count - offset,
                off_t(offset)
            )
            if count > 0 { offset += count }
            else if count < 0, errno == EINTR { continue }
            else { throw OwnedInstallationRemovalError.invalidInstallation }
        }
    }
    return data
}

private func validComponent(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && !value.contains("/") && !value.contains("\0")
}

private func currentRemovalPOSIXError() -> POSIXError {
    POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
}

import Darwin
import Foundation

public enum OwnedInstallationRemovalError: Error, Equatable,
    CustomStringConvertible, CustomDebugStringConvertible {
    case invalidInstallation

    public var description: String { "Runtime Raiders installation removal was refused" }
    public var debugDescription: String { description }
}

/// An unforgeable-across-modules proof that the coordinator reached its
/// explicit revocation boundary. Only RuntimeRaidersCore can create one.
public struct CompleteRemovalAuthorization: Sendable {
    init() {}
}

public struct OwnedInstallationRemover: @unchecked Sendable {
    typealias MetadataTransform = (_ relativePath: String, _ metadata: stat) -> stat
    typealias ValidationCheckpoint = () throws -> Void
    typealias RemovalObserver = (_ relativePath: String) -> Void

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
        let plan = try validateCompleteInstallation()
        try validationCheckpoint()
        try plan.revalidateAll(metadataTransform: metadataTransform)

        if let support = plan.support {
            for name in Self.executableNames.sorted() {
                guard let node = support.children[name] else { continue }
                try remove(node, from: support.descriptor)
            }
            try synchronize(support.descriptor)
        }
        try remove(plan.command)
        try remove(plan.legacyPlist)
    }

    public func removeAllArtifacts(authorization: CompleteRemovalAuthorization) throws {
        _ = authorization
        let plan = try validateCompleteInstallation()
        try validationCheckpoint()
        try plan.revalidateAll(metadataTransform: metadataTransform)

        try remove(plan.command)
        try remove(plan.legacyPlist)
        if let support = plan.support {
            try remove(support, from: plan.applicationSupport.descriptor)
            try synchronize(plan.applicationSupport.descriptor)
        }
    }

    func prevalidateAllArtifacts() throws {
        _ = try validateCompleteInstallation()
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
                  metadata.st_nlink == 1 else {
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
            guard type == mode_t(S_IFREG),
                  validOwnerModeDevice(
                    metadata,
                    expectedDevice: expectedDevice,
                    allowedModes: [0o600]
                  ),
                  metadata.st_nlink == 1,
                  metadata.st_size >= 0 else {
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
                  metadata.st_size >= 0 else {
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
                kind: .regular
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
              metadata.st_nlink == 1 else {
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
                descriptor: descriptor
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

    private func remove(_ node: RetainedNode, from parentDescriptor: Int32) throws {
        try node.revalidate(
            parentDescriptor: parentDescriptor,
            metadataTransform: metadataTransform
        )
        if node.kind == .directory {
            for child in node.children.values.sorted(by: { $0.name < $1.name }) {
                try remove(child, from: node.descriptor)
            }
            try synchronize(node.descriptor)
            removalObserver(node.relativePath)
            guard Darwin.unlinkat(parentDescriptor, node.name, AT_REMOVEDIR) == 0 else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
        } else {
            removalObserver(node.relativePath)
            guard Darwin.unlinkat(parentDescriptor, node.name, 0) == 0 else {
                throw OwnedInstallationRemovalError.invalidInstallation
            }
        }
    }

    private func remove(_ link: RetainedLink?) throws {
        guard let link else { return }
        try link.revalidate(metadataTransform: metadataTransform)
        removalObserver(link.relativePath)
        guard Darwin.unlinkat(link.parent.descriptor, link.name, 0) == 0 else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        try synchronize(link.parent.descriptor)
    }

    private func remove(_ file: RetainedExternalFile?) throws {
        guard let file else { return }
        try file.revalidate(metadataTransform: metadataTransform)
        removalObserver(file.relativePath)
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
            "update.lock", "re-enrollment.json",
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
    var children: [String: RetainedNode] = [:]

    init(
        name: String,
        relativePath: String,
        metadata: stat,
        descriptor: Int32,
        kind: RetainedNodeKind
    ) {
        self.name = name
        self.relativePath = relativePath
        self.metadata = metadata
        self.descriptor = descriptor
        self.kind = kind
    }

    deinit { if descriptor >= 0 { Darwin.close(descriptor) } }

    func revalidate(
        parentDescriptor: Int32,
        metadataTransform: OwnedInstallationRemover.MetadataTransform
    ) throws {
        var pathMetadata = stat()
        guard Darwin.fstatat(
            parentDescriptor,
            name,
            &pathMetadata,
            AT_SYMLINK_NOFOLLOW
        ) == 0,
        sameMetadata(metadata, metadataTransform(relativePath, pathMetadata)) else {
            throw OwnedInstallationRemovalError.invalidInstallation
        }
        if descriptor >= 0 {
            var descriptorMetadata = stat()
            guard Darwin.fstat(descriptor, &descriptorMetadata) == 0,
                  sameMetadata(
                    metadata,
                    metadataTransform(relativePath, descriptorMetadata)
                  ) else {
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

    init(
        parent: RetainedDirectory,
        name: String,
        relativePath: String,
        metadata: stat,
        descriptor: Int32
    ) {
        self.parent = parent
        self.name = name
        self.relativePath = relativePath
        self.metadata = metadata
        self.descriptor = descriptor
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
              sameMetadata(metadata, metadataTransform(relativePath, descriptorMetadata)) else {
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
}

private func validComponent(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && !value.contains("/") && !value.contains("\0")
}

private func currentRemovalPOSIXError() -> POSIXError {
    POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
}

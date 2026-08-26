import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class OwnedInstallationRemoverTests: XCTestCase {
    func testPreserveRemovalDeletesOnlyExecutableArtifactsAndPreservesStateBytes() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let protectedBefore = try fixture.protectedFingerprint()
        let unrelatedBefore = try fixture.unrelatedFingerprint()

        try OwnedInstallationRemover(paths: fixture.paths).removeExecutableArtifacts()

        for removed in fixture.executableArtifacts {
            XCTAssertFalse(entryExists(removed), "owned executable artifact must be absent")
        }
        XCTAssertEqual(try fixture.protectedFingerprint(), protectedBefore)
        XCTAssertEqual(try fixture.unrelatedFingerprint(), unrelatedBefore)
        XCTAssertTrue(entryExists(fixture.paths.agent.supportDirectory))
        XCTAssertTrue(entryExists(fixture.paths.agent.stateDirectory))
        XCTAssertTrue(entryExists(fixture.paths.agent.outboxDirectory))
    }

    func testCompleteRemovalDeletesSupportAndExactCommandButPreservesUnrelatedSiblings() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let unrelatedBefore = try fixture.unrelatedFingerprint()
        let remover = OwnedInstallationRemover(paths: fixture.paths)

        try remover.removeAllArtifacts(authorization: CompleteRemovalAuthorization())

        XCTAssertFalse(entryExists(fixture.paths.agent.supportDirectory))
        XCTAssertFalse(entryExists(fixture.paths.commandShim))
        XCTAssertFalse(entryExists(fixture.paths.legacyPlist))
        XCTAssertEqual(try fixture.unrelatedFingerprint(), unrelatedBefore)
        XCTAssertTrue(entryExists(fixture.paths.lifecycleLock))
    }

    func testEverySymlinkReplacementFailsBeforeAnyDeletionAndDoesNotTouchTarget() throws {
        let attacks: [(String, (RemovalFixture, URL) throws -> Void)] = [
            ("support", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.supportDirectory, target: target)
            }),
            ("state", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.stateDirectory, target: target)
            }),
            ("outbox", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.outboxDirectory, target: target)
            }),
            ("app", { fixture, target in
                try replaceWithSymlink(fixture.paths.agent.agentApplication, target: target)
            }),
            ("shim", { fixture, target in
                try replaceWithSymlink(fixture.paths.supportShim, target: target)
            }),
            ("plist", { fixture, target in
                try replaceWithSymlink(fixture.paths.legacyPlist, target: target)
            }),
        ]

        for (name, attack) in attacks {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            let target = fixture.root.appendingPathComponent("outside-\(name)")
            try writePrivate(Data("outside-\(name)".utf8), to: target)
            try attack(fixture, target)
            var removals: [String] = []
            let remover = OwnedInstallationRemover(
                paths: fixture.paths,
                removalObserver: { removals.append($0) }
            )

            XCTAssertThrowsError(try remover.removeExecutableArtifacts(), name)
            XCTAssertTrue(removals.isEmpty, name)
            XCTAssertEqual(try Data(contentsOf: target), Data("outside-\(name)".utf8), name)
            XCTAssertTrue(entryExists(fixture.paths.commandShim), name)
            XCTAssertTrue(entryExists(fixture.paths.legacyPlist), name)
        }
    }

    func testWrongCommandTargetIsRejectedRatherThanUnlinked() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        try FileManager.default.removeItem(at: fixture.paths.commandShim)
        try FileManager.default.createSymbolicLink(
            at: fixture.paths.commandShim,
            withDestinationURL: fixture.unrelatedCommand
        )
        var removals: [String] = []

        XCTAssertThrowsError(
            try OwnedInstallationRemover(
                paths: fixture.paths,
                removalObserver: { removals.append($0) }
            ).removeExecutableArtifacts()
        )
        XCTAssertTrue(removals.isEmpty)
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: fixture.paths.commandShim.path),
            fixture.unrelatedCommand.path
        )
    }

    func testHardLinkUnexpectedEntryAndUnsafeStateOrOutboxNamesFailBeforeDeletion() throws {
        let mutations: [(String, (RemovalFixture) throws -> Void)] = [
            ("hard-linked-enrollment-secret", { fixture in
                try FileManager.default.removeItem(at: fixture.paths.enrollment)
                guard Darwin.link(
                    fixture.unrelatedCommand.path,
                    fixture.paths.enrollment.path
                ) == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
            }),
            ("nested-app-symlink", { fixture in
                try FileManager.default.createSymbolicLink(
                    at: fixture.paths.agent.agentApplication.appendingPathComponent("nested-link"),
                    withDestinationURL: fixture.unrelatedCommand
                )
            }),
            ("unexpected-top-level", { fixture in
                try writePrivate(
                    Data("unexpected".utf8),
                    to: fixture.paths.agent.supportDirectory.appendingPathComponent("other")
                )
            }),
            ("unsafe-state-name", { fixture in
                try writePrivate(
                    Data("unsafe".utf8),
                    to: fixture.paths.agent.stateDirectory.appendingPathComponent("secret.txt")
                )
            }),
            ("unsafe-outbox-name", { fixture in
                try writePrivate(
                    Data("unsafe".utf8),
                    to: fixture.paths.agent.outboxDirectory.appendingPathComponent("record.json")
                )
            }),
        ]

        for (name, mutate) in mutations {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            try mutate(fixture)
            var removals: [String] = []

            XCTAssertThrowsError(
                try OwnedInstallationRemover(
                    paths: fixture.paths,
                    removalObserver: { removals.append($0) }
                ).removeAllArtifacts(authorization: CompleteRemovalAuthorization()),
                name
            )
            XCTAssertTrue(removals.isEmpty, name)
            XCTAssertTrue(entryExists(fixture.paths.agent.agentApplication), name)
            XCTAssertTrue(entryExists(fixture.paths.commandShim), name)
        }
    }

    func testOwnerModeTypeAndDeviceMetadataFailuresBeginNoDeletion() throws {
        let changes: [(String, (inout stat) -> Void)] = [
            ("owner", { $0.st_uid = Darwin.geteuid() &+ 1 }),
            ("mode", { $0.st_mode = ($0.st_mode & ~mode_t(0o7777)) | 0o777 }),
            ("type", { $0.st_mode = ($0.st_mode & ~mode_t(S_IFMT)) | mode_t(S_IFCHR) }),
            ("device", { $0.st_dev = $0.st_dev &+ 1 }),
        ]

        for (name, change) in changes {
            let fixture = try RemovalFixture()
            defer { fixture.remove() }
            var removals: [String] = []
            let remover = OwnedInstallationRemover(
                paths: fixture.paths,
                metadataTransform: { relative, metadata in
                    guard relative == "Runtime Raiders.app" else { return metadata }
                    var changed = metadata
                    change(&changed)
                    return changed
                },
                removalObserver: { removals.append($0) }
            )

            XCTAssertThrowsError(try remover.removeExecutableArtifacts(), name)
            XCTAssertTrue(removals.isEmpty, name)
            XCTAssertTrue(entryExists(fixture.paths.agent.agentApplication), name)
        }
    }

    func testDirectorySwapAfterValidationIsRejectedBeforeDeletion() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let displaced = fixture.root.appendingPathComponent("displaced-support", isDirectory: true)
        var removals: [String] = []
        let remover = OwnedInstallationRemover(
            paths: fixture.paths,
            validationCheckpoint: {
                try FileManager.default.moveItem(
                    at: fixture.paths.agent.supportDirectory,
                    to: displaced
                )
                try FileManager.default.createDirectory(
                    at: fixture.paths.agent.supportDirectory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            },
            removalObserver: { removals.append($0) }
        )

        XCTAssertThrowsError(try remover.removeExecutableArtifacts())
        XCTAssertTrue(removals.isEmpty)
        XCTAssertTrue(entryExists(displaced.appendingPathComponent("Runtime Raiders.app")))
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
        XCTAssertTrue(entryExists(fixture.paths.legacyPlist))
    }

    func testNestedStateDirectorySwapAfterValidationIsRejectedBeforeDeletion() throws {
        let fixture = try RemovalFixture()
        defer { fixture.remove() }
        let displaced = fixture.root.appendingPathComponent("displaced-state", isDirectory: true)
        var removals: [String] = []
        let remover = OwnedInstallationRemover(
            paths: fixture.paths,
            validationCheckpoint: {
                try FileManager.default.moveItem(
                    at: fixture.paths.agent.stateDirectory,
                    to: displaced
                )
                try FileManager.default.createDirectory(
                    at: fixture.paths.agent.stateDirectory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            },
            removalObserver: { removals.append($0) }
        )

        XCTAssertThrowsError(try remover.removeExecutableArtifacts())
        XCTAssertTrue(removals.isEmpty)
        XCTAssertTrue(entryExists(displaced.appendingPathComponent("enrollment.json")))
        XCTAssertTrue(entryExists(fixture.paths.agent.agentApplication))
        XCTAssertTrue(entryExists(fixture.paths.commandShim))
    }

    func testSuccessfulRemovalIsIdempotentInBothModes() throws {
        let preserve = try RemovalFixture()
        defer { preserve.remove() }
        let preserveRemover = OwnedInstallationRemover(paths: preserve.paths)
        try preserveRemover.removeExecutableArtifacts()
        try preserveRemover.removeExecutableArtifacts()
        XCTAssertTrue(entryExists(preserve.paths.enrollment))

        let complete = try RemovalFixture()
        defer { complete.remove() }
        let completeRemover = OwnedInstallationRemover(paths: complete.paths)
        try completeRemover.removeAllArtifacts(authorization: CompleteRemovalAuthorization())
        try completeRemover.removeAllArtifacts(authorization: CompleteRemovalAuthorization())
        XCTAssertFalse(entryExists(complete.paths.agent.supportDirectory))
    }
}

private final class RemovalFixture {
    let root: URL
    let paths: CompanionLifecyclePaths
    let unrelatedCommand: URL

    init() throws {
        root = URL(fileURLWithPath: "/private/tmp", isDirectory: true).appendingPathComponent(
            "r5-\(UUID().uuidString.prefix(8))",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        paths = try CompanionLifecyclePaths(homeDirectory: root)
        for directory in [
            root.appendingPathComponent("Library", isDirectory: true),
            root.appendingPathComponent("Library/Application Support", isDirectory: true),
            paths.agent.supportDirectory,
            paths.agent.stateDirectory,
            paths.agent.outboxDirectory,
            root.appendingPathComponent("Library/LaunchAgents", isDirectory: true),
            root.appendingPathComponent(".local", isDirectory: true),
            root.appendingPathComponent(".local/bin", isDirectory: true),
            root.appendingPathComponent(".codex", isDirectory: true),
            root.appendingPathComponent(".codex/sessions", isDirectory: true),
        ] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
        }

        let app = paths.agent.agentApplication
        for directory in [
            app,
            app.appendingPathComponent("Contents", isDirectory: true),
            app.appendingPathComponent("Contents/MacOS", isDirectory: true),
            app.appendingPathComponent("Contents/Resources", isDirectory: true),
            app.appendingPathComponent("Contents/Library", isDirectory: true),
            app.appendingPathComponent("Contents/Library/LaunchAgents", isDirectory: true),
        ] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o755]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: directory.path
            )
        }
        try writeFile(Data("agent".utf8), to: paths.agent.agentExecutable, mode: 0o755)
        try writeFile(Data("managed".utf8), to: paths.managedPlist, mode: 0o644)
        try writeFile(
            Data("resource".utf8),
            to: app.appendingPathComponent("Contents/Resources/data.bin"),
            mode: 0o644
        )
        try writeFile(Data("shim".utf8), to: paths.supportShim, mode: 0o700)
        try FileManager.default.createSymbolicLink(
            at: paths.commandShim,
            withDestinationURL: paths.supportShim
        )
        try writePrivate(Data("legacy".utf8), to: paths.legacyPlist)
        try makeUnixSocket(at: paths.agent.controlSocket)
        try writeFile(
            Data(),
            to: paths.agent.supportDirectory.appendingPathComponent(
                ".agent.sock.runtime-raiders.lock"
            ),
            mode: 0o600
        )

        try writePrivate(Data("enrollment".utf8), to: paths.enrollment)
        try writePrivate(
            Data(#"{"enabled":false,"files":{},"version":1}"#.utf8),
            to: paths.agent.stateDirectory.appendingPathComponent("collector-state.json")
        )
        try writePrivate(Data("cursor".utf8), to: paths.agent.stateDirectory.appendingPathComponent("update-state.json"))
        try writePrivate(Data("journal".utf8), to: paths.recoveryJournal)
        try writeFile(Data(), to: paths.agent.updateLock, mode: 0o600)
        try writePrivate(
            Data("record".utf8),
            to: paths.agent.outboxDirectory.appendingPathComponent(String(repeating: "a", count: 64) + ".json")
        )

        for name in ["releases", "installation", "launcher"] {
            let directory = paths.agent.supportDirectory.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            try writePrivate(Data(name.utf8), to: directory.appendingPathComponent("owned.dat"))
        }

        unrelatedCommand = root.appendingPathComponent(".local/bin/unrelated")
        try writePrivate(Data("keep-command".utf8), to: unrelatedCommand)
        try writePrivate(
            Data("keep-plist".utf8),
            to: root.appendingPathComponent("Library/LaunchAgents/unrelated.plist")
        )
        let unrelatedSupport = root.appendingPathComponent(
            "Library/Application Support/Unrelated",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: unrelatedSupport,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        try writePrivate(Data("keep-support".utf8), to: unrelatedSupport.appendingPathComponent("data"))
        try writePrivate(
            Data("keep-session".utf8),
            to: root.appendingPathComponent(".codex/sessions/session.jsonl")
        )
        try writeFile(Data(), to: paths.lifecycleLock, mode: 0o600)
    }

    var executableArtifacts: [URL] {
        [
            paths.agent.agentApplication,
            paths.supportShim,
            paths.commandShim,
            paths.agent.controlSocket,
            paths.agent.supportDirectory.appendingPathComponent(
                ".agent.sock.runtime-raiders.lock"
            ),
            paths.legacyPlist,
            paths.agent.supportDirectory.appendingPathComponent("releases"),
            paths.agent.supportDirectory.appendingPathComponent("installation"),
            paths.agent.supportDirectory.appendingPathComponent("launcher"),
        ]
    }

    func protectedFingerprint() throws -> [String: String] {
        try fingerprint([
            paths.agent.stateDirectory,
            paths.agent.outboxDirectory,
        ])
    }

    func unrelatedFingerprint() throws -> [String: String] {
        try fingerprint([
            root.appendingPathComponent(".local/bin/unrelated"),
            root.appendingPathComponent("Library/LaunchAgents/unrelated.plist"),
            root.appendingPathComponent("Library/Application Support/Unrelated"),
            root.appendingPathComponent(".codex/sessions"),
        ])
    }

    func remove() { try? FileManager.default.removeItem(at: root) }
}

private func fingerprint(_ roots: [URL]) throws -> [String: String] {
    var result: [String: String] = [:]
    for root in roots {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else {
            result[root.path] = "absent"
            continue
        }
        if isDirectory.boolValue {
            let names = try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
            result[root.path] = "directory:\(names.joined(separator: ","))"
            for name in names {
                result.merge(
                    try fingerprint([root.appendingPathComponent(name)]),
                    uniquingKeysWith: { _, new in new }
                )
            }
        } else {
            let data = try Data(contentsOf: root)
            let mode = try fullMode(root)
            result[root.path] = "file:\(mode):\(data.base64EncodedString())"
        }
    }
    return result
}

private func replaceWithSymlink(_ url: URL, target: URL) throws {
    try FileManager.default.removeItem(at: url)
    try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
}

private func writePrivate(_ data: Data, to url: URL) throws {
    try writeFile(data, to: url, mode: 0o600)
}

private func writeFile(_ data: Data, to url: URL, mode: Int) throws {
    guard FileManager.default.createFile(
        atPath: url.path,
        contents: data,
        attributes: [.posixPermissions: mode]
    ) else { throw CocoaError(.fileWriteUnknown) }
    try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
}

private func makeUnixSocket(at url: URL) throws {
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw POSIXError(.EIO) }
    defer { Darwin.close(descriptor) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(url.path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw POSIXError(.ENAMETOOLONG)
    }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        for index in buffer.indices { buffer[index] = 0 }
        for (index, byte) in bytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + bytes.count)
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(descriptor, $0, length)
        }
    }
    guard result == 0, Darwin.chmod(url.path, 0o600) == 0 else { throw POSIXError(.EIO) }
}

private func entryExists(_ url: URL) -> Bool {
    var metadata = stat()
    return Darwin.lstat(url.path, &metadata) == 0
}

private func fullMode(_ url: URL) throws -> Int {
    var metadata = stat()
    guard Darwin.lstat(url.path, &metadata) == 0 else { throw POSIXError(.EIO) }
    return Int(metadata.st_mode & 0o7777)
}

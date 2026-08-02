import Darwin
import Foundation
import XCTest
@testable import RuntimeRaidersCore

final class AdapterRegistryTests: XCTestCase {
    func testCodexSurfacesEnableAndAssignOpaqueKeys() throws {
        let root = try temporaryDirectory()
        let registry = try AdapterRegistry.enabled(
            surfaceNames: ["codex_desktop", "codex_cli"],
            codexRoot: root
        )
        XCTAssertEqual(registry.surfaces, [.codexDesktop, .codexCLI])
        let observation = NativeRunObservation(
            nativeID: "DO_NOT_EXPORT_NATIVE_ID",
            provider: .codex,
            surface: .codexCLI,
            sequence: 4,
            eventTimeMS: 100,
            observedAtMS: 101,
            startedAtMS: 90,
            state: .open,
            usage: .init(input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoningOutput: 5),
            model: nil,
            effort: nil
        )
        let event = try registry.event(
            from: observation,
            dedupeSecret: Data("secret".utf8),
            companionVersion: "0.1.0",
            deviceID: "00000000-0000-4000-8000-000000000001"
        )
        XCTAssertEqual(event.runKey.count, 64)
        XCTAssertEqual(event.idempotencyKey.count, 64)
        let encoded = try PrivacyEncoder().encode(event)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("DO_NOT_EXPORT"))
    }

    func testDisabledUnknownDuplicateAndMixedRequestsFailBeforeRootProbe() {
        let missing = URL(fileURLWithPath: "/DO_NOT_EXPORT_MISSING_ROOT")
        for names in [["claude_code"], ["omp"], ["unknown"], ["codex_cli", "omp"], ["codex_cli", "codex_cli"]] {
            XCTAssertThrowsError(try AdapterRegistry.enabled(surfaceNames: names, codexRoot: missing)) { error in
                XCTAssertNotEqual(error as? AdapterRegistryError, .invalidCodexRoot)
            }
        }
    }

    func testRunKeysAreStableAndSurfaceSeparated() throws {
        let root = try temporaryDirectory()
        let registry = try AdapterRegistry.enabled(
            surfaceNames: ["codex_cli", "codex_desktop"],
            codexRoot: root
        )
        func observation(_ surface: RunSurface) -> NativeRunObservation {
            NativeRunObservation(
                nativeID: "same-native-id", provider: .codex, surface: surface,
                sequence: 2, eventTimeMS: 2, observedAtMS: 2, startedAtMS: 1,
                state: .open,
                usage: .init(input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0),
                model: nil, effort: nil
            )
        }
        let arguments = (Data("shared-secret".utf8), "0.1.0", "00000000-0000-4000-8000-000000000001")
        let first = try registry.event(from: observation(.codexCLI), dedupeSecret: arguments.0, companionVersion: arguments.1, deviceID: arguments.2)
        let replay = try registry.event(from: observation(.codexCLI), dedupeSecret: arguments.0, companionVersion: arguments.1, deviceID: arguments.2)
        let desktop = try registry.event(from: observation(.codexDesktop), dedupeSecret: arguments.0, companionVersion: arguments.1, deviceID: arguments.2)
        XCTAssertEqual(first, replay)
        XCTAssertNotEqual(first.runKey, desktop.runKey)
        XCTAssertNotEqual(first.idempotencyKey, desktop.idempotencyKey)
    }

    func testCodexRootMustBeRealDirectoryAndRejectSymlinkComponents() throws {
        let parent = try temporaryDirectory()
        let real = parent.appendingPathComponent("real", isDirectory: true)
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false)
        let link = parent.appendingPathComponent("link", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertThrowsError(try AdapterRegistry.enabled(surfaceNames: ["codex_cli"], codexRoot: link))
        let file = parent.appendingPathComponent("file")
        try Data().write(to: file)
        XCTAssertThrowsError(try AdapterRegistry.enabled(surfaceNames: ["codex_cli"], codexRoot: file))
    }

    func testResolvedProviderFileCannotEscapeApprovedRoot() throws {
        let parent = try temporaryDirectory()
        let root = parent.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let file = root.appendingPathComponent("rollout.jsonl")
        try Data().write(to: file)
        let registry = try AdapterRegistry.enabled(surfaceNames: ["codex_cli"], codexRoot: root)
        let approved = try registry.approveProviderFile(file)
        XCTAssertEqual(try approved.readAppended(cursor: JSONLCursor(), maxBytes: 16).bytesRead, 0)
        XCTAssertThrowsError(try registry.approveProviderFile(parent.appendingPathComponent("outside.jsonl")))
        let link = root.appendingPathComponent("escape.jsonl")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try registry.approveProviderFile(link))
    }

    func testApprovedDescriptorCannotBeRedirectedAfterParentSwap() throws {
        let parent = try temporaryDirectory()
        let root = parent.appendingPathComponent("codex", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let file = root.appendingPathComponent("rollout.jsonl")
        try Data("original\n".utf8).write(to: file)
        let registry = try AdapterRegistry.enabled(surfaceNames: ["codex_cli"], codexRoot: root)
        let approved = try registry.approveProviderFile(file)

        let moved = parent.appendingPathComponent("moved", isDirectory: true)
        try FileManager.default.moveItem(at: root, to: moved)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let outside = parent.appendingPathComponent("outside.jsonl")
        try Data("DO_NOT_EXPORT_REDIRECT\n".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("rollout.jsonl"),
            withDestinationURL: outside
        )

        let result = try approved.readAppended(cursor: JSONLCursor(), maxBytes: 64)
        XCTAssertEqual(result.lines, [Data("original".utf8)])
    }

    func testUnreadableCodexRootFailsClosed() throws {
        let root = try temporaryDirectory()
        XCTAssertEqual(Darwin.chmod(root.path, 0), 0)
        defer { _ = Darwin.chmod(root.path, 0o700) }
        XCTAssertThrowsError(
            try AdapterRegistry.enabled(surfaceNames: ["codex_cli"], codexRoot: root)
        )
    }

    private func temporaryDirectory() throws -> URL {
        let basePath = FileManager.default.temporaryDirectory.path
        let canonicalBase = URL(fileURLWithPath:
            basePath == "/var" || basePath.hasPrefix("/var/")
                ? "/private" + basePath
                : basePath
        )
        let url = canonicalBase
            .appendingPathComponent("runtime-raiders-registry-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}

import Darwin
import Foundation

public enum AdapterRegistryError: Error, Equatable {
    case unsupportedSurface
    case duplicateSurface
    case invalidCodexRoot
    case providerFileOutsideRoot
    case invalidObservation
}

public struct AdapterRegistry: Sendable {
    public let surfaces: [RunSurface]
    public let codexRoot: URL

    public static func enabled(surfaceNames: [String], codexRoot: URL) throws -> AdapterRegistry {
        var surfaces: [RunSurface] = []
        var seen = Set<RunSurface>()
        for name in surfaceNames {
            guard let surface = RunSurface(rawValue: name),
                  surface == .codexDesktop || surface == .codexCLI else {
                throw AdapterRegistryError.unsupportedSurface
            }
            guard seen.insert(surface).inserted else {
                throw AdapterRegistryError.duplicateSurface
            }
            surfaces.append(surface)
        }
        guard !surfaces.isEmpty, try isRealDirectoryWithoutSymlink(codexRoot) else {
            throw AdapterRegistryError.invalidCodexRoot
        }
        return AdapterRegistry(
            surfaces: surfaces,
            codexRoot: codexRoot.standardizedFileURL
        )
    }

    public static func enabled(surfaces: [RunSurface], codexRoot: URL) throws -> AdapterRegistry {
        try enabled(surfaceNames: surfaces.map(\.rawValue), codexRoot: codexRoot)
    }

    public func adapter(for surface: RunSurface) throws -> CodexAdapter {
        guard surfaces.contains(surface) else { throw AdapterRegistryError.unsupportedSurface }
        return CodexAdapter(expectedSurface: surface)
    }

    @discardableResult
    public func approveProviderFile(_ file: URL) throws -> URL {
        let standardized = file.standardizedFileURL
        let prefix = codexRoot.path.hasSuffix("/") ? codexRoot.path : codexRoot.path + "/"
        guard standardized.path.hasPrefix(prefix),
              try Self.isRegularFileWithoutSymlink(standardized) else {
            throw AdapterRegistryError.providerFileOutsideRoot
        }
        return standardized
    }

    public func event(
        from observation: NativeRunObservation,
        dedupeSecret: Data,
        companionVersion: String,
        deviceID: String
    ) throws -> RunEventV1 {
        guard observation.provider == .codex,
              surfaces.contains(observation.surface),
              observation.surface == .codexDesktop || observation.surface == .codexCLI else {
            throw AdapterRegistryError.invalidObservation
        }
        let nativeIdentity = observation.surface.rawValue + "\0" + observation.nativeID
        let runKey = try RunIdentity.key(
            provider: .codex,
            nativeID: nativeIdentity,
            dedupeSecret: dedupeSecret
        )
        let idempotencyKey = try RunIdentity.eventKey(
            runKey: runKey,
            sequence: observation.sequence
        )
        return RunEventV1(
            schemaVersion: 1,
            companionVersion: companionVersion,
            deviceID: deviceID,
            provider: observation.provider,
            surface: observation.surface,
            runKey: runKey,
            sequence: observation.sequence,
            eventTimeMS: observation.eventTimeMS,
            observedAtMS: observation.observedAtMS,
            startedAtMS: observation.startedAtMS,
            state: observation.state,
            usage: observation.usage,
            model: observation.model,
            effort: observation.effort,
            idempotencyKey: idempotencyKey
        )
    }

    private static func isRealDirectoryWithoutSymlink(_ url: URL) throws -> Bool {
        guard try pathHasNoSymlink(url.standardizedFileURL) else { return false }
        var status = stat()
        guard Darwin.lstat(url.standardizedFileURL.path, &status) == 0 else { return false }
        return status.st_mode & S_IFMT == S_IFDIR
    }

    private static func isRegularFileWithoutSymlink(_ url: URL) throws -> Bool {
        guard try pathHasNoSymlink(url) else { return false }
        var status = stat()
        guard Darwin.lstat(url.path, &status) == 0 else { return false }
        return status.st_mode & S_IFMT == S_IFREG
    }

    private static func pathHasNoSymlink(_ url: URL) throws -> Bool {
        guard url.isFileURL else { return false }
        let standardized = url.standardizedFileURL
        return standardized.resolvingSymlinksInPath().path == standardized.path
    }
}

import Darwin
import Foundation

public enum AdapterRegistryError: Error, Equatable {
    case unsupportedSurface
    case duplicateSurface
    case invalidCodexRoot
    case providerFileOutsideRoot
    case invalidObservation
}

public final class ApprovedProviderFile: @unchecked Sendable {
    private let descriptor: Int32

    fileprivate init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    deinit {
        Darwin.close(descriptor)
    }

    public func readAppended(
        cursor: JSONLCursor,
        maxBytes: Int
    ) throws -> JSONLReadResult {
        try JSONLReader.readAppended(
            file: URL(fileURLWithPath: "/dev/fd/\(descriptor)"),
            cursor: cursor,
            maxBytes: maxBytes
        )
    }

    func cursor(atOffset offset: Int64, expectedIdentity: JSONLFileIdentity) throws -> JSONLCursor {
        try JSONLReader.cursor(
            file: URL(fileURLWithPath: "/dev/fd/\(descriptor)"),
            atOffset: offset,
            expectedIdentity: expectedIdentity
        )
    }

    func isCurrent(_ cursor: JSONLCursor) throws -> Bool {
        try JSONLReader.isCurrent(
            file: URL(fileURLWithPath: "/dev/fd/\(descriptor)"),
            cursor: cursor
        )
    }

    func snapshot() throws -> (identity: JSONLFileIdentity, size: Int64) {
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size >= 0 else {
            throw JSONLReaderError.unsupportedFile
        }
        return (
            JSONLFileIdentity(
                device: UInt64(metadata.st_dev),
                inode: UInt64(metadata.st_ino)
            ),
            Int64(metadata.st_size)
        )
    }
}

public final class AdapterRegistry: @unchecked Sendable {
    public let surfaces: [RunSurface]
    public let codexRoot: URL
    private let rootDescriptor: Int32

    private init(surfaces: [RunSurface], codexRoot: URL, rootDescriptor: Int32) {
        self.surfaces = surfaces
        self.codexRoot = codexRoot
        self.rootDescriptor = rootDescriptor
    }

    deinit {
        Darwin.close(rootDescriptor)
    }

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
        guard !surfaces.isEmpty else {
            throw AdapterRegistryError.invalidCodexRoot
        }
        let standardizedRoot = URL(fileURLWithPath: codexRoot.path, isDirectory: true)
        guard !standardizedRoot.pathComponents.contains("."),
              !standardizedRoot.pathComponents.contains("..") else {
            throw AdapterRegistryError.invalidCodexRoot
        }
        let descriptor: Int32
        do {
            descriptor = try openDirectoryTree(standardizedRoot)
        } catch {
            throw AdapterRegistryError.invalidCodexRoot
        }
        return AdapterRegistry(
            surfaces: surfaces,
            codexRoot: standardizedRoot,
            rootDescriptor: descriptor
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
    public func approveProviderFile(_ file: URL) throws -> ApprovedProviderFile {
        let standardized = URL(fileURLWithPath: file.path, isDirectory: false)
        let prefix = codexRoot.path.hasSuffix("/") ? codexRoot.path : codexRoot.path + "/"
        guard standardized.path.hasPrefix(prefix) else {
            throw AdapterRegistryError.providerFileOutsideRoot
        }
        let relative = String(standardized.path.dropFirst(prefix.count))
        let components = relative.split(separator: "/").map(String.init)
        guard !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw AdapterRegistryError.providerFileOutsideRoot
        }
        var directory = Darwin.dup(rootDescriptor)
        guard directory >= 0 else { throw AdapterRegistryError.providerFileOutsideRoot }
        defer { if directory >= 0 { Darwin.close(directory) } }
        for component in components.dropLast() {
            let next = Darwin.openat(
                directory,
                component,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            guard next >= 0 else { throw AdapterRegistryError.providerFileOutsideRoot }
            Darwin.close(directory)
            directory = next
        }
        let descriptor = Darwin.openat(
            directory,
            components.last!,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else { throw AdapterRegistryError.providerFileOutsideRoot }
        var status = stat()
        guard Darwin.fstat(descriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG else {
            Darwin.close(descriptor)
            throw AdapterRegistryError.providerFileOutsideRoot
        }
        return ApprovedProviderFile(descriptor: descriptor)
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
        let runKey = try RunIdentity.key(
            provider: .codex,
            nativeID: observation.nativeID,
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

    private static func openDirectoryTree(_ url: URL) throws -> Int32 {
        guard url.isFileURL, url.path.hasPrefix("/") else {
            throw AdapterRegistryError.invalidCodexRoot
        }
        var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { throw AdapterRegistryError.invalidCodexRoot }
        for component in url.pathComponents where component != "/" {
            let next = Darwin.openat(
                descriptor,
                component,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            guard next >= 0 else {
                Darwin.close(descriptor)
                throw AdapterRegistryError.invalidCodexRoot
            }
            Darwin.close(descriptor)
            descriptor = next
        }
        guard Darwin.faccessat(descriptor, ".", R_OK | X_OK, 0) == 0 else {
            Darwin.close(descriptor)
            throw AdapterRegistryError.invalidCodexRoot
        }
        return descriptor
    }
}

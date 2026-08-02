import CoreServices
import Darwin
import Foundation

public enum FileWatcherError: Error, Equatable {
    case streamCreationFailed
    case streamStartFailed
}

public final class FileWatcher: @unchecked Sendable {
    public typealias ChangeHandler = @Sendable ([URL]) -> Void

    public let watchedRoots: [URL]
    private let registry: AdapterRegistry
    private let handler: ChangeHandler
    private let processingQueue: DispatchQueue
    private let afterStreamStarted: @Sendable () -> Void
    private let eventQueue = DispatchQueue(
        label: "com.redlattice.runtime-raiders.fsevents",
        qos: .utility
    )
    private let lock = NSLock()
    private var stream: FSEventStreamRef?
    private var retainedContext: Unmanaged<FileWatcherCallbackBox>?
    private lazy var callbackBox = FileWatcherCallbackBox { [weak self] paths, requiresFullScan in
        guard let self else { return }
        processingQueue.async { [weak self] in
            guard let self else { return }
            let files = requiresFullScan
                ? try? discoverProviderFiles()
                : try? providerFiles(forChangedPaths: paths)
            guard let files else { return }
            handler(files)
        }
    }

    public init(
        registry: AdapterRegistry,
        processingQueue: DispatchQueue = DispatchQueue(
            label: "com.redlattice.runtime-raiders.provider-reader",
            qos: .utility
        ),
        onChange: @escaping ChangeHandler
    ) {
        self.registry = registry
        self.processingQueue = processingQueue
        afterStreamStarted = {}
        handler = onChange
        watchedRoots = [registry.codexRoot]
    }

    init(
        registry: AdapterRegistry,
        processingQueue: DispatchQueue,
        afterStreamStarted: @escaping @Sendable () -> Void,
        onChange: @escaping ChangeHandler
    ) {
        self.registry = registry
        self.processingQueue = processingQueue
        self.afterStreamStarted = afterStreamStarted
        handler = onChange
        watchedRoots = [registry.codexRoot]
    }

    deinit { stop() }

    public func discoverProviderFiles() throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: registry.codexRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsPackageDescendants]
        ) else { return [] }
        var files: [URL] = []
        for case let file as URL in enumerator where file.pathExtension == "jsonl" {
            if let approved = approvedRegularFile(file.path) { files.append(approved) }
        }
        return files.sorted { $0.path < $1.path }
    }

    public func providerFiles(forChangedPaths paths: [String]) throws -> [URL] {
        Array(Set(paths.compactMap(approvedRegularFile)))
            .sorted { $0.path < $1.path }
    }

    public func start() throws {
        let didStart = try lock.withLock { () throws -> Bool in
            guard stream == nil else { return false }
            let contextOwner = Unmanaged.passRetained(callbackBox)
            var context = FSEventStreamContext(
                version: 0,
                info: contextOwner.toOpaque(),
                retain: nil,
                release: nil,
                copyDescription: nil
            )
            let flags = FSEventStreamCreateFlags(
                kFSEventStreamCreateFlagFileEvents
                    | kFSEventStreamCreateFlagWatchRoot
                    | kFSEventStreamCreateFlagNoDefer
                    | kFSEventStreamCreateFlagUseCFTypes
            )
            guard let created = FSEventStreamCreate(
                kCFAllocatorDefault,
                fileWatcherCallback,
                &context,
                watchedRoots.map(\.path) as CFArray,
                FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                0.2,
                flags
            ) else {
                contextOwner.release()
                throw FileWatcherError.streamCreationFailed
            }
            FSEventStreamSetDispatchQueue(created, eventQueue)
            guard FSEventStreamStart(created) else {
                FSEventStreamInvalidate(created)
                FSEventStreamRelease(created)
                contextOwner.release()
                throw FileWatcherError.streamStartFailed
            }
            stream = created
            retainedContext = contextOwner
            return true
        }
        guard didStart else { return }
        afterStreamStarted()
        processingQueue.async { [weak self] in
            guard let self,
                  let files = try? discoverProviderFiles() else { return }
            handler(files)
        }
    }

    public func stop() {
        let old = lock.withLock { () -> (FSEventStreamRef?, Unmanaged<FileWatcherCallbackBox>?) in
            let value = stream
            let context = retainedContext
            stream = nil
            retainedContext = nil
            return (value, context)
        }
        if let stream = old.0 {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        old.1?.release()
    }

    private func approvedRegularFile(_ path: String) -> URL? {
        let file = URL(fileURLWithPath: path)
        let prefix = registry.codexRoot.path.hasSuffix("/")
            ? registry.codexRoot.path : registry.codexRoot.path + "/"
        guard file.path.hasPrefix(prefix), file.pathExtension == "jsonl" else { return nil }
        var metadata = stat()
        guard Darwin.lstat(file.path, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              (try? registry.approveProviderFile(file)) != nil else { return nil }
        return file
    }

}

private final class FileWatcherCallbackBox: @unchecked Sendable {
    private let callback: @Sendable ([String], Bool) -> Void

    init(callback: @escaping @Sendable ([String], Bool) -> Void) {
        self.callback = callback
    }

    func notify(paths: [String], requiresFullScan: Bool) {
        callback(paths, requiresFullScan)
    }
}

private let fileWatcherCallback: FSEventStreamCallback = {
    _, context, eventCount, eventPaths, eventFlags, _ in
    guard let context else { return }
    let box = Unmanaged<FileWatcherCallbackBox>.fromOpaque(context).takeUnretainedValue()
    let array = unsafeBitCast(eventPaths, to: CFArray.self)
    var paths: [String] = []
    paths.reserveCapacity(eventCount)
    for index in 0..<eventCount {
        guard let value = CFArrayGetValueAtIndex(array, index) else { continue }
        let string = Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue()
        paths.append(string as String)
    }
    let rescanFlags = FSEventStreamEventFlags(
        kFSEventStreamEventFlagMustScanSubDirs
            | kFSEventStreamEventFlagUserDropped
            | kFSEventStreamEventFlagKernelDropped
            | kFSEventStreamEventFlagRootChanged
    )
    var requiresFullScan = false
    for index in 0..<eventCount where eventFlags[index] & rescanFlags != 0 {
        requiresFullScan = true
        break
    }
    box.notify(paths: paths, requiresFullScan: requiresFullScan)
}

import Foundation

public struct ActivationOperations: @unchecked Sendable {
    public let startWatching: @Sendable () throws -> Void
    public let stopWatching: @Sendable () -> Void
    public let discoverProviderFiles: @Sendable () throws -> [URL]
    public let scheduleUpload: @Sendable () -> Void
    public let becameReady: @Sendable () -> Void
    public let becameDisabled: @Sendable () -> Void

    public init(
        startWatching: @escaping @Sendable () throws -> Void,
        stopWatching: @escaping @Sendable () -> Void,
        discoverProviderFiles: @escaping @Sendable () throws -> [URL],
        scheduleUpload: @escaping @Sendable () -> Void = {},
        becameReady: @escaping @Sendable () -> Void,
        becameDisabled: @escaping @Sendable () -> Void
    ) {
        self.startWatching = startWatching
        self.stopWatching = stopWatching
        self.discoverProviderFiles = discoverProviderFiles
        self.scheduleUpload = scheduleUpload
        self.becameReady = becameReady
        self.becameDisabled = becameDisabled
    }
}

public final class ActivationCoordinator: @unchecked Sendable {
    private let controller: AgentController
    private let workerQueue: DispatchQueue
    private let operations: ActivationOperations
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var readyGeneration: UInt64?

    public init(
        controller: AgentController,
        workerQueue: DispatchQueue = DispatchQueue(
            label: "com.redlattice.runtime-raiders.activation",
            qos: .utility
        ),
        operations: ActivationOperations
    ) {
        self.controller = controller
        self.workerQueue = workerQueue
        self.operations = operations
    }

    public func turnOn() throws -> CollectorActivationState {
        try lock.withLock {
            try controller.beginTurnOn()
            generation &+= 1
            let activationGeneration = generation
            readyGeneration = nil
            do {
                try operations.startWatching()
            } catch {
                generation &+= 1
                operations.becameDisabled()
                operations.stopWatching()
                try? controller.turnOff()
                throw error
            }
            workerQueue.async { [weak self] in
                self?.prepare(generation: activationGeneration)
            }
            return controller.activationState
        }
    }

    public func turnOff() throws {
        try lock.withLock {
            generation &+= 1
            readyGeneration = nil
            operations.becameDisabled()
            operations.stopWatching()
            try controller.turnOff()
        }
    }

    public func processChangedFiles(_ files: [URL]) {
        guard let activationGeneration = currentGenerationIfEnabled() else { return }
        do {
            try controller.processChangedFiles(files)
            scheduleUploadIfCurrent(generation: activationGeneration)
            workerQueue.async { [weak self] in
                self?.advance(generation: activationGeneration)
            }
        } catch {
            workerQueue.async { [weak self] in
                self?.failActivation(generation: activationGeneration)
            }
        }
    }

    private func prepare(generation activationGeneration: UInt64) {
        do {
            guard isCurrent(activationGeneration) else { return }
            let files = try operations.discoverProviderFiles()
            guard isCurrent(activationGeneration) else { return }
            try controller.install(existingFiles: files)
            guard isCurrent(activationGeneration) else { return }
            advance(generation: activationGeneration)
        } catch {
            failActivation(generation: activationGeneration)
        }
    }

    private func advance(generation activationGeneration: UInt64) {
        guard isCurrent(activationGeneration), controller.enabled else { return }
        switch controller.activationState {
        case .disabled:
            return
        case .ready:
            lock.withLock {
                guard generation == activationGeneration,
                      readyGeneration != activationGeneration else { return }
                readyGeneration = activationGeneration
                operations.becameReady()
            }
            guard isCurrent(activationGeneration), controller.hasPendingReadWork else { return }
            continueAndReschedule(generation: activationGeneration)
        case .preparing:
            guard controller.hasPendingReadWork else {
                failActivation(generation: activationGeneration)
                return
            }
            continueAndReschedule(generation: activationGeneration)
        }
    }

    private func continueAndReschedule(generation activationGeneration: UInt64) {
        do {
            try controller.continuePendingWork()
            scheduleUploadIfCurrent(generation: activationGeneration)
        } catch {
            failActivation(generation: activationGeneration)
            return
        }
        workerQueue.async { [weak self] in
            self?.advance(generation: activationGeneration)
        }
    }

    private func currentGenerationIfEnabled() -> UInt64? {
        lock.withLock {
            guard controller.enabled else { return nil }
            return generation
        }
    }

    private func scheduleUploadIfCurrent(generation activationGeneration: UInt64) {
        lock.withLock {
            guard generation == activationGeneration,
                  controller.isAcceptingCollection else { return }
            operations.scheduleUpload()
        }
    }

    private func isCurrent(_ activationGeneration: UInt64) -> Bool {
        lock.withLock { generation == activationGeneration }
    }

    private func failActivation(generation activationGeneration: UInt64) {
        lock.withLock {
            guard generation == activationGeneration else { return }
            generation &+= 1
            readyGeneration = nil
            operations.becameDisabled()
            operations.stopWatching()
            try? controller.turnOff()
        }
    }
}

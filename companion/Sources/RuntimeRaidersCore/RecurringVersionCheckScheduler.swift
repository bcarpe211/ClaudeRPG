import Foundation

public struct ScheduledVersionCheck: Sendable {
    private let cancelAction: @Sendable () -> Void

    public init(_ cancelAction: @escaping @Sendable () -> Void) {
        self.cancelAction = cancelAction
    }

    public func cancel() {
        cancelAction()
    }
}

public struct VersionCheckScheduleOperations: Sendable {
    public let checkIfDue: @Sendable () -> Void
    public let scheduleAfter: @Sendable (
        TimeInterval,
        @escaping @Sendable () -> Void
    ) -> ScheduledVersionCheck

    public init(
        checkIfDue: @escaping @Sendable () -> Void,
        scheduleAfter: @escaping @Sendable (
            TimeInterval,
            @escaping @Sendable () -> Void
        ) -> ScheduledVersionCheck
    ) {
        self.checkIfDue = checkIfDue
        self.scheduleAfter = scheduleAfter
    }
}

public final class RecurringVersionCheckScheduler: @unchecked Sendable {
    public static let opportunityInterval: TimeInterval = 60 * 60

    private let operations: VersionCheckScheduleOperations
    private let lock = NSLock()
    private var running = false
    private var generation: UInt64 = 0
    private var nextTimerID: UInt64 = 0
    private var scheduledTimerID: UInt64?
    private var scheduledCancellation: ScheduledVersionCheck?

    public init(operations: VersionCheckScheduleOperations) {
        self.operations = operations
    }

    deinit {
        stop()
    }

    public func start() {
        let activeGeneration = lock.withLock { () -> UInt64? in
            guard !running else { return nil }
            running = true
            generation &+= 1
            return generation
        }
        guard let activeGeneration else { return }

        operations.checkIfDue()
        scheduleNext(generation: activeGeneration)
    }

    public func stop() {
        let cancellation = lock.withLock { () -> ScheduledVersionCheck? in
            running = false
            generation &+= 1
            scheduledTimerID = nil
            defer { scheduledCancellation = nil }
            return scheduledCancellation
        }
        cancellation?.cancel()
    }

    private func scheduleNext(generation activeGeneration: UInt64) {
        let timerID = lock.withLock { () -> UInt64? in
            guard running, generation == activeGeneration else { return nil }
            nextTimerID &+= 1
            scheduledTimerID = nextTimerID
            scheduledCancellation = nil
            return nextTimerID
        }
        guard let timerID else { return }

        let cancellation = operations.scheduleAfter(Self.opportunityInterval) { [weak self] in
            self?.runOpportunity(generation: activeGeneration, timerID: timerID)
        }
        let staleCancellation = lock.withLock { () -> ScheduledVersionCheck? in
            guard running,
                  generation == activeGeneration,
                  scheduledTimerID == timerID else {
                return cancellation
            }
            scheduledCancellation = cancellation
            return nil
        }
        staleCancellation?.cancel()
    }

    private func runOpportunity(generation activeGeneration: UInt64, timerID: UInt64) {
        let shouldCheck = lock.withLock { () -> Bool in
            guard running,
                  generation == activeGeneration,
                  scheduledTimerID == timerID else {
                return false
            }
            scheduledTimerID = nil
            scheduledCancellation = nil
            return true
        }
        guard shouldCheck else { return }

        operations.checkIfDue()
        scheduleNext(generation: activeGeneration)
    }
}

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
    public let execute: @Sendable (@escaping @Sendable () -> Void) -> Void
    public let scheduleAfter: @Sendable (
        TimeInterval,
        @escaping @Sendable () -> Void
    ) -> ScheduledVersionCheck

    public init(
        checkIfDue: @escaping @Sendable () -> Void,
        execute: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void,
        scheduleAfter: @escaping @Sendable (
            TimeInterval,
            @escaping @Sendable () -> Void
        ) -> ScheduledVersionCheck
    ) {
        self.checkIfDue = checkIfDue
        self.execute = execute
        self.scheduleAfter = scheduleAfter
    }
}

public final class RecurringVersionCheckScheduler: @unchecked Sendable {
    public static let opportunityInterval: TimeInterval = 60 * 60

    private let operations: VersionCheckScheduleOperations
    private let condition = NSCondition()
    private var running = false
    private var inFlightCheckCount = 0
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
        let activeGeneration = condition.withLock { () -> UInt64? in
            guard !running else { return nil }
            running = true
            generation &+= 1
            return generation
        }
        guard let activeGeneration else { return }

        operations.execute { [weak self] in
            self?.runCheck(generation: activeGeneration)
        }
        scheduleNext(generation: activeGeneration)
    }

    public func stop() {
        let cancellation = condition.withLock { () -> ScheduledVersionCheck? in
            running = false
            generation &+= 1
            scheduledTimerID = nil
            defer { scheduledCancellation = nil }
            return scheduledCancellation
        }
        cancellation?.cancel()
        condition.withLock {
            while inFlightCheckCount > 0 {
                condition.wait()
            }
        }
    }

    private func scheduleNext(generation activeGeneration: UInt64) {
        let timerID = condition.withLock { () -> UInt64? in
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
        let staleCancellation = condition.withLock { () -> ScheduledVersionCheck? in
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
        let shouldCheck = condition.withLock { () -> Bool in
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

        operations.execute { [weak self] in
            self?.runCheck(generation: activeGeneration)
        }
        scheduleNext(generation: activeGeneration)
    }

    private func runCheck(generation activeGeneration: UInt64) {
        let shouldCheck = condition.withLock { () -> Bool in
            guard running, generation == activeGeneration else { return false }
            inFlightCheckCount += 1
            return true
        }
        guard shouldCheck else { return }
        defer {
            condition.withLock {
                inFlightCheckCount -= 1
                if inFlightCheckCount == 0 {
                    condition.broadcast()
                }
            }
        }

        operations.checkIfDue()
    }
}

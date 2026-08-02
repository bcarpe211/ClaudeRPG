import Foundation

public enum LocalRunState: String, Codable, Equatable, Sendable {
    case open
    case stalled
}

public struct LocalRunStatus: Codable, Equatable, Sendable {
    public let runKey: String
    public let state: LocalRunState
    public let lastObservedAtMS: Int64
}

public struct RunRegistry: Sendable {
    private struct Entry: Sendable {
        var lastObservedAtMS: Int64
    }

    private let capacity: Int
    private let stallAfterMS: Int64
    private var entries: [String: Entry] = [:]

    public init(capacity: Int = 256, stallAfterMS: Int64 = 15 * 60 * 1_000) {
        self.capacity = max(1, min(256, capacity))
        self.stallAfterMS = max(1, stallAfterMS)
    }

    public var activeRunCount: Int { entries.count }

    public mutating func observe(_ event: RunEventV1) {
        if event.state == .open {
            entries[event.runKey] = Entry(lastObservedAtMS: event.observedAtMS)
            while entries.count > capacity, let oldest = entries.min(by: {
                ($0.value.lastObservedAtMS, $0.key) < ($1.value.lastObservedAtMS, $1.key)
            })?.key {
                entries.removeValue(forKey: oldest)
            }
        } else {
            entries.removeValue(forKey: event.runKey)
        }
    }

    public func statuses(nowMS: Int64) -> [LocalRunStatus] {
        entries.map { key, entry in
            let stalled = nowMS >= entry.lastObservedAtMS
                && nowMS - entry.lastObservedAtMS >= stallAfterMS
            return LocalRunStatus(
                runKey: key,
                state: stalled ? .stalled : .open,
                lastObservedAtMS: entry.lastObservedAtMS
            )
        }.sorted { $0.runKey < $1.runKey }
    }
}

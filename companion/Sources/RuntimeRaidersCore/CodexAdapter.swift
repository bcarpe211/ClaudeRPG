import Foundation

public enum CodexAdapterSnapshotError: Error, Equatable {
    case invalidSnapshot
}

public struct CodexAdapter: ProviderAdapter {
    private struct PendingContext: Codable {
        let nativeID: String
        let model: String?
        let effort: String?
        let eventTime: Int64
        let ordinal: Int64
    }

    private struct PendingCompletion: Codable {
        let eventTime: Int64
        let ordinal: Int64
        let observedAt: Int64
    }

    private static let maximumSafeInteger: Int64 = 9_007_199_254_740_991
    private static let supportedRecordVersion = "0.146.0-alpha.3.1"
    private static let zeroUsage = UsageCountersV1(
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0
    )

    public let expectedSurface: RunSurface
    private var verifiedSurface: RunSurface?
    private var rejectedSurface = false
    private var pendingStartedAt: Int64?
    private var pendingStartedOrdinal: Int64?
    private var pendingUsage: UsageCountersV1?
    private var pendingContext: PendingContext?
    private var pendingCompletion: PendingCompletion?
    private var activeNativeID: String?
    private var activeStartedAt: Int64?
    private var activeStartedOrdinal: Int64?
    private var activeContextOrdinal: Int64?
    private var activeCompletedOrdinal: Int64?
    private var activeUsage = zeroUsage
    private var activeModel: String?
    private var activeEffort: String?

    public init(expectedSurface: RunSurface) {
        self.expectedSurface = expectedSurface
    }

    public init(snapshot: Data) throws {
        guard snapshot.count <= 65_536,
              let state = try? JSONDecoder().decode(PersistedState.self, from: snapshot),
              state.version == 1,
              state.expectedSurface == .codexCLI || state.expectedSurface == .codexDesktop,
              state.verifiedSurface == nil || state.verifiedSurface == state.expectedSurface,
              Self.validOptionalIdentity(state.activeNativeID),
              Self.validOptionalIdentity(state.pendingContext?.nativeID),
              Self.validOptionalDisplay(state.activeModel),
              Self.validOptionalDisplay(state.activeEffort),
              Self.validOptionalDisplay(state.pendingContext?.model),
              Self.validOptionalDisplay(state.pendingContext?.effort),
              Self.validOptionalInteger(state.pendingStartedAt),
              Self.validOptionalInteger(state.pendingStartedOrdinal),
              Self.validOptionalInteger(state.activeStartedAt),
              Self.validOptionalInteger(state.activeStartedOrdinal),
              Self.validOptionalInteger(state.activeContextOrdinal),
              Self.validOptionalInteger(state.activeCompletedOrdinal),
              Self.validOptionalInteger(state.pendingContext?.eventTime),
              Self.validOptionalInteger(state.pendingContext?.ordinal),
              Self.validOptionalInteger(state.pendingCompletion?.eventTime),
              Self.validOptionalInteger(state.pendingCompletion?.ordinal),
              Self.validOptionalInteger(state.pendingCompletion?.observedAt),
              Self.validUsage(state.activeUsage),
              state.pendingUsage.map(Self.validUsage) ?? true,
              Self.consistent(state) else {
            throw CodexAdapterSnapshotError.invalidSnapshot
        }
        expectedSurface = state.expectedSurface
        verifiedSurface = state.verifiedSurface
        rejectedSurface = state.rejectedSurface
        pendingStartedAt = state.pendingStartedAt
        pendingStartedOrdinal = state.pendingStartedOrdinal
        pendingUsage = state.pendingUsage
        pendingContext = state.pendingContext
        pendingCompletion = state.pendingCompletion
        activeNativeID = state.activeNativeID
        activeStartedAt = state.activeStartedAt
        activeStartedOrdinal = state.activeStartedOrdinal
        activeContextOrdinal = state.activeContextOrdinal
        activeCompletedOrdinal = state.activeCompletedOrdinal
        activeUsage = state.activeUsage
        activeModel = state.activeModel
        activeEffort = state.activeEffort
    }

    public func snapshot() throws -> Data {
        let state = PersistedState(
            version: 1,
            expectedSurface: expectedSurface,
            verifiedSurface: verifiedSurface,
            rejectedSurface: rejectedSurface,
            pendingStartedAt: pendingStartedAt,
            pendingStartedOrdinal: pendingStartedOrdinal,
            pendingUsage: pendingUsage,
            pendingContext: pendingContext,
            pendingCompletion: pendingCompletion,
            activeNativeID: activeNativeID,
            activeStartedAt: activeStartedAt,
            activeStartedOrdinal: activeStartedOrdinal,
            activeContextOrdinal: activeContextOrdinal,
            activeCompletedOrdinal: activeCompletedOrdinal,
            activeUsage: activeUsage,
            activeModel: activeModel,
            activeEffort: activeEffort
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(state)
    }

    mutating func prepareForSeeding() {
        clearLifecycle()
    }

    mutating func consumeDuringSeeding(
        line: Data,
        source: ProviderRecordSource,
        observedAt: Int64
    ) {
        _ = consume(line: line, source: source, observedAt: observedAt)
        clearLifecycle()
    }

    public mutating func consume(
        line: Data,
        source: ProviderRecordSource,
        observedAt: Int64
    ) -> [NativeRunObservation] {
        guard (0...Self.maximumSafeInteger).contains(source.ordinal),
              (0...Self.maximumSafeInteger).contains(observedAt),
              let object = try? JSONSerialization.jsonObject(with: line),
              let record = object as? [String: Any],
              let type = record["type"] as? String,
              let payload = record["payload"] as? [String: Any],
              let eventTime = Self.timestampMS(record["timestamp"] as? String) else {
            return []
        }

        if type == "session_meta" {
            guard !rejectedSurface else { return [] }
            guard payload["cli_version"] as? String == Self.supportedRecordVersion else {
                rejectedSurface = true
                verifiedSurface = nil
                clearLifecycle()
                return []
            }
            guard let sourceShape = payload["source"] else { return [] }
            let surface: RunSurface
            if sourceShape is String {
                surface = .codexCLI
            } else if sourceShape is [String: Any] {
                surface = .codexDesktop
            } else {
                return []
            }
            if surface == expectedSurface, expectedSurface == .codexCLI || expectedSurface == .codexDesktop {
                verifiedSurface = surface
            } else {
                rejectedSurface = true
                verifiedSurface = nil
                clearLifecycle()
            }
            return []
        }

        guard !rejectedSurface, verifiedSurface == expectedSurface else { return [] }

        if type == "turn_context" {
            guard let nativeID = payload["turn_id"] as? String,
                  !nativeID.isEmpty,
                  nativeID.utf8.count <= 4_096 else { return [] }
            pendingContext = PendingContext(
                nativeID: nativeID,
                model: Self.displayValue(payload["model"]),
                effort: Self.displayValue(payload["effort"]),
                eventTime: eventTime,
                ordinal: source.ordinal
            )
            return activatePendingRun(observedAt: observedAt)
        }

        guard type == "event_msg", let eventType = payload["type"] as? String else {
            return []
        }
        switch eventType {
        case "task_started":
            pendingStartedAt = eventTime
            pendingStartedOrdinal = source.ordinal
            activeNativeID = nil
            activeStartedAt = nil
            activeStartedOrdinal = nil
            activeContextOrdinal = nil
            activeCompletedOrdinal = nil
            activeUsage = Self.zeroUsage
            activeModel = nil
            activeEffort = nil
            return activatePendingRun(observedAt: observedAt)
        case "token_count":
            guard let usage = Self.usage(from: payload) else { return [] }
            if let nativeID = activeNativeID, let startedAt = activeStartedAt {
                activeUsage = Self.maximum(activeUsage, usage)
                return [observation(
                    nativeID: nativeID,
                    sequence: source.ordinal,
                    eventTime: eventTime,
                    observedAt: observedAt,
                    startedAt: startedAt,
                    state: .open
                )]
            }
            pendingUsage = pendingUsage.map { Self.maximum($0, usage) } ?? usage
            return []
        case "task_complete":
            pendingCompletion = PendingCompletion(
                eventTime: eventTime,
                ordinal: source.ordinal,
                observedAt: observedAt
            )
            return emitPendingCompletion()
        default:
            // Failure-like labels are deliberately unverified and stay open.
            return []
        }
    }

    private mutating func activatePendingRun(observedAt: Int64) -> [NativeRunObservation] {
        guard activeNativeID == nil,
              let context = pendingContext,
              let startedAt = pendingStartedAt,
              let startedOrdinal = pendingStartedOrdinal,
              context.ordinal > startedOrdinal else { return [] }
        activeNativeID = context.nativeID
        activeStartedAt = startedAt
        activeStartedOrdinal = startedOrdinal
        activeContextOrdinal = context.ordinal
        activeCompletedOrdinal = nil
        activeUsage = pendingUsage ?? Self.zeroUsage
        activeModel = context.model
        activeEffort = context.effort
        pendingContext = nil
        pendingStartedAt = nil
        pendingStartedOrdinal = nil
        pendingUsage = nil
        var output = [observation(
            nativeID: context.nativeID,
            sequence: context.ordinal,
            eventTime: context.eventTime,
            observedAt: observedAt,
            startedAt: startedAt,
            state: .open
        )]
        output += emitPendingCompletion()
        return output
    }

    private mutating func emitPendingCompletion() -> [NativeRunObservation] {
        guard let completion = pendingCompletion,
              let nativeID = activeNativeID,
              let startedAt = activeStartedAt,
              let contextOrdinal = activeContextOrdinal else { return [] }
        guard activeCompletedOrdinal == nil else { return [] }
        pendingCompletion = nil
        guard completion.ordinal > contextOrdinal else { return [] }
        activeCompletedOrdinal = completion.ordinal
        return [observation(
            nativeID: nativeID,
            sequence: completion.ordinal,
            eventTime: completion.eventTime,
            observedAt: completion.observedAt,
            startedAt: startedAt,
            state: .completed
        )]
    }

    private mutating func clearLifecycle() {
        pendingStartedAt = nil
        pendingStartedOrdinal = nil
        pendingUsage = nil
        pendingContext = nil
        pendingCompletion = nil
        activeNativeID = nil
        activeStartedAt = nil
        activeStartedOrdinal = nil
        activeContextOrdinal = nil
        activeCompletedOrdinal = nil
        activeUsage = Self.zeroUsage
        activeModel = nil
        activeEffort = nil
    }

    private func observation(
        nativeID: String,
        sequence: Int64,
        eventTime: Int64,
        observedAt: Int64,
        startedAt: Int64,
        state: RunState
    ) -> NativeRunObservation {
        NativeRunObservation(
            nativeID: nativeID,
            provider: .codex,
            surface: expectedSurface,
            sequence: sequence,
            eventTimeMS: eventTime,
            observedAtMS: max(observedAt, eventTime),
            startedAtMS: startedAt,
            state: state,
            usage: activeUsage,
            model: activeModel,
            effort: activeEffort
        )
    }

    private static func usage(from payload: [String: Any]) -> UsageCountersV1? {
        guard let info = payload["info"] as? [String: Any],
              let usage = info["last_token_usage"] as? [String: Any],
              let input = integer(usage["input_tokens"]),
              let output = integer(usage["output_tokens"]),
              let cacheRead = integer(usage["cached_input_tokens"]),
              let cacheWrite = integer(usage["cache_write_input_tokens"]),
              let reasoning = integer(usage["reasoning_output_tokens"]) else {
            return nil
        }
        return UsageCountersV1(
            input: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            reasoningOutput: reasoning
        )
    }

    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite,
              value >= 0,
              value <= 9_007_199_254_740_991,
              value.rounded(.towardZero) == value else { return nil }
        return number.int64Value
    }

    private static func maximum(_ lhs: UsageCountersV1, _ rhs: UsageCountersV1) -> UsageCountersV1 {
        UsageCountersV1(
            input: max(lhs.input, rhs.input),
            output: max(lhs.output, rhs.output),
            cacheRead: max(lhs.cacheRead, rhs.cacheRead),
            cacheWrite: max(lhs.cacheWrite, rhs.cacheWrite),
            reasoningOutput: max(lhs.reasoningOutput, rhs.reasoningOutput)
        )
    }

    private static func displayValue(_ value: Any?) -> String? {
        guard let string = value as? String, string.utf8.count <= 100 else { return nil }
        return string
    }

    private static func validOptionalIdentity(_ value: String?) -> Bool {
        guard let value else { return true }
        return !value.isEmpty && value.utf8.count <= 4_096
    }

    private static func validOptionalDisplay(_ value: String?) -> Bool {
        value.map { $0.utf8.count <= 100 } ?? true
    }

    private static func validOptionalInteger(_ value: Int64?) -> Bool {
        value.map { (0...maximumSafeInteger).contains($0) } ?? true
    }

    private static func validUsage(_ usage: UsageCountersV1) -> Bool {
        [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoningOutput]
            .allSatisfy { (0...maximumSafeInteger).contains($0) }
    }

    private static func consistent(_ state: PersistedState) -> Bool {
        if state.rejectedSurface && state.verifiedSurface != nil { return false }
        let activeValues: [Any?] = [
            state.activeNativeID,
            state.activeStartedAt,
            state.activeStartedOrdinal,
            state.activeContextOrdinal,
        ]
        let activeCount = activeValues.reduce(0) { $0 + ($1 == nil ? 0 : 1) }
        guard activeCount == 0 || activeCount == activeValues.count else { return false }
        guard (state.pendingStartedAt == nil) == (state.pendingStartedOrdinal == nil) else {
            return false
        }
        if let start = state.activeStartedOrdinal,
           let context = state.activeContextOrdinal,
           start >= context { return false }
        if let completed = state.activeCompletedOrdinal,
           let context = state.activeContextOrdinal,
           completed <= context { return false }
        if state.activeCompletedOrdinal != nil && activeCount == 0 { return false }

        let zero = zeroUsage
        let hasLifecycle = state.pendingStartedAt != nil
            || state.pendingUsage != nil
            || state.pendingContext != nil
            || state.pendingCompletion != nil
            || activeCount > 0
            || state.activeModel != nil
            || state.activeEffort != nil
            || state.activeUsage != zero
        if hasLifecycle && (state.rejectedSurface || state.verifiedSurface != state.expectedSurface) {
            return false
        }
        if activeCount == 0 && (
            state.activeModel != nil || state.activeEffort != nil || state.activeUsage != zero
        ) {
            return false
        }
        return true
    }

    private static func timestampMS(_ value: String?) -> Int64? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        guard let date else { return nil }
        let milliseconds = date.timeIntervalSince1970 * 1_000
        guard milliseconds >= 0,
              milliseconds <= Double(Self.maximumSafeInteger) else { return nil }
        return Int64(milliseconds.rounded(.towardZero))
    }

    private struct PersistedState: Codable {
        let version: Int
        let expectedSurface: RunSurface
        let verifiedSurface: RunSurface?
        let rejectedSurface: Bool
        let pendingStartedAt: Int64?
        let pendingStartedOrdinal: Int64?
        let pendingUsage: UsageCountersV1?
        let pendingContext: PendingContext?
        let pendingCompletion: PendingCompletion?
        let activeNativeID: String?
        let activeStartedAt: Int64?
        let activeStartedOrdinal: Int64?
        let activeContextOrdinal: Int64?
        let activeCompletedOrdinal: Int64?
        let activeUsage: UsageCountersV1
        let activeModel: String?
        let activeEffort: String?
    }
}

import Foundation

public struct CodexAdapter: ProviderAdapter {
    private static let maximumSafeInteger: Int64 = 9_007_199_254_740_991
    private static let zeroUsage = UsageCountersV1(
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0
    )

    public let expectedSurface: RunSurface
    private var verifiedSurface: RunSurface?
    private var rejectedSurface = false
    private var pendingStartedAt: Int64?
    private var pendingUsage: UsageCountersV1?
    private var activeNativeID: String?
    private var activeStartedAt: Int64?
    private var activeUsage = zeroUsage
    private var activeModel: String?
    private var activeEffort: String?

    public init(expectedSurface: RunSurface) {
        self.expectedSurface = expectedSurface
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
            }
            return []
        }

        guard !rejectedSurface, verifiedSurface == expectedSurface else { return [] }

        if type == "turn_context" {
            guard let nativeID = payload["turn_id"] as? String,
                  !nativeID.isEmpty,
                  nativeID.utf8.count <= 4_096,
                  let startedAt = pendingStartedAt else { return [] }
            activeNativeID = nativeID
            activeStartedAt = startedAt
            pendingStartedAt = nil
            activeUsage = pendingUsage ?? Self.zeroUsage
            pendingUsage = nil
            activeModel = Self.displayValue(payload["model"])
            activeEffort = Self.displayValue(payload["effort"])
            return [observation(
                nativeID: nativeID,
                sequence: source.ordinal,
                eventTime: eventTime,
                observedAt: observedAt,
                startedAt: startedAt,
                state: .open
            )]
        }

        guard type == "event_msg", let eventType = payload["type"] as? String else {
            return []
        }
        switch eventType {
        case "task_started":
            pendingStartedAt = eventTime
            activeNativeID = nil
            activeStartedAt = nil
            activeUsage = Self.zeroUsage
            activeModel = nil
            activeEffort = nil
            return []
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
            guard let nativeID = activeNativeID, let startedAt = activeStartedAt else { return [] }
            let terminal = observation(
                nativeID: nativeID,
                sequence: source.ordinal,
                eventTime: eventTime,
                observedAt: observedAt,
                startedAt: startedAt,
                state: .completed
            )
            return [terminal]
        default:
            // Failure-like labels are deliberately unverified and stay open.
            return []
        }
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
}

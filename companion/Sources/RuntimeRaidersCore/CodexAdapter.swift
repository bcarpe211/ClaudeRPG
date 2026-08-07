import Foundation

public enum CodexAdapterSnapshotError: Error, Equatable {
    case invalidSnapshot
}

public enum CodexCompatibilityIssue: String, Codable, CaseIterable, Equatable, Sendable {
    case unsupportedSource = "unsupported_source"
    case unsupportedContract = "unsupported_contract"
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
    private static let zeroUsage = UsageCountersV1(
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0
    )

    public let expectedSurface: RunSurface
    private var verifiedSurface: RunSurface?
    private var rejectedSurface = false
    private var storedCompatibilityIssue: CodexCompatibilityIssue?
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

    public var compatibilityIssue: CodexCompatibilityIssue? { storedCompatibilityIssue }
    public var hasActiveRun: Bool { activeNativeID != nil && activeCompletedOrdinal == nil }

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
        storedCompatibilityIssue = state.compatibilityIssue
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
            compatibilityIssue: storedCompatibilityIssue,
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
        verifiedSurface = nil
        rejectedSurface = false
        storedCompatibilityIssue = nil
        clearLifecycle()
    }

    mutating func consumeDuringSeeding(
        line: Data,
        source: ProviderRecordSource,
        observedAt: Int64
    ) {
        let seededSurface = verifiedSurface
        _ = consume(line: line, source: source, observedAt: observedAt)
        if rejectedSurface { verifiedSurface = seededSurface }
        rejectedSurface = false
        storedCompatibilityIssue = nil
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
              let type = record["type"] as? String else {
            return []
        }

        if type == "session_meta" {
            guard !rejectedSurface else { return [] }
            guard let payload = record["payload"] as? [String: Any],
                  Self.timestampMS(record["timestamp"] as? String) != nil,
                  Self.validRecordVersion(payload["cli_version"]),
                  Self.validRequiredMarker(payload["id"]),
                  Self.validRequiredMarker(payload["originator"]) else {
                reject(.unsupportedContract)
                return []
            }
            guard let surface = Self.sessionSurface(payload["source"]) else {
                reject(Self.isUnknownStringSource(payload["source"])
                    ? .unsupportedSource : .unsupportedContract)
                return []
            }
            if surface == expectedSurface {
                verifiedSurface = surface
            } else {
                verifiedSurface = nil
                clearLifecycle()
            }
            return []
        }

        guard type == "turn_context" || type == "event_msg" else { return [] }
        guard !rejectedSurface, verifiedSurface == expectedSurface else { return [] }
        guard let payload = record["payload"] as? [String: Any] else {
            reject(.unsupportedContract)
            return []
        }

        if type == "turn_context" {
            guard let eventTime = Self.timestampMS(record["timestamp"] as? String),
                  let nativeID = payload["turn_id"] as? String,
                  !nativeID.isEmpty,
                  nativeID.utf8.count <= 4_096 else {
                reject(.unsupportedContract)
                return []
            }
            pendingContext = PendingContext(
                nativeID: nativeID,
                model: Self.displayValue(payload["model"]),
                effort: Self.displayValue(payload["effort"]),
                eventTime: eventTime,
                ordinal: source.ordinal
            )
            return activatePendingRun(observedAt: observedAt)
        }

        guard let eventType = payload["type"] as? String else {
            reject(.unsupportedContract)
            return []
        }
        guard eventType == "task_started"
                || eventType == "token_count"
                || eventType == "task_complete" else {
            // Unknown event labels remain unrecognized noise.
            return []
        }
        guard let eventTime = Self.timestampMS(record["timestamp"] as? String) else {
            reject(.unsupportedContract)
            return []
        }
        switch eventType {
        case "task_started":
            if let startedAt = activeStartedAt, eventTime < startedAt {
                reject(.unsupportedContract)
                return []
            }
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
            guard let usage = Self.usage(from: payload) else {
                reject(.unsupportedContract)
                return []
            }
            if let nativeID = activeNativeID, let startedAt = activeStartedAt {
                guard eventTime >= startedAt, Self.isCumulative(usage, atLeast: activeUsage) else {
                    reject(.unsupportedContract)
                    return []
                }
                activeUsage = usage
                return [observation(
                    nativeID: nativeID,
                    sequence: source.ordinal,
                    eventTime: eventTime,
                    observedAt: observedAt,
                    startedAt: startedAt,
                    state: .open
                )]
            }
            if let startedAt = pendingStartedAt, eventTime < startedAt {
                reject(.unsupportedContract)
                return []
            }
            guard pendingUsage.map({ Self.isCumulative(usage, atLeast: $0) }) ?? true else {
                reject(.unsupportedContract)
                return []
            }
            pendingUsage = usage
            return []
        case "task_complete":
            if let startedAt = activeStartedAt, eventTime < startedAt {
                reject(.unsupportedContract)
                return []
            }
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
        guard context.eventTime >= startedAt else {
            reject(.unsupportedContract)
            return []
        }
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
        guard completion.eventTime >= startedAt else {
            reject(.unsupportedContract)
            return []
        }
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

    private mutating func reject(_ issue: CodexCompatibilityIssue) {
        rejectedSurface = true
        verifiedSurface = nil
        storedCompatibilityIssue = issue
        clearLifecycle()
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

    private static func isCumulative(_ value: UsageCountersV1, atLeast baseline: UsageCountersV1) -> Bool {
        value.input >= baseline.input
            && value.output >= baseline.output
            && value.cacheRead >= baseline.cacheRead
            && value.cacheWrite >= baseline.cacheWrite
            && value.reasoningOutput >= baseline.reasoningOutput
    }

    private static func displayValue(_ value: Any?) -> String? {
        guard let string = value as? String, string.utf8.count <= 100 else { return nil }
        return string
    }

    private static func validRequiredMarker(_ value: Any?) -> Bool {
        guard let string = value as? String else { return false }
        return !string.isEmpty && string.utf8.count <= 4_096
    }

    private static func validRecordVersion(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return !value.isEmpty && value.utf8.count <= 100
    }

    private static func sessionSurface(_ source: Any?) -> RunSurface? {
        if let source = source as? String {
            switch source {
            case "vscode": return .codexDesktop
            case "exec": return .codexCLI
            default: return nil
            }
        }
        return strictSubagentSurface(source)
    }

    private static func isUnknownStringSource(_ source: Any?) -> Bool {
        source is String
    }

    private static func strictSubagentSurface(_ source: Any?) -> RunSurface? {
        guard let source = source as? [String: Any],
              Set(source.keys) == ["subagent"],
              let subagent = source["subagent"] as? [String: Any],
              Set(subagent.keys) == ["thread_spawn"],
              let threadSpawn = subagent["thread_spawn"] as? [String: Any],
              Set(threadSpawn.keys) == [
                  "agent_nickname", "agent_path", "agent_role", "depth", "parent_thread_id",
              ],
              validRequiredMarker(threadSpawn["agent_nickname"]),
              validRequiredMarker(threadSpawn["agent_path"]),
              threadSpawn["agent_role"] is NSNull,
              integer(threadSpawn["depth"]) != nil,
              validRequiredMarker(threadSpawn["parent_thread_id"]) else {
            return nil
        }
        return .codexDesktop
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
        let compatibilityIssue: CodexCompatibilityIssue?
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

        private enum CodingKeys: String, CodingKey {
            case version, expectedSurface, verifiedSurface, rejectedSurface, compatibilityIssue
            case pendingStartedAt, pendingStartedOrdinal, pendingUsage, pendingContext, pendingCompletion
            case activeNativeID, activeStartedAt, activeStartedOrdinal, activeContextOrdinal
            case activeCompletedOrdinal, activeUsage, activeModel, activeEffort
        }

        init(
            version: Int,
            expectedSurface: RunSurface,
            verifiedSurface: RunSurface?,
            rejectedSurface: Bool,
            compatibilityIssue: CodexCompatibilityIssue?,
            pendingStartedAt: Int64?,
            pendingStartedOrdinal: Int64?,
            pendingUsage: UsageCountersV1?,
            pendingContext: PendingContext?,
            pendingCompletion: PendingCompletion?,
            activeNativeID: String?,
            activeStartedAt: Int64?,
            activeStartedOrdinal: Int64?,
            activeContextOrdinal: Int64?,
            activeCompletedOrdinal: Int64?,
            activeUsage: UsageCountersV1,
            activeModel: String?,
            activeEffort: String?
        ) {
            self.version = version
            self.expectedSurface = expectedSurface
            self.verifiedSurface = verifiedSurface
            self.rejectedSurface = rejectedSurface
            self.compatibilityIssue = compatibilityIssue
            self.pendingStartedAt = pendingStartedAt
            self.pendingStartedOrdinal = pendingStartedOrdinal
            self.pendingUsage = pendingUsage
            self.pendingContext = pendingContext
            self.pendingCompletion = pendingCompletion
            self.activeNativeID = activeNativeID
            self.activeStartedAt = activeStartedAt
            self.activeStartedOrdinal = activeStartedOrdinal
            self.activeContextOrdinal = activeContextOrdinal
            self.activeCompletedOrdinal = activeCompletedOrdinal
            self.activeUsage = activeUsage
            self.activeModel = activeModel
            self.activeEffort = activeEffort
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                version: try container.decode(Int.self, forKey: .version),
                expectedSurface: try container.decode(RunSurface.self, forKey: .expectedSurface),
                verifiedSurface: try container.decodeIfPresent(RunSurface.self, forKey: .verifiedSurface),
                rejectedSurface: try container.decode(Bool.self, forKey: .rejectedSurface),
                compatibilityIssue: try container.decodeIfPresent(CodexCompatibilityIssue.self, forKey: .compatibilityIssue),
                pendingStartedAt: try container.decodeIfPresent(Int64.self, forKey: .pendingStartedAt),
                pendingStartedOrdinal: try container.decodeIfPresent(Int64.self, forKey: .pendingStartedOrdinal),
                pendingUsage: try container.decodeIfPresent(UsageCountersV1.self, forKey: .pendingUsage),
                pendingContext: try container.decodeIfPresent(PendingContext.self, forKey: .pendingContext),
                pendingCompletion: try container.decodeIfPresent(PendingCompletion.self, forKey: .pendingCompletion),
                activeNativeID: try container.decodeIfPresent(String.self, forKey: .activeNativeID),
                activeStartedAt: try container.decodeIfPresent(Int64.self, forKey: .activeStartedAt),
                activeStartedOrdinal: try container.decodeIfPresent(Int64.self, forKey: .activeStartedOrdinal),
                activeContextOrdinal: try container.decodeIfPresent(Int64.self, forKey: .activeContextOrdinal),
                activeCompletedOrdinal: try container.decodeIfPresent(Int64.self, forKey: .activeCompletedOrdinal),
                activeUsage: try container.decode(UsageCountersV1.self, forKey: .activeUsage),
                activeModel: try container.decodeIfPresent(String.self, forKey: .activeModel),
                activeEffort: try container.decodeIfPresent(String.self, forKey: .activeEffort)
            )
        }
    }
}

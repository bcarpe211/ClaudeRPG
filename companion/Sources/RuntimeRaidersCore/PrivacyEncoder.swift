import Foundation

public enum PrivacyEncoderError: Error, Equatable {
    case invalidField(String)
}

public struct PrivacyEncoder {
    private static let maximumSafeInteger: Int64 = 9_007_199_254_740_991
    private static let maximumFieldLength = 100
    private static let maximumRunDurationMS: Int64 = 7 * 24 * 60 * 60 * 1_000

    public init() {}

    public func encode(_ event: RunEventV1) throws -> Data {
        try validate(event)
        let outbound = OutboundRunEvent(event)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(outbound)
    }

    private func validate(_ event: RunEventV1) throws {
        guard event.schemaVersion == 1 else { throw invalid("schema_version") }
        guard validRequiredString(event.companionVersion) else {
            throw invalid("companion_version")
        }
        guard UUID(uuidString: event.deviceID) != nil else { throw invalid("device_id") }
        guard Self.provider(for: event.surface) == event.provider else {
            throw invalid("provider")
        }
        guard validLowerHexKey(event.runKey) else { throw invalid("run_key") }
        guard validInteger(event.sequence) else { throw invalid("sequence") }
        guard validInteger(event.eventTimeMS) else { throw invalid("event_time_ms") }
        guard validInteger(event.observedAtMS) else { throw invalid("observed_at_ms") }
        guard validInteger(event.startedAtMS) else { throw invalid("started_at_ms") }
        guard validInteger(event.usage.input) else { throw invalid("usage.input") }
        guard validInteger(event.usage.output) else { throw invalid("usage.output") }
        guard validInteger(event.usage.cacheRead) else { throw invalid("usage.cache_read") }
        guard validInteger(event.usage.cacheWrite) else { throw invalid("usage.cache_write") }
        guard validInteger(event.usage.reasoningOutput) else {
            throw invalid("usage.reasoning_output")
        }
        guard validOptionalString(event.model) else { throw invalid("model") }
        guard validOptionalString(event.effort) else { throw invalid("effort") }
        guard validLowerHexKey(event.idempotencyKey) else {
            throw invalid("idempotency_key")
        }
        guard event.eventTimeMS >= event.startedAtMS,
              event.eventTimeMS - event.startedAtMS <= Self.maximumRunDurationMS else {
            throw invalid("event_time_ms")
        }
        guard event.observedAtMS >= event.eventTimeMS else {
            throw invalid("observed_at_ms")
        }
    }

    private func validInteger(_ value: Int64) -> Bool {
        (0...Self.maximumSafeInteger).contains(value)
    }

    private func validRequiredString(_ value: String) -> Bool {
        let count = value.utf16.count
        return (1...Self.maximumFieldLength).contains(count)
    }

    private func validOptionalString(_ value: String?) -> Bool {
        guard let value else { return true }
        return value.utf16.count <= Self.maximumFieldLength
    }

    private func validLowerHexKey(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return bytes.count == 64 && bytes.allSatisfy { byte in
            (48...57).contains(byte) || (97...102).contains(byte)
        }
    }

    private func invalid(_ field: String) -> PrivacyEncoderError {
        .invalidField(field)
    }

    private static func provider(for surface: RunSurface) -> RunProvider {
        switch surface {
        case .codexDesktop, .codexCLI: .codex
        case .claudeCode: .claude
        case .omp: .omp
        }
    }
}

private struct OutboundRunEvent: Encodable {
    let schemaVersion: Int
    let companionVersion: String
    let deviceID: String
    let provider: RunProvider
    let surface: RunSurface
    let runKey: String
    let sequence: Int64
    let eventTimeMS: Int64
    let observedAtMS: Int64
    let startedAtMS: Int64
    let state: RunState
    let usage: OutboundUsageCounters
    let model: String?
    let effort: String?
    let idempotencyKey: String

    init(_ event: RunEventV1) {
        schemaVersion = event.schemaVersion
        companionVersion = event.companionVersion
        deviceID = event.deviceID
        provider = event.provider
        surface = event.surface
        runKey = event.runKey
        sequence = event.sequence
        eventTimeMS = event.eventTimeMS
        observedAtMS = event.observedAtMS
        startedAtMS = event.startedAtMS
        state = event.state
        usage = OutboundUsageCounters(event.usage)
        model = event.model
        effort = event.effort
        idempotencyKey = event.idempotencyKey
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case companionVersion = "companion_version"
        case deviceID = "device_id"
        case provider
        case surface
        case runKey = "run_key"
        case sequence
        case eventTimeMS = "event_time_ms"
        case observedAtMS = "observed_at_ms"
        case startedAtMS = "started_at_ms"
        case state
        case usage
        case model
        case effort
        case idempotencyKey = "idempotency_key"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(companionVersion, forKey: .companionVersion)
        try container.encode(deviceID, forKey: .deviceID)
        try container.encode(provider, forKey: .provider)
        try container.encode(surface, forKey: .surface)
        try container.encode(runKey, forKey: .runKey)
        try container.encode(sequence, forKey: .sequence)
        try container.encode(eventTimeMS, forKey: .eventTimeMS)
        try container.encode(observedAtMS, forKey: .observedAtMS)
        try container.encode(startedAtMS, forKey: .startedAtMS)
        try container.encode(state, forKey: .state)
        try container.encode(usage, forKey: .usage)
        if let model {
            try container.encode(model, forKey: .model)
        } else {
            try container.encodeNil(forKey: .model)
        }
        if let effort {
            try container.encode(effort, forKey: .effort)
        } else {
            try container.encodeNil(forKey: .effort)
        }
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
    }
}

private struct OutboundUsageCounters: Encodable {
    let input: Int64
    let output: Int64
    let cacheRead: Int64
    let cacheWrite: Int64
    let reasoningOutput: Int64

    init(_ usage: UsageCountersV1) {
        input = usage.input
        output = usage.output
        cacheRead = usage.cacheRead
        cacheWrite = usage.cacheWrite
        reasoningOutput = usage.reasoningOutput
    }

    enum CodingKeys: String, CodingKey {
        case input
        case output
        case cacheRead = "cache_read"
        case cacheWrite = "cache_write"
        case reasoningOutput = "reasoning_output"
    }
}

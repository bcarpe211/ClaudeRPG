import Foundation

public enum RunProvider: String, Codable, CaseIterable, Sendable {
    case codex
    case claude
    case omp
}

public enum RunSurface: String, Codable, CaseIterable, Sendable {
    case codexDesktop = "codex_desktop"
    case codexCLI = "codex_cli"
    case claudeCode = "claude_code"
    case omp
}

public enum RunState: String, Codable, CaseIterable, Sendable {
    case open
    case completed
    case failed
    case cancelled
}

public struct UsageCountersV1: Codable, Equatable, Sendable {
    public var input: Int64
    public var output: Int64
    public var cacheRead: Int64
    public var cacheWrite: Int64
    public var reasoningOutput: Int64

    public init(
        input: Int64,
        output: Int64,
        cacheRead: Int64,
        cacheWrite: Int64,
        reasoningOutput: Int64
    ) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.reasoningOutput = reasoningOutput
    }

    enum CodingKeys: String, CodingKey {
        case input
        case output
        case cacheRead = "cache_read"
        case cacheWrite = "cache_write"
        case reasoningOutput = "reasoning_output"
    }
}

public struct RunEventV1: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var companionVersion: String
    public var deviceID: String
    public var provider: RunProvider
    public var surface: RunSurface
    public var runKey: String
    public var sequence: Int64
    public var eventTimeMS: Int64
    public var observedAtMS: Int64
    public var startedAtMS: Int64
    public var state: RunState
    public var usage: UsageCountersV1
    public var model: String?
    public var effort: String?
    public var idempotencyKey: String

    public init(
        schemaVersion: Int,
        companionVersion: String,
        deviceID: String,
        provider: RunProvider,
        surface: RunSurface,
        runKey: String,
        sequence: Int64,
        eventTimeMS: Int64,
        observedAtMS: Int64,
        startedAtMS: Int64,
        state: RunState,
        usage: UsageCountersV1,
        model: String?,
        effort: String?,
        idempotencyKey: String
    ) {
        self.schemaVersion = schemaVersion
        self.companionVersion = companionVersion
        self.deviceID = deviceID
        self.provider = provider
        self.surface = surface
        self.runKey = runKey
        self.sequence = sequence
        self.eventTimeMS = eventTimeMS
        self.observedAtMS = observedAtMS
        self.startedAtMS = startedAtMS
        self.state = state
        self.usage = usage
        self.model = model
        self.effort = effort
        self.idempotencyKey = idempotencyKey
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

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        companionVersion = try container.decode(String.self, forKey: .companionVersion)
        deviceID = try container.decode(String.self, forKey: .deviceID)
        provider = try container.decode(RunProvider.self, forKey: .provider)
        surface = try container.decode(RunSurface.self, forKey: .surface)
        runKey = try container.decode(String.self, forKey: .runKey)
        sequence = try container.decode(Int64.self, forKey: .sequence)
        eventTimeMS = try container.decode(Int64.self, forKey: .eventTimeMS)
        observedAtMS = try container.decode(Int64.self, forKey: .observedAtMS)
        startedAtMS = try container.decode(Int64.self, forKey: .startedAtMS)
        state = try container.decode(RunState.self, forKey: .state)
        usage = try container.decode(UsageCountersV1.self, forKey: .usage)
        guard container.contains(.model) else {
            throw DecodingError.keyNotFound(
                CodingKeys.model,
                .init(codingPath: decoder.codingPath, debugDescription: "model is required")
            )
        }
        guard container.contains(.effort) else {
            throw DecodingError.keyNotFound(
                CodingKeys.effort,
                .init(codingPath: decoder.codingPath, debugDescription: "effort is required")
            )
        }
        model = try container.decodeIfPresent(String.self, forKey: .model)
        effort = try container.decodeIfPresent(String.self, forKey: .effort)
        idempotencyKey = try container.decode(String.self, forKey: .idempotencyKey)
    }

    public func encode(to encoder: Encoder) throws {
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

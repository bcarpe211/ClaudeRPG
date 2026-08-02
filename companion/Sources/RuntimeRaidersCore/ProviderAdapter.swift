import Foundation

public struct ProviderRecordSource: Equatable, Sendable {
    public let ordinal: Int64

    public init(ordinal: Int64) {
        self.ordinal = ordinal
    }
}

public struct NativeRunObservation: Equatable, Sendable {
    public let nativeID: String
    public let provider: RunProvider
    public let surface: RunSurface
    public let sequence: Int64
    public let eventTimeMS: Int64
    public let observedAtMS: Int64
    public let startedAtMS: Int64
    public let state: RunState
    public let usage: UsageCountersV1
    public let model: String?
    public let effort: String?

    public init(
        nativeID: String,
        provider: RunProvider,
        surface: RunSurface,
        sequence: Int64,
        eventTimeMS: Int64,
        observedAtMS: Int64,
        startedAtMS: Int64,
        state: RunState,
        usage: UsageCountersV1,
        model: String?,
        effort: String?
    ) {
        self.nativeID = nativeID
        self.provider = provider
        self.surface = surface
        self.sequence = sequence
        self.eventTimeMS = eventTimeMS
        self.observedAtMS = observedAtMS
        self.startedAtMS = startedAtMS
        self.state = state
        self.usage = usage
        self.model = model
        self.effort = effort
    }
}

public protocol ProviderAdapter {
    mutating func consume(
        line: Data,
        source: ProviderRecordSource,
        observedAt: Int64
    ) -> [NativeRunObservation]
}

import Foundation

public enum DoctorEnvironment {
    private static let knownClaudeOTelVariableNames: Set<String> = [
        "CLAUDE_CODE_ENABLE_TELEMETRY",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_METRICS_EXPORTER",
        "OTEL_LOGS_EXPORTER",
    ]

    public static func claudeOTelPresent(in environment: [String: String]) -> Bool {
        !knownClaudeOTelVariableNames.isDisjoint(with: environment.keys)
    }

    public static func combinedPresence(
        invocationPresent: Bool,
        daemonEnvironment: [String: String]
    ) -> Bool {
        invocationPresent || claudeOTelPresent(in: daemonEnvironment)
    }
}

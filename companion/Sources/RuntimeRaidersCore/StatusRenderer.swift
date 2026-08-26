import Foundation

public enum OutputStyle: Equatable, Sendable {
    case plain
    case ansi
}

public enum StatusRenderer {
    private static let surfaceNames: [RunSurface: String] = [
        .claudeCode: "Claude Code",
        .codexCLI: "Codex CLI",
        .codexDesktop: "Codex Desktop",
        .omp: "Omp",
    ]

    public static func render(
        _ status: AgentStatus,
        nowMS: Int64,
        style: OutputStyle
    ) -> String {
        let needsAttention = needsAttention(status)
        let collection = collectionWord(enabled: status.enabled, style: style)
        var lines = [
            "Runtime Raiders",
            "Collection: \(collection)",
            "Status: \(statusText(for: status, needsAttention: needsAttention))",
            "Background agent: \(status.daemonRunning ? "Running" : "Not running")",
            "Surfaces: \(surfaceText(status.serverEnabledSurfaces))",
            "Active runs: \(status.activeRunCount)",
            "Queued events: \(status.queuedEventCount)",
            "Installed version: \(status.installedCompanionVersion)",
            "Available version: \(status.availableCompanionVersion ?? "None")",
            "Last successful upload: \(uploadText(status.lastSuccessfulUploadMS, nowMS: nowMS))",
        ]

        if needsAttention {
            lines.append("Next: Run `raiders doctor`.")
        } else if status.availableCompanionVersion != nil {
            lines.append("Next: Run `raiders update`.")
        }

        return lines.joined(separator: "\n")
    }

    private static func needsAttention(_ status: AgentStatus) -> Bool {
        if status.persistedState == .invalid ||
            (status.enabled && !status.daemonRunning) ||
            (status.enabled && status.activationState == .disabled) ||
            (!status.enabled && (status.activationState == .preparing || status.activationState == .ready)) ||
            (status.activationState == .ready &&
                (status.laggingProviderFileCount > 0 || status.providerLagBytes > 0)) {
            return true
        }

        return status.serverEnabledSurfaces.contains {
            status.compiledAdapters[$0] != .available
        }
    }

    private static func statusText(
        for status: AgentStatus,
        needsAttention: Bool
    ) -> String {
        if needsAttention { return "Needs attention" }
        if !status.enabled { return "Off" }

        switch status.activationState {
        case .disabled:
            return "Needs attention"
        case .preparing:
            return "Preparing safely in the background"
        case .ready:
            return "Ready"
        }
    }

    private static func collectionWord(enabled: Bool, style: OutputStyle) -> String {
        let word = enabled ? "ON" : "OFF"
        guard style == .ansi else { return word }
        let color = enabled ? "32" : "31"
        return "\u{001B}[\(color)m\(word)\u{001B}[0m"
    }

    private static func surfaceText(_ surfaces: [RunSurface]) -> String {
        let names = surfaces.compactMap { surfaceNames[$0] }.sorted()
        return names.isEmpty ? "None" : names.joined(separator: ", ")
    }

    private static func uploadText(_ lastSuccessfulUploadMS: Int64?, nowMS: Int64) -> String {
        guard let lastSuccessfulUploadMS else { return "Never" }
        let elapsed = elapsedMS(nowMS: nowMS, sinceMS: lastSuccessfulUploadMS)
        let minute: Int64 = 60_000
        let hour = 60 * minute
        let day = 24 * hour

        switch elapsed {
        case 0..<minute:
            return "Just now"
        case minute..<hour:
            return relativeText(elapsed / minute, unit: "minute")
        case hour..<day:
            return relativeText(elapsed / hour, unit: "hour")
        case day..<(30 * day):
            return relativeText(elapsed / day, unit: "day")
        default:
            return "30+ days ago"
        }
    }

    private static func elapsedMS(nowMS: Int64, sinceMS: Int64) -> Int64 {
        guard nowMS > sinceMS else { return 0 }
        let (elapsed, overflow) = nowMS.subtractingReportingOverflow(sinceMS)
        return overflow ? Int64.max : elapsed
    }

    private static func relativeText(_ value: Int64, unit: String) -> String {
        "\(value) \(unit)\(value == 1 ? "" : "s") ago"
    }
}

public enum CollectionCommandRenderer {
    public static func render(
        enabled: Bool,
        activationState: CollectorActivationState,
        style: OutputStyle
    ) -> String {
        let collection = collectionWord(enabled: enabled, style: style)
        guard enabled else {
            if activationState == .disabled {
                return "Runtime Raiders collection is \(collection)"
            }
            return "Runtime Raiders collection is \(collection)\nStatus: Needs attention."
        }

        let status: String
        switch activationState {
        case .preparing:
            status = "Preparing safely in the background"
        case .ready:
            status = "Ready"
        case .disabled:
            status = "Needs attention"
        }
        return "Runtime Raiders collection is \(collection)\nStatus: \(status)."
    }

    private static func collectionWord(enabled: Bool, style: OutputStyle) -> String {
        let word = enabled ? "ON" : "OFF"
        guard style == .ansi else { return word }
        let color = enabled ? "32" : "31"
        return "\u{001B}[\(color)m\(word)\u{001B}[0m"
    }
}

import XCTest
@testable import RuntimeRaidersCore

final class StatusRendererTests: XCTestCase {
    private let now: Int64 = 1_700_000_000_000

    func testReadySnapshotRendersExactPlainOutput() {
        let status = AgentStatus(
            enabled: true,
            activationState: .ready,
            daemonRunning: true,
            persistedState: .enabled,
            serverEnabledSurfaces: [.codexDesktop, .codexCLI],
            compiledAdapters: [.codexDesktop: .available, .codexCLI: .available],
            queuedEventCount: 0,
            lastSuccessfulUploadMS: 1_700_000_000_000 - 4 * 60_000,
            activeRunCount: 0,
            installedCompanionVersion: "0.4.8",
            availableCompanionVersion: nil,
            updateCommand: nil
        )

        XCTAssertEqual(
            StatusRenderer.render(status, nowMS: 1_700_000_000_000, style: .plain),
            """
            Runtime Raiders
            Collection: ON
            Status: Ready
            Background agent: Running
            Surfaces: Codex CLI, Codex Desktop
            Active runs: 0
            Queued events: 0
            Installed version: 0.4.8
            Available version: None
            Last successful upload: 4 minutes ago
            """
        )
    }

    func testFixturesRenderExpectedStatusAndNextStep() {
        let disabled = status(enabled: false, activationState: .disabled, daemonRunning: false,
                              persistedState: .disabled)
        let preparing = status(enabled: true, activationState: .preparing)
        let ready = status(enabled: true, activationState: .ready)
        let invalid = status(enabled: true, activationState: .ready, persistedState: .invalid)
        let updateAvailable = status(enabled: true, activationState: .ready,
                                     availableCompanionVersion: "0.4.9", updateCommand: "raiders update")
        let neverUploaded = status(enabled: true, activationState: .ready,
                                   lastSuccessfulUploadMS: nil)
        let futureUpload = status(enabled: true, activationState: .ready,
                                  lastSuccessfulUploadMS: now + 1)

        let fixtures: [(name: String, status: AgentStatus, expectedStatus: String, expectedNext: String?)] = [
            ("disabled", disabled, "Off", nil),
            ("preparing", preparing, "Preparing safely in the background", nil),
            ("ready", ready, "Ready", nil),
            ("invalid", invalid, "Needs attention", "Next: Run `raiders doctor`."),
            ("update available", updateAvailable, "Ready", "Next: Run `raiders update`."),
            ("never uploaded", neverUploaded, "Ready", nil),
            ("future upload", futureUpload, "Ready", nil),
        ]

        for fixture in fixtures {
            let rendered = StatusRenderer.render(fixture.status, nowMS: now, style: .plain)
            XCTAssertEqual(renderedStatus(fixture.status), fixture.expectedStatus, fixture.name)
            XCTAssertEqual(nextLine(rendered), fixture.expectedNext, fixture.name)
        }

        XCTAssertEqual(uploadText(StatusRenderer.render(neverUploaded, nowMS: now, style: .plain)), "Never")
        XCTAssertEqual(uploadText(StatusRenderer.render(futureUpload, nowMS: now, style: .plain)), "Just now")
    }

    func testInvalidAndIncoherentHealthAlwaysRecommendDoctorBeforeUpdate() {
        let incoherentStates = [
            status(enabled: true, activationState: .ready, daemonRunning: false),
            status(enabled: true, activationState: .disabled),
            status(enabled: false, activationState: .preparing, daemonRunning: false,
                   persistedState: .disabled),
            status(enabled: false, activationState: .ready, daemonRunning: false,
                   persistedState: .disabled),
            status(enabled: true, activationState: .ready,
                   compiledAdapters: [.codexCLI: .unavailable]),
            status(enabled: true, activationState: .ready, laggingProviderFileCount: 1),
            status(enabled: true, activationState: .ready, providerLagBytes: 1),
            status(enabled: true, activationState: .ready, persistedState: .invalid,
                   availableCompanionVersion: "0.4.9", updateCommand: "raiders update"),
        ]

        for snapshot in incoherentStates {
            let rendered = StatusRenderer.render(snapshot, nowMS: now, style: .plain)
            XCTAssertEqual(renderedStatus(snapshot), "Needs attention")
            XCTAssertEqual(nextLine(rendered), "Next: Run `raiders doctor`.")
        }
    }

    func testSurfacesAndRelativeUploadBoundariesAreStable() {
        let noSurfaces = status(enabled: false, activationState: .disabled, daemonRunning: false,
                                persistedState: .disabled, serverEnabledSurfaces: [])
        XCTAssertTrue(
            StatusRenderer.render(noSurfaces, nowMS: now, style: .plain).contains("Surfaces: None")
        )

        let cases: [(elapsedMS: Int64, expected: String)] = [
            (0, "Just now"),
            (60_000, "1 minute ago"),
            (59 * 60_000, "59 minutes ago"),
            (60 * 60_000, "1 hour ago"),
            (23 * 60 * 60_000, "23 hours ago"),
            (24 * 60 * 60_000, "1 day ago"),
            (29 * 24 * 60 * 60_000, "29 days ago"),
            (30 * 24 * 60 * 60_000, "30+ days ago"),
        ]

        for fixture in cases {
            let snapshot = status(enabled: true, activationState: .ready,
                                  lastSuccessfulUploadMS: now - fixture.elapsedMS)
            XCTAssertEqual(
                uploadText(StatusRenderer.render(snapshot, nowMS: now, style: .plain)),
                fixture.expected,
                "elapsedMS: \(fixture.elapsedMS)"
            )
        }
    }

    func testOnlyCollectionStateWordUsesANSIWhenRequested() {
        let ready = status(enabled: true, activationState: .ready)
        let off = status(enabled: false, activationState: .disabled, daemonRunning: false,
                         persistedState: .disabled)
        let plainReady = StatusRenderer.render(ready, nowMS: now, style: .plain)
        let ansiReady = StatusRenderer.render(ready, nowMS: now, style: .ansi)
        let ansiOff = StatusRenderer.render(off, nowMS: now, style: .ansi)

        XCTAssertTrue(ansiReady.contains("Collection: \u{001B}[32mON\u{001B}[0m"))
        XCTAssertEqual(ansiReady.replacingOccurrences(of: "\u{001B}[32mON\u{001B}[0m", with: "ON"), plainReady)
        XCTAssertTrue(ansiOff.contains("Collection: \u{001B}[31mOFF\u{001B}[0m"))
        XCTAssertFalse(plainReady.contains("\u{001B}["))
    }

    func testCollectionCommandRendererUsesApprovedLanguage() {
        XCTAssertEqual(
            CollectionCommandRenderer.render(
                enabled: true,
                activationState: .preparing,
                style: .plain
            ),
            "Runtime Raiders collection is ON\nStatus: Preparing safely in the background."
        )
        XCTAssertEqual(
            CollectionCommandRenderer.render(
                enabled: false,
                activationState: .disabled,
                style: .plain
            ),
            "Runtime Raiders collection is OFF"
        )
    }

    private func renderedStatus(_ status: AgentStatus) -> String {
        let rendered = StatusRenderer.render(status, nowMS: now, style: .plain)
        return rendered
            .split(separator: "\n")
            .first { $0.hasPrefix("Status: ") }
            .map { String($0.dropFirst("Status: ".count)) } ?? ""
    }

    private func nextLine(_ rendered: String) -> String? {
        rendered.split(separator: "\n").first { $0.hasPrefix("Next: ") }.map(String.init)
    }

    private func uploadText(_ rendered: String) -> String {
        rendered
            .split(separator: "\n")
            .first { $0.hasPrefix("Last successful upload: ") }
            .map { String($0.dropFirst("Last successful upload: ".count)) } ?? ""
    }

    private func status(
        enabled: Bool,
        activationState: CollectorActivationState,
        daemonRunning: Bool = true,
        persistedState: PersistedCollectorState = .enabled,
        serverEnabledSurfaces: [RunSurface] = [.codexCLI],
        compiledAdapters: [RunSurface: AdapterHealth] = [.codexCLI: .available],
        lastSuccessfulUploadMS: Int64? = 1_700_000_000_000,
        laggingProviderFileCount: Int = 0,
        providerLagBytes: Int64 = 0,
        availableCompanionVersion: String? = nil,
        updateCommand: String? = nil
    ) -> AgentStatus {
        AgentStatus(
            enabled: enabled,
            activationState: activationState,
            daemonRunning: daemonRunning,
            persistedState: persistedState,
            serverEnabledSurfaces: serverEnabledSurfaces,
            compiledAdapters: compiledAdapters,
            queuedEventCount: 2,
            lastSuccessfulUploadMS: lastSuccessfulUploadMS,
            activeRunCount: 3,
            laggingProviderFileCount: laggingProviderFileCount,
            providerLagBytes: providerLagBytes,
            installedCompanionVersion: "0.4.8",
            availableCompanionVersion: availableCompanionVersion,
            updateCommand: updateCommand
        )
    }
}

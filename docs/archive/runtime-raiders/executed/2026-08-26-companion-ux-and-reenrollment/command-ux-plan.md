# Runtime Raiders Command UX Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `raiders status`, `on`, and `off` clear to employees while preserving the existing JSON status contract for automation.

**Architecture:** Keep `AgentStatus` as the one structured status model and keep the daemon control response as sorted JSON. Add a pure renderer in `RuntimeRaidersCore`, route `status` and `status --json` explicitly, and render only in the CLI process. Convert every repository automation consumer to request `--json` before changing the default.

**Tech Stack:** Swift 6, Foundation, Darwin TTY APIs, XCTest, POSIX shell, Bash, Zsh, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-runtime-raiders-companion-ux-and-reenrollment-design.md`

## Global Constraints

- `raiders status --json` must retain the exact sorted `AgentStatus.description` contract, including explicit JSON `null` fields.
- Pretty output must never equate `enabled=true` with `Ready`; use `activationState`.
- Pretty status uses deterministic field order and left alignment.
- Only `ON` may be green and `OFF` red; color requires an interactive stdout TTY and absence of `NO_COLOR`.
- Redirected output, `NO_COLOR`, and all JSON output contain no ANSI bytes.
- A healthy or intentionally off status has no `Next:` line.
- `on` remains responsive while preparation continues; `off` remains responsive during preparation.
- Do not change the control-socket lock/timeout behavior or mask POSIX error 35.
- Do not change scoring, enrollment, accounts, collection state, version numbers, release artifacts, or production.

---

## File map

- `companion/Sources/RuntimeRaidersCore/StatusRenderer.swift`: pure status and collection-command rendering plus ANSI capability policy.
- `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`: explicit pretty/JSON status routes and help route.
- `companion/Sources/RuntimeRaidersCLI/main.swift`: decode live JSON, select renderer, and print employee-facing command output.
- `companion/Tests/RuntimeRaidersCoreTests/StatusRendererTests.swift`: exact rendering and color snapshots.
- `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`: command routing contract.
- `companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift`: actual executable pretty/JSON behavior.
- `companion/packaging/install.sh`: use `status --json` for readiness and print the approved install handoff.
- `scripts/test/run-runtime-raiders-live-activation-gate.sh`: use `status --json` for machine parsing.
- `tests/companion-installer.test.ts`, `tests/runtime-raiders-live-activation-gate.test.ts`, `tests/runtime-raiders-onboarding.test.ts`: shell contract regressions.
- `docs/runtime-raiders/employee-beta.md`, `docs/runtime-raiders/companion-operations.md`: employee and operator command examples.

### Task 1: Add deterministic status and collection renderers

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/StatusRenderer.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/StatusRendererTests.swift`

**Interfaces:**
- Consumes: `AgentStatus`, `CollectorActivationState`, and `RunSurface` from `RuntimeRaidersCore`.
- Produces: `OutputStyle`, `StatusRenderer.render(_:nowMS:style:)`, and `CollectionCommandRenderer.render(enabled:activationState:style:)`.
- Does not read the clock, environment, terminal, filesystem, or network internally.

- [ ] **Step 1: Write failing exact-output tests**

Create table-driven fixtures for disabled, preparing, ready, invalid, update-available, never-uploaded, and future-upload states. Use this exact ready assertion:

```swift
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
```

Assert these state mappings:

```swift
XCTAssertEqual(renderedStatus(disabled), "Off")
XCTAssertEqual(renderedStatus(preparing), "Preparing safely in the background")
XCTAssertEqual(renderedStatus(ready), "Ready")
XCTAssertEqual(renderedStatus(invalid), "Needs attention")
```

Assert `Next: Run `raiders doctor`.` only for invalid/incoherent health and `Next: Run `raiders update`.` only for a healthy update-available snapshot. Doctor takes precedence when both apply. Assert absent surfaces render `None` and relative upload text is exactly `Just now`, `1 minute ago`, `59 minutes ago`, `1 hour ago`, `23 hours ago`, `1 day ago`, `29 days ago`, and `30+ days ago` at the boundaries.

- [ ] **Step 2: Write failing color and command-output tests**

Prove only the state word is colored:

```swift
XCTAssertTrue(StatusRenderer.render(ready, nowMS: now, style: .ansi)
    .contains("Collection: \u{001B}[32mON\u{001B}[0m"))
XCTAssertFalse(StatusRenderer.render(ready, nowMS: now, style: .plain)
    .contains("\u{001B}["))
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
```

- [ ] **Step 3: Run the renderer tests and verify RED**

Run: `cd companion && swift test --filter StatusRendererTests`

Expected: FAIL because `StatusRenderer`, `OutputStyle`, and `CollectionCommandRenderer` do not exist.

- [ ] **Step 4: Implement the minimal pure renderers**

Create these public interfaces:

```swift
public enum OutputStyle: Equatable, Sendable { case plain, ansi }

public enum StatusRenderer {
    public static func render(
        _ status: AgentStatus,
        nowMS: Int64,
        style: OutputStyle
    ) -> String
}

public enum CollectionCommandRenderer {
    public static func render(
        enabled: Bool,
        activationState: CollectorActivationState,
        style: OutputStyle
    ) -> String
}
```

Use exact surface labels:

```swift
private static let surfaceNames: [RunSurface: String] = [
    .claudeCode: "Claude Code",
    .codexCLI: "Codex CLI",
    .codexDesktop: "Codex Desktop",
    .omp: "Omp",
]
```

Define needs-attention as any of: `.invalid` persisted state; enabled with no daemon; enabled with `.disabled` activation; disabled with `.preparing` or `.ready` activation; any server-enabled surface whose compiled adapter is not `.available`; or a positive provider lag count/byte total while activation claims ready. Use saturating elapsed-time subtraction so future upload timestamps render `Just now`. Join lines with `\n` and do not append a newline; `print` owns the final newline.

- [ ] **Step 5: Run renderer tests and the Swift suite**

Run: `cd companion && swift test --filter StatusRendererTests && swift test`

Expected: PASS with no nondeterministic clock or locale failures.

- [ ] **Step 6: Commit the pure rendering unit**

```bash
git add companion/Sources/RuntimeRaidersCore/StatusRenderer.swift companion/Tests/RuntimeRaidersCoreTests/StatusRendererTests.swift
git commit -m "feat(raiders): add human status rendering"
```

### Task 2: Route pretty status, JSON status, help, on, and off

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift`

**Interfaces:**
- Consumes: renderers from Task 1 and the unchanged JSON `AgentStatus.description` daemon response.
- Produces: `StatusOutputFormat`, `.status(StatusOutputFormat)`, `.help`, and testable `outputStyle(isTTY:environment:)`.
- Preserves: `.control(.doctor)`, `.updateCheck`, `.daemon`, hidden verification routes, and the daemon wire response.

- [ ] **Step 1: Write failing routing tests**

Replace the implicit status routing assertions with:

```swift
XCTAssertEqual(route([]), .status(.pretty))
XCTAssertEqual(route(["status"]), .status(.pretty))
XCTAssertEqual(route(["status", "--json"]), .status(.json))
XCTAssertEqual(route(["help"]), .help)
XCTAssertEqual(route(["--help"]), .help)
XCTAssertNil(route(["status", "--pretty"]))
XCTAssertNil(route(["status", "--json", "extra"]))
```

Keep `ControlCommand.status` for daemon protocol compatibility, but do not route employee arguments directly to `.control(.status)`.

- [ ] **Step 2: Write failing executable integration tests**

Update the verification fixture so:

```swift
let pretty = try runCLI(fixture, arguments: ["status"])
XCTAssertEqual(pretty.exitStatus, 0)
XCTAssertTrue(pretty.stdout.hasPrefix("Runtime Raiders\nCollection: OFF\n"))
XCTAssertFalse(pretty.stdout.contains("\u{001B}[")) // captured stdout is not a TTY

let json = try runCLI(fixture, arguments: ["status", "--json"])
XCTAssertEqual(json.exitStatus, 0)
XCTAssertEqual(
    JSONSerialization.isValidJSONObject(
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.stdout.utf8)))
    ),
    true
)
XCTAssertTrue(json.stdout.contains(#""installedCompanionVersion":"1.2.3""#))
```

Add a socket fixture that returns `preparing`, `ready`, and `disabled` raw messages for `on`/`off` and assert the approved plain-language output. Add a decode-failure fixture and assert nonzero exit with `Runtime Raiders status response was invalid.` rather than falling back or printing malformed data. Add help output containing every public command once and no hidden route.

- [ ] **Step 3: Run routing and CLI tests and verify RED**

Run: `cd companion && swift test --filter ControlProtocolTests && swift test --filter RuntimeRaidersCLIIntegrationTests`

Expected: FAIL because status formatting and help routes do not exist and current status prints JSON by default.

- [ ] **Step 4: Implement explicit routes and output capability selection**

Add:

```swift
public enum StatusOutputFormat: Equatable, Sendable { case pretty, json }

public enum CompanionCommandRoute: Equatable, Sendable {
    case daemon
    case managedAgent(ManagedAgentAction)
    case control(ControlCommand)
    case status(StatusOutputFormat)
    case updateCheck
    case help
}

public func outputStyle(isTTY: Bool, environment: [String: String]) -> OutputStyle {
    isTTY && environment["NO_COLOR"] == nil ? .ansi : .plain
}
```

Add direct tests for all four combinations of TTY/non-TTY and `NO_COLOR`
present/absent. The presence of `NO_COLOR`, including an empty value, forces
`.plain`.

In the CLI, request `.status` over the socket, decode `AgentStatus` from UTF-8 JSON, and either print `status.description` or `StatusRenderer.render`. For daemon-unavailable status, pass `localStatus` through the same choice. Use `Darwin.isatty(STDOUT_FILENO) == 1` only at the outer CLI boundary.

For `on`, accept only `preparing` or `ready` daemon messages and map to the command renderer. For `off`, accept only `disabled`. An unexpected success message is a protocol failure. Do not change `DaemonRuntime.handle` activation behavior.

- [ ] **Step 5: Implement concise help and usage**

Use this public help text:

```text
Usage: raiders <command>

Commands:
  on                       Turn collection on
  off                      Turn collection off
  status                   Show collection and agent status
  status --json            Show machine-readable status
  doctor                   Run content-free health checks
  update                   Check for a companion update
  uninstall                Stop the agent and preserve installed state
  help                     Show this help
```

- [ ] **Step 6: Run focused tests and the full Swift suite**

Run: `cd companion && swift test --filter ControlProtocolTests && swift test --filter RuntimeRaidersCLIIntegrationTests && swift test`

Expected: PASS; captured output is plain, JSON remains parseable, and hidden routes remain gated.

- [ ] **Step 7: Commit the command routing unit**

```bash
git add companion/Sources/RuntimeRaidersCore/ControlSocket.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift
git commit -m "feat(raiders): make command status employee friendly"
```

### Task 3: Migrate every machine consumer to `status --json`

**Files:**
- Modify: `companion/packaging/install.sh`
- Modify: `scripts/test/run-runtime-raiders-live-activation-gate.sh`
- Modify: `tests/companion-installer.test.ts`
- Modify: `tests/runtime-raiders-live-activation-gate.test.ts`
- Modify: `tests/runtime-raiders-onboarding.test.ts`

**Interfaces:**
- Consumes: `raiders status --json` from Task 2.
- Produces: installers and gates that never parse employee-facing text.
- Preserves: installer rollback, readiness deadlines, diagnostic redaction, and live-gate off cleanup.

- [ ] **Step 1: Write failing shell-contract tests**

Add source assertions proving all JSON parsing invocations contain `status --json` and no parser invokes bare status. In the fake raiders tools, make bare status return:

```text
Runtime Raiders
Collection: OFF
Status: Off
```

and make `status --json` return the existing fixture JSON. Assert installer and gate success only through `--json`. Keep a scenario where `status --json` fails and assert the existing fail-closed message.

- [ ] **Step 2: Run focused Node tests and verify RED**

Run: `npm test -- tests/companion-installer.test.ts tests/runtime-raiders-live-activation-gate.test.ts tests/runtime-raiders-onboarding.test.ts`

Expected: FAIL because the installer and live gate still invoke bare `status`.

- [ ] **Step 3: Change exact machine invocations**

In `wait_for_installation_status`, change:

```sh
"$readiness_command" status --json > "$readiness_output"
```

In rollback/existing-state checks, use the same `status --json` form. In the live gate, change all assignments used by `sed`, `grep`, or JSON field checks to:

```bash
INITIAL_STATUS="$($RAIDERS_TOOL status --json 2>/dev/null)" || gate_fail 'raiders status failed'
```

and likewise for readiness polling. Do not convert `doctor`; its current JSON contract is unchanged.

- [ ] **Step 4: Update the successful installer handoff**

Replace the final one-line message with exactly:

```sh
printf '%s\n' \
  'Runtime Raiders is installed.' \
  'Collection is OFF.' \
  'Run `raiders status` to check the setup.' \
  'Run `raiders on` when you want to join the game.'
```

Keep operator details and secondary commands out of this handoff.

- [ ] **Step 5: Run shell syntax and focused tests**

Run: `/bin/sh -n companion/packaging/install.sh`

Run: `/bin/zsh -n companion/packaging/install.sh`

Run: `/bin/bash -n scripts/test/run-runtime-raiders-live-activation-gate.sh`

Run: `npm test -- tests/companion-installer.test.ts tests/runtime-raiders-live-activation-gate.test.ts tests/runtime-raiders-onboarding.test.ts`

Expected: PASS under both installer shells and the Bash-only operator gate.

- [ ] **Step 6: Commit the automation migration**

```bash
git add companion/packaging/install.sh scripts/test/run-runtime-raiders-live-activation-gate.sh tests/companion-installer.test.ts tests/runtime-raiders-live-activation-gate.test.ts tests/runtime-raiders-onboarding.test.ts
git commit -m "fix(raiders): keep status automation on JSON"
```

### Task 4: Document and verify the command UX slice

**Files:**
- Modify: `docs/runtime-raiders/employee-beta.md`
- Modify: `docs/runtime-raiders/companion-operations.md`
- Modify: `docs/BACKLOG.md`

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: employee docs that use pretty status and operator docs that use `--json` when parsing.

- [ ] **Step 1: Update employee and operator examples**

In `employee-beta.md`, describe `status` as human-readable and state that collection starts off. In `companion-operations.md`, add this rule:

```text
Humans use `raiders status`. Scripts and release gates use `raiders status --json`.
Never parse the human-readable status output.
```

Mark only the pretty-status, JSON-compatibility, install-handoff, and on/off-copy portions of backlog item 33 complete. Leave re-enrollment and removal unchecked.

- [ ] **Step 2: Run documentation and full regression checks**

Run: `rg -n 'status[^\n]*plutil|status[^\n]*sed|status[^\n]*grep' companion scripts tests`

Expected: no machine parser consumes bare status.

Run: `cd companion && swift test`

Run: `npm run typecheck`

Run: `npm test`

Expected: all Swift tests and all 149 baseline Node test files pass, with any newly added tests increasing the totals.

- [ ] **Step 3: Confirm the release boundary**

Run: `git status --short`

Run: `git diff --name-only HEAD~4..HEAD | rg '(^dist/|Info.plist|version)'`

Expected: working tree clean; no built release, version bump, or publication file.

- [ ] **Step 4: Commit the documentation checkpoint**

```bash
git add docs/runtime-raiders/employee-beta.md docs/runtime-raiders/companion-operations.md docs/BACKLOG.md
git commit -m "docs(raiders): explain readable and JSON status"
```

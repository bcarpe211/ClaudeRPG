# Runtime Raiders Managed Background Service Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy LaunchAgent with an Apple-managed embedded agent so macOS visibly attributes background activity to Runtime Raiders while keeping the employee CLI, hidden app location, telemetry behavior, and installed-off safety unchanged.

**Architecture:** `Runtime Raiders.app` becomes the signed parent bundle `com.redlattice.runtime-raiders` and embeds `Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist`. Private exact-path-only CLI routes call `SMAppService.agent(plistName:)`; the installer migrates legacy 0.4.2 or updates a managed install transactionally and rolls back using the prior registration mechanism.

**Tech Stack:** Swift 6, ServiceManagement, POSIX shell, launchd, Vitest/TypeScript, Developer ID signing and Apple notarization.

**Spec:** `docs/superpowers/specs/2026-08-21-runtime-raiders-smappservice-branding-design.md`

## Global Constraints

- Minimum platform remains macOS 13, matching `companion/Package.swift`.
- Parent app bundle identifier is exactly `com.redlattice.runtime-raiders`.
- Managed agent label and embedded plist name are exactly `com.redlattice.runtime-raiders.agent` and `com.redlattice.runtime-raiders.agent.plist`.
- Retired legacy label remains recognized only for migration and rollback as `com.redlattice.runtime-raiders-agent`.
- The employee command remains `raiders`; the app remains at `~/Library/Application Support/Runtime Raiders/Runtime Raiders.app`.
- No app is installed in `/Applications`; no GUI, updater machinery, database change, or telemetry behavior is added.
- The installer never runs `sfltool resetbtm` and never edits unrelated background items.
- Collection stays off during all implementation, signing, publication, and installed-canary work.
- Implementation, signing/notarization, publication, local installation, visible UI proof, and live activation require separate approvals.
- The stale publisher hostname default is outside this implementation; use the separately reviewed host override if publication is later authorized.

---

### Task 1: Managed agent lifecycle and private CLI routes

**Files:**
- Create: `companion/Sources/RuntimeRaidersCore/ManagedAgentService.swift`
- Create: `companion/Tests/RuntimeRaidersCoreTests/ManagedAgentServiceTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCore/ControlSocket.swift:15-46`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift:4-12,380-425`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift:39-100`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift:7-51`
- Delete: `companion/Sources/RuntimeRaidersCore/ApplicationRegistration.swift`
- Delete: `companion/Tests/RuntimeRaidersCoreTests/ApplicationRegistrationTests.swift`

**Interfaces:**
- Produces: `ManagedAgentAction`, `ManagedAgentStatus`, `ManagedAgentServiceOperations`, and `ManagedAgentServiceController.perform(_:)`.
- Produces: private route `__runtime-raiders-managed-agent register|unregister|status` that is accepted only from `AgentPaths.agentExecutable`.
- Consumes later: the installer invokes these private routes and requires canonical single-line status output.

- [ ] **Step 1: Write failing controller tests**

Create tests that inject closures and prove the controller does not touch Service Management directly:

```swift
func testRegisterRequiresEnabledPostcondition() throws {
    var registered = false
    let controller = ManagedAgentServiceController(operations: .init(
        register: { registered = true },
        unregister: {},
        status: { registered ? .enabled : .notRegistered }
    ))

    XCTAssertEqual(try controller.perform(.register), .enabled)
}

func testRegisterRejectsApprovalAndNotFoundStates() {
    for status in [ManagedAgentStatus.requiresApproval, .notFound] {
        let controller = ManagedAgentServiceController(operations: .init(
            register: {}, unregister: {}, status: { status }
        ))
        XCTAssertThrowsError(try controller.perform(.register))
    }
}

func testUnregisterIsIdempotentAndRequiresNotRegisteredPostcondition() throws {
    var status = ManagedAgentStatus.enabled
    let controller = ManagedAgentServiceController(operations: .init(
        register: {}, unregister: { status = .notRegistered }, status: { status }
    ))
    XCTAssertEqual(try controller.perform(.unregister), .notRegistered)
    XCTAssertEqual(try controller.perform(.unregister), .notRegistered)
}
```

Also cover `status`, a register operation that returns without reaching
`enabled`, and an unregister operation that returns without reaching
`notRegistered`.

- [ ] **Step 2: Run the focused tests to capture RED**

Run:

```bash
cd companion
swift test --filter ManagedAgentServiceTests
```

Expected: compile failure because the managed-agent types do not exist.

- [ ] **Step 3: Implement the testable Service Management boundary**

Create these exact public types:

```swift
import Foundation
import ServiceManagement

public enum ManagedAgentAction: String, Equatable, Sendable {
    case register
    case unregister
    case status
}

public enum ManagedAgentStatus: String, Equatable, Sendable {
    case notRegistered = "not-registered"
    case enabled
    case requiresApproval = "requires-approval"
    case notFound = "not-found"
}

public enum ManagedAgentServiceError: Error, Equatable, Sendable {
    case unexpectedStatus(ManagedAgentStatus)
}

public struct ManagedAgentServiceOperations: @unchecked Sendable {
    public let register: () throws -> Void
    public let unregister: () throws -> Void
    public let status: () -> ManagedAgentStatus
}

public struct ManagedAgentServiceController: Sendable {
    public static let plistName = "com.redlattice.runtime-raiders.agent.plist"
    public let operations: ManagedAgentServiceOperations
    public func perform(_ action: ManagedAgentAction) throws -> ManagedAgentStatus
    public static var live: ManagedAgentServiceController
}
```

Map every `SMAppService.Status` case explicitly. For `register`, return early
only when already enabled; otherwise require `notRegistered`, call
`register()`, and require the final status `enabled`. For `unregister`, return
early only when already not registered; otherwise require `enabled` or
`requiresApproval`, call `unregister()`, and require `notRegistered`.

- [ ] **Step 4: Run controller tests to capture GREEN**

Run:

```bash
cd companion
swift test --filter ManagedAgentServiceTests
```

Expected: all managed lifecycle tests pass without registering a real service.

- [ ] **Step 5: Write failing exact-route and verifier-isolation tests**

Replace the old application-registration assertions with:

```swift
XCTAssertEqual(
    CompanionCommandRouter.route(
        arguments: ["__runtime-raiders-managed-agent", "register"],
        executableURL: stableExecutable,
        paths: paths
    ),
    .managedAgent(.register)
)
XCTAssertNil(CompanionCommandRouter.route(
    arguments: ["__runtime-raiders-managed-agent", "status"],
    executableURL: otherExecutable,
    paths: paths
))
```

Cover all three actions, missing/extra arguments, and the wrong executable.
In CLI integration verification mode, require output `enabled\n` for
`register` and `status`, `not-registered\n` for `unregister`, no support-tree
mutation, and rejection when the verification gate is absent.

- [ ] **Step 6: Run route tests to capture RED**

Run:

```bash
cd companion
swift test --filter ControlProtocolTests/testFlatCommandRoutingUsesOnlyStableDaemonControlAndUpdateCheckRoutes
swift test --filter RuntimeRaidersCLIIntegrationTests/testActualVersionOnlyAppRunsStatusUpdateAndRuntimeInputVersionLoad
```

Expected: compile or assertion failure while the old registration route remains.

- [ ] **Step 7: Replace the legacy Launch Services route**

Change the route enum to:

```swift
public enum CompanionCommandRoute: Equatable, Sendable {
    case daemon
    case managedAgent(ManagedAgentAction)
    case control(ControlCommand)
    case updateCheck
}
```

Parse exactly two private arguments and require the installed executable path.
In normal mode call `ManagedAgentServiceController.live.perform(action)` and
print its raw value. In signed-verifier isolation mode validate the exact
executable, print the canonical result without importing or calling live
Service Management, and leave the support tree unchanged. Remove
`ApplicationRegistration` and its old route entirely.

- [ ] **Step 8: Run focused and full Swift tests**

Run:

```bash
cd companion
swift test --filter ManagedAgentServiceTests
swift test --filter ControlProtocolTests
swift test --filter RuntimeRaidersCLIIntegrationTests
swift test
```

Expected: all Swift tests pass; no test registers a real background service.

- [ ] **Step 9: Commit the managed lifecycle**

```bash
git add companion/Sources/RuntimeRaidersCore/ManagedAgentService.swift \
  companion/Sources/RuntimeRaidersCore/ControlSocket.swift \
  companion/Sources/RuntimeRaidersCLI/main.swift \
  companion/Tests/RuntimeRaidersCoreTests/ManagedAgentServiceTests.swift \
  companion/Tests/RuntimeRaidersCoreTests/ControlProtocolTests.swift \
  companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift
git rm companion/Sources/RuntimeRaidersCore/ApplicationRegistration.swift \
  companion/Tests/RuntimeRaidersCoreTests/ApplicationRegistrationTests.swift
git commit -m "feat(companion): add managed agent lifecycle"
```

---

### Task 2: Signed parent bundle and embedded LaunchAgent contract

**Files:**
- Create: `companion/packaging/com.redlattice.runtime-raiders.agent.plist`
- Delete: `companion/packaging/com.redlattice.runtime-raiders-agent.plist.template`
- Modify: `companion/Sources/RuntimeRaidersCore/InstalledCompanionVersion.swift:12-29`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift:7-80`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift:569-578`
- Modify: `scripts/release/build-runtime-raiders-agent.sh:180-230,300-340`
- Modify: `tests/companion-installer.test.ts:230-260,730-790`

**Interfaces:**
- Consumes: `ManagedAgentServiceController.plistName` from Task 1.
- Produces: one signed app with parent ID `com.redlattice.runtime-raiders` and embedded managed agent label `com.redlattice.runtime-raiders.agent`.
- Produces: `release-summary.txt` keys `bundle_identifier` and `managed_agent_label` for Task 4 verification.

- [ ] **Step 1: Add the exact embedded plist and write failing shape tests**

Create:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.redlattice.runtime-raiders.agent</string>
  <key>BundleProgram</key>
  <string>Contents/MacOS/runtime-raiders-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>runtime-raiders-agent</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
```

Update `CompanionReleaseTests` to require these exact keys and to reject
`Program`, absolute paths, `AssociatedBundleIdentifiers`, extra keys, and the
retired label.

- [ ] **Step 2: Run the bundle-contract tests to capture RED**

Run:

```bash
cd companion
swift test --filter CompanionReleaseTests
```

Expected: failures because tests still load the legacy template and the
installed bundle identity is still the retired label.

- [ ] **Step 3: Change the parent bundle identity and version loader**

Change the exact `InstalledCompanionVersion` bundle check and every real-bundle
fixture to:

```swift
infoDictionary["CFBundleIdentifier"] as? String == "com.redlattice.runtime-raiders"
```

Retain the exact short-version/bundle-version equality and semantic-version
checks.

- [ ] **Step 4: Embed the plist before signing**

In the release builder, create the signed layout before `codesign`:

```bash
MANAGED_AGENT_PLIST="$ROOT/companion/packaging/com.redlattice.runtime-raiders.agent.plist"
/bin/mkdir -p "$AGENT_APP/Contents/MacOS" "$AGENT_APP/Contents/Resources" \
  "$AGENT_APP/Contents/Library/LaunchAgents"
/bin/cp "$MANAGED_AGENT_PLIST" \
  "$AGENT_APP/Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist"
/bin/chmod 644 \
  "$AGENT_APP/Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist"
```

Set `CFBundleIdentifier` to `com.redlattice.runtime-raiders`. Extend the
builder's pre-sign validation to parse the copied plist and require the exact
label, `BundleProgram`, argument vector, and boolean/background keys. Write:

```text
bundle_identifier=com.redlattice.runtime-raiders
managed_agent_label=com.redlattice.runtime-raiders.agent
```

to the release summary.

- [ ] **Step 5: Update fake build expectations and capture GREEN**

Update the release-build fake app fixture and assertions to require the new
parent identity and embedded plist. Run:

```bash
npx vitest run tests/companion-installer.test.ts -t "release build"
cd companion
swift test --filter CompanionReleaseTests
swift test --filter RuntimeRaidersCLIIntegrationTests
```

Expected: focused Node and Swift bundle-contract tests pass.

- [ ] **Step 6: Prove the old bundle contract is rejected**

Add parameterized mutations for:

```text
missing embedded plist
embedded plist symlink
retired agent label
absolute BundleProgram
wrong daemon argument
AssociatedBundleIdentifiers present
parent bundle ID still com.redlattice.runtime-raiders-agent
```

Each builder test must exit nonzero without leaving
`dist/runtime-raiders-beta-<version>`.

- [ ] **Step 7: Commit the signed bundle contract**

```bash
git add companion/packaging/com.redlattice.runtime-raiders.agent.plist \
  companion/Sources/RuntimeRaidersCore/InstalledCompanionVersion.swift \
  companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift \
  companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift \
  scripts/release/build-runtime-raiders-agent.sh tests/companion-installer.test.ts
git rm companion/packaging/com.redlattice.runtime-raiders-agent.plist.template
git commit -m "feat(raiders): embed managed background agent"
```

---

### Task 3: Transactional legacy migration and managed reinstall

**Files:**
- Modify: `companion/packaging/install.sh:4-115,226-312,326-488`
- Modify: `tests/companion-installer.test.ts:27-430,980-1430`

**Interfaces:**
- Consumes: private managed-agent CLI from Task 1.
- Consumes: parent and embedded-plist identities from Task 2.
- Produces: fresh install, 0.4.2 legacy migration, and later managed reinstall with one rollback model.

- [ ] **Step 1: Extend the fake agent into a stateful managed-service seam**

Add `RR_MANAGED_STATE` and `RR_RUNNING` files to every installer fixture. The
fake installed/candidate agent must implement:

```sh
case "${1:-} ${2:-}" in
  '__runtime-raiders-managed-agent status')
    /bin/cat "$RR_MANAGED_STATE";;
  '__runtime-raiders-managed-agent register')
    [ "${RR_FAIL_MANAGED_REGISTER:-0}" != 1 ] || exit 79
    printf 'enabled\n' > "$RR_MANAGED_STATE"
    : > "$RR_RUNNING"
    printf 'enabled\n';;
  '__runtime-raiders-managed-agent unregister')
    [ "${RR_FAIL_MANAGED_UNREGISTER:-0}" != 1 ] || exit 80
    printf 'not-registered\n' > "$RR_MANAGED_STATE"
    /bin/rm -f "$RR_RUNNING"
    printf 'not-registered\n';;
esac
```

Log every operation before mutation so ordering assertions can distinguish
old-app unregister, new-app register, rollback unregister, and old-app restore.

- [ ] **Step 2: Write failing success-path tests**

Add three exact tests:

1. Fresh install creates app and shim, creates no plist in
   `~/Library/LaunchAgents`, registers once after final app placement, and ends
   managed `enabled` with collection disabled.
2. Legacy 0.4.2 install bootouts `com.redlattice.runtime-raiders-agent`, moves
   its plist into transaction backup, installs 0.4.3, registers the fresh
   managed label, and leaves the legacy plist absent.
3. Managed reinstall calls the old app's `unregister`, replaces the app, calls
   the new app's `register`, and never invokes `launchctl bootstrap`.

Run:

```bash
npx vitest run tests/companion-installer.test.ts -t "managed service"
```

Expected: RED because the installer still requires a three-target legacy
layout and creates/bootstraps a plist.

- [ ] **Step 3: Split immutable identities and validate the signed candidate**

At the top of `install.sh`, use:

```sh
APP_BUNDLE_ID='com.redlattice.runtime-raiders'
MANAGED_LABEL='com.redlattice.runtime-raiders.agent'
MANAGED_PLIST_NAME="$MANAGED_LABEL.plist"
LEGACY_LABEL='com.redlattice.runtime-raiders-agent'
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
APP_REQUIREMENT='identifier "com.redlattice.runtime-raiders" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'
```

Require the candidate embedded plist to be a regular nonsymlink file inside
the app and parse the exact Task 2 contract before stopping an existing
service. Keep `codesign --deep --strict`, the designated requirement, Gatekeeper,
and icon validation before transaction activation.

- [ ] **Step 4: Implement explicit existing-layout classification**

Classify only these states:

```text
fresh: no app, no shim, no legacy plist
legacy: app + shim + exact legacy plist; app bundle ID is retired ID
managed: app + shim, no legacy plist; app bundle ID is new parent ID and private status is enabled
```

Reject every partial or mixed layout before stopping anything. Do not create a
new file in `~/Library/LaunchAgents`; create that directory only when required
to restore a legacy backup.

- [ ] **Step 5: Implement the forward transaction**

Use these ordered operations:

```sh
case "$existing_form" in
  legacy) /bin/launchctl bootout "gui/$OWNER/$LEGACY_LABEL" 2>/dev/null || true ;;
  managed) "$AGENT" __runtime-raiders-managed-agent unregister \
      | /usr/bin/grep -Fx 'not-registered' >/dev/null ;;
esac

# Back up the prior app, shim, and legacy plist when present.
# Move the verified candidate app and staged shim into their stable paths.

managed_result="$($AGENT __runtime-raiders-managed-agent register)"
[ "$managed_result" = enabled ] || exit 1
[ "$($AGENT __runtime-raiders-managed-agent status)" = enabled ] || exit 1
"$COMMAND" status >/dev/null
```

Record `new_managed_registered=1` immediately after the exact enabled result.
Do not call `launchctl bootstrap` for the new agent.

- [ ] **Step 6: Implement registration-form-aware rollback**

Rollback must execute in this order:

1. If the new app registered, invoke its private `unregister` and require
   `not-registered`.
2. Move the failed new app aside; restore old app, shim, legacy plist, and
   command-link state.
3. If prior form was `legacy`, bootstrap the restored legacy plist.
4. If prior form was `managed`, invoke the restored app's private `register`
   and require `enabled`.
5. Run the restored command's `status` and require disabled collection.
6. Delete transaction backups only after all restoration checks pass;
   otherwise preserve them and print the existing no-retry warning.

- [ ] **Step 7: Run success tests to capture GREEN**

Run:

```bash
npx vitest run tests/companion-installer.test.ts -t "managed service"
```

Expected: all three forward paths pass with exact operation ordering.

- [ ] **Step 8: Add and run the complete failure matrix**

Add one test per boundary and assert exact restored bytes, registration form,
running state, collection off, and preserved recovery material when rollback
itself fails:

```text
old managed unregister fails
backup app fails
backup legacy plist fails
backup shim fails
candidate app replacement fails
candidate shim replacement fails
new managed register fails
new managed status is requires-approval
new managed status is not-found
post-register raiders status fails
TERM after old service stop
rollback new managed unregister fails
rollback app restore fails
rollback legacy plist restore fails
rollback shim restore fails
rollback legacy bootstrap fails
rollback old managed re-register fails
rollback restored raiders status fails
```

Run:

```bash
npx vitest run tests/companion-installer.test.ts -t "reinstall-safe installer"
```

Expected: all installer tests pass without invoking real Service Management,
launchd, networking, or the installed canary.

- [ ] **Step 9: Validate both employee shells and commit**

Run:

```bash
/bin/sh -n companion/packaging/install.sh
/bin/zsh -n companion/packaging/install.sh
npx vitest run tests/companion-installer.test.ts
```

Then commit:

```bash
git add companion/packaging/install.sh tests/companion-installer.test.ts
git commit -m "feat(installer): migrate to managed background service"
```

---

### Task 4: Signed verifier, release identity, and offline completion gate

**Files:**
- Modify: `companion/RELEASE`
- Modify: `scripts/test/verify-runtime-raiders-signed-release.sh:240-490`
- Modify: `scripts/release/build-runtime-raiders-agent.sh:230-405`
- Modify: `tests/companion-installer.test.ts:580-990`
- Modify: `scripts/test/runtime-raiders-gate-safety.sh:430-450`
- Modify: `docs/BACKLOG.md:555-600`

**Interfaces:**
- Consumes: managed CLI, bundle, and installer contracts from Tasks 1-3.
- Produces: deterministic, unpublished `dist/runtime-raiders-beta-0.4.3` only after a separately approved signed prepare.

- [ ] **Step 1: Write failing verifier tests for the new sealed contract**

Require the verifier to reject each mutation independently:

```text
parent bundle identifier differs from com.redlattice.runtime-raiders
managed_agent_label summary field is missing or wrong
embedded plist is missing, symlinked, writable, or has extra keys
embedded label, BundleProgram, or daemon argument differs
retired AssociatedBundleIdentifiers key is present
signed verification invokes a real managed-service mutation
```

Update the fake signed-agent log to require this isolated sequence from the
installer and standalone smokes:

```text
__runtime-raiders-managed-agent register
__runtime-raiders-managed-agent status
status
status
update
```

No invocation may touch a real Service Management database.

- [ ] **Step 2: Run verifier tests to capture RED**

Run:

```bash
npx vitest run tests/companion-installer.test.ts -t "signed verifier"
```

Expected: failures on the retired identity and missing embedded-agent checks.

- [ ] **Step 3: Update signed verification and release summary binding**

Change every designated requirement from the retired identifier to the parent
app identifier. Parse the embedded plist with `/usr/bin/plutil`, require its
exact immutable metadata, and bind `managed_agent_label` to the release summary.
Retain the one-app archive, universal architectures, hardened runtime, secure
timestamp, notarization, stapling, Gatekeeper, byte-snapshot, and fake-HOME
installed-off checks.

Change gate-safety path reporting so the retired plist is migration input only;
the final managed install must report it absent.

- [ ] **Step 4: Bump only the companion version to 0.4.3**

Write exactly:

```text
format=1
companion_version=0.4.3
```

Update version-bound fixtures and backlog prose to say the 0.4.3 source is
ready for a separately approved signed canary; do not check the visible-UI
acceptance boxes yet.

- [ ] **Step 5: Run focused and complete offline verification**

Run:

```bash
cd companion
swift test
cd ..
npx vitest run tests/companion-installer.test.ts
npm run typecheck
npm test
/bin/bash -n scripts/release/build-runtime-raiders-agent.sh
/bin/bash -n scripts/test/verify-runtime-raiders-signed-release.sh
/bin/sh -n companion/packaging/install.sh
/bin/zsh -n companion/packaging/install.sh
git diff --check
```

Expected: all commands exit zero; no signing, network, publication,
installation, background registration, or activation occurs.

- [ ] **Step 6: Inspect the complete diff and commit offline implementation**

Confirm the diff contains no updater, database, server, activation, global BTM
reset, `/Applications`, or publisher-host changes. Commit:

```bash
git add companion/RELEASE \
  companion/Sources/RuntimeRaidersCore/InstalledCompanionVersion.swift \
  companion/Tests/RuntimeRaidersCoreTests/CompanionReleaseTests.swift \
  companion/Tests/RuntimeRaidersCoreTests/RuntimeRaidersCLIIntegrationTests.swift \
  companion/packaging/com.redlattice.runtime-raiders.agent.plist \
  companion/packaging/install.sh \
  scripts/release/build-runtime-raiders-agent.sh \
  scripts/test/verify-runtime-raiders-signed-release.sh \
  scripts/test/runtime-raiders-gate-safety.sh tests/companion-installer.test.ts \
  docs/BACKLOG.md
git commit -m "feat(raiders): adopt managed background service"
```

Before committing, verify `git status --short` still lists
`companion/.build/` only as the pre-existing untracked cache; never stage it.

---

### Task 5: Separately authorized signed and visible canary gates

**Files:**
- Read: `dist/runtime-raiders-beta-0.4.3/release-summary.txt`
- Read: installed `~/Library/Application Support/Runtime Raiders/Runtime Raiders.app`
- Read: macOS Background Task Management and System Settings state
- Modify only after proof: `docs/BACKLOG.md`

**Interfaces:**
- Consumes: reviewed clean implementation commit from Task 4.
- Produces: visible installed-off acceptance evidence; it does not authorize live telemetry.

- [ ] **Step 1: Stop for Apple signing/notarization approval**

After explicit approval, run only:

```bash
/bin/bash scripts/release/release-runtime-raiders-beta.sh prepare
```

Require the local 0.4.3 directory to contain exactly `install.sh`,
`runtime-raiders-agent.zip`, `version`, and `release-summary.txt`, plus accepted
notarization, a stapled ticket, Gatekeeper acceptance, the parent app ID, the
managed agent label, the embedded plist, and an installed-off verifier smoke.
Nothing is published or installed.

- [ ] **Step 2: Stop for publication approval and announce VPN use**

Until the separate publisher-host repair lands, use the explicit supported
host override:

```bash
RUNTIME_RAIDERS_RELEASE_HOST=rluser@raiders.redlattice.com \
  /bin/bash scripts/release/release-runtime-raiders-beta.sh publish
```

Require exact public installer, ZIP, version bytes, headers, health, and the
local approved ZIP SHA-256. Nothing is installed or activated.

- [ ] **Step 3: Stop for local canary installation approval**

Before installation, require 0.4.2 status disabled with zero active Runs and
zero queued events. Then run:

```bash
/usr/bin/curl -fsSL https://raiders.redlattice.com/install.sh | /bin/sh
```

Immediately require:

```bash
/Users/carp/.local/bin/raiders status
/Users/carp/.local/bin/raiders update
/usr/bin/codesign --verify --deep --strict --verbose=2 \
  "/Users/carp/Library/Application Support/Runtime Raiders/Runtime Raiders.app"
/usr/sbin/spctl --assess --type execute --verbose=2 \
  "/Users/carp/Library/Application Support/Runtime Raiders/Runtime Raiders.app"
/usr/bin/xcrun stapler validate \
  "/Users/carp/Library/Application Support/Runtime Raiders/Runtime Raiders.app"
```

Expected: version 0.4.3, current, daemon running, collection disabled, zero
active Runs, zero queued events, and Apple trust accepted.

- [ ] **Step 4: Perform the real visible-identity acceptance check**

Inspect `sfltool dumpbtm`, then read the actual System Settings > General >
Login Items & Extensions screen. Capture the fresh notification if macOS shows
one. Pass only when:

```text
one visible item: Runtime Raiders or Runtime Raiders.app
icon: Runtime Raiders icon
managed parent: com.redlattice.runtime-raiders / Runtime Raiders
managed agent: com.redlattice.runtime-raiders.agent
retired plist: absent
Bryan Carpenter: developer attribution only, never the visible item or parent
```

If normal UI refresh is insufficient, a logout or restart may be recorded and
used with approval. Never use `sfltool resetbtm`. If the visible item remains
Bryan Carpenter, mark the canary failed, keep collection off, and stop.

- [ ] **Step 5: Record proof without activating telemetry**

Only after the visible gate passes, check the two branding acceptance boxes in
`docs/BACKLOG.md`, record whether refresh/logout/restart was needed, the signed
version and Git SHA, and the observed notification/UI names. Commit only that
evidence:

```bash
git add docs/BACKLOG.md
git commit -m "docs(raiders): record managed service canary"
```

Do not run `raiders on`. A bounded live activation remains a separate approval.

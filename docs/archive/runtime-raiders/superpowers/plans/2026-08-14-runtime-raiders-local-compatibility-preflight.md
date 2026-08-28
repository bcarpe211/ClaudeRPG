# Runtime Raiders Local Compatibility Preflight Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **Superseded 2026-08-14. Do not execute this plan.** The production aggregate
> found no sequence-8 fleet beyond the single installed-off canary. Runtime
> Raiders therefore uses the smaller bounded design in
> `2026-08-14-runtime-raiders-sequence8-canary-migration.md`: a fresh-install-only
> public installer, a one-time exact-layout canary migrator, and unsigned local
> behavioral tests. Apple signing/notarization remains a final trust gate.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one local, real-seed-derived compatibility command that finds installer, migration, launcher, and rollback defects before Developer ID signing, Apple notarization, or any Pi or installed-canary action.

**Architecture:** A read-only Node seed tool captures and clones only the allowlisted, content-free sequence-8 compatibility surface. Test-only Swift agent, launcher, and validator products share production composition and core logic but inject local trust facts at compile-time composition boundaries. A shared shell behavioral harness runs the happy migration and complete failure matrix locally; release-mode preflight records the exact unsigned production payload so the signed builder and slimmed Gate 2 can prove they consume the already-tested candidate.

**Tech Stack:** Swift 6 / Swift Package Manager, Foundation, Security.framework, Darwin, Bash 3.2-compatible shell, Node.js 20 ESM, TypeScript, Vitest 2, macOS `sandbox-exec`, ad-hoc `codesign`, Git, SHA-256.

## Global Constraints

- The everyday entry point is exactly `npm run canary:preflight`; frozen-source mode is `npm run canary:preflight -- --release`.
- Local preflight must not require a Developer ID identity, App Store Connect key, notary profile, Apple network request, publication, Pi access, Caddy access, installed-companion mutation, collection, or activation.
- The installed-off sequence-8 app, plist, shim, command-link metadata, permissions, Runtime Raiders PATH marker, and content-free `status` wire may be read but never modified.
- Never read or copy real enrollment values, provider records, message content, collector-state contents, outbox contents, Run records, or diagnostic contents.
- Use an owner-only short temporary root, no-follow path inspection, bounded output, bounded waits, exact process identity, and pre/post source fingerprints.
- Production executables must have no environment variable, preference, file, argument, or command route that bypasses Apple trust.
- Preflight trust implementations exist only in test-only products; the release builder packages only production products.
- The public installer continues to return generic fail-closed migration errors. Detailed reason codes remain local, bounded, and content-free.
- Development mode may run against a dirty worktree but cannot create a Gate 2 record. Release mode requires a clean exact HEAD and valid `companion/RELEASE`.
- Gate 2 remains local and unpublished and is reduced to Apple trust, final packaging, binding verification, and one signed happy-path smoke check.
- No task in this plan authorizes Developer ID signing, notarization, publication, Pi changes, installation, `raiders on`, collection, or office activation.

## File Structure

### New Swift composition and preflight products

- `companion/Sources/RuntimeRaidersExecutable/RuntimeRaidersAgentApplication.swift` — shared production agent command composition moved out of `main.swift`.
- `companion/Sources/RuntimeRaidersExecutable/RuntimeRaidersLauncherApplication.swift` — shared launcher selection and `exec` composition.
- `companion/Sources/RuntimeRaidersExecutable/RuntimeRaidersExecutableDependencies.swift` — explicit live dependency values consumed by the two composition entry points.
- `companion/Sources/RuntimeRaidersPreflightSupport/PreflightTrustFacts.swift` — fixed test-only trust facts shared only by preflight products.
- `companion/Sources/RuntimeRaidersPreflightCLI/main.swift` — test-only agent product with local trust facts and a detailed legacy-validation route.
- `companion/Sources/RuntimeRaidersPreflightLauncher/main.swift` — test-only launcher product with local trust facts.
- `companion/Sources/RuntimeRaidersPreflightReleaseValidator/main.swift` — test-only archive validator; tooling, not an application product.
- `companion/Tests/RuntimeRaidersExecutableTests/RuntimeRaidersExecutableTests.swift` — composition and production/preflight separation tests.

### New build, seed, harness, and record tooling

- `scripts/release/build-runtime-raiders-payload.sh` — deterministic unsigned universal app and validator payload builder shared by local preflight and the signed builder.
- `scripts/test/build-runtime-raiders-local-candidate.sh` — builds and ad-hoc-signs the test-only apps, archive, manifest, checksum, and behavioral installer.
- `scripts/test/runtime-raiders-local-seed.mjs` — allowlisted seed inspection, normalized fingerprinting, path translation, and temporary clone creation.
- `scripts/test/runtime-raiders-behavioral-harness.sh` — shared full or smoke installer/launcher/migration harness.
- `scripts/test/runtime-raiders-local-preflight.sh` — one-command orchestration, sandboxing, ordering, diagnostics, and release-mode dispatch.
- `scripts/test/runtime-raiders-local-preflight.sb` — denies network, real launchd, and writes to every real seed surface.
- `scripts/test/runtime-raiders-preflight-record.mjs` — canonical record creation and verification.
- `tests/runtime-raiders-local-preflight.test.ts` — seed, sandbox, harness, record, and command-contract tests.

### Existing files changed

- `companion/Package.swift` — shared executable library, two test-only app products, test-only validator tool, and executable tests.
- `companion/Sources/RuntimeRaidersCLI/main.swift` — tiny production agent entry point.
- `companion/Sources/RuntimeRaidersLauncher/main.swift` — tiny production launcher entry point.
- `companion/Sources/RuntimeRaidersCore/InstallerMigrationValidation.swift` — typed local findings and the exact sequence-8 mode contract.
- `companion/Sources/RuntimeRaidersCore/ReleaseArchiveVerifier.swift` — public explicit dependency initializer for test-only validator composition.
- `companion/Tests/RuntimeRaidersCoreTests/InstallerMigrationValidationTests.swift` — diagnostic, wire, mode, and generic-public-error regressions.
- `scripts/release/build-runtime-raiders-agent.sh` — consumes an accepted preflight payload rather than rebuilding source.
- `scripts/test/runtime-raiders-gate-safety.sh` — allowlisted source fingerprint and bounded diagnostic helpers.
- `scripts/test/verify-runtime-raiders-signed-release.sh` — verifies preflight binding and delegates only a signed smoke run.
- `tests/companion-installer.test.ts` — unsigned payload and signed-builder binding fixtures.
- `tests/runtime-raiders-release-gates.test.ts` — safety, production-target, preflight-record, and slim-Gate-2 contracts.
- `package.json` — `canary:preflight` script.
- `docs/runtime-raiders-companion-release-gates.md` — revised local preflight and Apple-only Gate 2 runbook.

---

### Task 1: Add typed local migration findings without changing acceptance policy

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/InstallerMigrationValidation.swift:1-1,060`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/InstallerMigrationValidationTests.swift:1-1,050`

**Interfaces:**
- Produces: `InstallerMigrationValidationFinding`, `InstallerStatusValidator.inspectLegacyDetailed`, and `LegacySequenceEightInstallationValidator.inspect`.
- Preserves: `InstallerStatusValidator.inspectLegacy`, `LegacySequenceEightInstallationValidator.validate`, and their current generic public errors.

- [ ] **Step 1: Write failing detailed-finding tests**

Add tests that require the exact reason while proving the public method remains generic:

```swift
func testDetailedLegacyValidationReportsTheObservedApplicationMode() throws {
    try withLegacyInstallation { fixture in
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: fixture.paths.legacyFlatApplication.path
        )
        let validator = makeLegacyValidator(fixture: fixture)
        XCTAssertThrowsError(try validator.inspect(
            homeDirectory: fixture.home,
            paths: fixture.paths,
            expectedTeamIdentifier: "ABCDE12345",
            pathEnvironment: "\(fixture.home.path)/.local/bin:/usr/bin:/bin"
        )) { error in
            XCTAssertEqual(error as? InstallerMigrationValidationFinding, .init(
                code: .legacyApplicationMode,
                expected: "0755",
                observed: "0700"
            ))
        }
        XCTAssertThrowsError(try validator.validate(
            homeDirectory: fixture.home,
            paths: fixture.paths,
            expectedTeamIdentifier: "ABCDE12345",
            pathEnvironment: "\(fixture.home.path)/.local/bin:/usr/bin:/bin"
        )) { error in
            XCTAssertEqual(error as? InstallerMigrationValidationError, .invalidLegacyInstallation)
        }
    }
}

func testDetailedLegacyStatusNamesAMissingRequiredKey() {
    let wire = replacing(
        legacyStatus(enabled: false, prepared: false),
        #"\"activeRunCount\":0,"#,
        with: ""
    )
    XCTAssertThrowsError(try InstallerStatusValidator.inspectLegacyDetailed(
        wire,
        prepared: false,
        expectedEnabled: false
    )) { error in
        XCTAssertEqual(
            (error as? InstallerMigrationValidationFinding)?.code,
            .legacyStatusMissingKey
        )
    }
}
```

- [ ] **Step 2: Run the focused tests and verify the diagnostic API is absent**

Run:

```bash
swift test --package-path companion --filter InstallerMigrationValidationTests
```

Expected: compilation fails because `InstallerMigrationValidationFinding`, `inspect`, and `inspectLegacyDetailed` do not exist.

- [ ] **Step 3: Add the bounded finding type and detailed methods**

Add this public content-free value and route every legacy validation guard through a code-specific helper:

```swift
public struct InstallerMigrationValidationFinding: Error, Equatable, Sendable {
    public enum Code: String, Equatable, Sendable {
        case legacyStatusBody = "legacy.status.body"
        case legacyStatusMissingKey = "legacy.status.missing-key"
        case legacyStatusUnexpectedKey = "legacy.status.unexpected-key"
        case legacyStatusInvalidType = "legacy.status.invalid-type"
        case legacyStatusInvariant = "legacy.status.invariant"
        case legacySupportPath = "legacy.support.path"
        case legacyTeamIdentifier = "legacy.team-identifier"
        case legacyDirectory = "legacy.directory"
        case legacyApplicationMode = "legacy.app.mode"
        case legacyExecutable = "legacy.app.executable"
        case legacyInfoPlist = "legacy.app.info-plist"
        case legacyReleaseIdentity = "legacy.app.release-identity"
        case legacyTrustFacts = "legacy.app.trust"
        case legacyApplicationChanged = "legacy.app.changed"
        case legacyLaunchdPlist = "legacy.plist.content"
        case legacyShim = "legacy.shim.content"
        case legacyCommandRecord = "legacy.command.record"
        case legacyCommandPath = "legacy.command.path"
        case legacyCommandPathEnvironment = "legacy.command.path-environment"
        case legacyCommandSymlink = "legacy.command.symlink"
    }

    public let code: Code
    public let expected: String?
    public let observed: String?

    public init(code: Code, expected: String? = nil, observed: String? = nil) {
        self.code = code
        self.expected = expected.map { String($0.prefix(256)) }
        self.observed = observed.map { String($0.prefix(256)) }
    }
}
```

`inspect` throws the typed finding. `validate` calls `inspect` and maps every error to `.invalidLegacyInstallation`. `inspectLegacyDetailed` throws typed status findings; the existing `inspectLegacy` maps them to `.invalidStatus`.

Make the existing `LegacySequenceEightInstallationValidator(signatureInspector:identityLoader:)` initializer public so the separately compiled preflight product can inject facts. This changes library construction only; the production application continues calling `init()`.

- [ ] **Step 4: Add one test for every finding code branch**

Use the existing fixture mutators to change exactly one surface at a time. Assert only the `Code`; assert `expected` and `observed` for modes, keys, identities, and PATH. Include a redaction test with a 1,000-character observed string and assert `utf8.count <= 256`.

- [ ] **Step 5: Run focused and complete Swift tests**

Run:

```bash
swift test --package-path companion --filter InstallerMigrationValidationTests
swift test --package-path companion
```

Expected: both commands pass. The existing `0755` synthetic application remains accepted in this task; the real `0700` policy correction happens only after the new preflight reproduces it.

- [ ] **Step 6: Commit the diagnostic foundation**

```bash
git add companion/Sources/RuntimeRaidersCore/InstallerMigrationValidation.swift companion/Tests/RuntimeRaidersCoreTests/InstallerMigrationValidationTests.swift
git commit -m "test: add migration compatibility diagnostics"
```

---

### Task 2: Extract the production agent composition and add the test-only agent

**Files:**
- Create: `companion/Sources/RuntimeRaidersExecutable/RuntimeRaidersExecutableDependencies.swift`
- Create: `companion/Sources/RuntimeRaidersExecutable/RuntimeRaidersAgentApplication.swift`
- Create: `companion/Sources/RuntimeRaidersPreflightSupport/PreflightTrustFacts.swift`
- Create: `companion/Sources/RuntimeRaidersPreflightCLI/main.swift`
- Create: `companion/Tests/RuntimeRaidersExecutableTests/RuntimeRaidersAgentApplicationTests.swift`
- Modify: `companion/Sources/RuntimeRaidersCLI/main.swift:1-900`
- Modify: `companion/Package.swift:1-45`

**Interfaces:**
- Produces: `RuntimeRaidersAgentApplication.run(arguments:environment:dependencies:)`.
- Produces: `RuntimeRaidersAgentDependencies.live` and a public initializer used only by the preflight target.
- Consumes: Task 1's detailed legacy inspector.

- [ ] **Step 1: Add failing package and composition tests**

Require a shared library target, a production product, and a separate preflight product:

```swift
func testProductionDependenciesMapDetailedLegacyFailureToGenericError() throws {
    let dependencies = RuntimeRaidersAgentDependencies.live
    XCTAssertThrowsError(try dependencies.validateLegacy(
        URL(fileURLWithPath: "/private/tmp/home"),
        AgentPaths(applicationSupportDirectory: URL(fileURLWithPath: "/private/tmp/home/Library/Application Support")),
        "ABCDE12345",
        "/usr/bin:/bin"
    )) { error in
        XCTAssertEqual(error as? InstallerMigrationValidationError, .invalidLegacyInstallation)
    }
}
```

Add a Vitest source/product contract that requires `raiders` to depend on `RuntimeRaidersExecutable` and forbids `RuntimeRaidersPreflightCLI` from the production product dependency list.

- [ ] **Step 2: Run tests and observe the missing composition target**

Run:

```bash
swift test --package-path companion --filter RuntimeRaidersAgentApplicationTests
npx vitest run tests/runtime-raiders-release-gates.test.ts -t 'production agent product excludes preflight trust'
```

Expected: the Swift target or type is missing and the product-contract assertion fails.

- [ ] **Step 3: Define explicit dependencies**

Create a value-only trust root so no runtime registry or environment selection is possible:

```swift
public struct RuntimeRaidersInstalledTrustRoot: Sendable {
    public let verifiedSelf: VerifiedCompanionApplication
    public let verifyApplication: @Sendable (URL) throws -> VerifiedCompanionApplication
}

public struct RuntimeRaidersAgentDependencies {
    public let installedTrustRoot: @Sendable (URL) throws -> RuntimeRaidersInstalledTrustRoot
    public let validateLegacy: @Sendable (
        URL, AgentPaths, String, String?
    ) throws -> Void

    public init(
        installedTrustRoot: @escaping @Sendable (URL) throws -> RuntimeRaidersInstalledTrustRoot,
        validateLegacy: @escaping @Sendable (
            URL, AgentPaths, String, String?
        ) throws -> Void
    ) {
        self.installedTrustRoot = installedTrustRoot
        self.validateLegacy = validateLegacy
    }

    public static let live = RuntimeRaidersAgentDependencies(
        installedTrustRoot: { bundleURL in
            try RuntimeRaidersLiveTrustRoot(expectedBundleURL: bundleURL).erased()
        },
        validateLegacy: { home, paths, team, pathEnvironment in
            try LegacySequenceEightInstallationValidator().validate(
                homeDirectory: home,
                paths: paths,
                expectedTeamIdentifier: team,
                pathEnvironment: pathEnvironment
            )
        }
    )
}
```

Move the current CLI implementation, including daemon runtime and update composition, into `RuntimeRaidersAgentApplication.swift`. Replace only direct construction of `InstalledTrustRoot` and the legacy validator with the dependency value. Keep the production main as:

```swift
import Foundation
import RuntimeRaidersExecutable

do {
    try RuntimeRaidersAgentApplication.run(
        arguments: Array(CommandLine.arguments.dropFirst()),
        environment: ProcessInfo.processInfo.environment,
        dependencies: .live
    )
} catch {
    fputs("\(error)\n", stderr)
    Foundation.exit(EXIT_FAILURE)
}
```

Add `RuntimeRaidersPreflightSupport` as a separate target depending only on `RuntimeRaidersCore`. Put the fixed team identifier, safe bundle identity loading, and all `CandidateSignatureFacts` construction behind this exact interface:

```swift
public enum PreflightTrustFacts {
    public static let teamIdentifier = "RRPREVIEW1"

    public static func agentIdentity(_ application: URL) throws -> CompanionReleaseIdentity
    public static func launcherProtocol(_ application: URL) throws -> Int
    public static func launcherOperations(paths: AgentPaths) -> LauncherSelectionOperations
    public static func bundle(
        application: URL,
        expectedTeam: String? = nil
    ) throws -> CandidateSignatureFacts
}
```

`bundle` validates the expected bundle identifier from `Info.plist`, requires `expectedTeam` to be nil or `RRPREVIEW1`, and returns true local facts for signature, all architectures, required architectures, hardened runtime, secure timestamp, and notarization. Those facts are explicitly simulated by the preflight product and are not claims about the ad-hoc signature. Production targets must not depend on this target.

In the preflight agent target, construct dependencies in code:

```swift
private func preflightAgentDependencies() throws -> RuntimeRaidersAgentDependencies {
    let team = PreflightTrustFacts.teamIdentifier
    return RuntimeRaidersAgentDependencies(
        installedTrustRoot: { application in
            let verified = VerifiedCompanionApplication(
                identity: try PreflightTrustFacts.agentIdentity(application),
                teamIdentifier: team
            )
            return RuntimeRaidersInstalledTrustRoot(
                verifiedSelf: verified,
                verifyApplication: { candidate in
                    VerifiedCompanionApplication(
                        identity: try PreflightTrustFacts.agentIdentity(candidate),
                        teamIdentifier: team
                    )
                }
            )
        },
        validateLegacy: { home, paths, expectedTeam, pathEnvironment in
            try LegacySequenceEightInstallationValidator(
                signatureInspector: { application, team in
                    try PreflightTrustFacts.bundle(application: application, expectedTeam: team)
                },
                identityLoader: PreflightTrustFacts.agentIdentity
            ).validate(
                homeDirectory: home,
                paths: paths,
                expectedTeamIdentifier: expectedTeam,
                pathEnvironment: pathEnvironment
            )
        }
    )
}
```

- [ ] **Step 4: Add the preflight agent main**

The preflight main obtains fixed local facts from `RuntimeRaidersPreflightSupport`, never from runtime input. It intercepts only the test-product-only detailed route:

```swift
private let preflightTeam = PreflightTrustFacts.teamIdentifier
private let arguments = Array(CommandLine.arguments.dropFirst())

if arguments == ["__runtime-raiders-preflight-validate-legacy"] {
    do {
        try LegacySequenceEightInstallationValidator(
            signatureInspector: { application, team in
                try PreflightTrustFacts.bundle(application: application, expectedTeam: team)
            },
            identityLoader: PreflightTrustFacts.agentIdentity
        ).inspect(
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            paths: AgentPaths(),
            expectedTeamIdentifier: preflightTeam
        )
    } catch let finding as InstallerMigrationValidationFinding {
        fputs("\(finding.code.rawValue) expected=\(finding.expected ?? "-") observed=\(finding.observed ?? "-")\n", stderr)
        Foundation.exit(EXIT_FAILURE)
    }
} else {
    try RuntimeRaidersAgentApplication.run(
        arguments: arguments,
        environment: ProcessInfo.processInfo.environment,
        dependencies: try preflightAgentDependencies()
    )
}
```

The production router and product do not contain this argument string.

- [ ] **Step 5: Run the composition and full Swift suites**

Run:

```bash
swift test --package-path companion --filter RuntimeRaidersAgentApplicationTests
swift build --package-path companion --product raiders
swift build --package-path companion --product runtime-raiders-preflight-agent
swift test --package-path companion
```

Expected: all pass and both executables build separately.

- [ ] **Step 6: Commit the agent composition**

```bash
git add companion/Package.swift companion/Sources/RuntimeRaidersCLI/main.swift companion/Sources/RuntimeRaidersExecutable companion/Sources/RuntimeRaidersPreflightCLI companion/Sources/RuntimeRaidersPreflightSupport companion/Tests/RuntimeRaidersExecutableTests
git commit -m "refactor: isolate agent trust composition"
```

---

### Task 3: Extract launcher composition and add preflight launcher and validator tools

**Files:**
- Create: `companion/Sources/RuntimeRaidersExecutable/RuntimeRaidersLauncherApplication.swift`
- Create: `companion/Sources/RuntimeRaidersPreflightLauncher/main.swift`
- Create: `companion/Sources/RuntimeRaidersPreflightReleaseValidator/main.swift`
- Create: `companion/Tests/RuntimeRaidersExecutableTests/RuntimeRaidersLauncherApplicationTests.swift`
- Modify: `companion/Sources/RuntimeRaidersLauncher/main.swift:1-135`
- Modify: `companion/Sources/RuntimeRaidersCore/ReleaseArchiveVerifier.swift:40-85`
- Modify: `companion/Package.swift`
- Modify: `tests/runtime-raiders-release-gates.test.ts`

**Interfaces:**
- Produces: `RuntimeRaidersLauncherApplication.run(arguments:environment:dependencies:)`.
- Produces for `@testable` composition tests: `RuntimeRaidersLauncherApplication.selection(arguments:environment:dependencies:)`.
- Produces products: `runtime-raiders-preflight-launcher` and `runtime-raiders-preflight-release-validator`.
- The validator is test tooling and is never copied by the production release builder.

- [ ] **Step 1: Add failing launcher separation tests**

Require dependency construction rather than the current `#if DEBUG` environment route:

```swift
func testPreflightLauncherSelectsAnIdentityMatchingReleaseState() throws {
    let fixture = try LauncherCompositionFixture()
    let request = try RuntimeRaidersLauncherApplication.selection(
        arguments: ["status"],
        environment: fixture.environment,
        dependencies: fixture.preflightDependencies
    )
    XCTAssertEqual(request.executable, fixture.activeExecutable)
    XCTAssertEqual(request.arguments, ["status"])
}
```

Add a source assertion that the production launcher contains none of:

```text
RUNTIME_RAIDERS_LAUNCHER_DEBUG_SUPPORT_ROOT
RUNTIME_RAIDERS_LAUNCHER_DEBUG_EXEC_RECORD
RRPREVIEW1
```

- [ ] **Step 2: Run the focused tests and observe the old DEBUG route**

Run:

```bash
swift test --package-path companion --filter RuntimeRaidersLauncherApplicationTests
npx vitest run tests/runtime-raiders-release-gates.test.ts -t 'production launcher excludes preflight trust'
```

Expected: the new API is missing and the production-source assertion sees the DEBUG environment route.

- [ ] **Step 3: Move launcher behavior behind explicit dependencies**

Use this dependency shape:

```swift
public struct RuntimeRaidersLauncherDependencies {
    public let operations: @Sendable (AgentPaths) -> LauncherSelectionOperations
    public let execution: LauncherExecutionAdapter

    public init(
        operations: @escaping @Sendable (AgentPaths) -> LauncherSelectionOperations,
        execution: LauncherExecutionAdapter
    ) {
        self.operations = operations
        self.execution = execution
    }

    public static let live = RuntimeRaidersLauncherDependencies(
        operations: { paths in .live(paths: paths, launcherBundle: .main) },
        execution: LauncherExecutionAdapter(replaceProcess: replaceRuntimeRaidersProcess)
    )
}
```

Expose this internal helper to `@testable` tests and have `run` call it before executing:

```swift
static func selection(
    arguments: [String],
    environment: [String: String],
    dependencies: RuntimeRaidersLauncherDependencies
) throws -> LauncherExecutionRequest
```

Delete `DebugLauncherContext`. The production main passes `.live`; the preflight main passes operations that load the same release state and identity but return the fixed `RRPREVIEW1` trust facts.

The preflight launcher main uses no environment-selected trust mode:

```swift
try RuntimeRaidersLauncherApplication.run(
    arguments: Array(CommandLine.arguments.dropFirst()),
    environment: ProcessInfo.processInfo.environment,
    dependencies: RuntimeRaidersLauncherDependencies(
        operations: PreflightTrustFacts.launcherOperations,
        execution: RuntimeRaidersLauncherDependencies.live.execution
    )
)
```

- [ ] **Step 4: Add the preflight archive validator tool**

Make `ReleaseArchiveVerifier`'s explicit closure initializer public. The preflight validator parses the same 2- or 8-argument contract as the production tool and injects facts only in its own executable:

```swift
let verifier = ReleaseArchiveVerifier(
    signatureInspector: { try PreflightTrustFacts.bundle(application: $0) },
    installerSignatureInspector: { application, team in
        try PreflightTrustFacts.bundle(application: application, expectedTeam: team)
    },
    agentIdentityLoader: PreflightTrustFacts.agentIdentity,
    launcherProtocolLoader: PreflightTrustFacts.launcherProtocol
)
```

Replace the current internal three-closure initializer with a public four-closure initializer matching those argument labels. The production `init()` remains unchanged and continues constructing `SignedBundleTrustInspector`.

The tool must still use the production `ZipArchiveValidator`, release identity checks, bundle identifiers, architectures declared by the fixture, and exact archive roots.

- [ ] **Step 5: Prove release products cannot package preflight products**

Add Vitest assertions that `build-runtime-raiders-agent.sh` names only `raiders`, `runtime-raiders-launcher`, and `runtime-raiders-release-validator`, and that no preflight product string appears in `companion/packaging/install.sh` or the production renderer.

- [ ] **Step 6: Run all new product and package tests**

Run:

```bash
swift build --package-path companion --product runtime-raiders-launcher
swift build --package-path companion --product runtime-raiders-preflight-launcher
swift build --package-path companion --product runtime-raiders-preflight-release-validator
swift test --package-path companion
npx vitest run tests/runtime-raiders-release-gates.test.ts -t 'preflight trust|production launcher|production agent'
```

Expected: all pass.

- [ ] **Step 7: Commit launcher and validator separation**

```bash
git add companion/Package.swift companion/Sources/RuntimeRaidersCore/ReleaseArchiveVerifier.swift companion/Sources/RuntimeRaidersExecutable companion/Sources/RuntimeRaidersLauncher/main.swift companion/Sources/RuntimeRaidersPreflightLauncher companion/Sources/RuntimeRaidersPreflightReleaseValidator companion/Tests/RuntimeRaidersExecutableTests tests/runtime-raiders-release-gates.test.ts
git commit -m "refactor: isolate launcher and validator trust"
```

---

### Task 4: Extract deterministic unsigned payload building

**Files:**
- Create: `scripts/release/build-runtime-raiders-payload.sh`
- Create: `scripts/test/build-runtime-raiders-local-candidate.sh`
- Modify: `scripts/release/build-runtime-raiders-agent.sh:78-243`
- Modify: `tests/companion-installer.test.ts`
- Modify: `tests/runtime-raiders-release-gates.test.ts`

**Interfaces:**
- `build-runtime-raiders-payload.sh --release-sha SHA --output DIR --scratch-path DIR --agent-product PRODUCT --launcher-product PRODUCT --validator-product PRODUCT` creates one absent output directory containing `Runtime Raiders Release/` and `runtime-raiders-release-validator`.
- The production builder hard-codes production product names.
- The local candidate builder hard-codes the three preflight product names and emits a private disposable quartet.

- [ ] **Step 1: Add failing unsigned-payload tests**

Extend the disposable Swift/build fakes to record requested products and add:

```ts
it('builds a deterministic unsigned payload without Apple credentials', () => {
  const first = invokePayloadBuilder(fixture, fixture.firstOutput, {});
  const second = invokePayloadBuilder(fixture, fixture.secondOutput, {});
  expect(first.status, first.stderr).toBe(0);
  expect(second.status, second.stderr).toBe(0);
  expect(treeDigest(fixture.firstOutput)).toBe(treeDigest(fixture.secondOutput));
  expect(readFileSync(fixture.commandLog, 'utf8')).not.toMatch(/codesign|notarytool|stapler/);
});

it('keeps the signed builder hard-wired to production products', () => {
  expect(readFileSync(build, 'utf8')).toContain('--agent-product raiders');
  expect(readFileSync(build, 'utf8')).toContain('--launcher-product runtime-raiders-launcher');
  expect(readFileSync(build, 'utf8')).not.toContain('runtime-raiders-preflight-agent');
});
```

- [ ] **Step 2: Run focused tests and observe the missing builder**

Run:

```bash
npx vitest run tests/companion-installer.test.ts tests/runtime-raiders-release-gates.test.ts -t 'unsigned payload|hard-wired to production products'
```

Expected: failure because the payload builder is absent.

- [ ] **Step 3: Move deterministic build and app rendering into the payload script**

Move the universal Swift builds, `lipo` checks, production validator build, app directory creation, and both Info.plist renderings from the signed builder. Accept only these exact triples:

```sh
case "$AGENT_PRODUCT:$LAUNCHER_PRODUCT:$VALIDATOR_PRODUCT" in
  raiders:runtime-raiders-launcher:runtime-raiders-release-validator|\
  runtime-raiders-preflight-agent:runtime-raiders-preflight-launcher:runtime-raiders-preflight-release-validator) ;;
  *) echo "unsupported payload product set" >&2; exit 64 ;;
esac
```

The output is mode `0700`, contains no symlinks or extra roots, and remains unsigned.

- [ ] **Step 4: Make the signed builder call only the production triple**

Replace its build block with:

```sh
"$ROOT/scripts/release/build-runtime-raiders-payload.sh" \
  --release-sha "$RELEASE_SHA" \
  --output "$WORK/payload" \
  --scratch-path "$WORK/swift-scratch" \
  --agent-product raiders \
  --launcher-product runtime-raiders-launcher \
  --validator-product runtime-raiders-release-validator
```

Keep signing, notarization, stapling, final ZIP, checksum, manifest, renderer, and quartet publication-local staging in the existing script for now.

- [ ] **Step 5: Build a disposable local candidate**

The local builder calls the preflight triple, copies its output into an owned work root, applies automatic ad-hoc signatures with `/usr/bin/codesign --force --sign -`, creates a ZIP, checksum, canonical manifest, and renders `install.sh` with the preflight validator. It explicitly scrubs every Apple credential with `gate_run_without_release_credentials`.

- [ ] **Step 6: Run syntax, focused, and Gate 1 tests**

Run:

```bash
sh -n scripts/release/build-runtime-raiders-payload.sh
sh -n scripts/test/build-runtime-raiders-local-candidate.sh
npx vitest run tests/companion-installer.test.ts tests/runtime-raiders-release-gates.test.ts -t 'payload|production products|local candidate'
npm run canary:lifecycle-test
```

Expected: all pass without contacting Apple.

- [ ] **Step 7: Commit the shared payload builder**

```bash
git add scripts/release/build-runtime-raiders-payload.sh scripts/release/build-runtime-raiders-agent.sh scripts/test/build-runtime-raiders-local-candidate.sh tests/companion-installer.test.ts tests/runtime-raiders-release-gates.test.ts
git commit -m "build: add unsigned companion payload stage"
```

---

### Task 5: Add the allowlisted real sequence-8 seed inspector and cloner

**Files:**
- Create: `scripts/test/runtime-raiders-local-seed.mjs`
- Create: `tests/runtime-raiders-local-preflight.test.ts`
- Modify: `scripts/test/runtime-raiders-gate-safety.sh:382-450`

**Interfaces:**
- `inspect --home HOME --output FILE` writes a canonical mode-`0600` seed manifest.
- `clone --manifest FILE --source-home HOME --destination-home HOME` creates only the translated public layout plus empty structural directories; synthetic private state is written later by the behavioral harness.
- `verify --home HOME --manifest FILE` proves the allowlisted source fingerprint is unchanged.

- [ ] **Step 1: Write failing allowlist and translation tests**

Build a synthetic sequence-8 tree with unreadable sentinel secrets and an executable content-free status fixture:

```ts
it('inspects and clones only the allowlisted content-free seed surface', () => {
  const seed = sequenceEightSeed({ appMode: 0o700, omittedNilStatusKeys: true });
  chmodSync(seed.enrollment, 0o000);
  chmodSync(seed.collectorState, 0o000);
  const inspected = runSeed(['inspect', '--home', seed.home, '--output', seed.manifest]);
  expect(inspected.status, inspected.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(seed.manifest, 'utf8'));
  expect(manifest.identity.release_sequence).toBe(8);
  expect(manifest.entries.find((entry: any) => entry.path === 'app').mode).toBe('0700');
  expect(JSON.stringify(manifest)).not.toContain('device_token');
  expect(JSON.stringify(manifest)).not.toContain('collector-state.json');
  expect(runSeed(['clone', '--manifest', seed.manifest, '--source-home', seed.home,
    '--destination-home', seed.clone]).status).toBe(0);
  expect(readFileSync(seed.clonePlist, 'utf8')).toContain(seed.clone);
  expect(readFileSync(seed.clonePlist, 'utf8')).not.toContain(seed.home);
});
```

Also test symlinked directories, extra status keys, status output above 16 KiB, newline-bearing paths, changed source after inspection, and a profile containing unrelated lines and the one exact Runtime Raiders marker.

- [ ] **Step 2: Run the test and observe the missing tool**

Run:

```bash
npx vitest run tests/runtime-raiders-local-preflight.test.ts -t 'seed surface|source fingerprint|path translation'
```

Expected: failure because `runtime-raiders-local-seed.mjs` is absent.

- [ ] **Step 3: Implement the exact seed manifest**

Use this schema and canonical sorted-key JSON:

```ts
type SeedManifestV1 = {
  schema_version: 1;
  identity: {
    companion_version: '0.2.6';
    release_sequence: 8;
    release_sha: 'dec88d4f6ff600f2be92bed3b12dcfce85f84a51';
    update_protocol_version: 1;
  };
  team_identifier: string;
  status: Record<string, unknown>;
  entries: Array<{
    path: string;
    kind: 'directory' | 'file' | 'symlink';
    mode: string;
    uid: number;
    sha256?: string;
    target?: string;
    xattrs: Array<{ name: string; value_hex: string }>;
  }>;
  source_fingerprint: string;
};
```

Only app files, public plist/shim/command-link bytes, command symlink, owned directory metadata, Runtime Raiders marker presence, and status JSON enter the manifest. Normalize the source home to `${HOME}` before hashing. Limit the manifest to 4 MiB, status to 16 KiB, each public file to 1 MiB, 16,384 app entries, and 64 xattrs per entry.

- [ ] **Step 4: Implement metadata-preserving cloning**

Invoke `/usr/bin/ditto` only for the app bundle. Recreate other directories and links from validated manifest types. Replace the exact normalized `${HOME}` token with the destination home in plist, shim, command-link, symlink target, and Runtime Raiders profile marker. Refuse zero or multiple unexpected home substitutions.

- [ ] **Step 5: Add source-safe fingerprint helpers**

Add `gate_fingerprint_real_seed` that calls the Node `verify` command. Do not reuse `gate_fingerprint_migration_surface`, because that function intentionally hashes synthetic enrollment and state inside temporary fixtures.

- [ ] **Step 6: Run the complete seed test file**

Run:

```bash
npx vitest run tests/runtime-raiders-local-preflight.test.ts
```

Expected: all seed, privacy, bounds, symlink, translation, and fingerprint cases pass.

- [ ] **Step 7: Commit the seed tool**

```bash
git add scripts/test/runtime-raiders-local-seed.mjs scripts/test/runtime-raiders-gate-safety.sh tests/runtime-raiders-local-preflight.test.ts
git commit -m "test: derive migration fixtures from the real seed"
```

---

### Task 6: Extract the behavioral harness and expose the fail-fast command

**Files:**
- Create: `scripts/test/runtime-raiders-behavioral-harness.sh`
- Create: `scripts/test/runtime-raiders-local-preflight.sh`
- Create: `scripts/test/runtime-raiders-local-preflight.sb`
- Modify: `scripts/test/verify-runtime-raiders-signed-release.sh:196-592`
- Modify: `scripts/test/runtime-raiders-gate2-paths.sh`
- Modify: `tests/runtime-raiders-local-preflight.test.ts`
- Modify: `tests/runtime-raiders-release-gates.test.ts`
- Modify: `package.json`

**Interfaces:**
- `runtime-raiders-behavioral-harness.sh --mode full|smoke --quartet DIR --seed-manifest FILE --seed-home HOME --work-root DIR`.
- `npm run canary:preflight` invokes `bash scripts/test/runtime-raiders-local-preflight.sh`.
- Full mode runs launcher cases, fresh install, one successful migration, and all 16 injected failure boundaries. Smoke mode runs fresh install plus one successful migration.

- [ ] **Step 1: Add failing command, sandbox, and boundary-contract tests**

Require the new package script and exact full boundary list:

```ts
const migrationBoundaries = [
  'archive-verification', 'enrollment-decision', 'prepare', 'old-job-stop',
  'launcher-directory', 'releases-directory', 'installation-directory',
  'launcher-placement', 'release-placement', 'state-write', 'plist-replacement',
  'shim-replacement', 'command-link-replacement', 'bootstrap',
  'prepared-health', 'resume',
];

it('runs every migration boundary locally before Gate 2', () => {
  const source = readFileSync(localBehavioralHarness, 'utf8');
  for (const boundary of migrationBoundaries) expect(source).toContain(boundary);
  expect(source).toContain('--mode full');
});

it('denies writes to every real seed surface and all outbound network', () => {
  expect(readFileSync(localSandbox, 'utf8')).toContain('(deny network-outbound (remote ip))');
  for (const parameter of ['REAL_SUPPORT', 'REAL_PLIST', 'REAL_COMMAND', 'REAL_PROFILE']) {
    expect(readFileSync(localSandbox, 'utf8')).toContain(parameter);
  }
});
```

- [ ] **Step 2: Run tests and observe missing scripts**

Run:

```bash
npx vitest run tests/runtime-raiders-local-preflight.test.ts tests/runtime-raiders-release-gates.test.ts -t 'migration boundary|real seed surface|canary:preflight'
```

Expected: failure because the command and harness do not exist.

- [ ] **Step 3: Extract the reusable behavior from Gate 2**

Move synthetic enrollment creation, fake network and launchd, launcher cases, temporary daemon process capture, successful migration, and failure-fingerprint loop into the shared harness. Replace `write_legacy_fixture` with the Task 5 clone command followed by synthetic state creation:

```sh
node "$ROOT/scripts/test/runtime-raiders-local-seed.mjs" clone \
  --manifest "$SEED_MANIFEST" \
  --source-home "$SEED_HOME" \
  --destination-home "$case_home"
write_synthetic_enrollment_and_state "$case_home"
```

Delete each passing case immediately. Preserve only the current failed case's bounded logs and fingerprints.

At this intermediate commit, make `verify-runtime-raiders-signed-release.sh` invoke the extracted harness with `--mode full`. This preserves the existing Gate 2 behavior until Task 10 deliberately switches that caller to `--mode smoke`.

- [ ] **Step 4: Add the outer read-only orchestration and sandbox re-entry**

Outside the sandbox, resolve the original home, inspect the seed to an owner-only short root, and record the starting fingerprint. Re-enter through `sandbox-exec` with deny-write literals for the real support root, launchd plist, command symlink, and profile plus denied outbound network and denied absolute `launchctl`.

Inside the sandbox, scrub Apple credentials, build the local candidate, invoke the test-only detailed route against the first clone, run the full harness, then run existing Gate 1. A trap always verifies the source fingerprint before returning the original status.

- [ ] **Step 5: Make failures exact and bounded**

On failure, print exactly:

```text
Runtime Raiders local preflight failed
stage=<seed|build|happy-migration|failure-matrix|safety|gate1>
reason=<typed-code-or-bounded-command-status>
diagnostics=<absolute-owner-only-path>
```

Keep at most 16 MiB, 512 entries, and one failed case. Successful runs remove all temporary data.

- [ ] **Step 6: Run the synthetic command tests**

Run:

```bash
bash -n scripts/test/runtime-raiders-behavioral-harness.sh
bash -n scripts/test/runtime-raiders-local-preflight.sh
npx vitest run tests/runtime-raiders-local-preflight.test.ts tests/runtime-raiders-release-gates.test.ts
```

Expected: the scripted fixtures pass, including sandbox denial and source-unchanged checks.

- [ ] **Step 7: Run the command against the authorized real seed and preserve the red evidence**

Run:

```bash
npm run canary:preflight
```

Expected: failure before signing, notarization, or Pi access with:

```text
stage=happy-migration
reason=legacy.app.mode
```

The detailed line records expected `0755` and observed `0700`; the final source fingerprint matches the initial fingerprint.

- [ ] **Step 8: Commit the fail-fast detector while the real compatibility gate remains intentionally red**

```bash
git add package.json scripts/test/runtime-raiders-behavioral-harness.sh scripts/test/runtime-raiders-local-preflight.sh scripts/test/runtime-raiders-local-preflight.sb scripts/test/runtime-raiders-gate2-paths.sh scripts/test/verify-runtime-raiders-signed-release.sh tests/runtime-raiders-local-preflight.test.ts tests/runtime-raiders-release-gates.test.ts
git commit -m "test: add real-seed local compatibility preflight"
```

The repository's synthetic suites must be green. The real-seed preflight remains red only for the reproduced mode contract until Task 7.

---

### Task 7: Align the legacy mode contract with the exact installed sequence 8

**Files:**
- Modify: `companion/Sources/RuntimeRaidersCore/InstallerMigrationValidation.swift`
- Modify: `companion/Tests/RuntimeRaidersCoreTests/InstallerMigrationValidationTests.swift`
- Modify: `tests/runtime-raiders-local-preflight.test.ts`

**Interfaces:**
- Changes the exact legacy application-root mode from synthetic `0755` to observed `0700`.
- Does not broaden any other mode, owner, type, identity, signature, or path rule.

- [ ] **Step 1: Change the regression test to express the real contract**

Set the default legacy fixture application root to `0700` and require `0755` to fail specifically:

```swift
func testLegacyApplicationRequiresExactInstalledSequenceEightMode() throws {
    try withLegacyInstallation(applicationMode: 0o700) { fixture in
        XCTAssertNoThrow(try makeLegacyValidator(fixture: fixture).inspect(
            homeDirectory: fixture.home,
            paths: fixture.paths,
            expectedTeamIdentifier: "ABCDE12345",
            pathEnvironment: "\(fixture.home.path)/.local/bin:/usr/bin:/bin"
        ))
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: fixture.paths.legacyFlatApplication.path
        )
        XCTAssertThrowsError(try makeLegacyValidator(fixture: fixture).inspect(
            homeDirectory: fixture.home,
            paths: fixture.paths,
            expectedTeamIdentifier: "ABCDE12345",
            pathEnvironment: "\(fixture.home.path)/.local/bin:/usr/bin:/bin"
        )) { error in
            XCTAssertEqual(
                error as? InstallerMigrationValidationFinding,
                .init(code: .legacyApplicationMode, expected: "0700", observed: "0755")
            )
        }
    }
}
```

- [ ] **Step 2: Run the focused test and observe failure under the old rule**

Run:

```bash
swift test --package-path companion --filter testLegacyApplicationRequiresExactInstalledSequenceEightMode
```

Expected: the `0700` valid case fails and the `0755` invalid case succeeds.

- [ ] **Step 3: Make the one-line policy correction**

Change only:

```swift
try requireDirectory(application, mode: 0o700, code: .legacyApplicationMode)
```

Retain `0755` for `Contents`, `Contents/MacOS`, and the executable, and `0644` for `Info.plist`.

- [ ] **Step 4: Run focused, Swift, and real local preflight**

Run:

```bash
swift test --package-path companion --filter InstallerMigrationValidationTests
swift test --package-path companion
npm run canary:preflight
```

Expected: all pass. If the real preflight exposes another content-free seed mismatch, add a named regression that fails for that exact reason, make the narrow contract correction, and repeat these three commands. Do not proceed while any real-seed mismatch remains.

- [ ] **Step 5: Run the local preflight a second time**

Run:

```bash
npm run canary:preflight
```

Expected: a second clean pass with no dependency on the prior workspace or journal and an unchanged source fingerprint.

- [ ] **Step 6: Commit the exact compatibility correction**

```bash
git add companion/Sources/RuntimeRaidersCore/InstallerMigrationValidation.swift companion/Tests/RuntimeRaidersCoreTests/InstallerMigrationValidationTests.swift tests/runtime-raiders-local-preflight.test.ts
git commit -m "fix: align migration with the sequence eight seed"
```

---

### Task 8: Add canonical frozen-candidate records and release mode

**Files:**
- Create: `scripts/test/runtime-raiders-preflight-record.mjs`
- Modify: `scripts/test/runtime-raiders-local-preflight.sh`
- Modify: `scripts/test/build-runtime-raiders-local-candidate.sh`
- Modify: `tests/runtime-raiders-local-preflight.test.ts`
- Modify: `tests/runtime-raiders-release-gates.test.ts`

**Interfaces:**
- `create --source-root ROOT --payload DIR --installer FILE --results FILE --output FILE` writes canonical schema version 1.
- `verify --source-root ROOT --preflight-directory DIR` exits zero only for a clean exact source and byte-identical payload/renderer inputs.
- `compare --first DIR --second DIR` requires identical release identity, payload tree, renderer source, and installer digests while permitting different timestamps.
- Release mode writes atomically beneath `dist/preflight/sequence-<sequence>-<sha>/`.

- [ ] **Step 1: Add failing record and dirty-source tests**

Use this exact canonical shape:

```ts
type PreflightRecordV1 = {
  schema_version: 1;
  source_sha: string;
  source_clean: true;
  release: {
    companion_version: string;
    release_sequence: number;
    update_protocol_version: 2;
  };
  payload: Array<{ path: string; mode: string; sha256: string }>;
  renderer_source_sha256: string;
  installer_sha256: string;
  seed_contract_version: 1;
  passes: Array<{
    name: 'release-pass-1' | 'release-pass-2';
    payload_tree_sha256: string;
    behavioral_result: 'passed';
  }>;
  created_at: string;
};
```

Test missing files, symlinks, unsafe modes, dirty Git, wrong HEAD, changed payload bytes, changed renderer, changed installer, duplicate paths, unsorted paths, extra keys, and a record above 1 MiB.

- [ ] **Step 2: Run focused record tests and observe the missing tool**

Run:

```bash
npx vitest run tests/runtime-raiders-local-preflight.test.ts tests/runtime-raiders-release-gates.test.ts -t 'preflight record|dirty source|payload binding'
```

Expected: failure because the record tool and release mode do not exist.

- [ ] **Step 3: Implement canonical create and verify commands**

Use `lstat`, no-follow regular-file checks, sorted relative paths, SHA-256, exact Git `HEAD`, and `git status --porcelain --untracked-files=all`. Reject any payload path outside the preflight directory and any entry other than a directory or single-link regular file.

Implement `compare` through the same strict decoder. Compare `source_sha`, `release`, `payload`, `renderer_source_sha256`, `installer_sha256`, and both pass digests; ignore only `created_at`.

- [ ] **Step 4: Implement two-pass release mode**

`--release` must:

1. require clean exact HEAD and valid `companion/RELEASE`;
2. build production unsigned payload pass 1 and run full local behavior with the paired preflight payload;
3. rebuild into an independent scratch root for pass 2 and run the full behavior again;
4. compare production pre-sign payload and renderer-input digests;
5. create the record only after both passes succeed; and
6. atomically rename one owner-only staging directory to `dist/preflight/sequence-<sequence>-<sha>`.

The production unsigned payload and final pre-rendered installer remain in that directory. Ad-hoc test copies and seed manifests do not.

- [ ] **Step 5: Run record tests and a disposable release-mode fixture**

Run:

```bash
npx vitest run tests/runtime-raiders-local-preflight.test.ts tests/runtime-raiders-release-gates.test.ts -t 'preflight record|release mode|payload binding'
```

Expected: all pass without Apple credentials.

- [ ] **Step 6: Commit release-mode binding**

```bash
git add scripts/test/runtime-raiders-preflight-record.mjs scripts/test/runtime-raiders-local-preflight.sh scripts/test/build-runtime-raiders-local-candidate.sh tests/runtime-raiders-local-preflight.test.ts tests/runtime-raiders-release-gates.test.ts
git commit -m "build: record tested unsigned companion payloads"
```

---

### Task 9: Require the accepted preflight payload before signing

**Files:**
- Modify: `scripts/release/build-runtime-raiders-agent.sh:1-390`
- Modify: `tests/companion-installer.test.ts`
- Modify: `tests/runtime-raiders-release-gates.test.ts`

**Interfaces:**
- New signed-build invocation: `build-runtime-raiders-agent.sh --preflight-directory DIR --release-sha SHA --output DIR`.
- The script verifies the record before reading signing/notary environment or invoking any Apple tool.
- It signs a copy of the recorded production payload; it never rebuilds Swift.

- [ ] **Step 1: Add failing early-rejection tests**

Add cases for a missing record, changed app byte, changed installer, stale SHA, preflight product string, and dirty source. Each fake command log must remain empty:

```ts
it('rejects a stale preflight payload before any Apple command', () => {
  const fixture = acceptedPreflightFixture();
  appendFileSync(fixture.agentExecutable, 'changed');
  const result = invokeSignedBuild(fixture);
  expect(result.status).not.toBe(0);
  expect(readFileSync(fixture.appleCommandLog, 'utf8')).toBe('');
});
```

Add a success fixture that proves the first payload mutation is a copy into the builder's owned temporary root, not the recorded payload.

- [ ] **Step 2: Run focused builder tests and observe current credential-first behavior**

Run:

```bash
npx vitest run tests/companion-installer.test.ts tests/runtime-raiders-release-gates.test.ts -t 'preflight payload before|stale preflight|does not rebuild Swift'
```

Expected: failures because the current builder checks credentials first and builds Swift itself.

- [ ] **Step 3: Verify preflight before the Apple boundary**

Parse `--preflight-directory`, canonicalize it, invoke:

```sh
node "$ROOT/scripts/test/runtime-raiders-preflight-record.mjs" verify \
  --source-root "$ROOT" \
  --preflight-directory "$PREFLIGHT_DIRECTORY"
```

Only after success require `RUNTIME_RAIDERS_CODESIGN_IDENTITY`, `RUNTIME_RAIDERS_NOTARY_PROFILE`, and `RUNTIME_RAIDERS_TEAM_ID`.

- [ ] **Step 4: Sign the exact recorded payload copy**

Copy `payload/Runtime Raiders Release` and the production validator into `$WORK`, re-verify their recorded digests, then run the existing Developer ID, notarization, staple, archive, checksum, manifest, and rendering steps. Require the final `install.sh` to match the pre-rendered installer from the accepted record byte-for-byte.

- [ ] **Step 5: Prove the builder cannot package preflight trust**

Before signing, recursively reject the strings `RRPREVIEW1`, `runtime-raiders-preflight-agent`, `runtime-raiders-preflight-launcher`, and `__runtime-raiders-preflight-validate-legacy` from product names, Info.plists, and printable executable strings. Keep the authoritative production-target tests from Tasks 2-4.

- [ ] **Step 6: Run all fake release-builder tests**

Run:

```bash
sh -n scripts/release/build-runtime-raiders-agent.sh
npx vitest run tests/companion-installer.test.ts tests/runtime-raiders-release-gates.test.ts -t 'release builder|preflight payload|Apple command|production products'
```

Expected: all pass using only faked Apple commands. Do not run the real signed builder.

- [ ] **Step 7: Commit the signing-boundary correction**

```bash
git add scripts/release/build-runtime-raiders-agent.sh tests/companion-installer.test.ts tests/runtime-raiders-release-gates.test.ts
git commit -m "build: sign only accepted preflight payloads"
```

---

### Task 10: Reduce Gate 2 to Apple trust, binding, and one smoke migration

**Files:**
- Modify: `scripts/test/verify-runtime-raiders-signed-release.sh:1-592`
- Modify: `scripts/test/runtime-raiders-behavioral-harness.sh`
- Modify: `tests/runtime-raiders-release-gates.test.ts`

**Interfaces:**
- New reviewer invocation: `verify-runtime-raiders-signed-release.sh QUARTET PREFLIGHT_DIRECTORY`.
- Gate 2 performs real trust and package checks, then calls the shared harness with `--mode smoke`.
- The full 16-boundary matrix remains exclusively in local preflight full mode.

- [ ] **Step 1: Add failing slim-Gate-2 tests**

Require the reviewer to verify the record and delegate smoke mode:

```ts
it('keeps the failure matrix in local preflight and only smoke-tests Gate 2', () => {
  const gate2 = readFileSync(signedReviewer, 'utf8');
  expect(gate2).toContain('runtime-raiders-preflight-record.mjs" verify');
  expect(gate2).toContain('runtime-raiders-behavioral-harness.sh" --mode smoke');
  expect(gate2).not.toContain('for boundary in archive-verification');
  const local = readFileSync(localBehavioralHarness, 'utf8');
  expect(local).toContain('for boundary in archive-verification');
});
```

Also test that wrong quartet, wrong record, wrong SHA, missing staple, wrong Team ID, wrong bundle, and installer mismatch fail before smoke mode.

- [ ] **Step 2: Run focused tests and observe the old full matrix in Gate 2**

Run:

```bash
npx vitest run tests/runtime-raiders-release-gates.test.ts -t 'failure matrix|smoke-tests Gate 2|wrong preflight record'
```

Expected: failure because Gate 2 still contains the migration loop and accepts one argument.

- [ ] **Step 3: Keep all real Apple checks and replace behavior with smoke mode**

Retain quartet ownership, manifest, clean reviewed SHA, deterministic installer, production validator rebuild, Developer ID requirement, architecture, Gatekeeper, Team ID, notarization, and staple checks. Verify the preflight record immediately after parsing release identity. Then invoke:

```sh
ORIGINAL_HOME="$(CDPATH= cd -- "${HOME:?}" && pwd -P)"
seed_manifest="$gate_root/sequence-eight-seed.json"
node "$ROOT/scripts/test/runtime-raiders-local-seed.mjs" inspect \
  --home "$ORIGINAL_HOME" \
  --output "$seed_manifest"
"$ROOT/scripts/test/runtime-raiders-behavioral-harness.sh" \
  --mode smoke \
  --quartet "$QUARTET" \
  --seed-manifest "$seed_manifest" \
  --seed-home "$ORIGINAL_HOME" \
  --work-root "$gate_root"
```

The reviewer still scrubs all signing and notary credentials before running any installer, launcher, or daemon child.

- [ ] **Step 4: Run reviewer contract and existing Gate 1 tests**

Run:

```bash
bash -n scripts/test/verify-runtime-raiders-signed-release.sh
npx vitest run tests/runtime-raiders-release-gates.test.ts
npm run canary:lifecycle-test
```

Expected: all pass without a real signed quartet or Apple call.

- [ ] **Step 5: Commit the Gate 2 reduction**

```bash
git add scripts/test/verify-runtime-raiders-signed-release.sh scripts/test/runtime-raiders-behavioral-harness.sh tests/runtime-raiders-release-gates.test.ts
git commit -m "test: make Gate 2 an Apple trust smoke gate"
```

---

### Task 11: Update the runbook and perform the complete local verification

**Files:**
- Modify: `docs/runtime-raiders-companion-release-gates.md`
- Modify: `docs/superpowers/specs/2026-08-14-runtime-raiders-local-compatibility-preflight-design.md`
- Modify: `package.json` only if Task 6 did not already add the final exact script.

**Interfaces:**
- Documents the everyday command, release mode, diagnostic retention, accepted-record location, revised signed builder, revised reviewer, and unchanged later authorization boundaries.

- [ ] **Step 1: Add failing documentation contract assertions**

Add to `tests/runtime-raiders-release-gates.test.ts`:

```ts
it('documents local preflight before Apple and keeps the Pi outside both gates', () => {
  const runbook = readFileSync(releaseGateRunbook, 'utf8');
  expect(runbook.indexOf('npm run canary:preflight')).toBeLessThan(runbook.indexOf('Developer ID'));
  expect(runbook).toContain('npm run canary:preflight -- --release');
  expect(runbook).toContain('--preflight-directory');
  expect(runbook).toContain('Gate 2 does not contact or change the Pi');
  expect(runbook).toContain('Collection remains off');
});
```

- [ ] **Step 2: Run the documentation test and observe stale runbook text**

Run:

```bash
npx vitest run tests/runtime-raiders-release-gates.test.ts -t 'documents local preflight before Apple'
```

Expected: failure because the current runbook starts at synthetic Gate 1 and describes the full matrix under Gate 2.

- [ ] **Step 3: Rewrite the runbook around the approved flow**

Document these commands in order:

```bash
npm run canary:preflight
npm run canary:preflight -- --release
release_sha="$(git rev-parse HEAD)"
release_sequence="$(sed -n 's/^release_sequence=//p' companion/RELEASE)"
preflight_directory="$PWD/dist/preflight/sequence-$release_sequence-$release_sha"
quartet_parent="$(mktemp -d /private/tmp/runtime-raiders-unpublished.XXXXXX)"
quartet="$quartet_parent/quartet"
RUNTIME_RAIDERS_CODESIGN_IDENTITY='Developer ID Application: Bryan Carpenter (6Y523M8EQK)' \
RUNTIME_RAIDERS_NOTARY_PROFILE='runtime-raiders-notary' \
RUNTIME_RAIDERS_TEAM_ID='6Y523M8EQK' \
  scripts/release/build-runtime-raiders-agent.sh \
    --preflight-directory "$preflight_directory" \
    --release-sha "$release_sha" \
    --output "$quartet"
scripts/test/verify-runtime-raiders-signed-release.sh \
  "$quartet" \
  "$preflight_directory"
```

State explicitly that only the third command needs Apple credentials and authorization, and none of the four commands touches the Pi or publishes artifacts.

- [ ] **Step 4: Run the full local suite from the committed implementation**

Run:

```bash
npm run typecheck
npm test
npm run canary:lifecycle-test
npm run canary:lifecycle-test
npm run canary:preflight
npm run canary:preflight
git diff --check
```

Expected: every command exits zero. Record exact Swift and Vitest totals from the output. Do not infer success from an earlier or partial run.

- [ ] **Step 5: Commit the runbook and final script contract**

```bash
git add docs/runtime-raiders-companion-release-gates.md docs/superpowers/specs/2026-08-14-runtime-raiders-local-compatibility-preflight-design.md package.json tests/runtime-raiders-release-gates.test.ts
git commit -m "docs: make local preflight the release entry gate"
```

- [ ] **Step 6: Run frozen-source release mode twice from the clean commit**

Run:

```bash
npm run canary:preflight -- --release
first_pass="$(mktemp -d /private/tmp/runtime-raiders-preflight-pass-1.XXXXXX)"
/bin/mv "dist/preflight/sequence-$(sed -n 's/^release_sequence=//p' companion/RELEASE)-$(git rev-parse HEAD)" "$first_pass/candidate"
npm run canary:preflight -- --release
node scripts/test/runtime-raiders-preflight-record.mjs compare \
  --first "$first_pass/candidate" \
  --second "dist/preflight/sequence-$(sed -n 's/^release_sequence=//p' companion/RELEASE)-$(git rev-parse HEAD)"
```

Expected: both release-mode passes succeed and `compare` confirms identical pre-sign payload, renderer-source, and installer digests. Timestamps may differ. The output remains local, ignored, owner-only, and unsigned.

- [ ] **Step 7: Final read-only audit**

Run:

```bash
git status --short
git log --oneline --decorate -12
find dist/preflight -maxdepth 3 -type f -print | LC_ALL=C sort
```

Expected: clean tracked worktree; only the expected ignored preflight output exists; no signed quartet, publication, Pi change, installation, collection, or activation occurred.

---

## Completion boundary

Completing this plan yields a green, real-seed-derived local compatibility gate and an unsigned frozen candidate record. It does **not** run Gate 2, sign or notarize anything, contact the Pi, publish artifacts, migrate the installed canary, enable collection, or activate the office. Those remain later explicit decisions after the local preflight implementation and evidence are reviewed.

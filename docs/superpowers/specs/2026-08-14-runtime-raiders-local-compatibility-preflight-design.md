# Runtime Raiders local compatibility preflight design

**Date:** 2026-08-14

**Status:** Approved

**Scope:** Move sequence-8 migration compatibility and transaction testing ahead
of Developer ID signing, Apple notarization, artifact publication, Pi access, and
installed-canary changes.

## 1. Context

The protocol-2 companion release has repeatedly passed the synthetic local gate
and then failed the unpublished signed-artifact gate for ordinary migration
compatibility reasons. The recent failures were different symptoms of the same
test-architecture gap:

- the temporary migration environment omitted the legacy command directory from
  `PATH`;
- the synthetic sequence-8 status response represented absent optional values
  differently from the real sequence-8 response; and
- the synthetic sequence-8 application used mode `0755`, while the real
  installed application uses mode `0700`.

None of these failures depended on Developer ID signing, Apple notarization, or
the Pi. They appeared late because Gate 1 independently constructed an
approximation of sequence 8, while Gate 2 was the first gate to copy and execute
the real installed-off sequence-8 application.

Signing and notarization must become final trust and packaging checks. They must
not remain the discovery mechanism for installer behavior, legacy-layout
compatibility, or rollback correctness.

## 2. Goals

- Provide one local command, `npm run canary:preflight`, that exercises the real
  sequence-8-to-protocol-2 migration without Developer ID credentials,
  notarization, network access, Pi access, publication, or installed-companion
  mutation.
- Use the installed-off sequence-8 canary as a read-only compatibility reference
  for application bytes, release identity, filesystem structure, modes, public
  configuration, and content-free status behavior.
- Run the successful migration and every injected migration failure boundary in
  an owner-only temporary home.
- Reuse the installer, launcher, daemon, migration, rollback, and release logic
  that will ship, while replacing only Apple trust evaluation at an explicit
  test-only dependency boundary.
- Report the exact local validation reason instead of collapsing every
  development failure into `invalidLegacyInstallation`.
- Bind the final clean-source preflight to the payload that Gate 2 later signs.
- Keep the Pi and all public or installed release state outside both routine
  development and pre-notarization compatibility testing.

## 3. Non-goals

- Weakening Developer ID, Team ID, hardened-runtime, architecture, secure
  timestamp, Gatekeeper, notarization, or staple requirements for a published
  artifact.
- Adding a production environment variable or command-line flag that bypasses
  trust checks.
- Reading real enrollment secrets, provider records, message content, collector
  state contents, outbox contents, or activity data.
- Mutating, stopping, booting out, replacing, upgrading, or enabling the real
  sequence-8 companion.
- Contacting or changing the Pi, Caddy, DNS, public artifact selector, or game
  service.
- Replacing the complete Swift and Vitest suites. The new preflight runs before
  those broader suites and complements them.
- Removing the short signed-artifact smoke check from Gate 2.

## 4. Approaches considered

### A. Real-seed local behavioral candidate -- selected

Build a local candidate without Developer ID credentials, recreate the real
legacy layout in a temporary home, and run the complete behavioral Gate 2 matrix
there. A test-only trust adapter replaces only Apple trust facts. The production
trust path remains unchanged and is exercised later by Gate 2.

This approach catches the known compatibility class early while retaining a
strong boundary between behavior and Apple trust.

### B. Read-only legacy validator only

Run the current migration validator directly against the installed sequence-8
layout. This is fast and would catch status, path, and mode mismatches, but it
does not exercise installer rendering, launch ordering, durable transitions,
crash recovery, or rollback fingerprints. It is useful as the first stage of
the selected approach but is insufficient by itself.

### C. Fake Apple command-line tools inside Gate 2

Replace `codesign`, `spctl`, `stapler`, and `notarytool` with shell fakes and run
the current signed-release harness. This reuses the most shell code, but it
mixes security simulation with transaction testing, depends on command
interposition details, and risks accidentally testing a path that production
does not use. It is rejected in favor of an explicit trust dependency boundary.

## 5. Gate model

The release flow becomes:

1. **Local compatibility preflight:** real-seed compatibility, local candidate,
   migration, rollback, safety, and broader local tests. No external effects or
   signing credentials.
2. **Gate 2, Apple trust and packaging:** Developer ID signing, notarization,
   stapling, final archive validation, and one bounded signed smoke check.
3. **Later explicit gates:** publication, Pi or Caddy changes, installed-off
   migration canary, normal protocol-2 update canary, collection, and office
   activation.

Passing a stage only permits review of the next stage. It does not authorize the
next stage.

## 6. Real-seed inspector

The preflight begins with a read-only inspector. It resolves the expected
sequence-8 paths beneath the current user's home and rejects symlinks or unsafe
ownership at boundaries that must be directories or regular files.

The allowlisted source surface is:

- `Runtime Raiders Agent.app`, including its signed code, resources, file modes,
  ownership, and relevant extended attributes;
- `com.redlattice.runtime-raiders-agent.plist`;
- the Runtime Raiders command shim;
- the command-link record and command symlink;
- the support, state, outbox, LaunchAgents, `.local`, and `.local/bin` directory
  types and modes;
- presence and metadata for Runtime Raiders-owned PATH marker state plus only the
  exact Runtime Raiders marker line from the relevant profile; and
- the public, content-free `status` response returned by the exact sequence-8
  executable.

The inspector must not read the contents of enrollment, collector state,
provider files, outbox entries, Run records, or diagnostics. The temporary
fixture receives synthetic values for all such data.

The inspector emits a normalized, owner-only compatibility description in its
temporary workspace. Absolute home paths in the plist, shim, command-link
record, command symlink, and status-launch context are represented as typed path
fields rather than copied as arbitrary text.

The source surface is fingerprinted before and after the complete preflight.
The two fingerprints must match. The fingerprint includes no-follow file type,
mode, owner, device and inode where meaningful, size, digest for allowlisted
public files, and relevant extended attributes. A mismatch is a hard safety
failure.

## 7. Temporary legacy clone

The harness creates a short, owner-only temporary root to remain below Darwin's
Unix-domain socket path limit. It recreates the legacy installation as follows:

1. Copy the real sequence-8 application with a metadata-preserving tool. Do not
   normalize modes such as the observed application-root `0700`.
2. Translate only the typed home-dependent paths into the temporary home.
3. Recreate the plist, shim, command-link record, command symlink, and Runtime
   Raiders PATH marker using the captured structure and translated paths.
4. Create synthetic enrollment, disabled collector state, outbox, rollback,
   diagnostic, failed-candidate, and update-workspace fixtures.
5. Start the copied legacy application only inside the temporary environment,
   with collection disabled, fake external commands, fake launchd, denied
   network access, and no route to the real support directory.

The copied legacy application may execute because it is the compatibility
subject. It receives only synthetic local state and cannot read provider records
or real activity.

## 8. Local candidate and trust separation

The preflight build produces the current agent, launcher, release container,
archive, update metadata, and rendered installer without using a Developer ID
identity or notary credentials. Executable test copies may receive ad-hoc
signatures where macOS requires a code signature for local execution.

Apple trust evaluation is replaced only at a test-specific compiled dependency
boundary. Add two test-only executable targets: one for the agent and one for
the launcher. Each target invokes the same production composition entry point
as its release counterpart but supplies an in-process preflight trust inspector.
The temporary app builder places those executable outputs under the normal
bundle executable names. The release builder accepts only the production target
outputs.

The dependency rules are:

- production code continues to use `SignedBundleTrustInspector` and the real
  Apple tools;
- the two preflight targets inject explicit local `CandidateSignatureFacts`
  into the same core validators;
- the trust adapter is not included in the production application products or
  public archive; and
- the production installer and agent do not recognize a runtime environment
  variable, preference, file, or command-line switch that disables trust.

The build and tests must prove that the production release products contain no
preflight trust-adapter route. Gate 2 then independently exercises the real
trust inspector against the final signed applications.

All non-trust behavior uses the same production core implementation. Dependency
selection happens while constructing the executable and is not read from the
environment, arguments, preferences, or filesystem. The installer renderer and
shell transaction remain shared; only the temporary bundle's executable bytes
differ. The public renderer always packages the production executables.

## 9. Shared behavioral harness

The migration, launcher, process, and rollback portions of the current Gate 2
harness become a reusable behavioral harness. Artifact-specific trust checks are
provided by an adapter:

- the local-preflight adapter validates structure and injects test trust facts;
- the Gate 2 adapter invokes real Developer ID, Gatekeeper, notarization, and
  staple validation.

The shared harness covers:

- one successful flat sequence-8-to-versioned migration;
- every installer failure checkpoint from archive verification through prepared
  health and resume;
- precommit rollback and postcommit convergence;
- exact protected-surface fingerprints across each injected failure;
- legacy status-wire decoding, including absent and explicit-null optionals;
- actual legacy application, directory, executable, plist, shim, command-link,
  symlink, profile-marker, and PATH behavior;
- existing enrollment reuse using a synthetic enrollment;
- disabled collection intent, zero active Runs, and expected empty queued-event
  state;
- stable launcher active, fallback, trial, missing, malformed, unsafe, symlink,
  and identity-mismatch behavior;
- bounded process identity, termination, and cleanup; and
- denial of real network, launchd, support-directory, provider-record, and Pi
  access.

Each case begins from a fresh temporary clone. No case may depend on cleanup or
state left by a prior case.

## 10. Diagnostic model

`LegacySequenceEightInstallationValidator` and adjacent migration validation
code gain internal typed findings. Examples include:

```text
legacy.app.mode
legacy.status.missing-key
legacy.status.invalid-type
legacy.command.path-not-visible
legacy.plist.content-mismatch
migration.rollback.plist-mismatch
migration.postcommit.active-identity-mismatch
```

Each finding carries bounded expected and observed metadata appropriate for a
content-free test report. It must not include enrollment values, provider data,
message content, arbitrary file contents, or unbounded command output.

The public installer continues mapping these findings to its generic fail-closed
error. The local preflight prints the specific reason, failing checkpoint, and
owned diagnostic-directory path.

Diagnostic directories are mode `0700`. Successful runs remove their temporary
trees. Failed runs preserve one bounded directory for investigation and print a
command that removes that exact directory when it is no longer needed.

## 11. Command modes and execution order

The routine command is:

```sh
npm run canary:preflight
```

Development mode may run from a dirty worktree. Its report records the current
HEAD plus the dirty state and cannot be used to authorize Gate 2.

The frozen release mode is:

```sh
npm run canary:preflight -- --release
```

Release mode requires a clean worktree, a valid `companion/RELEASE`, and an exact
HEAD-derived release SHA. It records the payload and renderer inputs consumed by
the later signing build.

Both modes stop at the first failure and run in this order:

1. shell syntax and real-seed structural/status audit;
2. local deterministic build and package-layout audit;
3. one successful migration;
4. the complete injected-failure matrix;
5. source-fingerprint and external-boundary safety proofs; and
6. the existing broader Gate 1 Swift and Vitest suites.

Every child process and socket wait has a bounded timeout. Cleanup is bounded
and signals only a process whose exact PID, executable identity, arguments, and
start identity were recorded by the owned harness.

## 12. Frozen-candidate binding

Release-mode preflight emits an owner-only, untracked candidate record beneath
`dist/preflight/sequence-<sequence>-<sha>/`. It contains:

- release version, sequence, protocol, and exact source SHA;
- a clean-worktree assertion;
- deterministic pre-sign payload digests;
- the installer-renderer source digest and all non-signature render inputs;
- local archive-layout and behavioral-harness results;
- real-seed compatibility fingerprint version, not private seed contents;
- test totals and timestamps; and
- the format version of the preflight record.

An executable test copy may be ad-hoc signed, but Gate 2 signs a fresh copy of
the exact recorded pre-sign payload. If Gate 2 rebuilds instead, the new
pre-sign payload must reproduce the recorded digests byte-for-byte.

Developer ID signing changes signature material and therefore the final archive
digest. Gate 2 supplies those post-sign values through the same deterministic
renderer. The preflight binds the installer program, renderer, release identity,
and all non-signature inputs; Gate 2 independently verifies the final signed
rendering and archive digest.

Any source, payload, renderer, release metadata, or preflight-record mismatch
invalidates the record and requires another local release-mode preflight. A
routine dirty-worktree preflight never creates an acceptable release record.

## 13. Revised Gate 2

Gate 2 retains only work that requires or validates the real Apple artifact:

- require the clean exact SHA and matching release-mode preflight record;
- sign the exact recorded agent and launcher payloads with the approved
  Developer ID identity;
- submit for notarization, staple, and validate both applications;
- verify Team ID, bundle identifiers, hardened runtime, secure timestamp,
  required architectures, nested code, Gatekeeper assessment, and staples;
- verify final archive structure, digest, update manifest, checksum, and rendered
  installer;
- prove the production products contain no preflight trust adapter; and
- run one bounded signed-artifact happy-path smoke check in a temporary home.

Gate 2 does not rerun the full migration failure matrix. If its short smoke check
finds an ordinary non-trust behavioral mismatch, that is treated as a defect in
the preflight binding or harness and must be repaired before another signing
attempt.

Gate 2 remains local and unpublished. Passing it does not authorize publication,
Pi access, installation, collection, or activation.

## 14. Test strategy

### Unit tests

- allowlist and no-follow behavior for every real-seed surface;
- home-path normalization and temporary-path rendering;
- internal validation finding for every legacy-validation branch;
- bounded diagnostic redaction;
- preflight-record encoding, versioning, digest comparison, dirty-source
  rejection, and mismatch rejection;
- production-build rejection of any preflight trust adapter; and
- timeout and exact-process cleanup behavior.

### Contract tests

- capture the exact content-free sequence-8 status shape and prove omitted and
  explicit-null optional values are handled according to the legacy contract;
- preserve the actual sequence-8 application-root mode rather than normalizing
  it in a synthetic fixture;
- include the real command directory in the temporary PATH; and
- validate canonical path translation for plist, shim, command record, command
  symlink, and profile marker.

### Integration tests

- local happy migration from the real-seed clone;
- every existing migration failure checkpoint;
- stable-launcher scenarios currently exercised only after signing;
- exact before/after fingerprints for rollback cases;
- source fingerprint unchanged after both successful and failed preflight runs;
- sandbox probes for network, real launchd, real support-root, provider-record,
  and Pi denial; and
- two consecutive clean release-mode preflight passes without reliance on prior
  workspaces or journals.

### Historical regression tests

At minimum, the three recent late Gate 2 failures become named tests:

- legacy command directory present in PATH;
- sequence-8 status optional-field wire compatibility; and
- real sequence-8 application-root mode compatibility.

Each test must be observed failing for its intended reason against the current
implementation before the compatibility correction is made.

## 15. Failure handling

- A seed-audit failure stops before compilation.
- A local-build failure stops before any migration process starts.
- A happy-path failure stops before the full crash matrix.
- A crash-matrix failure reports the exact boundary and pre/post fingerprint
  difference.
- A safety-proof failure is always fatal, even if behavioral tests passed.
- A missing real sequence-8 seed is a clear hard failure in release mode; it may
  not silently fall back to a synthetic fixture.
- Development environments without the real seed may still run the synthetic
  Gate 1 suite, but they cannot produce a release-mode preflight record.
- Any unbounded output is truncated to a documented limit while the full owned
  diagnostic file remains bounded on disk.

## 16. Acceptance criteria

Implementation is complete when:

- `npm run canary:preflight` performs the complete local flow without signing
  credentials, network, Pi access, installed-app mutation, collection, or
  activation;
- the current real-seed `0700` mismatch is reproduced before its policy is
  corrected;
- the PATH, status-wire, and application-mode regressions all have named tests;
- one successful migration and every injected failure checkpoint pass against a
  real-seed-derived temporary clone;
- source fingerprints prove the installed sequence-8 surface is unchanged;
- all test processes and temporary resources terminate within bounded limits;
- detailed local reason codes remain content-free while the public installer
  stays generic and fail-closed;
- two consecutive clean `--release` preflight runs reproduce the same pre-sign
  payload and renderer-input digests;
- the complete existing Gate 1 suite remains green;
- Gate 2 refuses a missing, dirty, stale, or digest-mismatched preflight record;
  and
- Gate 2 is reduced to Apple trust, final packaging, binding verification, and a
  short signed smoke check.

## 17. Authorization boundaries

Once implementation is approved, read-only seed inspection, local source edits,
local builds, ad-hoc signing, temporary-home tests, crash injection, and
owner-only local diagnostic output are ordinary development actions. They do
not require per-command release ceremony.

The following remain separate explicit authorization boundaries:

1. Developer ID signing and Apple notarization;
2. public artifact publication or withdrawal;
3. Pi checkout, service, or Caddy changes;
4. installed-canary migration or update;
5. `raiders on` or any collection; and
6. office activation.

No local test, design approval, implementation commit, preflight record, or Gate
2 result implicitly authorizes any later boundary.

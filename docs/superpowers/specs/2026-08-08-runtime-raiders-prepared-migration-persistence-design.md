# Runtime Raiders Prepared Migration Persistence Design

Status: approved for implementation design on 2026-08-08. This document does not authorize a release, artifact publication, companion update, collection, canary activation, or office activation.

## Problem

Sequence 7 introduced version-2 Codex adapter snapshots. When its daemon was bootstrapped in the updater's prepared state, `AgentController` loaded version-1 snapshots, migrated them in memory, and immediately persisted the migrated collector state from its initializer.

The updater intentionally freezes enrollment, collector state, and outbox bytes until candidate health is accepted. It therefore treated the initializer write as an unsafe protected-state mutation and began rollback. The restored sequence-6 daemon could not read the already-persisted version-2 snapshots, so automatic recovery ended in terminal safety failure.

The missing test boundary is between candidate daemon construction and the prepared-startup coordinator. Migration tests currently prove that legacy snapshots are reseeded correctly, while updater tests prove strict byte preservation, but no test proves that constructing a prepared candidate leaves the protected state unchanged.

## Selected design

Keep the updater's strict frozen-state checks unchanged. Change migration persistence at its source:

1. `AgentController` loads and validates persisted state.
2. It migrates supported legacy adapter snapshots in memory and marks them for reseeding.
3. Construction does not persist solely because a migration occurred.
4. A normal daemon startup immediately runs the existing provider-file installation step, which persists the prepared state through the existing atomic state writer.
5. A prepared daemon defers that installation step while the updater holds the prepared-startup lease. Candidate bootstrap and health verification therefore observe the migrated in-memory state while the on-disk state remains byte-identical.
6. After candidate health succeeds, the updater sends the existing resume command. The deferred installation step then persists the migrated state normally.

If candidate bootstrap or health verification fails before resume, rollback sees the original on-disk state and the prior daemon can read it. No migration-aware exception is added to the updater, and no state file is copied, restored, or rewritten by rollback.

## Component boundaries

### `AgentController`

`AgentController` remains responsible for recognizing supported legacy snapshots and preparing their safe reseed state. Its initializer may mutate only its in-memory `PersistedState` representation. Existing atomic persistence remains owned by the controller's normal installation and collection operations.

A missing collector-state file remains different from a migration: the initializer must still create and persist the initial disabled state so the daemon has a valid durable starting point.

### Prepared startup

`PreparedDaemonStartupCoordinator` remains responsible for withholding provider discovery, controller installation, uploader scheduling, heartbeat activation, and watcher activation until the updater releases the daemon. Its lock protocol and control commands do not change.

### Updater

`CompanionUpdater` continues to require exact protected-state byte preservation through candidate bootstrap and prepared health verification. Its bundle swap, rollback, terminal recovery, signing checks, and health rules do not change.

## Failure behavior

- Invalid or unsupported persisted state still fails closed during controller construction without writing replacement state.
- A supported legacy snapshot may be transformed only in memory before candidate health acceptance.
- A candidate failure before resume leaves enrollment, collector state, and existing outbox entries byte-identical.
- The prior bundle remains capable of reading its original state after rollback.
- State persistence after a successful resume continues to use the existing owner-only atomic writer.
- Collection intent is preserved. Prepared startup does not collect, upload, watch provider files, or emit Raid Power before resume.

## Tests

Use test-driven development and first add a regression that fails against sequence 7's current initializer behavior.

1. Extend the legacy-snapshot controller test to capture collector-state bytes before constructing the upgraded controller. Assert that construction prepares reseeding in memory but leaves the file byte-identical.
2. Assert that the existing installation step persists version-2 snapshots and resets legacy cursor and ordinal state only after installation is invoked.
3. Add a prepared-update boundary test using a real legacy collector-state fixture. Candidate construction and prepared health must preserve the frozen bytes; resume must persist the migration and complete the update.
4. Add or retain a failed-candidate case proving that rollback receives the original version-1 bytes and can restart the prior identity.
5. Run the focused controller and updater suites, then the complete Swift package suite and repository verification commands.

The regression must be observed failing for protected-state mutation before production code changes, then passing after the minimal implementation.

## Scope exclusions

- No relaxed semantic comparison of protected state.
- No protected-state backup or restore subsystem.
- No snapshot-format downgrade support in older companions.
- No change to scoring, provider parsing, telemetry, enrollment, or server APIs.
- No release-number change, signing, notarization, artifact publication, installation, canary activation, collection, or office activation.

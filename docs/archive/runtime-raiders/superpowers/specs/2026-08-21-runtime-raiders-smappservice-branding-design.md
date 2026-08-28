# Runtime Raiders managed background service design

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

Date: 2026-08-21

Status: approved for implementation planning

## Outcome

Runtime Raiders remains a command-line employee tool installed under the
user's Application Support directory. macOS must show its background activity
under **Runtime Raiders** (or the OS-rendered **Runtime Raiders.app**), with the
Runtime Raiders icon, rather than grouping it under **Bryan Carpenter**. Bryan
Carpenter may remain the developer name.

The acceptance test is the actual System Settings UI on a signed installed-off
canary. Metadata alone is not proof.

## Why 0.4.2 failed

Versions through 0.4.2 copy a legacy property list into
`~/Library/LaunchAgents`. Version 0.4.2 registered the app with Launch Services
before bootstrapping that property list, but macOS still created this visible
relationship:

- service name: `Runtime Raiders`
- developer name: `Bryan Carpenter`
- parent identifier: `Bryan Carpenter`
- visible App Background Activity row: `Bryan Carpenter`

Apple documents `SMAppService` as the replacement for copying LaunchAgent
property lists into shared directories. An agent embedded in an app bundle is
automatically associated with that app in Login Items. Apple's sample also
uses a GUI-less container app installed in Application Support, so this design
does not require `/Applications` or a user-facing GUI.

References:

- [Updating helper executables from earlier versions of macOS](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)
- [Updating your app package installer to use the new Service Management API](https://developer.apple.com/documentation/servicemanagement/updating-your-app-package-installer-to-use-the-new-service-management-api)
- [`SMAppService`](https://developer.apple.com/documentation/servicemanagement/smappservice)

## Bundle and identities

The signed release remains one app:

```text
Runtime Raiders.app/
  Contents/
    Info.plist
    MacOS/runtime-raiders-agent
    Resources/RuntimeRaiders.icns
    Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist
```

Use distinct identities so macOS cannot reuse the stale legacy relationship:

- parent app bundle identifier: `com.redlattice.runtime-raiders`
- managed agent label: `com.redlattice.runtime-raiders.agent`
- retired legacy label: `com.redlattice.runtime-raiders-agent`

The embedded agent property list uses `BundleProgram` to launch the same signed
binary in `daemon` mode. It retains the existing keep-alive and background
process behavior. The employee command remains `raiders`; the installed app
remains at:

```text
~/Library/Application Support/Runtime Raiders/Runtime Raiders.app
```

## Registration interface

The installed executable exposes private, exact-path-only commands for managed
agent registration, unregistration, and status. Their implementation uses
`SMAppService.agent(plistName:)` from inside the signed parent app.

Normal employees do not see or run these commands. The public commands remain:

```text
raiders status
raiders on
raiders off
raiders update
raiders doctor
```

The signed-release verifier keeps its existing isolated mode. In that mode the
private registration lifecycle is validated without modifying the real Mac's
Service Management or Background Task Management state.

## Transactional installation

The 0.4.3 installer performs one transaction:

1. Download and validate the notarized one-app archive.
2. Confirm collection is off and record whether the existing service is the
   legacy 0.4.2 form or the new managed form.
3. Stop the existing service and back up the app, legacy property list, command
   shim, and registration form.
4. Place the new signed app at its final Application Support path.
5. Remove the retired legacy property list from its stable path.
6. Register the embedded managed agent with `SMAppService`.
7. Require managed status `enabled`, a running daemon, installed version 0.4.3,
   and `raiders status` showing collection disabled.
8. Commit the transaction and discard only the transaction's backups.

For later managed updates, the installer unregisters the old managed agent
before replacing the app and re-registers after replacement, as Apple
recommends when an executable changes.

If any step fails, rollback unregisters the new managed agent, restores the
prior app, property list, and shim, restarts the prior legacy or managed
service using its original mechanism, and proves the restored installation is
disabled. If rollback cannot prove restoration, it preserves recovery material
and tells the user not to retry.

The installer must never reset the global Background Task Management database.

## Verification

Automated tests must prove:

- the release contains exactly one app with the embedded LaunchAgent property
  list and distinct parent/agent identifiers;
- the embedded property list uses `BundleProgram` and starts daemon mode;
- the installer no longer creates the retired property list on a fresh install;
- 0.4.2 legacy migration, managed reinstall, every registration failure, every
  replacement failure, and rollback all preserve an installed-off state;
- private registration routes reject the wrong executable and are inert in the
  signed verifier's isolated environment;
- the full Swift and Node suites remain green.

The signed 0.4.3 canary passes only when all of the following are observed on
the real Mac:

- System Settings shows exactly one Runtime Raiders background item;
- the visible name is **Runtime Raiders** or **Runtime Raiders.app**, not Bryan
  Carpenter;
- the Runtime Raiders icon is visible;
- the first notification for the fresh managed identifier attributes the
  background activity to Runtime Raiders rather than Bryan Carpenter;
- the Background Task Management record associates the managed agent with the
  Runtime Raiders parent app;
- the retired legacy property list is absent;
- `raiders status` reports version 0.4.3, daemon running, collection disabled,
  zero active Runs, and zero queued events.

If System Settings needs a normal refresh, logout, or restart to display the
new managed record, record that fact. Do not use `sfltool resetbtm` to force the
result.

## Non-goals and release boundaries

This change does not add an app to `/Applications`, a GUI, an updater, canary
tiers, sequence machinery, database changes, new telemetry, or server changes.
It does not enable collection.

Implementation, Apple signing/notarization, publication, local installation,
and live activation remain separate approvals. The stale release-publisher
hostname default is a separate operator-tool repair and is not part of the
background-service implementation.

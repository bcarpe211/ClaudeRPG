# Employee beta 0.4.5 and 0.4.6 results

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**

This historical release narrative was removed from the active employee runbook.
It is evidence only; use the active [employee beta procedure](../../../runtime-raiders/employee-beta.md)
and immutable [0.4.9 evidence](../../../runtime-raiders/releases/0.4.9.md).

## Employee beta result — GO (2026-08-23)

- Version `0.4.5` was built and published from Git SHA
  `1e1f01540e924ec723b10e7ecec9aec1b5f8bb8f` as one signed app. Apple
  notarization, stapling, designated-requirement validation, and Gatekeeper
  acceptance passed.
- The repeatable local canary installed the exact prepared ZIP before
  publication. The managed service registered successfully, the daemon ran
  with collection disabled, and status reported zero active Runs and queued
  events.
- The public installer and ZIP matched the locally proven release byte for byte.
  `/version` returned `0.4.5`; required no-store, content-type, and nosniff
  headers passed.
- System Settings → Login Items showed **Runtime Raiders.app**. Bryan Carpenter
  remains acceptable as the Apple developer attribution, not the product name.
- The public registration page and installer both returned HTTP 200. New
  employees create a Raider; existing employees sign in with their Raider Key.
  Both flows issue a separate one-time 10-minute enrollment code, and the
  public installer now explains both paths before its private prompt. No
  administrator-generated batch of codes is required.
- The earlier live acceptance gate scanned 858 existing provider-history
  records, uploaded no history, scored exactly one synthetic completion as one
  Run, and turned collection off. The `0.4.5` release changed only release
  identity and first-install guidance, not scoring or telemetry behavior.
- Final verification passed 2,057 Node tests and 219 Swift tests. Employee
  installation is **GO**. Installation and publication do not enable collection;
  each employee explicitly starts it with `raiders on`.

## Employee beta patch 0.4.6 (2026-08-24)

- The first employee attempt exposed a real fresh-install blocker: current
  macOS provides `stty` at `/bin/stty`, while the public `0.4.5` installer used
  nonexistent `/usr/bin/stty` for its private enrollment-code prompt.
- Patch `0.4.6` at Git SHA
  `886ac4036927c5375b418494f96a30460da2dd76` uses `/bin/stty` for capture,
  echo suppression, and terminal restoration. A regression runs the private
  prompt through that exact path.
- The repeatable local canary signed, notarized, stapled, verified, and installed
  the exact `0.4.6` ZIP. Status proved the managed daemon running with collection
  disabled, zero active Runs, and zero queued events before publication.
- The public installer, ZIP, and version checks passed; `/version` returns
  `0.4.6`. Publication left employee collection off.
- The game server was fast-forwarded while paused with its updater held. New and
  existing Raider enrollment now display only
  `curl -fsSL https://raiders.redlattice.com/install.sh | sh`, not the retired
  long-form wrapper.
- Direct office-network verification proved `raiders.local` resolution, trusted
  SSH login, Avahi activity, mDNS and loopback health, and the loopback TV route.
  The internal IP is intentionally not retained here.
- Verification passed 2,058 Node tests, the 225-case installer transaction
  suite, TypeScript type checking, and both `/bin/sh` and `/bin/zsh` parsers.

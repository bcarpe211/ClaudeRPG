# Employee beta 0.4.5 and 0.4.6 results

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**

This historical release narrative was removed from the active employee runbook.
It is evidence only; use the active [employee beta procedure](../../../runtime-raiders/employee-beta.md)
and immutable [0.4.9 evidence](../../../runtime-raiders/releases/0.4.9.md).

## 0.4.5 — 2026-08-23

Release `0.4.5` was built and published from
`1e1f01540e924ec723b10e7ecec9aec1b5f8bb8f`. Apple notarization, stapling,
designated-requirement validation, and Gatekeeper acceptance passed. The local
canary had a running managed daemon, disabled collection, zero active Runs, and
zero queued events. Public installer/ZIP bytes and no-store/content-type/nosniff
checks passed. The acceptance gate scanned 858 existing provider-history records,
uploaded no history, scored one synthetic completion as one Run, and turned
collection off. Final verification reported 2,057 Node tests and 219 Swift tests.

## 0.4.6 — 2026-08-24

Patch `0.4.6` at `886ac4036927c5375b418494f96a30460da2dd76` corrected the
private enrollment prompt's `stty` path from `/usr/bin/stty` to `/bin/stty`.
The repeatable local canary completed Apple trust checks and kept collection
disabled with zero active Runs and queued events. Public installer, ZIP, and
version checks passed. The paused server update retained the one-line installer.
Verification reported 2,058 Node tests, the 225-case installer transaction suite,
TypeScript type checking, and `/bin/sh` and `/bin/zsh` parsing.

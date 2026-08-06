# Task 9 report — Runtime Raiders manual-update release gates

## RED

Updated `tests/runtime-raiders-publication-docs.test.ts` before the runbooks.
The first focused run failed 7 of 13 assertions, honestly exposing the old
three-file/three-route language, missing fourth digest/manifest options,
missing sequence-2/manual-update approval gates, the old routine-install
contract, and the absent two-sequence canary record.

## GREEN

The documentation now distinguishes three non-interchangeable lifecycles:

1. Routine new office players use the fixed-origin one-line installer only
   after every rollout gate and separate office authorization.
2. The sequence-1 installed-off canary downloads the installer locally,
   verifies the recorded installer digest, then executes only that local file.
3. Already-installed players use only `raiders update`; no installer, ZIP, or
   manifest is piped or executed.

It documents the signed quartet and all four public routes/digests, tracked
`companion/RELEASE`, v1 recovery plus v2 monotonic/withdrawal behavior, manifest
headers, anonymous off-state static discovery, separated approval boundaries,
and the exact pending 12-step two-sequence record. The new canary document is
aggregate-only and requires `raiders off` before a distinct office request.

## Tests

```text
npm test -- tests/runtime-raiders-publication-docs.test.ts → PASS (13 tests)
npm test -- tests/runtime-raiders-publication-docs.test.ts tests/brand-copy.test.ts tests/provider-shape-audit.test.ts → PASS (35 tests)
git diff --check → PASS
```

The combined suite needed the approved local-loopback execution context because
the sandbox denies Supertest's listener with `EPERM`; the rerun made no network
request and passed.

## Self-review

- Confirmed no stale triplet/three-route terminology remains in the Task 9
  operational documents.
- Confirmed all live signing, Caddy, publication, installation, provider, and
  office actions remain pending—not evidence marked complete.
- Confirmed docs say only Codex Desktop and CLI are official roots; model and
  effort are display-only, while Raid Power is the score.

## Concerns

No implementation or production action was performed. The live canary, signing,
publication, and office evidence is intentionally still pending and must be
recorded outside Git at each separately approved gate.

## Fix Round 1

### RED

Extended the documentation contract first. The old docs failed on missing
fail-fast isolated blocks, stale Pi onboarding/lifecycle order, and missing
clean-build, cadence, no-reselection, approval, and recovery evidence.

### GREEN

Publication, download/header/digest, withdrawal, and controlled-canary snippets
now use self-contained `set -eu` subshells; secret/temp blocks retain local
`umask` and traps. Primary cutover and Pi onboarding now require the complete
sequence through `raiders off` before office activation and routine onboarding.
The two-sequence record adds the clean Task 7 build command, the exact Task 6
launchd restart target after the 24-hour due boundary, status/doctor evidence,
terminal recovery command rule, and v2 consumed-sequence recovery rule.

### Tests and concerns

`npm test -- tests/runtime-raiders-publication-docs.test.ts` passed 16/16 and
`git diff --check` passed. No live signing, Caddy, publication, provider,
install, or office action occurred; all evidence remains pending.

## Fix Round 2

### RED

Added a structural documentation contract for the real owner-only update state:
the prior cadence prose failed because it offered no validated timestamp source,
computed due time, pre-due refusal, or enforced restart ordering.

### GREEN

The pending off-state canary block now reads only
`~/Library/Application Support/Runtime Raiders/state/update-state.json`, rejects
nonregular/symlinked or non-owner-`0600` state, extracts and bounds only the
numeric `lastCheckAttemptMS`, prints the derived UTC due time, refuses an early
restart, then runs the fixed launchd target followed by status and doctor. It
never prints the state file or adds a CLI field.

### Tests and concerns

The focused docs suite passed 17/17. This is documentation-only and no state,
launchd, network, installation, or provider action was performed. The current
controller-owned `.superpowers` progress ledger remains deliberately unstaged.

## Fix Round 3

### Contract strengthening

Expanded the cadence test from phrase presence plus three partial comparisons
to one exact ordered shell contract. It now locks down strict mode, state path,
regular/nonsymlink/owner-`0600` validation, exact `plutil` extraction, numeric
rejection and both bounds, exact due/current-time arithmetic, UTC output,
pre-due refusal, fixed launchd target, and status-before-doctor ordering.

The accepted canary block already matched the full requested contract, so a
natural RED against the document was not available without introducing a fake
requirement. Instead, the test includes two mutation witnesses and proves it
rejects removed nonsymlink validation and swapped status/doctor order.

### Tests and concerns

The focused documentation suite passed 17/17 with no runbook change. This round
is test/report-only; no live action occurred and the controller-owned
`.superpowers` ledger remains excluded.

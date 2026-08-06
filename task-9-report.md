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

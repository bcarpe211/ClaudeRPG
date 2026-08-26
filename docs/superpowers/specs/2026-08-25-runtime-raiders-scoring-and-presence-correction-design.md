# Runtime Raiders scoring and presence correction design

**Status:** Approved product direction; implementation and production activation
remain separately gated.

## Goal

Correct Raid Power for newly started Runs by treating Codex usage breakdowns as
nested counters, make the player page describe those counters honestly, and make
dungeon presence respond to fresh accepted Run activity without awarding points.

## Non-goals and immutable beta state

- Do not modify, delete, merge, or retarget accounts, Raiders, or device
  enrollments.
- Do not reset or recompute existing Runs, Raid Power, levels, gold, damage,
  rewards, purchases, cosmetics, or leaderboard history.
- Do not transfer queued or awarded work between Raiders.
- Do not tune `token_modifier_k` or `modifier_cap` in the correctness release.
- Do not enable collection on the primary canary. Its owner turned collection
  off, and re-enabling it requires a separate explicit approval.
- Do not bundle the server correction with the signed companion re-enrollment
  and human-readable-status release.

The inflated v1 results remain visible and are treated as beta history. The
correction is forward-only.

## Evidence and root cause

Codex currently emits cumulative native usage where:

- `cached_input_tokens` is contained within `input_tokens`;
- `reasoning_output_tokens` is contained within `output_tokens`; and
- `total_tokens` equals total input plus total output.

Runtime Raiders stores the native values without content, which is desirable.
The v1 Raid Power policy then treats the fields as independent categories. A
zero cache-read weight does not remove cached tokens already contained within
input, and adding reasoning to output counts that subset twice.

For the observed Run with 4,091,941 input, 4,004,352 cached input, 11,179 output,
and 6,033 reasoning output, v1 awarded 4,110,542 Raid Power. Under the corrected
parent/subset interpretation, its usage contribution is approximately:

```text
(4,091,941 total input - 4,004,352 cached input) + 11,179 total output
= 98,768 usage Raid Power
```

Completion and duration credits remain separate and unchanged.

## Forward-only Raid Power policy v2

The server retains raw native counters and derives the v2 scoring view:

```text
uncached_input = input - cache_read
scored_output = output
usage_credit = uncached_input + scored_output
```

Cache writes remain inside total input and therefore already receive the normal
input weight. Reasoning remains inside total output and is counted exactly once.
Model and effort remain metadata and never alter scoring.

For v2, the server rejects an event when `cache_read > input` or
`reasoning_output > output`. It never silently clamps malformed counters.

The cutover is based on Run start time:

- Runs started before the v2 cutover remain assigned to v1.
- Runs started at or after the cutover use v2.
- A Run's assigned policy is immutable.
- Duplicate event identities remain idempotent under either policy.

V1 usage credit expires at the v2 cutoff by authoritative server receipt time.
At or after that instant, an accepted event for an existing v1 Run still
updates its raw cumulative counters, lifecycle state, model metadata, and fresh
presence receipt, but its awarded usage credit cannot increase. A completed v1
Run may still receive the same bounded completion and duration credits. This is
forward-only: the expiration does not automatically remove Raid Power awarded
before deployment or otherwise rewrite existing history.

This allows 0.4.8 collectors to continue sending auditable native counters while
the server owns provider-specific scoring semantics.

## Player-page presentation

The Current Raid tab keeps raw native totals but presents containment explicitly:

```text
74,226 total input (71,424 cached, 2,802 uncached)
486 total output (284 reasoning)
0 cache writes reported
```

The Run Details grid packs Provider through Elapsed from the left. Native usage
and Awarded each begin on their own left-aligned row. The display never implies
that input, cache reads, output, and reasoning should be added together.

## Dungeon presence

Presence is not Raid Power. A fresh authenticated Run event may prove that a
Raider is working even when the event awards zero points.

The server records presence only when all of these are true:

- the event is authenticated to a current device;
- the event identity is newly accepted rather than duplicated;
- the Raider is enabled; and
- the server receives the event no more than 120 seconds after
  `observed_at_ms`, so it represents current work rather than delayed backlog.

Device heartbeat alone is not presence. Disabled Raiders, duplicates, stale
backlog, and observations later than server receipt do not extend it. Dungeon
sleep and the public `activeRaiders` count use this same definition. Scoring
continues through the independent Raid Power path.

## Rollout boundaries

1. Implement policy-v2 selection, nested-counter validation, player-page copy,
   and presence behavior as independently reviewable server changes.
2. Run focused tests, the full server suite, type checking, and a production-data
   read-only dry calculation comparing v1 awards with hypothetical v2 awards.
3. Back up the production database and deploy only while the dungeon is paused.
4. Verify public health and version before any canary collection.
5. With separate approval, enable one bounded canary long enough to create one
   new post-cutover Run; verify its raw counters, v2 arithmetic, prompt dungeon
   wake, 15-minute sleep boundary, and absence of duplicate credit; then turn
   collection off again.
6. Observe corrected content-free aggregates for two to three normal office
   days before proposing any Momentum tuning.

Account cleanup, official re-enrollment, pretty `raiders status`, signing,
notarization, publication, and wider employee activation remain separate work.

## Acceptance criteria

- A Run with 74,226 input, 71,424 cached input, 486 output, and 284 reasoning
  receives 3,288 usage credit under v2.
- A v1 Run retains its last pre-cutoff usage award when later accepted events
  increase its raw counters, while completion and duration remain bounded and
  available.
- The same native counters remain available for player-page audit without
  additive wording.
- Existing v1 database rows and every account-related table remain byte-for-byte
  unchanged by the v2 cutover.
- An accepted zero-credit opening event can wake the dungeon without changing
  Raid Power.
- Duplicate, heartbeat-only, disabled-Raider, and stale-backlog events cannot
  extend dungeon presence.
- No release step enables collection without separate approval.

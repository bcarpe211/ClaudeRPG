# Runtime Raiders provider record evidence

**Status:** Active evidence record
**Audience:** Adapter and policy reviewers
**Applies to:** Enabled Codex Desktop and Codex CLI surfaces
**Last verified:** 2026-08-28

Evidence date: 2026-08-01

This gate enables only the two Codex launch surfaces proven by controlled local canaries. The canary records remained in their normal local store and were not copied into the repository. Inspection emitted field keys, JSON types, and allowlisted boolean comparisons only; it did not emit scalar record values.

## Activation

```text
codex_desktop  enabled   verified by controlled canary
codex_cli      enabled   verified by controlled canary
omp            disabled  separate canary, adapter, privacy, and policy gate required
claude_code    disabled  credentialed canary, adapter, privacy, and policy gate required
```

Disabled means unsupported. Runtime Raiders must not scan those providers' roots, accept their records, infer their activity, or fall back to process watching, shell history, window focus, hooks, history databases, or telemetry.

## Evidence matrix

| Surface | Verified version | Local record root | Launch provenance | Run identity | Usage | Lifecycle |
| --- | --- | --- | --- | --- | --- | --- |
| Codex Desktop | bounded string version metadata; structurally verified through `0.146.0-alpha.9.2` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | The approved Desktop session had bounded nonempty string `id` and `originator` fields and the nested `session_meta.payload.source.subagent.thread_spawn` structure described below. No scalar marker value or path participates in identity. | String `turn_context.payload.turn_id` | `event_msg` / `token_count`; prefer monotonic `payload.info.total_token_usage` session deltas, with the older cumulative `last_token_usage` shape as a compatibility fallback | `session_meta`, `event_msg.task_started`, `turn_context`, zero or more token observations, `event_msg.task_complete` |
| Codex CLI | bounded string version metadata; live root record verified with `codex-cli 0.146.0-alpha.9.2` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | The isolated CLI canary created exactly one new record with bounded nonempty string `id`, `originator`, and `source` fields. The string source shape is structurally distinct from Desktop. No scalar marker value or path participates in identity. | String `turn_context.payload.turn_id`, also matched by the canary's user response metadata | Same session-total delta and legacy fallback rules as Desktop | Same verified lifecycle as Desktop; the bounded process exited successfully and wrote `task_complete` |
| Omp | unverified | not scanned | disabled | unsupported | unsupported | unsupported |
| Claude Code | unverified | not scanned | disabled | unsupported | unsupported | unsupported |

## Collector contract fixed by this evidence

- A stable Codex `turn_id` is the provider-native Run identity. The opaque Run key is derived from the provider plus `turn_id`; launch surface is display/provenance only and is not key material. The same underlying `turn_id` observed through Desktop and CLI therefore deduplicates to one Run.
- Current records expose session-cumulative `total_token_usage` plus per-model-call
  `last_token_usage`. Derive each Run's cumulative counters only from positive,
  component-wise session-total deltas. A repeated session total contributes zero;
  a decreasing total fails closed. Persist the session-total baseline across a
  daemon restart so prior work is never re-counted. When that baseline is
  intentionally unknown after an older snapshot upgrade or bounded historical
  seeding, the first live record establishes it but contributes zero; its total
  must still be at least its per-call `last_token_usage` component-wise. This
  conservative one-record undercount prevents a repeated boundary record from
  re-awarding prior work. Later records contribute only session-total deltas.
  Historical seeding never retains a total from the inspected prefix because the
  cursor is pinned to a later captured EOF boundary, but it does retain the
  observed usage format so a cross-boundary format change still fails closed.
- Older verified records without `total_token_usage` retain the original
  cumulative `last_token_usage` behavior. If `total_token_usage` is present it
  must be complete and valid; never fall back around a malformed total or
  switch usage formats inside one provider session. A byte-identical repeat of
  the first validated `session_meta` is ignored using only a locally persisted
  SHA-256 fingerprint; any different second metadata record fails closed rather
  than resetting an established accounting baseline. The fingerprint is never
  uploaded.
- A Run is complete only after `task_complete`. A partial final line, cancellation, failure-like terminal, or missing completion remains incomplete and must not be promoted to a completed Run.
- Duplicate records are idempotent. Reordered records remain pending until their required identity and lifecycle facts are available.
- Distinct `turn_id` values remain separate Runs, including the paired parallel fixtures, and must never be merged.
- Launch provenance comes from the verified `session_meta` shape/runtime marker, never from `cwd`, a project name, or a path.

The launch predicate is structural and fail-closed. Both surfaces require a
bounded, nonempty string `payload.cli_version` plus bounded, nonempty string
`payload.id` and `payload.originator`. CLI additionally requires a bounded,
nonempty string `payload.source`. Desktop requires `payload.source` to contain
only `subagent`, containing only `thread_spawn`, whose exact fields are
`agent_nickname` (bounded nonempty string), `agent_path` (bounded nonempty
string), `agent_role` (null), `depth` (nonnegative safe integer), and
`parent_thread_id` (bounded nonempty string). These scalar values are never
matched, exported, or used as Run identity. Missing, empty, wrong-type, or
structurally unknown required provenance—and additional fields inside the
Desktop source structure—permanently reject that file snapshot.

## Privacy audit contract

`auditJsonlShape` parses supplied JSONL lines one at a time and returns only sorted dotted field names mapped to sorted JSON types. It never returns scalar values. Malformed lines add only `$malformed` with type `malformed`.

The synthetic fixtures deliberately contain traps including `DO_NOT_EXPORT_PROMPT`, `DO_NOT_EXPORT_PATH`, and `DO_NOT_EXPORT_TOOL_ARGUMENT`. They use fake identifiers, timestamps, counts, origins, and content. No fixture is a copied or transformed real provider record.

## Fixture coverage

- Completed Run: one fixture per enabled launch surface.
- Failed and cancelled: one fixture per surface with synthetic, deliberately unverified terminal labels and no `task_complete`; these assert conservative incomplete handling, not additional provider support.
- Partial line: one fixture per surface ending in malformed JSON.
- Duplicated and reordered: one fixture per surface with an early usage observation and duplicate usage/completion records.
- Parallel: paired A/B records per surface with distinct fake sessions and turn IDs.

## Unsupported fallbacks

The gate does not authorize Claude Code, Omp, OpenTelemetry, provider analytics, provider configuration changes, process or window observation, shell history, provider hooks, history databases, prompt inspection, response inspection, command inspection, tool-payload inspection, or path/project-name identity.

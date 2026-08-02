# Runtime Raiders provider record evidence

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
| Codex Desktop | `0.146.0-alpha.3.1` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | The approved Desktop session matched the runtime thread and originator markers; `session_meta.payload.source` was a structured object. No path participates in identity. | String `turn_context.payload.turn_id` | `event_msg` / `token_count` / `payload.info.last_token_usage`; numeric input, cached input, cache-write input, output, reasoning output, and total fields | `session_meta`, `event_msg.task_started`, `turn_context`, zero or more cumulative token observations, `event_msg.task_complete` |
| Codex CLI | `codex-cli 0.146.0-alpha.3.1` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | The isolated CLI canary created exactly one new record and `session_meta.payload.source` was a string, structurally distinct from the Desktop canary. No scalar source value or path participates in identity. | String `turn_context.payload.turn_id`, also matched by the canary's user response metadata | Same cumulative `last_token_usage` object and numeric fields as Desktop | Same verified lifecycle as Desktop; the bounded process exited successfully and wrote `task_complete` |
| Omp | unverified | not scanned | disabled | unsupported | unsupported | unsupported |
| Claude Code | unverified | not scanned | disabled | unsupported | unsupported | unsupported |

## Collector contract fixed by this evidence

- A stable Codex `turn_id` is the provider-native Run identity. The opaque Run key is derived from the provider plus `turn_id`; launch surface is display/provenance only and is not key material. The same underlying `turn_id` observed through Desktop and CLI therefore deduplicates to one Run.
- `last_token_usage` is a cumulative per-Run observation. Keep the newest valid observation for a Run; never sum repeated observations.
- A Run is complete only after `task_complete`. A partial final line, cancellation, failure-like terminal, or missing completion remains incomplete and must not be promoted to a completed Run.
- Duplicate records are idempotent. Reordered records remain pending until their required identity and lifecycle facts are available.
- Distinct `turn_id` values remain separate Runs, including the paired parallel fixtures, and must never be merged.
- Launch provenance comes from the verified `session_meta` shape/runtime marker, never from `cwd`, a project name, or a path.

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

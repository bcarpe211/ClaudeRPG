# Runtime Raiders local canary checklist

This tracks local synthetic evidence, remote readiness, and the separately
authorized release gates for the Codex Desktop and Codex CLI companion
candidate. Record counts, outcome, and timestamp only. Do not record prompts,
responses, source files, paths, native IDs, credentials, or provider
configuration.

## Automated evidence

| Gate | Count | Status | Timestamp (UTC) |
| --- | ---: | --- | --- |
| Server: enrolled synthetic Raider/device | 1 | verified | 2026-08-02T07:08:34Z |
| Server: accepted Codex Run events | 6 | verified | 2026-08-02T07:08:34Z |
| Server: duplicate events | 1 | verified | 2026-08-02T07:08:34Z |
| Server: persisted Runs | 5 | verified | 2026-08-02T07:08:34Z |
| Server: reserved/mixed surface rejections | 3 | verified | 2026-08-02T07:08:34Z |
| Server: rejected-batch scoring/progression mutations | 0 | verified | 2026-08-02T07:08:34Z |
| Companion: private Codex fixture files | 12 | verified | 2026-08-02T06:37:20Z |
| Companion: fake-transport outbound destinations | 1 allowlisted destination | verified | 2026-08-02T06:37:20Z |
| Companion: content-trap outbound matches | 0 | verified | 2026-08-02T06:37:20Z |
| Companion: denied-server banked outbox events | 1 or more | verified | 2026-08-02T06:37:20Z |

The server evidence is the `runtime-raiders-e2e` suite: temporary database,
real Express routes, enrollment/authentication, parallel Codex surfaces,
duplicate delivery, Run/event audit, Raid Power projection, legacy
`total_delta=0`, potion work, wake, recent Run query, and atomic reserved or
mixed-surface rejection.

The companion evidence is only complete when the current `swift test` gate
passes its synthetic fixture and fake-transport checks. These local fixtures do
not open Claude or Omp roots and do not invoke a live provider or AI session.

## Controlled local-canary record

Complete each row with aggregate count/status/timestamp after an approved local
synthetic run. Both enabled surfaces must be shown by status; Claude and Omp
must remain absent and rejected.

| Scenario | Desktop count/status | CLI count/status | Timestamp (UTC) |
| --- | --- | --- | --- |
| short | 1 / server fixture verified | 1 / server fixture verified | 2026-08-02T07:08:34Z |
| long | 1 / server fixture verified | 1 / server fixture verified | 2026-08-02T07:08:34Z |
| failed or cancelled | 2 / observed open; no terminal support | 2 / observed open; no terminal support | 2026-08-02T06:37:20Z |
| parallel | 2 / fixture verified | 2 / fixture verified | 2026-08-02T06:37:20Z |
| duplicate surface | 1 / fixture verified | 1 / fixture verified | 2026-08-02T06:37:20Z |
| collector restart | 1 / shared controller verified | 1 / shared controller verified | 2026-08-02T06:37:20Z |
| server outage / outbox banking | 1 / shared uploader verified | 1 / shared uploader verified | 2026-08-02T06:37:20Z |
| off | 1 / shared controller verified | 1 / shared controller verified | 2026-08-02T06:37:20Z |
| on | 1 / shared controller verified | 1 / shared controller verified | 2026-08-02T06:37:20Z |
| status: enabled surfaces only | 1 / registry verified | 1 / registry verified | 2026-08-02T06:37:20Z |
| reserved Claude/Omp rejection | 0 accepted / server verified | 0 accepted / server verified | 2026-08-02T07:08:34Z |

Synthetic failed/cancelled labels are recorded only as conservative open Runs:
the current Codex contract has no verified terminal record for either outcome.
They are not evidence of failed/cancelled completion support or completion
credit.

## Fresh final-release readiness inventory

Every row here remains pending until it is freshly verified against the final
`RELEASE_SHA`. Earlier preparation observations do not establish current Pi,
network, Mac, or signed-artifact state and do not replace the installed-off
canary or direct-network checks below.

| Gate | Count | Status | Timestamp (UTC) |
| --- | ---: | --- | --- |
| Final signed/notarized package validation and three recorded digests | 0 | pending final build | — |
| Runtime Raiders app, command, process, and LaunchAgent absent before cutover | 0 | pending fresh check | — |
| Known legacy ClaudeRPG OTel variables absent | 0 | pending fresh check | — |
| Direct-path `raiders.local` client check | 0 | pending fresh check | — |
| Pi `sqlite3`, database integrity, pause, loopback health, and kiosk readiness | 0 | pending final preflight | — |
| Final server and companion release suites | 0 | pending final release SHA | — |

## Release blockers and non-automated gates

| Gate | Count | Status | Timestamp (UTC) |
| --- | ---: | --- | --- |
| Network/privacy fake-transport tests | 33 | verified | 2026-08-02T06:37:20Z |
| Exact RuntimeRaidersCore 10-minute resource measurement | 1 | verified | 2026-08-02T06:57:00Z–2026-08-02T07:07:39Z |
| Caddy release store prepared, selector absent | 0 | pending separate approval; `/var/lib/runtime-raiders/current` must remain absent | — |
| Artifact routes unpublished, 3/3 return 404 | 0/3 | waits for fail-closed Caddy preparation | — |
| Production cutover | 0 | not run; separately authorized action | — |
| Deployed server acceptance | 0 | waits for authorized cutover and section 5 | — |
| Signed triplet published, 3/3 digests verified | 0/3 | waits for server acceptance and separate publication approval | — |
| Installed signed artifact, daemon live and persistently off | 0 | waits for verified publication and separate installation approval | — |
| Live canary activation | 0 | waits for installed-off acceptance and separate approval | — |
| Office activation | 0 | waits for live-canary acceptance and separate approval | — |

The exact RuntimeRaidersCore measurement ran for five idle minutes plus five
synthetic active minutes: idle CPU `0.0040%`, active CPU `0.9807%`, peak RSS
`13.45 MiB`, outbox `508,295` bytes, one fake outbound destination, and zero
content-trap matches. The harness used the unmodified core sources, injected
temporary paths, direct controller processing, and an injected fake transport;
the checked read-only provider fixture preserved its size and modification
timestamp. Current uploader tests also verify the two-second request timeout,
bounded retry delay, exact destination guard, and outage banking.

The pre-cutover measurement is an exact RuntimeRaidersCore build with injected
local paths and fake transport. The signed LaunchAgent canary intentionally
remains uninstalled until the production server passes section 5 and the exact
signed triplet is separately published. Installation must prove the daemon is
live but collection remains persistently off before any activation approval.
For that canary, execute only a locally downloaded installer whose SHA-256
matches the restricted release record; do not pipe the remote installer into a
shell.

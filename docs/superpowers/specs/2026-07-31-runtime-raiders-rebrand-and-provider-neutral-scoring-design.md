# Runtime Raiders Rebrand and Provider-Neutral Scoring — Design

**Date:** 2026-07-31

**Status:** Design approved; implementation planning is gated on review of this written specification

**Scope:** Runtime Raiders product language and visual direction, passive local
Run collection, provider-neutral Raid Power scoring, compatibility migration,
and internal deployment naming

## 1. Purpose

ClaudeRPG currently rewards Claude Code token use through Claude-specific
OpenTelemetry ingestion. The office can no longer organize the game around a
single AI tool, and enabling additional provider telemetry is not acceptable.

Runtime Raiders keeps the existing idle co-op dungeon and progression while
changing the premise:

- each employee has one persistent fantasy character, their **Raider**;
- a supported AI session is a **Run**;
- Runs contribute **Raid Power** to the office's active **Raid**; and
- the Raider fights, progresses, and earns game rewards regardless of which
  supported AI tool produced the Run.

The system measures supported AI activity, not employee productivity or work
quality. It must never claim that Raid Power is a measurement of work output.

## 2. Product principles and hard constraints

The rebrand and new collection system must satisfy all of these requirements:

1. **No additional provider reporting.** Runtime Raiders must not enable OTel,
   analytics, or any other provider telemetry beyond the provider's standard
   behavior. It must not proxy AI traffic or change provider settings.
2. **No interference.** Collection is passive, read-only, low-priority, and
   outside the AI tool's execution path. A collector, parser, server, or network
   failure must not slow, block, modify, corrupt, or terminate a Run.
3. **Immediate control.** Players can use `raiders on`, `raiders off`,
   `raiders status`, `raiders doctor`, and `raiders uninstall`.
4. **One-step installation.** Enrollment is a generated `curl`-to-shell command
   requiring no package manager, language runtime, or administrator privileges.
5. **Content-free reporting.** The trusted office server may receive Run facts,
   usage counters, model, effort, and timestamps. It must never receive prompts,
   responses, commands, tool arguments or results, files, paths, workspace
   names, repository data, or shell history.
6. **Internal-only service.** The game remains available only through the
   internal office network. The rebrand must not make the Pi publicly reachable.
7. **Compatibility first.** Existing levels, gold, combat history, cosmetics,
   inventory, damage, and progression remain intact. Internal renaming that adds
   migration risk is deferred.

## 3. Approved vocabulary and voice

### 3.1 Brand

- Product name: **Runtime Raiders**
- Primary line: **Clock in. Clear dungeons. Get paid.**
- Secondary line: **Your AI keeps running. Your Raider keeps raiding.**

"Get paid" means earning in-game gold and rewards. Supporting landing-page copy
must make that clear without weakening the headline.

The voice is confident, playful, and tasteful. Humor may target fictional guild
bureaucracy, monsters, loot, and adventurer problems. It must not target employee
performance, lateness, hours, falling behind, or comparative productivity. Clear
interface language wins whenever a joke would obscure an action.

### 3.2 Player-facing terms

| Existing concept | Runtime Raiders term |
| --- | --- |
| Player or character | Raider |
| AI session | Run |
| One shared dungeon | Raid |
| Encounter | Fight |
| Effective tokens / normalized score | Raid Power |
| Active damage multiplier | Momentum |
| Provider, model, and effort metadata | Run Details |
| Character creation | Create Your Raider |
| Player authentication token | Raider Key |

**Leaderboard** remains Leaderboard because it is immediately understood.
Class, shop, wardrobe, potion, inventory, cosmetic, damage, gold, level, monster,
and boss language also remains.

A Raid is one complete shared dungeon, including its regular Fights and boss.
Runs join and contribute to the active Raid. The product must explain this once
in plain language; unexplained calls to action such as "Take the Run" are not
used.

## 4. Visual direction

Runtime Raiders remains classic fantasy with a restrained guild/company flavor.
The existing artwork dictates the visual language; the rebrand must not add
robots, circuitry, terminals, neon cyberpunk, or other technology that conflicts
with the dungeon art.

The existing palette is extended, never replaced:

- keep the purple-black foundation, mossy walls, warm torchlight, and existing
  gold hierarchy;
- make the current `#e8c96a` the official Runtime Raiders gold;
- use guild wine `#54282b` sparingly for banners, seals, and Raid headings;
- use green sparingly because the wall art already supplies moss green;
- do not introduce cool slate as a major surface color; and
- reserve parchment for small notices, labels, and illustrations rather than
  full-page backgrounds.

The rebrand should come from the wordmark, terminology, copy, guild banners,
seals, and small motifs. It must preserve the hard-won contrast between the
dungeon shell, torches, purple panels, and gold accents. Existing pixel art,
classes, monsters, cosmetics, and dungeon scenes remain valid.

## 5. Page and presentation changes

### 5.1 Landing and enrollment

The landing page leads with the Runtime Raiders wordmark, the primary line, and
the secondary line. Its three-step explanation is literal:

1. Create your Raider.
2. Install the private local companion.
3. Use a supported AI tool; completed and observed Runs generate Raid Power.

The privacy section explicitly lists what the system does and does not see. It
must name supported surfaces and must not imply support for an app that lacks a
safe local record source.

### 5.2 Raider Hub

The current character sheet becomes the Raider Hub in product copy while its
route and internal identifiers remain compatible. It shows:

- lifetime and period Raid Power;
- current Raid, Fight, damage, Momentum, gold, inventory, and effects;
- connection and collector status; and
- Latest Run with literal provider, model, effort, state, elapsed time, usage,
  and awarded Raid Power.

When Runs overlap, it may show a compact state such as **2 Runs active**. One
Raider appears in the dungeon; damage sourced from all of that Raider's Runs
accumulates into that one character.

### 5.3 TV and Leaderboard

The TV may show Raid number, Fight position, and number of active Raiders where
the information fits without cluttering the battlefield. Provider, model, and
effort details remain off the battlefield.

Existing boards are renamed only where necessary:

- Total Raid Power
- Today's Raid Power
- This Week's Raid Power
- Raid Momentum

Damage, gold, level, monsters, biggest hit, and other game boards remain.
Provider, model, and effort may be displayed as Run Details, but they are never
ranked and never modify score.

### 5.4 Admin and documentation

Visible ClaudeRPG, Claude-only, token, and OTel setup language is replaced.
Admin interfaces may retain compatibility field names temporarily, but labels
must distinguish **legacy baseline** from new Raid Power. Documentation must
explain the supported surfaces, privacy contract, control commands, diagnostics,
and removal of old Claude OTel settings.

## 6. Supported provider surfaces

Launch priority is:

1. **OpenAI Codex Desktop and CLI**
2. **Claude Code**
3. **Omp**

Composer is deferred. Claude desktop and web are unsupported unless a later
investigation proves that they expose stable, content-free local records that
can satisfy the same safety contract.

Support is granted per surface, not merely per provider. An adapter ships only
after its actual local record format and lifecycle have been verified. A format
that does not provide stable Run identity, trustworthy usage facts, or safe
incremental observation is unsupported rather than approximated through general
computer activity.

## 7. Local companion architecture

The installed service is internally named `runtime-raiders-agent`. It is an
independent per-user macOS background process managed by `launchd`, accompanied
by the `raiders` command.

### 7.1 Components

1. **Provider adapters** read only approved local record locations for their
   surface. They translate provider-native records into the common Run schema.
2. **Run registry** maintains a bounded map of open Runs and persisted cursors.
3. **Privacy allowlist** constructs an outbound record from explicitly allowed
   fields. Unknown fields are never forwarded.
4. **Durable outbox** stores content-free events until the internal server
   acknowledges them. It retries with bounded backoff.
5. **Uploader** communicates only with the configured Runtime Raiders server.
6. **Control and diagnostics** implement on/off, status, doctor, and uninstall
   without invoking or reconfiguring an AI tool.

### 7.2 Passive observation rules

The companion must not:

- wrap, launch, inject into, or monitor provider processes;
- install provider hooks or modify provider configuration;
- enable OTel or another analytics exporter;
- proxy network requests;
- scan workspaces, repositories, arbitrary files, or shell history;
- lock provider files or write into provider-owned directories; or
- depend on the collector being healthy for a Run to proceed.

Adapters use incremental, read-only observation after a provider has written a
record. Reads are bounded, tolerant of partial writes, and performed at low
priority. Persistent cursors are updated atomically only after a record is
successfully normalized or deliberately rejected. A new installation starts at
the current record boundary and does not backfill historical AI activity.

Malformed, truncated, unknown-version, or unrecognized records fail closed:
they produce no score and no outbound payload. The adapter records a local,
content-free diagnostic reason and continues watching for later valid records.

### 7.3 On, off, and failure behavior

`raiders off` stops local parsing and upload without changing any provider and
records the time collection was disabled. When `raiders on` is invoked, each
adapter first advances its cursor to the provider's current record boundary and
then resumes observation. The service may remain installed and idle while off.
Events already in the outbox remain banked, but provider records created during
the explicit off interval are never parsed, scored, or replayed.

If the Runtime Raiders server is unavailable, the bounded outbox banks already
observed content-free events and retries later. If the outbox reaches its size
or age limit, the oldest unsent events are discarded with a local diagnostic;
provider operation remains unaffected. Restarting the companion must preserve
cursors, the outbox, and Run identity.

CPU, memory, disk reads, outbox size, and retry frequency have explicit limits.
Exceeding a limit degrades or pauses collection, never the AI tool.

## 8. Installation and enrollment

The Raider Hub generates a single-use, short-lived enrollment command. The
enrollment code is not the persistent Raider Key, so shell history does not
contain the long-lived credential. The installer exchanges it with the trusted
internal server, stores the resulting credential with user-only permissions,
and invalidates the one-time code.

The installer:

- downloads a signed, prebuilt macOS binary for the current architecture;
- verifies its signature or pinned checksum before installation;
- installs entirely in the user's home directory;
- installs and starts a per-user LaunchAgent without `sudo`;
- exposes the `raiders` command through an already writable PATH directory, or
  adds one clearly marked PATH entry after announcing the exact shell-file
  change; and
- never edits Claude, Codex, Omp, workspace, or provider telemetry settings.

Installation is idempotent. Upgrades preserve credentials, cursors, and the
outbox. Uninstall stops and removes only Runtime Raiders-owned files and reports
what was removed. It does not remove or edit provider files.

## 9. Common Run event contract

The uploader authenticates its request with the device credential returned at
enrollment. The server binds that credential to the Raider; the persistent
credential is not repeated inside each event body. The companion sends only an
allowlisted, versioned event containing fields from this set:

- event schema version and companion version;
- random device identifier;
- provider and supported surface;
- opaque Run key derived locally from provider-native Run identity;
- monotonically increasing usage sequence;
- event time, observed time, Run start time, and terminal time when present;
- Run state: open, completed, failed, or cancelled;
- cumulative provider-native usage counters by supported category;
- elapsed duration on a terminal event;
- model and effort when reliably present; and
- a deterministic idempotency key.

The provider-native session identifier is not sent directly. The opaque Run key
is a keyed digest of the normalized provider identity using a Raider-scoped
deduplication secret supplied during enrollment. That secret is shared by the
same Raider's enrolled devices, making the key stable across adapters and
devices without revealing the native identifier, content, or a local path.
Missing model or effort becomes **Unknown** and never blocks scoring.

No free-form provider object is accepted. Extra fields are dropped locally, and
the server independently validates the same allowlist, types, sizes, enums, and
time bounds.

## 10. Server-side data and compatibility bridge

The server is authoritative for scoring. The companion reports observed facts;
it never decides Raid Power.

An additive migration introduces two provider-neutral tables:

- **`runs`** holds one current summary per Raider/provider/opaque Run key: lifecycle,
  cumulative native usage, display-only Run Details, and total Raid Power.
- **`run_events`** holds append-only, idempotent observations and their awarded
  Raid Power delta under a scoring-policy version.

These two responsibilities remain separate. A unique event identity and a
unique Run sequence prevent duplicated, delayed, or reordered delivery from
scoring twice.

For launch compatibility, every positive Raid Power delta also creates a
synthetic entry in the existing `token_events` activity path and increments the
existing `players.effective_tokens` progression counter in the same transaction.
That counter becomes the internal compatibility storage for lifetime Raid Power.
The synthetic activity entry sets `total_delta` to zero. New activity therefore
does not add a cross-provider fiction to `players.total_tokens`; that field
remains a retained legacy total and disappears from player-facing UI.

This bridge deliberately preserves the current engine, Momentum calculation,
level progression, potion work attribution, damage, rewards, Leaderboards, and
game wake/pause behavior. A future structural rewrite will replace the misleading
internal names after the rebrand is stable.

## 11. Raid Power policy

Raw tokens are not equal across providers, models, tokenizers, caches, or
reporting surfaces. Runtime Raiders therefore never adds raw provider token
counts together and never labels Raid Power as tokens.

For a completed Run with meaningful nonzero usage:

```text
Raid Power = completion credit
           + provider-normalized usage credit
           + capped sublinear duration credit
```

The rules are:

- **Usage credit** is awarded incrementally from positive changes in cumulative
  native usage. A versioned provider policy maps available input, output, cache
  creation, cache read, and equivalent categories into comparable usage units.
- **Completion credit** is a fixed credit awarded exactly once after the
  provider record supplies a trustworthy completed state and the Run has earned
  a positive provider-normalized usage credit.
- **Duration credit** is based on provider-recorded Run start-to-completion time,
  grows sublinearly, and has a hard cap. It recognizes long model churn without
  creating an uncapped reward for waiting.
- **Failed and cancelled Runs** receive only observed usage credit.
- **Open and stalled Runs** bank only observed usage credit. They receive no
  completion or duration credit unless a valid terminal completion arrives.
- There is no sustained-activity, concurrency, model, effort, provider-choice,
  or manual busy-time bonus.

Provider normalization coefficients, the fixed completion credit, duration
curve, and caps are server-owned configuration under an immutable policy
version. Before cutover, the implementation must calibrate and lock the initial
policy against a shared set of representative office workloads run through each
supported surface. The launch is blocked unless that policy and its fixtures are
committed, reproducible, and pass the cross-provider review. Later tuning creates
a new policy version; it never silently re-scores historical events.

This produces a fair game approximation of AI activity, not a scientifically
exact equivalence between providers and not an evaluation of work quality.

## 12. Concurrent Runs and deduplication

Distinct Runs used at the same time score independently and additively. This is
intentional: two genuinely separate agents performing two Runs represent two
simultaneous streams of AI activity.

- Each distinct completed Run receives its normal usage, completion, and capped
  duration credits.
- There is no concurrency multiplier and no concurrency penalty.
- Open or stalled parallel Runs still receive usage credit only.
- One Raider receives and displays the combined Raid Power and resulting damage.

The distinction is **parallel Runs are additive; duplicate observation is not**.
The server identifies an observation by Raider, provider, opaque Run key, and
usage sequence. The same underlying session observed through two surfaces or
adapters scores once. Two different stable Run identities score separately.

If an adapter cannot establish stable provider-native Run identity, that surface
does not score until the adapter can do so safely. It must not invent identity
from window focus, process lifetime, directory, or general computer activity.

## 13. Cutover and retained history

There is no progression reset.

- Each Raider's current `effective_tokens` value becomes their legacy lifetime
  Raid Power baseline.
- Existing level, gold, damage, cosmetics, inventory, potions, and historical
  records remain.
- New Run scoring begins at one explicit server cutover timestamp and policy
  version.
- Companion cursors and the server reject Runs whose recorded start precedes the
  cutover timestamp, preventing cross-cutover sessions, historical imports, and
  old OTel activity from being counted again.

The current Claude Code OTel setup must be explicitly disabled or removed on
each participating Mac before enabling Runtime Raiders collection. The new
installer and agent may detect and explain likely legacy settings through
`raiders doctor`, but they must not silently edit shell or provider configuration.
The old OTLP endpoint must not remain an alternate scoring path after cutover.

The earliest desired deployment day is Monday, but there is no hard deadline.
If internal DNS, Caddy/TLS, IT coordination, adapter verification, signing,
migration rehearsal, or another gate is incomplete, ClaudeRPG remains unchanged
and the cutover is rescheduled. A partial rebrand or mixed scoring period is not
acceptable.

## 14. Internal network and service naming

Current facts and target names are:

- `clauderpg.redlattice.com` resolves to an internally facing IP and is not an
  internet-exposed service;
- the Pi currently uses `claude-rpg.local` while reachable through the user's
  computer and Internet Sharing;
- IT must create the target internal DNS name `raiders.redlattice.com`;
- the Pi's target mDNS hostname is `raiders.local`; and
- Caddy must eventually serve the Runtime Raiders name.

The safe transition order is:

1. Keep all current names operational during development and verification.
2. Have IT create and verify internal DNS for `raiders.redlattice.com`.
3. Add the new name to Caddy/TLS while retaining the old host temporarily as a
   compatibility alias.
4. Change the Pi mDNS hostname to `raiders.local` and verify it on the actual
   network path used by the kiosk and Macs.
5. Update installer endpoints, documentation, onboarding links, and kiosk
   configuration.
6. Verify internal DNS, TLS, mDNS, health, kiosk loading, agent enrollment,
   and temporary old-host compatibility before cutover.

No step creates public ingress. Cloudflare may be involved in internal DNS or
certificate issuance, but that does not authorize public exposure.

## 15. Rollout and rollback

Deployment occurs only while the game is fully idle with
`game_state.paused = 1`, following the project's existing production-safety
rule.

Before cutover:

1. Back up the Pi database and record the running application version.
2. Rehearse the additive migration against a copy of production data.
3. Install the companion on canary Macs and verify `status` and `doctor`.
4. Verify retained progression and the legacy Raid Power baseline.
5. Run one controlled Run through each launch provider surface.
6. Remove or disable legacy Claude OTel configuration and prove there is no
   double-scoring path.

At cutover, apply the additive migration, deploy the server/UI release, set the
single cutover timestamp and scoring-policy version, and then enable companions.
Delayed outbox events remain idempotent.

Rollback restores the prior server release and the pre-cutover database backup.
The local companions are turned off. Lifetime game state is not reconstructed
from Mac outboxes, and no destructive reverse migration is attempted during an
incident.

## 16. Verification and acceptance gates

### 16.1 Adapter and privacy tests

- Sanitized fixtures cover every supported provider surface and lifecycle.
- Truncated, malformed, unknown-version, and format-changed fixtures fail closed.
- Negative privacy fixtures include prompts, responses, commands, tool data,
  filenames, and paths and prove none can enter the outbound payload.
- Network inspection proves the companion communicates only with the configured
  trusted internal server and no provider analytics endpoint.
- `raiders off` proves that records created while off are neither parsed nor
  replayed later.

### 16.2 Scoring and data tests

- Duplicate, delayed, reordered, restarted, cancelled, failed, stalled, and late
  terminal events produce the approved credits exactly once.
- Distinct concurrent Run identities score additively; the same Run observed
  twice does not.
- Model and effort changes never alter Raid Power for otherwise identical facts.
- Provider normalization fixtures and policy versions are deterministic.
- A migration rehearsal preserves all current progression and history.
- The compatibility projection drives Momentum, level progression, damage,
  potion attribution, rewards, pause/wake, and Leaderboards correctly.
- Legacy OTLP and new Run ingestion cannot both score the same activity.

### 16.3 Safety and operational tests

- Failure or termination of every companion component leaves each AI tool
  unaffected.
- CPU, memory, I/O, disk, retry, and outbox budgets are measured during idle,
  active, parallel, long-running, and server-offline scenarios.
- Installation, upgrade, on/off, diagnostics, and uninstall work without `sudo`
  and preserve or remove exactly the documented files.
- Database backup, migration, deployment, and rollback are rehearsed before the
  production window.

### 16.4 Product and infrastructure tests

- A content-string inventory finds no stale player-facing ClaudeRPG,
  Claude-only, token-scoring, or OTel-enrollment claims.
- Visual regression review confirms the moss, torchlight, purple surfaces,
  existing gold, pixel art, and layout contrast remain intact.
- Landing, Raider Hub, TV, Leaderboard, registration, admin, and documentation
  use the approved vocabulary consistently.
- Internal DNS, Caddy/TLS, Pi mDNS, kiosk, old-host compatibility, and
  internal-only reachability are verified on the real deployment path.
- A short canary with a test Raider passes for Codex, Claude Code, and Omp before
  office-wide cutover.

## 17. Explicit non-goals

This launch does not:

- collect or analyze message, code, tool, file, path, workspace, or shell content;
- monitor general keyboard, mouse, focus, window, process, or desktop activity;
- measure productivity, work quality, employee value, or time at work;
- claim exact token equivalence across providers;
- score or rank model choice, effort setting, or provider choice;
- support Composer, Claude desktop, or Claude web;
- redesign combat, progression, the shop, wardrobe, potion economy, cosmetics,
  dungeon generation, or reward balance;
- add extraction rewards, loot crates, or armor crafting; or
- make the Pi or game publicly accessible.

## 18. Recorded backlog

### 18.1 Raid participation and extraction

A later game design may reward Raiders who participate in a completed Raid with
an extraction opportunity containing loot crates, armor parts, or cosmetic
fragments. The concept is **join Runs to contribute to a Raid, then extract if
the Raid succeeds**. It requires a separate economy and gameplay design and must
not be folded into this compatibility-first rebrand.

### 18.2 Comprehensive internal rename

After Runtime Raiders and provider-neutral scoring are stable, perform a
separate structural rewrite with explicit data migrations:

- `player` internals become `raider`;
- `token_events` become provider-neutral Run/activity records;
- `effective_tokens` becomes Raid Power throughout domain and persistence code;
- package, repository, service, database, environment, deployment, and remaining
  hostname identifiers adopt Runtime Raiders naming; and
- compatibility aliases are retired only after history and rollback paths have
  been proven.

This rewrite is intentionally deferred because it is not required to deliver
the rebrand and would materially increase cutover risk.

## 19. Implementation decomposition

This document governs three coordinated workstreams that should be planned and
verified independently, then joined at the cutover gate:

1. **Collector and scoring:** provider probes, adapters, companion, common event
   contract, enrollment, Run ingestion, scoring policy, compatibility projection,
   privacy tests, and canary evidence.
2. **Product rebrand:** copy inventory, templates, styles, Leaderboards, Raider
   Hub, landing/enrollment, admin/docs, and visual regression.
3. **Internal deployment rename:** IT DNS, Caddy/TLS, Pi mDNS, kiosk and endpoint
   configuration, backups, cutover, and rollback.

The collector/scoring workstream establishes the data contract first. Product UI
may be implemented behind that contract without enabling it in production. The
network rename may be prepared in parallel but must be verified before the
single coordinated cutover. None of the three workstreams independently
authorizes a partial production launch.

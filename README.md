# Runtime Raiders

**Clock in. Clear dungeons. Get paid.**

Runtime Raiders is an office co-op dungeon RPG powered by AI Runs as they unfold.
Each person creates a Raider, keeps working in an enabled AI surface, and earns
Raid Power that drives leveling, Momentum, Fights, gold, potions, cosmetics, and
the Leaderboard. Your AI keeps running. Your Raider keeps raiding.

This repository contains the Runtime Raiders server and its private local
companion. The current release enables two Run surfaces: **Codex Desktop** and
**Codex CLI**. Existing package, database, service, route, and migration names
remain compatibility identifiers; a product rebrand does not rename them.

The [Runtime Raiders documentation authority map](docs/runtime-raiders/README.md)
is the entry point for current procedures. It links employee onboarding and
companion release, lifecycle/recovery, paused-dungeon deployment, and immutable
release evidence. Historical material is archived and must not be executed.

## How it works

1. A person creates a Raider and receives a Raider Key.
2. A one-time enrollment command installs the local companion for that Raider.
3. The companion observes Run lifecycle and cumulative usage while each Run is
   open, derives approved metadata locally, and sends authenticated Run events to
   the trusted Runtime Raiders server.
4. The server deduplicates each event, applies the versioned Raid Power policy,
   and awards usage-based Raid Power as the Run unfolds.

Completion adds only the policy's bounded completion and duration credit.
Elapsed wall time does not create a sustained or recurring Momentum bonus.

The server is Node.js/TypeScript with Express, EJS, SQLite, and a Canvas 2D TV
renderer. The companion is a separately tested local collector. The immutable
Raid Power policy is stored at `config/raid-power-policy-v1.json`; provider
evidence and calibration records live under `docs/runtime-raiders/`.

## Privacy and network boundary

The companion performs **local, metadata-only collection**. For enabled Runs it
may derive the provider, launch surface, opaque Run identity, lifecycle state,
timestamps, model/effort display metadata, and numeric usage counters needed for
Raid Power. The Run metadata pipeline does **not** extract or transmit prompt
text, response text, tool content or arguments, commands, source-code contents,
provider credentials, or project names.

Local absolute provider-record paths and read cursors are retained only in
owner-only collector operational state so incremental collection can resume
safely. They are never transmitted to the Runtime Raiders server. A cursor can
include a bounded incomplete-line buffer; that buffer is operational state, not
Run metadata.

The companion does not watch processes, windows, shell history, hooks, or
history databases, and it does not change provider configuration. AI traffic
continues to use only the standard network behavior of Codex Desktop or Codex
CLI; the companion does not proxy or add provider requests. Its only additional
application destination is the configured Runtime Raiders server. Treat that
server as a trusted destination because it receives Run metadata, usage counts,
and Raider/device credentials over the enrolled connection.

Codex Desktop and Codex CLI are the only currently enabled launch surfaces.
Unknown or disabled providers are not scanned, accepted, inferred, or used as a
fallback.

### Planned providers: separately gated and disabled

- **Omp** is planned, not enabled. It requires its own controlled canary,
  privacy audit, record adapter, matched-provider Raid Power calibration and
  policy version, and explicit server and companion allowlist approval.
- **Claude Code** is planned, not enabled. It separately requires a credentialed
  controlled canary, privacy audit, record adapter, matched-provider Raid Power
  calibration and policy version, and explicit server and companion allowlist
  approval.

Neither planned provider is authorized by the current Codex evidence or policy.

## Local development

### Requirements

- Node.js 20+
- The Oryx art pack under `assets/oryx_16-bit_fantasy_1.1/Sliced/`

### Install and test

```bash
npm install
npm test
npm run typecheck
npm run check:player-copy
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/claude-rpg.db` | Compatibility SQLite file path |
| `ADMIN_USERNAME` | `admin` | Admin login |
| `ADMIN_PASSWORD` | `changeme` | Admin password; change it |
| `SESSION_SECRET` | random | Session cookie secret |
| `SPRITES_DIR` | `assets/oryx_16-bit_fantasy_1.1/Sliced` | Sliced sprite directory |
| `SCORING_MODE` | `legacy-otlp` | Compatibility default; use `runtime-raiders` only with an explicit cutover |
| `RUN_SCORING_CUTOVER_AT` | — | Required millisecond epoch in Runtime Raiders mode |
| `RUN_ENABLED_SURFACES` | — | Required allowlist; current value is `codex_desktop,codex_cli` |
| `RAID_POWER_POLICY_PATH` | `config/raid-power-policy-v1.json` | Versioned Raid Power policy |
| `PUBLIC_URL` | derived local URL | Server origin returned during enrollment |
| `OTEL_ENDPOINT_HOST` | `claude-rpg.local` | Legacy OTLP only; inactive in Runtime Raiders mode |

The internal `cache_read_weight` setting is also legacy OTLP only and inactive
in Runtime Raiders mode. Native cache usage remains part of a Run's versioned
Raid Power policy; the legacy setting does not alter it.

### Start the server

```bash
ADMIN_PASSWORD=yourpassword npm run dev
# or
ADMIN_PASSWORD=yourpassword npm start
```

For server-only synthetic Runtime Raiders route testing:

```bash
SCORING_MODE=runtime-raiders \
RUN_SCORING_CUTOVER_AT=1700000000000 \
RUN_ENABLED_SURFACES=codex_desktop,codex_cli \
RAID_POWER_POLICY_PATH=config/raid-power-policy-v1.json \
PUBLIC_URL=http://localhost:8080 \
ADMIN_PASSWORD=yourpassword npm start
```

This starts only a local server candidate. It is not a companion enrollment
command or production cutover. The companion's production-origin guard means it
must not be pointed at this local URL.

Open:

- `http://localhost:8080/` — Runtime Raiders overview
- `http://localhost:8080/register` — Create Your Raider
- `http://localhost:8080/character` — Raider Login
- `http://localhost:8080/tv` — office TV
- `http://localhost:8080/admin` — admin panel

## Raspberry Pi 5 TV kiosk

The Pi setup targets the mDNS hostname `raiders.local`. Compatibility identifiers
intentionally retained for this release are `/home/rluser/ClaudeRPG`, <!-- runtime-raiders-copy-allow -->
`data/claude-rpg.db`, `/etc/claude-rpg.env`, `claude-rpg.service`, and
`claude-rpg-autoupdate.*`. See
**[docs/PI_SETUP.md](docs/PI_SETUP.md)** for the established server and Chromium
kiosk setup on `/tv`, and
**[docs/runtime-raiders/README.md](docs/runtime-raiders/README.md)** for
Runtime Raiders operating procedures and release evidence.

Do not treat local candidate verification as authorization to deploy, publish,
change DNS/Caddy, or replace the currently running Pi service.

## Sprite catalog (development only)

To browse sprite indices, parsed names, and current game assignments, start the
server with the catalog flag and open `/catalog`:

```bash
ENABLE_CATALOG=1 npm start
```

The catalog is off by default and is never mounted on the kiosk.

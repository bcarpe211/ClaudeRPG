# Runtime Raiders

Runtime Raiders is the Codex-first candidate for this office co-op dungeon RPG.
Its local companion privately collects only approved Codex Desktop and Codex
CLI Run metadata, then sends scored Run events to the candidate server. This
repository has not cut production over: the deployed ClaudeRPG/OTLP system,
its existing DNS, and its Pi setup remain authoritative until an explicit,
separately approved Runtime Raiders cutover.

The candidate's local verification record is
[docs/runtime-raiders/canary-checklist.md](docs/runtime-raiders/canary-checklist.md).
It is not a claim that an installer is signed, published, deployed, or active.

## Run it on a Raspberry Pi 5 (TV kiosk)

To deploy as an unattended office TV display (auto-start server + Chromium kiosk
on `/tv`, reachable at `claude-rpg.local`), see **[docs/PI_SETUP.md](docs/PI_SETUP.md)**:
clone the repo on the Pi and run `bash scripts/pi/setup.sh`.

## Plan A: Server foundation + player management (this milestone)

### Requirements
- Node.js 20+
- The Oryx art pack under `assets/oryx_16-bit_fantasy_1.1/Sliced/`

### Setup
```bash
npm install
```

### Environment variables
| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/claude-rpg.db` | SQLite file path |
| `ADMIN_USERNAME` | `admin` | Admin login |
| `ADMIN_PASSWORD` | `changeme` | Admin password (set this!) |
| `SESSION_SECRET` | random | Session cookie secret |
| `OTEL_ENDPOINT_HOST` | `claude-rpg.local` | Host shown in player setup snippets |
| `SPRITES_DIR` | `assets/oryx_16-bit_fantasy_1.1/Sliced` | Sliced sprite directory |
| `SCORING_MODE` | `legacy-otlp` | Keep legacy OTLP scoring until explicit Runtime Raiders cutover; candidate value: `runtime-raiders` |
| `RUN_SCORING_CUTOVER_AT` | — | Required millisecond epoch when `SCORING_MODE=runtime-raiders` |
| `RUN_ENABLED_SURFACES` | — | Required candidate allowlist: `codex_desktop,codex_cli` |
| `RAID_POWER_POLICY_PATH` | `config/raid-power-policy-v1.json` | Candidate Raid Power policy |
| `PUBLIC_URL` | derived local URL | Candidate server origin returned during enrollment |

### Run
```bash
ADMIN_PASSWORD=yourpassword npm run dev    # auto-reload
# or
ADMIN_PASSWORD=yourpassword npm start
```

To run the **server-only synthetic candidate** locally, use a past cutover
timestamp and the Codex-only surface allowlist:

```bash
SCORING_MODE=runtime-raiders \
RUN_SCORING_CUTOVER_AT=1700000000000 \
RUN_ENABLED_SURFACES=codex_desktop,codex_cli \
RAID_POWER_POLICY_PATH=config/raid-power-policy-v1.json \
PUBLIC_URL=http://localhost:8080 \
ADMIN_PASSWORD=yourpassword npm start
```

This starts only the local server candidate for synthetic route testing; it is
not a companion enrollment command or a production cutover. The companion
enforces its production-origin guard and therefore must not be pointed at this
local URL. The legacy OTLP default remains in effect until explicit approval.
Then open:
- `http://localhost:8080/` — register a character
- `http://localhost:8080/character` — log in with your token
- `http://localhost:8080/admin` — admin panel

### Test
```bash
npm test
```

## Sprite catalog (dev only)

To browse every sprite with its file index, parsed name, and current in-game
assignment (used for art curation), run with the catalog flag and open
`/catalog`:

```bash
ENABLE_CATALOG=1 npm start   # then open http://localhost:8080/catalog
```

It is off by default and never mounted on the kiosk.

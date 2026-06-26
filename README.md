# ClaudeRPG

An office co-op RPG that gamifies Claude Code token usage on a Raspberry Pi 5 TV
kiosk. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/`
for implementation plans.

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

### Run
```bash
ADMIN_PASSWORD=yourpassword npm run dev    # auto-reload
# or
ADMIN_PASSWORD=yourpassword npm start
```
Then open:
- `http://localhost:8080/` — register a character
- `http://localhost:8080/character` — log in with your token
- `http://localhost:8080/admin` — admin panel

### Test
```bash
npm test
```

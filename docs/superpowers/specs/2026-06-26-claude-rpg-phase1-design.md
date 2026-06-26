# ClaudeRPG — Phase 1 Design Spec

**Date:** 2026-06-26
**Status:** Approved for planning
**Author:** Bryan Carpenter (with Claude)

## 1. Overview

ClaudeRPG is an office "idle co-op RPG" displayed on a TV. It gamifies Claude
Code token usage: the more an employee works in Claude Code, the harder their
character hits a shared monster the whole office is fighting together. Token
usage streams to a Raspberry Pi 5 server in near-real-time via Claude Code's
OpenTelemetry export. The Pi drives the TV (kiosk) and hosts the management
website.

This spec covers **Phase 1 only** — a complete, playable, watchable game.
Deferred to later phases: shop + temporary potions, persistent items/armor,
sound effects. (Procedural dungeon generation IS in Phase 1.)

### Goals

- A TV that's fun to glance at: heroes battling monsters in a procedurally
  generated dungeon, with a live leaderboard.
- Zero-touch operation: auto-starts on boot, survives power loss, runs
  unattended.
- Token usage tracked automatically and mapped to each player's character.
- All management done remotely from a browser (no keyboard/mouse on the Pi).

### Non-goals (Phase 1)

- Shop, potions, equippable items/armor, sound.
- Player-vs-player; the game is strictly co-op.
- Internet exposure; the Pi serves the office LAN only.

## 2. Core game loop

1. The office collectively fights **one encounter at a time**.
2. A **dungeon level** consists of:
   - **2-3 regular encounters** — each is either a single 1×1 monster or a
     same-type pack of 1×1 monsters (e.g. 4 goblins). A pack shares one HP pool
     and counts as one encounter.
   - **1 boss encounter** — a 2×2 boss, occasionally flanked by 1×1 minions
     (all sharing one HP pool).
3. When the boss dies, a **new dungeon** is generated (new theme, layout, and
   tougher creature tier) and the formula repeats.
4. Difficulty and gold ramp **within** a dungeon (boss > encounters) and
   **across** dungeon levels.

### Attacks (how damage is dealt)

Damage is delivered through discrete **attack events**, not by applying tokens
directly:

- Every player has a **personal attack timer**: base interval ~4s plus random
  jitter, so swings desync and the battle looks like a real melee.
- On each swing, a small hit animation plays and the player deals:

  ```
  hitDamage = BASE_HIT × levelMultiplier × tokenModifier
  ```

- **`tokenModifier`** is a decaying recent-activity multiplier:

  ```
  tokenModifier = 1 + (recentEffectiveTokens / K)
  ```

  where `recentEffectiveTokens` is a rolling average over a recent window
  (~10 min). Actively using Claude raises it; going idle decays it to a **floor
  of 1.0**, so idle players still chip away with weak base attacks but engaged
  players hit much harder.

- **XP** is independent of combat: it is the player's **cumulative effective
  tokens** and only ever increases (see §5).

### Effective tokens

"Effective tokens" = `input + output + cacheCreation`. `cacheRead` is **excluded
by default** (admin can assign it a small weight) because it is automatic and
can dwarf the other types, distorting the leaderboard. The leaderboard still
displays a player's *total* tokens for bragging rights, but XP, `tokenModifier`,
and damage use effective tokens.

## 3. Screen layout & rendering

- **Resolution:** render 4K-native (3840×2160) with automatic 1080p fallback
  (config flag). Identical gameplay; the renderer picks the integer sprite scale
  for the active resolution.
- **Split:** leaderboard sidebar on the **left at 25% width**; battlefield fills
  the remaining 75%.
  - 4K: 960px sidebar + 2880×2160 battlefield.
  - 1080p: 480px sidebar + 1440×1080 battlefield.
- **Tile grid:** the battlefield is exactly **20×15 tiles**. The generator works
  only in tile coordinates (0-19 × 0-14), resolution-independent.
- **Integer scaling (crisp pixel art, nearest-neighbor):**
  - 4K: 24×24 art × **6** = 144px tiles.
  - 1080p: 24×24 art × **3** = 72px tiles.
  - Class sprites (26×28) scale by the same factor and center on their tile,
    overflowing slightly (normal for sprites).
  - The shared boss may use a larger integer scale (e.g. ×12 = 288px, a 2×2
    footprint) so bosses loom over heroes.
- **Theme:** wall tiles border both the battlefield and the leaderboard panel to
  tie them together visually.

### Leaderboard rows

Each row shows: avatar, character name, level, a token/XP progress bar, gold, and
the current `tokenModifier` (damage modifier). Rows auto-size to fit 10-20
players in the sidebar height. Sorting default: by effective tokens
(configurable, e.g. by damage this fight).

### Monster-defeat popup (~2 min, admin-configurable)

Overlays the center of the battlefield before the next encounter spawns:

- Monster name + portrait, "Defeated!" banner.
- Total damage dealt; **per-player damage bars with %**.
- **Gold awarded** to each player (by damage share).
- Tokens spent by the party during the fight.
- Fight duration (active time).
- **MVP** (top damage).
- Any **level-ups** that occurred during the fight.
- A fun flavor stat (e.g. "Biggest single strike", "First blood").

### Idle/pause overlay

When the dungeon is paused (see §6), the battlefield shows a subtle
"⏸ The dungeon rests… awaiting adventurers" overlay.

## 4. Procedural dungeon generation

Generated per dungeon level into the 20×15 grid. Inspired by the Oryx mockup
sheet (`assets/oryx_16-bit_fantasy_1.1/oryx_16bit_mockup.png`).

- **Theme** chosen per dungeon (e.g. Stone Crypt / Cave / Wood Fort), selecting
  matching wall + floor tilesets so the TV looks different each level.
- **Room:** a 1-tile wall border with 2-4 **doors** (gaps in the wall),
  leaving an 18×13 interior of floor tiles.
- **Floor pass:** scatter variant floor tiles and occasionally lay a
  rug/mosaic in the center as a "battle arena."
- **Decor pass:** place wall torches and interior props (barrels, pillars,
  chests, bones, pots) on floor tiles, avoiding collisions with heroes and the
  monster. Pillars may act as light obstacles heroes path around.
- **Tile classification:** at build time, identify which `world_24x24` sliced
  tiles are floor vs wall vs decor (curated into a tile manifest committed to the
  repo).
- **Seed-based:** a dungeon is fully described by `(dungeonLevel, theme, seed)`
  and regenerates identically — no need to persist individual tiles.

### Hero & monster placement

- Heroes are placed on interior floor tiles (spread out; avoid stacking).
- Encounter monster(s) spawn on floor tiles, the boss occupying a 2×2 footprint.
- Hero/monster positions are cosmetic (the game is not a tactical grid combat);
  attacks resolve via timers regardless of position, but a brief
  "step toward target" animation on swing sells the action.

## 5. Progression formulas (all admin-tunable defaults)

- **XP** = cumulative effective tokens.
- **Level-up cost** (geometric growth — each level harder):

  ```
  tokensForLevel(L → L+1) = BASE × GROWTH^(L-1)
  defaults: BASE = 50_000, GROWTH = 1.5
  ```

- **Level damage multiplier:**

  ```
  levelMultiplier(L) = 1 + 0.10 × (L - 1)      # L10 ≈ 1.9×
  ```

- **Monster HP (auto-calibrating to active throughput):**

  ```
  HP = activeTokenRate × targetBattleMinutes × difficultyFactor
  ```

  - `activeTokenRate` = rolling average of party effective-token inflow over
    recent **active (unpaused)** time.
  - `targetBattleMinutes` = admin slider (default ~30, within the 20-40 window).
  - `difficultyFactor` ramps per encounter index within a dungeon and per dungeon
    level; bosses get an extra multiplier (default 3×).
  - HP is computed at encounter spawn and persisted.

- **Gold on kill:**

  ```
  goldPool = round(maxHP × dungeonLevel × GOLD_FACTOR)
  player_gold = goldPool × (player_damage / total_damage)
  ```

Admin settings expose: `BASE`, `GROWTH`, level-multiplier slope, `BASE_HIT`,
attack interval + jitter, `K` (token-modifier scale), `targetBattleMinutes`,
difficulty ramp, boss multiplier, `GOLD_FACTOR`, `cacheRead` weight, popup
duration, `PAUSE_AFTER` (default ~15 min).

## 6. Off-hours pause & throughput balancing

- **Inactivity pause:** if no effective tokens arrive office-wide for
  `PAUSE_AFTER` (default ~15 min), the dungeon **freezes** — attack timers, HP,
  and the battle clock stop. The first incoming token **resumes** it. Nights and
  weekends pause automatically. The default exceeds the ~10-min token-modifier
  window so every player's `tokenModifier` has decayed to its 1.0 floor before
  the freeze, leaving no inflated modifiers hanging at pause.
- **Active-time accounting:** "battle length" and the `activeTokenRate` used for
  HP calibration are measured over **unpaused** time only, so off-hours never
  skew difficulty. A battle remains a ~30-minute *engagement* even if it spans a
  full workday.

## 7. Token ingestion (Claude Code → server)

- Players enable Claude Code OpenTelemetry and point it at the Pi. The server
  exposes an OTLP receiver at **`POST /v1/metrics`** accepting **`http/json`**
  (no protobuf dependency; we control the env block we hand out).
- The server parses the `claude_code.token.usage` counter (an OTLP `sum` with
  per-data-point `type` attribute = `input`/`output`/`cacheRead`/`cacheCreation`),
  and routes each export by a **custom resource attribute** the player sets:
  `claude_rpg_token=<their auth token>` (carried on `resourceMetrics[].resource`).
  Per export, **effective tokens = input + output + cacheCreation** (+
  `cacheRead × cache_read_weight`, default weight 0).
- **Counter temporality (robust to both modes):** the counter is reported
  cumulatively by default. The snippet sets
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` so each export carries
  the *increment*, but the server does **not** rely on that — it reads each
  metric's `aggregationTemporality`: **delta** data points are applied directly;
  **cumulative** data points are diffed against a small `metric_series` table
  (last value per `token|type|model|startTimeUnixNano`, with counter-reset
  handling) to recover the increment. Either configuration yields correct counts.
- Each ingested increment updates the player's `total_tokens`, `effective_tokens`
  (XP), and `last_token_at`, and appends a `token_events` row that the game engine
  (Plan C) reads to compute the recent-activity `tokenModifier`. Unknown tokens
  and **disabled** players are ignored. The endpoint always returns `200 {}`
  (OTLP success), accepts `application/json` (gzip-inflated if sent), and never
  lets a malformed body crash the server.
- **Player setup snippet** (generated per player on the character sheet, with the
  token baked in):

  ```bash
  export CLAUDE_CODE_ENABLE_TELEMETRY=1
  export OTEL_METRICS_EXPORTER=otlp
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://claude-rpg.local:PORT
  export OTEL_METRIC_EXPORT_INTERVAL=5000        # ~5s, near real-time
  export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
  export OTEL_RESOURCE_ATTRIBUTES=claude_rpg_token=<AUTH_TOKEN>
  # easy opt-out / opt-in while on-network:
  rpg_off() { export CLAUDE_CODE_ENABLE_TELEMETRY=0; }
  rpg_on()  { export CLAUDE_CODE_ENABLE_TELEMETRY=1; }
  ```

- **Off-network = automatic:** OTEL export is fire-and-forget; if the Pi is
  unreachable it silently drops with no effect on the player's Claude session.
  The endpoint uses the Pi's **mDNS name** (`claude-rpg.local`, via Avahi) so it
  only resolves/connects on the office LAN.
- **Connection status:** the server records per-player "last token received";
  the character sheet shows a connected/last-seen indicator.

## 8. Web application

One Node.js + TypeScript server hosts all of the below over the office LAN.

### Registration (public)

- Create a character: **free-text name** + pick one of the **18 class avatars**
  from `creature_key.doc` (Knight / Thief / Ranger / Wizard / Priest / Shaman /
  Berserker / Swordsman / Paladin, each M or F).
- On creation the server issues an **auth token** and displays the personalized
  setup snippet (§7).

### Character sheet (auth = the player's token)

The token is the player's "login." Once entered they can:

- View their stats (level, XP/effective tokens, total tokens, gold, damage
  modifier, connection status).
- Rename their character.
- Delete their character.
- Copy their setup snippet again.
- (Phase 2) Spend gold in the shop.

### Admin panel (master username + password)

- List all players; edit (name, class, level, gold, token reset) and delete via
  forms.
- Disable/enable a player's contribution.
- Tune all game settings (§5 sliders), pause/resume the game, force-regenerate
  the dungeon, view live stats.

### Real-time

- The TV kiosk page receives state via **WebSocket** (attacks, HP, kills,
  level-ups, popups, dungeon regen, pause).

## 9. Architecture

- **Single Node.js + TypeScript process** on the Pi:
  1. OTLP ingest (`POST /v1/metrics`, http/json).
  2. Game engine (tick loop: attack resolution, HP, kills, encounter/dungeon
     progression, gold, pause).
  3. Web app (registration, character sheet, admin) — server-rendered or light
     SPA.
  4. WebSocket push to the kiosk.
- **Storage:** SQLite (WAL mode), single file.
- **TV rendering:** PixiJS (WebGL, batched sprites, nearest-neighbor scaling) for
  crisp 4K pixel art.
- *Alternative considered:* Python/Pygame — rejected; Node lets one language
  drive the browser kiosk and serve the websites.

### Data model (sketch)

- `players(id, name, class_key, gender, auth_token, level, total_tokens,
  effective_tokens, gold, recent_tokens_state, last_token_at, disabled,
  created_at)`
- `dungeons(id, level, theme, seed, created_at)`
- `encounters(id, dungeon_id, index_in_dungeon, kind {single|pack|boss},
  creature_key, footprint, max_hp, current_hp, status, started_at, ended_at)`
- `encounter_damage(encounter_id, player_id, damage_total, hits, max_hit)` —
  aggregated per-player damage for a fight (gold split, MVP, biggest-strike);
  one row per player per encounter (upserted), not one per swing
- `level_ups(id, player_id, new_level, ts)` — records level-ups so a defeat
  popup can show which players levelled during the fight
- `token_events(id, player_id, ts, effective_delta, total_delta)` — per-ingest
  token increments; the engine sums recent rows for the `tokenModifier`
- `metric_series(series_key, last_value, updated_at)` — last cumulative counter
  value per series, to recover increments when temporality is cumulative
- `settings(key, value)` — all tunable knobs
- `game_state(singleton: current_dungeon_id, current_encounter_id, paused,
  paused_at, last_activity_at)`

### Durability (power loss)

- WAL-mode SQLite with write-through persistence: player stats and gold on every
  change; encounter `current_hp` snapshotted every few seconds; `game_state` on
  every transition.
- The map regenerates from `(level, theme, seed)`.
- On boot the engine loads `game_state` and resumes mid-fight (≤ a few seconds
  lost).

## 10. Pi 5 deployment (kiosk)

- Raspberry Pi OS (Bookworm, 64-bit). A dedicated user with **auto-login**.
- A **systemd service** starts the Node server on boot.
- **Chromium launches in `--kiosk`** pointed at `http://localhost:PORT` (the
  battlefield page) once the server is healthy.
- **Avahi** publishes `claude-rpg.local` for player connections and admin access.
- Admin reaches the panel from a laptop at `http://<pi-ip-or-claude-rpg.local>:PORT/admin`.
- A setup script + README cover OS config, auto-login, the service, and Chromium
  kiosk autostart (Wayland/labwc).

## 11. Assets

- Source: `assets/oryx_16-bit_fantasy_1.1/Sliced/`.
- `world_24x24` (1784) → tiles; curated into a committed manifest tagging
  floor/wall/decor and theme groupings.
- `creatures_24x24` (396) + `creature_key.doc` → monsters; mapped to a
  difficulty ladder (slimes/rats/bats → goblins/orcs → trolls/golems →
  dragons/demons/Death). Indices 1-18 are the hero classes.
- `classes_26x28` (49) → player avatars (or the 24×24 hero-class creatures —
  whichever reads better; decided during the art-integration task).
- `items_16x16` (308) → decor now; shop items in Phase 2.

## 12. Phasing

- **Phase 1 (this spec):** full core game — ingestion, progression, combat,
  procedural dungeons, leaderboard, defeat popups, gold accrual, registration /
  character sheet / admin, Pi kiosk, durability, pause.
- **Phase 2:** shop website, temporary damage potions, persistent items/armor.
- **Phase 3:** richer procedural dungeons (multi-room/corridors/treasure), more
  visual flair.

## 13. Open implementation details (resolved during planning/build)

- Curate the `world_24x24` tile manifest (floor/wall/decor per theme).
- Map the creature difficulty ladder and pack/boss assignments per tier.
- Choose hero avatar sprite set (`classes_26x28` vs hero-class creatures).
- Exact OTLP `http/json` payload parsing and resilience.
- Chromium kiosk autostart specifics on the current Pi OS release.

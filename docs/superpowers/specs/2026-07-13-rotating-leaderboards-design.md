# Rotating Leaderboards — Design (2026-07-13)

Backlog **#8**. Replace the single static TV leaderboard with a set of computed
boards, rotating a curated 6 on the TV every ~30s with bigger text and per-board
stats. All boards are computed by one module so the rest can be surfaced
elsewhere later (a web page, admin) without recomputation.

## Scope

- One domain module computes **all 14 boards** from existing data (+ one new
  `peak_modifier` column).
- The TV **rotates 6** of them; the full set ships in the same payload for future
  surfaces (not rendered on the TV in this build).
- Delivery is a **separate slow SSE event**, decoupled from the per-tick `state`.
- Out of scope: the "somewhere else" web page for the non-rotated boards (future);
  per-board admin config of the rotation set (rotation set is a code constant).

## The boards

`src/domain/leaderboards.ts` → `buildLeaderboards(db, now, cfg)` returns an
ordered array of boards. **Disabled players are excluded from every board.**
Each board is ranked value-desc, ties broken by name asc.

| key | title | format | source |
|-----|-------|--------|--------|
| `overall_tokens` | Overall Tokens | tokens | `players.effective_tokens` |
| `total_damage` | Total Damage | damage | `SUM(encounter_damage.damage_total)` per player |
| `gold` | Gold on Hand | gold | `players.gold` |
| `level` | Level | level | `players.level` (tiebreak effective_tokens desc) |
| `monsters_slain` | Monsters Slain | count | `COUNT(DISTINCT encounter_id)` in `encounter_damage` joined to defeated encounters |
| `mvp_count` | MVP Count | count | # defeated encounters where the player has the max `damage_total` |
| `biggest_hit` | Biggest Hit | damage | `MAX(encounter_damage.max_hit)` per player |
| `on_fire` | On Fire Now | multiplier | `tokenModifier(activityScore(db,pid,now,cfg), cfg.tokenModifierK)` per player |
| `peak_multiplier` | Highest Multiplier | multiplier | `players.peak_modifier` (new column) |
| `today_tokens` | Today's Tokens | tokens | `SUM(effective_delta)` where `ts >= startOfLocalDay(now)` |
| `week_tokens` | This Week's Tokens | tokens | `SUM(effective_delta)` where `ts >= startOfLocalWeek(now)` (Mon 00:00 local) |
| `days_champion` | Days as Champion | count | per local calendar day, the top token user "wins"; count wins per player |
| `most_battered` | Most Battered | count | `COUNT(monster_attacks)` per player |
| `most_gold_stolen` | Most Robbed | gold | `SUM(gold_delta)` where `kind='gold'` per player |

**TV rotation (in order):** `overall_tokens` → `total_damage` → `gold` →
`on_fire` → `days_champion` → `most_battered`.

### Board entry shape

```ts
export type BoardFormat = 'tokens' | 'gold' | 'count' | 'multiplier' | 'damage' | 'level';
export interface BoardEntry { playerId: number; name: string; avatarUrl: string; value: number; }
export interface Leaderboard { key: string; title: string; format: BoardFormat; entries: BoardEntry[]; }
export type Leaderboards = Leaderboard[]; // all 14, stable order
```

`avatarUrl` is built with `classSpriteUrl(class_key, gender)` (same as
`buildTvState`). The client formats `value` by `format`.

### Windowed / day computations (timezone-safe + testable)

`today_tokens`, `week_tokens`, and `days_champion` are computed in JS from
`token_events` (one query over a **90-day lookback** — `ts >= now - 90*86400000`),
NOT via SQL `localtime`, so they are deterministic given `now` + the server's
timezone:

- `startOfLocalDay(now)` / `startOfLocalWeek(now)` are computed with `new Date(now)`
  (explicit arg — allowed; only the arg-less form is avoided) using local fields.
- `days_champion`: bucket each event by its local calendar day
  (`new Date(ts)` → `YYYY-MM-DD`), sum per (player, day), take each day's argmax as
  that day's champion, count championships per player.

`overall_tokens`/`gold`/`level` read `players` directly (all-time, cheap). Damage
boards aggregate `encounter_damage`. `on_fire` reuses `activityScore`.

## New persistence — `peak_modifier`

Migration `006_peak_modifier`: `ALTER TABLE players ADD COLUMN peak_modifier REAL
NOT NULL DEFAULT 1`. The engine updates it in the per-player swing branch: after
computing the activity modifier `am = tokenModifier(score, cfg.tokenModifierK)`
(the player's own power, **excluding** the monster debuff), run
`UPDATE players SET peak_modifier=? WHERE id=? AND peak_modifier < ?` with `am`.
This is the one board needing new state; everything else derives from existing
tables. (The `on_fire` board shows the *current* `am`; `peak_multiplier` shows its
all-time max.)

## Delivery — a separate `leaderboards` SSE event

The per-tick `state` event (HP, positions, attacks — latency-sensitive) stays
lean. Leaderboards ride their own slower channel:

- `TvHub.broadcastLeaderboards(now)` — builds `buildLeaderboards(db, now,
  loadEngineConfig(db))`, frames it as `event: leaderboards`, writes to all
  clients (skips if no clients).
- `TvHub.addClient` also sends one `leaderboards` frame on connect (so a board
  shows immediately, not after the first interval).
- `index.ts` adds a second interval calling `tvHub.broadcastLeaderboards(Date.now())`
  every **15000 ms**; the graceful-shutdown path clears it alongside the tick timer.

Rationale: the day-grouping and damage-sum queries are heavier than the 1s state
build and don't need 1s latency. (Alternatives rejected: folding into every
`state` tick — wasteful; server-driven rotation — client rotation is smoother.)

## TV rotation UI (`src/web/public/tv/tv.js`)

- New `EventSource` listener for `leaderboards` → store the array.
- `drawLeaderboard` rewritten to render ONE active board: a bigger **title**
  (e.g. "TOP DAMAGE"), then ranked rows — **rank number**, avatar, name, and the
  board's stat formatted by `format` (tokens/damage → `fmt` K/M/B; gold → `fmt`+`g`;
  multiplier → `×2.34`; count/level → integer). Rows fill the sidebar as today,
  bigger.
- **Rotation:** a module-level `ROTATION` = the 6 keys above; advance the active
  index every `ROTATE_MS = 30000` (driven off the render `t` clock). On switch, a
  short **crossfade** (alpha dip ~0.4s) so it doesn't hard-cut. If the
  `leaderboards` payload hasn't arrived yet, show the header only (no crash).
- A subtle rotation indicator (e.g. `• • ●` dots for position in the cycle) at the
  bottom of the sidebar.
- Value formatting mirrors the existing `fmt` helper; `×`-multiplier and rank
  formatting are added inline (tv.js stays a dependency-free classic script).

## Configuration

- `ROTATE_MS` (30s) and the `ROTATION` key list: constants in `tv.js` (one spot to
  reorder/reselect the six later).
- Leaderboard broadcast cadence (15s): constant in `index.ts`.
- No new admin settings in this build (rotation is not yet operator-tunable —
  noted as a possible future setting).

## Testing

- `tests/leaderboards.test.ts` — seed players + `token_events` +
  `encounter_damage` + `encounters(defeated)` + `monster_attacks`; assert each
  board's ordering and values, tie-breaking (name asc), disabled-player exclusion,
  and window boundaries (today/week: an event just inside vs just outside;
  days_champion: two days with different winners → correct counts).
- `tests/db-peak-modifier-migration.test.ts` — column exists, defaults to 1.
- Engine: extend an existing engine test (or add one) asserting `peak_modifier`
  rises to the activity modifier after a high-activity swing and never decreases.
- `tvhub`: `addClient` emits a `leaderboards` frame on connect;
  `broadcastLeaderboards` writes to clients.
- `tv.js`: controller visual-verify of the rotation on the live TV (bigger text,
  titles, correct stats per board, crossfade), consistent with prior TV builds.

## Deliberate decisions

- Disabled players are excluded from all boards (they're not competing).
- `peak_modifier` tracks the activity modifier only (excludes the monster debuff),
  so it reads as "how hard were you grinding," not "were you debuffed."
- Day boundaries use the **server's local time** (the Pi runs EDT) — correct for an
  office TV; computed in JS for determinism + testability.
- The full 14-board payload ships every ~15s even though the TV shows 6, so future
  surfaces reuse the same computation with zero extra work.

## Files touched

- `src/domain/leaderboards.ts` — new: `buildLeaderboards` + types + all 14 boards.
- `src/db/migrations.ts` — `006_peak_modifier`.
- `src/domain/engine.ts` — update `peak_modifier` in the swing branch.
- `src/web/tvhub.ts` — `broadcastLeaderboards` + on-connect `leaderboards` frame.
- `src/index.ts` — 15s leaderboards interval + shutdown cleanup.
- `src/web/public/tv/tv.js` — `leaderboards` listener + rotating `drawLeaderboard`.
- Tests: `leaderboards`, peak-modifier migration, engine peak, tvhub.

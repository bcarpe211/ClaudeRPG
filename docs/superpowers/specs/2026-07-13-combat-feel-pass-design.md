# Combat Feel Pass — Design (2026-07-13)

Backlog items **#3** (attack animation direction) and **#5** (monsters attack
back). A focused pass to make live `/tv` combat read as a real fight: heroes
lunge *at* the monster, and the monster strikes back with visible, minor
consequences.

## Scope

- **#3 — Attack lunge toward the monster.** In scope. Client-only.
- **#5 — Monster attacks back.** In scope. New mechanic + FX.
- **#2 — Gender → class sprite.** Already done (verified): `players.gender` is
  stored at registration and `classSpriteUrl(class_key, gender)` drives the
  battlefield sprite, so female variants already render. Backlog checkbox is
  stale; tick it, no work.
- **#4 — Class-specific attacks (mage fireball, etc.).** Out — later phase.

## Part 1 — Attacks lunge toward the monster (#3)

**Problem.** `tv.js drawHeroes` nudges a swinging hero *downward*
(`groundY + lunge * tilePx`, `lunge = 0.25`). When the monster is above or beside
the hero, the lunge points the wrong way.

**Design.** Pure `src/web/public/tv/tv.js` change — no server or view-model
change. On a swing, compute the unit vector from the hero's tile centre to the
monster's tile centre (both already in the `layout` payload: monster at
`layout.monster` with `footprint`, hero at `p.x/p.y`) and offset the drawn
sprite along it by ~0.25 tile. Zero-length guard (hero on the monster tile →
fall back to no offset). The same helper drives the monster's recoil in Part 2.

Monster centre: `layout.monster.x + footprint/2`, `layout.monster.y + footprint/2`.
Hero centre: `p.x + 0.5`, `p.y + 0.5`.

## Part 2 — Monster attacks back (#5)

### Mechanic (engine)

The engine gains a monster attack timer alongside the per-player `nextAttackAt`
timers. It fires every `monster_attack_interval_ms` (default **15000**) ±
`monster_attack_jitter_ms` (default **5000**), scheduled the same way player
swings are (`scheduleNext` pattern). Gated by `monster_attacks_enabled` (default
on). The timer only runs while there is an active encounter and the game is not
paused (it lives inside the same active-encounter block as player swings, and is
cleared on the paused→active transition like `nextAttackAt`).

On fire, with injected `rng`:

1. **Pick a target** — a uniformly random *enabled* player. (In a <24-person
   office every enabled player has a battlefield slot, so the FX always has
   somewhere to land. If a target has no slot, the consequence still applies and
   the TV simply skips the visual.)
2. **Roll a consequence** — 50/50 gold vs debuff:
   - **Gold loss** — steal `min(currentGold, monster_gold_steal)` (default steal
     **5**); `UPDATE players SET gold = gold - steal`. **If the player has 0 gold,
     re-roll to debuff** so a hit always lands something.
   - **Damage debuff** — a transient penalty: the player's swing damage is
     multiplied by `monster_debuff_factor` (default **0.85**) for
     `monster_debuff_seconds` (default **8**).
3. **Log it** — insert a row into `monster_attacks` (durable; see below).

**Debuff is derived from the log, not held in memory.** A pure helper
`debuffFactor(db, playerId, now, cfg)` returns `monster_debuff_factor` if a
`kind='debuff'` row exists for the player with `ts >= now -
monster_debuff_seconds*1000`, else `1`. This mirrors how `activityScore` derives
from `token_events`: one source of truth, restart-safe, and naturally handles
two players debuffed at once. Non-stacking (any debuff row in the window → one
flat factor). Used by **both** the engine swing loop (multiplies the swing) and
`buildTvState` (the badge), so the penalty and the badge can never disagree.

Debuff application: in `GameEngine`'s per-player swing loop, after computing the
activity modifier, multiply by `debuffFactor(...)`.

### Data model — `monster_attacks` log table

Durable log (migration `005_monster_attacks`), chosen over game_state columns so
a future "most-battered player" leaderboard (#8) has data:

```sql
CREATE TABLE monster_attacks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id INTEGER NOT NULL,
  player_id    INTEGER NOT NULL,
  kind         TEXT NOT NULL,          -- 'gold' | 'debuff'
  gold_delta   INTEGER NOT NULL DEFAULT 0,  -- gold stolen (0 for debuff)
  ts           INTEGER NOT NULL,
  FOREIGN KEY (encounter_id) REFERENCES encounters(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);
CREATE INDEX idx_monster_attacks_encounter ON monster_attacks (encounter_id);
```

Deploy note: migration is additive and applies on next Pi start (existing
migration runner is id-based). No data backfill.

### View-model (tvview.ts)

`buildTvState` reads the latest `monster_attacks` row for the *current*
encounter (`ORDER BY id DESC LIMIT 1`) and adds to `TvState`:

```ts
monsterAttack: { id: number; playerId: number; kind: 'gold' | 'debuff';
                 amount: number } | null
```

`null` when there is no encounter or no attack yet this encounter. The `id` is
the fire-once handle for the TV (drives the one-shot impact animation).

Separately, each `TvHero` gains a **`debuffed: boolean`** — `debuffFactor(db,
p.id, now, cfg) < 1` — so the TV can show a persistent badge on every currently
debuffed hero (concurrency-safe; not tied to the single latest event).

### Visuals (tv.js)

On a `state.monsterAttack` whose `id` differs from the last one animated (same
detect-on-change pattern as swing floaters), start a transient effect keyed to
the target player for ~350ms:

- **Monster lunge** — in `drawMonster`, while the effect is active, offset the
  monster toward the target player's tile and recoil back (reuses the Part 1
  direction helper).
- **Hero flinch** — the target hero flashes red (tint/overlay) and recoils a
  little away from the monster.
- **FX sprite** over the target hero, 2-frame animated for the effect's life:
  - gold loss → gold star burst: `/sprites/fx_32x32/oryx_16bit_fantasy_fx_83.png`
    → `_84.png`
  - debuff → red X-slash: `/sprites/fx_32x32/oryx_16bit_fantasy_fx_11.png`
    → `_12.png`
  - (fx_32x32 tiles are 32px source; drawn scaled, loaded as individual images
    like class sprites, preloaded on first use)
- **Floater** — `-Ng` in gold for a steal (skip if amount 0), `WEAKENED` for a
  debuff.

Separately, a **persistent debuff badge**: for every hero with `debuffed=true`,
draw a small red "!" glyph
(`/sprites/fx_24x24/oryx_16bit_fantasy_fx2_45.png`) pinned to the **top-right
corner** of the avatar at ~40% avatar size, for the whole time the debuff is
active. This is independent of the one-shot impact animation (it stays up ~8s
while the flash lasts ~350ms).

FX are served by the existing `/sprites` static mount over the Sliced dir
(`config.spritesDir`), same as `creatures_24x24`.

### Settings + metadata

New knobs (each needs a `SETTINGS_META` entry — the coverage test fails the
build otherwise), grouped under a new **"Monster retaliation"** group in
`settings-meta.ts` / `GROUP_ORDER`:

| key | default | meaning |
|-----|---------|---------|
| `monster_attacks_enabled` | `1` | master on/off for monster retaliation |
| `monster_attack_interval_ms` | `15000` | base time between monster strikes |
| `monster_attack_jitter_ms` | `5000` | ± jitter on the strike interval |
| `monster_gold_steal` | `5` | max gold a strike steals |
| `monster_debuff_factor` | `0.85` | swing-damage multiplier while debuffed |
| `monster_debuff_seconds` | `8` | debuff duration |

Added to `DEFAULT_SETTINGS`; `seedSettings` INSERT-OR-IGNORE picks them up on
next start. `EngineConfig` / `loadEngineConfig` gain the same fields.

### New module

`src/domain/retaliation.ts` — small unit-tested helpers (the first three pure,
`debuffFactor` log-derived), keeping `engine.ts` lean:
- `pickTarget(players, rng)` — uniform random enabled player (or null if none).
- `rollConsequence(rng)` — `'gold' | 'debuff'`.
- `goldSteal(currentGold, max)` — `min(currentGold, max)`, ≥ 0.
- `debuffFactor(db, playerId, now, cfg)` — `monster_debuff_factor` if a
  `kind='debuff'` row is within the window, else `1`.

`engine.ts` owns only the transient timer (`nextMonsterAttackAt`), the
consequence application (gold UPDATE), and the `monster_attacks` insert. No
in-memory debuff state — the debuff lives in the log and is read back via
`debuffFactor`.

## Determinism & testing

The engine already takes injected `rng` + `now`, so all of this is
deterministic and testable:

- **retaliation.ts** — pure/derived helpers (target pick, consequence roll,
  gold-steal, `debuffFactor` from the log).
- **engine** — monster attacks fire on schedule; gold consequence decrements
  `players.gold` (floored at balance) and logs a row; broke player re-rolls to
  debuff; a logged debuff reduces subsequent swing damage within the window and
  stops reducing it after; `monster_attacks_enabled=0` suppresses everything.
- **tvview** — `buildTvState` surfaces the latest `monsterAttack` for the active
  encounter (`null` otherwise) and sets `debuffed` on heroes inside the window.
- **tv.js** — controller visual-verify via headless Chrome (fire-on-id-change,
  correct FX per kind), consistent with prior TV builds.

## Deliberate scope decisions

- The debuff is **not** reflected in the leaderboard modifier column — it reduces
  real swing damage (engine) and shows the corner badge, but the board's modifier
  stays base activity. Keeps that column meaning one thing; the debuff is about
  the hit *feeling* real, not board accuracy.
- Debuff is non-stacking: overlapping debuff hits don't compound (one flat
  factor while any debuff row is in the window). Keeps it minor by design.
- Only the *latest* monster attack per encounter drives the one-shot impact
  animation; the persistent badge is per-hero from the window; the full log is
  retained for future stats, not replayed on the TV.
- No player HP is introduced (consistent with the existing design); consequences
  stay minor (a little gold / a small brief debuff).

## Out of scope

- #4 class-specific attack visuals (later phase).
- A "most-battered" leaderboard view (the log table enables it; building it is
  #8 work).
- Reflecting the debuff on the leaderboard.

## Files touched

- `src/db/migrations.ts` — `005_monster_attacks`.
- `src/domain/settings.ts` — 6 new defaults.
- `src/domain/settings-meta.ts` — 6 new meta entries + "Monster retaliation" group.
- `src/domain/encounters.ts` — `EngineConfig` + `loadEngineConfig` new fields.
- `src/domain/retaliation.ts` — new pure helpers.
- `src/domain/engine.ts` — monster attack timer, consequence apply, log insert, `debuffFactor` in the swing loop.
- `src/web/tvview.ts` — `TvState.monsterAttack` + `TvHero.debuffed` + queries.
- `src/web/public/tv/tv.js` — #3 lunge direction; #5 monster lunge, hero flinch,
  impact FX, floater, persistent red "!" debuff badge.
- Tests: `retaliation` (incl. `debuffFactor`), engine, tvview.

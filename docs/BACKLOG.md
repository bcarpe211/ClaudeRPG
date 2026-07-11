# ClaudeRPG — Backlog

Observed-in-play items to tackle one by one. Logged 2026-06-27 after the
Phase B (token ingestion) checkpoint confirmed the dungeon wakes and spawns
encounters from token credit.

Reference: the oryx 16-bit fantasy tileset under
`assets/oryx_16-bit_fantasy_1.1/` (loaded at runtime via `spritesDir`).

---

## 1. Art curation — tile & creature catalog
Build an understanding of what each tile and creature sprite means and how to
use it. Produce a reference/manifest mapping sprites to meaning so the rest of
the visual work (decorations, class variants, lively floors) can draw from it.
This likely underpins items 6 and 7.
- [ ] Catalog tiles (`world_24x24`, etc.) — meaning + intended use
- [ ] Catalog creatures (`creatures_24x24`) — meaning + intended use

**Finding (2026-06-29, via the `/catalog` tool):** `creatures_24x24` is a 22×18 = 396
sheet of **animation A/B pairs** — odd rows (files 1–18, 37–54, 73–90, …) are the
real creatures (frame A); each even row is the **same creature's animation frame
(frame-A index + 18)**. Verified visually: #1↔#19, #37↔#55, #217↔#235. This is the
mechanism behind the offset bug: the current naive `name[i] → file i+1` mapping
assigns names straight down all 396 files, so every B-frame row gets a wrong name
and everything shifts. `creature_key.doc` is only a rough guide — its blank-line
sections are thematic groups of irregular size (18,18,18,18,36,36,18,18,18), it
lists animation frames as near-duplicate entries, and it omits the 18 class
B-frames (files 19–36). Phase-2 fix: pin names to the **frame-A files** visually
via the catalog (treat B-frames as animation dupes, not separate creatures), then
fix `MONSTER_TIERS`/`BOSSES` against the corrected mapping.
- [ ] Phase 2: teach the catalog about A/B frames (label/dim B-frames, show the
      `+18` animation partner) so only the ~198 real creatures need naming
- [ ] Phase 2: correct `spritenames.ts` / the name→file mapping to frame-A files
- [ ] Phase 2: fix `MONSTER_TIERS`/`BOSSES` to real creature indices

## 2. Gender selection drives creature/class sprites
Choosing gender at registration should select the correct class sprite variant.
There are female versions of each class; currently only male variants are shown.
- [ ] Wire gender choice → correct class sprite variant (male/female)

## 3. Attack animation direction
Attacks currently only nudge downward a little, which looks wrong when the
monster is above the player. The animation should move *toward* the monster
regardless of relative position.
- [ ] Direct attack animation toward the monster's position

## 4. Class-appropriate attack animations *(possibly a later phase)*
Different classes get visually distinct attacks — e.g. mages shoot a fireball
that explodes on the monster, etc.
- [ ] Per-class attack visuals (mage fireball + explosion, etc.)

## 5. Monsters attack back
Monsters should attack a random player. Since there is no player HP, the hit
should affect something else minor — e.g. remove a couple gold, or lower the
player's damage modifier by an insignificant amount.
- [ ] Monster retaliates against a random player
- [ ] Define the (non-HP) consequence (small gold loss / tiny damage-mod debuff)

## 6. Dungeon decorations
The dungeon layout needs more decorations, using the oryx tileset for
inspiration. (Depends on item 1.)
- [ ] Add decorative tiles to dungeon layout

## 7. Lively, colorful dungeon floor
The floor should be lively and colorful so the whole thing reads like a really
nice wallpaper. (Covered largely by art curation, item 1.)
- [ ] Make floor visually rich / wallpaper-quality

## 8. Leaderboard improvements
Larger text and better showcasing of player stats — current token-usage streak
and other fun things. Consider rotating the leaderboard every ~30s through
different views:
- [ ] Larger leaderboard text
- [ ] Show more/better player stats (e.g. current token-usage streak)
- [ ] Rotating leaderboards (~30s): daily win streaks, daily token usage,
      overall leaderboard, and other fun leaderboards

## 9. Damage modifier should not decay during active play
The "damage modifier" is `tokenModifier = 1 + recent/k` (`src/domain/combat.ts`),
where `recent` = effective tokens within a **trailing rolling window**
(`recent_window_minutes`, default 10) summed via `sumEffectiveSince`
(`src/domain/engine.ts`, `src/domain/encounters.ts`). Because the window slides,
tokens older than the window continuously drop off — so the modifier decays
*while the player is still actively burning tokens*, which caps the big numbers
from ever landing on the monster.

Desired: while there is token activity, the modifier should hold/accumulate; it
should only start decaying after a configurable threshold of **token
inactivity**.
- [ ] Add a setting, e.g. `decay_after_minutes` (minutes of no tokens before
      decay begins), with a sensible default
- [ ] Rework the modifier so it does not shrink during continuous activity —
      only after `decay_after_minutes` of inactivity (design: track modifier as
      decaying state keyed off `last_token_at`, vs. the pure sliding window)
- [ ] Make sure this composes with the existing office-idle pause

## 10. Public landing page
Visitors to the site (the registration/root page) need a real landing page that
explains what the game is, how it works, and — importantly — that it **only
reflects Claude Code token usage** (nothing else is tracked/affected).
- [ ] Landing page with game description + "what this does / doesn't do"
- [ ] Clarify scope: affects only Claude Code usage; how to join/register

## 11. Admin settings: human-readable descriptions
The admin settings page shows raw variable names (`base_hit`, `token_modifier_k`,
`recent_window_minutes`, etc. — see `src/domain/settings.ts`). Hard to tell what
each does or how changing it impacts the game.
- [ ] For each setting: a plain-language description of what it controls
- [ ] Show the default value and the effect/direction of changing it
- [ ] (Optional) units and sane min/max hints

## 12. Monster name flare — on-screen label with random adjective
Show the current monster's name on the TV during battle, but prefix it with a
random **dungeon-themed adjective** from a large dictionary so a plain "beetle"
reads as e.g. "flaming beetle". It does not have to make literal sense — the goal
is variety/personality. Part of a broader "add flare/diversity to names" idea.
Depends on the curated creature display names from the art-curation pass (#1) —
names must be clean, singular display labels so `<adjective> <creature>` reads
well.
- [ ] Large dictionary of dungeon-themed adjectives (e.g. flaming, cursed,
      ancient, venomous, spectral, …)
- [ ] Roll an adjective per encounter, deterministic from the encounter seed so
      it's stable across renders/reconnects
- [ ] Render the `<adjective> <creature>` label on the TV near the monster
- [ ] (Stretch) broader name flare for other entities

## 13. Animate sprites (two-frame loop) for a livelier dungeon
Every creature/class sprite in `creatures_24x24` ships as a **two-frame animation
pair**: frame A at file index N, frame B at **N + 18** (see the #1 finding). The TV
renderer currently shows a single static frame. Alternating A/B on a slow timer
would make monsters and heroes look alive. Pairs with #6/#7 (lively dungeon) and
depends on the #1 frame-A/B mapping being curated.
- [ ] Record each creature's animation partner (frame-A index + 18)
- [ ] Renderer toggles A/B frames on a timer (e.g. ~0.5–1s), independent per
      sprite or globally
- [ ] Confirm world-tile/decor sprites for any animated tiles (torches, etc.)

## 14. Modular flooring — palette tuning (data-only)
The modular flooring system (merged 2026-07-10, preview-only via `/dungeon-preview`)
works and is compat-matched, but a roster render surfaced floor-palette taste items.
All are **data edits** in `src/domain/floordata/*.json` (or the `ACCENT_RATE`/`GLOW_RATE`
constants in `src/domain/floorgroups.ts`) — no generator changes. Not player-facing yet
(live `/tv` still runs the old `dungeon.ts`); tune before/with the eventual `/tv` swap.
- [ ] `cinder_rock`'s two mains blend ~50/50 and its 2nd main ("subtle ember slab") is
      high-contrast → busy/noisy floor (seen under Oakenvault). Demote the ember slab
      from a 2nd MAIN to a sparse ACCENT.
- [ ] `crimson_mosaic` (single "checkerboard" tile) is loud as a whole-room fill and its
      compat bridges it to grey dungeons (e.g. Rustpipe Sewers). Drop it as a main, or
      restrict its compat to crimson-family dungeons only.
- [ ] Generous `good`-tier compat lists put warm floors (e.g. `oaken_flag` red slab) under
      cool/green walls (e.g. Thornwind Ruins). Tighten `good` lists if you want stricter
      per-theme color coherence.
- [ ] Many floors read dark & flat (charcoal) — ties into #7 "wallpaper-quality floor".
      Consider bumping `ACCENT_RATE`, adding accents to flat single-main groups, or biasing
      selection toward multi-main groups for within-room variation.
- [ ] (Optional) Floor choice is purely seed-driven, so two same-class dungeons at the same
      seed pick the identical floor. Cosmetic in play (each dungeon has its own seed); if
      dungeons are ever shown side-by-side, mix the dungeon id/name into the floor-pick rng.
- [ ] Follow-ups from the final code review (non-blocking): restore the spec-promised
      load-time JSON shape validation in `floorgroups.ts` (currently a test-time guard);
      the `dungeon2` decor block is dormant (all dungeons `decor:[]`); latent `pickCell`
      accent-rate quirk if a group ever has BOTH glow and normal accents.

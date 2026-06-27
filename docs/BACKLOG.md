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

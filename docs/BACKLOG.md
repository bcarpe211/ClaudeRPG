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
- [x] Phase 2: fix creature indices — DONE (2026-07-12). `MONSTER_TIERS`/`BOSSES`
      REMOVED entirely and replaced by `src/domain/bestiary.ts` (117 monsters with
      correct frame-A indices) + `src/domain/dungeonthemes.ts` (theme-gated
      selection). See the themed-bestiary spec/plan (2026-07-11).

## 2. Gender selection drives creature/class sprites ✅ DONE
Choosing gender at registration selects the correct class sprite variant.
- [x] Wire gender choice → correct class sprite variant (male/female).
      `players.gender` is stored at registration (with a live gender→sprite
      preview) and `classSpriteUrl(class_key, gender)` drives the battlefield
      sprite, so female variants render on the TV (`spriteIndexFor` = maleIndex+9
      for F). Verified 2026-07-13.

## 3. Attack animation direction ✅ DONE (2026-07-13)
Attacks now lunge *toward* the monster regardless of relative position (was a
downward nudge). Pure `tv.js` change: `dirToMonster(hx,hy)` unit-vector from the
hero tile to `layout.monster` centre; the swing offset follows it (monster recoil
in #5 reuses it). Spec/plan: `docs/superpowers/{specs,plans}/2026-07-13-combat-feel-pass*`.
- [x] Direct attack animation toward the monster's position

## 4. Class-appropriate attack animations *(possibly a later phase)*
Different classes get visually distinct attacks — e.g. mages shoot a fireball
that explodes on the monster, etc.
- [ ] Per-class attack visuals (mage fireball + explosion, etc.)

## 5. Monsters attack back ✅ DONE (2026-07-13)
The monster strikes back every ~15s (tunable) at a random enabled player,
rolling 50/50: a small gold loss (up to `monster_gold_steal`, re-rolls to debuff
if broke) OR a brief damage debuff (`monster_debuff_factor` for
`monster_debuff_seconds`). Each hit is logged to a durable `monster_attacks`
table; the debuff is *derived from that log* (`debuffFactor`), read by both the
engine swing loop and the TV view-model (one source of truth, restart-safe,
concurrency-safe). TV shows a monster lunge, hero flinch + red flash, impact FX
(gold star / red X), a `-Ng`/`WEAKENED` floater, and a persistent red "!" badge
while debuffed. Six admin-tunable settings under a new "Monster retaliation"
group. Controller visual-verified live. Spec/plan:
`docs/superpowers/{specs,plans}/2026-07-13-combat-feel-pass*`.
- [x] Monster retaliates against a random player
- [x] Consequence: random gold loss OR damage-mod debuff (non-HP, minor)
- [ ] (Enabled by the log) future "most-battered player" leaderboard view — ties into #8.

## 6. Dungeon decorations ✅ ALL BUILDS DONE (2026-07-12)
Themed decor now renders in `/tv`. Spec/plan/reference:
`docs/superpowers/{specs,plans}/2026-07-12-dungeon-decor-floors*`, `docs/oryx_decor_reference.md`.
- [x] `src/domain/decor.ts` — ~50-tile curated library tagged by theme + placement
      (floor / corner-cobweb / wall-torch) + `walkable` flag; `decorFor(name)`.
      `dungeon2` places them (corners, wall torches, floor scatter clear of the
      2×2 monster zone); hero slots avoid non-walkable decor. Visual-verified.
- [x] **Build 2 DONE (2026-07-12):** animated decor — torches/cauldron/tomes/skull
      flip A↔animB on the shared ~600ms clock (`tv.js drawAnimDecor`; animB threaded
      dungeon2→tvlayout→payload; bake only static decor). Also delivers the decor
      half of #13. Spec/plan: `docs/superpowers/{specs,plans}/2026-07-12-animated-decor*`.
- [x] **Build 3 DONE (2026-07-12):** occasional walkable 3×3 rug centerpiece
      (themed red/blue border + heraldic crest) centered on the monster zone —
      the monster stands on the platform, framed by the border (`rugs.ts` +
      `dungeon2` placement; rides the Build 1 decor pipeline, no tv.js change).
      Spec/plan: `docs/superpowers/{specs,plans}/2026-07-12-rug-centerpieces*`.

## 17. Multi-room dungeons ✅ DONE (2026-07-12)
BSP-partitioned dungeons (2–4 rooms) with autotiled interior walls + door
connections; largest room = "arena" holding the monster + all heroes (co-op
battle stays cohesive), others decorated flavor. Spec/plan:
`docs/superpowers/{specs,plans}/2026-07-12-dungeon-rooms*`.
- [x] `pickWall` T/cross junctions (`WALL_COLS` cols 21–25); BSP partition + door
      per split (connectivity verified over 9000 seeds); `dungeon2` exposes
      `monster`+`arena`; `tvlayout` pins monster+heroes to the arena. Visual-verified.
- [ ] (Follow-ons) corridors + smaller rooms; per-room *themed* decor sets;
      interior *door* variety.

## 7. Lively, colorful dungeon floor ⏳ partial (2026-07-12)
- [x] Bumped `ACCENT_RATE` 6%→11% + conservative #14 palette tuning (cinder_rock/
      verdant_slab 2nd main→accent; accents added to a few flat groups;
      crimson_mosaic compat restricted).
- [ ] **Garish floors** seen in rooms visual pass (e.g. a bright-yellow floor group
      under Greystone) — some floor groups / compat picks read too loud; revisit
      as part of the palette tuning.
- [ ] Finish the flat-floor groups — ~12 groups still have empty `accents` (no
      confidently same-family tile found without a visual pass); enrich them for
      full "wallpaper-quality" floors. Overlaps #14.

## 8. Leaderboard improvements ✅ DONE (2026-07-13)
Rotating leaderboards with bigger text, titles, numeric ranks, and per-board
stats. Spec/plan: `docs/superpowers/{specs,plans}/2026-07-13-rotating-leaderboards*`.
- [x] Larger leaderboard text (board title + rank + avatar + stat, all scaled up).
- [x] Richer stats — `src/domain/leaderboards.ts` computes **14 boards**
      (overall/today/week tokens, total damage, biggest hit, gold, level,
      monsters slain, MVP count, on-fire multiplier, all-time peak multiplier,
      days-as-champion, most-battered, most-robbed). Delivered on a separate 15s
      SSE `leaderboards` channel (`TvHub.broadcastLeaderboards`).
- [x] Rotating views (~30s crossfade): the TV rotates **6** — overall tokens →
      total damage → gold → on-fire → days-as-champion → most-battered — with
      position dots. (Consecutive-day *streaks* were rejected — they break on
      weekends; "days as champion" is the weekend-proof count instead.)
- [ ] (Future, enabled) surface the other 8 computed boards somewhere (a web
      page / admin), and a "most-battered / most-robbed" flavor page.
- [ ] (Minor) the non-rotated `level` board uses a uniform name-asc tiebreak
      rather than `effective_tokens desc` — cosmetic; revisit if it ever shows.

## 9. Damage modifier should not decay during active play ✅ DONE (2026-07-12)
Grew into a full **combat & reward economy redesign** (spec/plan
`docs/superpowers/{specs,plans}/2026-07-12-combat-reward-economy*`).
- [x] Activity modifier is now session-**accumulate**, **uncapped**, with
      **linear** decay only after `decay_after_minutes` of token inactivity over
      `decay_span_minutes` (`src/domain/activity.ts`, pure/derived from
      `token_events` — no migration). Replaced the sliding window; feeds attack
      damage + leaderboard.
- [x] Composes with the office-idle pause (unchanged, separate mechanism).
- [x] Also landed: **HP Model A** (office baseline power × `baseline_battle_minutes`
      × depth — decoupled from wall-clock AND from activity bursts, so heavy play
      genuinely melts monsters); **diminishing level curve** (`1 + slope·ln(level)`);
      **gold split by token-usage share** (`rewards.splitGold`, tunable
      `gold_damage_weight`, default pure token; award == defeat popup); **bar-only
      HP** + **abbreviated K/M/B/T numbers** (`format.ts`).
- [ ] (Follow-up, tuning) retune on the real TV: `base_hit`, `token_modifier_k`,
      `level_curve_slope`, `baseline_battle_minutes` — pacing shifted (active
      office kills fast, quiet grinds).

## 10. Public landing page ✅ DONE (2026-07-14)
A full dungeon-corridor landing page at `/` (commit `3e05096`,
`src/web/views/landing.ejs` + `static/landing.css`): torch-lit wall border, live
boss snapshot card, nine-class picker, a 3-step "how to join" with the shell
snippet, and the scope clarification in two places.
- [x] Landing page with game description + "what this does / doesn't do" — the
      **"What it sees — and what it doesn't"** trust section (sees token
      counts/model/timestamps; never prompts/code/conversations; `rpg_off` pause).
- [x] Clarify scope: affects only Claude Code usage; how to join/register — the
      **"Claude Code only"** callout (CLI only, not API tokens or desktop/web app)
      + the 3-step register/snippet/code flow.
- [ ] (Follow-on) roll the landing design language (torch-lit wall border,
      background, torch glow, side loot-float — but *not behind content*) across
      the other pages: character login, character sheet, registration, admin,
      eventual shop/character editor. Tracked as #18.

## 11. Admin settings: human-readable descriptions ✅ DONE (2026-07-12)
Grouped, self-describing admin settings page. Spec/plan
`docs/superpowers/{specs,plans}/2026-07-12-admin-settings-descriptions*`.
- [x] Plain-language description per setting (incl. effect of raising/lowering)
      — `src/domain/settings-meta.ts` `SETTINGS_META` (all 22 knobs); a coverage
      test fails the build if a `DEFAULT_SETTINGS` key lacks metadata.
- [x] Default value shown + per-setting **reset** button (client-side).
- [x] Units + soft min/max/step hints (number inputs); grouped into 7 sections
      (`groupedSettings()` view-model + regrouped `admin-settings.ejs`). POST save
      path unchanged (inputs keep `name=<key>`).
- [ ] (Future, optional) hard server-side clamp/validation of out-of-range values
      (currently hints only).

## 12. Monster name flare — on-screen label with random adjective ✅ DONE (2026-07-12)
Show the current monster's name on the TV during battle, prefixed with a random
adjective so a plain "skeleton" reads as e.g. "Cursed Skeleton".
- [x] Adjective dictionary — `src/domain/monstername.ts` (GENERAL pool ∪
      category-flavored pools; grow freely). Adjective pool keyed off the monster
      CATEGORY rather than the dungeon, which reads better.
- [x] Roll an adjective per encounter, deterministic from the **encounter id**
      (fixed integer hash, no storage/migration) — stable across renders/reconnects.
- [x] Render `<adjective> <creature>` above the HP bar (`tv.js drawHpBar`), bigger
      than the HP numerals, in the reserved strip.
- [ ] (Stretch, still open) broader name flare for other entities.
- [ ] (Follow-up, TV visual tuning) long titles (e.g. "Grave-touched Lizardman
      High Shaman") have no width clamp — could overflow the name strip at lower
      resolutions. Add a max-width/shrink-to-fit if it clips on the real TV.

## 13. Animate sprites (two-frame loop) for a livelier dungeon
Every creature/class sprite in `creatures_24x24` ships as a **two-frame animation
pair**: frame A at file index N, frame B at **N + 18** (see the #1 finding). The TV
renderer currently shows a single static frame. Alternating A/B on a slow timer
would make monsters and heroes look alive. Pairs with #6/#7 (lively dungeon).
**Monster + heroes: ✅ DONE (2026-07-12)** — `tv.js` alternates each rendered
creature/hero sprite between frame A and its `+18` partner on a staggered ~0.6s
shared clock (`animImg`/`partnerUrl`; frame math mirrors anim.js; falls back to
frame A until the partner image loads). Spec: docs/superpowers/specs/2026-07-12-sprite-animation-design.md.
- [x] Animation partner = frame-A index + 18 (derived client-side from the URL).
- [x] Renderer toggles A/B on a ~0.6s timer, staggered per sprite (monster incl.
      pack duplicates + battlefield heroes). Leaderboard avatars + defeat popup
      stay static (scope decision).
- [ ] **Decor animation still OPEN** (deferred): dungeon2 renders no decor yet
      (#6). Animated decor needs its own WORLD-sheet frame-pair map (torches etc.
      — the `+18` rule is creatures-sheet only) AND decor drawn per-frame in
      `render()` instead of baked into the `bg` canvas in `buildBackground()`.
      Do this alongside #6.

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

## 15. Gold Glow floor → bonus gold reward
When the `auric_glow` floor (the emissive gold slab, a rare `feature`-tier floor) is the
chosen floor for a dungeon, award bonus gold to the players who fight there. Makes the rare
"treasure vault" floor a payout moment, not just a visual. Logged 2026-07-11 during floor
tuning. `auric_glow` is intentionally kept rare (feature-tier on a curated set of dungeons).
- [ ] Detect when the active dungeon's chosen floor group is `auric_glow`
- [ ] Award a bonus-gold amount (define; scale with dungeon level?) — likely in the engine
      on kill/clear, or as a flat per-dungeon bonus
- [ ] Surface it on the TV (a "Gold Vault!" flourish / gold-rain) so players notice

## 16. Cracked-wall tiles: re-enable per-band with placement rules
During the wall-autotiling polish (2026-07-11) cracks were **disabled** for the bands
whose shared crack columns (sheet 26/27) don't read well — see `NO_CRACK_DUNGEON_IDS`
in `src/domain/floorgroups.ts` (`wallVariantChance = 0`):
- **Rustpipe Sewers (10)** — plain walls carry a pipe/"=" motif the plain cracked
  variant lacks, so a crack looks inconsistent beside the piped walls (tile is *not*
  broken, just stylistically off).
- **Bogstone Mire (20), Dunewatch (21), Cobblemoor (22), Bloodstone Cairn (23)** — the
  rounded fieldstone/cobble bands have notched rubble at the crack columns that breaks
  the wall line (wrong tile for a cracked run).

These bands currently render clean walls only (no `wallVariantChance` cracks). Later, add
smarter cracked-tile support so they can have damage again:
- [ ] Per-band crack tiles: some bands' correct cracked pieces may live at different
      columns than the shared 26/27 — decode the right cracked-wall tile per band.
- [ ] Placement rules for when a crack is allowed (e.g. only on straight runs away from
      corners/doors; a max density; avoid stylistic clashes like the sewer pipe motif).
- [ ] Consider band-appropriate "damage" beyond cracks (moss, rust, scorch) that matches
      each theme, rather than one generic spiderweb crack.

## 18. Roll the landing design language across the pages
Extend the landing dungeon-corridor look (torch-lit wall border, background +
torch glow, side loot-float — but *not behind content*) to the rest of the pages.
Decomposed into a foundation spec + per-cohort follow-ups (approach A).
Spec 1: `docs/superpowers/specs/2026-07-14-dungeon-shell-design-language-design.md`.
- [x] **Spec 1 — foundation + player cohort ✅ DONE (2026-07-14, #18 merge):**
      shared `dungeon.css` design system (tokens/background/frame/loot/primitives)
      + `layout.ejs` shell with a `full`/`lite` frame variant + gutter loot rails
      (hide below 1180px) + landing refactored onto the shell (one source of truth,
      `renderStandalone` removed) + full redesign of the 4 player pages (register,
      registered, character-login, character-sheet). Admin/dev get the lite frame.
      `style.css` retired. Plan: `docs/superpowers/plans/2026-07-14-dungeon-shell-design-language.md`.
      Controller visual-verified live (landing/character-sheet/register/admin-login).
- [ ] **Spec 2 (follow-up)** — admin cohort bespoke redesign (login/players/
      player-edit/settings).
- [ ] **Spec 3 (follow-up)** — dev-tools cohort (catalog, dungeon-preview).
- [ ] (Free) eventual shop / character-editor inherit the shell when built.

## 19. Daily-stats page — permanent "balance ledger" for players
Turn the one-off balance dashboard (built 2026-07-19 for the gold/damage tuning
review) into a permanent, fun stats page for players. Prototype artifact:
https://claude.ai/code/artifact/310f3824-11c3-4020-a6b0-99c70bd0e2dc (dungeon-
ledger look: torch-dark ground, leaderboard-gold accent, grimoire serif).
Candidate stats: gold in circulation + daily mint, per-player effective-power
ranking (raw→effective compression), fight pace vs. target, peak modifiers,
steal/debuff tallies, fights/day. Inherit the `dungeon.css` shell (#18). Feed it
live from a stats endpoint rather than a DB snapshot (the prototype is static).
Fits the "fun daily stats" framing — leaderboard flavour, not admin telemetry.
- [ ] Stats endpoint (aggregate queries; cache/refresh cadence)
- [ ] Page on the dungeon shell, linked from the player/character pages
- [ ] "Daily" framing — day-over-day deltas, a rotating highlight or two

## 20. Combat pacing — fight-duration backstop (DEFERRED, observe first)
**Decision 2026-07-21: DEFER ~1 week and re-observe before building anything.**
Fight durations vary wildly and we want to know if that's actually a problem
before adding machinery. Right now a boss has run all day — but that may self-
correct as players level.

**Why fights drag (mechanics, confirmed 2026-07-19 review):** every enabled
player swings each interval; an idle player still hits at modifier 1×, so the
monster always takes a *floor DPM*. HP is `floorDPM × 45min × difficulty`, but
`difficulty` ramps *multiplicatively* (0.15/encounter, 0.25/dungeon, ×3 boss)
while floorDPM only tracks player *levels* (which crawl up). So a floor-paced
fight at depth is `45min × difficulty` — ~3.6h for a L16 single, ~10h for a boss.
Bursts (own-activity modifier, observed up to 194×) collapse that to 7–13 min.
Plus the 15-min auto-pause freezes ticks but not the wall clock, so overnight
"26-hour fights" are mostly *paused* time, not combat.

**Key reason to wait:** floorDPM is level-based, so as the roster levels up the
deep-fight floor time shrinks on its own — the drag may resolve without code.

**Options explored (pick up here if we act):**
- **A. Festering bleed (leaning).** Monster loses a growing % of max-HP per
  minute of *active* (unpaused) combat. Un-griefable (HP not derived from anyone's
  output, so a pre-spawn burst does nothing), idle-safe, simple. TV shows only a
  proportional bar, so the fudge is invisible there; homepage numbers just tick down.
- **B. Rubber-band controller.** Per-tick correction toward a 45-min schedule both
  ways. Most precise, but padding fast fights fights the "let whales cook" goal and
  makes homepage numbers stall. Rejected as too artificial.
- **C. Smoothed spawn calc.** HP from a rolling-average DPM instead of instantaneous
  — fixes only the grief vector, not the stalls. Minimal-change fallback.

**Philosophy leaning = backstop, NOT pacer.** Rescue only pathological stalls;
let real damage decide fights. Threshold scaled to each fight's *expected floor
time* (`45 × difficulty`): ramp bleed at ~1.5×, force finish by ~2.5×. Never
truncates a fair-clip fight; adapts to depth automatically.

**Gold interaction (important):** the bleed does NOT change gold-per-fight (pool =
`max_hp × level × gold_factor`, independent of how the fight ends). It only raises
*fights/day*, which compounds: faster fights → faster dungeon descent → deeper
levels → pools grow super-linearly (`HP × level`, both rising). An aggressive
pacer would need a compensating `gold_factor` cut (~0.01 → ~0.007 for +40%
fights/day); the backstop barely moves fights/day, keeping gold predictable —
another reason to prefer it. (This also shelves the original "activity-aware
`calibrateHp`" idea, which had the same grief vector as C without the bleed.)

**Reconsider trigger:** if, after the roster levels up more, active-hours boss /
deep fights still routinely drag (not just overnight paused stalls). Start with
backstop-A + relative threshold; measure fights/day and gold influx over a week.
Separate, already-approved and still pending: gold steal → 0.008% of target gold,
and a ~200× modifier cap.

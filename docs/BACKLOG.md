# Runtime Raiders — Backlog

Observed-in-play items to tackle one by one. This file is the current product
roadmap; dated specs and plans preserve design and implementation history.
The backlog began on 2026-06-27 under the original ClaudeRPG name.

Reference: the oryx 16-bit fantasy tileset under
`assets/oryx_16-bit_fantasy_1.1/` (loaded at runtime via `spritesDir`).

---

## Current priority view (2026-08-25)

**Importance** is the product/operational urgency. **Impact** and **effort** use
a 1–5 scale, where 5 is highest. A quick win is useful work estimated at effort
1–2 with no unresolved design dependency. Completed work remains in the dated
sections below for history but is not repeated here.

| Backlog | Current work | Importance | Impact | Effort | Quick win |
|---|---|---:|---:|---:|:---:|
| #31 | Onboard the employee beta and observe first-install, opt-in, and Run behavior | High | 5 | 2 | Yes |
| #34 | Correct nested Codex usage scoring for new Runs, then reassess Momentum | Critical | 5 | 4 | No |
| #35 | Align dungeon presence with accepted fresh Run activity without awarding points | High | 4 | 3 | No |
| #22 | Audit Potion Lab evidence against the higher-tier launch threshold | High | 4 | 2 | Yes |
| #9/#20 | Recheck real fight pacing and economy before changing balance | High | 4 | 2 | Yes |
| #32 | Add and calibrate the Omp adapter after a credentialed privacy canary | High | 4 | 5 | No |
| #22 | Design and build Phase 3 loot, equipment, parts, and gems | High | 5 | 5 | No |
| #22 | Design stronger potion tiers only after the evidence threshold is met | Medium | 3 | 3 | Blocked |
| #22 | Design Phase 4 pets after the gems/equipment economy exists | Medium | 4 | 5 | Blocked |
| #19 | Turn the balance ledger prototype into a live daily-stats page | Medium | 3 | 3 | No |
| #25 | Build a denser personal watch view with player interaction | Medium | 4 | 5 | No |
| #4 | Add class-specific attack visuals | Medium | 3 | 4 | No |
| #1/#7/#14/#16/#17/#24 | Curate and polish creature names, floors, cracks, rooms, and decor | Medium | 3 | 3 | No |
| #15 | Make the rare Gold Glow floor grant a visible bonus | Medium | 3 | 3 | No |
| #20/#21 | Reassess long fights, then choose a backstop or cosmetic reskin | Medium | 4 | 4 | No |
| #12 | Clamp or shrink long monster titles on the TV | Medium | 2 | 1 | Yes |
| #14 | Validate floor-data JSON shapes at load time | Medium | 3 | 2 | Yes |
| #23 | Make idle heroes face the monster | Medium | 2 | 2 | Yes |
| #11 | Extend hard server validation to the remaining admin settings | Medium | 3 | 2 | Yes |
| #8 | Surface more of the already-computed leaderboards | Low | 2 | 2 | Yes |
| #18 | Give admin and developer tools bespoke dungeon-shell layouts | Low | 2 | 3 | No |
| #28 | Add a branded, fail-closed Runtime Raiders 404 page | Low | 2 | 2 | Yes |
| #32 | Add Claude Code only after a credentialed privacy and scoring canary | Medium | 4 | 5 | No |
| #32 | Reconsider Composer only after a safe record contract exists | Low | 2 | 5 | No |
| #28/#30/#32 | Optional audit metadata, UI evidence, and internal-name cleanup | Optional | 1–2 | 1–5 | No |

**Recommended work order:** correct new-Run scoring in #34 → align dungeon
presence in #35 → verify one bounded collection-off canary boundary → complete
the post-install guidance/status slice of #33 → observe corrected Momentum →
Potion Lab evidence audit → fight/economy snapshot → monster title clamp →
floor-data validation. Do not start higher potion tiers, provider
expansion, equipment, or pets until their stated evidence/dependency gates pass.

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
- [x] Phase 2: teach the catalog about A/B frames (label/dim B-frames, show the
      `+18` animation partner) so only the ~198 real creatures need naming.
- [x] Phase 2: correct `spritenames.ts` / the name→file mapping to frame-A files.
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
- [x] The durable log now drives the rotating **Most Battered** leaderboard in #8.

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

## 10. Public Runtime Raiders landing page ✅ DONE (updated 2026-08-23)
The original 2026-07-14 dungeon-corridor landing page was superseded by the
completed Runtime Raiders product rebrand. The current page uses the approved
Runs, Raiders, Raid Power, one-time enrollment, and content-free privacy
language for Codex Desktop and CLI. It no longer instructs players to configure
Claude OTel or use the retired `rpg_off` command.
- [x] Preserve the dungeon-corridor art direction, live boss card, class picker,
      and trust section under the Runtime Raiders name.
- [x] Explain new-Raider registration, existing-Raider login, the private local
      companion, one-time enrollment code, and `raiders on|off|status` controls.
- [x] State the exact content-free boundary and advertise only server-enabled
      provider surfaces.
- [x] Roll the shared shell across the player cohort and the Gilded Mimic shop.
- [ ] Bespoke admin and developer-tool shell work remains tracked in #18.

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
- [x] Animated world decor uses explicit per-tile partners and renders on the
      shared live animation clock; creature `+18` frame rules are not reused for
      the world sheet. The duplicate pre-implementation checklist was removed
      during the 2026-08-23 roadmap reconciliation.

## 14. Modular flooring — palette tuning and validation
The modular flooring system now drives live `/tv` through `dungeon2` and remains
compat-matched. Most follow-ups are data edits in `src/domain/floordata/*.json`
or small validation/selection changes in `src/domain/floorgroups.ts`.
- [x] Demote `cinder_rock`'s high-contrast ember slab from main to accent.
- [x] Restrict `crimson_mosaic` compatibility to appropriate crimson-family
      dungeons.
- [ ] Generous `good`-tier compat lists put warm floors (e.g. `oaken_flag` red slab) under
      cool/green walls (e.g. Thornwind Ruins). Tighten `good` lists if you want stricter
      per-theme color coherence.
- [x] Raise `ACCENT_RATE` to 11% and add conservative accents to several flat
      groups. Remaining empty-accent groups and visual taste work stay in #7.
- [ ] (Optional) Floor choice is purely seed-driven, so two same-class dungeons at the same
      seed pick the identical floor. Cosmetic in play (each dungeon has its own seed); if
      dungeons are ever shown side-by-side, mix the dungeon id/name into the floor-pick rng.
- [ ] Restore the spec-promised load-time JSON shape validation in
      `floorgroups.ts` (currently a test-time guard).
- [x] Activate themed `dungeon2` decor and animated world tiles.
- [ ] Resolve the latent `pickCell` accent-rate quirk if a group ever has both
      glow and normal accents.

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
- [x] The Gilded Mimic shop and Raider Hub Wardrobe inherit the shared shell.

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
Separate, already-approved and shipped 2026-07-21: gold steal → 0.008% of held
gold (`monster_gold_steal_pct`), and a 200× activity-modifier cap (`modifier_cap`).

## 21. Reskin the dungeon during a long fight (cosmetic, no gameplay change)
A gentler answer to "long fights feel like a slog" (#20) that touches *visuals
only*: while a single encounter drags on, periodically swap the **dungeon
theme/background** — same monster, same HP, same combat — so the backdrop stays
fresh through the day while the grind continues uninterrupted. Decouples "how
long the fight lasts" from "how monotonous it looks," so we may not need to
shorten fights at all (see #20). The TV already regenerates a full themed layout
per dungeon (`tvlayout.ts` / `dungeon2`), so this is a periodic re-roll of the
*layout theme* for the active encounter without touching `encounters` HP/state.
- [ ] Re-roll the render theme on a timer (or every N monster-attacks) mid-fight,
      independent of the encounter row — monster + HP + hero slots unchanged
- [ ] Pick a cadence that reads as "fresh," not flickery (e.g. every ~20-30 min
      of active time), and re-use the existing kiosk layout push
- [ ] Confirm hero-slot / monster-zone continuity across the reskin (no actors
      jumping) — keep positions, swap only wall/floor/decor theme

## 22. Player shop — a multi-phase PROGRAM (spend gold; the missing gold sink) 🔥
**Current status 2026-08-23:** Phases 0 and 1 plus the Tier 1 launch of Phase 2
are implemented on `main`. The shop release was deployed and verified on the Pi
at commit `4caebd4`; later Runtime Raiders and release work preserved it. Phase
2 higher strengths and Phases 3–4 remain future projects.

Most-requested feature, and the **missing gold sink**: the 2026-07-19 balance
review found gold only inflates (38M+ in circulation, ~6.7M/day minted, near-zero
removal even after the new 0.008% steal — see #20). Player vision (2026-07-21) is a
program of ~5 interlocking subsystems — **decompose into sequenced sub-projects,
each its own spec→plan→build.** Dependencies: Phase 0 → {1,2,3} → 4.

**Phase 0 — Foundation (shared spine) ✅ IMPLEMENTED.** Player inventory/ownership model + currency
balances (gold now; gems later), a shop page on the `dungeon.css` shell (#18) gated
to a logged-in character, and an **atomic, server-authoritative** purchase +
gold-deduction. Every product line plugs into this; ship with one product to prove
the loop end-to-end.

**Phase 1 — Cosmetics: character color customization ✅ IMPLEMENTED.** All nine
classes, both genders, and both animation frames use approved per-pixel slot
maps. Three sequential permanent Wardrobe upgrades cost 1.5M, 2M, and 2.5M gold
(6M total), exposing each class/gender's approved basic, detail, and
weapon/shield channels. The picker includes hue, black/white Tone, material
presets, atomic saves, and the locally approved animated review surface.

**Phase 2 — Consumables: timed boosts ⏳ TIER 1 IMPLEMENTED.** Beginner Gold and
Damage Potions are sold from personal daily stock, stored in Inventory, and
manually activated for two hours of combat-active time. Gold rewards effective
token work through a capped base/stretch mini-quest; Damage raises personal base
hit by 25%. Purchases and uses are limited to three per type per office day, and
the admin-only Potion Lab records real costs and yields for later tuning. Higher
strengths wait for the approved evidence threshold. **NO token boosts** — tokens
remain the pure earned-from-work metric.

**Phase 3 — Loot boxes + equipment progression (the addicting endgame sink).** Loot
boxes output random parts (some gold, weapon/armor parts, gems). **Doubling upgrade
curve to level 10: 1,2,4,8,16,32,64,128,256,512 parts** per successive level.
Weapon: sharpening stones / gems. Armor split into parts, each a slight effect +
own curve — gloves (attack speed), cloak (reduce monster attacks), boots (gold
gain), etc. **Gems** = a second currency (feeds Phase 4). The endgame sink once
cosmetics are exhausted.

**Phase 4 — Pets (later, plan separately).** Gated on **gems** earned from loot
boxes (Phase 3). Design later.

**Fairness guardrail throughout:** whales hold the most gold, so avoid permanent
pay-to-win runaway — favour self-consuming (Phase 2), diminishing returns, and
catch-up. Prices scaled to the inflated economy (millions, not hundreds).
- [x] Confirm decomposition + build order; build Phase 0 with the first cosmetic product.
- [x] Complete recoloring feasibility, slot-map authoring, and male/female pixel approval.
- [x] Build Phase 1 cosmetics and the Tier 1 launch of Phase 2 consumables.
- [ ] Use Potion Lab evidence to design higher potion strengths after at least 14
      combat-active days, 30 completed activations per launch product, and five
      participating players.
- [ ] Spec→plan→build Phase 3 loot boxes/equipment and Phase 4 pets when prioritized.

## 23. Heroes face the monster (flip sprite by side)
On the TV a hero sprite always faces the same direction regardless of which side
of the monster it stands on. Flip the hero sprite horizontally to face the monster
based on `hero.x` vs the monster-zone centre — a hero to the monster's right faces
left, and vice-versa. Small `tv.js` render change (`drawSprite` with an x-flip).
Pairs with #3 (attack lunge direction, done) and #4 (class attacks).
- [ ] Flip hero sprite to face the monster by relative x-position
- [ ] (Optional) monster / pack faces the cluster of heroes

## 24. Richer / more complex dungeon decorations
Spruce up the dungeon further beyond the #6 pass: more elaborate, layered, varied
decorations — larger multi-tile props, denser themed arrangements, structural
pieces — so each room reads as a more detailed place. Follow-on to #6 (decor
library + placement) and #7 (lively floors); keep the walkability / hero-slot /
monster-zone clearance rules intact.
- [ ] Expand the decor library with more complex / multi-tile pieces per theme
- [ ] Denser, more varied placement without crowding the actors
- [ ] Preserve walkability + monster-zone clearance guarantees

## 25. Local/personal view — enhanced & interactive (distinct from the big-screen TV)
Players have started watching `/tv` on their own computers. Build a view tuned for
a personal screen rather than the shared office TV: a **smaller dungeon panel**,
**more stats on-screen**, and some **player-to-player interactivity**. The TV kiosk
stays lean and readable from across the room; the personal view trades that for
density + interaction. Needs a design pass.
- [ ] Brainstorm the interactivity — what "between players" means (emotes/reactions,
      cheering a player, live chat, spectator predictions?) and how it's gated
- [ ] Route/mode decision: a new `/watch` vs a `?mode=local` on `/tv`
- [ ] Denser layout: smaller dungeon + expanded stats/leaderboard panes
- [ ] Reuse the SSE stream + `dungeon.css` shell; do NOT regress the TV kiosk

## 26. Bound delayed potion-clock credit at the idle deadline ✅ DONE (2026-07-30)
The engine now clips a delayed tick's elapsed interval and accounting timestamp
to the office-idle deadline before advancing combat-active potion time. If new
activity resumes after an idle gap but before the delayed tick runs, the engine
credits the old and resumed active windows without filling the gap. Regression
tests cover both cases across the 15-minute boundary.

## 27. Verify `raiders.local` from a direct network path ✅ DONE (2026-08-24)

Verified from a Mac directly on the office network without VPN. The committed
record intentionally omits the internal IP.

- [x] Confirm `raiders.local` resolves to the same Pi as the internal FQDN.
- [x] Verify SSH host identity and login through `raiders.local`, binding the
      alias to the already-trusted internal-FQDN host key rather than accepting
      a new key blindly.
- [x] Verify `http://raiders.local:8080/health` and the loopback kiosk route on
      that same network path.
- [x] Verify the Pi-side Avahi advertisement, loopback health, and kiosk route
      without
      treating a remote process that cannot receive multicast as office-path
      evidence.

## 28. Release-host follow-ups

- [ ] Branded Runtime Raiders 404 page — design a later human-friendly response
      while preserving HTTP `404`, the three exact artifact matchers,
      `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and the
      unpublished-state tests. This is not an asset dependency for this release.
- [ ] Optional audit metadata — consider recording release sequence, Git SHA,
      and protocol as opaque metadata only if employees or operators later find
      it useful. It must remain non-required for startup, collection, status,
      install, update, and publication; must not restore self-update, artifact
      selection, canary, manifest, checksum, or multi-generation machinery; and
      is not a blocker for the employee beta.

## 29. Next-release zsh-compatible onboarding and pasted-command audit ✅ DONE (2026-08-19)

The earlier onboarding command used a zsh read-only variable and could fail when
employees pasted it into their normal terminal. Runtime Raiders `0.4.0` replaces
that variable, exercises the complete command under both zsh and POSIX sh, and
has completed a clean public installed-off canary.

Original defect:

- zsh defines `status` as a read-only special parameter;
- `src/web/companion-install.ts` assigned the generated command's HTTP result
  to `status`;
- registration and Player Hub render that command directly for the user to
  paste into their interactive shell, without selecting Bash; and
- `tests/runtime-raiders-onboarding.test.ts` executed the complete generated
  command only with `/bin/sh`.

Completed requirements:

- [x] Rename only the user-facing command variable to a portable, specific name
      such as `download_http_code`. Do not require users to invoke Bash to run
      the onboarding command.
- [x] Parameterize full generated-command execution tests across both
      `/bin/zsh -f -c` and `/bin/sh -c`. Each shell must prove the successful
      download-and-execute path and fail-closed download paths, including a curl
      failure or non-200 response and a completed download that fails local
      validation. A failed case must not execute the installer and must clean up
      its owner-only temporary file.
- [x] Update route, snapshot, and documentation assertions that currently bind
      the generated command to `[ "$status" = 200 ]`. Keep the website output,
      canonical command documentation, and tests byte-consistent.
- [x] Move substantial operational runbook blocks that require Bash syntax into
      checked-in Bash scripts where practical. Otherwise invoke the block
      explicitly with `/bin/bash`; a Markdown `bash` fence is not execution.
- [x] Audit every command intended for direct copy/paste for zsh special or
      read-only parameter names and for an implicit shell assumption.
- [x] Do not mechanically rename `status` inside scripts already unambiguously
      executed by a `#!/bin/bash`, `#!/bin/sh`, `/bin/bash`, or `/bin/sh`
      boundary. Change only code whose actual execution shell is ambiguous or
      incompatible.

Acceptance gate:

- [x] The exact website-generated command passes its complete success and
      fail-closed matrix under clean zsh and POSIX sh processes.
- [x] Website, route, runbook, and documentation drift tests agree on one
      canonical onboarding behavior.
- [x] Released and independently verified in Runtime Raiders `0.4.0`; the exact
      public `curl -fsSL https://raiders.redlattice.com/install.sh | sh`
      employee command completed a clean installed-off canary on 2026-08-19.

## 30. Runtime Raiders background-item name and icon ✅ DONE (2026-08-22)

The signed `0.4.0` canary is functionally correct, but its app bundle currently
appears as **Runtime Raiders Agent** and has no bundled icon. macOS also shows
**Software from “Bryan Carpenter”** in the App Background Activity notification;
the live Background Task record repeats that value as both Developer Name and
Parent Identifier. The developer identity may remain Bryan Carpenter, but the
software/background-item identity must be **Runtime Raiders**. Before the wider
employee rollout, verify that association between the LaunchAgent and hidden app
prevents the developer name from replacing the product name while retaining
`com.redlattice.runtime-raiders-agent` as the internal LaunchAgent label.

The signed `0.4.1` canary proved the app name, service name, associated-bundle
declaration, and branded icon, but System Settings still grouped the service
under **Bryan Carpenter**. The `0.4.2` repair registered the final installed app
before installing or bootstrapping the LaunchAgent. Its signed installed-off
canary still displayed **Bryan Carpenter** in the actual App Background
Activity list. The corresponding record had service name `Runtime Raiders` but
Developer Name and Parent Identifier `Bryan Carpenter`; metadata registration
was therefore not sufficient.

The approved 0.4.3 design replaces the copied legacy property list with an
agent embedded in the signed app and registered using Apple's `SMAppService`.
It uses distinct new parent-app and managed-agent identifiers so macOS cannot
reuse the stale legacy relationship. See
`docs/superpowers/specs/2026-08-21-runtime-raiders-smappservice-branding-design.md`.
The signed `0.4.3` installed-off canary failed closed before registration.
macOS returned `SMAppService.Status.notFound` for the fresh managed agent
because no Background Task Management record existed yet; the controller
incorrectly rejected that state before calling `register()`. The installer
restored the signed 0.4.2 legacy service with collection disabled and retained
its recovery directory.

The `0.4.4` repair treats `.notFound` as the expected first-registration state.
It passed the repeatable signed/notarized local installed-off canary below, was
published from Git commit `5ced73d`, and its public installer and ZIP matched the
locally proven artifact. The installed service reports version `0.4.4`, a
running managed daemon, disabled collection, and zero active Runs or queued
events. The operator then confirmed that System Settings → Login Items shows
**Runtime Raiders.app**. This clears the employee-rollout branding blocker.
macOS may continue to say **Software from “Bryan Carpenter”** when identifying
the Apple developer; that is approved developer attribution, not the product or
background-item name.

```sh
/bin/bash scripts/release/install-runtime-raiders-local-canary.sh
```

- [x] Set the user-facing bundle/display name to exactly `Runtime Raiders` and
      remove the retired `Runtime Raiders Launcher` / `Runtime Raiders Agent`
      wording from visible system UI.
- [x] Ship one approved Runtime Raiders `.icns` resource and bind it through the
      app bundle metadata.
- [x] Confirm the signed association keeps **Runtime Raiders** as the product
      identity while correctly retaining Bryan Carpenter as the Apple developer.
- [x] After a clean signed install, verify the actual Login Items entry in System
      Settings shows **Runtime Raiders.app**; the signed bundle retains the
      approved Runtime Raiders icon metadata.
- [x] Keep this branding work independent from enrollment, collection,
      telemetry, update checking, and publication behavior.
- [ ] (Optional regression evidence) Capture the first-run notification and a
      matching `sfltool dumpbtm` record after a future clean macOS enrollment if
      Apple changes how Login Items presents developer attribution.

## 31. Runtime Raiders employee beta adoption and observation

Runtime Raiders `0.4.6` is signed, notarized, publicly available, and verified
with collection off. This is ordinary employee rollout work, not another release
engineering project. Each employee chooses when to run `raiders on`.

- [x] Share the short employee instructions as Codex subscriptions become
      available.
- [x] Record and repair the first employee blockers: the installer used the
      nonexistent `/usr/bin/stty` instead of macOS `/bin/stty`, and production
      still displayed the retired long-form download wrapper. Patch `0.4.6`
      fixed the installer; the game server now returns only the one-line
      `curl -fsSL https://raiders.redlattice.com/install.sh | sh` command.
- [ ] Confirm the new-Raider and existing-Raider enrollment paths are clear on
      at least one employee-owned Mac that did not participate in development.
- [ ] Confirm ordinary `raiders status`, one real post-opt-in Run, and expected
      game credit without repeating the synthetic release gate for every user.
- [ ] Record only concrete onboarding failures, privacy questions, or scoring
      surprises for a short follow-up review; do not add release ceremony without
      evidence that employees need it.

## 32. Future provider expansion and optional internal cleanup

The Runtime Raiders event contract is provider-neutral, but `0.4.6` enables only
Codex Desktop and Codex CLI. A provider name in an enum or status response is
not support. Every added surface requires a real local-record contract, strict
content-free fixtures, privacy review, scoring calibration, server allowlist
change, controlled canary, and explicit release approval.

- [ ] **Omp — next candidate.** Validate its local SDK/RPC session and usage
      records, implement the adapter, calibrate a new scoring-policy version,
      and keep it disabled until every gate passes.
- [ ] **Claude Code — planned.** Use a credentialed machine to validate the
      current local record contract. Do not revive or require the legacy Claude
      OTel enrollment path.
- [ ] **Composer/Cursor — deferred.** Reconsider only if a safe, stable record
      contract exists; asynchronous administrative polling is not assumed to be
      acceptable employee telemetry.
- [ ] **Optional internal rename.** After multi-provider behavior is stable,
      consider replacing compatibility names such as `token_events` and
      `effective_tokens`. This must preserve history and is not required for
      player-facing Runtime Raiders behavior.

## 33. Official Raider re-enrollment and readable companion status ✅ DONE (2026-08-26)

**Observed during the employee beta (2026-08-24):** an employee can create a
duplicate Level 1 Raider, then discover that browser login does not change the
already-installed companion's device enrollment. The completed supported
commands replace the former undocumented cleanup approach: `raiders re-enroll`
changes an enrollment with collection off; `raiders uninstall` preserves
recovery state; and `raiders uninstall --everything` is the confirmed complete
local removal.

The same beta exposed that `raiders status` emits a correct but operator-oriented
single-line JSON document. Employees need a concise answer to “is it on?”, “is
it ready?”, “will it send work?”, and “what should I do next?” without exposing
credentials, local paths, or provider-record content.

- [x] **Design and implement an explicit `raiders re-enroll` flow.** It must
      require collection to be off, show only a content-free summary of the
      current state, require an unambiguous confirmation, unregister the managed
      background agent, and remove only Runtime Raiders-owned local state. It
      must finish by prompting for a new short-lived enrollment code from the
      Raider selected in **Raider settings → Companion Setup**. Browser login
      alone must never silently retarget an installed device.
  - [x] Server: atomically consume the target enrollment, revoke the old
        device, insert the client-generated replacement, and make exact replay
        deterministic without changing account or game history.
  - [x] Server: provide active-device configuration recovery for an ambiguous
        response or interrupted local commit.
  - [x] Local: implement and verify the owner-only coordinator, recovery
        journal, private prompt, safe state reset, and managed-agent lifecycle.
- [x] **Make pending-event disposition explicit.** Before replacing enrollment,
      show the queued-event count and require either a deliberate, documented
      delivery-to-current-Raider choice or a deliberate discard choice. Never
      transfer queued work or already awarded points to another Raider. A
      re-enrollment must revoke the prior device credential before the new one
      can collect, and historical scores/Runs remain attached to their original
      Raider.
  - [x] Server: reject the old credential after replacement and preserve every
        Run, event, score, reward, inventory row, player total, and Run owner
        across replacement, recovery, and revocation.
  - [x] Local: implement and verify bounded delivery, explicit discard, cancel,
        partial-failure recovery, and the rule that queued work is never sent in
        a replacement request.
- [x] **Provide a true, equally bounded removal option.** It must unregister the
      managed agent and remove only the companion's app, launcher, owner-only
      state, and outbox; it must not touch Codex sessions or unrelated user data.
      Distinguish “stop and preserve state” from “remove local companion state”
      in both command names and output.
  - [x] Server: provide idempotent current-device revocation that immediately
        blocks configuration recovery, events, and heartbeat.
  - [x] Local: implement and verify recoverable uninstall and confirmed
        `--everything` allowlisted removal.
- [x] **Make `raiders status` human-readable by default.** Render collection
      state (`Off`, `Preparing`, or `Ready`), daemon/background-agent health,
      supported surfaces, active Runs, queued events, installed/available
      version, last successful upload when present, and one bounded next action.
      Keep it content-free: no Raider Key, device token, native Run ID, local
      path, cursor, prompt, response, or provider-record content.
- [x] **Preserve automation compatibility with `raiders status --json`.** Keep
      the existing structured fields stable and sorted, and exercise both the
      live-daemon and daemon-unavailable local-status paths. The pretty output
      must be deterministic enough for snapshot tests but must not be parsed by
      automation.
- [x] **Give a successful install a plain-language handoff.** Say that Runtime
      Raiders is installed, collection starts off, `raiders status` checks the
      setup, and `raiders on` opts into the game. Keep secondary commands behind
      `raiders help` instead of printing an operator runbook after installation.
- [x] **Acceptance coverage:** test duplicate-account recovery, prior-device
      rejection, re-enrollment onto the intended Raider, explicit queue
      delivery/discard behavior, managed-agent cleanup, interrupted recovery,
      no score transfer, and no secret/content leakage. The employee runbook
      names only the supported commands, and fresh install, reinstall, and
      recovery matrices pass. This completion does not create, publish, or
      authorize a release or change production collection.

## 34. Correct nested Codex usage scoring, then reassess Raid Momentum

**Production finding (2026-08-25):** Codex reports cache reads as a subset of
input and reasoning as a subset of output. Runtime Raiders v1 stores those raw
counters correctly, but its policy sums `input + output + reasoning` while only
adding zero for the separate cache-read field. Cache reads therefore remain
inside scored input, and reasoning is counted twice. One 3m55s Run received
4,110,542 Raid Power even though removing the nested cache-read contribution
would put the same Run near 100,000 Raid Power. The 200× Momentum cap is therefore
not evidence that the combat ramp itself is too steep.

**Approved beta-history decision (2026-08-25):** fix scoring only for new Runs.
Preserve every existing account, Raider, device enrollment, Run, awarded Raid
Power value, level, gold balance, damage record, reward, and leaderboard result.
Do not merge, delete, retarget, reset, or recompute any account or historical
gameplay data as part of this correction. The inflated v1 beta history remains
visible as beta history. The primary canary's collection was manually turned off;
no release or diagnostic step may turn it back on without separate approval.

**Release status (2026-08-25):** scoring v2 is planned and approved for a
separately authorized, collection-off release gate; it is **not deployed**.

- [ ] Add a forward-only Raid Power policy v2 that scores non-overlapping usage:
      total input minus cached input, plus total output exactly once. Cache-write
      and reasoning counters remain visible native-usage detail but are already
      contained by their parent totals.
- [ ] Preserve raw provider counters unchanged for audit and display. Reject a
      new v2 event when cache reads exceed input or reasoning exceeds output.
- [ ] Add a server cutover that keeps pre-cutover and already-open Runs on v1 and
      assigns only newly started Runs to v2. Exact duplicates remain idempotent,
      and one Run may never cross policies.
- [ ] Render nested usage honestly on the player page: total input with cached
      and uncached portions, total output with its reasoning portion, and cache
      writes explicitly labeled as reported usage.
- [ ] Do not change `token_modifier_k` or `modifier_cap` during the correctness
      release. After two to three normal office days under v2, record median,
      p95, peak, cap frequency, fight duration, damage concentration, and decay;
      tune Momentum only if the corrected evidence still supports it.
- [ ] Verify the `0.4.8` reconciliation repair with one Codex Desktop Run and one
      Codex CLI Run that deliver opening, incremental, and terminal events without
      quitting either client; report provider emission delay separately from
      collector/upload latency.

## 35. Align dungeon presence with accepted Run activity

**Production finding (2026-08-25):** Runtime Raiders can report an active Run as
soon as a zero-credit opening event arrives, while dungeon sleep still uses
`MAX(players.last_token_at)` and therefore waits for the first positive Raid
Power award. Version 0.4.8 delivered a new Run opening immediately and its first
positive usage event about 14 seconds later, reproducing the mismatch without a
collector stall.

**Release status (2026-08-25):** the presence correction is approved and
planned behind a separately authorized, collection-off production gate. Local
implementation and test evidence do not complete this backlog item; it remains
open until migration, public wake/count, unchanged Raid Power, duplicate
non-extension, 15-minute sleep, and verified-off canary evidence exist in
production. Official re-enrollment and human-readable `raiders status` remain
separate #33 work and are not part of this server rollout.

- [ ] Add a scoring-independent presence timestamp. Advance it only for a fresh,
      authenticated, newly accepted Run event from an enabled Raider.
- [ ] Do not let duplicates, device heartbeats, disabled Raiders, future-skewed
      timestamps, or stale reconciled backlog extend presence.
- [ ] Make dungeon sleep and `activeRaiders` consume the same presence definition
      while positive Raid Power continues to update scoring independently.
- [ ] Cover zero-credit opening wake, duplicate and heartbeat exclusion, stale
      backlog exclusion, disabled-Raider exclusion, the 15-minute boundary, and
      the unchanged positive-credit path.
- [ ] Ship and verify this server behavior independently from signed companion
      re-enrollment/status work in #33.

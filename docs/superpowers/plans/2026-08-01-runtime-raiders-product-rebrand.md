# Runtime Raiders Product Rebrand Implementation Plan

> **Implementation status (2026-08-23): COMPLETE.** The product rebrand was
> implemented on `main` through the Runtime Raiders copy, enrollment, player
> hub, TV, admin, and provider-neutral Run work. The player-copy guard passes.
> Unchecked boxes below are preserved as historical TDD instructions, not the
> current todo list; current work is tracked in `docs/BACKLOG.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand every current player-facing surface as Runtime Raiders while preserving the existing fantasy artwork, palette, routes, game mechanics, and compatibility-oriented internal identifiers.

**Architecture:** Central brand copy is passed through the existing EJS rendering boundary, while page-specific views adopt the approved Raider/Run/Raid/Raid Power vocabulary. The current purple-black dungeon shell, moss, torchlight, gold, pixel art, and feature layouts stay intact; new server Run queries supply a small literal Run Details panel without placing provider metadata on the TV battlefield.

**Tech Stack:** TypeScript, Express, EJS, existing CSS/vanilla JavaScript, Vitest, Supertest, Canvas 2D TV renderer, in-app browser visual verification

## Global Constraints

- Product name: **Runtime Raiders**.
- Primary line: **Clock in. Clear dungeons. Get paid.**
- Secondary line: **Your AI keeps running. Your Raider keeps raiding.**
- Player-facing terms are Raider, Run, Raid, Fight, Raid Power, Momentum, Run Details, Create Your Raider, and Raider Key.
- Keep the word **Leaderboard**.
- Model, effort, and provider are display-only; do not rank or score them.
- Player-facing support claims are derived from `enabledRunSurfaces`. The initial release names only Codex Desktop and Codex CLI; Omp and Claude Code remain absent until separately enabled.
- Keep classic fantasy; add no robots, circuitry, terminals, neon, or cyberpunk art.
- Extend the existing palette; do not replace it. Keep `#e8c96a` gold and use `#54282b` wine sparingly.
- Preserve all routes, database columns, domain IDs, package/service names, levels, gold, combat, shop, wardrobe, potions, cosmetics, inventory, and history.
- Do not implement extraction, loot crates, armor crafting, Composer, or the comprehensive internal rename.
- Do not deploy, push, change DNS/Caddy/Pi hostname, or publish the companion in this plan.
- This plan depends on collector/scoring Tasks 2–8 for the Run contract, enrollment, and Run queries.

## File map

- `src/domain/brand.ts`: single source of player-facing brand constants and terminology.
- `src/web/app.ts`: inject brand into every rendered EJS page.
- `src/web/views/layout.ejs`: Runtime Raiders wordmark, navigation, title, and footer.
- `src/web/views/landing.ejs`: approved pitch, three-step explanation, and literal privacy boundary.
- `src/web/views/register.ejs`, `registered.ejs`, `character-login.ejs`: Raider enrollment language.
- `src/domain/playerhub.ts`, `src/web/views/character-sheet.ejs`, `character-live.ejs`, `src/web/public/player-hub.{css,js}`: Raid Power, collector state, active Runs, and Latest Run.
- `src/domain/leaderboards.ts`, `src/web/tvview.ts`, `src/web/public/tv/{index.html,tv.js}`: Leaderboard title changes and unobtrusive Raid/Fight status.
- `src/web/views/admin-*.ejs`, `src/domain/settings-meta.ts`, `src/domain/playerhub.ts`: literal admin/game copy with compatibility labels where needed.
- `tools/runtime-raiders/check-player-copy.mjs`: stale-copy inventory for active player-facing sources.

---

### Task 1: Establish one brand-copy source and a stale-copy guard

**Files:**
- Create: `src/domain/brand.ts`
- Modify: `src/web/app.ts`
- Create: `tools/runtime-raiders/check-player-copy.mjs`
- Create: `tests/brand-copy.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `BRAND` and `TERMS` immutable objects.
- Produces: `npm run check:player-copy`.
- Changes: `renderPage()` always supplies `brand` to EJS.

- [ ] **Step 1: Write failing brand tests**

```ts
expect(BRAND).toEqual(expect.objectContaining({
  name: 'Runtime Raiders',
  primaryLine: 'Clock in. Clear dungeons. Get paid.',
  secondaryLine: 'Your AI keeps running. Your Raider keeps raiding.',
}));
expect(TERMS.leaderboard).toBe('Leaderboard');
```

Render `/register` and assert `<title>` ends in `Runtime Raiders` and the global
wordmark no longer contains `CLAUDE`.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/brand-copy.test.ts tests/web-shell.test.ts`

- [ ] **Step 3: Add brand constants and inject them through `renderPage`**

```ts
export const BRAND = Object.freeze({
  name: 'Runtime Raiders',
  primaryLine: 'Clock in. Clear dungeons. Get paid.',
  secondaryLine: 'Your AI keeps running. Your Raider keeps raiding.',
});
```

Keep functional page titles (`Register`, Raider name, `Admin`) and change only
the global suffix/default from ClaudeRPG to Runtime Raiders.

- [ ] **Step 4: Add the active-copy scanner**

Scan `src/web/views`, `src/web/public`, `src/domain/settings-meta.ts`,
`src/domain/playerhub.ts`, and `README.md`. Fail on player-facing `ClaudeRPG`,
`Claude Code only`, `rpg_on`, `rpg_off`, `effective tokens`, or `Total tokens`.
Allow explicit compatibility strings marked on the same line with
`runtime-raiders-copy-allow` and exclude historical specs/plans.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/brand-copy.test.ts tests/web-shell.test.ts`

```bash
git add src/domain/brand.ts src/web/app.ts tools/runtime-raiders/check-player-copy.mjs tests/brand-copy.test.ts package.json
git commit -m "feat(brand): establish Runtime Raiders copy"
```

### Task 2: Rebrand the shared shell without repainting the dungeon

**Files:**
- Modify: `src/web/views/layout.ejs`
- Modify: `src/web/public/dungeon.css`
- Modify: `tests/dungeon-shell-css.test.ts`
- Modify: `tests/web-shell.test.ts`

**Interfaces:**
- Consumes: `brand` from Task 1.
- Preserves: current `.wall`, `.sconce`, `.loot-rail`, panel, torch, moss, and responsive behavior.

- [ ] **Step 1: Write shell and palette tests**

Assert the wordmark reads `RUNTIME RAIDERS`, navigation uses `Create Raider` and
`Raider Login`, and footer uses the game premise without claiming work output.
CSS assertions lock the existing purple surface variables and `--gold:#e8c96a`,
add `--guild-wine:#54282b`, and reject a new slate page background.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/web-shell.test.ts tests/dungeon-shell-css.test.ts`

- [ ] **Step 3: Update wordmark, navigation, title, and footer**

Use the existing sword asset. Style `RUNTIME` as the primary gold word and
`RAIDERS` as the companion weight; keep it readable at narrow widths. Use wine
only for a restrained seal/banner edge, never the main page surface.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/web-shell.test.ts tests/dungeon-shell-css.test.ts`

```bash
git add src/web/views/layout.ejs src/web/public/dungeon.css tests/dungeon-shell-css.test.ts tests/web-shell.test.ts
git commit -m "feat(brand): rebrand the dungeon shell"
```

### Task 3: Rewrite landing, registration, and enrollment around Runs and Raiders

**Files:**
- Modify: `src/web/routes/registration.ts`
- Modify: `src/web/views/landing.ejs`
- Modify: `src/web/views/register.ejs`
- Modify: `src/web/views/registered.ejs`
- Modify: `src/web/views/character-login.ejs`
- Modify: `src/web/public/landing.css`
- Modify: `tests/web-registration.test.ts`

**Interfaces:**
- Consumes: `createEnrollment(db, playerId, now)`, `config.publicUrl`, and `config.enabledRunSurfaces` from the collector plan.
- Produces: `installCommand` containing a short-lived one-time code, never the persistent Raider Key.

- [ ] **Step 1: Write landing and enrollment tests**

Assert exact approved lines, `Create Your Raider`, the three Run steps, the
Codex Desktop/CLI enabled-surface line, and the privacy lists below. Assert the
old OTel snippet, `Claude Code only`, and claims that Omp or Claude Code are
currently supported are absent.

```text
It sees: provider, supported surface, usage counts, model, effort, timestamps, Run state
It never sends: prompts, responses, commands, tool details, code, files, paths, workspaces, shell history
```

POST registration must create one Raider and one 10-minute enrollment, display
the persistent token as **Raider Key**, and display one install command containing
only the one-time code.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/web-registration.test.ts`

- [ ] **Step 3: Implement the landing composition**

Keep the existing hero/boss/classes/how/trust/final section structure and pixel
assets. Change hero copy to the approved lines. The literal explanation is:

1. Create your Raider.
2. Install the private local companion.
3. Use Codex Desktop or CLI; your Runs generate Raid Power.

Clarify next to the primary line that “Get paid” means in-game gold and rewards.
Render the supported-surface line from `config.enabledRunSurfaces`; fail closed
instead of inventing copy for an unknown or disabled surface.

- [ ] **Step 4: Implement registration and one-time enrollment copy**

Rename fighter/character copy to Raider without changing `class_key`, `players`,
or route names. The registered page shows the Raider Key separately from the
copyable installer and explains `raiders on|off|status|doctor|uninstall`.

- [ ] **Step 5: Verify responsive cards and commit**

Run: `npm test -- tests/web-registration.test.ts tests/web-shell.test.ts`

```bash
git add src/web/routes/registration.ts src/web/views/landing.ejs src/web/views/register.ejs src/web/views/registered.ejs src/web/views/character-login.ejs src/web/public/landing.css tests/web-registration.test.ts
git commit -m "feat(brand): introduce Runs and Raiders"
```

### Task 4: Turn the character sheet into the Raider Hub with Run Details

**Files:**
- Modify: `src/domain/playerhub.ts`
- Modify: `src/web/routes/character.ts`
- Modify: `src/web/views/character-sheet.ejs`
- Modify: `src/web/views/character-live.ejs`
- Modify: `src/web/public/player-hub.css`
- Modify: `src/web/public/player-hub.js`
- Modify: `tests/playerhub.test.ts`
- Modify: `tests/web-character.test.ts`
- Modify: `tests/player-hub-client.test.ts`

**Interfaces:**
- Consumes: `recentRuns`, `activeRunCount`, and `collectorStatus` from the collector plan.
- Adds view fields: `today.raidPower`, `activeRuns`, `latestRun`, `collector`.
- Preserves internal `players.effective_tokens`, `token_events`, and all existing routes/DOM feature behavior.

- [ ] **Step 1: Write view-model tests**

Seed two parallel Runs and assert `activeRuns === 2`, Latest Run is newest-first,
and its output contains provider, surface, model/Unknown, effort/Unknown, state,
elapsed time, native usage, and awarded Raid Power—but no Run key, device ID,
path, or credential. Assert today's compatibility sum is exposed as
`today.raidPower`.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/playerhub.test.ts tests/web-character.test.ts`

- [ ] **Step 3: Implement the Raider Hub model and headings**

Change the hero stats to Level, Raid Power, Gold, and Momentum/collector state;
remove player-facing Total tokens. Rename Live Dungeon to Current Raid, Active
time to Raid time, setup snippet to Companion Setup, and Character settings to
Raider settings. Preserve all IDs used by potion, inventory, wardrobe, and dye
code unless a corresponding test-driven client update is included.

- [ ] **Step 4: Add the compact Run Details card**

Place it after the current Raid/supporting stats, not over the dungeon. Show
`2 Runs active` when applicable and one Latest Run row. Provider/model/effort
remain literal metadata with no rank, badge value, rarity, multiplier, or color
that implies advantage.

- [ ] **Step 5: Add fresh one-time installer generation**

The Companion Setup card POSTs the existing Raider Key to
`/api/raiders/enrollments`, replaces any expired command with the returned
one-time command, and never embeds a device credential in page bootstrap JSON.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/playerhub.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts`

```bash
git add src/domain/playerhub.ts src/web/routes/character.ts src/web/views/character-sheet.ejs src/web/views/character-live.ejs src/web/public/player-hub.css src/web/public/player-hub.js tests/playerhub.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts
git commit -m "feat(brand): create the Raider Hub"
```

### Task 5: Rename Leaderboards and add unobtrusive Raid status to the TV

**Files:**
- Modify: `src/domain/leaderboards.ts`
- Modify: `src/web/tvview.ts`
- Modify: `src/web/public/tv/index.html`
- Modify: `src/web/public/tv/tv.js`
- Modify: `tests/leaderboards.test.ts`
- Modify: `tests/tvview-state.test.ts`
- Modify: `tests/tv-compact-renderer.test.ts`
- Modify: `tests/web-tv.test.ts`

**Interfaces:**
- Preserves internal board keys: `overall_tokens`, `today_tokens`, `week_tokens`, `on_fire`.
- Changes visible titles to Total/Today's/This Week's Raid Power and Raid Momentum.
- Adds display state: `raidNumber`, `fightIndex`, `fightCount`, `activeRaiders`.

- [ ] **Step 1: Write visible-title and TV-state tests**

Assert all four approved titles and unchanged internal keys/order. Assert the TV
state exposes Raid/Fight counts derived from the current dungeon/encounter and
counts enabled Raiders with recent activity. Assert no provider/model/effort is
added to the TV payload.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/leaderboards.test.ts tests/tvview-state.test.ts tests/web-tv.test.ts`

- [ ] **Step 3: Update visible titles and TV chrome**

Use a compact line such as `Raid 12 · Fight 2/4 · 7 Raiders active` in the
existing status area when a Fight exists. Resting/defeat behavior remains.
Do not change dungeon dimensions, Canvas scaling, leaderboard timing, actor
placement, or the compact hub renderer.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/leaderboards.test.ts tests/tvview-state.test.ts tests/tv-compact-renderer.test.ts tests/web-tv.test.ts`

```bash
git add src/domain/leaderboards.ts src/web/tvview.ts src/web/public/tv/index.html src/web/public/tv/tv.js tests/leaderboards.test.ts tests/tvview-state.test.ts tests/tv-compact-renderer.test.ts tests/web-tv.test.ts
git commit -m "feat(brand): rename Raid leaderboards and TV status"
```

### Task 6: Update admin, settings, potion, and active documentation copy

**Files:**
- Modify: `src/web/views/admin-login.ejs`
- Modify: `src/web/views/admin-players.ejs`
- Modify: `src/web/views/admin-player-edit.ejs`
- Modify: `src/web/views/admin-settings.ejs`
- Modify: `src/domain/settings-meta.ts`
- Modify: `src/domain/playerhub.ts`
- Modify: `README.md`
- Modify: `tests/settings-meta.test.ts`
- Modify: `tests/web-admin-players.test.ts`
- Modify: `tests/web-admin-settings.test.ts`

**Interfaces:**
- Preserves all form field names and admin update contracts.
- Changes only labels/descriptions and active onboarding/operations documentation.

- [ ] **Step 1: Write compatibility-label tests**

The player list says Raiders. The edit form labels `effective_tokens` as Raid
Power and `total_tokens` as Legacy raw-token total. Settings labels/descriptions
say Raid Power and Momentum while retaining internal keys such as
`token_modifier_k` and `cache_read_weight`.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- tests/settings-meta.test.ts tests/web-admin-players.test.ts tests/web-admin-settings.test.ts`

- [ ] **Step 3: Rewrite active copy**

Replace literal token units in potion/reward descriptions with Raid Power where
the value now comes from `effective_delta`. Clearly mark cache-read weight and
legacy OTLP settings as legacy-only and inactive in Runtime Raiders mode. Update
README product overview, local developer commands, architecture, privacy, and
the Codex Desktop/CLI launch surfaces. List Omp and Claude Code only in a clearly
marked planned-provider section with their separate canary, privacy, adapter,
calibration, and allowlist gates; leave package, DB, service, and historical
document names unchanged.

- [ ] **Step 4: Run the stale-copy guard and fix every active hit**

Run: `npm run check:player-copy`

Expected: PASS. Historical specs/plans may retain ClaudeRPG terminology; active
UI and README may not.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/settings-meta.test.ts tests/web-admin-players.test.ts tests/web-admin-settings.test.ts`

```bash
git add src/web/views/admin-login.ejs src/web/views/admin-players.ejs src/web/views/admin-player-edit.ejs src/web/views/admin-settings.ejs src/domain/settings-meta.ts src/domain/playerhub.ts README.md tests/settings-meta.test.ts tests/web-admin-players.test.ts tests/web-admin-settings.test.ts
git commit -m "docs(brand): complete Runtime Raiders terminology"
```

### Task 7: Perform complete automated and visual rebrand verification

**Files:**
- Create: `docs/runtime-raiders/rebrand-visual-checklist.md`
- Modify: only files required to correct failures found in this task.

**Interfaces:**
- Consumes all prior product-rebrand tasks and a temporary database with sample Runs.
- Produces a locally approved, undeployed visual candidate.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run check:player-copy`

Run: `git diff --check`

Expected: all pass.

- [ ] **Step 2: Seed a disposable review database**

Create local-only Raiders covering male/female class sprites, zero/one/multiple
active Runs, Codex Desktop/CLI Latest Run states, Unknown model/effort, long
model duration, inventory, wardrobe tiers, potions, active Fight, defeat, and
resting states. Add a config-state fixture proving disabled Omp/Claude surfaces
do not appear in onboarding or status. Do not copy or alter
`data/claude-rpg.db`.

- [ ] **Step 3: Review every active surface in the browser**

At desktop and narrow mobile widths, review landing, registration, registered,
login, Raider Hub tabs/settings/Run Details, shop, wardrobe, admin, and error
states. Review `/tv` and `/tv/embed` at 1×/2× plus 1080p/4K proportions.

Confirm:

- moss walls, torch warmth, purple-black panels, `#e8c96a` gold, and pixel-art
  shading are unchanged;
- wine is restrained and no cool slate/cyberpunk palette appears;
- no card, tagline, wordmark, command, or Run Detail overflows;
- the dungeon stays the focal point;
- provider/model/effort look informational rather than competitive; and
- jokes target guild/monster life, never employee performance.

- [ ] **Step 4: Record evidence and commit any corrections**

Write the reviewed routes/viewports/states and screenshot paths to the visual
checklist. Re-run the targeted tests after each correction.

```bash
git add docs/runtime-raiders/rebrand-visual-checklist.md src tests
git commit -m "test(brand): approve Runtime Raiders visual system"
```

Stop here. Do not push or deploy. The deployment/cutover plan remains separately
gated on collector canaries, IT DNS, Caddy/TLS, Pi mDNS, a paused game, backups,
and explicit user approval.

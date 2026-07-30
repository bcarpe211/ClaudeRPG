# Timed consumables local review

This review uses a disposable database at an explicit path. The seeder refuses `:memory:`, the configured production database, directories, and existing non-empty database files. It never replaces or deletes a database.

## Start the deterministic demo

Use a path that does not already exist. If the example path is already occupied, change it to a new numbered path rather than reusing it.

```bash
PUBLIC_URL=http://localhost:8115 npm exec tsx tools/seed-potion-demo.ts -- /private/tmp/clauderpg-potion-demo.db
```

The command prints eight complete local character URLs and the local TV URL. Keep the token inside each URL; do not copy it into notes separately.

Start the app from the repository root in a separate terminal:

```bash
DB_PATH=/private/tmp/clauderpg-potion-demo.db \
PORT=8115 \
PUBLIC_URL=http://localhost:8115 \
SPRITES_DIR=/Users/carp/Code/ClaudeRPG/assets/oryx_16-bit_fantasy_1.1/Sliced \
OFFICE_TIME_ZONE=America/New_York \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=potion-demo-only \
SESSION_SECRET=potion-demo-local-session \
npm start
```

Open the printed URLs. The seeded cast has eight distinct classes, both genders, six active potion rows, Gold-only, Damage-only, dual-potion, debuff-only, potion-plus-debuff, and unaffected controls. The active boss has deliberately high health so the local engine cannot immediately end the visual review.

The fixture also includes two completed canonical audit rows using the same eight players: a Gold Potion with immutable 125,000g base plus 25,000g stretch payout, and a Damage Potion with 250 bonus damage, rank 1 → 2, and actual/counterfactual reward evidence. Potion Lab therefore has both live visual rows and completed report evidence.

## Reproduce Armed → Active locally

Use this separate fresh database only when reviewing the state transition. It contains the same eight-player cast, six active potion rows, two debuffs, one active encounter, and the historical Potion Lab evidence, but deliberately starts the encounter idle. No Pi or production database is involved.

```bash
PUBLIC_URL=http://localhost:8115 npm exec tsx tools/seed-potion-demo.ts -- --armed-review /private/tmp/clauderpg-potion-armed-demo.db
```

Start the app with the same local-only settings as above, replacing its `DB_PATH` with `/private/tmp/clauderpg-potion-armed-demo.db`. Open the printed **Quiet Berserker** character URL, open Inventory, and activate the spare Gold Potion through the confirmation dialog. Verify the new effect reads **Armed** and its remaining combat-active duration has not changed.

In a second local terminal, explicitly resume only that demo's combat clock:

```bash
DB_PATH=/Users/carp/Code/ClaudeRPG/data/claude-rpg.db \
npm exec tsx tools/seed-potion-demo.ts -- --resume /private/tmp/clauderpg-potion-armed-demo.db
```

Keep `DB_PATH` set to the configured production database path for this command; it is only compared, never opened. Refresh the Quiet Berserker page (or wait for the normal hub refresh). Verify the same potion now reads **Active**, with one millisecond of combat-active time consumed. The resume command refuses the configured production path and, before any write-capable database open, read-only verifies both the durable Armed-review marker and the known eight-player demo cast.

## Bazaar and inventory

- Open the Bazaar from a character page and verify quantities 1, 2, and 3 update the total price correctly.
- Verify each potion starts with three personal daily stock, purchased quantity lowers stock, and a purchase adds exactly that many bottles to Inventory.
- Complete one real purchase and verify the button animation, updated gold, updated inventory, and one matching `shop_purchase` ledger debit with the exact quantity total.
- Verify buying past remaining stock is blocked and midnight office-time restock copy is clear.
- With one potion sold out, verify both cards remain visible while the sibling potion can still be purchased.
- Confirm the Wardrobe upgrade card/empty-state behavior remains unchanged.
- After Wardrobe mastery and both potion stocks are exhausted, refresh and verify the closed-mimic scene replaces the potion shelf while the Adventurer Ledger remains.

## Activation and player hub

- Verify Live Dungeon is the default tab and includes the compact dungeon, compact leaderboard, Today statistics, Inventory, and Active Effects affordance.
- Activate an inventory potion through the confirmation step. Verify the confirmed SKU cannot change underneath the dialog.
- Use the separate Armed-review fixture above to verify the state reads Armed before explicit local combat resume, then Active; remaining duration changes only with combat-active time.
- Verify one active potion per type, Gold and Damage can overlap, and each type allows at most three daily doses.
- Verify Inventory quantities and daily uses update after activation.
- Begin an unsaved Wardrobe edit, change tabs, wait through the five-second hub refresh, and return. The draft must remain intact.
- Hover, keyboard-focus, click, and tap the character to open Active Effects. Verify each potion icon, remaining active time, short effect copy, Gold progress, and monster debuff appear together without overflowing the card.
- Verify click-away and Escape close the popover and return focus to the trigger.
- [x] Confirm Inventory uses the snapped Duskstone room with plain floor, two five-tile Thornwind corner patches, the top-row TV floor shadow, 28 fixed item cells, and no door or additional decorations. Approved 2026-07-30.
- Confirm the compact renderer has no TV backdrop: only the centered monster name/rounded HP strip and the complete rounded 20×15 dungeon are visible.
- At desktop width, confirm the 480×400 dungeon sits beside Fight Leaders and Today spans the full row beneath both.
- Confirm the dungeon has only a restrained bottom-right shadow; there is no four-sided halo or ambient glow.
- At narrow widths, confirm the order is dungeon, Fight Leaders, Today; Today becomes 3×2 and then 2×3 without overflow.

## Animated male/female effect review

Review every printed character URL, full `/tv`, and the compact Live Dungeon view. Let at least two complete A/B sprite cycles and several mote cycles play before judging a state.

- Confirm both male and female sprites animate with the approved slot maps and no effect canvas blocks either frame.
- Confirm the seeded Elder Demon alternates only between its matching A/B frames.
- Gold-only: solid gold square motes rise from the feet, step with restrained horizontal jitter, and stop only a few pixels above the character.
- Damage-only: solid red square motes use the same motion vocabulary and remain distinguishable over red clothing.
- Dual-potion: six motes alternate Gold and Damage, remain capped, and do not merge into an oversized ring or glow.
- Debuff-only: the monster debuff remains visible without potion motes.
- Potion-plus-debuff: front-layer potion motes and the debuff indicator coexist without obscuring the face, weapon, name, or damage feedback.
- Across all potion states, confirm mixed square sizes, crisp pixel edges, front-layer placement, dark offset shadow, restrained bloom, and short travel height.
- Check a crowded fight for readable player silhouettes and make sure hit effects still render above potion motes.
- Confirm full-TV potion squares are slightly smaller than the character-card motes while retaining the same colors, jitter, density, and rise.

## Responsive, input, and motion review

- Review desktop and narrow mobile widths. Purple cards and floating decoration must stay inside the moss-wall boundary.
- Verify the character page tab list is keyboard reachable and has a clear selected/focus state.
- Verify effect details are reachable by keyboard and touch, not hover alone.
- Emulate `prefers-reduced-motion: reduce`: potion motes should stop, information must remain available, and navigation/purchase state must still work.
- Verify the full TV remains visually unchanged except for the approved Gold/red potion motes.

## Admin Potion Lab

- Sign in at `http://localhost:8115/admin`, then open Potion Lab.
- Verify Gold purchase cost, immutable eligible work, base/stretch payout, net, and player/office-hour distributions.
- Verify Damage actual and counterfactual rank/reward copy explains that encounter gold is redistributed rather than minted.
- Verify potion spend, Gold Potion minting, encounter awards, monster steals, stock/use, inflow/outflow, and ledger reconciliation.
- Verify Tier 2 remains a human evidence gate: 14 combat days, 30 completed Gold activations, 30 completed Damage activations, and five distinct players. It must not unlock a product.
- Verify date, player, and SKU filters and confirm the page exposes no player authentication token.

## Automated release gate

Run from a clean process:

```bash
npm test
npm run typecheck
node --check src/web/public/shop.js
node --check src/web/public/player-hub.js
node --check src/web/public/potion-fx.js
node --check src/web/public/tv/tv.js
git diff --check
```

## Deferred Pi and production gate

Do not perform this section until Pi access is available and the user separately authorizes deployment.

- Copy no database to or from the Pi. Production data remains authoritative and untouched.
- Preserve the Pi's external sprite/assets directory; Git does not contain those production assets.
- Confirm `game_state.paused=1` immediately before deployment. If the game is not fully idle-paused, stop.
- Deploy only the reviewed commit through the existing idle-only update path.
- Verify the SSE `version` event causes the kiosk to reload onto the deployed commit without a manual stale page.
- Review a crowded production scene for mote density, animation smoothness, CPU load, TV layout, and collision behavior.
- Exercise purchase and activation with approved production test data only; confirm ledger reconciliation in Potion Lab.
- Treat Pi visual/performance verification and idle-only deployment as separate release approvals, not consequences of passing the local gate.

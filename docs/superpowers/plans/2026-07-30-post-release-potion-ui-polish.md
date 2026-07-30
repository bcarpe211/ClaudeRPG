# Post-release Potion UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contain potion feedback and inventory actions, replace generic purchase readiness copy, and show every current-fight participant in a bounded scrollable ledger.

**Architecture:** Keep potion behavior and data storage unchanged. Add product-specific copy to the existing server-rendered potion cards and let the existing shop client preserve it while quantities change. Remove only the player-hub fight-query display limit, then bound overflow in the player-hub CSS so the larger public list cannot resize the live layout.

**Tech Stack:** Node 26, TypeScript, Express/EJS, vanilla browser JavaScript, CSS, SQLite/better-sqlite3, Vitest.

## Global Constraints

- Do not change potion prices, effects, limits, duration, activation, active-time accounting, inventory, or wardrobe behavior.
- Affordable Gold copy is exactly `Ready to turn hard work into bonus gold.`
- Affordable Damage copy is exactly `Ready to put more force behind every hit.`
- Unaffordable quantity selections retain the exact missing-gold calculation and message.
- Current-fight ordering remains damage descending, then player ID ascending.
- The player-hub leaderboard includes only participants with positive current-fight damage.
- Do not change the TV leaderboard or its rotation.
- Do not deploy or push as part of this plan.

---

### Task 1: Compact, product-specific marketplace feedback

**Files:**
- Modify: `tests/shop-client-behavior.test.ts`
- Modify: `tests/web-shop.test.ts`
- Modify: `tests/shop-css.test.ts`
- Modify: `src/web/views/shop.ejs`
- Modify: `src/web/public/shop.js`
- Modify: `src/web/public/dungeon.css`

**Interfaces:**
- Consumes: each consumable offer's existing `potionType`, `missingGoldForOne`, unit price, player gold, and stock.
- Produces: `data-ready-copy: string` on each `[data-consumable-offer]`; the shop client uses it whenever the selected quantity is affordable.

- [ ] **Step 1: Write failing client tests for product-specific readiness copy**

Add `readyCopy?: string` to the `createShopHarness` options type in
`tests/shop-client-behavior.test.ts`:

```ts
readyCopy?: string;
```

Immediately after the harness sets `data-stock-remaining`, set the complete
simulated server attribute:

```ts
offer.setAttribute(
  'data-ready-copy',
  options.readyCopy ?? 'Ready to turn hard work into bonus gold.',
);
```

Replace the old affordable assertion in the quantity-total test:

```ts
expect(harness.offer.affordability.textContent).toBe(
  'Ready to turn hard work into bonus gold.',
);
```

Add a table-driven test proving quantity changes cannot replace either product's copy:

```ts
it.each([
  ['Ready to turn hard work into bonus gold.'],
  ['Ready to put more force behind every hit.'],
])('retains the product guidance %j for every affordable quantity', (readyCopy) => {
  const harness = createShopHarness({ readyCopy, playerGold: 500_000 });

  expect(harness.offer.affordability.textContent).toBe(readyCopy);
  harness.offer.input.value = '3';
  harness.offer.input.dispatch('input');

  expect(harness.offer.button.disabled).toBe(false);
  expect(harness.offer.affordability.textContent).toBe(readyCopy);
  expect(harness.offer.affordability.classList.contains('is-ready')).toBe(true);
});
```

- [ ] **Step 2: Write failing server-render and CSS containment tests**

In the existing consumables rendering test in `tests/web-shop.test.ts`, assert both cards expose and initially display their own line:

```ts
expect(res.text).toContain(
  'data-ready-copy="Ready to turn hard work into bonus gold."',
);
expect(res.text).toContain(
  'data-ready-copy="Ready to put more force behind every hit."',
);
expect(res.text).toContain('Ready to turn hard work into bonus gold.');
expect(res.text).toContain('Ready to put more force behind every hit.');
expect(res.text).not.toContain('Your purse is ready for 1.');
```

Add this behavior check to `tests/shop-css.test.ts`:

```ts
it('keeps the one-time potion result compact and inside the marketplace gutter', () => {
  const shell = declarations('.bazaar-open');
  const result = declarations('.bazaar-potion-result');

  expect(shell).toContain('--bazaar-gutter:clamp(22px,4vw,44px)');
  expect(result).toContain('box-sizing:border-box');
  expect(result).toContain('width:max-content');
  expect(result).toContain('max-width:calc(100% - 2 * var(--bazaar-gutter))');
  expect(result).toContain('padding:6px 10px!important');
  expect(marketplace).toMatch(
    /@media \(max-width:760px\)\{[\s\S]*?\.bazaar-open\{[^}]*--bazaar-gutter:18px/,
  );
  expect(marketplace).toMatch(
    /@media \(max-width:480px\)\{[\s\S]*?\.bazaar-open\{[^}]*--bazaar-gutter:13px/,
  );
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/shop-client-behavior.test.ts tests/web-shop.test.ts tests/shop-css.test.ts
```

Expected: FAIL because the page and client still emit `Your purse is ready for N`, no `data-ready-copy` exists, and the result notice is not content-box-safe or compact.

- [ ] **Step 4: Render and preserve each potion's approved guidance**

In the `shop.consumables` loop in `src/web/views/shop.ejs`, derive copy once and add it to the card:

```ejs
<% for (const offer of shop.consumables) {
  const unavailable = !offer.available;
  const soldOut = offer.available && offer.stockRemaining === 0;
  const readyCopy = offer.potionType === 'gold'
    ? 'Ready to turn hard work into bonus gold.'
    : 'Ready to put more force behind every hit.';
%>
  <article
    class="bazaar-product <%= offer.iconClass %><%= soldOut ? ' is-sold-out' : '' %><%= unavailable ? ' is-unavailable' : '' %>"
    data-consumable-offer
    data-unit-price="<%= offer.unitPrice %>"
    data-player-gold="<%= shop.gold %>"
    data-stock-remaining="<%= offer.stockRemaining %>"
    data-ready-copy="<%= readyCopy %>">
```

Use the same value in the server-rendered affordable branch:

```ejs
<% if (soldOut) { %>Back at midnight<% }
else if (offer.missingGoldForOne > 0) { %>Need <%= offer.missingGoldForOne.toLocaleString() %>g more for 1.<% }
else { %><%= readyCopy %><% } %>
```

In `src/web/public/shop.js`, read the page-owned line beside the existing numeric attributes:

```js
const readyCopy = offer.getAttribute('data-ready-copy');
if (!quantityInput || !button || !affordability || !readyCopy) return;
```

Replace only the affordable assignment:

```js
affordability.textContent = readyCopy;
affordability.classList.add('is-ready');
```

The missing-gold branch remains unchanged.

- [ ] **Step 5: Contain and compact the redirected purchase notice**

In `src/web/public/dungeon.css`, put the shared responsive gutter on `.bazaar-open`:

```css
.bazaar-open{--bazaar-gutter:clamp(22px,4vw,44px);position:relative;overflow:clip;min-height:440px;padding:0;
```

Replace `.bazaar-potion-result` with:

```css
.bazaar-potion-result{position:relative;z-index:2;box-sizing:border-box;width:max-content;
  max-width:calc(100% - 2 * var(--bazaar-gutter));margin:12px auto 4px!important;
  padding:6px 10px!important;line-height:1.35}
```

Immediately before the existing 760- and 480-pixel marketplace media blocks,
add standalone overrides that synchronize the gutter with the card padding:

```css
@media (max-width:760px){.bazaar-open{--bazaar-gutter:18px}}
@media (max-width:480px){.bazaar-open{--bazaar-gutter:13px}}
```

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```bash
npm test -- tests/shop-client-behavior.test.ts tests/web-shop.test.ts tests/shop-css.test.ts
node --check src/web/public/shop.js
```

Expected: all tests PASS and the browser script has valid syntax.

- [ ] **Step 7: Commit marketplace feedback**

```bash
git add tests/shop-client-behavior.test.ts tests/web-shop.test.ts tests/shop-css.test.ts src/web/views/shop.ejs src/web/public/shop.js src/web/public/dungeon.css
git commit -m "fix(shop): contain and clarify potion feedback"
```

---

### Task 2: Complete, scrollable current-fight ledger

**Files:**
- Modify: `tests/playerhub.test.ts`
- Modify: `tests/player-hub-css.test.ts`
- Modify: `src/domain/playerhub.ts`
- Modify: `src/web/public/player-hub.css`

**Interfaces:**
- Consumes: current encounter ID and positive `encounter_damage` rows.
- Produces: `PlayerHubState.currentFight.leaders` containing every positive-damage participant in deterministic rank order; `#hub-leaders` owns internal overflow scrolling.

- [ ] **Step 1: Write a failing state test with seven participants**

Add this test to `tests/playerhub.test.ts`:

```ts
it('returns every positive-damage current-fight participant in rank order', () => {
  const player = createPlayer(
    db,
    { name: 'Hero', class_key: 'wizard', gender: 'M' },
    now - 20_000,
  );
  const encounterId = seedFight(player.id);
  const addDamage = db.prepare(
    `INSERT INTO encounter_damage
      (encounter_id, player_id, damage_total, hits, max_hit)
     VALUES (?, ?, ?, 1, ?)`,
  );
  for (const [name, damage] of [
    ['Fourth', 400],
    ['Fifth', 300],
    ['Sixth', 200],
    ['Seventh', 100],
  ] as const) {
    const extra = createPlayer(
      db,
      { name, class_key: 'knight', gender: 'M' },
      now,
    );
    addDamage.run(encounterId, extra.id, damage, damage);
  }

  const hub = buildPlayerHubState(
    db,
    getPlayerById(db, player.id)!,
    now,
    timeZone,
  );

  expect(hub.currentFight.leaders.map(({ name, damage }) => [name, damage])).toEqual([
    ['Ahead', 900],
    ['Hero', 500],
    ['Fourth', 400],
    ['Fifth', 300],
    ['Sixth', 200],
    ['Behind', 100],
    ['Seventh', 100],
  ]);
});
```

This independently derives the expected order and proves the player-ID tie break with `Behind` before `Seventh`.

- [ ] **Step 2: Write a failing bounded-overflow CSS test**

Add these assertions to the live-layout test in `tests/player-hub-css.test.ts`:

```ts
expect(css).toMatch(
  /\.hub-fight-leaders\{[^}]*display:flex[^}]*flex-direction:column[^}]*max-height:400px[^}]*overflow:hidden/,
);
expect(css).toMatch(
  /#hub-leaders\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow-y:auto[^}]*overscroll-behavior:contain[^}]*scrollbar-gutter:stable/,
);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/playerhub.test.ts tests/player-hub-css.test.ts
```

Expected: the state test receives only five rows because of `LIMIT 5`, and the CSS test cannot find the bounded scroll surface.

- [ ] **Step 4: Return the full ordered ledger**

In `currentFight` in `src/domain/playerhub.ts`, remove only the display limit so the query ends with:

```sql
WHERE ed.encounter_id = ? AND ed.damage_total > 0
ORDER BY ed.damage_total DESC, p.id ASC
```

Do not change the filters or ordering.

- [ ] **Step 5: Bound the list beside the dungeon**

Replace the existing `.hub-fight-leaders` rule and add a child overflow rule in `src/web/public/player-hub.css`:

```css
.hub-fight-leaders{grid-area:leaders;display:flex;min-width:0;max-height:400px;
  flex-direction:column;overflow:hidden}
#hub-leaders{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  scrollbar-gutter:stable}
```

The existing ordered-list and row rules remain unchanged, preserving keyboard/wheel scrolling and rank rendering.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```bash
npm test -- tests/playerhub.test.ts tests/player-hub-css.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts
```

Expected: all tests PASS; both initial EJS rendering and client refresh accept the larger array.

- [ ] **Step 7: Commit the complete ledger**

```bash
git add tests/playerhub.test.ts tests/player-hub-css.test.ts src/domain/playerhub.ts src/web/public/player-hub.css
git commit -m "fix(player): show the complete fight ledger"
```

---

### Task 3: Keep active potion actions inside the detail card

**Files:**
- Modify: `tests/player-hub-css.test.ts`
- Modify: `src/web/public/player-hub.css`

**Interfaces:**
- Consumes: the existing `#hub-item-detail-content` flex column and all existing action labels.
- Produces: a 288-pixel minimum desktop card that expands for active-state content; the action remains border-box-contained.

- [ ] **Step 1: Replace the fixed-height CSS expectations with fitting behavior**

In `tests/player-hub-css.test.ts`, replace the current detail/card assertions in `keeps the wide potion ledger aligned with the inventory room` with:

```ts
expect(css).toMatch(
  /\.hub-item-detail\{[^}]*box-sizing:border-box[^}]*height:auto[^}]*min-height:288px[^}]*padding:12px/,
);
expect(css).toMatch(
  /#hub-item-detail-content\{[^}]*display:flex[^}]*height:auto[^}]*min-height:262px[^}]*flex-direction:column/,
);
expect(css).toMatch(
  /\.hub-item-detail \.btn\{[^}]*box-sizing:border-box[^}]*flex:0 0 auto[^}]*width:100%[^}]*max-width:100%[^}]*margin-top:auto/,
);
expect(constrainedPanel).toMatch(
  /\.hub-item-detail\{[^}]*height:auto[^}]*min-height:190px/,
);
expect(constrainedPanel).toMatch(
  /#hub-item-detail-content\{[^}]*height:auto[^}]*min-height:0/,
);
```

Keep the existing header, icon, definition-list, and active-progress alignment assertions.

- [ ] **Step 2: Run the CSS test and verify RED**

Run:

```bash
npm test -- tests/player-hub-css.test.ts
```

Expected: FAIL because the desktop detail and content use fixed heights and the action lacks explicit border-box/flex containment.

- [ ] **Step 3: Make the card grow only when content requires it**

Update the owning rules in `src/web/public/player-hub.css`:

```css
.hub-item-detail{box-sizing:border-box;height:auto;min-height:288px;padding:12px;
  border:1px solid var(--line);border-radius:11px;
  background:linear-gradient(180deg,#20142e,#100b18)}
#hub-item-detail-content{display:flex;height:auto;min-height:262px;flex-direction:column}
.hub-item-detail .btn{box-sizing:border-box;flex:0 0 auto;width:100%;max-width:100%;margin-top:auto}
```

Inside the existing `@container (max-width:739px)` block, make these three
rules exactly:

```css
.hub-item-detail{height:auto;min-height:190px}
#hub-item-detail-content{height:auto;min-height:0}
.hub-item-detail .btn{margin-top:14px}
```

- [ ] **Step 4: Run the focused behavior and CSS tests and verify GREEN**

Run:

```bash
npm test -- tests/player-hub-css.test.ts tests/player-hub-client.test.ts tests/web-character.test.ts
```

Expected: all tests PASS and the client still uses the same disabled labels and activation state.

- [ ] **Step 5: Commit the fitting potion detail**

```bash
git add tests/player-hub-css.test.ts src/web/public/player-hub.css
git commit -m "fix(player): contain active potion actions"
```

---

### Task 4: Release-candidate verification and visual review

**Files:**
- Verify: `src/web/views/shop.ejs`
- Verify: `src/web/public/shop.js`
- Verify: `src/web/public/dungeon.css`
- Verify: `src/domain/playerhub.ts`
- Verify: `src/web/public/player-hub.css`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a locally verified candidate only; no production deployment or push.

- [ ] **Step 1: Run syntax, targeted, full, and type verification**

Run:

```bash
node --check src/web/public/shop.js
node --check src/web/public/player-hub.js
npm test -- tests/shop-client-behavior.test.ts tests/web-shop.test.ts tests/shop-css.test.ts tests/playerhub.test.ts tests/player-hub-css.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts
npm test
npm run typecheck
git diff --check
```

Expected: every command PASS with no new warning or skipped test.

- [ ] **Step 2: Start a fresh disposable local review**

Create a unique directory and seed only its database:

```bash
POTION_POLISH_REVIEW_DIR="$(mktemp -d /private/tmp/clauderpg-potion-polish.XXXXXX)"
PUBLIC_URL=http://localhost:8121 npm exec tsx tools/seed-potion-demo.ts -- "$POTION_POLISH_REVIEW_DIR/demo.db"
```

Start the app from the repository root:

```bash
DB_PATH="$POTION_POLISH_REVIEW_DIR/demo.db" \
PORT=8121 \
PUBLIC_URL=http://localhost:8121 \
SPRITES_DIR=/Users/carp/Code/ClaudeRPG/assets/oryx_16-bit_fantasy_1.1/Sliced \
OFFICE_TIME_ZONE=America/New_York \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=potion-demo-only \
SESSION_SECRET=potion-demo-local-session \
npm start
```

Do not use the production database, production port, or a production token.

- [ ] **Step 3: Review the marketplace at desktop and narrow widths**

Open the seeded shop URL and verify:

1. the Gold card says `Ready to turn hard work into bonus gold.` for quantities 1–3 while affordable;
2. the Damage card says `Ready to put more force behind every hit.` for quantities 1–3 while affordable;
3. an unaffordable selection reports the exact missing-gold amount;
4. a simulated `?result=potion_success` notice is compact, centered, and remains within the purple marketplace at desktop, 760, 480, and 390 pixels; and
5. the Wardrobe purchase card and persistent Adventurer Ledger are unchanged.

- [ ] **Step 4: Review the active inventory and complete leaderboard**

Open `http://localhost:8121/character?token=local-potion-demo-3` and verify:

1. the active potion detail keeps `Potion Already Active` fully inside its card;
2. inactive, unavailable, and daily-limit labels also remain contained;
3. the normal wide detail remains aligned to the 288-pixel inventory room and grows only when active content requires it;
4. every seeded positive-damage participant appears in rank order;
5. overflowing leaders scroll inside the card without growing the dungeon row; and
6. narrow layouts retain the approved dungeon, leaders, Today order without horizontal overflow.

If a visual check fails, add one focused failing test to the owning test file before changing implementation, then repeat Steps 1, 3, and 4.

- [ ] **Step 5: Confirm repository state**

Run:

```bash
git status --short --branch
git log -4 --oneline
```

Expected: only the committed design, plan, and three focused implementation commits are present; no temporary database, token, generated asset, or review output is tracked.

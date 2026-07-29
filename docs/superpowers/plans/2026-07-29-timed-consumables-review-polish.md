# Timed Consumables Review Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the exhausted Bazaar, deterministic review boss, TV potion motes, Inventory room, and compact Live Dungeon match the approved review-polish design.

**Architecture:** Keep stock truth in `buildShopViewModel`, deterministic fixture choices in the demo seeder, and potion motion in the existing shared vocabulary. Build the Inventory room from native DOM controls over existing Oryx tile assets so polling, keyboard use, and potion activation retain their current contracts; reshape Live Dungeon with CSS around the existing compact TV iframe.

**Tech Stack:** Node 26, TypeScript, better-sqlite3, Express/EJS, browser JavaScript, CSS, Vitest, Supertest, Oryx 16-bit Fantasy assets.

## Global Constraints

- Do not change potion prices, effects, inventory rules, daily stock, daily use limits, combat calculations, or reward allocation.
- Keep sold-out potion cards visible while any potion has stock; show the closed Bazaar only when no wardrobe offer exists and every potion is sold out.
- Invalid potion tuning is unavailable, not sold out, and must keep its cards visible.
- Preserve the one-refresh `Dye Mastery Complete` state after the final wardrobe purchase.
- Keep the shared potion count, colors, jitter, rise, fade, and tier intensity unchanged; reduce only TV square display size.
- Keep Inventory cells as native buttons and preserve selection across polling by SKU.
- Use the existing Oryx and ClaudeRPG assets; add no dependency and generate no replacement artwork.
- Keep production and the Pi untouched. Do not push or deploy.

---

## File responsibility map

- `src/domain/shopview.ts` — computes canonical Bazaar exhausted/open state from offers and personal stock.
- `src/web/views/shop.ejs` — renders ordinary offers, one-refresh mastery, or the existing closed-mimic scene from the view model.
- `tools/seed-potion-demo.ts` — selects the deterministic animated review boss.
- `src/web/public/tv/tv.js` — scales potion-mote squares for the full and compact TV canvases.
- `src/web/views/character-inventory.ejs` — initial accessible dungeon-room inventory markup.
- `src/web/public/player-hub.js` — rebuilds the same inventory-cell contract after state polling.
- `src/web/public/player-hub.css` — dungeon-room art/layout and full-width Live Dungeon geometry.
- `src/web/views/character-live.ejs` — retains the compact-TV/leaderboard/stat semantic structure.
- `docs/testing/timed-consumables-local.md` — records the final local visual checks.

---

### Task 1: Close the Bazaar only after every offer is exhausted

**Files:**
- Modify: `tests/shopview.test.ts`
- Modify: `tests/web-shop.test.ts`
- Modify: `src/domain/shopview.ts`
- Modify: `src/web/views/shop.ejs`

**Interfaces:**
- Produces: `ShopViewModel.marketplaceClosed: boolean`.
- Consumes: `nextOffer: ShopOffer | null` and each `ConsumableOffer.available` / `stockRemaining` value already computed by `buildShopViewModel`.

- [ ] **Step 1: Write failing view-model tests for the complete state table**

Import and use the existing `purchase` and `purchaseConsumable` helpers. Add a local mastery helper to `tests/shopview.test.ts`:

```ts
function masterWardrobe(playerId: number): void {
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(playerId);
  purchase(db, playerId, 'cosmetic_wheel_t1', 1_500_000, now - 3);
  purchase(db, playerId, 'cosmetic_wheel_t2', 2_000_000, now - 2);
  purchase(db, playerId, 'cosmetic_wheel_t3', 2_500_000, now - 1);
}

function buyDailyStock(playerId: number, skuId: 'potion_gold_t1' | 'potion_damage_t1', requestId: string): void {
  const unitPrice = skuId === 'potion_gold_t1' ? 100_000 : 150_000;
  expect(purchaseConsumable(db, {
    playerId, skuId, quantity: 3, expectedUnitPrice: unitPrice,
    requestId, now, timeZone,
  })).toMatchObject({ ok: true, stockRemaining: 0 });
}
```

Add these assertions:

```ts
it('closes only when wardrobe and every configured potion are exhausted', () => {
  const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 10000000 WHERE id = ?').run(player.id);
  masterWardrobe(player.id);

  expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
    .toBe(false);
  buyDailyStock(player.id, 'potion_gold_t1', 'sold-gold');
  expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
    .toBe(false);
  buyDailyStock(player.id, 'potion_damage_t1', 'sold-damage');
  expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
    .toBe(true);
});

it('does not call invalid potion tuning sold out', () => {
  const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  masterWardrobe(player.id);
  setSetting(db, 'potion_damage_t1_base_hit_pct', 'not-a-number');

  expect(buildShopViewModel(db, player.id, undefined, undefined, now, timeZone)?.marketplaceClosed)
    .toBe(false);
});
```

- [ ] **Step 2: Run the focused view-model test and verify it fails**

Run:

```bash
npm test -- tests/shopview.test.ts
```

Expected: FAIL because `marketplaceClosed` does not exist.

- [ ] **Step 3: Compute the canonical closed state in `buildShopViewModel`**

Extend the interface:

```ts
export interface ShopViewModel {
  // existing fields
  marketplaceClosed: boolean;
}
```

After constructing `consumables`, compute:

```ts
const marketplaceClosed = nextOffer === null
  && consumables.every((offer) => offer.available && offer.stockRemaining === 0);
```

Return `marketplaceClosed` with the other view-model fields. The empty-array case intentionally evaluates to closed because it represents no configured wares; invalid tuning still returns two unavailable offers and therefore stays open.

- [ ] **Step 4: Run the view-model test and verify it passes**

Run:

```bash
npm test -- tests/shopview.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing route/render tests for one sold-out card and the fully closed scene**

In `tests/web-shop.test.ts`, modify the single sold-out test to purchase all three wardrobe tiers before exhausting Gold stock. Its existing assertions then prove the sold-out Gold card remains beside purchasable Damage stock. Add a second test that buys both daily stocks after mastery:

```ts
it('shows the closed mimic after wardrobe mastery and both daily stocks are exhausted', async () => {
  const { db, app, player } = ctx(10_000_000);
  purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 1);
  purchase(db, player.id, 'cosmetic_wheel_t2', 2_000_000, 2);
  purchase(db, player.id, 'cosmetic_wheel_t3', 2_500_000, 3);
  for (const [skuId, price, requestId] of [
    ['potion_gold_t1', 100_000, 'closed-gold'],
    ['potion_damage_t1', 150_000, 'closed-damage'],
  ] as const) {
    expect(purchaseConsumable(db, {
      playerId: player.id, skuId, quantity: 3, expectedUnitPrice: price,
      requestId, now: Date.now(), timeZone: 'America/New_York',
    })).toMatchObject({ ok: true, stockRemaining: 0 });
  }

  const response = await request(app).get('/shop').query({
    token: player.auth_token,
    result: 'potion_success',
  });

  expect(response.text).toContain('Potion stock added to your inventory.');
  expect(response.text).toContain('class="bazaar-closed"');
  expect(response.text).toContain('The Bazaar is Closed');
  expect(response.text).not.toContain('id="daily-potions-title"');
  expect(response.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
});
```

Update manual `renderPage('shop', ...)` fixtures to include the explicit `marketplaceClosed` property.

- [ ] **Step 6: Run the route test and verify it fails**

Run:

```bash
npm test -- tests/web-shop.test.ts
```

Expected: FAIL because `shop.ejs` still renders both consumable cards whenever the array is non-empty.

- [ ] **Step 7: Render consumables or the closed scene from `marketplaceClosed`**

Make these exact condition replacements in `shop.ejs`:

```ejs
<% if (shop.consumables.length > 0) { %>
```

becomes:

```ejs
<% if (!shop.marketplaceClosed && shop.consumables.length > 0) { %>
```

and:

```ejs
<% } else if (!shop.nextOffer && !(shop.mastered && purchaseResult === 'success')) { %>
```

becomes:

```ejs
<% } else if (shop.marketplaceClosed && !(shop.mastered && purchaseResult === 'success')) { %>
```

Do not filter individual cards. The one-refresh `Dye Mastery Complete` branch remains before this block and still wins only for `purchaseResult === 'success'`.

- [ ] **Step 8: Run the shop tests and commit**

Run:

```bash
npm test -- tests/shopview.test.ts tests/web-shop.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/domain/shopview.ts src/web/views/shop.ejs tests/shopview.test.ts tests/web-shop.test.ts
git commit -m "fix(shop): close the fully exhausted bazaar"
```

---

### Task 2: Seed one valid animated boss in the local review

**Files:**
- Modify: `tests/potion-demo.test.ts`
- Modify: `tools/seed-potion-demo.ts`

**Interfaces:**
- Consumes: `monsterByIndex(index)` from `src/domain/bestiary.ts` and `isFrameA(index)` from `src/web/public/anim.js` in the test.
- Produces: an active demo encounter with `creature_index = 188`, whose TV frame partner is `206`.

- [ ] **Step 1: Add a failing semantic boss assertion**

Import `monsterByIndex` and `isFrameA`, then add this to the complete-cast test after `seedPotionDemo`:

```ts
const encounter = db.prepare(
  "SELECT creature_index AS creatureIndex FROM encounters WHERE status='active'",
).get() as { creatureIndex: number };
expect(encounter.creatureIndex).toBe(188);
expect(isFrameA(encounter.creatureIndex)).toBe(true);
expect(monsterByIndex(encounter.creatureIndex)).toMatchObject({ boss: true });
```

- [ ] **Step 2: Run the demo test and verify it fails on index `35`**

Run:

```bash
npm test -- tests/potion-demo.test.ts
```

Expected: FAIL with received creature index `35`.

- [ ] **Step 3: Replace the invalid fixture sprite with the Elder Demon frame A**

Near the demo constants, add:

```ts
const DEMO_BOSS_CREATURE_INDEX = 188;
```

Move the `dungeonId` conversion directly after the dungeon insert so it can be used by the encounter insert:

```ts
const dungeonId = Number(dungeon.lastInsertRowid);
```

Use the constant in the active encounter insert:

```ts
VALUES (?, 1, 'boss', ?, 2, 1, 500000000, 499000000, 'active', ?,
```

Bind all three placeholders and remove the later duplicate `dungeonId` declaration:

```ts
).run(dungeonId, DEMO_BOSS_CREATURE_INDEX, now - 50_000);
```

- [ ] **Step 4: Run the test and commit**

Run:

```bash
npm test -- tests/potion-demo.test.ts
```

Expected: PASS.

Commit:

```bash
git add tools/seed-potion-demo.ts tests/potion-demo.test.ts
git commit -m "fix(potions): seed a coherent review boss"
```

---

### Task 3: Reduce TV potion squares without changing the shared motion vocabulary

**Files:**
- Modify: `tests/anim.test.ts`
- Modify: `src/web/public/tv/tv.js`

**Interfaces:**
- Consumes: unchanged `ClaudeRpgPotionFx.frame(...)` output with `mote.size` in source pixels.
- Produces: TV-only integer `moteScale = max(1, round(sourceScale × 2/3))`.

- [ ] **Step 1: Add a failing renderer contract test**

Extend the existing shared-potion-vocabulary test in `tests/anim.test.ts`:

```ts
const drawMotes = tvSource.slice(
  tvSource.indexOf('function drawPotionMotes'),
  tvSource.indexOf('function groundShadow'),
);
expect(drawMotes).toContain(
  'const moteScale = Math.max(1, Math.round(sourceScale * 2 / 3));',
);
expect(drawMotes).toContain('const size = mote.size * moteScale;');
expect(drawMotes).toContain('x + moteScale, y + moteScale');
expect(drawMotes).toContain('ctx.shadowBlur = moteScale;');
expect(drawMotes).toContain('mote.dx * sourceScale');
expect(drawMotes).toContain('mote.dy * sourceScale');
```

- [ ] **Step 2: Run the animation tests and verify failure**

Run:

```bash
npm test -- tests/anim.test.ts tests/potion-fx.test.ts
```

Expected: FAIL because size, shadow, and glow still use `sourceScale`.

- [ ] **Step 3: Apply the TV-only integer size scale**

In `drawPotionMotes`, retain `sourceScale` for `dx`/`dy` and add:

```js
const sourceScale = Math.max(1, Math.round(w / 26));
const moteScale = Math.max(1, Math.round(sourceScale * 2 / 3));
```

Use the smaller scale only for the square itself and its depth:

```js
const size = mote.size * moteScale;
const x = Math.round(drawX + mote.dx * sourceScale - size / 2);
const y = Math.round(drawY + mote.dy * sourceScale - size);
ctx.fillRect(x + moteScale, y + moteScale, size, size);
ctx.shadowBlur = moteScale;
```

- [ ] **Step 4: Run the tests and commit**

Run:

```bash
npm test -- tests/anim.test.ts tests/potion-fx.test.ts
node --check src/web/public/tv/tv.js
```

Expected: PASS.

Commit:

```bash
git add src/web/public/tv/tv.js tests/anim.test.ts
git commit -m "fix(potions): tighten TV mote scale"
```

---

### Task 4: Build the accessible dungeon-room Inventory

**Files:**
- Modify: `tests/web-character.test.ts`
- Modify: `tests/player-hub-client.test.ts`
- Modify: `tests/player-hub-css.test.ts`
- Modify: `src/web/views/character-inventory.ejs`
- Modify: `src/web/public/player-hub.js`
- Modify: `src/web/public/player-hub.css`

**Interfaces:**
- Preserves: `#hub-inventory-grid`, `[data-sku]`, `aria-pressed`, `#hub-item-detail`, and all potion activation IDs.
- Produces: `.hub-inventory-room`, decorative `.hub-room-tile` elements, title-free item cells, and accessible labels of the form `"<name>, <quantity> owned"`.

- [ ] **Step 1: Add failing server-rendered markup assertions**

In the owned-potion character test, assert:

```ts
expect(response.text).toContain('class="hub-inventory-room"');
expect(response.text).toContain('class="hub-room-tile hub-room-crack-a"');
expect(response.text).toContain('class="hub-room-tile hub-room-crack-b"');
expect(response.text).toContain('class="hub-room-tile hub-room-moss"');
expect(response.text).toContain('class="hub-room-tile hub-room-door"');
expect(response.text).toContain('aria-label="Beginner Gold Potion, 1 owned"');
expect(response.text).toContain('<span class="hub-item-qty" aria-hidden="true">1</span>');
expect(response.text).not.toContain('class="hub-item-name"');
```

- [ ] **Step 2: Add failing client-refresh assertions**

In `tests/player-hub-client.test.ts`, after the interaction harness renders inventory:

```ts
const gold = h.document.getElementById('hub-inventory-grid')!
  .querySelectorAll('[data-sku]')
  .find((button) => button.dataset.sku === 'potion_gold_t1')!;
expect(gold.getAttribute('aria-label')).toBe('Beginner Gold Potion, 2 owned');
expect(gold.children.some((child) => child.className === 'hub-item-name')).toBe(false);
expect(gold.children.find((child) => child.className === 'hub-item-qty')?.textContent).toBe('2');
```

Keep the existing selection/poll test as the proof that the selected SKU and reusable detail panel survive refresh.

- [ ] **Step 3: Add failing CSS/art assertions**

Extend `tests/player-hub-css.test.ts`:

```ts
it('builds a two-thirds dungeon-room inventory from existing pixel assets', () => {
  expect(css).toMatch(/\.hub-inventory-layout\{[^}]*grid-template-columns:\s*minmax\(0,2fr\) minmax\(240px,1fr\)/);
  expect(css).toMatch(/\.hub-inventory-room\{[^}]*border-image:[^}]*moss_wall\.png/);
  expect(css).toContain('/sprites/world_24x24/oryx_16bit_fantasy_world_349.png');
  expect(css).toContain('/sheet/world.png');
  expect(css).toMatch(/\.hub-room-door\{[^}]*background-position:\s*-1392px -144px/);
  expect(css).toMatch(/\.hub-item-qty\{[^}]*top:/);
  expect(css).toMatch(/\.hub-item-qty\{[^}]*text-shadow:/);
  expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-inventory-layout[^}]*grid-template-columns:\s*1fr/);
});
```

- [ ] **Step 4: Run the focused tests and verify they fail**

Run:

```bash
npm test -- tests/web-character.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts
```

Expected: FAIL because Inventory still uses named gradient cards and a roughly even split.

- [ ] **Step 5: Wrap the initial grid in deterministic dungeon-room decoration**

In `character-inventory.ejs`, replace the bare grid with:

```ejs
<div class="hub-inventory-room">
  <span class="hub-room-tile hub-room-crack-a" aria-hidden="true"></span>
  <span class="hub-room-tile hub-room-crack-b" aria-hidden="true"></span>
  <span class="hub-room-tile hub-room-moss" aria-hidden="true"></span>
  <div id="hub-inventory-grid" class="hub-inventory-grid" aria-label="Owned items">
    <% if (inventory.length === 0) { %>
      <div class="hub-satchel-empty"><strong>Your satchel is quiet.</strong><span>Purchased supplies will settle into these floor spaces.</span></div>
    <% } else { %>
      <% inventory.forEach(function (item, index) { %>
        <button type="button" class="hub-item-slot" data-sku="<%= item.sku %>"
          aria-label="<%= item.name %>, <%= item.quantity %> owned"
          aria-pressed="<%= index === 0 ? 'true' : 'false' %>">
          <img class="hub-item-icon <%= item.iconClass %>" src="/static/landing/potion.png" alt="" />
          <span class="hub-item-qty" aria-hidden="true"><%= item.quantity %></span>
        </button>
      <% }); %>
    <% } %>
  </div>
  <span class="hub-room-tile hub-room-door" aria-hidden="true"></span>
</div>
```

Keep the existing detail `<aside>` as the second child of `.hub-inventory-layout`.

- [ ] **Step 6: Make polling recreate the same accessible item cell**

Replace `inventoryButton` with:

```js
function inventoryButton(item) {
  const button = element('button', 'hub-item-slot');
  button.type = 'button';
  button.dataset.sku = item.sku;
  button.setAttribute('aria-label', `${item.name}, ${number.format(item.quantity)} owned`);
  button.setAttribute('aria-pressed', item.sku === selectedSku ? 'true' : 'false');
  const icon = element('img', `hub-item-icon ${item.iconClass}`);
  icon.src = '/static/landing/potion.png';
  icon.alt = '';
  const quantity = element('span', 'hub-item-qty', number.format(item.quantity));
  quantity.setAttribute('aria-hidden', 'true');
  button.append(icon, quantity);
  return button;
}
```

Change the dynamic empty copy to `Purchased supplies will settle into these floor spaces.` so initial and refreshed states match.

- [ ] **Step 7: Implement the two-thirds dungeon room and one-third detail layout**

Replace the existing Inventory CSS block with the following contract, preserving the existing detail-panel styles after it:

```css
.hub-inventory-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(240px,1fr);gap:14px;align-items:start}
.hub-inventory-room{position:relative;min-width:0;border:24px solid transparent;border-image:url('/static/landing/moss_wall.png') 8 round;background:#0a0d0a;box-shadow:inset 0 0 28px #000,0 10px 24px -18px #000}
.hub-inventory-grid{position:relative;z-index:1;display:grid;grid-template-columns:repeat(8,minmax(48px,1fr));grid-auto-rows:48px;min-height:144px;gap:0;padding:0;background:#182219 url('/sprites/world_24x24/oryx_16bit_fantasy_world_349.png') repeat;background-size:48px 48px}
.hub-room-tile{position:absolute;z-index:2;width:48px;height:48px;pointer-events:none;background-image:url('/sheet/world.png');background-repeat:no-repeat;background-size:2688px 1968px;image-rendering:pixelated}
.hub-room-crack-a{left:48px;top:-24px;background-position:-96px -288px}
.hub-room-crack-b{right:48px;top:-24px;background-position:-144px -288px}
.hub-room-moss{left:96px;bottom:0;z-index:0;background-position:-240px -288px;opacity:.72}
.hub-room-door{left:50%;bottom:-24px;transform:translateX(-50%);background-position:-1392px -144px}
.hub-item-slot{position:relative;z-index:3;min-width:48px;min-height:48px;margin:0;padding:5px;border:1px solid transparent;border-radius:0;background:transparent;box-shadow:none}
.hub-item-slot:hover{transform:none;border-color:#c9a649;background:#f2cf6920;box-shadow:inset 0 0 10px #f2cf691f}
.hub-item-slot:focus-visible{outline:2px solid var(--gold2);outline-offset:-3px}
.hub-item-slot[aria-pressed="true"]{border-color:var(--gold);background:#edca6a20;box-shadow:inset 0 0 0 2px #edca6a35,0 0 10px #e7bd4e26}
.hub-item-icon{display:block;width:32px;height:38px;margin:auto;image-rendering:pixelated;filter:drop-shadow(2px 3px 0 #060409)}
.hub-item-qty{position:absolute;right:3px;top:3px;color:#f4d769;font:900 11px/1 ui-monospace,monospace;text-shadow:1px 1px 0 #160b08,-1px 0 0 #160b08,0 -1px 0 #160b08}
.hub-satchel-empty{grid-column:1/-1;align-self:center;justify-self:center;padding:14px;text-align:center;color:var(--muted);text-shadow:1px 2px 0 #000}
```

Retain the existing Gold Potion hue filter after the shared icon declaration. At `max-width: 760px`, stack `.hub-inventory-layout`; at `max-width: 480px`, use six room columns:

```css
@media (max-width:480px){
  .hub-inventory-grid{grid-template-columns:repeat(6,minmax(48px,1fr))}
}
```

- [ ] **Step 8: Run the Inventory tests and commit**

Run:

```bash
npm test -- tests/web-character.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts
node --check src/web/public/player-hub.js
```

Expected: PASS.

Commit:

```bash
git add src/web/views/character-inventory.ejs src/web/public/player-hub.js src/web/public/player-hub.css tests/web-character.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts
git commit -m "feat(inventory): build the dungeon room grid"
```

---

### Task 5: Make the compact dungeon full width with 50/50 summaries below

**Files:**
- Modify: `tests/player-hub-css.test.ts`
- Modify: `tests/web-character.test.ts`
- Modify: `src/web/public/player-hub.css`
- Verify unchanged semantics: `src/web/views/character-live.ejs`

**Interfaces:**
- Preserves: `.hub-live-grid`, `.hub-dungeon`, `.hub-dungeon-frame`, `.hub-live-side`, `#hub-leaders`, and all `#hub-today-*` update targets.
- Produces: one full-width iframe row and a two-column summary row.

- [ ] **Step 1: Replace the old side-by-side CSS expectation with the approved geometry**

Add to `tests/player-hub-css.test.ts`:

```ts
it('gives the compact dungeon a full-width row and splits summaries beneath it', () => {
  expect(css).toMatch(/\.hub-live-grid\{[^}]*grid-template-columns:\s*1fr/);
  expect(css).toMatch(/\.hub-dungeon\{[^}]*padding:\s*0/);
  expect(css).toMatch(/\.hub-dungeon\{[^}]*overflow:\s*hidden/);
  expect(css).toMatch(/\.hub-live-side\{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)/);
  expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-live-side[^}]*grid-template-columns:\s*1fr/);
});
```

In `tests/web-character.test.ts`, keep asserting one compact iframe and add:

```ts
expect(res.text.match(/class="hub-dungeon"/g)).toHaveLength(1);
expect(res.text.match(/class="hub-live-side"/g)).toHaveLength(1);
expect(res.text.indexOf('class="hub-dungeon"'))
  .toBeLessThan(res.text.indexOf('class="hub-live-side"'));
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm test -- tests/player-hub-css.test.ts tests/web-character.test.ts
```

Expected: FAIL because the desktop grid still places `.hub-live-side` beside the dungeon.

- [ ] **Step 3: Reshape the existing semantic structure entirely in CSS**

Replace the Live Dungeon layout declarations with:

```css
.hub-live-grid{display:grid;grid-template-columns:1fr;gap:14px;align-items:start}
.hub-dungeon{min-width:0;padding:0;overflow:hidden;border:1px solid #30223d;border-radius:6px;background:#050308;box-shadow:0 12px 30px -22px #000}
.hub-dungeon-frame{display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:0;background:#050308}
.hub-live-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
```

Update the `max-width: 760px` rule to stack `.hub-live-side`:

```css
.hub-live-side{grid-template-columns:1fr}
```

Do not add another wrapper or duplicate the iframe; `character-live.ejs` already orders the dungeon before the summary container.

- [ ] **Step 4: Run the tests and commit**

Run:

```bash
npm test -- tests/player-hub-css.test.ts tests/web-character.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/web/public/player-hub.css tests/player-hub-css.test.ts tests/web-character.test.ts
git commit -m "feat(player): expand the compact live dungeon"
```

---

### Task 6: Update the review runbook and execute the complete local gate

**Files:**
- Modify: `docs/testing/timed-consumables-local.md`
- Verify: all changed production/test files from Tasks 1–5

**Interfaces:**
- Produces: a repeatable local review covering the newly approved visual states.

- [ ] **Step 1: Add the new review checks to the existing runbook**

Add these bullets to the relevant sections:

```markdown
- With one potion sold out, verify both cards remain visible while the sibling potion can still be purchased.
- After Wardrobe mastery and both potion stocks are exhausted, refresh and verify the closed-mimic scene replaces the potion shelf while the Adventurer Ledger remains.
- Confirm the seeded Elder Demon alternates only between its matching A/B frames.
- Confirm full-TV potion squares are slightly smaller than the character-card motes while retaining the same colors, jitter, density, and rise.
- Confirm Inventory is a moss-walled dungeon room with deterministic floor, cracks, moss, one door, title-free item tiles, and gold upper-right quantities.
- Confirm the compact dungeon uses the full panel width and Fight Leaders / Today split evenly beneath it.
```

- [ ] **Step 2: Run focused suites together**

Run:

```bash
npm test -- tests/shopview.test.ts tests/web-shop.test.ts tests/potion-demo.test.ts tests/anim.test.ts tests/potion-fx.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts tests/player-hub-css.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full automated release gate**

Run each command independently and require a zero exit status:

```bash
npm test
npm run typecheck
node --check src/web/public/shop.js
node --check src/web/public/player-hub.js
node --check src/web/public/potion-fx.js
node --check src/web/public/tv/tv.js
git diff --check
```

- [ ] **Step 4: Start a fresh isolated visual review**

Use a path that does not exist and a port not already occupied:

```bash
PUBLIC_URL=http://localhost:8116 npm exec tsx tools/seed-potion-demo.ts -- /private/tmp/clauderpg-potion-polish-review.db
```

Start only that database:

```bash
DB_PATH=/private/tmp/clauderpg-potion-polish-review.db \
PORT=8116 \
PUBLIC_URL=http://localhost:8116 \
SPRITES_DIR=/Users/carp/Code/ClaudeRPG/assets/oryx_16-bit_fantasy_1.1/Sliced \
OFFICE_TIME_ZONE=America/New_York \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=potion-polish-only \
SESSION_SECRET=potion-polish-local-session \
npm start
```

Do not reuse, replace, or delete another database if the example path is occupied; choose a new numbered path.

- [ ] **Step 5: Perform browser review at desktop and narrow widths**

Review the Bazaar, Twinbrew Ranger Inventory, Live Dungeon, and full TV. Verify all six visual bullets from Step 1, at least two complete boss cycles, Gold-only/Damage-only/dual motes, keyboard focus, selection persistence after one five-second poll, and no console errors. Restore any temporary viewport override before finishing and leave the useful review pages open for the user.

- [ ] **Step 6: Commit the runbook after the visual state passes**

```bash
git add docs/testing/timed-consumables-local.md
git commit -m "docs(potions): update the polish review gate"
```

- [ ] **Step 7: Record final repository evidence**

Run:

```bash
git status --short --branch
git log -6 --oneline
```

Expected: clean working tree on `feat/player-shop-cosmetics`, with no push or deployment performed.

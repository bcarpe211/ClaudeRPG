# Player Hub Inventory Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the Today section and replace the obsolete Inventory presentation with the approved responsive Duskstone/Thornwind 28-cell room.

**Architecture:** Keep the player-hub data model and interaction flow unchanged. Render one 54-tile decorative layer and one 28-cell interactive layer; CSS reflows both between wide and narrow snapped geometries, while polling updates only the interactive cells.

**Tech Stack:** Node 26, TypeScript, Express/EJS, browser JavaScript, CSS Grid, Vitest, Supertest

## Global Constraints

- This is presentation-only: do not change potion ownership, activation, filters, selected-item details, polling, daily limits, or combat behavior.
- Display every Oryx source tile at exactly 48×48 CSS pixels.
- Use the full 1366×1007 world-sheet dimensions, scaled to 2732×2014 at 2×.
- Wide room geometry is 9×6 with a 7×4 interactive interior; narrow geometry is 6×9 with a 4×7 interactive interior.
- The room has exactly 28 usable item cells. More than 28 distinct stacks remains out of scope.
- Use Duskstone row 12, Thornwind row 13, plain floor column 4 row 12, and shadow column 30 row 37.
- Moss appears only in five-cell patches at the top-left and bottom-right.
- Do not add a door, cracks, flowers, webs, torch, or floor accents.
- Live Dungeon uses a 12px row gap and a 6px Today heading gap at every width.
- Production and Raspberry Pi changes are out of scope.

---

### Task 1: Render stable decorative and interactive room layers

**Files:**
- Modify: `tests/web-character.test.ts:124-136`
- Modify: `tests/player-hub-client.test.ts:397-407`
- Modify: `src/web/views/character-inventory.ejs:15-36`
- Modify: `src/web/public/player-hub.js:108-142`

**Interfaces:**
- Consumes: the existing `inventory` view-model array and browser `state.inventory` array.
- Produces: `.hub-room-tiles` containing 54 `.hub-room-tile` elements and `#hub-inventory-grid` containing exactly 28 `.hub-inventory-cell` elements. Owned items remain `.hub-item-slot` buttons with `data-sku`.

- [ ] **Step 1: Replace the obsolete server-rendering expectations with failing layer/capacity expectations**

In `tests/web-character.test.ts`, replace the four assertions for `hub-room-crack-a`, `hub-room-crack-b`, `hub-room-moss`, and `hub-room-door` with:

```ts
expect(response.text).toContain('class="hub-room-tiles" aria-hidden="true"');
expect(response.text.match(/class="hub-room-tile"/g)).toHaveLength(54);
expect(response.text.match(/class="hub-inventory-cell"/g)).toHaveLength(28);
expect(response.text).not.toContain('hub-room-crack-a');
expect(response.text).not.toContain('hub-room-crack-b');
expect(response.text).not.toContain('hub-room-moss');
expect(response.text).not.toContain('hub-room-door');
```

- [ ] **Step 2: Add a failing browser-refresh capacity assertion**

In `tests/player-hub-client.test.ts`, extend `renders polling inventory cells with accessible quantity labels` after creating the harness:

```ts
const grid = h.document.getElementById('hub-inventory-grid')!;
expect(grid.children.filter((child) => child.className === 'hub-inventory-cell'))
  .toHaveLength(28);
```

Keep the existing accessible label, title-free cell, and quantity assertions.

- [ ] **Step 3: Run the focused tests and confirm they fail for the old room**

Run:

```bash
npm test -- tests/web-character.test.ts tests/player-hub-client.test.ts
```

Expected: FAIL because EJS still emits the obsolete decorations and the browser renderer does not create 28 cell wrappers.

- [ ] **Step 4: Replace the EJS room with the two-layer 54/28 structure**

In `src/web/views/character-inventory.ejs`, replace the current contents of `.hub-inventory-room` with this structure, preserving the existing item-button attributes and icon markup:

```ejs
<div class="hub-inventory-room">
  <div class="hub-room-tiles" aria-hidden="true">
    <% for (let tileIndex = 0; tileIndex < 54; tileIndex += 1) { %>
      <span class="hub-room-tile"></span>
    <% } %>
  </div>
  <div id="hub-inventory-grid" class="hub-inventory-grid" aria-label="Owned items">
    <% for (let cellIndex = 0; cellIndex < 28; cellIndex += 1) { %>
      <% const cellItem = inventory[cellIndex]; %>
      <div class="hub-inventory-cell">
        <% if (cellItem) { %>
          <button type="button" class="hub-item-slot" data-sku="<%= cellItem.sku %>"
            aria-label="<%= cellItem.name %>, <%= cellItem.quantity %> owned"
            aria-pressed="<%= cellIndex === 0 ? 'true' : 'false' %>">
            <img class="hub-item-icon <%= cellItem.iconClass %>" src="/static/landing/potion.png" alt="" />
            <span class="hub-item-qty" aria-hidden="true"><%= cellItem.quantity %></span>
          </button>
        <% } %>
      </div>
    <% } %>
    <% if (inventory.length === 0) { %>
      <div class="hub-satchel-empty"><strong>Your satchel is quiet.</strong><span>Purchased supplies will settle into these floor spaces.</span></div>
    <% } %>
  </div>
</div>
```

- [ ] **Step 5: Make polling rebuild the same 28-cell interactive layer**

In `src/web/public/player-hub.js`, add:

```js
const INVENTORY_CAPACITY = 28;

function inventoryCell(item) {
  const cell = element('div', 'hub-inventory-cell');
  if (item) cell.append(inventoryButton(item));
  return cell;
}
```

After computing `items` inside `renderInventory()`, constrain the visible room to its approved capacity:

```js
const visibleItems = items.slice(0, INVENTORY_CAPACITY);
if (!visibleItems.some((item) => item.sku === selectedSku)) {
  selectedSku = visibleItems[0]?.sku ?? null;
}
```

Then replace the item/empty append branch with:

```js
for (let index = 0; index < INVENTORY_CAPACITY; index += 1) {
  grid.append(inventoryCell(visibleItems[index]));
}
if (visibleItems.length === 0) {
  const empty = element('div', 'hub-satchel-empty');
  empty.append(element('strong', '', 'Your satchel is quiet.'));
  empty.append(element('span', '', 'Purchased supplies will settle into these floor spaces.'));
  grid.append(empty);
}
```

Do not change `selectedSku`, focus restoration, button delegation, detail rendering, or activation behavior.

- [ ] **Step 6: Run the focused tests and confirm they pass**

Run:

```bash
npm test -- tests/web-character.test.ts tests/player-hub-client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the stable room structure**

```bash
git add tests/web-character.test.ts tests/player-hub-client.test.ts src/web/views/character-inventory.ejs src/web/public/player-hub.js
git commit -m "feat(inventory): add stable 28-cell room layers"
```

---

### Task 2: Apply the approved atlas art and spacing rhythm

**Files:**
- Modify: `tests/player-hub-css.test.ts:20-47`
- Modify: `src/web/public/player-hub.css:46-82,103-123`
- Modify: `docs/testing/timed-consumables-local.md:72`

**Interfaces:**
- Consumes: the 54 decorative tiles and 28 interactive cells from Task 1.
- Produces: exact wide/narrow room geometry, approved atlas crops, five-cell moss patches, TV floor shadow, and compact Today spacing.

- [ ] **Step 1: Write failing CSS contract tests for Today and the approved room**

In `tests/player-hub-css.test.ts`, add these assertions to the Live Dungeon test:

```ts
expect(css).toMatch(/\.hub-live-grid\{[^}]*gap:\s*12px 20px/);
expect(css).toMatch(/\.hub-today-panel h3\{[^}]*margin:\s*0 0 6px/);
```

Replace the obsolete dungeon-room test with assertions covering:

```ts
expect(css).toMatch(/\.hub-inventory-layout\{[^}]*grid-template-columns:\s*minmax\(0,2fr\) minmax\(240px,1fr\)/);
expect(css).toMatch(/\.hub-inventory-room\{[^}]*--room-columns:\s*9[^}]*--room-rows:\s*6/);
expect(css).toMatch(/\.hub-room-tiles\{[^}]*grid-template-columns:\s*repeat\(var\(--room-columns\),48px\)/);
expect(css).toMatch(/\.hub-room-tile\{[^}]*background-size:\s*2732px 2014px/);
expect(css).toContain('background-position:-192px -576px');
expect(css).toContain('background-position:-1440px -1776px');
expect(css).toContain('-816px -624px');
expect(css).toContain('-960px -624px');
expect(css).toMatch(/\.hub-inventory-grid\{[^}]*grid-template-columns:\s*repeat\(7,48px\)/);
expect(css).toMatch(/@container \(max-width:\s*520px\)[\s\S]*--room-columns:\s*6[\s\S]*--room-rows:\s*9/);
expect(css).toMatch(/@container \(max-width:\s*520px\)[\s\S]*\.hub-inventory-grid\{[^}]*repeat\(4,48px\)/);
expect(css).not.toContain('moss_wall.png');
expect(css).not.toContain('.hub-room-door');
expect(css).not.toContain('.hub-room-crack');
```

Keep the quantity badge and stacked-detail assertions.

- [ ] **Step 2: Run the CSS test and confirm it fails**

Run:

```bash
npm test -- tests/player-hub-css.test.ts
```

Expected: FAIL on the old 22px gap, old moss border, and missing snapped room rules.

- [ ] **Step 3: Tighten Today without increasing the primary panel height**

In `src/web/public/player-hub.css`:

```css
.hub-live-grid{display:grid;grid-template-columns:minmax(0,480px) minmax(240px,1fr);grid-template-areas:"dungeon leaders" "today today";gap:12px 20px;align-items:stretch}
.hub-subpanel h3{margin:0 0 10px;color:#cdb767;font:850 11px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}
.hub-today-panel h3{margin:0 0 6px;color:#cdb767;font:850 11px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}
```

Do not add bottom margin or padding to `.hub-live-grid`, `.hub-today-panel`, or `.hub-panel`.

- [ ] **Step 4: Replace the obsolete Inventory CSS with the wide snapped room**

Use the following base geometry and atlas contract:

```css
.hub-inventory-room{--room-columns:9;--room-rows:6;position:relative;justify-self:center;width:432px;height:288px;min-width:0;overflow:hidden;background:#080807;box-shadow:0 18px 42px #000c;image-rendering:pixelated}
.hub-room-tiles{position:absolute;inset:0;display:grid;grid-template-columns:repeat(var(--room-columns),48px);grid-template-rows:repeat(var(--room-rows),48px);pointer-events:none}
.hub-room-tile{position:relative;width:48px;height:48px;background-image:url('/sheet/world.png');background-repeat:no-repeat;background-size:2732px 2014px;background-position:-192px -576px;image-rendering:pixelated}
.hub-room-tile::after{position:absolute;z-index:1;inset:0;background-image:url('/sheet/world.png');background-repeat:no-repeat;background-size:2732px 2014px;background-position:-1440px -1776px;image-rendering:pixelated;pointer-events:none}
.hub-inventory-grid{position:absolute;z-index:2;left:48px;top:48px;display:grid;grid-template-columns:repeat(7,48px);grid-template-rows:repeat(4,48px);width:336px;height:192px}
.hub-inventory-cell{position:relative;width:48px;height:48px}
```

Add these exact `:nth-child()` groups for the 9×6 room:

```css
.hub-room-tile:nth-child(-n+9),
.hub-room-tile:nth-child(n+46){background-position:-576px -576px}
.hub-room-tile:nth-child(9n+1),
.hub-room-tile:nth-child(9n){background-position:-720px -576px}
.hub-room-tile:nth-child(1){background-position:-816px -576px}
.hub-room-tile:nth-child(9){background-position:-864px -576px}
.hub-room-tile:nth-child(46){background-position:-912px -576px}
.hub-room-tile:nth-child(54){background-position:-960px -576px}

.hub-room-tile:nth-child(1){background-position:-816px -624px}
.hub-room-tile:nth-child(2),
.hub-room-tile:nth-child(3){background-position:-576px -624px}
.hub-room-tile:nth-child(10),
.hub-room-tile:nth-child(19){background-position:-720px -624px}
.hub-room-tile:nth-child(54){background-position:-960px -624px}
.hub-room-tile:nth-child(52),
.hub-room-tile:nth-child(53){background-position:-576px -624px}
.hub-room-tile:nth-child(36),
.hub-room-tile:nth-child(45){background-position:-720px -624px}

.hub-room-tile:nth-child(11)::after,
.hub-room-tile:nth-child(12)::after,
.hub-room-tile:nth-child(13)::after,
.hub-room-tile:nth-child(14)::after,
.hub-room-tile:nth-child(15)::after,
.hub-room-tile:nth-child(16)::after,
.hub-room-tile:nth-child(17)::after{content:""}
```

Keep `.hub-item-slot`, `.hub-item-icon`, `.hub-item-qty`, selected/focus styles, and the detail panel behavior. Replace the old grid-spanning empty-state rule with:

```css
.hub-satchel-empty{position:absolute;z-index:4;inset:0;display:grid;place-content:center;padding:14px;text-align:center;color:var(--muted);text-shadow:1px 2px 0 #000}
.hub-satchel-empty strong{display:block;margin-bottom:4px;color:var(--head)}
```

This keeps the message over the 28-cell interior instead of creating a 29th grid track.

- [ ] **Step 5: Add the narrow 6×9 / 4×7 snapped geometry**

Inside `@container (max-width:520px)`:

```css
.hub-inventory-room{--room-columns:6;--room-rows:9;width:288px;height:432px}
.hub-inventory-grid{grid-template-columns:repeat(4,48px);grid-template-rows:repeat(7,48px);width:192px;height:336px}
.hub-room-tile{background-position:-192px -576px}
.hub-room-tile::after{content:none}

.hub-room-tile:nth-child(-n+6),
.hub-room-tile:nth-child(n+49){background-position:-576px -576px}
.hub-room-tile:nth-child(6n+1),
.hub-room-tile:nth-child(6n){background-position:-720px -576px}
.hub-room-tile:nth-child(1){background-position:-816px -576px}
.hub-room-tile:nth-child(6){background-position:-864px -576px}
.hub-room-tile:nth-child(49){background-position:-912px -576px}
.hub-room-tile:nth-child(54){background-position:-960px -576px}

.hub-room-tile:nth-child(1){background-position:-816px -624px}
.hub-room-tile:nth-child(2),
.hub-room-tile:nth-child(3){background-position:-576px -624px}
.hub-room-tile:nth-child(7),
.hub-room-tile:nth-child(13){background-position:-720px -624px}
.hub-room-tile:nth-child(54){background-position:-960px -624px}
.hub-room-tile:nth-child(52),
.hub-room-tile:nth-child(53){background-position:-576px -624px}
.hub-room-tile:nth-child(42),
.hub-room-tile:nth-child(48){background-position:-720px -624px}

.hub-room-tile:nth-child(8)::after,
.hub-room-tile:nth-child(9)::after,
.hub-room-tile:nth-child(10)::after,
.hub-room-tile:nth-child(11)::after{content:""}
}
```

The media query that stacks `.hub-inventory-layout` beneath 760px remains unchanged.

- [ ] **Step 6: Update the local review checklist**

Replace the obsolete Inventory sentence in `docs/testing/timed-consumables-local.md` with:

```markdown
- [ ] Confirm Inventory uses the snapped Duskstone room with plain floor, two five-tile Thornwind corner patches, the top-row TV floor shadow, 28 fixed item cells, and no door or additional decorations.
```

- [ ] **Step 7: Run the focused tests and confirm they pass**

Run:

```bash
npm test -- tests/player-hub-css.test.ts tests/web-character.test.ts tests/player-hub-client.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the approved art and spacing**

```bash
git add tests/player-hub-css.test.ts src/web/public/player-hub.css docs/testing/timed-consumables-local.md
git commit -m "style(player): apply approved inventory room"
```

---

### Task 3: Verify behavior and visual geometry

**Files:**
- Verify only; no expected source changes.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: automated evidence and a refreshed local review page at wide and narrow widths.

- [ ] **Step 1: Run the full automated verification**

Run:

```bash
npm test
npm run typecheck
node --check src/web/public/player-hub.js
git diff --check
```

Expected: all commands pass with no warnings or whitespace errors.

- [ ] **Step 2: Reload the disposable local review and inspect the wide layout**

At `http://localhost:8120/character?token=local-potion-demo-3`:

- confirm Today is 12px below the first row and its title is 6px above the cards;
- confirm the bottom of the primary panel has not grown;
- confirm Inventory shows a 9×6 outer room and 7×4 item interior;
- confirm the two potions remain 48px-cell items with gold upper-right quantities; and
- confirm Duskstone, Thornwind moss, and shadow crops have no neighboring-tile bleed.

- [ ] **Step 3: Inspect the narrow layout**

Use a viewport narrow enough to trigger the 520px container rule and confirm:

- room geometry snaps to 6×9 with a 4×7 item interior;
- no tile is continuously scaled or stretched;
- the details panel stacks beneath the room;
- Today uses the same compact vertical rhythm; and
- all 28 cells remain represented.

- [ ] **Step 4: Exercise the unchanged interaction flow**

Select each potion, switch filters, trigger the activation confirmation, cancel once, and confirm the selected SKU and details remain synchronized after the next state poll.

- [ ] **Step 5: Record any visual-only corrections as a separate reviewed patch**

If the browser review finds an atlas-coordinate, layering, or spacing mismatch, first add or tighten the corresponding focused assertion, then make the smallest CSS/EJS correction and rerun Task 3 Step 1. Do not change game logic or expand the room beyond 28 cells.

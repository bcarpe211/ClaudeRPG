# Wardrobe Responsive Controls and Shop Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Wardrobe control layout, wall-safe responsive shell, authenticated Store shortcut, and one-time Tier 3 mastery-to-closed-Bazaar transition.

**Architecture:** Keep the existing server-rendered EJS pages and the established saved/draft Wardrobe controller. Rearrange stable DOM hooks without changing persistence semantics, add scoped CSS for the approved visual flow, and select the completed-shop presentation from the existing `shop.mastered` and allow-listed `purchaseResult` values. The final-success query value is consumed client-side with `history.replaceState` so the rendered celebration remains visible once and a refresh naturally enters the closed-shop state.

**Tech Stack:** Node 26, TypeScript, Express, EJS, vanilla browser JavaScript, CSS, Vitest, Supertest, SQLite via better-sqlite3.

## Global Constraints

- Work only on `feat/player-shop-cosmetics`; do not merge, push, deploy, restart the Pi, or mutate production data.
- Do not change slot maps, class/gender channel availability, entitlement prices, cosmetic rendering, or the atomic batch-save endpoint.
- Preserve the existing saved/draft model: Save writes every dirty channel in one transaction, Discard is local, Restore Default stages one active-channel clear, and Reload appears only after a stale save conflict.
- Preserve `Cache-Control: private, no-store` on authenticated Character and Shop HTML and immutable caching on content-addressed sprite PNGs.
- The Store shortcut must retain the authenticated character token and stay inside the player profile card, not global navigation.
- The Adventurer Ledger is the only Return to Character button in authenticated Shop states.
- No new runtime dependency, inventory model, future-product model, timed consumable, loot box, gem, pet, or combat change is included.
- Keep existing reduced-motion behavior and visible keyboard focus treatment.

---

## File map

- Modify `src/web/views/character-sheet.ejs` — semantic player header, token-preserving Store link, save-status placement, and final action-strip order.
- Modify `src/web/public/dungeon.css` — character header, compact Wardrobe controls, wall-safe shell, closed-state integration, and responsive rules.
- Modify `src/web/views/shop.ejs` — distinguish one-time mastery success from the ordinary no-products closed state.
- Modify `src/web/public/shop.js` — consume the one-time `result` query signal before running the existing purchase enhancement.
- Modify `tests/web-dye.test.ts` — Character and Wardrobe DOM contracts.
- Modify `tests/dye-css.test.ts` — approved Wardrobe layout/style contracts.
- Create `tests/dungeon-shell-css.test.ts` — shared wall-safe shell contract.
- Modify `tests/web-shop.test.ts` — one-time mastery, closed Bazaar, and persistent ledger contracts.
- Modify `tests/shop-css.test.ts` — closed scene integration inside the marketplace shell.
- Modify `tests/shop-client-behavior.test.ts` — result-query cleanup without breaking purchase animation.

No route or domain file changes are required: `src/web/routes/shop.ts` already allow-lists `result`, passes `purchaseResult`, and builds the mastered view model needed by the template.

---

### Task 1: Reorder the Character and Wardrobe markup

**Files:**
- Modify: `tests/web-dye.test.ts:441-509`
- Modify: `src/web/views/character-sheet.ejs:1-103`

**Interfaces:**
- Consumes: existing EJS values `player`, `className`, `connected`, `dye`, `avatarA`, and `avatarB`; existing browser hooks `#dye-save-status`, `#dye-reload`, `#dye-discard`, and `#dye-save`.
- Produces: `.character-profile-head`, `.character-profile-identity`, `.character-store`, `.dye-action-label`, `.dye-action-strip`, and `.dye-action` hooks for Task 2. All existing IDs remain unchanged for `src/web/public/dye.js`.

- [ ] **Step 1: Write the failing Character DOM tests**

In `tests/web-dye.test.ts`, extend the Tier-0 test to assert the profile Store link and replace the three long-button assertions in the Tier-1 test with the approved location and order contract:

```ts
expect(res.text).toContain(
  `class="btn btn-gold character-store" href="/shop?token=${encodeURIComponent(player.auth_token)}"`,
);
```

Add this test in `describe('character wardrobe panel')`:

```ts
it('places status on the fitting stage and closes the Tone flow with compact draft actions', async () => {
  const { db, app, player } = ctx();
  buy(db, player.id, 1);

  const res = await request(app).get('/character').query({ token: player.auth_token });
  const stage = res.text.match(/<div class="dye-stage">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const tone = res.text.indexOf('class="dye-tone-label"');
  const finishes = res.text.indexOf('class="dye-finishes"');
  const restore = res.text.indexOf('data-recipe="none"');
  const actionLabel = res.text.indexOf('class="dye-action-label"');
  const actions = res.text.indexOf('class="dye-action-strip"');

  expect(stage).toContain('id="dye-save-status"');
  expect(stage).toContain('role="status" aria-live="polite"');
  expect(tone).toBeGreaterThan(-1);
  expect(finishes).toBeGreaterThan(tone);
  expect(restore).toBeGreaterThan(finishes);
  expect(actionLabel).toBeGreaterThan(restore);
  expect(actions).toBeGreaterThan(actionLabel);
  expect(res.text).toContain('id="dye-reload" type="button" class="btn btn-ghost dye-action dye-reload" hidden');
  expect(res.text).toContain('<span>Reload</span>');
  expect(res.text).toContain('<span>Discard</span>');
  expect(res.text).toContain('<span>Save</span>');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- tests/web-dye.test.ts
```

Expected: FAIL because the profile has no `.character-store`, status is still in the toolbox, and the compact action-strip hooks do not exist.

- [ ] **Step 3: Replace the profile header markup**

Replace `src/web/views/character-sheet.ejs:1-11` with:

```ejs
<div class="panel">
  <div class="character-profile-head">
    <div class="character-avatar sprite-anim">
      <img id="character-avatar-a" src="<%= avatarA %>" alt="avatar" class="px frame-a" />
      <img id="character-avatar-b" src="<%= avatarB %>" alt="" class="px frame-b" />
    </div>
    <div class="character-profile-identity">
      <h1><%= player.name %></h1>
      <p><span><%= className %></span> · <%= player.gender === 'M' ? 'Male' : 'Female' %> · <%= connected ? 'Connected' : 'Not seen yet' %></p>
    </div>
    <a class="btn btn-gold character-store" href="/shop?token=<%= encodeURIComponent(player.auth_token) %>">
      <span aria-hidden="true">✦</span><span>Store</span>
    </a>
  </div>
```

Leave the stat grid and the panel's closing tag unchanged.

- [ ] **Step 4: Move status into the stage and actions below Restore Default**

In the `.dye-stage`, place status immediately after the stage label:

```ejs
<span class="dye-stage-label">Live fitting</span>
<span id="dye-save-status" class="dye-save-status" data-state="saved" role="status" aria-live="polite">Saved</span>
<canvas id="dye-preview" width="168" height="168" class="px dye-preview" aria-label="Live character dye preview"></canvas>
```

Delete the old `.dye-actions` block from above `.dye-paint-row`. Inside `.dye-tone-section`, after `.dye-finishes`, add:

```ejs
<span class="dye-action-label">Wardrobe changes</span>
<div class="dye-action-strip">
  <button id="dye-reload" type="button" class="btn btn-ghost dye-action dye-reload" hidden title="Reload the latest saved Wardrobe">
    <span class="dye-action-icon" aria-hidden="true">↻</span><span>Reload</span>
  </button>
  <button id="dye-discard" type="button" class="btn btn-ghost dye-action dye-discard" disabled title="Discard all unsaved changes">
    <span class="dye-action-icon" aria-hidden="true">×</span><span>Discard</span>
  </button>
  <button id="dye-save" type="button" class="btn btn-gold dye-action dye-save" disabled title="Save all Wardrobe changes">
    <span class="dye-action-icon" aria-hidden="true">✓</span><span>Save</span>
  </button>
</div>
```

Do not rename any button ID or change `src/web/public/dye.js`.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
npm test -- tests/web-dye.test.ts tests/dye-client-behavior.test.ts
```

Expected: PASS. The browser behavior tests prove the rearranged IDs retain atomic Save, local Discard, staged Restore Default, and stale-only Reload behavior.

- [ ] **Step 6: Commit the semantic layout**

```bash
git add src/web/views/character-sheet.ejs tests/web-dye.test.ts
git commit -m "feat(wardrobe): order the final editing controls"
```

---

### Task 2: Style the profile, fitting status, and joined action strip

**Files:**
- Modify: `tests/dye-css.test.ts:1-42`
- Modify: `src/web/public/dungeon.css:118-267`

**Interfaces:**
- Consumes: the Task 1 hooks `.character-profile-head`, `.character-profile-identity`, `.character-store`, `.dye-save-status`, `.dye-action-label`, `.dye-action-strip`, and `.dye-action`.
- Produces: a three-column desktop profile that wraps Store under identity on small screens; absolute stage status; a two-button normal strip that naturally expands to three controls when Reload loses `hidden`.

- [ ] **Step 1: Write the failing CSS contract**

Append to `tests/dye-css.test.ts`:

```ts
it('integrates the Store, stage status, and final joined actions without oversized buttons', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const profile = css.match(/\.character-profile-head\{([^}]*)\}/)?.[1] ?? '';
  const status = css.match(/\.dye-save-status\{([^}]*)\}/)?.[1] ?? '';
  const strip = css.match(/\.dye-action-strip\{([^}]*)\}/)?.[1] ?? '';
  const action = css.match(/\.dye-action\{([^}]*)\}/)?.[1] ?? '';

  expect(profile).toContain('grid-template-columns:auto minmax(0,1fr) auto');
  expect(css).toContain('.character-store{justify-self:end');
  expect(status).toContain('position:absolute');
  expect(status).toContain('right:10px');
  expect(status).toContain('top:10px');
  expect(strip).toContain('display:flex');
  expect(strip).toContain('overflow:hidden');
  expect(action).toContain('flex:1');
  expect(action).toContain('height:40px');
  expect(action).toContain('border-radius:0');
  expect(css).toMatch(/@media \(max-width:620px\)\{[\s\S]*?\.character-store\{[^}]*grid-column:2/);
});
```

- [ ] **Step 2: Run the CSS test and verify failure**

Run:

```bash
npm test -- tests/dye-css.test.ts
```

Expected: FAIL because none of the new structural selectors is styled and status is still a normal flex item.

- [ ] **Step 3: Add the profile component styles**

Add after the `/* character-sheet stat cards */` comment in `src/web/public/dungeon.css`:

```css
.character-profile-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;
  gap:20px;align-items:center}
.character-profile-head .character-avatar{width:112px;height:112px;border:1px solid var(--line);
  border-radius:16px;background:linear-gradient(180deg,var(--panel2),var(--panel));
  box-shadow:inset 0 1px 0 #ffffff0d}
.character-profile-identity{min-width:0}.character-profile-identity h1{margin:0 0 6px}
.character-profile-identity p{margin:0;color:var(--muted)}
.character-profile-identity p span{color:var(--gold2);font-weight:700}
.character-store{justify-self:end;white-space:nowrap}
```

- [ ] **Step 4: Restyle status and add the final action strip**

Change `.dye-save-status` so its first declarations are:

```css
.dye-save-status{position:absolute;z-index:3;right:10px;top:10px;display:inline-flex;
  align-items:center;gap:7px;margin:0;padding:6px 10px;border:1px solid var(--line);
  border-radius:999px;background:#0c0912dd;color:var(--muted);font-size:10px;
  font-weight:800;letter-spacing:.04em;text-transform:uppercase}
```

After `.dye-fin-default`, add:

```css
.dye-action-label{display:block;margin:11px 0 6px;color:var(--muted);font-size:9px;
  font-weight:850;letter-spacing:.12em;text-transform:uppercase}
.dye-action-strip{display:flex;min-width:0;border:1px solid #554061;border-radius:8px;
  overflow:hidden;background:#17101f}
.dye-action{position:relative;flex:1;min-width:0;height:40px;margin:0;padding:7px 8px;
  justify-content:center;border:0;border-radius:0;box-shadow:none;font-size:11px;gap:6px}
.dye-action:not(:last-child){border-right:1px solid #554061}
.dye-action:hover{transform:none;box-shadow:none}.dye-action-icon{font-size:14px;line-height:1}
.dye-action:focus-visible{z-index:1;outline:2px solid var(--gold);outline-offset:-3px}
```

The `hidden` attribute keeps Reload out of flex layout during normal editing, so Discard and Save each consume half the strip. When stale handling sets `reloadButton.hidden = false`, all three controls share the row.

- [ ] **Step 5: Replace the narrow-profile/status rule**

Replace the current `@media (max-width:620px)` block with:

```css
@media (max-width:620px){
  .character-profile-head{grid-template-columns:auto minmax(0,1fr);align-items:start}
  .character-store{grid-column:2;justify-self:start;padding:9px 12px}
  .dye-head{display:block}.dye-save-status{padding:5px 7px;font-size:9px}
  .dye-unavailable{grid-template-columns:1fr}
}
```

- [ ] **Step 6: Run the focused UI tests**

Run:

```bash
npm test -- tests/dye-css.test.ts tests/web-dye.test.ts tests/dye-client-behavior.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the Wardrobe styling**

```bash
git add src/web/public/dungeon.css tests/dye-css.test.ts
git commit -m "style(wardrobe): compact the final editing flow"
```

---

### Task 3: Keep every panel inside the moss-wall safe area

**Files:**
- Create: `tests/dungeon-shell-css.test.ts`
- Modify: `src/web/public/dungeon.css:1-69,105`

**Interfaces:**
- Consumes: the shared `--wall` variable and `.wall`, `.loot-rail`, `.bar`, `main`, `.foot`, and `.sconce` shell elements.
- Produces: `--shell-gap` and `--shell-inline`; all full-frame pages inherit the same safe area without page-specific margins.

- [ ] **Step 1: Create the failing shared-shell CSS test**

Create `tests/dungeon-shell-css.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/dungeon.css', 'utf8');

describe('responsive dungeon shell safe area', () => {
  it('drives header, content, and footer from one wall-aware inline inset', () => {
    expect(css).toMatch(/:root\{[^}]*--shell-gap:12px[^}]*--shell-inline:34px/);
    expect(css).toMatch(/\.bar\{[^}]*padding:22px var\(--shell-inline\)/);
    expect(css).toMatch(/main\{[^}]*padding:8px var\(--shell-inline\) 40px/);
    expect(css).toMatch(/\.foot\{[^}]*padding:20px var\(--shell-inline\) 0/);
  });

  it('hides gutter loot before it can meet the shell and narrows walls on small screens', () => {
    expect(css).toMatch(/@media \(max-width:1252px\)\{[\s\S]*?\.loot-rail\{display:none\}/);
    expect(css).toMatch(/@media \(max-width:1252px\)\{[\s\S]*?--shell-inline:clamp\(/);
    expect(css).toMatch(/@media \(max-width:760px\)\{[\s\S]*?:root\{--wall:48px/);
    expect(css).toMatch(/@media \(max-width:480px\)\{[\s\S]*?:root\{--wall:36px;--shell-gap:8px/);
    expect(css).toMatch(/\.sconce\{[^}]*width:min\(48px,var\(--wall\)\)[^}]*height:min\(48px,var\(--wall\)\)/);
  });
});
```

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
npm test -- tests/dungeon-shell-css.test.ts
```

Expected: FAIL because the shell still hard-codes 34-pixel inline padding, loot survives until 1180 pixels, and wall width never steps down.

- [ ] **Step 3: Add shell variables and use them everywhere**

Extend `:root` with:

```css
--wall:66px;--shell-gap:12px;--shell-inline:34px;
```

Replace the three shell padding declarations with:

```css
.bar{display:flex;align-items:center;justify-content:space-between;max-width:1120px;
  margin:0 auto;padding:22px var(--shell-inline)}
main{max-width:1120px;margin:0 auto;padding:8px var(--shell-inline) 40px}
.foot{max-width:1120px;margin:20px auto 34px;padding:20px var(--shell-inline) 0;
  border-top:1px solid var(--line);display:flex;justify-content:space-between;
  flex-wrap:wrap;gap:10px;font-size:12.5px;color:var(--muted)}
```

- [ ] **Step 4: Make loot and insets respond to the actual wall/shell threshold**

Replace `@media (max-width:1180px){.loot-rail{display:none}}` with:

```css
@media (max-width:1252px){
  :root{--shell-inline:clamp(34px,
    calc(var(--wall) + var(--shell-gap) + 560px - 50vw),
    calc(var(--wall) + var(--shell-gap)))}
  .loot-rail{display:none}
}
```

`1252px` is the 1120-pixel shell plus both 66-pixel walls. `560px` is half the shell width; the clamp smoothly adds only the padding needed to keep panel edges at least `--shell-gap` beyond each wall, then stops growing once the shell fills the viewport.

- [ ] **Step 5: Narrow walls and contain torches at tablet and phone widths**

Change the base sconce dimensions to:

```css
.sconce{position:absolute;left:50%;transform:translateX(-50%);
  width:min(48px,var(--wall));height:min(48px,var(--wall));
  filter:drop-shadow(0 0 24px rgba(255,150,60,.6))}
.sconce img{position:absolute;inset:0;width:100%;height:100%}
```

Add these dedicated shell rules immediately after the 1252-pixel rule:

```css
@media (max-width:760px){
  :root{--wall:48px}
}
@media (max-width:480px){
  :root{--wall:36px;--shell-gap:8px}
}
```

- [ ] **Step 6: Run shell and page CSS tests**

Run:

```bash
npm test -- tests/dungeon-shell-css.test.ts tests/dye-css.test.ts tests/shop-css.test.ts tests/web-shell.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the shared responsive correction**

```bash
git add src/web/public/dungeon.css tests/dungeon-shell-css.test.ts
git commit -m "fix(ui): keep dungeon panels inside the walls"
```

---

### Task 4: Split one-time mastery success from the closed Bazaar

**Files:**
- Modify: `tests/web-shop.test.ts:202-217`
- Modify: `tests/shop-css.test.ts:12-78`
- Modify: `src/web/views/shop.ejs:1,59-74`
- Modify: `src/web/public/dungeon.css:317-323`

**Interfaces:**
- Consumes: `shop.nextOffer`, `shop.mastered`, `shop.currentTier`, `shop.avatarA`, `purchaseResult`, `player.auth_token`, and `mimicUrl` already passed by `registerShopRoutes`.
- Produces: `[data-consume-shop-result]` for Task 5; mutually exclusive `.bazaar-mastered` and `.bazaar-closed` states; the existing `.adventurer-ledger` remains outside both state branches.

- [ ] **Step 1: Replace the old always-mastered test with two failing state tests**

Replace `renders mastery with no purchase card after Tier 3` in `tests/web-shop.test.ts` with:

```ts
it('renders one-time mastery immediately after the final successful purchase', async () => {
  const { db, app, player } = ctx(7_000_000);
  purchase(db, player.id, 'cosmetic_wheel_t1', 1);
  purchase(db, player.id, 'cosmetic_wheel_t2', 2);
  purchase(db, player.id, 'cosmetic_wheel_t3', 3);

  const res = await request(app).get('/shop').query({
    token: player.auth_token,
    result: 'success',
  });

  expect(res.text).toContain('data-consume-shop-result');
  expect(res.text).toContain('Dye Mastery Complete');
  expect(res.text).not.toContain('The Bazaar is Closed');
  expect(res.text).not.toContain('name="sku"');
  expect(res.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
  expect(res.text).toContain('Wardrobe Tier 3');
  expect(res.text).toContain('Mastered');
});

it('shows the closed mimic scene on later mastered visits while retaining the ledger', async () => {
  const { db, app, player } = ctx(7_000_000);
  purchase(db, player.id, 'cosmetic_wheel_t1', 1);
  purchase(db, player.id, 'cosmetic_wheel_t2', 2);
  purchase(db, player.id, 'cosmetic_wheel_t3', 3);

  const res = await request(app).get('/shop').query({ token: player.auth_token });

  expect(res.text).toContain('class="bazaar-closed"');
  expect(res.text).toContain('The Bazaar is Closed');
  expect(res.text).toContain('Definitely not merchandise');
  expect(res.text).not.toContain('Dye Mastery Complete');
  expect(res.text).not.toContain('data-consume-shop-result');
  expect(res.text).not.toContain('action="/shop/cosmetics/purchase"');
  expect(res.text.match(/class="adventurer-ledger"/g)).toHaveLength(1);
  expect(res.text).toContain('Wardrobe Tier 3');
  expect(res.text).toContain('Mastered');
  expect(res.text.match(/Return to Character/g)).toHaveLength(1);
});
```

Append to `tests/shop-css.test.ts`:

```ts
it('layers the closed stall inside the Gilded Mimic marketplace shell', () => {
  expect(marketplace).toMatch(/\.bazaar-open \.bazaar-closed\{[^}]*position:relative[^}]*z-index:1/);
});
```

- [ ] **Step 2: Run focused Shop tests and verify failure**

Run:

```bash
npm test -- tests/web-shop.test.ts tests/shop-css.test.ts
```

Expected: FAIL because every no-offer Tier 3 visit currently renders mastery and no result-consumption hook exists.

- [ ] **Step 3: Mark only the final-success page for result consumption**

Change the first line of `src/web/views/shop.ejs` to:

```ejs
<div class="panel bazaar-open"<%= shop?.mastered && purchaseResult === 'success' ? ' data-consume-shop-result' : '' %>>
```

- [ ] **Step 4: Replace the current no-offer branch with explicit mastery-success and closed branches**

Replace `src/web/views/shop.ejs:59-74` with:

```ejs
  <% } else if (shop.mastered && purchaseResult === 'success') { %>
    <section class="bazaar-floor bazaar-mastered" aria-label="Wardrobe mastery">
      <div class="bazaar-player bazaar-player-mastered">
        <span class="bazaar-player-label"><%= player.name %> · Tier <%= shop.currentTier %></span>
        <img class="px" src="<%= shop.avatarA %>" alt="<%= player.name %> in their completed Wardrobe">
      </div>
      <article class="bazaar-product bazaar-mastery">
        <div class="bazaar-product-meta">
          <span class="bazaar-product-category"><img class="px" src="/static/landing/gem_purple.png" alt="">Permanent wardrobe</span>
          <span class="dye-mastery">Mastered</span>
        </div>
        <h2>Dye Mastery Complete</h2>
        <p>Every applicable cosmetic channel is unlocked. The Gilded Mimic has no more dye-ledger pages to sell you.</p>
      </article>
    </section>
  <% } else { %>
    <section class="bazaar-closed" aria-label="Closed marketplace">
      <div class="bazaar-scene">
        <div class="bazaar-sign">
          <span>THE BAZAAR</span>
          <b>CLOSED</b>
        </div>
        <span class="bazaar-spark bazaar-spark-a" aria-hidden="true">✦</span>
        <span class="bazaar-spark bazaar-spark-b" aria-hidden="true">·</span>
        <img class="px bazaar-mimic" src="<%= mimicUrl %>" width="168" height="168" alt="a suspicious treasure chest mimic guarding the empty stall">
        <span class="bazaar-warning">Definitely not merchandise</span>
      </div>
      <div class="bazaar-copy">
        <p class="dye-kicker">A note nailed to the stall</p>
        <h1>The Bazaar is Closed</h1>
        <p class="bazaar-lead">The merchant has packed up for now. Come back soon — new wares are being dragged up from the dungeon.</p>
        <div class="bazaar-note">
          <span aria-hidden="true">⚠</span>
          <p>Please do not feed, pet, or attempt to purchase the treasure chest. It has already eaten one inventory ledger.</p>
        </div>
        <p class="bazaar-wardrobe">Your completed Dye Wheel still lives in the <b>Wardrobe</b> on your character page.</p>
      </div>
    </section>
  <% } %>
```

Do not add a second Return button; the existing Adventurer Ledger immediately below this branch remains the sole authenticated return action.

- [ ] **Step 5: Integrate the nested closed scene with the marketplace stacking context**

Immediately after `.bazaar-open::before` in `src/web/public/dungeon.css`, add:

```css
.bazaar-open .bazaar-closed{position:relative;z-index:1}
```

- [ ] **Step 6: Run focused Shop tests**

Run:

```bash
npm test -- tests/web-shop.test.ts tests/shop-css.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit completed-Shop rendering**

```bash
git add src/web/views/shop.ejs src/web/public/dungeon.css tests/web-shop.test.ts tests/shop-css.test.ts
git commit -m "feat(shop): close the Bazaar after mastery"
```

---

### Task 5: Consume the one-time success query without breaking purchase motion

**Files:**
- Modify: `tests/shop-client-behavior.test.ts:104-228`
- Modify: `src/web/public/shop.js:1-8`

**Interfaces:**
- Consumes: the Task 4 `[data-consume-shop-result]` marker, browser `location.href`, `URL`, and `history.replaceState`.
- Produces: a cleaned path/query/hash string with only the `result` parameter removed; the existing `form[data-purchase-effect]` enhancement continues unchanged.

- [ ] **Step 1: Extend the browser harness and write the failing cleanup test**

In `tests/shop-client-behavior.test.ts`, add `replacedUrls: string[]` to `ShopHarness`. Change `createShopHarness` to accept:

```ts
function createShopHarness(options: {
  reducedMotion?: boolean;
  enhanced?: boolean;
  consumeResult?: boolean;
  locationHref?: string;
} = {}): ShopHarness {
```

Inside it, add:

```ts
const replacedUrls: string[] = [];
```

Replace the fake document's `querySelector` with:

```ts
querySelector(selector: string): FakeHTMLFormElement | null {
  if (selector === '[data-consume-shop-result]') {
    return options.consumeResult === true ? form : null;
  }
  if (selector !== 'form[data-purchase-effect]' || options.enhanced === false) return null;
  return form;
},
```

Add these values to the VM context:

```ts
URL,
location: {
  href: options.locationHref
    ?? 'https://example.test/shop?token=player-token',
},
history: {
  state: { page: 'shop' },
  replaceState(_state: unknown, _title: string, url: string) {
    replacedUrls.push(url);
  },
},
```

Return `replacedUrls` with the existing harness fields. Add this test before the purchase-celebration cases:

```ts
it('consumes only the one-time result query while preserving token, other query, and hash', () => {
  const harness = createShopHarness({
    enhanced: false,
    consumeResult: true,
    locationHref: 'https://example.test/shop?token=player-token&result=success&from=wardrobe#ledger',
  });

  expect(harness.replacedUrls).toEqual([
    '/shop?token=player-token&from=wardrobe#ledger',
  ]);
});
```

- [ ] **Step 2: Run the client test and verify failure**

Run:

```bash
npm test -- tests/shop-client-behavior.test.ts
```

Expected: FAIL because `shop.js` never inspects the result-consumption marker or calls `replaceState`.

- [ ] **Step 3: Consume the result before the no-form early return**

At the start of `src/web/public/shop.js`, after `const documentRef = root.document;`, add:

```js
  const consumeResult = documentRef?.querySelector('[data-consume-shop-result]');
  if (consumeResult && root.location?.href && root.history?.replaceState && root.URL) {
    const url = new root.URL(root.location.href);
    url.searchParams.delete('result');
    root.history.replaceState(
      root.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
```

Keep this block before:

```js
const form = documentRef?.querySelector('form[data-purchase-effect]');
```

That ordering is required because the mastered success page has no purchase form.

- [ ] **Step 4: Run client, render, and syntax checks**

Run:

```bash
npm test -- tests/shop-client-behavior.test.ts tests/web-shop.test.ts
node --check src/web/public/shop.js
```

Expected: all PASS and `node --check` exits 0. Existing purchase-animation tests must remain unchanged and green.

- [ ] **Step 5: Commit one-time result consumption**

```bash
git add src/web/public/shop.js tests/shop-client-behavior.test.ts
git commit -m "fix(shop): consume the mastery success state once"
```

---

### Task 6: Full verification and visual acceptance

**Files:**
- Verify only; do not change production configuration or data.

**Interfaces:**
- Consumes: all Task 1-5 commits.
- Produces: automated and browser evidence that the approved layout works at desktop, tablet, and phone widths and that final-purchase refresh transitions to the closed Bazaar.

- [ ] **Step 1: Run all automated gates**

Run:

```bash
npm test
npm run typecheck
node --check src/web/public/dye-color.js
node --check src/web/public/dye-draft.js
node --check src/web/public/dye.js
node --check src/web/public/shop-preview.js
node --check src/web/public/shop.js
node --check src/web/public/anim.js
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, every syntax check exits 0, and `git diff --check` prints nothing.

- [ ] **Step 2: Create an isolated local visual-review database**

Run in one shell:

```bash
export WARDROBE_DEMO_DIR="$(mktemp -d /private/tmp/clauderpg-wardrobe.XXXXXX)"
export WARDROBE_DEMO_DB="$WARDROBE_DEMO_DIR/demo.db"
./node_modules/.bin/tsx -e '
import { openDb } from "./src/db/db";
import { createPlayer } from "./src/domain/players";
import { seedSettings } from "./src/domain/settings";
import { purchase } from "./src/domain/shop";
const db = openDb(process.env.WARDROBE_DEMO_DB);
seedSettings(db);
const ready = createPlayer(db, { name: "Tier Two Wizard", class_key: "wizard", gender: "M" }, 1);
db.prepare("UPDATE players SET gold = 7000000 WHERE id = ?").run(ready.id);
purchase(db, ready.id, "cosmetic_wheel_t1", 2);
purchase(db, ready.id, "cosmetic_wheel_t2", 3);
const mastered = createPlayer(db, { name: "Dye Master Priest", class_key: "priest", gender: "F" }, 4);
db.prepare("UPDATE players SET gold = 7000000 WHERE id = ?").run(mastered.id);
purchase(db, mastered.id, "cosmetic_wheel_t1", 5);
purchase(db, mastered.id, "cosmetic_wheel_t2", 6);
purchase(db, mastered.id, "cosmetic_wheel_t3", 7);
console.log(`READY_CHARACTER=http://localhost:8114/character?token=${ready.auth_token}`);
console.log(`READY_SHOP=http://localhost:8114/shop?token=${ready.auth_token}`);
console.log(`MASTERED_SHOP=http://localhost:8114/shop?token=${mastered.auth_token}`);
db.close();
'
```

Expected: three local URLs print. This database lives only under the newly created `/private/tmp/clauderpg-wardrobe.*` directory.

- [ ] **Step 3: Start the isolated server**

In the same shell so `WARDROBE_DEMO_DB` remains defined, run:

```bash
PORT=8114 DB_PATH="$WARDROBE_DEMO_DB" npm run dev
```

Expected: the server reports `listening on http://localhost:8114`.

- [ ] **Step 4: Verify the Character page at three widths**

Open the printed `READY_CHARACTER` URL and inspect at 1280, 760, and 390 CSS pixels:

- Store remains in the authenticated profile card and retains the token.
- No panel overlaps a moss wall; floating loot is absent before the shell becomes narrow.
- Saved sits at the top-right of the live-fitting stage.
- Tone precedes Forged Steel, Aged Bronze, Royal Gold, and Restore Default.
- The joined normal strip below Restore Default contains Discard and Save with no empty third column.
- Draft a hue and Tone change: status becomes Unsaved changes, Discard restores the saved state without a request, and Save writes the full draft once.
- Keyboard focus remains visible on Store, channel buttons, wheel, Tone, finishes, Discard, and Save.

- [ ] **Step 5: Verify final purchase and refresh behavior**

Open the printed `READY_SHOP` URL:

1. Confirm the Tier 3 offer and Adventurer Ledger fit inside the walls.
2. Buy Tier 3 and confirm the purchase motion ends on `Dye Mastery Complete`.
3. Confirm the address retains the token but no longer contains `result=success`.
4. Refresh and confirm the CLOSED sign, mimic warning, merchant note, and `Wardrobe Tier 3 — Mastered` ledger appear.
5. Confirm there is exactly one Return to Character button and no purchase card.

Open the printed `MASTERED_SHOP` URL directly and confirm it enters the closed state immediately.

- [ ] **Step 6: Confirm branch state**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: no uncommitted implementation files remain; the design/spec correction and five implementation commits are visible. Stop the local dev server with Ctrl-C. Do not push or deploy.

---

## Acceptance checklist

- [ ] Store is a gold, token-preserving action inside the authenticated profile card.
- [ ] Saved status occupies the fitting-stage upper-right corner without moving the sprite.
- [ ] Tone and all four finish/default rows precede the joined draft-action strip.
- [ ] Reload is hidden normally and visible only for stale recovery.
- [ ] Discard and Restore Default retain distinct, tested scopes.
- [ ] Shared content insets keep every purple panel inside stepped moss walls.
- [ ] Tier 3 success shows mastery once; refresh and later visits show the closed Bazaar.
- [ ] Tier 3 mastery persists in the Adventurer Ledger, which owns the sole Return button.
- [ ] Full tests, typecheck, syntax checks, diff check, and three-width browser review pass.

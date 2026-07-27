# Wardrobe Stage and Navigation Toast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the live-fitting center guide, compact and align its status header, and add a thematic action toast that safely saves or discards a pending Wardrobe draft before Store navigation.

**Architecture:** Keep the existing server-rendered Character page and its single `dye.js` draft controller. Add semantic stage-header and toast markup to the EJS view, style both in the shared dungeon stylesheet, and extend the existing save controller so every caller receives an explicit result while sharing one in-flight promise. Guard only the two known Wardrobe links; retain `beforeunload` as the fallback for all other navigation.

**Tech Stack:** EJS, browser JavaScript, CSS, Vitest, Supertest, Node `vm` client harness, TypeScript typecheck.

## Global Constraints

- Work on the existing `feat/player-shop-cosmetics` branch; do not create a new worktree or branch.
- Preserve class, gender, slot-map, tier entitlement, and price behavior exactly.
- Preserve the current atomic multi-channel request to `POST /character/dye/save`.
- Preserve revision, retry, stale-conflict, and `beforeunload` guarantees.
- A clean draft must navigate normally without showing the toast.
- Never navigate after a failed, stale, rejected, forbidden, or expired save.
- Never offer destructive leave while an ambiguous save attempt may already have reached the server.
- Keep the toast inside `--wall` plus `--shell-gap` at every responsive width.
- Respect the existing global `prefers-reduced-motion` rule.
- Do not deploy, push, restart the Pi, or mutate production data.

---

## File Structure

- `src/web/views/character-sheet.ejs` — stage header, guarded-link markers, and accessible action-toast markup.
- `src/web/public/dungeon.css` — compact stage header, center-guide removal, safe-area toast presentation, and responsive toast actions.
- `src/web/public/dye.js` — one shared save promise, explicit save outcomes, guarded navigation, toast state, focus restoration, and Escape handling.
- `tests/web-dye.test.ts` — server-rendered markup and copy contract.
- `tests/dye-css.test.ts` — stage and toast style contract.
- `tests/dye-client-behavior.test.ts` — clean/dirty navigation, save/discard actions, in-flight edits, retries, conflicts, focus, and Escape behavior.

---

### Task 1: Align the live-fitting header and remove the center guide

**Files:**
- Modify: `src/web/views/character-sheet.ejs:70-75`
- Modify: `src/web/public/dungeon.css:163-198,298-302`
- Test: `tests/web-dye.test.ts:511-534`
- Test: `tests/dye-css.test.ts:19-31,52-70`

**Interfaces:**
- Consumes: existing `#dye-save-status`, `.dye-stage-label`, and `.dye-stage` elements.
- Produces: `.dye-stage-head`, an absolute flex header containing the unchanged status live region and label.

- [ ] **Step 1: Write failing render and CSS tests**

Update the fitting-stage assertions in `tests/web-dye.test.ts`:

```ts
const stage = res.text.match(/<div class="dye-stage">([\s\S]*?)<canvas id="dye-preview"/)?.[1] ?? '';

expect(stage).toContain('<div class="dye-stage-head">');
expect(stage).toContain('<span class="dye-stage-label">Live fitting</span>');
expect(stage).toContain('id="dye-save-status"');
expect(stage).toContain('role="status" aria-live="polite"');
expect(stage.indexOf('dye-stage-label')).toBeLessThan(stage.indexOf('dye-save-status'));
```

Replace the old absolute-status expectations in `tests/dye-css.test.ts` and extend the stage-background test:

```ts
it('aligns a compact stage header and removes the center guide', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const header = css.match(/\.dye-stage-head\{([^}]*)\}/)?.[1] ?? '';
  const status = css.match(/\.dye-save-status\{([^}]*)\}/)?.[1] ?? '';
  const stage = css.match(/\.dye-stage\{([^}]*)\}/)?.[1] ?? '';

  expect(header).toContain('position:absolute');
  expect(header).toContain('display:flex');
  expect(header).toContain('align-items:center');
  expect(header).toContain('left:12px');
  expect(header).toContain('right:10px');
  expect(status).toContain('position:static');
  expect(status).toContain('padding:4px 7px');
  expect(status).toContain('font-size:9px');
  expect(css).toMatch(/\.dye-save-status::before\{[^}]*width:5px[^}]*height:5px/);
  expect(stage).toContain('background:linear-gradient(180deg,#21142f,#120c1b 72%)');
  expect(stage).not.toContain('linear-gradient(90deg');
});
```

- [ ] **Step 2: Run the focused tests and verify the expected failures**

Run:

```bash
npm test -- tests/web-dye.test.ts tests/dye-css.test.ts
```

Expected: FAIL because `.dye-stage-head` does not exist, the status is still absolutely positioned with `6px 10px` padding, and the 90-degree center guide remains.

- [ ] **Step 3: Implement the semantic stage header and compact styles**

Wrap the label and status in `src/web/views/character-sheet.ejs`:

```ejs
<div class="dye-stage">
  <div class="dye-stage-head">
    <span class="dye-stage-label">Live fitting</span>
    <span id="dye-save-status" class="dye-save-status" data-state="saved" role="status" aria-live="polite">Saved</span>
  </div>
  <canvas id="dye-preview" width="168" height="168" class="px dye-preview" aria-label="Live character dye preview"></canvas>
</div>
```

Replace the current status, stage background, and label rules in `src/web/public/dungeon.css`:

```css
.dye-stage-head{position:absolute;z-index:3;left:12px;right:10px;top:10px;
  display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.dye-stage-label{position:static;flex:0 0 auto;color:var(--muted);
  font:800 10px/1 ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase}
.dye-save-status{position:static;display:inline-flex;min-width:0;max-width:100%;align-items:center;
  justify-content:flex-end;gap:5px;margin:0;padding:4px 7px;border:1px solid var(--line);
  border-radius:999px;background:#0c0912dd;color:var(--muted);font-size:9px;line-height:1.25;
  font-weight:800;letter-spacing:.03em;text-align:right;text-transform:uppercase;overflow-wrap:anywhere}
.dye-save-status::before{content:"";width:5px;height:5px;flex:0 0 5px;border-radius:1px;background:var(--muted)}
```

Make `.dye-stage` use only:

```css
background:linear-gradient(180deg,#21142f,#120c1b 72%)
```

Delete the obsolete `@media (max-width:620px)` status padding override; the compact base rule now applies at every width. Keep every status-state color and animation rule unchanged.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- tests/web-dye.test.ts tests/dye-css.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the stage cleanup**

```bash
git add src/web/views/character-sheet.ejs src/web/public/dungeon.css tests/web-dye.test.ts tests/dye-css.test.ts
git commit -m "fix(wardrobe): align the live fitting status"
```

---

### Task 2: Render and style the thematic navigation toast

**Files:**
- Modify: `src/web/views/character-sheet.ejs:11-13,44-45,113-129`
- Modify: `src/web/public/dungeon.css:269-302`
- Test: `tests/web-dye.test.ts:484-534`
- Test: `tests/dye-css.test.ts:52-70`

**Interfaces:**
- Consumes: token-preserving Store and Unlock links, `--wall`, `--shell-gap`, `.btn-gold`, and `.btn-ghost`.
- Produces: `[data-dye-guarded-nav]`, `#dye-nav-toast`, `#dye-nav-title`, `#dye-nav-message`, `#dye-nav-save`, `#dye-nav-save-label`, `#dye-nav-leave`, and `#dye-nav-close` for Task 3.

- [ ] **Step 1: Write failing markup tests**

Add these assertions to the Tier-1 Wardrobe render test in `tests/web-dye.test.ts`:

```ts
expect(res.text).toContain('class="btn btn-gold character-store"');
expect(res.text).toContain('data-dye-guarded-nav>');
expect(res.text).toContain('id="dye-nav-toast" class="dye-nav-toast" hidden role="alert"');
expect(res.text).toContain('id="dye-nav-title">The tailor catches your sleeve!</h3>');
expect(res.text).toContain('You still have unfinished dye work on the fitting table.');
expect(res.text).toContain('id="dye-nav-save"');
expect(res.text).toContain('id="dye-nav-save-label">Save &amp; Continue</span>');
expect(res.text).toContain('id="dye-nav-leave"');
expect(res.text).toContain('Leave Without Saving');
expect(res.text).toContain('id="dye-nav-close"');
```

In the same test, count two guarded links for a player with a next-tier offer:

```ts
expect(res.text.match(/data-dye-guarded-nav/g)).toHaveLength(2);
```

Add CSS assertions in `tests/dye-css.test.ts`:

```ts
it('keeps the Wardrobe action toast inside the moss walls', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const toast = css.match(/\.dye-nav-toast\{([^}]*)\}/)?.[1] ?? '';

  expect(css).toContain('.dye-nav-toast[hidden]{display:none!important}');
  expect(toast).toContain('position:fixed');
  expect(toast).toContain('left:calc(var(--wall) + var(--shell-gap))');
  expect(toast).toContain('right:calc(var(--wall) + var(--shell-gap))');
  expect(toast).toContain('max-width:460px');
  expect(toast).toContain('z-index:20');
  expect(css).toMatch(/\.dye-nav-actions\{[^}]*display:flex/);
  expect(css).toMatch(/@media \(max-width:620px\)\{[\s\S]*?\.dye-nav-actions\{[^}]*flex-direction:column/);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm test -- tests/web-dye.test.ts tests/dye-css.test.ts
```

Expected: FAIL because the guarded markers, toast markup, and toast styles do not exist.

- [ ] **Step 3: Add guarded-link markers and accessible toast markup**

Add `data-dye-guarded-nav` to both token-preserving links:

```ejs
<a class="btn btn-gold character-store" href="/shop?token=<%= encodeURIComponent(player.auth_token) %>" data-dye-guarded-nav>
```

```ejs
<a class="btn btn-gold" href="/shop?token=<%= encodeURIComponent(player.auth_token) %>" data-dye-guarded-nav>Unlock the next tier</a>
```

Inside the `dye.channels.length > 0` branch, after `.dye-workbench` and before `dyeClient`, add:

```ejs
<aside id="dye-nav-toast" class="dye-nav-toast" hidden role="alert"
  aria-labelledby="dye-nav-title" aria-describedby="dye-nav-message">
  <button id="dye-nav-close" type="button" class="dye-nav-close" aria-label="Keep editing and close this notice">×</button>
  <span class="dye-nav-kicker">Unfinished fitting</span>
  <h3 id="dye-nav-title">The tailor catches your sleeve!</h3>
  <p id="dye-nav-message">You still have unfinished dye work on the fitting table. Save it before heading out, or leave it behind.</p>
  <div class="dye-nav-actions">
    <button id="dye-nav-save" type="button" class="btn btn-gold">
      <span aria-hidden="true">✦</span><span id="dye-nav-save-label">Save &amp; Continue</span>
    </button>
    <button id="dye-nav-leave" type="button" class="btn btn-ghost">Leave Without Saving</button>
  </div>
</aside>
```

- [ ] **Step 4: Add the safe-area toast presentation**

Add to the Wardrobe section of `src/web/public/dungeon.css`:

```css
.dye-nav-toast[hidden]{display:none!important}
.dye-nav-toast{position:fixed;z-index:20;left:calc(var(--wall) + var(--shell-gap));
  right:calc(var(--wall) + var(--shell-gap));bottom:24px;max-width:460px;margin-inline:auto;
  padding:16px 46px 16px 16px;border:1px solid var(--gold-dim);border-radius:11px;
  background:linear-gradient(180deg,#2b1c38,#160f20);box-shadow:0 24px 60px #000c,inset 0 1px #fff2;
  animation:dye-toast-in .16s steps(2,end)}
.dye-nav-kicker{display:block;margin-bottom:3px;color:var(--gold);font:850 9px/1 ui-monospace,monospace;
  letter-spacing:.15em;text-transform:uppercase}
.dye-nav-toast h3{margin:0 0 4px;font-size:16px}.dye-nav-toast p{margin:0;color:var(--ink);font-size:12px}
.dye-nav-close{position:absolute;right:9px;top:9px;width:28px;height:28px;margin:0;padding:0;
  justify-content:center;border:1px solid var(--line);border-radius:6px;background:#ffffff08;
  color:var(--muted);box-shadow:none;font-size:17px}
.dye-nav-actions{display:flex;gap:7px;margin-top:12px}.dye-nav-actions .btn{min-height:38px;padding:8px 12px;font-size:11px}
.dye-nav-actions button:hover,.dye-nav-close:hover{transform:none}
.dye-nav-actions button:focus-visible,.dye-nav-close:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
@keyframes dye-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
```

Inside the existing `@media (max-width:620px)` block, add:

```css
.dye-nav-toast{bottom:12px;padding:14px 40px 14px 14px}
.dye-nav-actions{flex-direction:column}.dye-nav-actions .btn{width:100%;justify-content:center}
```

The existing global reduced-motion rule already sets `animation:none!important`; do not add a duplicate media query.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm test -- tests/web-dye.test.ts tests/dye-css.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the toast shell**

```bash
git add src/web/views/character-sheet.ejs src/web/public/dungeon.css tests/web-dye.test.ts tests/dye-css.test.ts
git commit -m "feat(wardrobe): add the navigation action toast"
```

---

### Task 3: Guard dirty links with Close, Escape, and safe discard

**Files:**
- Modify: `src/web/public/dye.js:11-26,228-369,485-492`
- Modify: `tests/dye-client-behavior.test.ts:14-368,740-747`

**Interfaces:**
- Consumes: Task 2's guarded links and toast element IDs; existing `operations()`, `discardDraft()`, `pendingAttempt`, `saving`, and `refreshRequired` state.
- Produces: `hasPendingChanges()`, `showDirtyNavigationToast(link)`, `closeNavigationToast(restoreFocus)`, and `navigatePending()` inside the `dye.js` closure.

- [ ] **Step 1: Extend the browser harness for links, toast state, focus, and navigation**

Add `focusCount` and `focus()` to `FakeElement`:

```ts
focusCount = 0;

focus(): void {
  this.focusCount += 1;
}
```

Create `storeLink`, `unlockLink`, and all toast elements in `createWardrobeHarness`; set each link's `href` and return the guarded links from `querySelectorAll`:

```ts
const storeLink = new FakeElement();
storeLink.setAttribute('href', '/shop?token=test-token');
const unlockLink = new FakeElement();
unlockLink.setAttribute('href', '/shop?token=test-token&tier=next');
const navToast = new FakeElement();
navToast.hidden = true;
const navTitle = new FakeElement();
const navMessage = new FakeElement();
const navSaveButton = new FakeButton();
const navSaveLabel = new FakeElement();
const navLeaveButton = new FakeButton();
const navCloseButton = new FakeButton();
```

Map the toast IDs in `elements`, return `[storeLink, unlockLink]` for `[data-dye-guarded-nav]`, add `location.assign`, and expose test helpers:

```ts
const navigations: string[] = [];

location: {
  assign(destination: string) { navigations.push(destination); },
  reload() { reloads += 1; },
},
```

```ts
clickGuarded(link: FakeElement) {
  let prevented = false;
  link.dispatch('click', { preventDefault() { prevented = true; } });
  return prevented;
},
keydown(key: string) {
  for (const listener of windowListeners.get('keydown') ?? []) listener({ key });
},
navigations,
```

Update `WardrobeHarness` with the exact new fields and helper signatures.

- [ ] **Step 2: Write failing clean, dirty, Close, Escape, and discard tests**

Append to `tests/dye-client-behavior.test.ts`:

```ts
it('lets guarded links navigate normally when the draft is clean', () => {
  const harness = createWardrobeHarness();

  expect(harness.clickGuarded(harness.storeLink)).toBe(false);
  expect(harness.navToast.hidden).toBe(true);
  expect(harness.navigations).toEqual([]);
});

it('blocks a guarded link with a dirty draft and opens one thematic toast', () => {
  const harness = createWardrobeHarness();
  pressWheel(harness, 'ArrowRight');

  expect(harness.clickGuarded(harness.storeLink)).toBe(true);
  expect(harness.navToast.hidden).toBe(false);
  expect(harness.navTitle.textContent).toBe('The tailor catches your sleeve!');
  expect(harness.navMessage.textContent).toContain('unfinished dye work');
  expect(harness.navSaveLabel.textContent).toBe('Save & Continue');
  expect(harness.navSaveButton.focusCount).toBe(1);
  expect(harness.navigations).toEqual([]);

  expect(harness.clickGuarded(harness.unlockLink)).toBe(true);
  expect(harness.navToast.hidden).toBe(false);
  harness.navLeaveButton.dispatch('click');
  expect(harness.navigations).toEqual(['/shop?token=test-token&tier=next']);
});

it('closes the navigation toast without changing or navigating the draft', () => {
  const harness = createWardrobeHarness();
  pressWheel(harness, 'ArrowRight');
  harness.clickGuarded(harness.storeLink);

  harness.navCloseButton.dispatch('click');
  expect(harness.navToast.hidden).toBe(true);
  expect(harness.storeLink.focusCount).toBe(1);
  expect(harness.status.textContent).toBe('Unsaved changes');
  expect(harness.navigations).toEqual([]);

  harness.clickGuarded(harness.unlockLink);
  harness.keydown('Escape');
  expect(harness.navToast.hidden).toBe(true);
  expect(harness.unlockLink.focusCount).toBe(1);
});

it('leaves without saving only from an ordinary draft', () => {
  const harness = createWardrobeHarness({
    1: { op: 'colorize', hue: 20, sat: 0.6, tone: 0 },
  });
  pressWheel(harness, 'ArrowRight');
  harness.clickGuarded(harness.unlockLink);

  harness.navLeaveButton.dispatch('click');

  expect(harness.requests).toHaveLength(0);
  expect(harness.wheel.getAttribute('aria-valuenow')).toBe('20');
  expect(harness.navigations).toEqual(['/shop?token=test-token&tier=next']);
  expect(harness.navToast.hidden).toBe(true);
});
```

- [ ] **Step 3: Run the client test and verify failure**

Run:

```bash
npm test -- tests/dye-client-behavior.test.ts
```

Expected: FAIL because `dye.js` does not read the toast, intercept guarded links, restore focus, handle Escape, or assign captured destinations.

- [ ] **Step 4: Implement ordinary guarded navigation**

Read all Task 2 elements at the top of `dye.js`, include them in the initialization guard, and collect the links:

```js
const navToast = document.getElementById('dye-nav-toast');
const navTitle = document.getElementById('dye-nav-title');
const navMessage = document.getElementById('dye-nav-message');
const navSaveButton = document.getElementById('dye-nav-save');
const navSaveLabel = document.getElementById('dye-nav-save-label');
const navLeaveButton = document.getElementById('dye-nav-leave');
const navCloseButton = document.getElementById('dye-nav-close');
const guardedLinks = Array.from(document.querySelectorAll('[data-dye-guarded-nav]'));
```

Add state and ordinary-draft helpers after `operations()`:

```js
let pendingDestination = null;
let pendingNavigationTrigger = null;

function hasPendingChanges() {
  return operations().length > 0 || pendingAttempt !== null || saving;
}

function showDirtyNavigationToast(link) {
  pendingDestination = link.getAttribute('href');
  pendingNavigationTrigger = link;
  navTitle.textContent = 'The tailor catches your sleeve!';
  navMessage.textContent = 'You still have unfinished dye work on the fitting table. Save it before heading out, or leave it behind.';
  navSaveLabel.textContent = 'Save & Continue';
  navSaveButton.hidden = false;
  navSaveButton.disabled = false;
  navLeaveButton.hidden = false;
  navToast.hidden = false;
  navSaveButton.focus();
}

function closeNavigationToast(restoreFocus) {
  const trigger = pendingNavigationTrigger;
  navToast.hidden = true;
  pendingDestination = null;
  pendingNavigationTrigger = null;
  if (restoreFocus && trigger) trigger.focus();
}

function navigatePending() {
  const destination = pendingDestination;
  closeNavigationToast(false);
  if (destination) location.assign(destination);
}

function leaveWithoutSaving() {
  if (saving || pendingAttempt !== null || refreshRequired) return;
  discardDraft();
  navigatePending();
}
```

Bind the links and ordinary actions near the existing button listeners:

```js
for (const link of guardedLinks) {
  link.addEventListener('click', function (event) {
    if (!hasPendingChanges()) return;
    event.preventDefault();
    showDirtyNavigationToast(link);
  });
}
navLeaveButton.addEventListener('click', leaveWithoutSaving);
navCloseButton.addEventListener('click', function () { closeNavigationToast(true); });
window.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && !navToast.hidden) closeNavigationToast(true);
});
```

Do not bind Save & Continue yet; Task 4 adds it with explicit save outcomes.

- [ ] **Step 5: Run the client test**

Run:

```bash
npm test -- tests/dye-client-behavior.test.ts
```

Expected: PASS for the new ordinary-navigation tests and every existing draft/retry test.

- [ ] **Step 6: Commit ordinary guarded navigation**

```bash
git add src/web/public/dye.js tests/dye-client-behavior.test.ts
git commit -m "feat(wardrobe): guard dirty shop navigation"
```

---

### Task 4: Share save outcomes with Save & Continue

**Files:**
- Modify: `src/web/public/dye.js:235-350,485-492`
- Modify: `tests/dye-client-behavior.test.ts:390-772`

**Interfaces:**
- Consumes: Task 3's pending destination, toast elements, and navigation helpers; existing retry-safe `pendingAttempt` payload.
- Produces: `saveDraft(): Promise<'clean'|'saved'|'dirty'|'retryable-error'|'refresh-required'>`, one shared `savePromise`, `saveAndContinue()`, and `handleNavigationSaveResult(result)`.

- [ ] **Step 1: Write failing Save & Continue outcome tests**

Append these tests to `tests/dye-client-behavior.test.ts`:

```ts
it('saves one atomic draft and continues only after acknowledgement', async () => {
  const harness = createWardrobeHarness();
  const pending = deferred<ResponseLike>();
  harness.responses.push(pending);
  pressWheel(harness, 'ArrowRight');
  harness.cloak.dispatch('click');
  harness.steelButton.dispatch('click');
  harness.clickGuarded(harness.storeLink);

  harness.navSaveButton.dispatch('click');
  expect(harness.requests).toHaveLength(1);
  expect(changes(harness.requests[0])).toEqual([
    { action: 'set', slot: 1, recipe: 'wheel', hue: 6, tone: 0 },
    { action: 'set', slot: 2, recipe: 'steel', tone: 0 },
  ]);
  expect(harness.navigations).toEqual([]);

  pending.resolve(response({
    1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 },
    2: { op: 'colorize', hue: 212, sat: 0.13, tone: 0 },
  }));
  await harness.settle();
  expect(harness.navigations).toEqual(['/shop?token=test-token']);
});

it('waits on an existing save instead of issuing a second request', async () => {
  const harness = createWardrobeHarness();
  const pending = deferred<ResponseLike>();
  harness.responses.push(pending);
  pressWheel(harness, 'ArrowRight');
  harness.saveButton.dispatch('click');

  expect(harness.clickGuarded(harness.storeLink)).toBe(true);
  expect(harness.requests).toHaveLength(1);
  expect(harness.navMessage.textContent).toContain('finishing your dye work');

  pending.resolve(response({ 1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 } }));
  await harness.settle();
  expect(harness.requests).toHaveLength(1);
  expect(harness.navigations).toEqual(['/shop?token=test-token']);
});

it('stays on the fitting when newer edits appear during Save & Continue', async () => {
  const harness = createWardrobeHarness();
  const pending = deferred<ResponseLike>();
  harness.responses.push(pending);
  pressWheel(harness, 'ArrowRight');
  harness.clickGuarded(harness.storeLink);
  harness.navSaveButton.dispatch('click');
  pressWheel(harness, 'ArrowRight');

  pending.resolve(response({ 1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 } }));
  await harness.settle();

  expect(harness.navigations).toEqual([]);
  expect(harness.navToast.hidden).toBe(false);
  expect(harness.navMessage.textContent).toContain('another loose thread');
  expect(harness.navLeaveButton.hidden).toBe(false);
  expect(harness.status.textContent).toBe('Unsaved changes');
});

it('offers retry without destructive leave after an ambiguous save', async () => {
  const harness = createWardrobeHarness();
  const failed = deferred<ResponseLike>();
  const retry = deferred<ResponseLike>();
  harness.responses.push(failed, retry);
  pressWheel(harness, 'ArrowRight');
  harness.clickGuarded(harness.unlockLink);
  harness.navSaveButton.dispatch('click');
  failed.reject(new Error('offline'));
  await harness.settle();

  expect(harness.navigations).toEqual([]);
  expect(harness.navSaveLabel.textContent).toBe('Retry Save');
  expect(harness.navLeaveButton.hidden).toBe(true);

  harness.navSaveButton.dispatch('click');
  expect(harness.requests).toHaveLength(2);
  expect(harness.requests[1].body.get('revision')).toBe('1000');
  expect(changes(harness.requests[1])).toEqual(changes(harness.requests[0]));
  retry.resolve(response({ 1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 } }));
  await harness.settle();
  expect(harness.navigations).toEqual(['/shop?token=test-token&tier=next']);
});

it('never continues through a stale save conflict', async () => {
  const harness = createWardrobeHarness();
  const stale = deferred<ResponseLike>();
  harness.responses.push(stale);
  pressWheel(harness, 'ArrowRight');
  harness.clickGuarded(harness.storeLink);
  harness.navSaveButton.dispatch('click');
  stale.resolve(failedResponse(409));
  await harness.settle();

  expect(harness.navigations).toEqual([]);
  expect(harness.reloadButton.hidden).toBe(false);
  expect(harness.navSaveButton.hidden).toBe(true);
  expect(harness.navLeaveButton.hidden).toBe(true);
  expect(harness.navMessage.textContent).toContain('ledger must be reloaded');
  expect(harness.beforeunload()).toEqual({ prevented: true, returnValue: '' });
});
```

- [ ] **Step 2: Run the client test and verify failure**

Run:

```bash
npm test -- tests/dye-client-behavior.test.ts
```

Expected: FAIL because Save & Continue has no handler, `saveDraft` does not return an outcome, and an already-running save is not exposed to the navigation guard.

- [ ] **Step 3: Refactor the existing save into one shared promise with explicit outcomes**

Add:

```js
let savePromise = null;
```

Replace the current `saveDraft()` definition with the complete shared-promise implementation below. It preserves the existing request construction, canonical rebasing, and retry payload exactly while adding explicit outcomes:

```js
async function performSave() {
  if (refreshRequired) return 'refresh-required';
  if (!pendingAttempt) {
    const changes = operations();
    if (changes.length === 0) return 'clean';
    pendingAttempt = {
      changes,
      revision: nextRevision,
      submittedStates: Draft.cloneStates(states),
    };
  }
  const attempt = pendingAttempt;
  saving = true;
  saveError = false;
  renderSaveState('Saving');
  let message = 'Save failed';
  let result = 'retryable-error';
  try {
    const body = new URLSearchParams({
      token: D.token,
      session: String(revisionSession),
      revision: String(attempt.revision),
      changes: JSON.stringify(attempt.changes),
    });
    const response = await fetch('/character/dye/save', {
      method: 'POST', body, credentials: 'same-origin',
    });
    if (response.status === 409) {
      refreshRequired = true;
      refreshMessage = 'Wardrobe changed elsewhere — refresh required';
      reloadButton.hidden = false;
      message = refreshMessage;
      result = 'refresh-required';
      return result;
    }
    if (response.status === 400 || response.status === 403 || response.status === 404) {
      pendingAttempt = null;
      refreshRequired = true;
      refreshMessage = response.status === 400
        ? 'Wardrobe save was rejected — refresh required'
        : response.status === 403
          ? 'Wardrobe access changed — refresh required'
          : 'Character session expired — reload required';
      reloadButton.hidden = false;
      message = refreshMessage;
      result = 'refresh-required';
      return result;
    }
    if (!response.ok) throw new Error(`Save failed (${response.status})`);

    const canonical = await response.json();
    const canonicalConfig = new Map(
      Object.entries(canonical.config).map(([slot, rule]) => [Number(slot), rule]),
    );
    const canonicalStates = new Map();
    for (const [slot, rule] of canonicalConfig) {
      canonicalStates.set(slot, stateFromRule(rule));
    }
    const rebasedConfig = cloneConfig(canonicalConfig);
    const rebasedStates = Draft.cloneStates(canonicalStates);
    const touchedWhileSaving = new Set([...attempt.submittedStates.keys(), ...states.keys()]);
    for (const slot of touchedWhileSaving) {
      const currentState = states.get(slot);
      if (Draft.equalState(attempt.submittedStates.get(slot), currentState)) continue;
      if (!currentState) {
        rebasedConfig.delete(slot);
        rebasedStates.delete(slot);
        continue;
      }
      const currentRule = config.get(slot);
      rebasedConfig.set(slot, currentRule ? { ...currentRule } : ruleFromState(currentState));
      rebasedStates.set(slot, { ...currentState });
    }
    savedConfig = cloneConfig(canonicalConfig);
    savedStates = Draft.cloneStates(canonicalStates);
    config = rebasedConfig;
    states = rebasedStates;
    pendingAttempt = null;
    nextRevision = Math.max(nextRevision, attempt.revision + 1);
    renderPreview();
    renderControls();
    result = operations().length > 0 ? 'dirty' : 'saved';
    message = result === 'dirty' ? 'Unsaved changes' : 'Saved';
  } catch (_error) {
    saveError = true;
    result = 'retryable-error';
  } finally {
    saving = false;
    renderSaveState(message);
  }
  return result;
}

function saveDraft() {
  if (savePromise) return savePromise;
  savePromise = performSave().finally(function () { savePromise = null; });
  return savePromise;
}
```

A clean call returns `'clean'` without allocating a request. Existing click listeners may ignore the returned promise.

- [ ] **Step 4: Connect the toast state machine to the shared save**

Add these focused view-state helpers:

```js
function showWaitingNavigationToast() {
  navTitle.textContent = 'The tailor is tying the last knot!';
  navMessage.textContent = 'The tailor is finishing your dye work before opening the next door.';
  navSaveButton.hidden = false;
  navSaveButton.disabled = true;
  navLeaveButton.hidden = true;
  navToast.hidden = false;
}

function showRetryNavigationToast() {
  navTitle.textContent = 'The ledger ink is still wet!';
  navMessage.textContent = 'The fitting could not be confirmed. Retry the same save before leaving.';
  navSaveLabel.textContent = 'Retry Save';
  navSaveButton.hidden = false;
  navSaveButton.disabled = false;
  navLeaveButton.hidden = true;
  navToast.hidden = false;
  navSaveButton.focus();
}

function showRefreshNavigationToast() {
  navTitle.textContent = 'The ledger has changed!';
  navMessage.textContent = 'The tailor’s ledger must be reloaded before this fitting can leave the workbench.';
  navSaveButton.hidden = true;
  navLeaveButton.hidden = true;
  navToast.hidden = false;
}
```

Track one navigation waiter and interpret save results:

```js
let navigationSaveWait = null;

function handleNavigationSaveResult(result) {
  if (!pendingDestination) return;
  if (result === 'saved' || result === 'clean') {
    navigatePending();
    return;
  }
  if (result === 'dirty') {
    navTitle.textContent = 'The tailor found another loose thread!';
    navMessage.textContent = 'New dye work appeared while the ledger was saving. Save again before heading out, or leave it behind.';
    navSaveLabel.textContent = 'Save & Continue';
    navSaveButton.hidden = false;
    navSaveButton.disabled = false;
    navLeaveButton.hidden = false;
    navToast.hidden = false;
    navSaveButton.focus();
    return;
  }
  if (result === 'retryable-error') {
    showRetryNavigationToast();
    return;
  }
  showRefreshNavigationToast();
}

function saveAndContinue() {
  if (!pendingDestination || navigationSaveWait) return;
  showWaitingNavigationToast();
  navigationSaveWait = saveDraft()
    .then(handleNavigationSaveResult)
    .finally(function () { navigationSaveWait = null; });
}
```

Bind `navSaveButton` to `saveAndContinue`. In each guarded-link listener, update the pending destination and trigger first; if `saving` or `savePromise` is active, call `saveAndContinue()` immediately. If `saveError && pendingAttempt !== null`, show the retry state. Otherwise show the ordinary dirty state.

Replace Task 3's guarded-link listener with this exact final form:

```js
for (const link of guardedLinks) {
  link.addEventListener('click', function (event) {
    if (!hasPendingChanges()) return;
    event.preventDefault();
    pendingDestination = link.getAttribute('href');
    pendingNavigationTrigger = link;
    if (saving || savePromise) {
      showWaitingNavigationToast();
      saveAndContinue();
      return;
    }
    if (saveError && pendingAttempt !== null) {
      showRetryNavigationToast();
      return;
    }
    showDirtyNavigationToast(link);
  });
}
navSaveButton.addEventListener('click', saveAndContinue);
```

The `pendingDestination` guard at the start of `handleNavigationSaveResult`
ensures that closing the toast while a save is in flight cancels only the
navigation intent: the save may finish, but the toast does not reopen and the
page does not navigate.

Keep **Leave Without Saving** unavailable whenever `pendingAttempt !== null`, `saving`, `savePromise`, or `refreshRequired` is present.

- [ ] **Step 5: Run all Wardrobe client tests and syntax validation**

Run:

```bash
npm test -- tests/dye-client-behavior.test.ts tests/web-dye.test.ts tests/dye-css.test.ts
node --check src/web/public/dye.js
```

Expected: PASS. Existing atomic batch, retry revision, stale conflict, canonical rebase, discard, and `beforeunload` tests must remain green.

- [ ] **Step 6: Commit Save & Continue**

```bash
git add src/web/public/dye.js tests/dye-client-behavior.test.ts
git commit -m "feat(wardrobe): save before guarded navigation"
```

---

### Task 5: Full verification and browser acceptance

**Files:**
- Verify only; no expected source changes.

**Interfaces:**
- Consumes: Tasks 1-4 complete on `feat/player-shop-cosmetics`.
- Produces: evidence that the feature is regression-safe and visually approved; no deployment.

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
npm test
npm run typecheck
node --check src/web/public/dye.js
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, JavaScript syntax is valid, and Git reports no whitespace errors.

- [ ] **Step 2: Start or reuse the isolated showcase**

If port 8114 is not already serving the branch, run:

```bash
PORT=8114 DB_PATH=/private/tmp/clauderpg-showcase.neMLqF/showcase.db ENABLE_COSMETICS_REVIEW=1 npm run dev
```

Use the seeded Tier-1 Knight URL:

```text
http://localhost:8114/character?token=WJjKIqGzMUaVcFtP3VwZi1PDUeEjKDlh
```

- [ ] **Step 3: Verify live-fitting visuals at three widths**

In the in-app browser, check 1280px, 760px, and 390px viewport widths:

1. The faint vertical center guide is gone.
2. `Live fitting` and Saved are vertically centered in the same header.
3. Change Tone so the badge reads `Unsaved changes`; it fits without touching, wrapping, or escaping the stage.
4. The animated character and black floor shadow remain unchanged.

Expected: all four checks pass at every width.

- [ ] **Step 4: Verify guarded navigation actions**

With a dirty Tone or hue draft:

1. Select Store; confirm the themed toast appears and the Character page remains.
2. Close it; confirm focus returns to Store and the draft remains.
3. Open it again and choose Leave Without Saving; confirm the saved appearance returns and the Shop opens without a native warning.
4. Return to Character, make two channel edits, select Unlock the next tier, and choose Save & Continue.
5. Confirm one save occurs, both channels persist after returning, and the requested Shop opens only after success.
6. Repeat at 390px and confirm the toast remains between the moss walls with stacked actions.

Expected: no silent draft loss, duplicate toast, duplicate save, native warning after a resolved action, or wall overlap.

- [ ] **Step 5: Review final branch state**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: branch is `feat/player-shop-cosmetics`; only intentional commits from Tasks 1-4 are present; the worktree is clean. Stop and report results without pushing, merging, deploying, or stopping the user's showcase server.

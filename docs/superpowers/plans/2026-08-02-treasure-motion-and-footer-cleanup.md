# Runtime Raiders Treasure Motion and Footer Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give gutter treasure deterministic staggered motion, animate it behind the moss walls at the responsive boundary, and remove the shared footer separator from every dungeon-shell page.

**Architecture:** Keep the interaction CSS-only. `layout.ejs` owns the fixed per-treasure timing data, `dungeon.css` owns rail geometry and reversible responsive transitions, and the shared footer rule owns separator removal. Existing focused Vitest files prove the rendered timing contract, CSS boundary behavior, and shared footer ownership before live browser verification exercises the actual transitions.

**Tech Stack:** EJS templates, CSS media queries/transitions/keyframes, TypeScript, Vitest, Supertest, in-app Browser verification

## Global Constraints

- Use the approved fixed durations and negative animation delays exactly; do not add runtime randomness.
- At `1431px` and below, left treasure retreats left and right treasure retreats right over `260ms`.
- Fade rail opacity over `140ms`, beginning `90ms` into the retreat; delay `visibility:hidden` until `260ms`.
- At `1432px` and above, visibility returns immediately and both rails re-enter over `260ms`.
- Rail width must never be smaller than the current `--wall` width.
- Under `prefers-reduced-motion: reduce`, treasure animations and rail transitions stop immediately.
- Remove the top border from the shared `.foot`; do not change borders inside panels, forms, tables, or landing content.
- Do not add resize listeners, timers, DOM mutation, or client JavaScript.
- Lite-frame pages remain treasure-free, and full-frame treasure remains `aria-hidden`.
- Do not change scoring, collection, companion packaging, registration logic, authentication, database state, deployment, DNS, Caddy, or the Pi.
- Preserve and do not stage `assets`, `companion/.build/`, or `docs/runtime-raiders/rebrand-visual-checklist.md`.

---

### Task 1: Stagger deterministic treasure phases and speeds

**Files:**
- Modify: `src/web/views/layout.ejs:16-21`
- Test: `tests/web-shell.test.ts:20-34`

**Interfaces:**
- Consumes: the existing ten full-frame treasure entries rendered by `layout.ejs`.
- Produces: ten `.loot` elements whose inline styles expose `--d:<duration>s` and `--delay:<negative-delay>s`; Task 2 consumes both custom properties.

- [ ] **Step 1: Write the failing rendered-markup test**

Extend the full-frame test so it derives timing from the real `/register`
response rather than inspecting the template source:

```ts
const styles = [...res.text.matchAll(/class="loot [lr]" style="([^"]+)"/g)]
  .map((match) => match[1]);
const value = (style: string, name: string) =>
  style.match(new RegExp(`--${name}:([^;]+)`))?.[1];

expect(styles).toHaveLength(10);
expect(styles.map((style) => value(style, 'd'))).toEqual([
  '9.4s', '11.2s', '12.8s', '10.3s', '13.6s',
  '12.1s', '9.7s', '13.2s', '10.8s', '11.6s',
]);
expect(styles.map((style) => value(style, 'delay'))).toEqual([
  '-2.1s', '-7.4s', '-4.9s', '-8.6s', '-1.3s',
  '-6.2s', '-3.8s', '-9.1s', '-5.4s', '-10.3s',
]);
expect(new Set(styles.map((style) => value(style, 'delay'))).size).toBe(10);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/web-shell.test.ts
```

Expected: FAIL because the rendered duration list still contains the old
integer sequence and each `--delay` lookup returns `undefined`.

- [ ] **Step 3: Add the approved timing data to the template**

Change the two tuple arrays to carry duration and delay explicitly:

```ejs
<% var LOOT_L=[
  ["orb_cyan","9%","9.4","1.6","-2.1"],
  ["book","44%","11.2","1.9","-7.4"],
  ["key","72%","12.8","1.3","-4.9"],
  ["amulet","28%","10.3","1.4","-8.6"],
  ["crown","88%","13.6","1.8","-1.3"]
]; %>
```

```ejs
<% var LOOT_R=[
  ["coins","13%","12.1","1.9","-6.2"],
  ["scroll","33%","9.7","1.3","-3.8"],
  ["gem_red","55%","13.2","1.4","-9.1"],
  ["ring_gold","74%","10.8","1.2","-5.4"],
  ["potion","90%","11.6","1.6","-10.3"]
]; %>
```

Append the delay variable to both inline style renderers without changing the
existing position, scale, or drift expressions:

```ejs
--d:<%= f[2] %>s;--delay:<%= f[4] %>s;--s:<%= f[3] %>
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run tests/web-shell.test.ts
```

Expected: all `tests/web-shell.test.ts` tests pass and the full/lite frame
assertions remain unchanged.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/web/views/layout.ejs tests/web-shell.test.ts
git commit -m "fix(shell): stagger gutter treasure motion"
```

---

### Task 2: Animate responsive wall retreat and re-entry

**Files:**
- Modify: `src/web/public/dungeon.css:46-64,136`
- Test: `tests/dungeon-shell-css.test.ts:6-39`

**Interfaces:**
- Consumes: `--d` and `--delay` from Task 1 plus existing `--wall` and per-item `--drift` variables.
- Produces: reversible CSS rail states at the `1431px`/`1432px` boundary with no responsive `display:none` rule.

- [ ] **Step 1: Replace the old breakpoint assertion with failing behavior assertions**

Update the first shell-motion test to require the delay in the animation:

```ts
expect(css).toMatch(
  /\.loot\{[^}]*animation:rail-bob var\(--d\) ease-in-out var\(--delay\) infinite/,
);
```

Replace the old “hides gutter loot” test with:

```ts
it('parks gutter loot behind the walls and reverses without display none', () => {
  expect(css).toMatch(
    /\.loot-rail\{[^}]*width:max\(var\(--wall\),calc\(\(100vw - 1120px\)\/2 \+ 18px\)\)[^}]*transform:translateX\(0\)[^}]*opacity:1[^}]*visibility:visible/,
  );
  expect(css).toMatch(
    /@media \(max-width:1431px\)\{[\s\S]*?\.loot-rail\.left\{transform:translateX\(-100%\)\}[\s\S]*?\.loot-rail\.right\{transform:translateX\(100%\)\}/,
  );
  expect(css).toMatch(
    /@media \(max-width:1431px\)\{[\s\S]*?\.loot-rail\{[^}]*opacity:0[^}]*visibility:hidden[^}]*visibility 0s linear 260ms/,
  );
  expect(css).not.toMatch(
    /@media \(max-width:1431px\)\{[\s\S]*?\.loot-rail\{[^}]*display:none/,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important[\s\S]*?\.loot-rail\{transition:none!important\}/,
  );
});
```

- [ ] **Step 2: Run the CSS test and verify RED**

Run:

```bash
npx vitest run tests/dungeon-shell-css.test.ts
```

Expected: FAIL because the animation has no delay, rail width has no minimum,
the breakpoint still uses `display:none`, and reduced motion does not disable
rail transitions.

- [ ] **Step 3: Implement the base and responsive rail states**

Update the shared rail and loot rules:

```css
.loot-rail{position:fixed;top:0;bottom:0;
  width:max(var(--wall),calc((100vw - 1120px)/2 + 18px));
  z-index:1;pointer-events:none;overflow:hidden;
  transform:translateX(0);opacity:1;visibility:visible;
  transition:transform 260ms cubic-bezier(.4,0,.8,.2),opacity 140ms ease 90ms,visibility 0s linear 0s}
.loot{position:absolute;top:var(--t);width:calc(30px*var(--s));height:calc(30px*var(--s));
  opacity:.6;animation:rail-bob var(--d) ease-in-out var(--delay) infinite}
```

Replace the `display:none` breakpoint with directional parked states:

```css
@media (max-width:1431px){
  .loot-rail{opacity:0;visibility:hidden;
    transition:transform 260ms cubic-bezier(.4,0,.8,.2),opacity 140ms ease 90ms,visibility 0s linear 260ms}
  .loot-rail.left{transform:translateX(-100%)}
  .loot-rail.right{transform:translateX(100%)}
}
```

Extend the existing shared reduced-motion rule without changing its loot
opacity contract:

```css
@media (prefers-reduced-motion:reduce){
  *{animation:none!important}
  .loot{opacity:.5}
  .loot-rail{transition:none!important}
}
```

- [ ] **Step 4: Run focused shell tests and verify GREEN**

Run:

```bash
npx vitest run tests/dungeon-shell-css.test.ts tests/web-shell.test.ts
```

Expected: both files pass; the lite-frame template remains treasure-free and
the wall/rail z-index contract is unchanged.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/web/public/dungeon.css tests/dungeon-shell-css.test.ts
git commit -m "fix(shell): retreat treasure behind dungeon walls"
```

---

### Task 3: Remove the shared footer separator

**Files:**
- Modify: `src/web/public/dungeon.css:87-88`
- Modify: `src/web/public/landing.css:57`
- Test: `tests/dungeon-shell-css.test.ts:18-24`
- Test: `tests/landing-css.test.ts:11-15`
- Test: `tests/web-shell.test.ts:43-50`

**Interfaces:**
- Consumes: the single shared `.foot` element rendered by `layout.ejs` for full and lite frames.
- Produces: a global `border-top:0` footer contract with no landing-specific override.

- [ ] **Step 1: Write failing shared-ownership tests**

Add a shell CSS assertion:

```ts
it('removes the footer separator from the shared shell', () => {
  expect(css).toMatch(/\.foot\{[^}]*border-top:0/);
  expect(css).not.toMatch(/\.foot\{[^}]*border-top:1px solid var\(--line\)/);
});
```

Replace the landing-only footer test with:

```ts
it('leaves shared footer presentation to dungeon.css', () => {
  expect(css).not.toMatch(/\.foot\s*\{/);
});
```

Extend the rendered footer test to cover the requested routes:

```ts
for (const path of ['/', '/register', '/character', '/admin/login']) {
  const page = await request(app).get(path);
  expect(page.status).toBe(200);
  expect(page.text).toContain('class="foot"');
}
```

- [ ] **Step 2: Run the footer tests and verify RED**

Run:

```bash
npx vitest run tests/dungeon-shell-css.test.ts tests/landing-css.test.ts tests/web-shell.test.ts
```

Expected: FAIL because the shared rule still declares a one-pixel top border
and `landing.css` still owns a `.foot` override.

- [ ] **Step 3: Move border removal into the shared shell**

Change only the footer border declaration in `dungeon.css`:

```css
.foot{max-width:1120px;margin:20px auto 34px;padding:20px var(--shell-inline) 0;border-top:0;
```

Delete this now-redundant rule from `landing.css`:

```css
.foot{border-top:0}
```

- [ ] **Step 4: Run the footer tests and verify GREEN**

Run:

```bash
npx vitest run tests/dungeon-shell-css.test.ts tests/landing-css.test.ts tests/web-shell.test.ts
```

Expected: all focused files pass; the landing motto and full/lite shell tests
remain green.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/web/public/dungeon.css src/web/public/landing.css tests/dungeon-shell-css.test.ts tests/landing-css.test.ts tests/web-shell.test.ts
git commit -m "fix(shell): remove shared footer separator"
```

---

### Task 4: Run complete automated and live visual verification

**Files:**
- Verify: `src/web/views/layout.ejs`
- Verify: `src/web/public/dungeon.css`
- Verify: `src/web/public/landing.css`
- Verify: `tests/web-shell.test.ts`
- Verify: `tests/dungeon-shell-css.test.ts`
- Verify: `tests/landing-css.test.ts`

**Interfaces:**
- Consumes: the completed timing, transition, reduced-motion, and footer contracts from Tasks 1-3.
- Produces: final local evidence only; this task does not deploy, push, install, or alter production state.

- [ ] **Step 1: Run the complete automated gate**

Run each command from the feature worktree:

```bash
npm test
npm run typecheck
npm run check:player-copy
git diff --check
```

Expected: all 140-or-more Vitest files pass with zero failed tests, TypeScript
reports no errors, the player-copy scanner reports no findings, and the diff
check produces no output.

- [ ] **Step 2: Verify staggered live motion at 1440x900**

Reload `/` in the existing local companion, set the viewport to `1440x900`,
and record computed `animationDuration`, `animationDelay`, transform, and
bounding-box X for all ten `.loot` elements.

Expected: durations and delays exactly match Task 1; all delays are negative
and unique; the ten pieces are not all at one transform or starting X phase;
there is no horizontal overflow.

- [ ] **Step 3: Verify retreat and re-entry across the exact boundary**

At `1432x900`, confirm each rail is visible at `translateX(0)`. Resize to
`1431x900`; sample during the first 260ms and again after 260ms. Then resize
back to `1432x900` and repeat the intermediate/final samples.

Expected: the left and right rails move in opposite outward directions; opacity
decreases after the 90ms delay; final narrow visibility is hidden; widening
makes visibility immediate and returns both transforms to zero after 260ms.
The moss walls remain above the rails for the full transition.

- [ ] **Step 4: Verify mobile and footer behavior**

At `390x844`, confirm rails remain off-screen, the page has no horizontal
overflow, and the landing composition remains intact. At a normal desktop
viewport, visit `/`, `/register`, `/character`, and `/admin/login` and record
the computed `.foot` top border.

Expected: every footer computes to `0px none`; Create Raider, Raider Login, and
Admin Login remain comfortably laid out; lite-frame Admin Login renders no
treasure markup.

- [ ] **Step 5: Inspect runtime errors and restore the deliverable tab**

Inspect browser warning/error logs across the live checks.

Expected: no new warnings or errors. Reset the temporary viewport, navigate the
existing tab back to `/`, and finalize that landing tab as the deliverable.

- [ ] **Step 6: Confirm the repository boundary**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: implementation is committed; only the three protected local
untracked paths remain; there is no deployment, push, installer, signing, DNS,
Caddy, or Pi change.

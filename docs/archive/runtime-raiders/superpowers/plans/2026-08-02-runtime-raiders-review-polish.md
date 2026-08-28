# Runtime Raiders Review Polish Implementation Plan

> **ARCHIVED — NON-AUTHORITATIVE — DO NOT EXECUTE.**
>
> This historical planning/design record is preserved as evidence only. The active
> Runtime Raiders authority is [docs/runtime-raiders/README.md](../../../../runtime-raiders/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the five approved review fixes: an exact three-line landing motto, wall-occluded treasure motion, no landing footer rule, a full-width Raider Login panel, and an adaptive full-TV leaderboard that uses spare width without reducing crisp dungeon scale.

**Architecture:** Keep the canonical motto and its display lines in the frozen brand contract, render one accessible heading with three visual spans, and use the landing stylesheet for page-only typography and footer treatment. Preserve the existing shell boundary by implementing treasure geometry and wall stacking in `dungeon.css`, while the Canvas 2D renderer computes the full-TV sidebar from a 38% target capped by the field width required at the largest available integer dungeon scale.

**Tech Stack:** TypeScript, Express, EJS, CSS, vanilla JavaScript, Canvas 2D, Vitest, Supertest, and in-app browser visual verification

## Global Constraints

- Preserve the approved classic-fantasy artwork, moss walls, torches, purple-and-gold palette, mobile behavior, and existing game rules.
- The motto must read exactly `Clock in.`, `Clear dungeons.`, and `Get paid.` on three deliberate lines.
- The accessible motto must be announced once as `Clock in. Clear dungeons. Get paid.`.
- Treasure may move below the walls but must remain decorative, non-interactive, and still under the existing `prefers-reduced-motion` treatment.
- The landing footer rule removal must not remove footer separators from other pages.
- Raider Login behavior, labels, and focus order must not change.
- Full-TV sidebar width targets `38%`; compact TV geometry remains unchanged.
- Full-TV allocation must retain the largest integer dungeon scale that fits the viewport height whenever the viewport width can support it with the existing `3%` field margins.
- Existing long-name ellipsis remains the final overflow fallback.
- Do not deploy, push, install, change DNS/Caddy, or modify the Raspberry Pi.
- Preserve and never stage `assets`, `companion/.build/`, or the untracked `docs/runtime-raiders/rebrand-visual-checklist.md` unless separately authorized.

## File Structure

- `src/domain/brand.ts` — owns the canonical brand sentence and its three approved display lines.
- `src/web/views/landing.ejs` — renders the single accessible motto as three visual lines.
- `src/web/public/landing.css` — owns landing-only motto typography and the landing-only footer override.
- `src/web/views/layout.ejs` — emits the per-treasure mirrored drift distance used by the shared shell animation.
- `src/web/public/dungeon.css` — owns treasure-rail bounds, wall/rail stacking, drift animation, and reduced-motion behavior.
- `src/web/views/character-login.ejs` — removes the one-off width cap and identifies the normal-width login panel.
- `src/web/public/tv/tv.js` — computes the adaptive full-TV sidebar and retains the existing measured ellipsis.
- `tests/brand-copy.test.ts` — verifies the frozen canonical/display motto contract.
- `tests/web-registration.test.ts` — verifies the accessible three-line landing markup.
- `tests/landing-css.test.ts` — verifies landing-only line and footer styling.
- `tests/web-shell.test.ts` — verifies mirrored drift metadata in rendered shell markup.
- `tests/dungeon-shell-css.test.ts` — verifies wall occlusion, rail bounds, motion, breakpoints, and reduced motion.
- `tests/web-character.test.ts` — verifies the login panel no longer carries an inline maximum width.
- `tests/anim.test.ts` — verifies the adaptive-TV constants and preserves existing full/compact rendering gates.
- `tests/tv-compact-renderer.test.ts` — exercises 1920×1080 and 3840×2160 full-TV geometry plus unchanged compact geometry.

---

### Task 1: Checkpoint the already verified review corrections

**Files:**
- Existing modified source: `src/web/public/dungeon.css`
- Existing modified source: `src/web/public/player-hub.css`
- Existing modified source: `src/web/public/tv/tv.js`
- Existing modified views: `src/web/views/admin-players.ejs`, `src/web/views/admin-potions.ejs`
- Existing modified tests: `tests/admin-potions-css.test.ts`, `tests/anim.test.ts`, `tests/dungeon-shell-css.test.ts`, `tests/player-hub-css.test.ts`, `tests/shop-css.test.ts`, `tests/tv-compact-renderer.test.ts`, `tests/web-admin-players.test.ts`

**Interfaces:**
- Consumes: the already reviewed mobile Inventory, Bazaar badge, admin layout, long-name ellipsis, and defeat-result corrections in the current worktree.
- Produces: a clean tracked-file baseline so the five new fixes can be committed and reviewed independently.

- [ ] **Step 1: Confirm the existing correction set is exactly the expected tracked set**

Run:

```bash
git status --short
git diff --stat -- src/web/public/dungeon.css src/web/public/player-hub.css src/web/public/tv/tv.js src/web/views/admin-players.ejs src/web/views/admin-potions.ejs tests/admin-potions-css.test.ts tests/anim.test.ts tests/dungeon-shell-css.test.ts tests/player-hub-css.test.ts tests/shop-css.test.ts tests/tv-compact-renderer.test.ts tests/web-admin-players.test.ts
```

Expected: only the listed tracked files contain the already verified corrections; `assets`, `companion/.build/`, and `docs/runtime-raiders/rebrand-visual-checklist.md` remain untracked and unstaged.

- [ ] **Step 2: Re-run the focused correction tests**

Run:

```bash
npm test -- tests/admin-potions-css.test.ts tests/anim.test.ts tests/dungeon-shell-css.test.ts tests/player-hub-css.test.ts tests/shop-css.test.ts tests/tv-compact-renderer.test.ts tests/web-admin-players.test.ts
npm run typecheck
```

Expected: every focused Vitest file passes and TypeScript reports no errors.

- [ ] **Step 3: Stage only the verified tracked correction files**

Run:

```bash
git add src/web/public/dungeon.css src/web/public/player-hub.css src/web/public/tv/tv.js src/web/views/admin-players.ejs src/web/views/admin-potions.ejs tests/admin-potions-css.test.ts tests/anim.test.ts tests/dungeon-shell-css.test.ts tests/player-hub-css.test.ts tests/shop-css.test.ts tests/tv-compact-renderer.test.ts tests/web-admin-players.test.ts
git diff --cached --name-only
git diff --cached --check
```

Expected: the staged name list contains exactly those twelve paths and the staged whitespace check is clean.

- [ ] **Step 4: Commit the existing review corrections**

Run:

```bash
git commit -m "fix(ui): apply Runtime Raiders visual review corrections"
```

Expected: one local commit containing only the verified tracked correction set.

---

### Task 2: Render the landing motto as three accessible lines and remove its footer rule

**Files:**
- Modify: `src/domain/brand.ts:1-5`
- Modify: `src/web/views/landing.ejs:1-8`
- Modify: `src/web/public/landing.css:1-9,66`
- Modify: `tests/brand-copy.test.ts:88-97`
- Modify: `tests/web-registration.test.ts:18-54`
- Create: `tests/landing-css.test.ts`

**Interfaces:**
- Consumes: `BRAND.primaryLine: string` from the existing brand contract and landing-only `styles: ['landing.css']` from `src/web/routes/registration.ts`.
- Produces: `BRAND.primaryLines: readonly ['Clock in.', 'Clear dungeons.', 'Get paid.']`, `.hero-motto`, and `.hero-motto-line`.

- [ ] **Step 1: Write failing brand, markup, and CSS tests**

Add these assertions to the brand-contract test in `tests/brand-copy.test.ts`:

```ts
expect(BRAND.primaryLines).toEqual([
  'Clock in.',
  'Clear dungeons.',
  'Get paid.',
]);
expect(BRAND.primaryLines.join(' ')).toBe(BRAND.primaryLine);
```

Replace the single landing-copy assertion in `tests/web-registration.test.ts` with the explicit visual/accessibility contract:

```ts
expect(res.text).toContain(
  '<h1 class="hero-motto" aria-label="Clock in. Clear dungeons. Get paid.">',
);
expect(res.text.match(/class="hero-motto-line" aria-hidden="true"/g)).toHaveLength(3);
expect(res.text).toContain('>Clock in.</span>');
expect(res.text).toContain('>Clear dungeons.</span>');
expect(res.text).toContain('>Get paid.</span>');
```

Create `tests/landing-css.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/landing.css', 'utf8');

describe('Runtime Raiders landing presentation', () => {
  it('keeps each approved motto sentence on its own line', () => {
    expect(css).toMatch(/\.hero-motto-line\{[^}]*display:block[^}]*white-space:nowrap/);
    expect(css).toMatch(/@media \(max-width:480px\)\{[\s\S]*?\.hero-motto\{[^}]*font-size:clamp\(26px,8\.5vw,38px\)/);
  });

  it('removes the separator from the landing footer only', () => {
    expect(css).toMatch(/\.foot\{[^}]*border-top:0/);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
npm test -- tests/brand-copy.test.ts tests/web-registration.test.ts tests/landing-css.test.ts
```

Expected: FAIL because `BRAND.primaryLines`, the three visual spans, `.hero-motto-line`, the narrow motto sizing rule, and the landing footer override do not exist yet.

- [ ] **Step 3: Add the canonical display lines and accessible EJS markup**

Change `BRAND` in `src/domain/brand.ts` to:

```ts
export const BRAND = Object.freeze({
  name: 'Runtime Raiders',
  primaryLine: 'Clock in. Clear dungeons. Get paid.',
  primaryLines: Object.freeze([
    'Clock in.',
    'Clear dungeons.',
    'Get paid.',
  ]),
  secondaryLine: 'Your AI keeps running. Your Raider keeps raiding.',
});
```

Replace the landing `<h1>` in `src/web/views/landing.ejs` with:

```ejs
<h1 class="hero-motto" aria-label="<%= brand.primaryLine %>">
  <% brand.primaryLines.forEach(function (line) { %><span class="hero-motto-line" aria-hidden="true"><%= line %></span><% }); %>
</h1>
```

The heading's `aria-label` supplies the canonical sentence once; the three child spans are visual-only.

- [ ] **Step 4: Add landing-only line sizing and footer styling**

Replace the landing stylesheet's global `h1` rule with `.hero-motto`, then add the line and footer rules:

```css
.hero-motto{font-size:clamp(38px,6.2vw,64px);line-height:1.02;margin:0 0 18px;font-weight:850;letter-spacing:-.02em;color:var(--head);text-wrap:balance}
.hero-motto-line{display:block;white-space:nowrap}
.foot{border-top:0}
```

Extend the existing narrow rules in `src/web/public/landing.css` with:

```css
@media (max-width:480px){.hero-motto{font-size:clamp(26px,8.5vw,38px)}}
```

Because `landing.css` is linked only by `GET /`, `.foot{border-top:0}` cannot alter the footer on Raider Login, registration, admin, or other pages.

- [ ] **Step 5: Run the focused tests to verify they pass**

Run:

```bash
npm test -- tests/brand-copy.test.ts tests/web-registration.test.ts tests/landing-css.test.ts tests/web-shell.test.ts
```

Expected: PASS; the brand copy remains canonical, landing HTML contains three visual lines with one accessible label, and other shell copy remains intact.

- [ ] **Step 6: Commit the motto and landing-only footer fix**

Run:

```bash
git add src/domain/brand.ts src/web/views/landing.ejs src/web/public/landing.css tests/brand-copy.test.ts tests/web-registration.test.ts tests/landing-css.test.ts
git diff --cached --check
git commit -m "fix(landing): strengthen the Runtime Raiders motto"
```

Expected: one local commit containing only the brand, landing, and associated tests.

---

### Task 3: Let gutter treasure drift beneath the moss walls

**Files:**
- Modify: `src/web/views/layout.ejs:11-21`
- Modify: `src/web/public/dungeon.css:30-60,128`
- Modify: `tests/web-shell.test.ts:22-29`
- Modify: `tests/dungeon-shell-css.test.ts:5-22`

**Interfaces:**
- Consumes: shell custom properties `--wall`, per-item `--x`, `--t`, `--d`, and `--s`, plus the existing `frame-lite` and `1252px` rail-hiding contracts.
- Produces: per-item `--drift` pixels, `@keyframes rail-bob`, a rail spanning the wall gutter plus an `18px` safe overhang, and foreground wall stacking at `z-index:3`.

- [ ] **Step 1: Write failing shell markup and CSS tests**

Extend the full-frame test in `tests/web-shell.test.ts`:

```ts
expect(res.text).toContain('--drift:-22px');
expect(res.text).toContain('--drift:24px');
```

Add a new test to `tests/dungeon-shell-css.test.ts`:

```ts
it('drifts gutter treasure beneath foreground moss walls without an inner-edge crop', () => {
  expect(css).toMatch(/\.wall\{[^}]*z-index:3/);
  expect(css).toMatch(/\.loot-rail\{[^}]*width:calc\(\(100vw - 1120px\)\/2 \+ 18px\)[^}]*z-index:1[^}]*overflow:hidden/);
  expect(css).toMatch(/\.loot-rail\.left\{left:0\} \.loot-rail\.right\{right:0\}/);
  expect(css).toMatch(/\.loot\.l\{left:calc\(var\(--wall\) \+ var\(--x\)\)\}/);
  expect(css).toMatch(/\.loot\.r\{right:calc\(var\(--wall\) \+ var\(--x\)\)\}/);
  expect(css).toMatch(/\.loot\{[^}]*animation:rail-bob var\(--d\) ease-in-out infinite/);
  expect(css).toMatch(/@keyframes rail-bob\{[^}]*translate\(var\(--drift\),-16px\)/);
  expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important[\s\S]*?\.loot\{opacity:\.5\}/);
});
```

- [ ] **Step 2: Run the shell tests to verify they fail**

Run:

```bash
npm test -- tests/web-shell.test.ts tests/dungeon-shell-css.test.ts
```

Expected: FAIL because the layout has no `--drift`, the walls and rails share a stacking level, and `.loot` still uses the vertical-only `bob` animation inside the old rail bounds.

- [ ] **Step 3: Emit mirrored drift distances from the shell**

Update the left treasure inline style in `src/web/views/layout.ejs` to include:

```ejs
--drift:<%= -(22 + (i % 3) * 22) %>px
```

Update the right treasure inline style to include:

```ejs
--drift:<%= 24 + (i % 3) * 20 %>px
```

These values move each of the three horizontal starting columns twelve pixels beneath its nearest wall at the animation midpoint while preserving the existing staggered durations and vertical positions.

- [ ] **Step 4: Put walls above the expanded rails and animate toward them**

Change the relevant shell rules in `src/web/public/dungeon.css` to:

```css
.wall{position:fixed;top:0;bottom:0;width:var(--wall);z-index:3;
  background:url('/static/landing/moss_wall.png');background-size:var(--wall) var(--wall);
  image-rendering:pixelated;pointer-events:none}

/* gutter loot rails include the wall region; walls at z-index 3 provide the visible occlusion */
.loot-rail{position:fixed;top:0;bottom:0;width:calc((100vw - 1120px)/2 + 18px);
  z-index:1;pointer-events:none;overflow:hidden}
.loot-rail.left{left:0} .loot-rail.right{right:0}
.loot{position:absolute;top:var(--t);width:calc(30px*var(--s));height:calc(30px*var(--s));
  opacity:.6;animation:rail-bob var(--d) ease-in-out infinite}
.loot.l{left:calc(var(--wall) + var(--x))} .loot.r{right:calc(var(--wall) + var(--x))}
.loot img{width:100%;height:100%;filter:drop-shadow(0 4px 7px rgba(0,0,0,.55))}
@keyframes rail-bob{0%,100%{transform:translate(0,0) rotate(-2deg)}50%{transform:translate(var(--drift),-16px) rotate(2deg)}}
@keyframes bob{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-16px) rotate(2deg)}}
```

Keep `.bar,main,.foot{position:relative;z-index:2}`, the `1252px` hide breakpoint, `body.frame-lite .loot-rail{display:none}`, and the existing reduced-motion rule unchanged. The separate `bob` keyframes remain because the landing's final reward icons use them without a `--drift` variable.

- [ ] **Step 5: Run the shell and landing tests to verify they pass**

Run:

```bash
npm test -- tests/web-shell.test.ts tests/dungeon-shell-css.test.ts tests/landing-css.test.ts tests/web-registration.test.ts
```

Expected: PASS; the rails still disappear at the established breakpoint and in lite frames, but visible treasure now travels into the wall region below the foreground wall layer.

- [ ] **Step 6: Commit the wall-occluded treasure motion**

Run:

```bash
git add src/web/views/layout.ejs src/web/public/dungeon.css tests/web-shell.test.ts tests/dungeon-shell-css.test.ts
git diff --cached --check
git commit -m "fix(shell): hide drifting treasure beneath dungeon walls"
```

Expected: one local commit containing only the shell markup, shell CSS, and focused tests.

---

### Task 4: Expand Raider Login to the normal page width

**Files:**
- Modify: `src/web/views/character-login.ejs:1`
- Modify: `tests/web-character.test.ts:20-30`

**Interfaces:**
- Consumes: the shared block-level `.panel` rule and normal `main` width from `dungeon.css`.
- Produces: `.raider-login` as a semantic page marker with no inline `max-width` constraint.

- [ ] **Step 1: Write the failing login-width test**

Add these assertions to `GET /character shows the login form` in `tests/web-character.test.ts`:

```ts
expect(res.text).toContain('<div class="panel raider-login">');
expect(res.text).not.toContain('style="max-width:520px"');
```

- [ ] **Step 2: Run the login test to verify it fails**

Run:

```bash
npm test -- tests/web-character.test.ts -t "GET /character shows the login form"
```

Expected: FAIL because the panel still contains `style="max-width:520px"` and lacks the semantic class.

- [ ] **Step 3: Remove the one-off width cap**

Change the first line of `src/web/views/character-login.ejs` to:

```ejs
<div class="panel raider-login">
```

Do not add a replacement maximum width. A block-level `.panel` naturally fills the normal content column established by `main`.

- [ ] **Step 4: Run the character tests to verify they pass**

Run:

```bash
npm test -- tests/web-character.test.ts
```

Expected: PASS; login and authenticated Raider Hub behavior remain unchanged.

- [ ] **Step 5: Commit the login-width fix**

Run:

```bash
git add src/web/views/character-login.ejs tests/web-character.test.ts
git diff --cached --check
git commit -m "fix(character): expand Raider Login panel"
```

Expected: one local commit containing only the login view and route test.

---

### Task 5: Allocate spare full-TV width to the leaderboard

**Files:**
- Modify: `src/web/public/tv/tv.js:7-15,91-121`
- Modify: `tests/anim.test.ts:18-31`
- Modify: `tests/tv-compact-renderer.test.ts:198-323,318-430`

**Interfaces:**
- Consumes: `TILE = 24`, a 20×15 dungeon, `canvas.width`, `canvas.height`, the existing `9%` HP zone, `2%` bottom margin, `3%` field-side margins, and `fitSidebarText(text, maxWidth, font)`.
- Produces: `SIDEBAR_TARGET_FRAC = 0.38`, `FIELD_SIDE_MARGIN_FRAC = 0.03`, and full-TV layout metrics where `sidebarW <= viewportWidth * 0.38` and `fieldW >= panelW / 0.94`.

- [ ] **Step 1: Write failing constant and geometry tests**

Update the full/compact bootstrap assertions in `tests/anim.test.ts`:

```ts
expect(source).toContain('const SIDEBAR_TARGET_FRAC = 0.38;');
expect(source).toContain('const FIELD_SIDE_MARGIN_FRAC = 0.03;');
expect(source).not.toContain('const SIDEBAR_FRAC = IS_COMPACT ? 0 : 0.30;');
```

Add these interfaces immediately before `renderTvAt` in `tests/tv-compact-renderer.test.ts`:

```ts
interface TvViewport {
  width: number;
  height: number;
}

interface TvLayoutMetrics {
  sidebarW: number;
  fieldX: number;
  scale: number;
  panelX: number;
  panelW: number;
  panelH: number;
}
```

Change the `renderTvAt` signature and its first two lines to:

```ts
function renderTvAt(
  dpr: number,
  mode: 'compact' | 'full' = 'compact',
  stateOverrides: Record<string, unknown> = {},
  viewport: TvViewport = mode === 'compact'
    ? { width: 480, height: 400 }
    : { width: 1200, height: 800 },
) {
  const source = readFileSync('src/web/public/tv/tv.js', 'utf8');
  const instrumentedSource = `${source}\nwindow.__readTvLayout = () => ({ sidebarW, fieldX, scale, panelX, panelW, panelH });`;
  const stage = new FakeCanvas(dpr);
```

Replace the current `windowObject` declaration with:

```ts
  const windowObject: {
    devicePixelRatio: number;
    innerWidth: number;
    innerHeight: number;
    addEventListener: () => void;
    ClaudeRpgPotionFx: undefined;
    __readTvLayout?: () => TvLayoutMetrics;
  } = {
    devicePixelRatio: dpr,
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    addEventListener() {},
    ClaudeRpgPotionFx: undefined,
  };
```

Pass `instrumentedSource` as the first argument of the existing `vm.runInNewContext(...)` call. Immediately before the existing return statement, add:

```ts
  const tvLayout = windowObject.__readTvLayout?.();
  if (!tvLayout) throw new Error('Renderer did not expose its test layout');
```

Replace the existing return statement with:

```ts
  return {
    backingSize: { width: stage.width, height: stage.height },
    cssSize: { width: stage.style.width, height: stage.style.height },
    dungeon: dungeonDraw.bounds,
    title: {
      top: rounded(titleTop),
      bottom: rounded(titleBottom),
      draws: titleDraws,
    },
    bar: barFills,
    texts: stage.context.texts,
    tvLayout,
  };
```

Add full-TV geometry coverage:

```ts
describe('adaptive full TV geometry', () => {
  it('uses the 38 percent target at 1920 by 1080 without reducing scale 2', () => {
    const rendering = renderTvAt(1, 'full', {}, { width: 1920, height: 1080 });

    expect(rendering.tvLayout.scale).toBe(2);
    expect(rendering.tvLayout.sidebarW).toBe(Math.round(1920 * 0.38));
    expect(rendering.tvLayout.fieldX).toBe(rendering.tvLayout.sidebarW);
    expect(rendering.tvLayout.panelW).toBe(20 * 24 * 2);
    expect(rendering.dungeon.width).toBe(20 * 24 * 2);
  });

  it('caps the 4K sidebar so the height-supported scale 5 dungeon still fits', () => {
    const rendering = renderTvAt(1, 'full', {}, { width: 3840, height: 2160 });
    const fieldWidth = 3840 - rendering.tvLayout.sidebarW;

    expect(rendering.tvLayout.scale).toBe(5);
    expect(rendering.tvLayout.sidebarW).toBeLessThan(Math.round(3840 * 0.38));
    expect(fieldWidth).toBeGreaterThanOrEqual(rendering.tvLayout.panelW / 0.94);
    expect(rendering.tvLayout.panelW).toBe(20 * 24 * 5);
    expect(rendering.dungeon.width).toBe(20 * 24 * 5);
  });
});
```

- [ ] **Step 2: Run the TV tests to verify they fail**

Run:

```bash
npm test -- tests/anim.test.ts tests/tv-compact-renderer.test.ts
```

Expected: FAIL because the renderer still fixes the full sidebar at `30%` and does not expose the new target/margin constants.

- [ ] **Step 3: Replace the fixed fraction with the capped adaptive calculation**

Replace the fixed sidebar constant in `src/web/public/tv/tv.js` with:

```js
const SIDEBAR_TARGET_FRAC = 0.38;
const FIELD_SIDE_MARGIN_FRAC = 0.03;
```

Replace the full-mode body of `computeScale()` with:

```js
const vw = canvas.width, vh = canvas.height;
const hpZone = vh * 0.09;
const bottomMargin = vh * 0.02;
const availH = vh - hpZone - bottomMargin;
const heightScale = Math.max(1, Math.floor(availH / (15 * TILE)));
const widthScale = Math.max(1, Math.floor(
  vw * (1 - 2 * FIELD_SIDE_MARGIN_FRAC) / (20 * TILE),
));

scale = Math.max(1, Math.min(heightScale, widthScale));
tilePx = TILE * scale;
panelW = 20 * tilePx;
panelH = 15 * tilePx;

const targetSidebarW = Math.round(vw * SIDEBAR_TARGET_FRAC);
const minimumFieldW = panelW / (1 - 2 * FIELD_SIDE_MARGIN_FRAC);
const maximumSidebarW = Math.max(0, Math.floor(vw - minimumFieldW));
sidebarW = Math.min(targetSidebarW, maximumSidebarW);
fieldX = sidebarW;

const fieldW = vw - sidebarW;
panelX = fieldX + Math.round((fieldW - panelW) / 2);
panelY = Math.round(hpZone + (availH - panelH) / 2);
```

This chooses the largest integer scale supported by both the height and the whole viewport, then grants the sidebar up to `38%` only after reserving enough field width for the dungeon plus the existing two `3%` margins.

- [ ] **Step 4: Run full and compact TV tests to verify they pass**

Run:

```bash
npm test -- tests/anim.test.ts tests/tv-compact-renderer.test.ts tests/web-tv.test.ts tests/tvview-layout.test.ts
```

Expected: PASS at 1920×1080 and 3840×2160, with all existing compact 480×400/DPR assertions unchanged and the previously added long-name ellipsis tests still green.

- [ ] **Step 5: Commit the adaptive TV allocation**

Run:

```bash
git add src/web/public/tv/tv.js tests/anim.test.ts tests/tv-compact-renderer.test.ts
git diff --cached --check
git commit -m "fix(tv): widen the adaptive leaderboard"
```

Expected: one local commit containing only the full-TV geometry calculation and its tests.

---

### Task 6: Run complete automated and visual verification

**Files:**
- Verify only; no production or deployment files change.

**Interfaces:**
- Consumes: all five completed UI fixes and the local companion at `http://127.0.0.1:41739/`.
- Produces: a locally verified, undeployed review candidate.

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
npm test
npm run typecheck
npm run check:player-copy
git diff --check
```

Expected: the complete Vitest suite passes, TypeScript reports no errors, the player-copy scanner passes, and there are no whitespace errors.

- [ ] **Step 2: Verify landing desktop presentation at 1440×1000**

Open `/` at 1440×1000 and confirm:

- the motto is exactly three lines, with **Clear dungeons.** intact;
- the footer has no purple rule;
- left and right treasure remain behind content and visibly travel beneath the moss walls;
- no treasure is cut off at the inner gutter edge; and
- the existing palette, torches, boss card, calls to action, and content width are unchanged.

Expected: the only visible landing differences are the approved motto, footer edge, and wall-occluded treasure motion.

- [ ] **Step 3: Verify narrow and reduced-motion landing behavior**

Open `/` at 390×844, enable reduced motion in the browser context, and confirm:

- each motto sentence remains intact without horizontal scrolling;
- gutter treasure is hidden by the established narrow breakpoint; and
- remaining animation is disabled by the shared reduced-motion rule.

Expected: a stable, readable mobile composition with no clipped content.

- [ ] **Step 4: Verify Raider Login at wide and narrow widths**

Open `/character` at 1440×1000 and 390×844. Confirm the dungeon panel fills the same normal content column as other full-frame views, then confirm the form remains comfortable, labeled, focusable, and free of horizontal scrolling on mobile.

Expected: the wide card no longer stops at 520px; mobile behavior remains unchanged.

- [ ] **Step 5: Verify TV allocation at 1920×1080 and 3840×2160**

Open `/tv` at both target sizes and confirm:

- the 1920×1080 leaderboard is visibly wider and uses the old empty strip;
- representative long Raider names gain room and still ellipsize before overlap;
- the dungeon remains crisp at integer scale 2 on 1920×1080;
- the 4K sidebar stops below 38% so the dungeon remains crisp at integer scale 5; and
- combat, pause, defeat, status chrome, and leaderboard rotation remain aligned.

Expected: the leaderboard receives spare width without shrinking or blurring the dungeon.

- [ ] **Step 6: Confirm repository boundaries**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: only protected local untracked paths remain outside the completed commits; there is no deployment, DNS, Caddy, signing, installer, or Pi change.

## Self-Review Record

- **Spec coverage:** Motto wording/accessibility and narrow behavior are Task 2; wall occlusion, mirrored motion, breakpoints, and reduced motion are Task 3; landing-only footer and full-width Login are Tasks 2 and 4; adaptive 38% TV allocation, integer scaling, margins, ellipsis preservation, and compact-mode protection are Task 5; complete local verification and no-deploy boundary are Task 6.
- **File ownership:** The implementation keeps treasure geometry in the existing shared shell stylesheet because rails and walls are shared layout components; `landing.css` remains responsible for the landing-only motto and footer override.
- **Protected worktree state:** Task 1 commits only the known tracked review corrections. Every later commit stages an explicit path list, and no task stages `assets`, `companion/.build/`, or the untracked visual checklist.
- **Type and selector consistency:** `primaryLines`, `hero-motto`, `hero-motto-line`, `raider-login`, `SIDEBAR_TARGET_FRAC`, `FIELD_SIDE_MARGIN_FRAC`, `TvViewport`, `TvLayoutMetrics`, `tvLayout`, and `--drift` use the same names in implementation and tests.
- **Placeholder scan:** Every code change, test assertion, command, expected failure, expected pass, and commit boundary is specified; there are no deferred implementation markers.

# Player Hub Live Dungeon Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the player hub's broad compact-TV embed with a tight, transparent, animated dungeon dashboard: dungeon and Fight Leaders side by side, with Today in one full-width strip.

**Architecture:** Keep `/tv/embed`, `/tv/stream`, and the shared `tv.js` renderer. Add a compact-only 480 × 400 framing path that draws the existing 20 × 15 dungeon beneath a 40-pixel status strip without the TV backdrop; then reshape the character-page markup and CSS around that exact stage. Full-TV geometry, rendering, SSE state, combat behavior, and data calculations remain unchanged.

**Tech Stack:** Node 26, TypeScript 5.5, Express 4, EJS, browser Canvas 2D, plain JavaScript/CSS, Vitest 2, Supertest

## Global Constraints

- The production implementation must render from the existing live TV layout/state frames; it must not use CSS viewport cropping or hardcoded TV-page offsets.
- `/tv/embed` remains an iframe and continues to use the shared `/static/tv/tv.js` renderer and `/tv/stream` SSE connection.
- The compact desktop composition is 480 × 400 CSS pixels: a 40-pixel transparent status area above the complete 480 × 360 (20 × 15 tile) dungeon.
- Compact mode has no TV leaderboard, no tiled TV backdrop, and no proportional outer margins.
- Full-screen `/tv` geometry, backdrop, leaderboard, cursor behavior, and rendering remain unchanged.
- The dungeon uses an 11-pixel rounded clip; cropping the extreme corner wall pixels is approved.
- The dungeon shadow is small, soft, and offset only toward the bottom-right. Do not add a four-sided halo or ambient glow.
- Fight Leaders and Today become visually quieter than the dungeon while remaining readable.
- Existing Fight Leader and Today calculations, IDs, formatting, and five-second player-hub updates remain unchanged.
- No database migration, new game-state payload, new polling loop, combat change, potion tuning change, Pi action, or production deployment belongs in this plan.

---

## File Structure

- `src/web/public/tv/tv.js` — owns full and compact canvas geometry, transparent compact rendering, rounded compact clipping, HP/status drawing, and compact pause bounds.
- `src/web/public/tv/embed.html` — owns the transparent iframe document; still loads the shared potion vocabulary and TV renderer.
- `src/web/views/character-live.ejs` — owns semantic dashboard order: dungeon, Fight Leaders, Today.
- `src/web/public/player-hub.css` — owns the 480-pixel desktop grid, room-only offset shadow, subdued supporting panels, and responsive stacking.
- `tests/anim.test.ts` — protects shared renderer/SSE behavior and compact-only framing/polish decisions.
- `tests/web-tv.test.ts` — protects the transparent compact document while preserving the full-TV document.
- `tests/web-character.test.ts` — protects semantic dashboard order and existing update IDs.
- `tests/player-hub-css.test.ts` — protects desktop geometry, radius/shadow direction, Today strip, and narrow breakpoints.
- `docs/testing/timed-consumables-local.md` — records the new visual-review contract.

---

### Task 1: Add tight transparent compact geometry

**Files:**
- Modify: `tests/anim.test.ts:13-42`
- Modify: `tests/web-tv.test.ts:22-35`
- Modify: `src/web/public/tv/tv.js:6-12, 84-128, 269-289`
- Modify: `src/web/public/tv/embed.html:5-13`

**Interfaces:**
- Consumes: existing `TV_MODE`, `IS_COMPACT`, `canvas`, `layout`, `bg`, `texbg`, `scale`, `tilePx`, `panelX`, `panelY`, `panelW`, and `panelH` globals in `tv.js`.
- Produces: `COMPACT_STATUS = 40`; compact geometry with `panelW = 20 * tilePx`, `panelH = 15 * tilePx`, and `panelY` immediately after the scaled status area; `texbg === null` in compact mode.

- [ ] **Step 1: Write failing compact-geometry tests**

In `tests/anim.test.ts`, keep the existing shared-renderer test and append this test inside `describe('TV renderer bootstrap', ...)`:

```ts
  it('gives compact mode a tight transparent 480 by 400 composition', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'web', 'public', 'tv', 'tv.js'),
      'utf8',
    );

    expect(source).toContain('const COMPACT_STATUS = 40;');
    expect(source).toContain('const logicalW = 20 * TILE;');
    expect(source).toContain('const logicalH = 15 * TILE + COMPACT_STATUS;');
    expect(source).toContain('panelY = Math.round((vh - logicalH * scale) / 2) + COMPACT_STATUS * scale;');
    expect(source).toContain('const compactFit = Math.min(1, window.innerWidth / 480, window.innerHeight / 400);');
    expect(source).toContain('const compactDpr = Math.max(1, Math.floor(dpr));');
    expect(source).toContain('canvas.style.transform = `scale(${compactFit})`;');
    expect(source).toContain("texbg = IS_COMPACT ? null : document.createElement('canvas');");
    expect(source).toContain("else if (!IS_COMPACT) { ctx.fillStyle = '#14121a';");
  });
```

In `tests/web-tv.test.ts`, replace the compact route test with:

```ts
  it('GET /tv/embed serves the transparent shared compact renderer', async () => {
    const embed = await request(app).get('/tv/embed');
    expect(embed.status).toBe(200);
    expect(embed.text).toContain('<body data-tv-mode="compact">');
    expect(embed.text).toContain('<canvas id="stage"></canvas>');
    expect(embed.text).toContain('/static/potion-fx.js');
    expect(embed.text).toContain('/static/tv/tv.js');
    expect(embed.text).toContain('background: transparent');
    expect(embed.text).toContain('width: 100%');
    expect(embed.text).toContain('height: 100%');
    expect(embed.text).not.toContain('cursor: none');
  });
```

- [ ] **Step 2: Run the targeted tests and verify the expected failure**

Run:

```bash
npm test -- tests/anim.test.ts tests/web-tv.test.ts
```

Expected: FAIL because `COMPACT_STATUS`, the compact logical geometry, compact `texbg` suppression, and the transparent embed background do not exist.

- [ ] **Step 3: Implement compact-only geometry**

In `src/web/public/tv/tv.js`, add the status constant beside `TILE`:

```js
const TILE = 24;            // source tile size
const COMPACT_STATUS = 40;  // source pixels above the 20x15 hub dungeon
```

Replace `resize()` with a fixed-source compact branch and the unchanged
viewport-sized full branch:

```js
function resize() {
  const dpr = window.devicePixelRatio || 1;
  if (IS_COMPACT) {
    const compactFit = Math.min(1, window.innerWidth / 480, window.innerHeight / 400);
    const compactDpr = Math.max(1, Math.floor(dpr));
    canvas.width = 480 * compactDpr;
    canvas.height = 400 * compactDpr;
    canvas.style.width = '480px';
    canvas.style.height = '400px';
    canvas.style.transformOrigin = 'top left';
    canvas.style.transform = `scale(${compactFit})`;
  } else {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.transform = '';
  }
  ctx.imageSmoothingEnabled = false;
  computeScale();
  buildBackground();
}
```

This keeps compact drawing at the exact 480 × 400 logical source (or its DPR
multiple), then uniformly scales that completed composition only when the iframe
viewport is narrower than 480 pixels.

Replace `computeScale()` with this compact-first version; preserve the existing full-TV branch exactly after the early return:

```js
function computeScale() {
  const vw = canvas.width, vh = canvas.height;
  if (IS_COMPACT) {
    sidebarW = 0;
    fieldX = 0;
    const logicalW = 20 * TILE;
    const logicalH = 15 * TILE + COMPACT_STATUS;
    scale = Math.max(1, Math.floor(Math.min(vw / logicalW, vh / logicalH)));
    tilePx = TILE * scale;
    panelW = 20 * tilePx;
    panelH = 15 * tilePx;
    panelX = Math.round((vw - panelW) / 2);
    panelY = Math.round((vh - logicalH * scale) / 2) + COMPACT_STATUS * scale;
    return;
  }

  sidebarW = Math.round(vw * SIDEBAR_FRAC);
  fieldX = sidebarW;
  const fieldW = vw - sidebarW;
  const hpZone = vh * 0.09, bottomMargin = vh * 0.02, sideMargin = fieldW * 0.03;
  const availW = fieldW - 2 * sideMargin;
  const availH = vh - hpZone - bottomMargin;
  scale = Math.max(1, Math.floor(Math.min(availW / (20 * TILE), availH / (15 * TILE))));
  tilePx = TILE * scale;
  panelW = 20 * tilePx;
  panelH = 15 * tilePx;
  panelX = fieldX + Math.round((fieldW - panelW) / 2);
  panelY = Math.round(hpZone + (availH - panelH) / 2);
}
```

In `buildBackground()`, make the backdrop optional and guard its context/draw loop:

```js
  texbg = IS_COMPACT ? null : document.createElement('canvas');
  let tb = null;
  if (texbg) {
    texbg.width = canvas.width;
    texbg.height = canvas.height;
    tb = texbg.getContext('2d');
    tb.imageSmoothingEnabled = false;
  }
```

At the start of the existing `draw` callback, replace the unconditional backdrop loop with:

```js
    if (tb && texbg) {
      for (let y = 0; y < texbg.height; y += tilePx)
        for (let x = 0; x < texbg.width; x += tilePx)
          tb.drawImage(sheet, TEX.col * TILE, TEX.row * TILE, TILE, TILE,
            x, y, tilePx, tilePx);
    }
```

In `render(t)`, replace the fallback background branch with:

```js
  if (texbg) ctx.drawImage(texbg, 0, 0);
  else if (!IS_COMPACT) { ctx.fillStyle = '#14121a'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
```

In `src/web/public/tv/embed.html`, replace its inline stage styles with:

```html
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
    #stage { display: block; width: 100%; height: 100%; background: transparent; image-rendering: pixelated; }
  </style>
```

- [ ] **Step 4: Verify compact geometry and full-TV preservation**

Run:

```bash
node --check src/web/public/tv/tv.js
npm test -- tests/anim.test.ts tests/web-tv.test.ts
npm run typecheck
```

Expected: all commands PASS. Confirm the full-TV assertions still find one shared EventSource, the 30% full-TV sidebar, and compact-only leaderboard suppression.

- [ ] **Step 5: Commit the geometry task**

```bash
git add src/web/public/tv/tv.js src/web/public/tv/embed.html tests/anim.test.ts tests/web-tv.test.ts
git commit -m "feat(tv): add tight transparent compact framing"
```

---

### Task 2: Clip and polish the compact encounter surface

**Files:**
- Modify: `tests/anim.test.ts:13-60`
- Modify: `src/web/public/tv/tv.js:258-310, 427-447, 526-548`

**Interfaces:**
- Consumes: Task 1's compact `panelX`, `panelY`, `panelW`, `panelH`, `scale`, and `COMPACT_STATUS` geometry.
- Produces: `roundedRectPath(x, y, w, h, radius): void`, `fillRoundedRect(x, y, w, h, radius, color): void`, and `withDungeonClip(draw): void`; compact actors/decor/floaters clipped to an 11-pixel room radius; compact pause and defeat surfaces bounded to the room; rounded, 86%-wide compact HP bar.

- [ ] **Step 1: Write failing compact-polish tests**

Append this test inside `describe('TV renderer bootstrap', ...)` in `tests/anim.test.ts`:

```ts
  it('clips the compact room and keeps status and pause treatment compact-only', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'web', 'public', 'tv', 'tv.js'),
      'utf8',
    );

    expect(source).toContain('function roundedRectPath(x, y, w, h, radius)');
    expect(source).toContain('function fillRoundedRect(x, y, w, h, radius, color)');
    expect(source).toContain('function withDungeonClip(draw)');
    expect(source).toContain('Math.round(11 * scale)');
    expect(source).toContain('withDungeonClip(() => {');
    expect(source).toContain('if (!IS_COMPACT) {');
    expect(source).toContain('const w = panelW * 0.86;');
    expect(source).toContain('const overlayX = IS_COMPACT ? panelX : 0;');
    expect(source).toContain('const overlayY = IS_COMPACT ? panelY : 0;');
    expect(source).toContain('const defeatX = IS_COMPACT ? panelX : fieldX;');
    expect(source).toContain('const defeatY = IS_COMPACT ? panelY : 0;');
  });
```

- [ ] **Step 2: Run the renderer test and verify it fails**

Run:

```bash
npm test -- tests/anim.test.ts
```

Expected: FAIL because the rounded-path helpers, compact clip, wider HP bar, and compact overlay bounds do not exist.

- [ ] **Step 3: Add rounded Canvas helpers**

Add these helpers immediately before `render(t)` in `src/web/public/tv/tv.js`:

```js
function roundedRectPath(x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRoundedRect(x, y, w, h, radius, color) {
  roundedRectPath(x, y, w, h, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

function withDungeonClip(draw) {
  if (!IS_COMPACT) { draw(); return; }
  ctx.save();
  roundedRectPath(panelX, panelY, panelW, panelH, Math.round(11 * scale));
  ctx.clip();
  draw();
  ctx.restore();
}
```

- [ ] **Step 4: Clip the compact room while preserving full-TV shadow behavior**

Replace the dungeon/actor portion of `render(t)` with this structure:

```js
  withDungeonClip(() => {
    if (bg) {
      if (IS_COMPACT) {
        ctx.drawImage(bg, panelX, panelY);
      } else {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.75)';
        ctx.shadowBlur = Math.round(tilePx * 0.45);
        ctx.shadowOffsetX = Math.round(tilePx * 0.10);
        ctx.shadowOffsetY = Math.round(tilePx * 0.20);
        ctx.drawImage(bg, panelX, panelY);
        ctx.restore();
      }
    }

    drawAnimDecor(t);
    if (state) {
      drawMonster(t);
      drawHeroes(t);
      drawFloaters(t);
    }
  });

  if (state) {
    drawHpBar();
    if (!IS_COMPACT) drawLeaderboard(t);
    if (state.paused) drawOverlay('The dungeon rests… awaiting adventurers');
    if (state.defeat) drawDefeat();
  }
```

This preserves the current full-TV field shadow while clipping compact backgrounds, actors, potion motes, debuff indicators, and floaters at the approved rounded room edge.

- [ ] **Step 5: Round and widen the compact HP bar**

Replace `drawHpBar()` with:

```js
function drawHpBar() {
  const e = state.encounter; if (!e) return;
  if (!IS_COMPACT) {
    const w = panelW * 0.6, h = Math.max(16, Math.round(tilePx * 0.34));
    const x = panelX + (panelW - w) / 2;
    const y = panelY - h - Math.round(tilePx * 0.5);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = Math.round(h * 0.6); ctx.shadowOffsetY = Math.round(h * 0.3);
    ctx.fillStyle = '#180a0a'; ctx.fillRect(x - 4, y - 3, w + 8, h + 6);
    ctx.restore();
    ctx.fillStyle = '#3a0d0d'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#d23b3b'; ctx.fillRect(x, y, w * Math.max(0, e.hp / e.maxHp), h);
    const nameSize = Math.max(14, Math.round(h * 1.15));
    shadowText(e.name, panelX + panelW / 2, y - Math.round(h * 0.55),
      `bold ${nameSize}px system-ui`, '#f2e4e4', 'center');
    return;
  }

  const w = panelW * 0.86;
  const h = Math.max(16, Math.round(tilePx * 0.34));
  const x = panelX + (panelW - w) / 2;
  const y = panelY - h - Math.round(tilePx * 0.5);
  const radius = Math.max(2, Math.round(h / 2));
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = Math.round(h * 0.6);
  ctx.shadowOffsetY = Math.round(h * 0.3);
  fillRoundedRect(x - 4, y - 3, w + 8, h + 6, radius + 3, '#180a0a');
  ctx.restore();
  fillRoundedRect(x, y, w, h, radius, '#3a0d0d');
  const hpW = w * Math.max(0, e.hp / e.maxHp);
  if (hpW > 0) fillRoundedRect(x, y, hpW, h, Math.min(radius, hpW / 2), '#d23b3b');
  const nameSize = Math.max(14, Math.round(h * 1.15));
  shadowText(e.name, panelX + panelW / 2, y - Math.round(h * 0.55),
    `bold ${nameSize}px system-ui`, '#f2e4e4', 'center');
}
```

- [ ] **Step 6: Bound the compact resting overlay to the rounded room**

Replace `drawOverlay(text)` with:

```js
function drawOverlay(text) {
  const overlayX = IS_COMPACT ? panelX : 0;
  const overlayY = IS_COMPACT ? panelY : 0;
  const overlayW = IS_COMPACT ? panelW : canvas.width;
  const overlayH = IS_COMPACT ? panelH : canvas.height;
  ctx.save();
  if (IS_COMPACT) {
    roundedRectPath(panelX, panelY, panelW, panelH, Math.round(11 * scale));
    ctx.clip();
  }
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000b';
  ctx.fillRect(overlayX, overlayY, overlayW, overlayH);
  ctx.fillStyle = '#e8c96a';
  ctx.textAlign = 'center';
  ctx.font = `${Math.round(20 * scale)}px system-ui`;
  ctx.fillText(text, overlayX + overlayW / 2, overlayY + overlayH / 2);
  ctx.restore();
}
```

- [ ] **Step 7: Bound the compact defeat surface to the room**

Before verification, replace the opening geometry in `drawDefeat()` so compact
defeat content is calculated within the room while full TV retains its existing
field bounds:

```js
function drawDefeat() {
  const d = state.defeat;
  const defeatX = IS_COMPACT ? panelX : fieldX;
  const defeatY = IS_COMPACT ? panelY : 0;
  const defeatW = IS_COMPACT ? panelW : canvas.width - fieldX;
  const defeatH = IS_COMPACT ? panelH : canvas.height;
  const w = defeatW * 0.7, h = defeatH * 0.7;
  const x = defeatX + (defeatW - w) / 2;
  const y = defeatY + (defeatH - h) / 2;
```

Keep the rest of `drawDefeat()` unchanged after the existing `ctx.fillStyle =
'#1a1022ee'` line. This is a replacement of the function's opening lines, not a
second `drawDefeat()` declaration.

- [ ] **Step 8: Verify the compact polish and shared renderer**

Run:

```bash
node --check src/web/public/tv/tv.js
npm test -- tests/anim.test.ts tests/web-tv.test.ts
npm run typecheck
```

Expected: all commands PASS. The shared EventSource count remains one, and full mode still executes the existing panel-shadow and leaderboard branches.

- [ ] **Step 9: Commit the compact rendering polish**

```bash
git add src/web/public/tv/tv.js tests/anim.test.ts
git commit -m "style(tv): polish the compact encounter surface"
```

---

### Task 3: Reshape the player-hub dashboard

**Files:**
- Modify: `tests/web-character.test.ts:36-55`
- Modify: `tests/player-hub-css.test.ts:10-30`
- Modify: `src/web/views/character-live.ejs:1-38`
- Modify: `src/web/public/player-hub.css:43-62, 115-130`

**Interfaces:**
- Consumes: Task 1's transparent 6:5 `/tv/embed`; existing `#hub-leaders` and six `#hub-today-*` update targets.
- Produces: direct `.hub-live-grid` children `.hub-dungeon`, `.hub-fight-leaders`, and `.hub-today-panel`; desktop grid areas `dungeon leaders / today today`; 480-pixel dungeon column; room-only bottom-right shadow; six-column Today strip; stacked narrow layout.

- [ ] **Step 1: Write failing markup and CSS tests**

In the main authenticated character test in `tests/web-character.test.ts`, replace the current `.hub-live-side` assertions with:

```ts
    expect(res.text.match(/class="hub-dungeon"/g)).toHaveLength(1);
    expect(res.text.match(/class="hub-subpanel hub-fight-leaders"/g)).toHaveLength(1);
    expect(res.text.match(/class="hub-today-panel"/g)).toHaveLength(1);
    const dungeonIndex = res.text.indexOf('class="hub-dungeon"');
    const leadersIndex = res.text.indexOf('class="hub-subpanel hub-fight-leaders"');
    const todayIndex = res.text.indexOf('class="hub-today-panel"');
    expect(dungeonIndex).toBeLessThan(leadersIndex);
    expect(leadersIndex).toBeLessThan(todayIndex);
    expect(res.text).not.toContain('class="hub-live-side"');
    expect(res.text).toContain('<span>Active time</span>');
```

Replace the old full-width dungeon test in `tests/player-hub-css.test.ts` with:

```ts
  it('lays out the tight dungeon beside leaders with Today across the bottom', () => {
    expect(css).toMatch(/\.hub-live-grid\{[^}]*grid-template-columns:\s*minmax\(0,480px\) minmax\(240px,1fr\)/);
    expect(css).toMatch(/\.hub-live-grid\{[^}]*grid-template-areas:\s*"dungeon leaders" "today today"/);
    expect(css).toMatch(/\.hub-dungeon\{[^}]*aspect-ratio:\s*6\/5/);
    expect(css).toMatch(/\.hub-dungeon\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.hub-dungeon::before\{[^}]*top:\s*10%/);
    expect(css).toMatch(/\.hub-dungeon::before\{[^}]*8px 10px 20px -11px/);
    expect(css).toMatch(/\.hub-fight-leaders\{[^}]*grid-area:\s*leaders/);
    expect(css).toMatch(/\.hub-today-panel\{[^}]*grid-area:\s*today/);
    expect(css).toMatch(/\.hub-today\{[^}]*grid-template-columns:\s*repeat\(6,minmax\(0,1fr\)\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*grid-template-areas:\s*"dungeon" "leaders" "today"/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-today\{[^}]*repeat\(3,minmax\(0,1fr\)\)/);
    expect(css).toMatch(/@media \(max-width:\s*480px\)[\s\S]*\.hub-today\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
    expect(css).not.toContain('.hub-live-side');
  });
```

- [ ] **Step 2: Run the character/CSS tests and verify they fail**

Run:

```bash
npm test -- tests/web-character.test.ts tests/player-hub-css.test.ts
```

Expected: FAIL because the old DOM groups Fight Leaders and Today in `.hub-live-side`, the dungeon is full-width 16:9, and Today has only two columns.

- [ ] **Step 3: Restructure the Live Dungeon partial**

Replace the `.hub-live-grid` block in `src/web/views/character-live.ejs` with:

```ejs
<div class="hub-live-grid">
  <div class="hub-dungeon">
    <iframe class="hub-dungeon-frame" src="/tv/embed" title="Live ClaudeRPG dungeon"></iframe>
  </div>

  <section class="hub-subpanel hub-fight-leaders" aria-labelledby="hub-leaders-title">
    <h3 id="hub-leaders-title">Fight Leaders</h3>
    <div id="hub-leaders">
      <% if (currentFight.leaders.length > 0) { %>
        <ol class="hub-leaders">
          <% currentFight.leaders.forEach(function (leader, index) { %>
            <li><span class="hub-leaders-rank">#<%= index + 1 %></span><span class="hub-leaders-name"><%= leader.name %></span><span class="hub-leaders-damage"><%= leader.damage.toLocaleString('en-US') %> dmg</span></li>
          <% }); %>
        </ol>
      <% } else { %>
        <p class="hub-empty-line">The damage ledger is waiting for its first mark.</p>
      <% } %>
    </div>
  </section>

  <section class="hub-today-panel" aria-labelledby="hub-today-title">
    <h3 id="hub-today-title">Today</h3>
    <div class="hub-today">
      <div class="hub-today-card"><span>Effective tokens</span><strong id="hub-today-tokens"><%= today.effectiveTokens.toLocaleString('en-US') %></strong></div>
      <div class="hub-today-card"><span>Damage</span><strong id="hub-today-damage"><%= today.damage.toLocaleString('en-US') %></strong></div>
      <div class="hub-today-card"><span>Fight rank</span><strong id="hub-today-rank"><%= today.fightRank == null ? '—' : '#' + today.fightRank %></strong></div>
      <div class="hub-today-card"><span>Gold earned</span><strong id="hub-today-gold"><%= today.goldEarned.toLocaleString('en-US') %>g</strong></div>
      <div class="hub-today-card"><span>Active time</span><strong id="hub-today-active"><%= Math.floor(today.combatActiveMs / 3600000) %>h <%= Math.floor((today.combatActiveMs % 3600000) / 60000) %>m</strong></div>
      <div class="hub-today-card"><span>Potions used</span><strong id="hub-today-potions"><%= today.potionsUsed %></strong></div>
    </div>
  </section>
</div>
```

Do not change the panel heading or **Watch full screen** link above this block.

- [ ] **Step 4: Implement the approved desktop hierarchy**

Replace the current Live Dungeon CSS block in `src/web/public/player-hub.css` with:

```css
.hub-live-grid{display:grid;grid-template-columns:minmax(0,480px) minmax(240px,1fr);grid-template-areas:"dungeon leaders" "today today";gap:22px 20px;align-items:stretch}
.hub-dungeon{grid-area:dungeon;position:relative;isolation:isolate;min-width:0;width:min(480px,100%);aspect-ratio:6/5;overflow:visible;border:0;background:transparent}
.hub-dungeon::before{content:"";position:absolute;z-index:-1;left:0;right:0;top:10%;bottom:0;border-radius:11px;box-shadow:8px 10px 20px -11px #000e,3px 4px 8px -5px #000f,0 0 0 2px #08040cf0;pointer-events:none}
.hub-dungeon-frame{position:relative;z-index:1;display:block;width:100%;height:100%;aspect-ratio:6/5;border:0;background:transparent;image-rendering:pixelated}
.hub-subpanel{padding:13px;border:1px solid #3b2d48;border-radius:11px;background:linear-gradient(180deg,#191024d1,#0c0812db)}
.hub-fight-leaders{grid-area:leaders;min-width:0}
.hub-subpanel h3,.hub-today-panel h3{margin:0 0 10px;color:#cdb767;font:850 11px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}
.hub-leaders{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.hub-leaders li{display:grid;grid-template-columns:25px minmax(0,1fr) auto;gap:7px;align-items:center;padding:8px 7px;border-bottom:1px solid #ffffff07;font-size:12px}
.hub-leaders li:last-child{border-bottom:0}
.hub-leaders-rank{color:#c7ac56;font-weight:850}
.hub-leaders-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#baadbf}
.hub-leaders-damage{color:#776b80;font-variant-numeric:tabular-nums}
.hub-empty-line{margin:0;color:var(--muted);font-size:12px}
.hub-today-panel{grid-area:today;min-width:0}
.hub-today{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;overflow:hidden;border:1px solid #34283f;border-radius:9px;background:#34283f}
.hub-today-card{min-width:0;padding:10px 9px;background:linear-gradient(180deg,#140d1dd1,#0b0710e0)}
.hub-today-card span{display:block;overflow:hidden;color:#746879;font-size:9px;letter-spacing:.06em;text-overflow:ellipsis;text-transform:uppercase;white-space:nowrap}
.hub-today-card strong{display:block;margin-top:4px;color:#c4b9ca;font-size:15px;overflow-wrap:anywhere}
```

- [ ] **Step 5: Implement the approved responsive stack**

Inside the existing `@media (max-width:760px)` block, replace the old Live Dungeon rules with:

```css
  .hub-live-grid{grid-template-columns:1fr;grid-template-areas:"dungeon" "leaders" "today"}
  .hub-dungeon{justify-self:center;width:min(480px,100%)}
  .hub-today{grid-template-columns:repeat(3,minmax(0,1fr))}
```

Keep `.hub-inventory-layout{grid-template-columns:1fr}` as a separate rule in that breakpoint. Remove the obsolete `.hub-live-side` rule.

Inside the existing `@media (max-width:480px)` block, add:

```css
  .hub-today{grid-template-columns:repeat(2,minmax(0,1fr))}
```

- [ ] **Step 6: Verify markup, layout contracts, and unchanged polling IDs**

Run:

```bash
npm test -- tests/web-character.test.ts tests/player-hub-css.test.ts tests/player-hub-client.test.ts
npm run typecheck
```

Expected: all commands PASS. `player-hub-client.test.ts` continues to find all six Today IDs and `#hub-leaders` without client-code changes.

- [ ] **Step 7: Commit the player-hub layout**

```bash
git add src/web/views/character-live.ejs src/web/public/player-hub.css tests/web-character.test.ts tests/player-hub-css.test.ts
git commit -m "style(player): condense the live dungeon dashboard"
```

---

### Task 4: Update the review contract and verify the finished dashboard

**Files:**
- Modify: `docs/testing/timed-consumables-local.md:55-80`
- Verify: `src/web/public/tv/tv.js`
- Verify: `src/web/public/tv/embed.html`
- Verify: `src/web/views/character-live.ejs`
- Verify: `src/web/public/player-hub.css`

**Interfaces:**
- Consumes: Tasks 1–3's tight renderer and dashboard layout.
- Produces: an updated local-review checklist and recorded evidence that full TV, compact active/resting states, effects, defeat, and responsive layouts remain correct.

- [ ] **Step 1: Update the local review checklist**

In `docs/testing/timed-consumables-local.md`, replace:

```markdown
- Confirm the compact dungeon uses the full panel width and Fight Leaders / Today split evenly beneath it.
```

with:

```markdown
- Confirm the compact renderer has no TV backdrop: only the centered monster name/rounded HP strip and the complete rounded 20×15 dungeon are visible.
- At desktop width, confirm the 480×400 dungeon sits beside Fight Leaders and Today spans the full row beneath both.
- Confirm the dungeon has only a restrained bottom-right shadow; there is no four-sided halo or ambient glow.
- At narrow widths, confirm the order is dungeon, Fight Leaders, Today; Today becomes 3×2 and then 2×3 without overflow.
```

- [ ] **Step 2: Run syntax, targeted, full, and type verification**

Run:

```bash
node --check src/web/public/tv/tv.js
npm test -- tests/anim.test.ts tests/web-tv.test.ts tests/web-character.test.ts tests/player-hub-css.test.ts tests/player-hub-client.test.ts tests/potion-fx.test.ts
npm test
npm run typecheck
```

Expected: every command PASS with no skipped or newly failing test.

- [ ] **Step 3: Start a fresh disposable visual-review fixture**

Create a unique temporary directory and seed a new database inside it:

```bash
DASHBOARD_REVIEW_DIR="$(mktemp -d /private/tmp/clauderpg-live-dashboard.XXXXXX)"
PUBLIC_URL=http://localhost:8120 npm exec tsx tools/seed-potion-demo.ts -- "$DASHBOARD_REVIEW_DIR/demo.db"
```

Start the app from the repository root using only that disposable database:

```bash
DB_PATH="$DASHBOARD_REVIEW_DIR/demo.db" \
PORT=8120 \
PUBLIC_URL=http://localhost:8120 \
SPRITES_DIR=/Users/carp/Code/ClaudeRPG/assets/oryx_16-bit_fantasy_1.1/Sliced \
OFFICE_TIME_ZONE=America/New_York \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=potion-demo-only \
SESSION_SECRET=potion-demo-local-session \
npm start
```

Do not substitute the production database or production port.

- [ ] **Step 4: Perform the active/resting and animation review**

In the browser, open the seeded character URL ending in `local-potion-demo-3` and the seeded `/tv` URL. Verify:

1. `/tv` retains its tiled backdrop, 30% rotating leaderboard, full viewport, and cursor-hidden kiosk behavior.
2. The player-hub iframe has a transparent 6:5 stage, centered name, rounded wide HP bar, full 20×15 room, 11-pixel corner crop, and only the small bottom-right shadow.
3. The dungeon and Fight Leaders are side by side, with the six-cell Today strip below.
4. At least two monster and player A/B cycles show matching frames.
5. Gold-only, Damage-only, dual-potion, debuff-only, and potion-plus-debuff characters retain their approved effects and do not clip incorrectly at ordinary room positions.
6. After the disposable demo idles, the resting overlay dims only the rounded room; the name/HP status area remains outside the room overlay.

- [ ] **Step 5: Perform responsive and transition review**

At desktop width and representative 760-, 480-, and 390-pixel widths, verify:

1. desktop keeps the exact 480-pixel dungeon column and a readable flexible leaderboard;
2. the narrow layout stacks dungeon, Fight Leaders, Today;
3. the complete dungeon scales to fit without horizontal scrolling or additional row cropping;
4. Today becomes 3×2 and then 2×3 with no label/value overflow;
5. the Fight Leaders and Today text remains readable while visually quieter than the dungeon; and
6. the defeat overlay and next encounter remain contained and legible in the compact stage.

If any check fails, add one focused failing automated test to the owning test file before changing implementation, then rerun Steps 2, 4, and 5.

- [ ] **Step 6: Commit the updated review contract**

```bash
git add docs/testing/timed-consumables-local.md
git commit -m "docs(player): update live dungeon review checklist"
```

---

## Completion Criteria

- `/tv` is unchanged in layout and behavior.
- `/tv/embed` shares the same SSE/animation renderer but has transparent tight compact framing.
- Compact mode draws the complete 20 × 15 dungeon beneath a 40-pixel status area in a 480 × 400 composition.
- The compact room has approved 11-pixel corner clipping, a rounded wide HP bar, and a room-bounded resting overlay.
- The player hub places the dungeon beside Fight Leaders and Today across the bottom.
- The room has only the approved small bottom-right shadow; supporting data is quieter but readable.
- Narrow layouts stack in the approved order and reflow Today to 3×2 then 2×3.
- Targeted tests, the full test suite, JavaScript syntax check, and TypeScript typecheck all pass.
- Active, resting, effect, defeat, full-TV, and responsive visual checks pass against a disposable local database.
- No Pi or production system is changed.

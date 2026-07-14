# Dungeon Shell + Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll the landing page's torch-lit dungeon design language across every web page via a reusable shell + shared stylesheet, and fully redesign the four player-facing pages.

**Architecture:** Extract the reusable frame/tokens/primitives out of `landing.css` into a new shared `dungeon.css`. Rewrite `layout.ejs` into a "dungeon shell" (walls, torches, gutter loot rails, themed header/footer, content panel) that every `renderPage` view inherits, with a `full`/`lite` frame variant. Refactor landing onto the shell, then redesign the player pages using the shared primitives.

**Tech Stack:** Express + EJS server-rendered views, plain CSS, Vitest + supertest for route tests. Node 26, tsx/ESM.

## Global Constraints

- Node 26 + better-sqlite3 v12; tests run under Vitest (`npx vitest run`).
- Express routes that are `async` MUST be wrapped in `asyncHandler` (existing rule) — no route changes here add async handlers, but keep the rule if touching handlers.
- Static assets are served from `src/web/public/` at `/static/…`. Reuse the existing landing assets under `/static/landing/` (`tex.png`, `moss_wall.png`, `torch_a.png`, `torch_b.png`, and the loot/icon PNGs) — do NOT add or move assets.
- `renderPage(view, data)` wraps a view in `layout.ejs`; `renderStandalone(view, data)` renders a full-page view directly.
- Single dark theme only (no light mode). Design tokens live in `:root` in `dungeon.css` and are the single source of truth.
- Preserve every string/selector currently asserted by tests (called out per task). All existing route tests use `toContain`, so added shell markup is safe as long as asserted substrings remain.
- Commit after each task with a conventional-commit message. Branch is `feat/dungeon-shell-design-language` (already created).

---

### Task 1: Dungeon shell foundation (`dungeon.css` + `layout.ejs` + `renderPage`)

Builds the reusable shell. After this task every `renderPage` page renders inside the torch-lit frame (full variant by default).

**Files:**
- Create: `src/web/public/dungeon.css`
- Modify: `src/web/views/layout.ejs` (full rewrite)
- Modify: `src/web/app.ts` (`renderPage` — thread `frame` + `styles`)
- Test: `tests/web-shell.test.ts` (create)

**Interfaces:**
- Produces: `renderPage(view, data)` now forwards `frame: data.frame ?? 'full'` and `styles: data.styles ?? []` to `layout.ejs`. `layout.ejs` renders `class="frame-lite"` on `<body>` when `frame === 'lite'`, links `/static/dungeon.css` then each `/static/<s>` in `styles`, and emits `.wall-l`/`.wall-r` always plus `.loot-rail` only when frame is not lite.
- Consumes: existing landing assets at `/static/landing/*.png`.

- [ ] **Step 1: Write the failing test**

Create `tests/web-shell.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, config: loadConfig({}) });
});

describe('dungeon shell', () => {
  it('wraps renderPage views in the torch-lit frame and links dungeon.css', async () => {
    const res = await request(app).get('/register');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/static/dungeon.css"');
    expect(res.text).toContain('class="wall wall-l"');
    expect(res.text).toContain('class="wall wall-r"');
  });

  it('full-frame pages render the gutter loot rails', async () => {
    const res = await request(app).get('/register');
    expect(res.text).toContain('class="loot-rail left"');
    expect(res.text).toContain('class="loot-rail right"');
    expect(res.text).not.toContain('frame-lite');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/web-shell.test.ts`
Expected: FAIL — `/register` HTML does not yet contain `dungeon.css` / `wall-l` / `loot-rail`.

- [ ] **Step 3: Create `src/web/public/dungeon.css`**

```css
/* ClaudeRPG shared dungeon shell + design system. Single dark theme. */
:root{
  --panel:#160f20;--panel2:#1c1329;--card:#221631;--line:#2e2140;
  --gold:#e8c96a;--gold2:#f4dd93;--gold-dim:#a5863f;
  --red:#e0483f;--red-track:#3c1618;--live:#7bd88f;
  --ink:#c9bce0;--head:#f3ecdf;--muted:#8b7ea6;--wall:66px;
}
*{box-sizing:border-box} html{scroll-behavior:smooth}
body{margin:0;position:relative;color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden;
  background:
   radial-gradient(340px 300px at var(--wall) 60px, rgba(255,150,60,.20), transparent 70%),
   radial-gradient(340px 300px at calc(100% - var(--wall)) 60px, rgba(255,150,60,.20), transparent 70%),
   radial-gradient(340px 300px at var(--wall) calc(100% - 60px), rgba(255,150,60,.16), transparent 70%),
   radial-gradient(340px 300px at calc(100% - var(--wall)) calc(100% - 60px), rgba(255,150,60,.16), transparent 70%),
   radial-gradient(1100px 700px at 50% 0%, #241833 0%, transparent 55%),
   url('/static/landing/tex.png');
  background-color:#0c0912;background-size:auto,auto,auto,auto,auto,48px 48px;background-attachment:fixed;}
body.frame-lite{
  background:
   radial-gradient(300px 260px at var(--wall) 60px, rgba(255,150,60,.10), transparent 70%),
   radial-gradient(300px 260px at calc(100% - var(--wall)) 60px, rgba(255,150,60,.10), transparent 70%),
   radial-gradient(1100px 700px at 50% 0%, #201530 0%, transparent 55%),
   url('/static/landing/tex.png');
  background-color:#0c0912;background-size:auto,auto,auto,48px 48px;background-attachment:fixed;}
.px{image-rendering:pixelated;display:block}
a{color:inherit;text-decoration:none}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* frame: walls + torches */
.wall{position:fixed;top:0;bottom:0;width:var(--wall);z-index:1;
  background:url('/static/landing/moss_wall.png');background-size:var(--wall) var(--wall);
  image-rendering:pixelated;pointer-events:none}
.wall-l{left:0;box-shadow:inset -20px 0 28px -10px #000,10px 0 34px -6px #000b}
.wall-r{right:0;box-shadow:inset 20px 0 28px -10px #000,-10px 0 34px -6px #000b}
.sconce{position:absolute;left:50%;transform:translateX(-50%);width:48px;height:48px;
  filter:drop-shadow(0 0 24px rgba(255,150,60,.6))}
.sconce.top{top:64px} .sconce.bot{bottom:44px}
.sconce img{position:absolute;inset:0;width:48px;height:48px}
.t-b{opacity:0;animation:flick 520ms steps(1) infinite}
.t-a{animation:flickA 520ms steps(1) infinite}
@keyframes flick{50%{opacity:1}} @keyframes flickA{50%{opacity:0}}
body.frame-lite .sconce{filter:drop-shadow(0 0 16px rgba(255,150,60,.4))}

/* gutter loot rails — between wall and centered content, never behind content */
.loot-rail{position:fixed;top:0;bottom:0;width:calc((100vw - 1120px)/2 - var(--wall));
  z-index:1;pointer-events:none;overflow:hidden}
.loot-rail.left{left:var(--wall)} .loot-rail.right{right:var(--wall)}
.loot{position:absolute;top:var(--t);width:calc(30px*var(--s));height:calc(30px*var(--s));
  opacity:.6;animation:bob var(--d) ease-in-out infinite}
.loot.l{left:var(--x)} .loot.r{right:var(--x)}
.loot img{width:100%;height:100%;filter:drop-shadow(0 4px 7px rgba(0,0,0,.55))}
@keyframes bob{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-16px) rotate(2deg)}}
@media (max-width:1180px){.loot-rail{display:none}}
body.frame-lite .loot-rail{display:none}

/* shell chrome: header bar + content + footer */
.bar,main,.foot{position:relative;z-index:2}
.bar{display:flex;align-items:center;justify-content:space-between;max-width:1120px;margin:0 auto;padding:22px 34px}
.brand{display:flex;align-items:center;gap:12px;font-weight:850;letter-spacing:.13em;font-size:21px;color:var(--head)}
.brand img{width:32px;height:32px} .brand b{color:var(--gold)}
.bar nav{display:flex;gap:20px;font-size:14px;color:var(--muted);align-items:center;flex-wrap:wrap}
.bar nav a:hover{color:var(--gold)} .bar nav .mini{opacity:.6;font-size:13px}
main{max-width:1120px;margin:0 auto;padding:8px 34px 40px}
body.frame-lite main{max-width:1180px}
.foot{max-width:1120px;margin:20px auto 34px;padding:20px 34px 0;border-top:1px solid var(--line);
  display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;font-size:12.5px;color:var(--muted)}
.foot .si{width:15px;height:15px;display:inline-block;vertical-align:-3px;margin-right:5px}

/* shared primitives */
.panel{background:linear-gradient(180deg,var(--card),var(--panel));border:1px solid var(--line);
  border-radius:16px;padding:22px;margin-bottom:20px;
  box-shadow:0 30px 70px -30px #000,inset 0 1px 0 #ffffff0d}
h1,h2,h3{color:var(--head);letter-spacing:-.01em;margin:0 0 14px;font-weight:800}
h1{font-size:clamp(26px,4vw,40px);font-weight:850} h2{font-size:24px} h3{font-size:18px}
p{margin:0 0 12px}
.sec-head{margin-bottom:24px}
label{display:block;margin:14px 0 6px;color:var(--muted);font-size:14px}
input,select,textarea{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);
  background:#120d1a;color:var(--head);font-size:15px;font-family:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--gold-dim);box-shadow:0 0 0 3px rgba(232,201,106,.12)}
.btn,button{display:inline-flex;align-items:center;gap:9px;padding:12px 20px;border-radius:10px;
  font-weight:750;font-size:15px;border:1px solid transparent;cursor:pointer;transition:transform .12s,box-shadow .12s;
  background:linear-gradient(180deg,var(--gold2),var(--gold));color:#1a1206;
  box-shadow:0 10px 24px -10px rgba(232,201,106,.6),inset 0 1px 0 #fff6}
.btn:hover,button:hover{transform:translateY(-2px)}
a.btn{text-decoration:none}
.btn-ghost{background:#ffffff0d;border-color:var(--line);color:var(--head);box-shadow:none}
.btn-ghost:hover{border-color:var(--gold-dim);color:var(--gold)}
.btn-danger{background:linear-gradient(180deg,#e8675c,var(--red));color:#fff;box-shadow:0 10px 24px -12px rgba(224,72,63,.6)}
pre{background:#0c0912ee;border:1px solid var(--line);padding:14px 16px;border-radius:12px;overflow-x:auto;color:#cfe4d2;font-size:13px}
code{color:var(--gold2)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
.flash{padding:11px 15px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);margin-bottom:16px}
.err{color:#ff9b9b;border-color:rgba(224,72,63,.4)}

@media (prefers-reduced-motion:reduce){*{animation:none!important}.loot{opacity:.5}}
```

- [ ] **Step 4: Rewrite `src/web/views/layout.ejs`**

```ejs
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title><%= title %> — ClaudeRPG</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>%E2%9A%94%EF%B8%8F</text></svg>" />
  <link rel="stylesheet" href="/static/dungeon.css" />
  <% (typeof styles !== 'undefined' ? styles : []).forEach(function (s) { %><link rel="stylesheet" href="/static/<%= s %>" />
  <% }); %>
</head>
<% var _frame = (typeof frame !== 'undefined' ? frame : 'full'); %>
<body class="<%= _frame === 'lite' ? 'frame-lite' : '' %>">
  <div class="wall wall-l"><span class="sconce top"><img class="px t-a" src="/static/landing/torch_a.png" alt=""><img class="px t-b" src="/static/landing/torch_b.png" alt=""></span><span class="sconce bot"><img class="px t-a" src="/static/landing/torch_a.png" alt=""><img class="px t-b" src="/static/landing/torch_b.png" alt=""></span></div>
  <div class="wall wall-r"><span class="sconce top"><img class="px t-a" src="/static/landing/torch_a.png" alt=""><img class="px t-b" src="/static/landing/torch_b.png" alt=""></span><span class="sconce bot"><img class="px t-a" src="/static/landing/torch_a.png" alt=""><img class="px t-b" src="/static/landing/torch_b.png" alt=""></span></div>
  <% if (_frame !== 'lite') { %>
  <% var LOOT_L=[["orb_cyan","9%","9","1.6"],["book","44%","10","1.9"],["key","72%","11","1.3"],["amulet","28%","12","1.4"],["crown","88%","13","1.8"]]; %>
  <div class="loot-rail left" aria-hidden="true"><% LOOT_L.forEach(function (f, i) { %><span class="loot l" style="--x:<%= 10 + (i % 3) * 22 %>px;--t:<%= f[1] %>;--d:<%= f[2] %>s;--s:<%= f[3] %>"><img class="px" src="/static/landing/<%= f[0] %>.png" alt=""></span><% }); %></div>
  <% var LOOT_R=[["coins","13%","10","1.9"],["scroll","33%","11","1.3"],["gem_red","55%","13","1.4"],["ring_gold","74%","10.5","1.2"],["potion","90%","11","1.6"]]; %>
  <div class="loot-rail right" aria-hidden="true"><% LOOT_R.forEach(function (f, i) { %><span class="loot r" style="--x:<%= 12 + (i % 3) * 20 %>px;--t:<%= f[1] %>;--d:<%= f[2] %>s;--s:<%= f[3] %>"><img class="px" src="/static/landing/<%= f[0] %>.png" alt=""></span><% }); %></div>
  <% } %>

  <header class="bar">
    <a class="brand" href="/"><img class="px" src="/static/landing/sword.png" alt=""><span>CLAUDE<b>RPG</b></span></a>
    <nav><a href="/">Home</a><a href="/tv">Watch the TV</a><a href="/register">Register</a><a href="/character">Log in</a><a class="mini" href="/admin">Admin</a></nav>
  </header>

  <main><%- body %></main>

  <footer class="foot"><span><img class="px si" src="/static/landing/skull.png" alt=""> Runs on the office TV · your usage, gamified</span><span>Pixel art &copy; Oryx Design Lab</span></footer>
</body>
</html>
```

- [ ] **Step 5: Update `renderPage` in `src/web/app.ts`**

Replace the `renderPage` body so it threads `frame` and `styles` (currently it forwards only `title` + `body`):

```ts
// Renders a page template, wraps it in layout.ejs, returns HTML.
export async function renderPage(
  view: string,
  data: Record<string, unknown>,
): Promise<string> {
  const body = await ejs.renderFile(path.join(VIEWS, `${view}.ejs`), data);
  return ejs.renderFile(path.join(VIEWS, 'layout.ejs'), {
    title: data.title ?? 'ClaudeRPG',
    body,
    frame: data.frame ?? 'full',
    styles: data.styles ?? [],
  });
}
```

- [ ] **Step 6: Run the new test and the full suite**

Run: `npx vitest run tests/web-shell.test.ts`
Expected: PASS.

Run: `npx vitest run`
Expected: PASS — existing route tests still pass (they use `toContain`; shell markup is additive). If `web-registration`/`web-character`/`web-admin-*`/`web-catalog`/`web-dungeon-preview` fail, a previously-asserted substring was lost — restore it before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/web/public/dungeon.css src/web/views/layout.ejs src/web/app.ts tests/web-shell.test.ts
git commit -m "feat(web): dungeon shell — shared dungeon.css + layout frame + renderPage variant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Lite frame for admin + dev-tool pages

Dense pages (admin forms/tables, catalog grid, dungeon preview) opt into the `lite` variant — walls + background, dimmer glow, no loot, wider content column.

**Files:**
- Modify: `src/web/routes/admin.ts` (each `renderPage(...)` call)
- Modify: `src/web/routes/catalog.ts` (the `renderPage(...)` call)
- Modify: `src/web/routes/dungeon-preview.ts` (the `renderPage(...)` call)
- Test: `tests/web-shell.test.ts` (add cases)

**Interfaces:**
- Consumes: `renderPage` frame threading from Task 1.
- Produces: admin/catalog/dungeon-preview responses carry `class="frame-lite"` on `<body>` and omit loot rails.

- [ ] **Step 1: Add failing tests to `tests/web-shell.test.ts`**

```ts
describe('lite frame', () => {
  it('the catalog uses the lite frame (no loot rails)', async () => {
    // catalog requires spritesDir; loadConfig({}) provides the default asset dir
    const res = await request(app).get('/catalog');
    if (res.status === 200) {
      expect(res.text).toContain('class="frame-lite"');
      expect(res.text).not.toContain('class="loot-rail left"');
    }
  });

  it('the admin login page uses the lite frame', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="frame-lite"');
    expect(res.text).not.toContain('class="loot-rail left"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/web-shell.test.ts -t "lite frame"`
Expected: FAIL — admin/catalog still render the full frame (no `frame-lite`).

- [ ] **Step 3: Add `frame: 'lite'` to the admin renders**

In `src/web/routes/admin.ts`, add `frame: 'lite'` to the data object of every `renderPage(...)` call. There are renders for `admin-login` (two: the GET and the 401 re-render), `admin-players`, `admin-player-edit`, and `admin-settings`. Example for the login GET:

```ts
res.send(await renderPage('admin-login', { title: 'Admin Login', frame: 'lite' }));
```

And the 401 re-render:

```ts
await renderPage('admin-login', { title: 'Admin Login', frame: 'lite', error: '...' })
```

Apply the same `frame: 'lite'` addition to the `admin-players`, `admin-player-edit`, and `admin-settings` render calls (keep all their existing keys).

- [ ] **Step 4: Add `frame: 'lite'` to catalog and dungeon-preview**

`src/web/routes/catalog.ts`:

```ts
res.send(await renderPage('catalog', { title: 'Sprite Catalog', frame: 'lite', view }));
```

`src/web/routes/dungeon-preview.ts` — add `frame: 'lite'` to the render data object (keep existing keys):

```ts
await renderPage('dungeon-preview', {
  title: 'Dungeon Preview',
  frame: 'lite',
  /* ...existing keys... */
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/web-shell.test.ts`
Expected: PASS.

Run: `npx vitest run tests/web-admin-players.test.ts tests/web-admin-settings.test.ts tests/web-catalog.test.ts tests/web-dungeon-preview.test.ts`
Expected: PASS — content assertions unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/admin.ts src/web/routes/catalog.ts src/web/routes/dungeon-preview.ts tests/web-shell.test.ts
git commit -m "feat(web): lite dungeon frame for admin + dev-tool pages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Refactor landing onto the shell

Landing stops being standalone: it becomes a `renderPage` view supplying only its body sections; the shell owns the walls/torches/loot/header/footer. `landing.css` shrinks to landing-unique rules and is linked via the per-page `styles` hook.

**Files:**
- Modify: `src/web/views/landing.ejs` (strip to body sections)
- Modify: `src/web/public/landing.css` (delete rules now in `dungeon.css`)
- Modify: `src/web/routes/registration.ts` (landing route → `renderPage`)
- Modify: `src/web/app.ts` (remove `renderStandalone` if now unused — verify first)
- Test: `tests/web-registration.test.ts` (add shell-marker assertion; existing cases must still pass)

**Interfaces:**
- Consumes: `renderPage` `styles`/`frame` from Task 1.
- Produces: `GET /` rendered through the shell with `styles: ['landing.css']`, `frame: 'full'`.

- [ ] **Step 1: Add a failing assertion to `tests/web-registration.test.ts`**

In the existing `'GET / is the landing page…'` test, add:

```ts
    expect(res.text).toContain('href="/static/dungeon.css"'); // now on the shared shell
    expect(res.text).toContain('class="wall wall-l"');
    expect(res.text).toContain('href="/static/landing.css"'); // landing-unique styles still linked
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/web-registration.test.ts -t "landing page"`
Expected: FAIL — landing is still standalone (no `dungeon.css` / `wall-l`).

- [ ] **Step 3: Strip `src/web/views/landing.ejs` to body sections**

Remove the document scaffold and shell-owned chrome. Delete:
- lines 1–10 (`<!doctype>` … `<body>` head block),
- lines 11–12 (the `.wall` divs),
- lines 14–15 (the `loot` const + `.loot-field` — the shell provides gutter loot now),
- lines 17–20 (the `.bar` header),
- line 22 `<main>` open and line 74 `</main>` close,
- line 76 (the `.foot`) and lines 77–78 (`</body></html>`).

Keep exactly the section markup that was inside `<main>`: `<section class="hero">…</section>`, `<section class="classes">…`, `<section class="how">…`, `<section class="trust">…`, `<section class="final">…`. The file becomes those five `<section>` blocks only (the EJS `<% ... %>` inside them — `boss`, `classes`, `snippet` — is unchanged). The `.callout` inside the `how` section (containing "Claude Code only" and "does <b>not</b> count Claude <b>API</b>") and the "The dungeon rests" idle fallback MUST remain — tests assert them.

- [ ] **Step 4: Trim `src/web/public/landing.css`**

Delete the rules now provided by `dungeon.css` (they would duplicate or fight it). Remove these selectors/blocks from `landing.css`:
- the `:root{…}` token block (line 2),
- `body{…}` background stack + `body{background-color…}` (lines 4–12),
- `.px` (line 13), `a{…}` and `pre,code{…}` (line 14),
- `.wall`, `.wall-l`, `.wall-r`, `.sconce*`, `.t-a`/`.t-b`, `@keyframes flick/flickA` (lines 15–22),
- `.loot-field`, `.loot`, `.loot img`, `@keyframes bob` (lines 23–26),
- `main,.bar,.foot{z-index}` and `.bar`, `.brand`, `.bar nav*` (lines 27–33) — but KEEP `main{max-width:1120px;margin:0 auto;padding:0 34px}` is now the shell's; delete the landing copy,
- `.btn`, `.btn .bi`, `.btn-gold`, `.btn-ghost`, `.btn:hover…`, `.big` (lines 41–45),
- `section{padding:44px 0}` and `.sec-head*` (lines 68–69),
- `.foot`, `.foot .si` (lines 98–99),
- the `@media (prefers-reduced-motion…)` block (line 101).

KEEP all landing-unique rules: `.hero*`, `.eyebrow`, `.dot`/`@keyframes pulse`, `h1`, `.lede`, `.cta-row`, the entire `.boss-card` group (`.boss-head`,`.tag`,`@keyframes pulseR`,`.floor`,`.boss-stage`,`.boss-glow`,`@keyframes breathe`,`.boss-sprite`,`@keyframes hoverB`,`.boss-name`,`.hpbar*`,`.hp-meta*`,`.party*`,`.pty*`,`.boss-idle*`), `.cls-grid`,`.cls*`,`@keyframes glint`, `.steps`,`.step*`, `.snippet`,`.snip-head`, `.callout*`, `.trust-cols`,`.tcol*`,`.sees`,`.nots`,`.fine*`, `.final*`,`.final-loot*`.

In the KEPT `@media (max-width:900px)` block (line 100), remove `.wall,.loot-field{display:none}` and `body{background-attachment:scroll}` (those belong to the shell / are gone) — keep the `.hero`, `.boss-card{order:-1}`, `.steps`, `.trust-cols` stacking rules. Because `landing.css` is linked AFTER `dungeon.css`, its kept `h1{font-size:clamp(38px,6.2vw,64px)}` correctly overrides the shell's smaller `h1` for the landing hero.

- [ ] **Step 5: Switch the landing route to the shell**

In `src/web/routes/registration.ts`, change the landing render (currently `renderStandalone('landing', { classes, boss, snippet })`) to:

```ts
res.send(
  await renderPage('landing', {
    title: 'ClaudeRPG',
    frame: 'full',
    styles: ['landing.css'],
    classes,
    boss,
    snippet,
  }),
);
```

Update the import line if needed so `renderPage` is imported (it already is in this file).

- [ ] **Step 6: Remove `renderStandalone` if unused**

Run: `grep -rn "renderStandalone" src/`
If the only remaining hit is the definition in `src/web/app.ts`, delete the `renderStandalone` function. If any route still uses it, leave it.

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/web-registration.test.ts`
Expected: PASS — all existing landing/register assertions plus the new shell markers.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/views/landing.ejs src/web/public/landing.css src/web/routes/registration.ts src/web/app.ts tests/web-registration.test.ts
git commit -m "refactor(web): land landing page on the shared dungeon shell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Redesign the register page

Rebuild `register.ejs` with the shared primitives. Preserve every test-asserted hook: `name="class_key"`, the `data-sprite-m`/`data-sprite-f` attributes and exact URLs, `id="class_key" value="<sel>"`, `data-key="<key>" onclick="pick(this)"`, `name="gender"`, and the `applyGender`/`pick` scripts.

**Files:**
- Modify: `src/web/views/register.ejs` (full rewrite)
- Test: `tests/web-registration.test.ts` (existing register cases must pass unchanged)

**Interfaces:**
- Consumes: shared `.panel`, `.avatars`, `.avatar`, inputs, `button` from `dungeon.css`.
- Produces: no new interface; markup hooks preserved for the existing tests.

- [ ] **Step 1: Confirm the guard tests exist**

The existing tests already assert the hooks. Re-run them to establish the green baseline before editing:

Run: `npx vitest run tests/web-registration.test.ts -t "register"`
Expected: PASS (baseline).

- [ ] **Step 2: Rewrite `src/web/views/register.ejs`**

```ejs
<div class="panel">
  <p class="eyebrow" style="color:var(--gold2);font-family:ui-monospace,monospace;font-size:12.5px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 10px">Enlist</p>
  <h1>Create your character</h1>
  <p style="color:var(--muted);max-width:52ch">Pick a name, a look, and a class. Your Claude Code usage powers this fighter on the office TV.</p>
  <% if (typeof error !== 'undefined' && error) { %>
    <p class="flash err"><%= error %></p>
  <% } %>
  <form method="post" action="/register">
    <label for="name">Character name</label>
    <input id="name" name="name" maxlength="40" required
           value="<%= typeof name !== 'undefined' ? name : '' %>" />

    <label for="gender">Gender</label>
    <select name="gender" id="gender" onchange="applyGender()">
      <option value="M">Male</option>
      <option value="F">Female</option>
    </select>

    <label>Class / avatar</label>
    <% var sel = typeof selected !== 'undefined' ? selected : 'knight'; %>
    <input type="hidden" name="class_key" id="class_key" value="<%= sel %>" />
    <div class="avatars">
      <% classes.forEach(function (c, i) { %>
        <div class="avatar <%= c.key === sel ? 'selected' : '' %>"
             data-key="<%= c.key %>" onclick="pick(this)">
          <img class="px" src="<%= c.spriteM %>" data-sprite-m="<%= c.spriteM %>"
               data-sprite-f="<%= c.spriteF %>" alt="<%= c.name %>" />
          <div><%= c.name %></div>
        </div>
      <% }) %>
    </div>
    <button type="submit">Create character</button>
  </form>
</div>
<script>
  function pick(el) {
    document.querySelectorAll('.avatar').forEach(a => a.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('class_key').value = el.dataset.key;
  }
  // Swap every avatar preview to match the selected gender.
  function applyGender() {
    var female = document.getElementById('gender').value === 'F';
    document.querySelectorAll('.avatar img').forEach(function (img) {
      img.src = female ? img.dataset.spriteF : img.dataset.spriteM;
    });
  }
  applyGender();
</script>
```

- [ ] **Step 3: Add themed `.avatars`/`.avatar` rules to `dungeon.css`**

Append to `src/web/public/dungeon.css` (the old copies lived in `style.css`, which is being retired in Task 8):

```css
/* class picker (register) */
.avatars{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:12px;margin-top:8px}
.avatar{position:relative;text-align:center;padding:14px 8px 10px;border:1px solid var(--line);border-radius:13px;
  background:linear-gradient(180deg,var(--panel2),var(--panel));cursor:pointer;transition:transform .14s,border-color .14s,box-shadow .14s}
.avatar img{image-rendering:pixelated;width:64px;height:64px;transition:transform .16s;filter:drop-shadow(0 6px 8px rgba(0,0,0,.5))}
.avatar div{margin-top:6px;font-size:13px;font-weight:650;color:var(--ink)}
.avatar:hover{transform:translateY(-4px);border-color:var(--gold-dim);box-shadow:0 16px 30px -16px rgba(232,201,106,.5)}
.avatar:hover img{transform:scale(1.12) translateY(-2px)}
.avatar.selected{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold),0 16px 30px -16px rgba(232,201,106,.5)}
.avatar.selected div{color:var(--gold)}
```

- [ ] **Step 4: Run the register tests**

Run: `npx vitest run tests/web-registration.test.ts`
Expected: PASS — every `register` assertion (`Paladin`, `name="class_key"`, both `data-sprite-*` URLs, `applyGender`, `id="class_key" value="wizard"`, `data-key="wizard" onclick="pick(this)"`) still holds.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/register.ejs src/web/public/dungeon.css
git commit -m "feat(web): redesign register page on the dungeon shell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Redesign the registered (post-register) page

Rebuild `registered.ejs` with the shell primitives. Preserve the token/snippet `<pre>` blocks (the POST /register test asserts `claude_rpg_token=` appears in the response) and the "Claude Code only" scope note.

**Files:**
- Modify: `src/web/views/registered.ejs` (full rewrite)
- Test: `tests/web-registration.test.ts` (POST case must still pass)

**Interfaces:**
- Consumes: `.panel`, `pre`, `.callout` (landing.css defines `.callout`, but registered goes through the shell WITHOUT landing.css — so use a shell-styled note, not `.callout`).
- Produces: markup preserving `player.auth_token` and `snippet` in `<pre>`.

- [ ] **Step 1: Rewrite `src/web/views/registered.ejs`**

```ejs
<div class="panel">
  <h1>Welcome, <%= player.name %>!</h1>
  <p>Your class: <strong style="color:var(--gold2)"><%= className %></strong></p>

  <label style="margin-top:4px">Your auth token — this is your login. Keep it safe.</label>
  <pre><%= player.auth_token %></pre>

  <label>Add this to your shell config to start contributing</label>
  <pre><%= snippet %></pre>

  <p class="flash" style="border-color:var(--gold-dim);background:linear-gradient(180deg,#26200f,#1b1712);color:#efe4c9">
    ⚔️ <strong style="color:var(--gold2)">Claude Code only.</strong> This tracks the <strong>Claude Code CLI</strong> — it does
    <strong>not</strong> count Claude <strong>API</strong> tokens or usage from the
    <strong>desktop / web app</strong>. Run Claude Code with the snippet above active and your usage
    joins the fight. Pause anytime with <code>rpg_off</code>.
  </p>

  <a class="btn" href="/character?token=<%= encodeURIComponent(player.auth_token) %>">Go to your character sheet →</a>
</div>
```

- [ ] **Step 2: Run the POST-register test**

Run: `npx vitest run tests/web-registration.test.ts -t "creates a player"`
Expected: PASS — response still contains `claude_rpg_token=` (from `snippet`).

- [ ] **Step 3: Commit**

```bash
git add src/web/views/registered.ejs
git commit -m "feat(web): redesign post-register page on the dungeon shell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Redesign the character-login page

Rebuild `character-login.ejs`. Preserve `name="token"` (asserted by `web-character`).

**Files:**
- Modify: `src/web/views/character-login.ejs` (full rewrite)
- Test: `tests/web-character.test.ts` (login case must still pass)

**Interfaces:**
- Consumes: `.panel`, inputs, `button` from `dungeon.css`.
- Produces: form with `name="token"` preserved.

- [ ] **Step 1: Rewrite `src/web/views/character-login.ejs`**

```ejs
<div class="panel" style="max-width:520px">
  <p class="eyebrow" style="color:var(--gold2);font-family:ui-monospace,monospace;font-size:12.5px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 10px">Return</p>
  <h1>Character login</h1>
  <p style="color:var(--muted)">Enter your auth token to view your character sheet.</p>
  <% if (typeof error !== 'undefined' && error) { %>
    <p class="flash err"><%= error %></p>
  <% } %>
  <form method="get" action="/character">
    <label for="token">Auth token</label>
    <input id="token" name="token" required />
    <button type="submit">View character</button>
  </form>
</div>
```

- [ ] **Step 2: Run the login test**

Run: `npx vitest run tests/web-character.test.ts -t "login"`
Expected: PASS — `name="token"` present. (If the test name differs, run the whole file: `npx vitest run tests/web-character.test.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/web/views/character-login.ejs
git commit -m "feat(web): redesign character-login page on the dungeon shell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Redesign the character-sheet page (showcase)

Rebuild `character-sheet.ejs` as the player's reward page — a portrait/identity header + stat cards + setup snippet + rename/delete. Preserve the player name and `snippet` (asserted: `Gandalf`, `claude_rpg_token=`), all form fields (`token`, `name`), and the delete confirm.

**Files:**
- Modify: `src/web/views/character-sheet.ejs` (full rewrite)
- Test: `tests/web-character.test.ts` (sheet + rename + delete cases must still pass)

**Interfaces:**
- Consumes: `.panel`, `table`, inputs, `button`, `.btn-danger`, `.stat-card` (added below) from `dungeon.css`.
- Produces: preserves `player.name`, `avatarUrl`, `snippet`, and the rename/delete forms with hidden `token` fields.

- [ ] **Step 1: Rewrite `src/web/views/character-sheet.ejs`**

```ejs
<div class="panel">
  <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
    <div style="flex:0 0 auto;width:112px;height:112px;border-radius:16px;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);display:grid;place-items:center;box-shadow:inset 0 1px 0 #ffffff0d">
      <img src="<%= avatarUrl %>" alt="avatar" class="px" style="width:88px;height:88px;filter:drop-shadow(0 8px 10px rgba(0,0,0,.5))" />
    </div>
    <div>
      <h1 style="margin:0 0 6px"><%= player.name %></h1>
      <p style="margin:0;color:var(--muted)"><span style="color:var(--gold2);font-weight:700"><%= className %></span> · <%= player.gender === 'M' ? 'Male' : 'Female' %> · <%= connected ? 'Connected' : 'Not seen yet' %></p>
    </div>
  </div>

  <div class="stat-grid">
    <div class="stat-card"><span class="stat-k">Level</span><span class="stat-v"><%= player.level %></span></div>
    <div class="stat-card"><span class="stat-k">XP (effective tokens)</span><span class="stat-v"><%= player.effective_tokens %></span></div>
    <div class="stat-card"><span class="stat-k">Total tokens</span><span class="stat-v"><%= player.total_tokens %></span></div>
    <div class="stat-card"><span class="stat-k">Gold</span><span class="stat-v" style="color:var(--gold2)"><%= player.gold %></span></div>
  </div>
</div>

<div class="panel">
  <h2>Your setup snippet</h2>
  <pre><%= snippet %></pre>
</div>

<div class="panel">
  <h2>Rename</h2>
  <form method="post" action="/character/rename">
    <input type="hidden" name="token" value="<%= player.auth_token %>" />
    <label for="name">New name</label>
    <input id="name" name="name" maxlength="40" value="<%= player.name %>" required />
    <button type="submit">Rename</button>
  </form>
</div>

<div class="panel">
  <h2>Delete character</h2>
  <p style="color:var(--muted)">This permanently removes your character and its progress.</p>
  <form method="post" action="/character/delete"
        onsubmit="return confirm('Delete this character permanently?');">
    <input type="hidden" name="token" value="<%= player.auth_token %>" />
    <button type="submit" class="btn-danger">Delete</button>
  </form>
</div>
```

- [ ] **Step 2: Add `.stat-grid`/`.stat-card` rules to `dungeon.css`**

Append to `src/web/public/dungeon.css`:

```css
/* character-sheet stat cards */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.stat-card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:13px;padding:16px}
.stat-k{display:block;font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.stat-v{display:block;margin-top:6px;font-size:26px;font-weight:800;color:var(--head)}
```

- [ ] **Step 3: Run the character tests**

Run: `npx vitest run tests/web-character.test.ts`
Expected: PASS — `Gandalf`, `claude_rpg_token=`, the 302 rename/delete redirects, and the 500 case all hold.

- [ ] **Step 4: Commit**

```bash
git add src/web/views/character-sheet.ejs src/web/public/dungeon.css
git commit -m "feat(web): redesign character sheet on the dungeon shell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Retire overlapping `style.css` rules + full verification

`style.css` still ships its own `:root` tokens, `body` background, `.panel`, inputs, `button`, `table`, `.flash`, `.avatars`/`.avatar` — all now owned by `dungeon.css`. Because `layout.ejs` no longer links `style.css`, these are already dead for shell pages, but leaving a second `:root`/`body` around is a trap. Confirm nothing links `style.css`, then delete the dead file (or reduce it to nothing).

**Files:**
- Modify/Delete: `src/web/public/style.css`
- Test: full suite + manual visual verification

- [ ] **Step 1: Confirm `style.css` is unreferenced**

Run: `grep -rn "style.css" src/`
Expected: no references (Task 1 removed the `<link>` from `layout.ejs`; landing links `dungeon.css` + `landing.css`). If any view still links it, convert that view onto shared primitives first.

- [ ] **Step 2: Delete `style.css`**

Run: `git rm src/web/public/style.css`

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS — all web route tests green.

- [ ] **Step 4: Visual verification via the app**

Use the `/run` skill (or `npm run dev` per README) to launch the app, then load and eyeball at a wide (>1180px) and a narrow (~1000px) window:
- `/` (landing) — must look essentially identical to before the refactor; loot now only in the side gutters, walls/glow intact.
- `/register`, `/register?class=wizard` — themed form + class picker; gender swap works.
- After a test registration: the registered page, then `/character?token=…` (character sheet) — stat cards, snippet, rename/delete.
- `/character` (login), `/admin/login` (lite frame: dimmer glow, no loot, wider content).
- Narrow window: loot rails disappear below ~1180px; walls, torches, background persist; content is not crowded.

Record what was observed (which pages, both widths). If anything clips or clashes, fix and re-run before finishing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(web): retire style.css — superseded by dungeon.css

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** §1 design system → Task 1 (`dungeon.css`). §2 shell + `renderPage` → Task 1. §2 lite variant → Task 2. §3 gutter loot rails (hide < ~1180px, not behind content) → Task 1 CSS (`.loot-rail`, media query) + layout markup. §4 landing refactor + remove `renderStandalone` → Task 3. §5 player-page redesigns → Tasks 4–7. §6 lite frame for deferred cohorts → Task 2. Testing (route-smoke + visual) → Tasks 1–2 tests + Task 8 visual pass. §2 per-page `styles` hook → Task 1 (`layout.ejs` + `renderPage`) + Task 3 (landing uses it).
- **Breakpoint consistency:** the spec said "~1100px"; this plan pins it to **1180px** (matches the content column + gutter math where rails reach zero width) and uses 1180 consistently in the CSS media query, the `frame-lite main` width, and the Task 8 verification. Intentional tightening of the spec's approximate figure.
- **Type/selector consistency:** frame values `'full'`/`'lite'` and the `frame-lite` body class are used identically across `renderPage`, `layout.ejs`, and all route calls. Loot markers `loot-rail left`/`loot-rail right` match between `layout.ejs` and the tests. `.panel`/`.btn`/`.btn-danger`/`.avatars`/`.avatar`/`.stat-card` are defined in `dungeon.css` and referenced by the views that use them.
- **Preserved test hooks:** register (`name="class_key"`, `data-sprite-m/-f`, `applyGender`, `pick(this)`, `id="class_key" value=`), registered/POST (`claude_rpg_token=` via snippet), character-login (`name="token"`), character-sheet (`Gandalf`, `claude_rpg_token=`, rename/delete forms), landing (`Your code has`, `Claude Code only`, `does <b>not</b> count Claude <b>API</b>`, `href="/register"`, `href="/tv"`, `The dungeon rests`).

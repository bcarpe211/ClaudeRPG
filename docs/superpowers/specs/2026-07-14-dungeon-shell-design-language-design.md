# Dungeon Shell + Design System — design

**Date:** 2026-07-14
**Backlog:** #18 (design-language rollout; follow-on to #10 landing page)
**Scope:** Spec 1 of 3 — foundation + landing refactor + player-page redesign.
Admin and dev-tool cohort redesigns are deferred to their own specs.

## Problem

The landing page (`/`, #10) established a distinctive dungeon-corridor look —
torch-lit moss-wall border, corner torch glow, tiled floor texture, and floating
loot decorations. Every other page (`register`, `registered`, `character-login`,
`character-sheet`, `admin-*`, `catalog`, `dungeon-preview`) still renders on the
plain shared `layout.ejs` + `style.css`, so the game has one beautiful front door
and a set of utilitarian rooms behind it.

Landing is **standalone** — a full HTML document with its own `landing.css`,
rendered via `renderStandalone`. Its frame styling is not reusable as written.

## Goal

Lift the landing design language into a **reusable shell** that every page
inherits, with the loot decorations confined to the side gutters (never behind
content), a lighter variant for dense admin/dev pages, and one source of truth
for the frame. Prove the system by fully redesigning the four player-facing
pages and refactoring landing onto the same shell.

## Non-goals

- Bespoke redesign of admin pages (login/players/player-edit/settings) or dev
  tools (catalog, dungeon-preview) — they receive the **lite frame** now; their
  content redesigns are separate specs under #18.
- Shop / character-editor pages — do not exist yet; they inherit the shell for
  free when built.
- Any change to routes' data/behavior beyond passing a frame variant.

## Approach (decomposition)

Chosen approach **A**: build the foundation once, apply the lite frame everywhere
so nothing looks broken, and fully redesign only the player cohort in this spec.
Remaining cohorts are cheap follow-ups because the system already exists.

## Design

### 1. Shared design system — `src/web/public/dungeon.css` (new)

Extract the reusable layer out of `landing.css`. Moves into the shared file:

- **Tokens** — the entire `:root` block from `landing.css` (`--panel`, `--panel2`,
  `--card`, `--line`, `--gold`, `--gold2`, `--gold-dim`, `--red`, `--red-track`,
  `--live`, `--ink`, `--head`, `--muted`, `--wall`). Single source of truth.
- **Background** — the `body` background stack: four corner torch-glow radials,
  the top vignette radial, the `tex.png` tile, `background-color:#0c0912`,
  `background-attachment:fixed`.
- **Frame** — `.wall`, `.wall-l`, `.wall-r` (moss wall + inset/outset shadows);
  `.sconce`(`.top`/`.bot`), `.t-a`/`.t-b` torch flicker keyframes, drop-shadow glow.
- **Loot** — `.loot` + `bob` keyframe, re-scoped to gutter rails (§3).
- **Shared primitives** — `.px`; buttons `.btn`/`.btn-gold`/`.btn-ghost`/`.big`;
  `.sec-head` + `section` rhythm; a generalized **`.panel`** (the gradient +
  border + shadow currently duplicated across `.boss-card`/`.tcol`/`.cls`);
  themed **headings, links, form controls (`input`/`select`/`textarea`),
  buttons, and `table`** so redesigned pages are cohesive by default.
- **Motion** — `prefers-reduced-motion:reduce` block.

Assets (`tex.png`, `moss_wall.png`, `torch_a.png`, `torch_b.png`, loot sprites)
already live under `src/web/public/landing/` and are reused as-is (served at
`/static/landing/…`). No asset moves required.

### 2. The shell — `src/web/views/layout.ejs` (rewrite) + `renderPage` change

`layout.ejs` becomes the dungeon shell wrapping every `renderPage` view:

- Links `dungeon.css` always, plus `style.css` during the transition (trimmed as
  pages move onto shared primitives). Adds an optional **per-page stylesheet
  hook**: `layout.ejs` accepts a `styles` array (default `[]`) and links each —
  landing passes `['landing.css']`. `renderPage` threads `styles` through
  alongside `frame`.
- Emits the frame markup: `.wall-l`/`.wall-r` with sconce torches (top+bottom),
  the two gutter loot rails (§3), a themed **header bar** (landing's `.bar`
  style — brand + nav, nav links reconciled: Home / Watch TV / Log in / Register
  / Admin), page content inside a centered `.panel`, and a themed footer.
- **Frame variant** via a `frame` string:
  - `'full'` (default) — full corner glow + gutter loot. Player pages, landing.
  - `'lite'` — same walls + background, **dimmer glow, no loot rails, wider
    content column** so dense tables/forms stay legible. Achieved with a
    `body.frame-lite` (or `data-frame="lite"`) hook toggling glow opacity, loot
    `display:none`, and the content `max-width`.

**`renderPage` change (`src/web/app.ts`):** it currently forwards only
`{ title, body }` to `layout.ejs`, dropping the rest of `data`. Thread the shell
params through: pass `frame: data.frame ?? 'full'` and `styles: data.styles ?? []`
(and keep `title`, `body`). Routes for admin/catalog/dungeon-preview add
`frame: 'lite'` to their render data; landing adds `styles: ['landing.css']`.
No other route changes.

### 3. Loot in the gutters, never behind content

Landing's `.loot-field` is `position:absolute; inset:0` full-bleed, and its loot
list places items at `left:33%/50%` — i.e. **behind** the content column.

Replace with **two gutter rails**: containers absolutely positioned in the space
between each wall (`--wall`, 66px) and the edges of the centered
`max-width:1120px` content column. Loot is positioned only within those rails
(`left`/`right` measured from the wall inward), so nothing floats behind content.

- Rails are present only for `frame:'full'`.
- Below **~1100px** viewport (gutters collapse; content fills the width) the
  rails `display:none`. Walls, torch glow, and background persist at all widths
  (unlike landing today, which hides the walls at 900px too — we split that).
- Reduced-motion: loot static, reduced opacity (as landing does).

### 4. Refactor landing onto the shell

Landing stops being standalone:

- `landing.ejs` becomes a `renderPage` view providing only its **body** content
  (hero + boss card + classes + how-to-join + trust + final). The shell owns
  wall/torch/loot/background/header/footer.
- `landing.css` shrinks to the **landing-unique** sections only: `.hero`,
  `.boss-card` (+ boss stage/glow/sprite/hp/party/idle), `.cls-grid`/`.cls`,
  `.steps`/`.step`, `.snippet`, `.callout`, `.trust-cols`/`.tcol`, `.final`.
  Everything else now comes from `dungeon.css`. Landing links both stylesheets.
- The landing route switches `renderStandalone('landing', …)` →
  `renderPage('landing', { title, frame: 'full', classes, boss, snippet })`.
  The landing page keeps its bespoke header/footer content **only if** it differs
  from the shell's; otherwise it uses the shell's. Reconcile so there is one bar.
- If landing is the last caller of `renderStandalone`, remove the helper
  (verify with a grep before deleting).

### 5. Full redesign of the four player pages

`register`, `registered`, `character-login`, `character-sheet` get bespoke
content built from the shared primitives inside `.panel` — real dungeon-styled
forms and cards, not old CSS reheated inside a frame. `character-sheet` is the
showcase (the player's "reward" page: character portrait, class, level, gold,
stats presented as themed cards). All four render with `frame:'full'`.

### 6. Lite frame for deferred cohorts

Admin (login/players/player-edit/settings) and dev tools (catalog,
dungeon-preview) render with `frame:'lite'` immediately — framed and on-theme
background, existing content untouched. Their bespoke redesigns are follow-up
specs. This guarantees no page looks broken after this spec ships.

## Components & boundaries

- `dungeon.css` — the design system. Consumed by every page. Depends on nothing
  but the `/static/landing/` assets.
- `layout.ejs` — the shell. Depends on `dungeon.css` + the `frame` param. Every
  `renderPage` view is its consumer; views know nothing of the frame internals.
- `renderPage` — threads `title`, `body`, `frame` into the shell.
- Page views — supply body content only; swap-in/out without touching the shell.

## Testing

- Existing test suite still passes (no behavior change to routes/engine).
- Route-smoke test (per page): renders and contains the shell marker
  (`class="wall-l"`); loot rails present iff `frame:'full'`; admin/catalog/
  dungeon-preview responses carry the `frame-lite` hook.
- `renderPage` unit: forwards `frame` (defaults to `'full'`).
- Visual verification via `/run`: landing (regression — must look identical
  after the refactor), the four redesigned player pages, and one lite page
  (admin-settings) at wide and <1100px widths (loot hides, frame persists).

## Risks

- **Landing regression** — the refactor must leave landing visually identical.
  Mitigated by the visual regression check and by keeping landing-unique CSS
  byte-for-byte where it moves file.
- **`style.css` clashes** — during transition, shared primitives in `dungeon.css`
  and legacy rules in `style.css` could collide. Load order and scoping
  (`.panel` context) contain it; trim `style.css` as pages migrate.

## Follow-ups (separate specs, all #18)

- Admin cohort bespoke redesign.
- Dev-tools cohort (catalog, dungeon-preview) bespoke redesign.
- Shop / character-editor when those pages are built.

# Player Hub Live Dungeon Dashboard — Design

**Date:** 2026-07-30

**Status:** Implemented and locally approved; Pi release gate pending

**Scope:** Player-hub Live Dungeon presentation and the compact TV renderer used by `/tv/embed`

## Goal

Turn the player hub's Live Dungeon tab into a condensed, watchable dashboard:

- the animated dungeon is the clear focal point;
- Fight Leaders sits beside it rather than below it;
- Today becomes one supporting strip across the full width;
- the compact view contains only the encounter status and dungeon tiles, without the TV backdrop; and
- the full-screen TV remains visually and behaviorally unchanged.

The implementation must reconstruct the hub view from the same live layout and
state frames as the TV. The CSS cropping used by the visual mockups is not an
implementation technique.

## 1. Approved desktop composition

The existing purple Live Dungeon panel remains the outer surface and keeps its
heading, explanatory copy, and **Watch full screen** link.

Its content becomes two rows:

1. A primary row with a tightly fitted animated dungeon on the left and Fight
   Leaders on the right.
2. A full-width Today strip beneath both.

At the reviewed desktop width, the primary row uses:

- a **480 × 400 pixel** dungeon composition, including a 40-pixel status area
  above the 480 × 360 tile field;
- a flexible Fight Leaders panel that consumes the remaining width; and
- a gap of roughly 20–22 pixels, leaving room for the dungeon's offset shadow.

This keeps the dungeon at the same visible pixel scale as the current 871 × 490
embed while eliminating unused backdrop. Combined with moving the summaries,
it removes roughly 250 pixels of page height in the reviewed viewport.

## 2. Purpose-built hub renderer

`/tv/embed` remains an iframe so the canvas renderer, animation loop, and SSE
connection stay isolated from the character page and Wardrobe JavaScript.

The iframe continues to use the shared TV renderer and the existing `/tv/stream`
events. It does not duplicate dungeon generation, encounter state, actor
positioning, sprite animation, potion effects, monster debuffs, hit feedback,
pause behavior, or defeat behavior.

Compact mode receives a distinct framing path:

- no leaderboard sidebar;
- no tiled TV backdrop;
- no proportional outer margins;
- one transparent 6:5 stage containing the status area and the complete 20 × 15
  dungeon panel;
- the dungeon begins directly below the status area; and
- all actors, decor, overlays, and effects retain their existing dungeon-relative
  coordinates.

The renderer still draws at integer source-pixel scales. The desktop iframe is
480 × 400 CSS pixels, which maps cleanly to the 480 × 400 logical composition at
1× displays and its integer multiple at 2× displays. The full-TV `computeScale`
path remains unchanged.

The compact document and canvas backgrounds become transparent. Before the
first layout frame arrives, the renderer may show its existing loading state,
but it must not introduce a black rectangle around the future dungeon.

## 3. Encounter status

The monster name and HP bar remain visible in the compact view. They occupy the
narrow status area above the room instead of floating within a large TV
backdrop.

- The monster name is centered and subdued enough not to compete with the room.
- The HP bar is wider and more prominent than the current compact rendering.
- The HP track and fill use rounded corners consistent with the dashboard.
- Existing HP updates, pause behavior, and defeat transitions remain live.

The status area is transparent so the purple player-hub surface shows through
around the label and bar.

## 4. Dungeon surface and elevation

Only the 20 × 15 dungeon tiles form the visible room rectangle. The room uses an
11-pixel radius matching the Fight Leaders panel. `overflow: hidden` deliberately
crops the extreme corner pixels of the wall tiles; this tradeoff is approved.

The room receives a restrained elevation treatment:

- a thin dark edge around the tile rectangle;
- a small, soft shadow offset only toward the bottom-right; and
- a very light inner top edge for separation.

There is no four-sided halo, large ambient glow, or theatrical floating effect.
The intended reference is approximately:

```css
box-shadow:
  8px 10px 20px -11px rgb(0 0 0 / 88%),
  3px 4px 8px -5px rgb(0 0 0 / 92%),
  0 0 0 2px rgb(8 4 12 / 94%);
```

Exact values may be adjusted slightly during browser verification, but the
direction, restraint, and absence of an all-sided halo are fixed.

## 5. Supporting information hierarchy

Fight Leaders remains a rounded purple subpanel with its existing five entries,
rank, player name, and damage. Its border, row separators, names, and damage
figures become slightly quieter than the dungeon edge and HP bar. Gold rank
markers remain visible.

Today becomes one six-cell strip across the full content width in this order:

1. Effective tokens
2. Damage
3. Fight rank
4. Gold earned
5. Active time
6. Potions used

The strip keeps every existing ID and polling target. Its labels and borders are
subdued, while values remain readable. The hierarchy is:

1. animated dungeon;
2. fight context;
3. personal daily statistics.

This is a presentation change only. Fight Leader and Today data, calculations,
polling cadence, and formatting remain unchanged.

## 6. Responsive behavior

Desktop keeps the dungeon and Fight Leaders side by side.

When the primary row can no longer fit a 480-pixel dungeon, the minimum leader
width, and the approved gap, it stacks in this order:

1. dungeon;
2. Fight Leaders;
3. Today.

The dungeon remains centered. At widths below 480 pixels, the complete 6:5
composition scales down uniformly to fit the available width; it must not crop
additional dungeon rows or introduce horizontal scrolling. The source renderer
continues to use integer drawing and disabled smoothing before the final
responsive presentation scale.

Today changes from six columns to three columns by two rows, then two columns by
three rows at the smallest supported width. No label or value may overflow its
cell.

## 7. Component and data boundaries

- `tv.js` owns shared SSE state, animation, full-TV drawing, and the distinct
  compact framing calculation.
- `embed.html` owns the transparent compact document and stage sizing.
- `character-live.ejs` owns the semantic order: dungeon, Fight Leaders, Today.
- `player-hub.css` owns the dashboard grid, room radius/shadow, supporting-panel
  hierarchy, and responsive stacking.
- `player-hub.js` keeps updating the existing Fight Leader and Today targets; it
  does not render the dungeon.

No new database table, route payload, polling loop, or duplicate game-state
view-model is introduced.

## 8. Accessibility and resilience

- The iframe keeps a descriptive title.
- **Watch full screen** remains a normal link to `/tv`.
- Fight Leaders and Today retain their headings and semantic regions.
- Muted supporting colors must remain comfortably readable against their panel
  backgrounds; hierarchy must not depend on opacity alone.
- Reduced-motion behavior remains unchanged.
- The resting message, encounter-defeat overlay, potion motes, monster debuffs,
  and damage feedback remain visible within the rounded room without being cut
  off incorrectly.
- If the live stream disconnects, existing renderer behavior remains available;
  the transparent document must not collapse the iframe's 6:5 geometry.

## 9. Verification strategy

### Automated

- Route tests continue to prove that `/tv/embed` serves compact mode and the
  shared renderer.
- Renderer tests distinguish the unchanged full-TV framing from the tight 6:5
  compact framing and prove that compact mode does not draw the TV backdrop or
  leaderboard.
- Character rendering tests preserve one iframe followed by Fight Leaders and
  Today.
- CSS tests cover the desktop two-column primary row, full-width Today strip,
  11-pixel dungeon radius, bottom-right-only shadow, and responsive stacking.
- Existing TV animation, potion FX, player-hub polling, and accessibility tests
  remain green.

### Visual review

Using the disposable potion-demo database, review:

1. an active encounter for at least two complete actor and monster A/B cycles;
2. the resting state;
3. potion-only, debuff-only, and overlapping potion/debuff effects;
4. hit flashes, floating damage, and monster attacks near every room edge;
5. the defeat overlay and next-encounter transition;
6. desktop side-by-side layout and narrow stacked layouts; and
7. common 1× and 2× display densities for crisp tiles and a restrained shadow.

## 10. Out of scope

- Full-screen TV layout or art changes
- Fight Leader or Today calculation changes
- New player statistics
- New dungeon dimensions or procedural generation
- Potion economy or combat-balance changes
- Pi or production deployment

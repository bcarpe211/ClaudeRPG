# Player Hub Inventory Correction — Design

**Date:** 2026-07-30

**Status:** Approved for implementation planning

**Scope:** Player-hub Today spacing and Inventory room presentation

## Goal

Correct two issues found during final local review of the timed-consumables player hub:

1. reduce the oversized vertical gap above the Today statistics at both wide and narrow widths; and
2. replace the obsolete first-pass Inventory room with the later approved Duskstone Warren and Thornwind Ruins hybrid.

This pass changes presentation only. Potion ownership, activation, filters, selected-item details, polling, daily limits, and combat behavior remain unchanged.

## 1. Today spacing

The Live Dungeon grid currently uses a 22px row gap, while the Today heading adds another 10px before its six statistic cards. This makes Today feel detached from the dungeon and Fight Leaders above it.

The correction will:

- reduce the Live Dungeon row gap to 12px;
- reduce the Today heading-to-card gap to 6px;
- retain the existing 20px horizontal gap between the dungeon and Fight Leaders; and
- use the same vertical rhythm when the container stacks the dungeon, leaders, and Today on narrow layouts.

No card dimensions, typography, values, breakpoints, or polling behavior change.

## 2. Approved Inventory art direction

The current implementation is obsolete. It uses the site's repeated moss-wall border, two cracked decorations, one moss accent, and a centered door. Those elements must be removed.

The replacement follows the approved hybrid preview in `.superpowers/brainstorm/80055-1785382569/content/inventory-hybrid-duskthorn-v3.html`:

- **Base walls:** Duskstone Warren wall row 12.
- **Floor:** one plain Duskstone tile, atlas coordinate column 4, row 12, repeated across every usable item cell.
- **Moss:** Thornwind Ruins wall row 13 in exactly two diagonal corner patches.
- **Top-left patch:** the corner plus two wall tiles extending right and two wall tiles extending down.
- **Bottom-right patch:** the mirrored corner plus two wall tiles extending left and two wall tiles extending up.
- **Floor shadow:** the same TV wall-shadow tile, atlas coordinate column 30, row 37, over the first interior floor row and beneath the top wall layer.
- **Decorations:** none. No door, cracked tiles, flowers, webs, torch, or floor accents.

The room must use the verified full-sheet dimensions when scaling atlas coordinates. The Oryx source PNG is 1366×1007 with a 56×41 usable 24px grid; treating it as a tightly cropped 1344×984 sheet causes neighboring-tile bleed.

## 3. Room geometry and responsiveness

The room uses a live DOM tile grid rather than a pre-rendered composite image. This keeps every inventory item a native button and allows the layout to snap without softening the pixel art.

- Every displayed source tile is exactly 48×48 CSS pixels, an integer 2× enlargement.
- Wide layouts use a 9-column × 6-row room. The outer wall consumes one cell on each side, leaving a 7×4 interior with 28 usable item cells.
- Narrow layouts use a 6-column × 9-row room. The outer wall again consumes one cell on each side, leaving a 4×7 interior with the same 28 usable item cells.
- Both room shapes contain exactly 54 total tiles. One 54-tile decorative layer can therefore reflow between the two shapes without duplicating the room or its controls.
- The room switches geometry at a container breakpoint; tile dimensions never stretch continuously with viewport width.
- The room is centered within its two-thirds desktop column and remains the first column when the item details occupy the remaining third.
- On narrow screens the detail panel stacks below the room as it does today.

Inventory growth beyond 28 distinct item stacks is deliberately out of scope and remains future work.

## 4. Item cells and interaction

The approved room art is decorative beneath the existing inventory contract:

- owned stacks occupy interior floor cells in their existing deterministic order;
- each item remains a native button with its full accessible name and quantity;
- potion art remains centered at its current crisp size and does not scale with room width;
- the gold quantity badge stays in the upper-right with its hard-edged dark shadow;
- selected, hover, and keyboard-focus treatments remain visible without moving the tile;
- clicking a stack continues to populate the existing details and Drink action;
- polling continues to preserve the selected SKU when the stack still exists; and
- the empty state appears over the interior floor while the room remains visible.

No product title is added inside an item cell.

## 5. Rendering boundary

The server-rendered EJS view owns two layers:

1. a 54-tile decorative layer for walls, floor, moss, and the top-row shadow; and
2. a 28-cell interactive layer inset by one tile on every side.

At the responsive breakpoint, CSS reflows those layers from 9×6 / 7×4 to 6×9 / 4×7. The same item buttons and accessible names remain in the DOM, so no duplicate controls are exposed to keyboard or assistive-technology users.

The browser refresh path updates only the 28-cell item layer. It must recreate the existing item-button contract without rebuilding or changing the decorative layer.

The CSS owns:

- exact atlas dimensions and coordinates;
- Duskstone and Thornwind wall variants;
- the shadow overlay;
- wide and narrow snapped geometry; and
- item, selection, focus, and empty-state layering.

Decorative tiles remain hidden from assistive technology. If the world sheet fails to load, the existing dark background and all item controls remain usable.

## 6. Test and review strategy

### Automated

- Rendering tests reject the obsolete crack, moss-accent, and door elements.
- Rendering tests assert the room's decorative grid and 28 usable item positions.
- CSS tests assert the verified sheet sizing, approved Duskstone/Thornwind coordinates, five-cell moss patches, shadow overlay, and the 9×6 / 6×9 snapped geometries.
- Client tests continue to cover title-free item cells, selection persistence, filters, and polling updates.
- Live Dungeon CSS tests assert the 12px row gap and 6px Today heading gap.
- The complete test suite and typecheck must remain green.

### Visual

Using the disposable local potion demo:

1. review Today at a wide viewport and a narrow viewport;
2. review populated Inventory at both snapped room geometries;
3. confirm the plain Duskstone floor has no tile bleed;
4. confirm the two five-cell Thornwind patches are the only moss treatment;
5. confirm the TV floor shadow sits over the first floor row and beneath the top wall;
6. confirm there is no door or additional decoration; and
7. select and activate both potion types to verify that the existing detail and activation flow is unchanged.

Production and Raspberry Pi testing remain out of scope for this local correction pass.

# Inventory Detail Card Alignment Design

**Date:** 2026-07-30  
**Status:** Implemented and locally approved; Pi release gate pending
**Scope:** Player Hub Inventory presentation only

## Goal

Make the wide Inventory layout feel like one balanced ledger spread: the potion detail card must match the 288px dungeon-room height, and switching between Gold and Damage potions must not move the header icon or the title's starting position.

## Observed behavior and root cause

At the 1280px review viewport, the dungeon inventory room is 432×288px. The Gold detail card is approximately 348px tall and the Damage detail card approximately 331px tall because the card has unconstrained content height and the longer Gold progress sentence wraps differently.

The header also moves between products. The shared `.hub-item-icon` rule applies `margin:auto`; inside the flex header, those automatic margins absorb the remaining width based on the selected potion title. Gold and Damage therefore place both the icon and title at different horizontal coordinates.

## Approved wide-layout design

- Keep the approved 432×288px inventory room unchanged.
- Make `.hub-item-detail` exactly 288px tall at wide, side-by-side layouts, including its border and padding. Use `box-sizing:border-box` and 12px padding.
- Compact the card's vertical rhythm so the existing header, five metadata rows, optional active-progress line, and action button fit without clipping or scrolling: metadata rows use an 11px font with 5px row gaps, the metadata block begins 10px below the header, and active progress uses an 8px top gap with 7px padding.
- Keep the action button anchored to the bottom of the card by making the detail content fill the available card height and allowing the button's top margin to absorb the remaining space. Changing progress-copy length must not move the button.
- Use one shared two-column ledger grid for the header and metadata:
  - column one is a 70px label/icon rail;
  - column two is the flexible value/title rail;
  - the columns use a 10px gap;
  - the potion icon stays left-aligned and fixed within column one;
  - the tier and potion title begin at exactly the same horizontal coordinate as the metadata values below;
  - metadata labels begin at the same horizontal coordinate for every potion.
- Override automatic icon margins inside `.hub-item-detail-head`; inventory-slot icons retain their existing centered behavior.
- The card remains top-aligned with the inventory room. Both bottom edges align at wide widths.

## Responsive behavior

At the existing `@container (max-width:739px)` breakpoint, Inventory stacks vertically. In this stacked layout:

- the approved room geometry and its separate 520px atlas switch remain unchanged;
- the detail card and its content return to automatic height rather than reserving 288px, and the action button returns to its normal 14px top margin;
- the fixed header/value columns remain in effect so potion switching still does not move content;
- no card may overlap the room or extend beyond the player-hub panel.

## Visual language

This is a precision pass, not a redesign. Preserve the purple ledger card, gold tier label, pixel potion artwork, existing typefaces, borders, and dungeon-room art. The inventory room remains the signature visual; the detail card should become quieter and more disciplined beside it.

## Interaction and accessibility

- Potion selection, focus behavior, polling, activation confirmation, inventory quantities, and active-effect text are unchanged.
- Do not truncate product names, effects, progress text, or button labels.
- Keyboard focus and disabled-button treatments remain unchanged.
- No additional motion is introduced.

## Verification contract

Automated coverage must prove:

- the wide detail card uses a 288px border-box height;
- the detail header and metadata use the same fixed first-column width;
- the header icon no longer inherits automatic margins;
- the action area is bottom-anchored;
- the 739px stacked layout restores automatic detail-card height;
- existing 739px stacking and 520px room-geometry behavior remain intact.

Browser verification must compare Gold and Damage at a wide viewport and confirm:

- detail-card top and bottom match the room;
- icon, title, label, and value starting coordinates do not change when the selected potion changes;
- all progress and button content fits within the card;
- the stacked medium-width layout remains readable without overlap.

## Out of scope

- Inventory room artwork or geometry changes
- Potion copy or game-balance changes
- Inventory data, activation, or polling changes
- New item types or support beyond the existing 28 inventory cells

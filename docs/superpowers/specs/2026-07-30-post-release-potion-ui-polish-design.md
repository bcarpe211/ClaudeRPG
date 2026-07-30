# Post-release potion UI polish

Date: 2026-07-30
Status: approved

## Goal

Correct four issues found during the first production potion purchase and use
without changing potion economics, activation, inventory, or wardrobe behavior.

## Marketplace feedback

The one-time potion purchase result remains visible after the redirect, but it
becomes a compact notice contained within the marketplace content boundary. Its
declared width must include padding and borders at every viewport size.

The quantity helper keeps exact affordability feedback when a purchase cannot be
covered. When affordable, it shows product-specific guidance instead of the
generic `Your purse is ready for N` copy:

- Gold: `Ready to turn hard work into bonus gold.`
- Damage: `Ready to put more force behind every hit.`

Changing quantity must preserve the correct line for that potion.

## Inventory detail card

The potion detail card must contain its action button in every state, including
the longer disabled labels shown after activation. The detail surface may grow
when its content requires more room; on wide layouts it should continue to align
visually with the inventory room at its normal content height.

## Live fight ledger

The player hub receives every participant with positive damage in the current
fight, using the existing damage-descending and player-ID tie-break order. The
leaderboard card keeps its place beside the dungeon and uses an internal vertical
scroll area when the list is taller than the card. Keyboard and wheel scrolling
must work without expanding the overall live layout.

## Verification

- A shop client test proves each affordable potion keeps its own guidance while
  quantity changes and unaffordable selections still report the missing gold.
- A player-hub state test proves more than five fight participants are returned
  in deterministic order.
- CSS regression checks cover contained purchase feedback, the fitting inventory
  action, and the bounded scrollable leaderboard.
- Targeted tests, the full test suite, typecheck, and a browser review at wide and
  narrow sizes must pass before release.

## Out of scope

- Potion prices, effects, limits, duration, and active-time accounting.
- Purchase redirect behavior.
- The TV leaderboard and its rotation.
- Automatically deploying these corrections to the Pi.

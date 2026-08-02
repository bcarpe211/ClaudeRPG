# Runtime Raiders Treasure Motion and Footer Cleanup Design

**Date:** 2026-08-02  
**Status:** Approved interaction design; awaiting written-spec review  
**Scope:** Shared web shell motion and footer presentation only

## Goal

Make the decorative gutter treasure feel naturally scattered on page load and
remove the abrupt disappearance when a full-frame page crosses the 1432px
viewport boundary. Remove the one-pixel footer separator everywhere the shared
dungeon shell is used, including Home, Create Raider, Raider Login, and Admin
Login.

## Confirmed Current Behavior

- Every gutter treasure animation has a `0s` delay, so all ten pieces begin at
  the same keyframe position even though their durations differ.
- At 1432px the treasure rails render; at 1431px the responsive rule changes
  both rails directly to `display:none`, producing an instantaneous cut.
- The landing stylesheet overrides the shared footer border, but Create Raider,
  Raider Login, and Admin Login still inherit the shared `1px` border.

## Treasure Starting Phases and Speeds

The motion stays deterministic: it should look varied without introducing
runtime randomness, JavaScript, or layout-dependent state.

Each treasure receives its own fixed negative animation delay so it enters the
animation at a different phase on first paint. Durations remain close enough to
feel like one ambient system but are no longer arranged as a simple integer
sequence.

| Side | Treasure | Duration | Initial delay |
| --- | --- | ---: | ---: |
| Left | cyan orb | 9.4s | -2.1s |
| Left | book | 11.2s | -7.4s |
| Left | key | 12.8s | -4.9s |
| Left | amulet | 10.3s | -8.6s |
| Left | crown | 13.6s | -1.3s |
| Right | coins | 12.1s | -6.2s |
| Right | scroll | 9.7s | -3.8s |
| Right | red gem | 13.2s | -9.1s |
| Right | gold ring | 10.8s | -5.4s |
| Right | potion | 11.6s | -10.3s |

The existing vertical positions, sprite scales, per-item horizontal offsets,
opacity, and bobbing distance remain unchanged.

## Wall Retreat and Re-entry

The 1431px responsive boundary will no longer use `display:none` for full-frame
treasure rails. Instead:

- The left rail translates fully toward the left edge and the right rail toward
  the right edge over **260ms**.
- Rail opacity fades to zero over **140ms**, beginning **90ms** into the retreat,
  so the wall remains the visible reason the treasure disappears.
- `visibility:hidden` applies only after the 260ms retreat completes. This keeps
  hidden treasure out of painting and accessibility while preserving a
  reversible CSS transition.
- When the viewport widens back to 1432px or greater, visibility returns
  immediately and both rails slide back out from behind their walls over the
  same 260ms interval.
- A rail has a minimum width equal to the current wall width. This prevents an
  invalid or collapsing calculated width at small viewports while the hidden
  rail is parked off-screen.

This is CSS-only. There will be no resize listener, timer, DOM mutation, or new
client script. A page first loaded below the breakpoint paints the rails in
their already-hidden state, avoiding an entrance flash.

## Reduced Motion

Under `prefers-reduced-motion: reduce`, both the treasure bobbing animation and
the new rail transitions are disabled. The responsive state changes
immediately, without creating motion the player asked to avoid.

## Footer Separator

The separator is removed from the shared `.foot` rule in `dungeon.css`, making
`border-top:0` the default for every page using the dungeon layout. The
landing-only override is deleted because it is no longer needed. Other borders
inside panels, forms, tables, and landing content are not changed.

## Testing and Visual Verification

Automated regression coverage will verify:

- all ten treasure entries expose distinct fixed negative delays and the
  approved durations;
- the animation consumes the per-item delay;
- the 1431px rule uses directional transforms, opacity, delayed visibility, and
  no `display:none`;
- the rail minimum width remains wall-safe;
- reduced-motion disables both animations and transitions;
- the shared footer rule has no top border and the redundant landing override
  is absent; and
- Home, Create Raider, Raider Login, and Admin Login continue to render through
  the shared footer.

Live review will cover 1440px, 1432px, 1431px, and 390px widths. It will confirm
staggered initial positions, inward retreat, outward re-entry, no horizontal
overflow, no console errors, and a computed `0px none` footer border on Home,
Create Raider, Raider Login, and Admin Login.

## Boundaries

- No changes to scoring, collection, companion packaging, registration logic,
  authentication, database state, deployment, DNS, Caddy, or the Pi.
- The full-frame treasure treatment remains decorative and `aria-hidden`.
- Lite-frame pages remain treasure-free.
- Protected local untracked paths remain untouched and unstaged.

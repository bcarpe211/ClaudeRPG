# Wardrobe Responsive Controls and Shop Completion Design

**Date:** 2026-07-27

**Status:** Approved visual direction; awaiting spec review

**Branch:** `feat/player-shop-cosmetics`

## 1. Goal

Finish the Wardrobe and Gilded Mimic presentation pass without changing the
approved cosmetic entitlement, slot-map, or save model. This increment keeps
the decorative dungeon frame from covering content at narrow widths, gives the
Wardrobe controls a clear editing flow, adds a token-preserving Store shortcut,
and makes a completed Wardrobe transition naturally into the existing closed
Bazaar scene.

This design refines the implemented
`2026-07-26-wardrobe-bazaar-polish-design.md`; it does not replace that design's
atomic batch save, revision conflict, animation, or marketplace requirements.

## 2. Confirmed interaction flow

The Wardrobe tool order is:

1. select a cosmetic channel;
2. choose a hue;
3. adjust Tone;
4. apply an optional material finish or Restore Default;
5. save or discard the complete draft.

The compact action strip therefore belongs below the material finishes and
Restore Default. It must not interrupt the color controls or sit above Tone.

### 2.1 Restore Default, Discard, and Reload

These controls have intentionally different scopes:

- **Restore Default** clears the draft rule for only the active channel. It is
  an unsaved edit and does not write until Save is pressed.
- **Discard** replaces the complete draft with the saved baseline already held
  by the page. It makes no request.
- **Reload** fetches the latest saved Wardrobe by reloading the page. It is a
  conflict-recovery action for a stale browser copy, not a normal editing
  action.

Reload remains hidden during ordinary editing. It appears only after the server
rejects a save as stale. In that state, Save and Discard retain the existing
conflict-safe behavior and Reload becomes the available recovery path.

Compact visible labels are `Reload`, `Discard`, and `Save`. Each keeps its
existing accessible name or receives an explanatory title so the full concepts
remain available to assistive technology. Icons are decorative and hidden from
the accessibility tree.

## 3. Character profile and Store shortcut

The character profile header becomes a named layout component instead of an
inline-only flex group. The animated character, identity, and connection line
stay on the left. A gold **Store** button sits at the upper right of this
authenticated player card.

The Store URL includes the current character token:

`/shop?token=<encoded player token>`

The shortcut does not move into the global navigation. The global navigation
has no player context, while this action must preserve the authenticated
character. At narrow widths the Store button wraps below the identity rather
than overlapping the avatar or text.

The existing `Unlock the next tier` action remains in the Dye Workbench while a
tier is available. The profile-level Store shortcut remains visible after
mastery so future wares are always reachable.

## 4. Wardrobe workbench presentation

### 4.1 Saved status

The live save status moves from the toolbox action row to the upper-right corner
of the live-fitting stage. The stage label remains at the upper left. The status
keeps `role="status"` and `aria-live="polite"` and continues to render Saved,
Unsaved changes, Saving, and failure states from the existing draft controller.

The status is a compact stage badge and must not change the character's vertical
position or consume color-control space.

### 4.2 Tone and material controls

Tone remains immediately above the four equal material rows:

1. Forged steel;
2. Aged bronze;
3. Royal gold;
4. Restore default.

The range track and its focus ring must visually reach both the Black and White
endpoints without extra horizontal input padding. Restore Default keeps its
larger, unsquashed arrow icon and the same row dimensions as the three presets.

### 4.3 Action strip

A small `Wardrobe changes` label separates the edit controls from the final
actions. The action strip follows Restore Default and uses joined, compact
buttons with a shared border and equal widths. Normal editing shows Discard and
Save; the hidden Reload control occupies its first position only when stale
conflict recovery is required.

Buttons use the same height, corner language, font scale, and restrained hover
treatment as the material rows. Discard is neutral; Save uses the gold primary
treatment. Short labels and small icons prevent overlap without reducing the
tap target below 39 pixels.

No JavaScript save semantics change in this pass. Save still writes all dirty
channels in one transaction, Discard remains local, and Restore Default remains
staged.

## 5. Responsive dungeon safe area

Purple panels must remain inside the visible moss-wall boundary. The wall is the
authoritative safe-area edge; floating loot is decorative and may disappear
earlier.

The responsive shell follows these rules:

- Above the existing loot cutoff, the current centered 1120-pixel shell and
  loot rails remain unchanged.
- At and below the loot cutoff, loot rails are hidden and the header, main
  content, and footer receive inline padding that clears each moss wall plus a
  small visual gap.
- At tablet and phone breakpoints, `--wall` narrows in steps and the shell gap
  follows it. This preserves usable card width while keeping every panel fully
  between the walls.
- The moss texture remains pixelated and tiled at the active wall width. Torch
  art scales with or remains contained by the narrowed wall.
- Existing one-column Wardrobe and Bazaar layouts continue below their current
  breakpoints. Cards may stack, but they may not extend underneath a wall or
  create horizontal scrolling.

This is a shared dungeon-shell correction, not a Bazaar-only negative margin or
one-page clipping workaround. It protects Character, Shop, and other full-frame
pages consistently.

## 6. Completed Wardrobe shop states

The Bazaar has three relevant authenticated states:

1. **Offer available** — render the current permanent Wardrobe upgrade card.
2. **Final tier just purchased** — render `Dye Mastery Complete` once as the
   immediate success/celebration state.
3. **No products available** — render the existing closed-stall scene with its
   mimic, CLOSED sign, merchant note, and Wardrobe link.

The final purchase redirect already carries `result=success`. When the resulting
view is both successful and mastered, that signal selects the one-time mastery
card. Client code then removes only the `result` query parameter with
`history.replaceState`, preserving the token and the rendered success state.
Refreshing the cleaned URL therefore shows the closed Bazaar instead of
repeating the completion card.

The Adventurer Ledger remains visible in offer, mastery-success, and closed
states. It permanently records `Wardrobe Tier 3 — Mastered`, so completion is
still visible after the sales card disappears and when future products are
added. The profile Store link and ledger Return to Character action remain
available in the closed state.

The closed state means there are no current products, not merely that Wardrobe
Tier 3 is owned. A future consumable, loot-box, pet, or other offer should return
the Bazaar to its normal product presentation without changing Wardrobe
mastery.

Unauthenticated and invalid-token states retain their current login/error
behavior.

## 7. Accessibility and reduced motion

- Save status remains a polite live region.
- Joined controls preserve visible focus outlines and usable keyboard order.
- Button icons do not replace readable labels.
- The Store button has a normal anchor focus state and an unambiguous label.
- The closed Bazaar reuses meaningful mimic alt text and keeps decorative
  sparks hidden from assistive technology.
- Existing `prefers-reduced-motion` handling remains authoritative for sprite,
  purchase, and decorative motion.

## 8. Verification

Automated coverage must prove:

- Character renders a token-preserving Store link.
- Save status is inside the live-fitting stage.
- Tone and finishes precede the action strip in document order.
- Reload is hidden in the initial saved state and is still revealed by a stale
  save response.
- Restore Default stages one active-channel clear, Discard restores the full
  saved baseline locally, and neither writes by itself.
- A mastered player with `result=success` sees `Dye Mastery Complete`.
- The same mastered player without a result sees the closed Bazaar and no
  mastery product card.
- The Adventurer Ledger shows Tier 3 mastery in both completed states.
- The one-time result cleanup preserves the token.
- Responsive CSS defines wall-aware shell insets and stepped wall widths.

Manual browser verification covers desktop, tablet, and narrow phone widths:

- no purple panel crosses a moss wall;
- no action label or button overlaps;
- Saved status stays in the fitting-stage corner;
- Store wraps cleanly in the player card;
- the final purchase shows mastery immediately, then refresh shows the closed
  mimic scene;
- the Wardrobe controls remain keyboard-operable and visually ordered as
  approved.

The final implementation gate remains `npm test`, `npm run typecheck`, and a
JavaScript syntax check for modified public scripts.

## 9. Out of scope

This increment does not change:

- slot maps, cosmetic channel availability, or tier entitlement prices;
- cosmetic rule rendering, presets, or atomic transaction behavior;
- inventory storage or future product domain models;
- timed consumables, loot boxes, gems, pets, or combat balance;
- production deployment, Pi restart, or live database state.

# Wardrobe Stage and Navigation Toast Design

**Date:** 2026-07-27

**Status:** Implemented and locally approved; Pi release gate pending

**Branch:** `feat/player-shop-cosmetics`

## 1. Goal

Refine the live-fitting stage header and prevent ambiguous navigation while a
player has unsaved Wardrobe changes. This is a focused follow-up to
`2026-07-27-wardrobe-responsive-controls-and-shop-completion-design.md`. It does
not change cosmetic entitlements, saved data, or the existing atomic batch-save
model.

## 2. Live-fitting stage

### 2.1 Remove the center guide

The faint vertical line through the live-fitting stage comes from a decorative
center-guide gradient, not from the sprite or canvas. Remove that gradient
layer. Keep the dark vertical stage gradient, character shadow, and sprite drop
shadows unchanged.

### 2.2 Compact and align the status

`Live fitting` and the save-status badge move into one absolutely positioned
header wrapper across the top of the stage. The wrapper vertically centers the
two visible contents rather than merely assigning them the same top coordinate.

Reduce the status badge's horizontal and vertical padding, internal gap, status
dot, and font size enough that `Unsaved changes` fits beside `Live fitting`
without touching or wrapping at the narrowest supported stage width. Longer
error text may wrap inside the badge, but may not overlap the label or escape
the stage. Preserve the existing Saved, Unsaved changes, Saving, and error
colors and status text. The status remains a polite live region, and the
absolute header must not move the animated character.

## 3. Guarded Wardrobe navigation

### 3.1 Guarded actions

The authenticated **Store** shortcut and **Unlock the next tier** link are
guarded while the Wardrobe draft has unsaved operations or an unresolved save
attempt. With a clean draft they navigate normally and show no toast.

The existing `beforeunload` protection remains as a fallback for browser Back,
Refresh, closing the tab, and other navigation outside these two known links.
The custom guard does not replace revision-conflict handling.

### 3.2 Action toast

Clicking either guarded link with pending changes prevents immediate
navigation and opens one action toast. Repeated clicks update the toast's
pending destination instead of stacking multiple notices.

The toast uses this thematic copy:

> **The tailor catches your sleeve!**
> You still have unfinished dye work on the fitting table. Save it before
> heading out, or leave it behind.

For an ordinary unsaved draft with no unresolved request, it provides three
choices:

- **Save & Continue** is the gold primary action. It invokes the same atomic
  save path as the Wardrobe Save button. After the server acknowledges the
  complete draft and the page has no remaining operations, it navigates to the
  captured destination.
- **Leave Without Saving** is a visually subdued action. It restores the full
  saved baseline locally, clears the pending navigation guard, and navigates to
  the captured destination without issuing a save request.
- **Close** is an accessible icon button. It dismisses the toast, clears the
  pending destination, and leaves the draft untouched so the player can keep
  editing.

The toast is fixed within the viewport, does not shift page layout, and remains
inside the moss-wall safe area at all supported widths. It uses `role="alert"`
because it explains why the requested navigation did not occur. Keyboard focus
moves to **Save & Continue** when the toast opens; closing it returns focus to
the link that triggered it. Escape performs the same action as Close.

### 3.3 Save outcomes

The toast must wait for the existing save operation to finish:

- On success with no newer edits, navigate to the captured destination.
- If the player edits again while the save is in flight, remain on the
  character page, keep the newer draft visible, and update the toast to explain
  that more changes still need saving.
- If a normal Wardrobe save is already in flight when a guarded link is
  selected, capture the destination and show a non-destructive waiting state.
  Apply the same success and newer-edit rules when that request finishes.
- On an ambiguous network failure, remain on the page and preserve the current
  retry-safe save attempt. The toast reports that the fitting could not be
  confirmed and offers **Retry Save** plus Close. **Leave Without Saving** is
  unavailable because the server may already have accepted the attempt; the
  toast must not discard or navigate automatically.
- On stale, rejected, forbidden, or expired-session responses, remain on the
  page and defer to the existing refresh-required state. Reload becomes
  available in the Wardrobe action strip; the toast explains that the ledger
  must be reloaded and does not offer navigation that could hide the conflict.

The normal Wardrobe Save button continues to save without navigating. The
action toast reuses the save controller rather than creating a second request
format or bypassing revision and retry protections.

## 4. Accessibility and motion

- The toast actions have visible focus states and readable labels; icons are
  decorative except for the labelled Close control.
- Toast appearance may use a short pixel-style rise or pop, but it must be
  disabled under `prefers-reduced-motion`.
- The toast remains legible without relying on color alone.
- Destructive navigation is never the initial focus or primary-colored action.

## 5. Verification

Automated coverage must prove:

- the stage no longer contains the center-guide gradient;
- the compact status and label have non-overlapping layout rules;
- Store and Unlock navigate normally with a clean draft;
- both links are blocked by a dirty draft and open one toast with the captured
  destination;
- Save & Continue sends the existing atomic batch request once and navigates
  only after acknowledged success;
- newer edits made during Save & Continue prevent navigation;
- Leave Without Saving restores the saved baseline, sends no request, and
  navigates;
- Close and Escape retain the draft and do not navigate;
- ambiguous and definitive save failures preserve the existing retry/conflict
  guarantees;
- `beforeunload` still protects dirty drafts outside the guarded-link flow.

Manual browser verification covers a saved and dirty Wardrobe at desktop,
tablet, and phone widths. Confirm that the long status does not touch `Live
fitting`, the vertical guide is gone, the toast stays between the walls, focus
returns correctly, and both guarded destinations resume after the chosen
action.

The implementation gate is `npm test`, `npm run typecheck`, and a JavaScript
syntax check for modified public scripts.

## 6. Out of scope

This increment does not change Wardrobe prices, entitlement tiers, slot maps,
sprite rendering, the closed Bazaar, future products, or production deployment.

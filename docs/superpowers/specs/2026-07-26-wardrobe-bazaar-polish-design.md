# Wardrobe and Gilded Mimic Polish Design

**Date:** 2026-07-26

**Status:** Approved for implementation

**Branch:** `feat/player-shop-cosmetics`

## 1. Goal

Polish the approved three-tier cosmetic experience before it ships. The
Wardrobe should support deliberate, atomic edits without save-status thrashing.
The Bazaar should feel like a compact, reusable fantasy marketplace rather than
one oversized upgrade card.

This pass also fixes the stale character appearance observed after navigating
from the Wardrobe to the Bazaar and then using the browser Back button.

## 2. Scope

This design includes:

- explicit, atomic saving of all edited cosmetic channels;
- animated A/B character previews in the player menu and Wardrobe;
- compact Tone, material preset, and Restore Default controls;
- personalized-page cache and history-restoration safeguards;
- a branded, reusable Bazaar shell named **The Gilded Mimic**;
- a compact permanent Wardrobe upgrade card;
- a sticky Adventurer Ledger with player-facing marketplace context;
- a slot-aware, read-only demonstration of the channels in the next tier;
- a short purchase celebration with an accessible reduced-motion alternative.

This design does not add inventory storage, consumables, loot boxes, gems,
pets, combat bonuses, product grids populated with future products, or any
production deployment work.

## 3. Confirmed stale-history cause

The personalized Character response currently has no explicit cache policy. A
browser history restore can revive old server-rendered cosmetic data and
browser-restored form values. During reproduction, the restored Tone value and
its rendered label disagreed even though a full refresh loaded the persisted
cosmetics correctly.

The fix has two layers:

1. Personalized Character and Bazaar responses send `Cache-Control: private,
   no-store`.
2. The cosmetic page detects a back-forward-cache `pageshow` restoration and
   reloads once from the server.

The immutable, content-addressed PNG skin responses retain their long-lived
public cache headers.

## 4. Wardrobe interaction model

### 4.1 Saved and draft configurations

The browser maintains two configurations:

- **saved configuration** — the last configuration acknowledged by the server;
- **draft configuration** — the configuration currently shown in the preview.

Hue, Tone, material presets, and Restore Default update the draft and preview
immediately. They do not write to SQLite while the player drags or experiments.

The page has four stable states:

- **Saved** — draft and saved configurations match;
- **Unsaved changes** — one or more channels differ;
- **Saving** — one batch is in flight;
- **Save failed** — the draft remains available to retry.

The rapidly alternating “Change queued” and “All changes saved” statuses are
removed.

### 4.2 Save and discard

The workbench action row contains:

- **Save Changes** — saves every dirty channel in one transaction;
- **Discard Changes** — restores the complete saved configuration locally.

Save Changes is disabled when the draft is clean or while a save is in flight.
Discard Changes is disabled when the draft is clean.

Restore Default applies only to the active channel and is staged like every
other edit. It does not bypass Save Changes.

If the player attempts to leave while the draft is dirty, the browser presents
its standard unsaved-changes warning. The page does not silently flush draft
edits during `pagehide` or `beforeunload`.

### 4.3 Atomic batch endpoint

The browser submits one authenticated `application/x-www-form-urlencoded`
request. The body carries the issued mutation session, one increasing revision,
and a serialized list of dirty channel operations. Each operation is either:

- `set`: slot, recipe, optional hue, and Tone; or
- `clear`: slot.

The server validates the complete batch before mutation:

- player token;
- issued session and revision;
- class and gender channel availability;
- current Wardrobe tier entitlement;
- operation shape, recipe, hue, and Tone bounds;
- duplicate slots and the maximum possible operation count.

All operations and their revision tombstones are written in one SQLite
transaction. Any invalid, locked, stale, or failed operation rejects the entire
batch. No partial cosmetic configuration is visible.

A successful response returns the canonical entitled configuration and its
content hash. That response becomes the browser's new saved baseline.

Existing single-channel endpoints remain available for compatibility in this
pass, but the Wardrobe UI no longer calls them.

## 5. Wardrobe presentation

### 5.1 Character preview

Both the profile-header character and the workbench character alternate their
A/B animation frames. Draft colors apply to both frames with their corresponding
slot maps.

The “`<channel> selected`” bubble beneath the character is removed. The active
channel button already communicates selection.

The workbench stage uses a soft black ground shadow instead of the brown
platform. The character receives a deeper layered drop shadow so it appears to
float above the stage without losing its pixel-art edge.

### 5.2 Tone and material controls

The Tone range receives a custom pixel-style track whose visible fill reaches
the Black and White endpoints. Keyboard interaction and focus treatment remain
fully available.

The material controls become four compact, equal, full-width rows:

1. Forged Steel
2. Aged Bronze
3. Royal Gold
4. Restore Default

The Restore Default arrow is redrawn or replaced with a larger, unsquashed icon
that has the same visual weight as the material swatches.

## 6. Bazaar presentation

### 6.1 Marketplace shell

The shop is branded **The Gilded Mimic**. Its purple card background remains,
but the page gains a compact merchant header decorated with existing pixel item
assets such as potions, weapons, shields, coins, and gems.

The shell must support later small product cards without redesigning the page.
This pass implements only the next permanent Wardrobe upgrade or the completed
mastery state.

### 6.2 Product-card template

The permanent upgrade uses the shared product-card structure:

- product category/icon;
- title;
- tier badge;
- one concise description;
- price/action row;
- result or affordability message.

For this product the title is:

> Permanent Wardrobe Upgrade — Tier X

The description follows this pattern:

> The merchant is offering a permanent upgrade to your dye ledger, which
> unlocks Belt, Boots, and Gold Trim customizations.

The channel names are generated from the authoritative class/gender entitlement
registry. The card does not repeat the player name, show gold on hand, include
an oversized sales heading, or contain the Return to Character link.

The purchase button remains prominent and playful, but the complete card is
substantially tighter than the current ledger.

### 6.3 Player preview

The circular backdrop behind the Bazaar character is removed. A stronger,
multi-layer drop shadow gives the animated character a polished floating
silhouette.

Only channels granted by the next offer demonstrate new colors. Each offered
slot independently transitions through a small palette of two or three colors
with a different duration and phase. The effect uses the actual A/B source
frames and slot maps; it must not apply one whole-sprite CSS hue rotation.

The demonstration is local canvas animation only. It never writes a cosmetic
rule or changes the player's saved appearance.

### 6.4 Adventurer Ledger

A sticky bottom bar within the marketplace shows:

- current gold;
- current Wardrobe tier;
- **Inventory — Coming Soon**;
- small Coming Soon teasers for potions, loot boxes, and pets;
- a permanent **Return to Character** button.

No inventory table or future item model is introduced. Below the existing
760-pixel responsive breakpoint, the ledger wraps to two compact rows without
horizontal overflow or obscuring the purchase action.

The ledger remains present in next-offer and mastery states.

## 7. Purchase celebration

The purchase form is progressively enhanced. On activation:

1. disable the button immediately to prevent duplicate clicks;
2. update its label to a forging state;
3. apply a short, contained jolt to the offer card;
4. emit existing item sprites from behind the button;
5. grow and move the sprites outward while sparks fade;
6. submit the unchanged server-authoritative purchase form after approximately
   1.2 seconds.

The visual burst must remain clipped or positioned so it cannot change document
dimensions or introduce scrollbars. The purchase route retains its atomic tier,
gold, and duplicate protections.

With `prefers-reduced-motion: reduce`, skip the jolt and flight paths, show a
brief glow, and submit immediately.

If client JavaScript is unavailable, the form submits normally with no
celebration.

## 8. Error handling

- A batch validation failure changes no channels and keeps the draft visible.
- A network failure produces **Save failed** and leaves Save Changes enabled for
  retry.
- A stale mutation session prompts a page refresh rather than overwriting newer
  cosmetic state.
- A failed purchase remains governed by the existing server result states. The
  pre-submit motion is presented as a forging attempt; only the server-confirmed
  result page presents ownership or deducted gold.
- Missing optional marketplace art falls back to the card without breaking the
  purchase flow.
- The history safeguard must not create a reload loop.

## 9. Accessibility and motion

- All sliders retain keyboard controls and visible focus rings.
- Save status remains a polite live region and changes only at meaningful
  boundaries.
- Buttons expose disabled and pressed states correctly.
- Animated preview canvases have useful accessible labels; decorative item
  sprites are hidden from assistive technology.
- All new movement respects reduced-motion preferences.
- Purchase confirmation remains readable without relying on animation, color,
  or sound.

## 10. Verification

Automated tests must cover:

- atomic multi-channel set/clear and rollback;
- authentication, entitlement, duplicate-slot, bounds, and stale-revision
  rejection;
- canonical response configuration and hash;
- draft editing without network writes;
- one-request Save Changes behavior;
- discard, retry, and unsaved-navigation warning behavior;
- stable save-state transitions;
- A/B draft rendering and active slot-map parity;
- private no-store headers and one-time history restoration;
- exact compact material-control order and Restore Default semantics;
- next-offer slot-only color animation;
- purchase lock, delayed submit, and reduced-motion behavior;
- Adventurer Ledger contents in next-offer and mastery states;
- desktop and mobile overflow/layout constraints.

The final browser gate uses a fresh temporary database and verifies:

- a Tier 1 Wardrobe draft spanning multiple channels;
- Save, refresh, Bazaar navigation, and Back navigation preserving the result;
- animated male and female A/B previews;
- Tier 1, Tier 2, Tier 3, and mastery Bazaar states;
- independent color motion on the next offer's channels;
- the purchase celebration and reduced-motion fallback;
- desktop and narrow mobile layouts.

No production database, Pi, deployment, push, or merge is part of this design.

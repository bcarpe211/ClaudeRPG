# Cosmetic Tier Entitlements, Tone, and Bazaar Reopening Design

**Date:** 2026-07-25
**Status:** Approved for implementation planning
**Track:** Player Shop Phase 1 — complete the cosmetic product after slot-map Phase 2C
**Branch:** `feat/player-shop-cosmetics`

## 1. Outcome

Reopen the Bazaar with three sequential, permanent cosmetic upgrades. A player
buys Tier 1, then Tier 2, then Tier 3. Each purchase unlocks a class- and
gender-specific group of dye channels in the Wardrobe on the character page.

The complete product costs 6,000,000 gold:

| Upgrade | Price | Purchase result |
|---|---:|---|
| Tier 1 | 1,500,000g | Unlock Tier-1 channels and reveal the Tier-2 offer |
| Tier 2 | 2,000,000g | Unlock Tier-2 channels and reveal the Tier-3 offer |
| Tier 3 | 2,500,000g | Unlock Tier-3 channels and remove the purchase card |

The target is approximately two weeks of work for the full unlock. Purchases
remain cosmetic-only and have no combat, token, gold-generation, or leaderboard
effect.

This design also completes the color controls:

- a hue wheel;
- a continuous **Tone** slider from shaded black, through the chosen hue, to
  shaded white;
- Forged Steel, Aged Bronze, and Royal Gold material presets;
- Restore Default.

The Bazaar owns purchases. The character page owns customization.

## 2. Position in the shop roadmap

This work begins only after the animated male/female slot-map roster has been
approved. It completes the cosmetic product before the separate timed-consumable
phase begins.

Related documents:

- `docs/superpowers/specs/2026-07-21-player-shop-cosmetics-design.md` — original
  shop foundation and single-wheel slice;
- `docs/superpowers/specs/2026-07-24-cosmetic-slots-phase2c-female-review-design.md`
  — complete male/female map and review design;
- `docs/superpowers/plans/2026-07-24-cosmetic-slots-phase2c-complete-roster.md`
  — completed Phase-2C implementation and visual-approval gate.

Where those documents describe one dominant-color channel or a single purchase
unlocking every mapped channel, this document supersedes them.

## 3. Goals

1. Turn the approved slot maps into three cumulative player entitlements.
2. Preserve the exact class and gender channel inventory approved in the animated
   review.
3. Keep purchases sequential, atomic, idempotent, and server-authoritative.
4. Reopen the Bazaar as the fun purchase surface while keeping the dye workbench
   on the character page.
5. Add the requested continuous black/white Tone control without flattening the
   sprite's pixel shading.
6. Use one authoritative channel registry for labels, gender availability,
   entitlement tiers, the Wardrobe, and the review page.
7. Preserve saved customization when a player changes class or gender.

## 4. Non-goals

- Timed damage or gold consumables.
- Token boosts. Tokens remain work-earned.
- Loot boxes, equipment-part progression, gems, pets, or permanent combat power.
- Weapon overlays or weapon swapping. Tier 3 recolors the authored weapon pixels.
- New sprite artwork or additional slot-map authoring.
- New cosmetic tiers beyond Tier 3.
- Paying again to change a color after its channel is unlocked.

## 5. Approved entitlement rules

### 5.1 Player-wide cumulative ownership

`player_cosmetics.wheel_tier` remains the highest cosmetic tier owned:

- `0`: no dye entitlement;
- `1`: Tier 1;
- `2`: Tiers 1 and 2;
- `3`: Tiers 1, 2, and 3.

Ownership belongs to the player, not to a class, gender, slot, or saved color.
Changing class or gender never lowers `wheel_tier` and never requires another
purchase.

A channel is editable and rendered only when all three conditions are true:

1. the approved registry exposes the channel for the player's current class;
2. the registry exposes it for the player's current gender;
3. `wheel_tier >= channel.requiredTier`.

### 5.2 Sequential purchases

Only the next tier may be purchased:

| Current tier | Allowed purchase | Rejected purchases |
|---:|---|---|
| 0 | Tier 1 | Tier 2, Tier 3 |
| 1 | Tier 2 | Tier 1, Tier 3 |
| 2 | Tier 3 | Tier 1, Tier 2 |
| 3 | None | Tier 1, Tier 2, Tier 3 |

The Bazaar sends a requested tier or SKU, but the domain transaction re-reads
the player's current tier and gold. The client cannot skip prerequisites by
modifying a form.

An already-owned or stale purchase is a no-op and never charges gold. An
out-of-sequence purchase is rejected and never charges gold.

### 5.3 Exact channel map

Unmarked channels are available to both genders. `(F only)` means the channel
must be absent for male characters, not merely hidden by CSS.

The Priest Trim entry includes the approved red cap edging, male-only red left
shoulder, and the red robe edge that runs to the floor. The Priest belt remains a
separate channel.

| Class | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| Knight | Clothing; Headgear; Skin | Belt; Cape; Hair (F only); Boots; Lips (F only); Plume | Weapon; Shield |
| Thief | Clothing; Cape; Headgear; Skin | Trim; Belt; Hair (F only); Boots; Lips (F only); Feather | Weapon; Accessory |
| Ranger | Clothing; Cloak; Headgear; Skin | Trim; Belt; Boots; Lips (F only); Feather | Weapon; Quiver |
| Wizard | Clothing; Cloak; Skin | Gold trim; Belt; Boots | Weapon; Eyes |
| Priest | Clothing; Skin | Trim; Belt; Hair (F only); Boots; Lips (F only) | Weapon; Holy symbol |
| Shaman | Pelt; Skin | Clothing; Boots; Face paint; Lips (F only) | Weapon |
| Berserker | Clothing; Headgear; Skin | Helmet trim; Cape; Hair (F only); Boots; Lips (F only) | Weapon; Horns |
| Swordsman | Shirt; Clothing; Skin | Trim; Cape; Hair; Boots; Lips (F only); Details (F only) | Weapon |
| Paladin | Clothing; Headgear; Skin | Cape; Hair (F only); Boots; Lips (F only); Plume | Weapon; Shield |

### 5.4 Semantic slot aliases

The entitlement registry stores slot ids while exposing the approved semantic
labels. These aliases are part of the product contract:

| Class | Player-facing label | Material slot |
|---|---|---|
| Thief | Accessory | Shield |
| Ranger | Cloak | Cape |
| Ranger | Quiver | Shield |
| Wizard | Gold trim | Trim |
| Wizard | Cloak | Headgear |
| Wizard | Eyes | Details/Flair |
| Priest | Holy symbol | Details/Flair |
| Shaman | Pelt | Headgear |
| Berserker | Helmet trim | Trim |
| Berserker | Horns | Details/Flair |
| Swordsman | Shirt | Body |
| Swordsman | Clothing | Headgear |
| Swordsman female | Details | Details/Flair |
| Paladin | Plume | Details/Flair |

Female Lips use Face Paint except Shaman female, whose Lips use Details/Flair
because Face Paint is already the independent face-paint channel. Swordsman Hair
is available to both genders; the other Hair entries in the map are female-only.

## 6. Authoritative channel registry

Create one code-owned registry rather than storing individual grants in the
database or inferring tiers globally from slot names.

Conceptual interface:

```ts
export type CosmeticTier = 1 | 2 | 3;

export interface CosmeticChannelDefinition {
  slot: number;
  label: string;
  requiredTier: CosmeticTier;
  genders: readonly Gender[];
}

export const COSMETIC_CHANNELS: Record<
  ClassKey,
  readonly CosmeticChannelDefinition[]
>;
```

The registry declaration order is the player-facing order within each tier.
Every consumer uses shared queries such as:

```ts
channelsFor(classKey, gender)
requiredTierFor(classKey, gender, slot)
entitledChannelsFor(classKey, gender, wheelTier)
```

This registry becomes the source of truth for:

- class/gender channel availability;
- player-facing labels;
- required tiers;
- the Wardrobe's unlocked and locked groups;
- server-side dye authorization;
- render-time filtering;
- the animated review inventory;
- exact matrix-coverage tests.

`EXPECTED_CHANNELS`, class label overrides, and gender label overrides must be
derived from or replaced by this registry so the three concepts cannot drift.

A database table of individual channel grants is intentionally rejected. It
would duplicate static sprite semantics, complicate class changes, and permit
partial or inconsistent grants. Global rules such as “all Flair is Tier 2” are
also rejected because approved exceptions such as Wizard Eyes and Berserker
Horns are Tier 3.

## 7. Product catalog and pricing

Extend the SKU catalog:

| SKU | Grants | Price setting | Default |
|---|---:|---|---:|
| `cosmetic_wheel_t1` | 1 | `cosmetic_wheel_t1_price` | 1,500,000 |
| `cosmetic_wheel_t2` | 2 | `cosmetic_wheel_t2_price` | 2,000,000 |
| `cosmetic_wheel_t3` | 3 | `cosmetic_wheel_t3_price` | 2,500,000 |

All three settings belong to the Shop admin group with gold units, non-negative
minimums, and practical increments. The existing Tier-1 setting and ownership
row remain valid.

`purchase(...)` remains one SQLite transaction:

1. resolve the requested known SKU;
2. read current gold and `wheel_tier` inside the transaction;
3. require `sku.grantTier === wheel_tier + 1`;
4. require enough gold;
5. deduct exactly the configured price;
6. set `wheel_tier` to the granted tier and stamp `updated_at`;
7. return the new balance and tier.

Concurrent or repeated submissions cannot double-charge because current tier and
gold are re-read and changed inside the same transaction.

## 8. Bazaar experience

The Bazaar reopens on the full dungeon shell. It is a purchase surface, not the
place where colors are edited.

### 8.1 Before Tier 3

Show one personalized “next upgrade” card containing:

- the player's animated/current character;
- current gold;
- current tier;
- the next tier and price;
- only the channels that purchase adds for the current class and gender;
- a gold purchase button or an exact “need X more gold” state;
- a link back to the Wardrobe.

No owned product card and no later-tier purchase card is displayed. Buying Tier
1 replaces its card with Tier 2; buying Tier 2 replaces its card with Tier 3.

### 8.2 After Tier 3

The purchase card disappears. Replace it with a celebratory, non-purchasable
“Dye Mastery Complete” scene and a prominent link to the Wardrobe. There is no
disabled Tier-3 card and no fake “coming soon” Tier 4.

### 8.3 Failed purchase feedback

- insufficient gold: show the missing amount and charge nothing;
- stale/already-owned form: show the current tier and charge nothing;
- out-of-sequence or malformed purchase: reject, charge nothing, and return to
  the correct next-tier card;
- missing/invalid player token: use the existing character login flow and never
  echo or log the token.

The visual language remains the dungeon Bazaar: gold framing, pixel art, a
physical upgrade ledger or dye-vat presentation, and satisfying purchase
feedback consistent with the character page.

## 9. Character-page Wardrobe

The character page owns the live workbench.

### 9.1 Tier presentation

Show:

- current cosmetic tier;
- unlocked channel buttons grouped by tier;
- applicable locked channels grouped under their required tier;
- a concise link to the Bazaar for the next purchase.

Locked channels are visible as disabled, labelled previews so the player knows
what the next upgrade adds. Channels unavailable to the current class/gender are
absent; for example, male Knight never sees a locked Hair or Lips control.

After Tier 3, no purchase prompt is shown. The complete workbench remains.

### 9.2 Active channel controls

Every unlocked channel receives the same tools:

1. hue wheel;
2. Tone slider;
3. Forged Steel preset;
4. Aged Bronze preset;
5. Royal Gold preset;
6. Restore Default.

The three material presets plus Restore Default form a balanced 2-by-2 button
group. Blackened and Holy White are removed as discrete buttons because they are
the Tone slider endpoints.

Changes continue to preview immediately and autosave per channel. Hue changes do
not reset Tone; Tone changes do not reset hue.

## 10. Tone rendering

### 10.1 Persisted rule

Extend `SlotRule` and `player_slot_cosmetics` with a nullable real `tone` value.
The canonical domain range is `-1 <= tone <= 1`:

- `-1`: shaded neutral black;
- `0`: selected hue with today's colorize behavior;
- `+1`: shaded neutral white.

`NULL` and omitted `tone` normalize to `0`, so every existing saved color renders
unchanged after migration.

Tone belongs to each channel rule. It is not a player-global setting and not an
additional entitlement.

### 10.2 Shading-preserving interpolation

For each source pixel, let `v` be its HSV value in `[0,1]`, `h` the selected hue,
`s` the selected/base saturation, and `t` the normalized Tone.

For `t <= 0`, let `a = -t`:

```text
outputSaturation = lerp(s, 0, a)
outputValue      = lerp(v, 0.32 * v, a)
```

For `t >= 0`, let `a = t`:

```text
outputSaturation = lerp(s, 0, a)
outputValue      = lerp(v, 0.74 + 0.26 * v, a)
```

Convert `(h, outputSaturation, outputValue)` back to RGB using the same rounding
on the server and in the browser.

Consequences:

- `t = 0` is byte-compatible with current `colorize` output;
- `t = -1` matches the current Blackened value range while retaining source
  highlight/shadow relationships;
- `t = +1` matches the current Holy White value range while retaining source
  highlight/shadow relationships;
- intermediate values produce dark red → red → pale red behavior instead of
  snapping between unrelated finishes;
- the endpoints are not flat solid black or white, so 24×24 sprite detail remains
  readable.

Tone calculation must be implemented once as a pure domain operation and mirrored
exactly in the client preview, with parity fixtures protecting the two versions.

### 10.3 Material presets

Presets are convenience recipes, not new rendering operations:

| Preset | Hue | Saturation | Tone |
|---|---:|---:|---:|
| Forged Steel | 212° | 0.13 | 0.00 |
| Aged Bronze | 28° | 0.58 | -0.12 |
| Royal Gold | 46° | 0.75 | +0.10 |

Applying a preset writes its recipe to the active channel. The player may then
move Tone or the wheel. Moving the wheel preserves Tone and returns saturation to
the normal wheel saturation. Restore Default deletes the active channel rule and
returns the authored pixels.

## 11. Storage and migration

### 11.1 Entitlements

No new ownership table is required. Continue using
`player_cosmetics.wheel_tier`, whose existing schema already supports values 0–3.

Existing Tier-1 owners remain Tier 1. No one receives Tier 2 or Tier 3 through a
migration.

### 11.2 Tone

Add `tone REAL` to `player_slot_cosmetics`. Existing rows receive `NULL`, which the
domain normalizes to zero. Domain and route validation reject non-finite values and
values outside `[-1,1]`.

Read/write and canonical hashing include normalized Tone. Skin URLs change when
Tone changes and remain immutable for a given complete render configuration.

### 11.3 Saved rules across class/gender changes

Do not delete rules for slots absent from the current variant. They remain stored
and return if the player switches back to a variant that exposes them.

Do not delete a valid saved rule merely because its required tier is currently
locked. The authoritative render configuration filters it out until the tier is
owned, then allows it to return. This is lossless and protects against legacy or
administratively changed data without permitting an entitlement bypass.

The render hash is computed from the filtered, entitled configuration, not from
inactive stored rows.

## 12. Server-side enforcement and rendering

Hiding a channel in the browser is not authorization.

### 12.1 Dye write routes

For set and clear operations:

1. authenticate the player token;
2. validate slot, hue, Tone, and preset input;
3. resolve the channel in the authoritative registry for current class/gender;
4. require `wheel_tier >= requiredTier`;
5. write or clear the rule.

Unknown, unavailable, and locked channels are rejected without changing stored
configuration.

### 12.2 Skin rendering

The `/sprite/skin` route loads the player, current class/gender, tier, slot map,
and stored configuration. Before hashing or recoloring, filter rules through the
same entitlement registry used by the write route.

This prevents a direct database remnant, stale browser, or forged request from
rendering locked channels.

### 12.3 Client contract

The serialized Wardrobe model includes:

- current tier and next tier;
- unlocked channels;
- applicable locked channels with required tier;
- only entitled active rules;
- normalized Tone;
- material preset recipes;
- the base sprite and slot map.

The browser never receives the player's auth token in logs or error text.

## 13. Error handling and race behavior

- All purchase checks and deductions occur in one transaction.
- All numeric inputs are finite, bounded, and server-validated.
- Rapid hue/Tone movement uses the existing ordered per-slot autosave queue so
  the last accepted change wins.
- A page navigation flushes the final pending hue/Tone request using the existing
  keepalive behavior.
- A failed save leaves the local preview visible, marks the affected channel as
  unsaved, and permits retry; it does not silently claim success.
- Restore Default cancels pending set operations for that slot before clearing.
- A class/gender change between page render and save causes the server to resolve
  against the player's current variant and reject a now-unavailable slot.

## 14. Testing requirements

### 14.1 Registry and availability

- Assert the complete table in §5.3 for all nine classes and both genders.
- Assert no duplicate slot exists for a class/gender.
- Assert every registry slot appears in both authored animation frames.
- Assert no authored expected channel is missing from the registry.
- Assert declaration order is stable within each tier.
- Assert labels and semantic aliases in §5.4.

### 14.2 Purchases

- Tier 0 may buy only Tier 1 for 1.5M.
- Tier 1 may buy only Tier 2 for 2M.
- Tier 2 may buy only Tier 3 for 2.5M.
- Tier 3 cannot buy another cosmetic tier.
- Insufficient, stale, duplicate, unknown, and out-of-sequence requests never
  deduct gold.
- Successful purchases deduct exactly once and grant the exact next tier.
- Admin price overrides are honored independently for all three tiers.

### 14.3 Authorization and rendering

- Each tier permits exactly its approved channels for all 18 variants.
- Locked and unavailable set/clear requests are rejected.
- Stored locked rules are omitted from rendering and skin hashes.
- Buying the required tier activates a retained valid rule.
- Class/gender changes retain stored data but expose only current applicable
  channels.

### 14.4 Tone and presets

- Tone rejects values outside `[-1,1]` and non-finite values.
- Tone zero matches current colorize output.
- Tone endpoints match the approved shaded black/white ranges.
- Intermediate Tone preserves ordering between source shadow and highlight
  pixels.
- Server and browser preview produce identical fixture pixels for negative,
  zero, and positive Tone.
- Steel, Bronze, and Gold produce their exact recipes.
- Hue movement preserves Tone; Tone movement preserves hue.
- Restore Default clears the complete rule.
- Tone participates in canonical skin hashing.

### 14.5 Web UI

- Bazaar renders exactly one next-tier card at tiers 0–2.
- Bazaar shows each correct price and current-variant channel list.
- Bazaar removes the purchase card and renders mastery state at Tier 3.
- Character page renders unlocked controls and only applicable locked previews.
- Male variants never expose female-only Hair, Lips, or Details.
- The workbench contains the hue wheel, Tone slider, Steel/Bronze/Gold presets,
  and Restore Default.
- Blackened/Holy White discrete buttons are absent.
- Autosave status and failed-save recovery remain accessible.

### 14.6 Full verification

Run:

```bash
npm test
npm run typecheck
node --check src/web/public/dye.js
node --check src/web/public/anim.js
git diff --check
```

## 15. Visual acceptance

Before merge or deployment, demonstrate locally with real authored maps and
animated A/B sprites:

1. one player at each tier 0–3;
2. the Bazaar's Tier-1, Tier-2, Tier-3, and mastery states;
3. the character page for all nine classes and both genders;
4. every unlocked/locked channel group;
5. hue plus black/white Tone extremes and intermediate values;
6. Steel, Bronze, Gold, and Restore Default;
7. class/gender switching without lost customization;
8. purchase transitions and exact gold deductions.

The shop and character page must remain fun and visually consistent with the
dungeon shell. The product is not complete merely because automated tests pass;
the tier cards, workbench layout, Tone control, material recipes, and animated
sprites require user visual approval.

## 16. Rollout boundary

This specification authorizes design and implementation planning on
`feat/player-shop-cosmetics`. It does not authorize merge, push, Pi deployment,
or timed-consumable implementation.

After the cosmetic shop is implemented, verified, visually approved, and shipped,
the next shop-program design is Phase 2: timed damage and gold consumables. Token
boosts remain excluded unless the user explicitly reopens that decision.

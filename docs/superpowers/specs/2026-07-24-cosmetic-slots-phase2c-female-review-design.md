# Cosmetic Slot System — Phase 2C Complete Roster Maps and Review Design

**Date:** 2026-07-24  
**Status:** Approved design  
**Track:** Character cosmetics, after Phase 2B.2 and before tiered shop entitlements

## 1. Outcome

Phase 2C completes the material inventory across all 36 class maps: nine
classes, two genders, and two animation frames. It first creates female maps
from the corrected male maps, then fills the material channels that the
collision-focused Phase 2A male maps intentionally omitted. It also adds a
permanent, read-only review tool for checking every male/female animation pair.
Female characters become eligible to buy and use the dye workbench only after
their authored slot maps exist.

Phase 2C ends at a deliberate visual-review gate: the app must present all 18
male/female class variants, fully animated through frames A and B with their
complete material channels, and the user must approve or identify pixel
corrections before this phase is complete.

## 2. Naming and roadmap boundary

Two unrelated plans used “Phase 2”:

- **Cosmetic Phase 2C** is this work: female slot maps and the animated review
  tool.
- **Shop-program Phase 2** is the later timed-consumables system.

The agreed order is:

1. Finish Cosmetic Phase 2C and its visual correction loop.
2. Add three paid cosmetic tiers and reflect them in the shop and character page.
3. Reopen the shop dynamically, then perform the launch, merge, deployment, and
   Pi verification pass.
4. Begin the separate timed-consumables phase.

Tier pricing, shop reopening, timed boosts, loot boxes, equipment, gems, and pets
are not part of this Phase 2C implementation.

## 3. Existing system

Phase 2A committed 18 male slot maps under `slotmaps/`:

```text
slotmaps/<class>_M_a.png
slotmaps/<class>_M_b.png
```

Each 24×24 map assigns visible pixels to the established 12-slot taxonomy:
outline, body, headgear, hair, face paint, cape, trim, weapon, shield, boots,
skin, and flair. Phase 2B stores one recolor rule per player and material, serves
content-addressed composite skins, and exposes the per-slot workbench on the
character page.

Female sprites currently have no maps. `presentSlots(<class>_F)` therefore
returns no channels, the character page marks dyes unavailable, and the unlock
route refuses to spend the player's gold.

The male maps are collision-safe but are not yet complete material inventories.
Their current exposed channels are:

| Class | Current male channels |
|---|---|
| Knight | Clothing |
| Thief | Clothing |
| Ranger | Clothing |
| Wizard | Clothing, trim, weapon, eyes, skin |
| Priest | Clothing, trim, weapon |
| Shaman | Clothing, weapon, face paint, skin |
| Berserker | Clothing, trim, cape, headgear, weapon, skin |
| Swordsman | Clothing |
| Paladin | Clothing, headgear, boots, shield, skin |

This was enough for Phase 2A to prove collision isolation, but it is not enough
for the approved three-tier product that follows 2C. Phase 2C therefore includes
a full 36-map material-completion pass before visual acceptance.

## 4. Source-sprite finding

Male and female sprites use the same 24×24 canvas and nearly the same silhouette.
The female art is primarily a palette variant, with only 1–9 alpha-mask
differences in each class/frame pair:

| Class | Frame A differing alpha pixels | Frame B differing alpha pixels |
|---|---:|---:|
| Knight | 3 | 2 |
| Thief | 5 | 4 |
| Ranger | 2 | 1 |
| Wizard | 5 | 6 |
| Priest | 3 | 3 |
| Shaman | 3 | 3 |
| Berserker | 9 | 4 |
| Swordsman | 4 | 4 |
| Paladin | 9 | 9 |

That geometry makes the corrected male maps the safest source of truth. Repeating
the old palette-and-bounding-box seeding would reintroduce the exact collision
bugs the slot maps were built to remove.

## 5. Map authoring

### 5.1 Female baseline by coordinate transfer

A pure transfer function consumes:

- the corrected male slot map;
- the male source sprite;
- the corresponding female source sprite; and
- explicit female overrides.

For every coordinate:

1. If the female source pixel is transparent, output transparent/slot 0.
2. If both source sprites are visible, copy the corrected male slot id.
3. If only the female source pixel is visible, require an explicit override.

An override may replace any transferred coordinate, assign a female-only
coordinate to a material slot, or explicitly assign slot 0 for outline linework.
Keeping all female deviations in committed override data makes regeneration
repeatable. The generator must fail with the class, frame, and unresolved
coordinates when any female-only visible pixel lacks an override. It must never
guess a slot from a nearby color.

The generated artifacts are:

```text
slotmaps/<class>_F_a.png
slotmaps/<class>_F_b.png
```

The transfer step never rewrites the existing male maps.

### 5.2 Complete material inventory

After baseline transfer, both genders are completed against the per-character
inventory in `docs/cosmetics-recolor-regions.md` §3 and the presence matrix in
§4. The committed PNGs are the artifacts consumed at runtime. The reproducible
authoring sources are the corrected male PNGs plus the explicit female override
data; the old hex-and-bounding-box seeder remains only a bootstrap tool.

Each visually independent material receives its own applicable taxonomy slot.
When the source document marks two regions as the same garment
(`headgear = body`, `cape = body`, or similar), they intentionally remain one
channel unless the pixels are visibly separate materials. This prevents the
presence-matrix shorthand from creating two controls that recolor the same
garment.

The target picker channels are:

| Class | Shared target channels | Gender-specific channels |
|---|---|---|
| Knight | headgear (cap), body (tunic), cape, trim, weapon, shield, boots, skin | female hair |
| Thief | headgear (cap), body (cloak), trim, weapon, hair, boots, skin, flair (feather) | none |
| Ranger | headgear (hat), body (shirt), hair, weapon (bow/arrow), boots, skin, flair (fletching) | none |
| Wizard | body (hood/robe), trim, weapon, skin (hand), flair (eyes) | none |
| Priest | body (hood/robe), trim, weapon, skin, flair (holy symbol) | female hair |
| Shaman | body (pelt hood/cloak), face paint, trim (loincloth), weapon, boots, skin | none |
| Berserker | body (tunic), headgear (helmet), cape, trim (headband), weapon, boots, skin, flair (horns) | none |
| Swordsman | body (shirt), hair, trim (pauldron/belt), weapon, boots, skin | female flair (earring/lips) |
| Paladin | body (`#b4c21d` helmet/shirt), trim (front panel), weapon, shield, boots, skin, flair (white feather/wings) | none |

Opaque outline and intentionally fixed artwork remain slot 0. “Complete” means
every intended recolorable material above is mapped; it does not mean every
visible pixel becomes recolorable.

The exact pixel boundaries are verified in the review tool and corrected in the
male map artifacts or female override data. Whenever a male correction changes
a shared coordinate, the female maps are regenerated so the correction
propagates before female-specific overrides are applied.

### 5.3 Corrections that must survive transfer and completion

The female maps inherit all accepted male material boundaries:

- Wizard eyes remain flair and never follow the robe.
- Shaman staff remains weapon.
- Berserker tunic/body, helmet, cape, axe, and horns remain independent.
- Paladin shield, white feather/wings, front panel, and boots remain independent
  from the helmet-and-shirt garment.
- Paladin’s authoritative source-sprite garment color is `#b4c21d`; the slot map,
  not runtime color matching, is authoritative. This is the region previously
  identified from the rendered sample as approximately RGB 183/193/68.
- Outline pixels remain slot 0 and are never recolored.

The transfer is only an initial authoring pass. Any material differences visible
on the female art are recorded in the override data and regenerated during the
review loop rather than forced to match the male labels or patched only in the
generated PNG.

## 6. Skin-cache correctness

The current player skin hash reflects only the saved slot rules. That is
insufficient when a slot map itself changes: an old immutable URL could continue
serving pixels rendered from an earlier map, and a pre-2C female fallback could
remain cached as the plain sprite.

Phase 2C replaces the config-only hash with:

```ts
slotmapFingerprint(sprite: string): string
skinRenderHash(sprite: string, config: Map<number, SlotRule>): string
```

`slotmapFingerprint` computes SHA-256 over the raw frame-A and frame-B slot-map
bytes, using an explicit missing-map sentinel, and returns the first 16
lowercase hexadecimal characters. `skinRenderHash` computes SHA-256 over the
sprite id, the map fingerprint, and the canonical ordered slot configuration,
also returning 16 lowercase hexadecimal characters.

The resulting render hash therefore includes:

- the canonical, ordered per-slot player configuration;
- the sprite identity; and
- a stable fingerprint covering both frame-A and frame-B slot-map contents.

Both animation-frame URLs share that combined map fingerprint, so the existing
client-side `/a/` → `/b/` partner substitution remains valid. Editing either map
changes the skin URL and invalidates both cached frames. A stale hash redirects
to the current canonical URL before any immutable cache header is set.

## 7. Permanent cosmetics review tool

### 7.1 Access

Add `Config.enableCosmeticsReview`, loaded from:

```text
ENABLE_COSMETICS_REVIEW=1
```

The review routes are not registered when the flag is false, matching the
existing `/catalog` and `/dungeon-preview` dev-tool pattern. The tool is unlinked
from player navigation and uses the lite dungeon shell.

### 7.2 Page

`GET /cosmetics-review` displays one row per class. Each row shows male and
female cards side by side. Every card renders frames A and B through the real
server recoloring engine and alternates them on the shared pixel-art animation
clock.

Global controls provide:

- original sprite;
- full slot-color overlay using distinct legend colors;
- one selected material highlighted while all other materials stay original;
- a test hue;
- blackened, holy-white, and forged-steel finishes;
- animation pause/resume.

The page shows the friendly channel labels actually present in each map. Missing
or mismatched channels must be visible as a warning rather than silently hidden.
Images use nearest-neighbor scaling.

### 7.3 Render endpoint

The flag-gated endpoint is:

```text
GET /cosmetics-review/render/:sprite/:frame.png
```

`:sprite` must be `<known-class>_<M|F>` and `:frame` must be `a` or `b`. The
validated query is:

```text
mode=original|slots|focus|hue|black|white|steel
slot=<0..11>
hue=<0..359>
```

`slot` is required for focus/hue/finish modes, and `hue` is required only for
`mode=hue`. Invalid values return 400; unknown sprites or missing maps return
404. `original` returns the source frame. `slots` displays all non-outline map
regions in their distinct legend colors. `focus` displays the selected slot in
its legend color over the original sprite. Hue and finish modes apply one
selected slot through `recolorSpriteSlots`, leaving every other slot unchanged.

The endpoint does not use player records or write to the database.

Review responses use `Cache-Control: no-store` so regenerated maps are visible
immediately during the correction loop. The review renderer reads the map PNG
from disk and calls `readSlotmap` on each request instead of using
`loadSlotmap`'s process-lifetime cache. The production `/sprite/skin` endpoint
continues to use its in-memory map loader and immutable, content-addressed
caching; production map changes arrive with a process restart during deployment.

## 8. Runtime behavior

No special female unlock switch is added. Availability continues to derive from
the authored data:

```text
presentSlots(spriteId(player.class_key, player.gender)).length > 0
```

Before a female map exists, unlock remains unavailable and no gold can be spent.
Once all committed female maps exist, the existing character page, guarded
purchase route, skin URL, TV, leaderboard, and animation partner logic work for
female players through the same code paths used for male players.

## 9. Validation

Automated acceptance covers:

- all 36 expected map files exist and decode to 24×24;
- every female-only visible source pixel has an explicit override;
- no nonzero slot-map pixel exists where the corresponding source sprite is
  transparent;
- all slot ids are from the established taxonomy;
- frame A and frame B expose the same material-channel set for each
  class/gender;
- each class/gender exposes the independent materials documented in the
  per-character inventory, collapsing only the document's explicit same-garment
  aliases;
- female and male variants expose matching channels except for documented
  female-only materials such as hair, cape, or flair;
- known collision regions remain isolated in both genders and both frames;
- the skin render hash changes when either frame’s map fingerprint changes;
- stale skin hashes redirect before receiving immutable cache headers;
- the review route is absent when disabled and renders all 18 variants when
  enabled;
- female dye availability and guarded purchase behavior switch on without
  changing the purchase code’s atomic gold deduction.

Full verification runs `npm test`, `npm run typecheck`, and the browser-script
syntax check.

## 10. Visual acceptance and stop gate

Run an isolated local server with `ENABLE_COSMETICS_REVIEW=1` and open
`/cosmetics-review`. Review every class in original, full-overlay,
single-material, hue, black, white, and steel modes while frames A and B
alternate.

Phase 2C is not complete merely because tests pass. Work stops at the animated
review page for user inspection. Reported pixel issues are corrected in the male
authored maps or explicit female override data, female maps are regenerated,
and the page is reviewed again. Phase 2C is complete only after the user
approves the complete male/female animated roster.

## 11. Explicit non-goals

- Three-tier cosmetic ownership or prices.
- Moving products between the shop and character page.
- Reopening the closed Bazaar.
- Timed damage or gold consumables.
- Token boosts.
- Loot boxes, equipment parts, gems, weapon overlays/swapping, or pets.
- Combat, dungeon, leaderboard, or economy changes beyond the cosmetic gold
  purchase becoming available to female players.

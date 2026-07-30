# Timed Consumables Review Polish — Design

**Date:** 2026-07-29

**Status:** Implemented and locally approved; Pi release gate pending

**Scope:** Bazaar exhaustion, local-demo boss animation, potion-mote scale, and player-hub Inventory/Live Dungeon presentation

## Goal

Bring the timed-consumables review in line with the approved mockups and the rest of ClaudeRPG's dungeon presentation. The finished pass must:

- show the closed Bazaar only when the character has no permanent wardrobe offer and every potion is sold out;
- animate one coherent boss in the deterministic local review;
- make TV potion motes slightly smaller without changing their approved motion or the character-page version;
- turn Inventory into an interactive dungeon room built from the existing Oryx art; and
- give the compact live dungeon the maximum useful width, with leaders and daily statistics beneath it.

This pass changes presentation and deterministic review data. It does not change potion prices, effects, inventory rules, daily limits, combat calculations, or production deployment.

## 1. Bazaar exhaustion

The Bazaar has three possible sources of purchasable stock:

1. the next permanent wardrobe tier;
2. the Beginner Gold Potion's personal daily stock; and
3. the Beginner Damage Potion's personal daily stock.

The Bazaar remains open when a wardrobe offer exists or at least one potion has stock remaining. While it is open, both potion cards remain visible, including a sold-out card with its existing **Back at midnight** treatment. This avoids a card appearing and disappearing while its neighboring potion is still available.

The closed-mimic scene renders only when all of the following are true:

- `nextOffer` is `null`;
- every configured consumable is available; and
- every consumable has `stockRemaining === 0`.

An invalid potion configuration is not treated as a sellout. Its unavailable cards remain visible so an operator can distinguish broken tuning from exhausted daily stock. An unaffordable wardrobe offer also keeps the Bazaar open because it is still a real offer.

After the final successful potion purchase, the normal redirect/refresh may render the closed scene immediately. The success notice can coexist with the closed scene. The persistent Adventurer Ledger remains visible and continues to show gold, wardrobe mastery, owned potion inventory, future-product copy, and Return to Character.

## 2. Deterministic review boss

The local potion demo currently seeds encounter creature index `35`. The TV animation contract assumes every encounter URL starts on a frame-A sprite and derives frame B with `index + 18`. Index `35` is already a frame-B character sprite, so the renderer alternates between unrelated sprites `35` and `53`.

The demo will seed the Elder Demon frame-A boss from `MONSTERS` at index `188`; its frame-B partner is `206`. This preserves the existing TV animation contract and produces a visually obvious boss suitable for potion-effect review.

The demo test will assert that its active encounter resolves through `monsterByIndex`, is marked `boss`, and uses a frame-A bestiary entry. Production encounter generation and the global bestiary are unchanged.

## 3. TV potion-mote scale

The shared potion vocabulary continues to emit the approved square sizes, colors, count, jitter, rise, fade, and tier intensity. Character-page motes remain unchanged.

The TV renderer currently uses the actor's full sprite scale for both mote position and mote size. At common TV scales, a three-source-pixel mote becomes noticeably larger than the reviewed mockup. The renderer will keep the full source scale for positioning but derive a smaller integer `moteScale` for square size, shadow offset, glow, and depth. The target is approximately two-thirds of the current displayed square size while retaining crisp integer pixels at every TV scale.

No icon badges, rings, additional glow layers, or extra motes are introduced.

## 4. Inventory dungeon room

### Structure

Desktop Inventory uses a two-column layout:

- **two thirds:** the dungeon-room inventory grid;
- **one third:** the selected item's details and activation action.

The existing title and category filters remain above the layout. On narrow screens the room comes first and the details stack beneath it.

### Dungeon art

The room is a regular DOM grid, not a canvas. This preserves native buttons, focus, screen-reader semantics, and the existing click/touch/keyboard interaction model.

- The perimeter uses the same 24×24 `moss_wall.png` artwork as the site's wall frame.
- Cell backgrounds use the served Oryx world sheet, primarily the Verdant Crypt's dark inset floor, with sparse light-moss accents.
- The perimeter includes one cracked wall tile and one more heavily broken wall tile.
- One closed dungeon door is centered along the lower edge.
- The decorative pattern is deterministic so polling and inventory refreshes never rearrange the room.
- Decoration never occupies or obscures an interactive item cell.

The first implementation provides a stable room large enough for current and near-term inventory. Empty floor cells remain visible so the room still reads as a place rather than a row of cards. Future item categories reuse the same cells without changing the room component.

### Item cells

Each owned stack is one floor-cell button:

- the item sprite is centered and uses crisp pixel rendering;
- no product name appears inside the room;
- a gold quantity appears in the upper-right corner with a dark, hard-edged pixel shadow;
- the selected cell receives a restrained gold outline and inset highlight;
- hover and focus lift brightness without moving the tile; and
- the accessible name contains the full item name and quantity.

Clicking or focusing a cell selects it and populates the existing detail panel. The detail panel keeps the potion icon, tier, full name, owned quantity, effect, duration, daily doses, reset time, active progress, and Drink action. Polling preserves the selected SKU whenever that stack still exists.

The empty-inventory state appears inside the dungeon room rather than replacing its walls and floor.

## 5. Live Dungeon layout

The compact TV iframe becomes the primary content of the Live Dungeon tab:

- remove the nested padded `.hub-dungeon` card treatment;
- render the iframe at the full inner width of the main panel;
- retain a crisp dark edge and minimal radius without an additional purple container; and
- keep the 16:9 aspect ratio and Watch full screen action.

Fight Leaders and Today move into a second row beneath the dungeon and split the width approximately 50/50. Their existing subpanel styling, content, IDs, and polling updates remain intact. On narrow screens the two sections stack vertically after the full-width dungeon.

## 6. Data flow and component boundaries

- `buildShopViewModel` remains the source of stock and availability truth. It will expose or make directly derivable one closed-state boolean; EJS will not duplicate purchase rules.
- `shop.ejs` chooses between ordinary offers and the existing closed-mimic scene from that view-model state.
- `seed-potion-demo.ts` owns only deterministic fixture selection; the TV renderer continues to receive an ordinary encounter.
- `potion-fx.js` remains the shared motion vocabulary. Only TV display scaling changes in `tv.js`.
- `character-inventory.ejs` owns the initial accessible room markup; `player-hub.js` recreates the same item-cell contract after polling.
- `player-hub.css` owns the room tiles, responsive proportions, selected/focus states, and the revised Live Dungeon geometry.

## 7. Accessibility and resilience

- Inventory cells remain native buttons with unique accessible names and `aria-pressed` selection state.
- Keyboard focus and the selected item remain visible against both floor and moss textures.
- Potion activation confirmation, focus return, filters, and live updates retain their current behavior.
- Decorative walls, cracks, moss, and the door are hidden from assistive technology.
- Reduced-motion behavior is unchanged: potion motes stop while all status information remains available.
- A missing decorative asset falls back to the existing dark inventory background; items and actions remain usable.

## 8. Test and review strategy

### Automated

- Shop view-model tests cover: wardrobe offer present; one potion sold out and one available; both potions sold out with wardrobe offer; both sold out after wardrobe mastery; and invalid tuning.
- Shop route tests assert that one sold-out potion remains visible while its sibling is available, and that the closed-mimic scene appears only after every offer is exhausted.
- Potion-demo tests assert the active encounter is a valid bestiary boss and no longer uses index `35`.
- Potion FX/TV tests assert that the shared source vocabulary is unchanged and TV uses the smaller integer display scale.
- Player-hub rendering/client tests cover dungeon-room markup, title-free item cells, quantity badges, selection persistence, and full-width Live Dungeon structure.
- Existing potion purchase, activation, polling, wardrobe, and accessibility suites remain green.

### Visual review

Use a fresh disposable potion-demo database and inspect:

1. one sold-out potion beside one available potion;
2. the fully closed Bazaar after all offers are exhausted;
3. at least two boss A/B cycles;
4. Gold-only, Damage-only, and dual potion motes on the full TV;
5. populated and empty inventory rooms at desktop and narrow widths; and
6. the full-width compact dungeon with 50/50 leaders and Today panels.

The Pi and production remain out of scope until separately authorized and the game is fully idle-paused.

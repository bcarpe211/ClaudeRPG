# Oryx Tileset — Decor & Items Reference

Curated coordinates for dungeon decor (world sheet) and a catalog of the items
sheet, captured during the #6/#7 brainstorm. Coordinates are `(col,row)` tiles on
the **full** sheet (24px tiles). Sources:
- World: `assets/oryx_16-bit_fantasy_1.1/oryx_16bit_fantasy_world_trans.png` (56×41)
- Items: `assets/oryx_16-bit_fantasy_1.1/oryx_16bit_fantasy_items_trans.png` (16×12)

Used by the staged decor builds:
- **Build 1** — static themed decor (floor/corner/wall) + walkable + floors.
- **Build 2** — animate the A/B pairs below (per-frame decor rendering).
- **Build 3** — rugs + swappable crests + boss platform.
- Items sheet — future shop / equipment phase.

## World-sheet decor (props)

Placement: `floor` (scatter), `corner` (cobwebs), `wall` (torches). `walkable` =
can a hero/monster stand on it (rugs yes; solid props no).

### Cobwebs (corner) — cols 29–34, row 2
- 29,2 small corner web · 30,2 corner web · 32,2 corner web (diagonal)
- 31,2 larger web · 33,2 full web · 34,2 full web  (use full webs sparingly, only
  for cobweb-heavy dungeons: Ossuary Pale, Duskstone Warren, Verdant Crypt, Bogstone Mire)

### Animated items (A/B frames) — Build 2
| Item | Frame A | Frame B | placement | notes |
|------|---------|---------|-----------|-------|
| Floor flame | 39,1 | 40,1 | floor | fire |
| Standing torch/brazier | 41,1 | 42,1 | wall/floor | fire |
| Wall torch | 41,2 | 42,2 | wall | fire |
| Cauldron (purple goo) | 31,6 | 32,6 | floor | fire/poison |
| Tome grey | 38,9 | 38,10 | floor | arcane |
| Tome blue | 39,9 | 39,10 | floor | arcane |
| Tome green | 40,9 | 40,10 | floor | arcane |
| Skull | 41,9 | 41,10 | floor | crypt/bones |

(A/B pairing is per-item — flames/torches are horizontal neighbors, tomes/skull
are vertical neighbors. NOT the creatures-sheet +18 rule.)

### Static floor props (verified coords)
- **crypt/bones:** 29,1 gravestone · 30,1 broken tombstone · 32,1 crossed bones ·
  34,1 scattered bones · 36,1 skull pile · 38,1 skeleton
- **fire/forge:** 39,1 flame(A) · 41,1 brazier(A) · 31,6 cauldron(A)
- **treasure:** 32,4 chest · 33,4 open gold chest · 36,4 gold idol · 36,5 throne · 40,5 gold chest
- **generic:** 39,4 barrel · 40,4 barrel open · 29,5 crate · 41,5 wood crate ·
  37,6 stone urn · 39,6 stone pot · 42,6 broken pot
- **colored urns:** 37,7 blue · 40,7 green · 37,8 red · 40,8 clay
- **rubble/rock:** 31,1 rubble · 34,6 rocks · 33,7 cracked rock
- **blood:** 35,2 splat · 36,2 specks
- **poison/slime:** 38,2 slime splat · 39,2 green slime
- **water:** 29,8 fountain · 30,8 well
- **nature:** 44,1 bush · 45,1 bush · 52,3 round bush · 44,2 flowers · 46,2 flowers ·
  50,3 cactus · 54,2 red mushroom · 52,2 blue mushroom · 45,3 brown rock ·
  46,3 grey rock · 49,4 small pine · 45,8 small tree
- **ice:** 50,4 snowy pine (+ grey rock 46,3, rocks 34,6)
- **arcane (tomes):** 38,9 / 39,9 / 40,9 (see animated table)

### Rugs (3×3 blocks + swappable crest) — Build 3, walkable
- **Red rug:** cols 5–7 × rows 24–26 (9 tiles; plain center 6,25). Crests (row 27):
  5,27 phoenix · 6,27 heraldic shield · 7,27 knot emblem.
- **Blue rug:** cols 8–10 × rows 24–26 (center 9,25). Crests: 8,27 cross · 9,27 crown · 10,27 lion.
- Crest overlays the rug's center tile. Rug is walkable → can sit under the boss's
  2×2 zone as a platform.

## Items sheet catalog (16×12) — future shop / equipment

Row bands (for later curation; not used by the dungeon):
- **Rows 0–1:** potions (flasks/bottles, many colors) + amulets/necklaces + colored gem-drops
- **Row 2:** scrolls/tomes, staff/wand, rings, cut gems (diamonds), hearts
- **Row 3:** orbs/spheres, mushrooms, feather, gems/stars
- **Row 4:** skulls, scrolls, **keys** (row of keys), clock, candle, lantern, crown, bell, torch
- **Rows 5–7:** weapons — hammers/mallets, staves/wands, swords, spears, axes, daggers
- **Row 8:** shields (varied), banners/flags, hourglass, urns
- **Rows 9–10:** armor/clothes — chestplates, helmets, gauntlets, boots, pants/greaves, wizard hats; + gems

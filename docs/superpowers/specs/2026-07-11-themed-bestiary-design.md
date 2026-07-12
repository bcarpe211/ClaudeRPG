# Themed Bestiary + Encounter Engine + Monster Name Flare — Design

**Date:** 2026-07-11
**Status:** Draft for review

## Goal

Replace the hand-picked, index-buggy `MONSTER_TIERS` / `BOSSES` creature
selection with a **category-based bestiary** that gates encounter creatures by
**dungeon theme**, and surface each monster's name on the TV as
`"<adjective> <creature>"`. Along the way, correct every creature index to the
verified frame-A file numbers, and record two new per-monster traits — **size**
(S/M/L) and **flying** — that drive a ground shadow under each monster on the TV.

## Motivation

- `src/domain/creatures.ts` still uses pre-catalog creature indices that render
  the *wrong* sprites (the frame-A/frame-B +18 offset bug, documented in the
  roadmap and `docs/BACKLOG.md#1`). The name↔index mapping is now verified
  (`nameForCreatureFile` in `src/web/catalog/build.ts`), so we can fix this.
- Encounters are currently theme-blind: any dungeon can spawn any tier's
  creatures, so a fire forge and a bone crypt field identical monsters.
- No monster name is shown on the TV; the last layout pass reserved space for it
  (`docs/BACKLOG.md#12`).

## Scope

**In:** bestiary data module, theme→category map, engine rewrite (`creatures.ts`
+ `encounters.ts`), monster-title generation, TV rendering of the name + a
size/flying-driven ground shadow.

**Out (unchanged / later):** the HP calibration + difficulty-ramp model stays
exactly as is (difficulty is *not* gated by creature — the game delves forever,
challenge escalates via HP only); sprite A/B animation (`#13`); per-class attack
visuals; the `/catalog` tooling.

## Design decisions (confirmed in brainstorming)

1. **Category-based composition**, not per-dungeon rosters: each monster is
   tagged once; each dungeon lists the categories it draws from.
2. **Difficulty does not gate selection.** Any theme-appropriate monster can
   appear at any depth. No `difficulty` field is stored (YAGNI).
3. **Humanoid foes included** (bandits, assassins, drow, goblins, orcs, gnolls,
   lizardmen, evil casters). Peaceful townsfolk (merchants, kings, chefs, guards,
   allied dwarves/elves/gnomes) are excluded from the bestiary.
4. **Monster name rendered on the TV** this build: `"<adjective> <creature>"`.
5. **Size (S/M/L) + flying** recorded per monster to select/place a ground
   shadow.
6. Monster **title is computed deterministically from the encounter id** in the
   view-model — **no DB migration**.

---

## Architecture

Five components, each with one responsibility:

| File | Responsibility |
|------|----------------|
| `src/domain/bestiary.ts` | The curated monster list + category/size/flying/boss data + lookup helpers. Single source of monster truth. |
| `src/domain/dungeonthemes.ts` | Map each of the 21 dungeon names → the monster categories (and optional boss categories) it draws from. |
| `src/domain/creatures.ts` (rewrite) | `pickEncounterCreature(theme, kind, rng)` — theme-gated selection. `MONSTER_TIERS`/`BOSSES` deleted. |
| `src/domain/monstername.ts` | `monsterTitle(encounterId, index, category)` → `"<adjective> <creature>"`, deterministic. Adjective pools. |
| `src/domain/tilesheet.ts` (add) | `MONSTER_SHADOWS` tile coords (S/M/L). |
| `src/web/tvview.ts` (edit) + `src/web/public/tv/tv.js` (edit) | Carry `name`, `size`, `flying` in the monster state; render the name label + ground shadow. |

Data flow:

```
encounters.spawnEncounter(dungeon.theme, kind, rng)
   -> creatures.pickEncounterCreature(theme, kind, rng)
        -> bestiary.monstersFor(theme.categories)  / bestiary.bossesFor(theme.bossCategories)
        -> { index, footprint }   (unchanged encounter row shape)
   -> encounters row stores creature_index (frame-A file index)

tvview.buildTvState(db)
   -> reads active encounter (id, creature_index)
   -> bestiary.monsterByIndex(creature_index) -> { name, category, size, flying }
   -> monstername.monsterTitle(encounter.id, creature_index, category) -> label
   -> state.monster = { ...position, index, footprint, name: label, size, flying }

tv.js drawMonster(state.monster)
   -> draw MONSTER_SHADOWS[size] on the ground (offset down for flying)
   -> draw the sprite (raised for flying)
   -> draw the name label in the reserved strip above the HP bar
```

---

## Component 1 — `src/domain/bestiary.ts`

### Types

```ts
export type MonsterCategory =
  | 'undead' | 'demon' | 'beast' | 'vermin' | 'elemental'
  | 'dragon' | 'construct' | 'humanoid' | 'ooze' | 'giant'
  | 'aberration' | 'plant';

export type MonsterSize = 'S' | 'M' | 'L';

export interface Monster {
  index: number;          // frame-A file index in creatures_24x24 (renderer sprite id)
  category: MonsterCategory;
  size: MonsterSize;      // selects the ground-shadow tile
  flying: boolean;        // raise sprite + drop shadow to the ground for a float
  boss: boolean;          // eligible to be a 2x2 boss
}
```

`name` is **not** stored — it is derived from `index` via
`nameForCreatureFile(index, CREATURE_SHEET_NAMES)` so the doc stays the single
source for names. The bestiary exposes it through `monsterName(index)`.

### The roster (authoritative draft)

Authored below by frame-A file index (from the generated index/name table).
Category assignments are pragmatic-thematic (where a creature best *belongs* in
a dungeon), not a biological taxonomy. Implementer transcribes this table
verbatim; it is complete (no TBDs).

**undead** (bosses marked ★)
| idx | name | size | flying |
|-----|------|------|--------|
| 265 | Death Knight | M | no |
| 266 | Death Knight Alt | M | no |
| 267 | Death Knight Alt | M | no |
| 289 | Zombie | M | no |
| 290 | Headless Zombie | M | no |
| 291 | Skeleton | M | no |
| 292 | Skeleton Archer | M | no |
| 293 | Skeleton Warrior | M | no |
| 294 | Shadow | M | yes |
| 295 | Ghost | M | yes |
| 296 | Mummy | M | no |
| 297 ★ | Pharoah | M | no |
| 298 | Necromancer | M | no |
| 299 | Dark Wizard | M | no |
| 300 ★ | Death | L | yes |
| 301 | Vampire | M | no |
| 302 | Vampire Alt | M | no |
| 303 ★ | Vampire Lord | M | no |
| 371 | Red Specter | S | yes |
| 372 | Blue Specter | S | yes |
| 373 | Brown Specter | S | yes |

**demon**
| idx | name | size | flying |
|-----|------|------|--------|
| 188 ★ | Elder Demon | L | no |
| 189 ★ | Fire Demon | L | no |
| 190 | Horned Demon | M | no |
| 342 | Imp/Demon/Devil | S | yes |
| 365 | Fire Minion | S | no |
| 367 | Smoke Minion | S | yes |

**beast**
| idx | name | size | flying |
|-----|------|------|--------|
| 185 ★ | Minotaur Axe | L | no |
| 186 | Minotaur Club | L | no |
| 187 | Minotaur Alt | L | no |
| 226 | Cobra | S | no |
| 229 | Grey Wolf | M | no |
| 230 | Brown Wolf | M | no |
| 231 | Black Wolf | M | no |
| 329 ★ | Yeti | L | no |
| 330 | Yeti Alt | L | no |
| 333 | Brown Bear | M | no |
| 334 | Grey Bear | M | no |
| 335 | Polar Bear | L | no |

**vermin**
| idx | name | size | flying |
|-----|------|------|--------|
| 219 | Black Bat | S | yes |
| 220 | Red Bat | S | yes |
| 222 | Red Spider | S | no |
| 223 | Black Spider | S | no |
| 224 | Grey Rat | S | no |
| 225 | Brown Rat | S | no |
| 227 | Beetle | S | no |
| 228 | Fire Beetle | S | no |
| 331 | Giant Leech | S | no |
| 332 | Giant Worm | M | no |
| 336 | Giant Scorpion | M | no |
| 337 | Scorpion Alt | M | no |
| 338 | Scorpion Alt | M | no |

**elemental**
| idx | name | size | flying |
|-----|------|------|--------|
| 196 | Djinn | M | yes |
| 268 ★ | Earth Elemental | L | no |
| 269 | Ice/Water Elemental | M | no |
| 270 | Air Elemental | M | yes |
| 361 | Wisp | S | yes |
| 362 | Wisp Alt | S | yes |
| 366 | Ice Minion | S | no |
| 368 | Mud Minion | S | no |
| 377 | Flame | S | yes |
| 378 | Cold Flame | S | yes |

**dragon** (all boss-eligible; grounded — flying=no for the 2x2 footprint)
| idx | name | size | flying |
|-----|------|------|--------|
| 325 ★ | Red Dragon | L | no |
| 326 ★ | Purple Dragon | L | no |
| 327 ★ | Gold Dragon | L | no |
| 328 ★ | Green Dragon | L | no |

**construct**
| idx | name | size | flying |
|-----|------|------|--------|
| 191 ★ | Stone Golem | L | no |
| 192 | Mud Golem | L | no |
| 193 | Flesh Golem | L | no |
| 194 ★ | Lava Golem | L | no |
| 195 ★ | Bone Golem | L | no |
| 198 | Mimic | M | no |

**giant**
| idx | name | size | flying |
|-----|------|------|--------|
| 261 ★ | Troll | L | no |
| 262 | Troll Captain | L | no |
| 263 ★ | Cyclops | L | no |
| 264 | Cyclops Alt | L | no |
| 339 ★ | Ettin | L | no |
| 340 | Ettin Alt | L | no |

**ooze**
| idx | name | size | flying |
|-----|------|------|--------|
| 217 | Purple Slime | M | no |
| 218 | Green Slime | M | no |
| 374 | Blue Jelly | S | no |
| 375 | Green Jelly | S | no |
| 376 | Red Jelly | S | no |

**aberration**
| idx | name | size | flying |
|-----|------|------|--------|
| 221 ★ | Beholder | M | yes |
| 369 | Eye | S | yes |
| 370 | Eyes | S | yes |

**plant** (nature/fey)
| idx | name | size | flying |
|-----|------|------|--------|
| 197 ★ | Treant | L | no |
| 341 | Pixie/Fairy/Sprite | S | yes |
| 363 | Turnip | S | no |
| 364 | Rotten Turnip | S | no |

**humanoid**
| idx | name | size | flying |
|-----|------|------|--------|
| 109 | Assassin | M | no |
| 110 | Bandit | M | no |
| 114 | Drow Assassin | M | no |
| 115 | Drow Fighter | M | no |
| 116 | Drow Ranger | M | no |
| 117 | Drow Mage | M | no |
| 118 | Drow Sorceress | M | no |
| 153 | Lizardman Warrior | M | no |
| 154 | Lizardman Archer | M | no |
| 155 | Lizardman Captain | M | no |
| 156 | Lizardman Shaman | M | no |
| 157 | Lizardman High Shaman | M | no |
| 181 | Gnoll Fighter | M | no |
| 182 | Gnoll Fighter Alt | M | no |
| 183 | Gnoll Fighter Captain | M | no |
| 184 | Gnoll Shaman | M | no |
| 253 | Goblin Fighter | S | no |
| 254 | Goblin Archer | S | no |
| 255 | Goblin Captain | M | no |
| 256 ★ | Goblin King | M | no |
| 257 | Goblin Mystic | S | no |
| 258 | Orc Fighter | M | no |
| 259 | Orc Captain | M | no |
| 260 | Orc Mystic | M | no |
| 304 | Witch | M | no |
| 305 | Frost Witch | M | no |
| 306 | Green Witch | M | no |

★ = `boss: true`. All others `boss: false`.

### Helpers

```ts
export const MONSTERS: Monster[];                      // the table above
export function monsterByIndex(index: number): Monster | undefined;
export function monsterName(index: number): string;    // via nameForCreatureFile
export function monstersFor(cats: MonsterCategory[]): Monster[];  // any category in cats
export function bossesFor(cats: MonsterCategory[]): Monster[];    // boss:true AND category in cats
```

---

## Component 2 — `src/domain/dungeonthemes.ts`

```ts
import type { MonsterCategory } from './bestiary';

export interface ThemeMonsters {
  categories: MonsterCategory[];        // regular/pack pool
  bossCategories?: MonsterCategory[];   // boss pool; defaults to `categories`
}

export const THEME_MONSTERS: Record<string, ThemeMonsters>;
export const FALLBACK_THEME: ThemeMonsters;   // used for unknown/legacy theme names
export function themeMonsters(name: string): ThemeMonsters;  // returns FALLBACK_THEME if unknown
```

Authoritative draft for the 21 dungeon names (from `DUNGEONS`):

| Dungeon | categories | bossCategories |
|---------|-----------|----------------|
| Greystone Keep | humanoid, beast, undead | undead |
| Crimson Court | humanoid, demon, undead | demon |
| Mossmarch Hold | beast, ooze, plant | giant |
| Emberforge | demon, elemental, construct | demon, dragon |
| Oakenvault | humanoid, beast, vermin | giant |
| Verdant Crypt | undead, plant, vermin | undead |
| Tideglass Halls | elemental, ooze, aberration | elemental |
| Frostiron Bastion | elemental, undead, construct | construct |
| Auric Deep | construct, dragon, demon | dragon |
| Rustpipe Sewers | vermin, ooze, humanoid | giant |
| Drowned Foundry | construct, elemental, ooze | construct |
| Duskstone Warren | humanoid, beast, vermin | giant |
| Thornwind Ruins | plant, beast, elemental | plant |
| Cinderdeep | demon, elemental, dragon | dragon |
| Wildroot Barrow | plant, beast, undead | plant |
| Ossuary Pale | undead, construct | undead |
| Glacierhold | elemental, beast, giant | giant |
| Bogstone Mire | ooze, vermin, undead | giant |
| Dunewatch | undead, vermin, humanoid | undead |
| Cobblemoor | beast, humanoid, vermin | giant |
| Bloodstone Cairn | undead, demon | undead |

Every listed `bossCategories` is chosen so `bossesFor(bossCategories)` is
non-empty (verified in tests). The fallback for an unknown/legacy theme is
`{ categories: ['beast','vermin','humanoid'], bossCategories: ['giant'] }`.

---

## Component 3 — `src/domain/creatures.ts` (rewrite)

Delete `MONSTER_TIERS` and `BOSSES`. New signature:

```ts
export function pickEncounterCreature(
  theme: string,
  kind: EncounterKind,
  rng: () => number,
): PickedCreature {   // { creatureIndex, footprint }
  const tm = themeMonsters(theme);
  if (kind === 'boss') {
    const pool = bossesFor(tm.bossCategories ?? tm.categories);
    const m = pick(pool.length ? pool : bossesFor(FALLBACK_THEME.bossCategories!), rng);
    return { creatureIndex: m.index, footprint: 2 };
  }
  const pool = monstersFor(tm.categories);
  const m = pick(pool.length ? pool : monstersFor(FALLBACK_THEME.categories), rng);
  return { creatureIndex: m.index, footprint: 1 };
}
```

`pick` unchanged. `dungeonLevel` is removed from the signature (depth no longer
selects creatures). Callers pass the dungeon **theme** string.

### `src/domain/encounters.ts` edits

`spawnEncounter` and `newDungeon` must thread the dungeon **theme**:

- `newDungeon` already computes `theme` — return it in the object:
  `{ id, level, theme, regular_count }`.
- `advanceToNextEncounter` reads the existing dungeon row (which has `theme`) —
  pass `dungeon.theme` through.
- `spawnEncounter(db, dungeon, index, now, cfg, rng)` calls
  `pickEncounterCreature(dungeon.theme, kind, rng)`.

The rng draw *order and count* per encounter is unchanged (still one draw for
kind, one for creature pick, one for pack count), preserving determinism shape.

---

## Component 4 — `src/domain/monstername.ts`

```ts
export function monsterTitle(
  encounterId: number,
  index: number,
  category: MonsterCategory,
): string;   // e.g. "Cursed Skeleton", "Molten Fire Demon"
```

- Deterministic: a small integer hash of `encounterId` (e.g. a fixed
  multiplicative hash — no `Math.random`) selects one adjective from the pool.
- Adjective pool = a **category-flavored** list ∪ a shared **general** list, so
  undead → *cursed / rotting / spectral / grave-touched*, fire-ish (demon,
  elemental) → *flaming / charred / molten*, ice → *frozen / frostbitten*, etc.
  The union guarantees ≥8 adjectives per category for variety.
- Stable across renders/reconnects because it keys off the persistent
  `encounter.id`. No storage needed.
- Names read naturally because `monsterName(index)` returns clean singular
  labels ("Skeleton", "Red Dragon").

Adjective dictionaries live in this module as plain arrays (data, easy to grow —
ties into `docs/BACKLOG.md#12` "large dictionary").

---

## Component 5 — shadows + TV rendering

### `src/domain/tilesheet.ts`

```ts
// Ground shadow ellipses under a monster (row 37): col 37 = S, 38 = M, 39 = L.
// Larger/rounder variants live at cols 40-41 (reserved).
export const MONSTER_SHADOWS: Record<'S' | 'M' | 'L', TileCoord> = {
  S: { col: 37, row: 37 },
  M: { col: 38, row: 37 },
  L: { col: 39, row: 37 },
};
```

### `src/web/tvview.ts`

`buildTvState` monster payload gains three fields:

```ts
monster: {
  x, y, footprint,        // existing
  index,                  // existing creature sprite index
  name: string,           // monsterTitle(encounter.id, index, category)
  size: 'S' | 'M' | 'L',  // from bestiary
  flying: boolean,        // from bestiary
}
```

Resolved via `monsterByIndex(creature_index)`. If the index is not in the
bestiary (legacy encounter rows), fall back to `size:'M', flying:false` and the
raw creature index, with the plain `monsterName` (or "Monster") as the label —
never throw.

### `src/web/public/tv/tv.js`

`drawMonster`:
1. Compute the monster's tile position (existing).
2. Draw `MONSTER_SHADOWS[size]` scaled to the footprint, centered on the
   monster's ground row. For `flying`, draw the shadow at the ground row and
   draw the sprite **raised** by a small offset (≈ 0.25 tile) so it reads as
   hovering; for grounded monsters the sprite sits on the shadow.
3. Draw the sprite (existing), with the raise offset applied when flying.

Name label: render `state.monster.name` centered in the strip **above the HP
bar** (the space reserved in the last layout pass), using the existing
`shadowText` helper, sized a step larger than the HP numerals per the earlier
"monster name should be bigger than the bar" note.

---

## Testing

New/updated tests (vitest):

**`tests/bestiary.test.ts`**
- Every `MONSTER.index` is a valid **frame-A** file index (i.e.
  `nameForCreatureFile(index)` is non-null) and `monsterName(index)` is a
  non-empty string.
- No duplicate indices.
- Every `MonsterCategory` value is represented by ≥1 monster.
- `monstersFor`/`bossesFor` filter correctly; `bossesFor` returns only
  `boss:true`.

**`tests/dungeonthemes.test.ts`**
- Every one of the 21 `DUNGEONS` names has an entry in `THEME_MONSTERS`.
- For every dungeon, `monstersFor(categories)` and
  `bossesFor(bossCategories ?? categories)` are both **non-empty** (guarantees
  every theme can spawn a regular and a boss).

**`tests/creatures.test.ts`** (rewrite)
- `pickEncounterCreature(theme, 'single'|'pack', rng)` returns footprint 1 and a
  creature whose category is in the theme's list; `'boss'` returns footprint 2
  and a `boss:true` creature.
- Deterministic given the same rng sequence.
- Unknown theme falls back without throwing and still returns a valid creature.

**`tests/monstername.test.ts`**
- `monsterTitle` is deterministic for a fixed `(encounterId, index, category)`.
- Output is `"<adjective> <name>"` and varies across different encounter ids.

**`tests/tvview.test.ts`** (extend)
- Built state's `monster` carries `name` (non-empty), `size` ∈ {S,M,L}, and a
  boolean `flying`, resolved from the bestiary for the active encounter.

**`tests/encounters.test.ts`** (extend if present)
- A spawned encounter's `creature_index` is a bestiary index consistent with the
  dungeon theme.

Full suite + `npm run typecheck` must stay green (currently 193 tests).

---

## Risks / notes

- **Legacy encounter rows** hold old (buggy) creature indices. Cosmetic history
  only; the view-model's bestiary-miss fallback keeps them from throwing. New
  encounters use correct indices immediately.
- **Single-category limitation**: a creature belongs to exactly one category, so
  a few assignments are pragmatic (Necromancer/Dark Wizard → undead so they haunt
  crypts; witches → humanoid). Acceptable for a flavor system; revisit only if a
  dungeon feels wrong on the TV.
- **Shadow tile sizes**: S/M/L confirmed at row 37 cols 37–39 by direct sheet
  crop. If the L ellipse reads too small under 2×2 bosses on the real TV, cols
  40–41 hold larger variants to swap in (data-only change).
- The HP/difficulty model is deliberately untouched, so battle pacing is
  unaffected.

# Themed Bestiary + Encounter Engine + Monster Name Flare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `MONSTER_TIERS`/`BOSSES` with a category-based bestiary that gates encounter creatures by dungeon theme, and render each monster's name (`"<adjective> <creature>"`) plus a size/flying-driven ground shadow on the TV.

**Architecture:** A pure data module (`bestiary.ts`) is the single source of monster truth (corrected frame-A sprite indices + category/size/flying/boss). A small theme→category map (`dungeonthemes.ts`) drives selection. `creatures.ts` is rewritten to pick from the bestiary by theme; `encounters.ts` threads the dungeon theme through. `monstername.ts` builds deterministic titles. The TV view-model carries the name/size/flying, and `tv.js` renders them.

**Tech Stack:** TypeScript ESM run via `tsx` (no build step), vitest, better-sqlite3. Browser renderer is dependency-free vanilla JS (Canvas 2D).

Spec: `docs/superpowers/specs/2026-07-11-themed-bestiary-design.md`.

## Global Constraints

- **No build step.** ESM run directly via `tsx`. Typecheck with `npm run typecheck` (`tsc --noEmit`); tests with `npx vitest run`.
- **Determinism in domain code.** No `Date.now()` / `Math.random()` in `src/domain/**`. Selection takes an injected `rng: () => number`; titles derive from the encounter id via a fixed integer hash.
- **Creature sprite index == file number.** `creatureSpriteFile(index)` → `oryx_16bit_fantasy_creatures_<index>.png`. Bestiary indices are **frame-A file indices** (verified: `nameForCreatureFile(index)` non-null).
- **`tv.js` is dependency-free browser JS** — it has no module imports; tile coordinates are hardcoded as local `const`s (mirroring the existing `SHADOW`/`TEX` constants), kept consistent with `tilesheet.ts`.
- **Suite stays green:** baseline is 193 tests passing + clean typecheck. Every task ends green.
- **Frame-A only** for all monster indices.

---

## File Structure

- Create: `src/domain/bestiary.ts`, `tests/bestiary.test.ts`
- Create: `src/domain/dungeonthemes.ts`, `tests/dungeonthemes.test.ts`
- Create: `src/domain/monstername.ts`, `tests/monstername.test.ts`
- Modify: `src/web/catalog/build.ts`, `src/web/routes/catalog.ts`, `tests/catalog-build.test.ts` (repoint annotations off `MONSTER_TIERS`/`BOSSES`)
- Modify (rewrite): `src/domain/creatures.ts`, `tests/creatures.test.ts`
- Modify: `src/domain/encounters.ts` (thread theme), `tests/encounters.test.ts` (extend)
- Modify: `src/domain/tilesheet.ts` (add `MONSTER_SHADOWS`)
- Modify: `src/web/tvview.ts` (add name/size/flying to `TvEncounter`), `tests/tvview-state.test.ts` (extend)
- Modify: `src/web/public/tv/tv.js` (shadow + flying raise + name label)

---

## Task 1: Bestiary data module

**Files:**
- Create: `src/domain/bestiary.ts`
- Test: `tests/bestiary.test.ts`

**Interfaces:**
- Consumes: `nameForCreatureFile`, `CREATURE_SHEET_NAMES` (from `src/web/catalog/build.ts` and `src/web/catalog/spritenames.ts`).
- Produces: `MonsterCategory`, `MonsterSize`, `Monster`, `MONSTERS`, `monsterByIndex(index)`, `monsterName(index)`, `monstersFor(cats)`, `bossesFor(cats)`.

- [ ] **Step 1: Write the failing test** — `tests/bestiary.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  MONSTERS, monsterByIndex, monsterName, monstersFor, bossesFor,
  type MonsterCategory,
} from '../src/domain/bestiary';
import { nameForCreatureFile } from '../src/web/catalog/build';
import { CREATURE_SHEET_NAMES } from '../src/web/catalog/spritenames';

const ALL_CATEGORIES: MonsterCategory[] = [
  'undead','demon','beast','vermin','elemental','dragon',
  'construct','humanoid','ooze','giant','aberration','plant',
];

describe('bestiary', () => {
  it('every monster index is a valid frame-A file with a name', () => {
    for (const m of MONSTERS) {
      expect(nameForCreatureFile(m.index, CREATURE_SHEET_NAMES)).not.toBeNull();
      expect(monsterName(m.index).length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate indices', () => {
    const seen = new Set(MONSTERS.map((m) => m.index));
    expect(seen.size).toBe(MONSTERS.length);
  });

  it('every category is represented, and every category has a boss', () => {
    for (const c of ALL_CATEGORIES) {
      expect(monstersFor([c]).length).toBeGreaterThan(0);
      expect(bossesFor([c]).length).toBeGreaterThan(0);
    }
  });

  it('monstersFor filters by category; bossesFor returns only bosses', () => {
    for (const m of monstersFor(['undead'])) expect(m.category).toBe('undead');
    for (const m of bossesFor(['dragon'])) { expect(m.boss).toBe(true); expect(m.category).toBe('dragon'); }
  });

  it('monsterByIndex resolves known creatures', () => {
    expect(monsterByIndex(291)?.category).toBe('undead'); // Skeleton
    expect(monsterName(325)).toBe('Red Dragon');
    expect(monsterByIndex(9999)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/bestiary.test.ts`
Expected: FAIL — cannot find module `../src/domain/bestiary`.

- [ ] **Step 3: Write `src/domain/bestiary.ts`**

Header + types + helpers, then the roster array transcribed verbatim from the spec's Component 1 table (reproduced below in full — do not abbreviate):

```ts
import { nameForCreatureFile } from '../web/catalog/build';
import { CREATURE_SHEET_NAMES } from '../web/catalog/spritenames';

export type MonsterCategory =
  | 'undead' | 'demon' | 'beast' | 'vermin' | 'elemental'
  | 'dragon' | 'construct' | 'humanoid' | 'ooze' | 'giant'
  | 'aberration' | 'plant';

export type MonsterSize = 'S' | 'M' | 'L';

export interface Monster {
  index: number;          // frame-A file index in creatures_24x24 (== sprite file number)
  category: MonsterCategory;
  size: MonsterSize;      // selects the ground-shadow tile
  flying: boolean;        // raise sprite + keep shadow on the ground for a float
  boss: boolean;          // eligible to be a 2x2 boss
}

export const MONSTERS: Monster[] = [
  { index: 265, category: 'undead', size: 'M', flying: false, boss: false }, // Death Knight
  { index: 266, category: 'undead', size: 'M', flying: false, boss: false }, // Death Knight Alt
  { index: 267, category: 'undead', size: 'M', flying: false, boss: false }, // Death Knight Alt
  { index: 289, category: 'undead', size: 'M', flying: false, boss: false }, // Zombie
  { index: 290, category: 'undead', size: 'M', flying: false, boss: false }, // Headless Zombie
  { index: 291, category: 'undead', size: 'M', flying: false, boss: false }, // Skeleton
  { index: 292, category: 'undead', size: 'M', flying: false, boss: false }, // Skeleton Archer
  { index: 293, category: 'undead', size: 'M', flying: false, boss: false }, // Skeleton Warrior
  { index: 294, category: 'undead', size: 'M', flying: true, boss: false }, // Shadow
  { index: 295, category: 'undead', size: 'M', flying: true, boss: false }, // Ghost
  { index: 296, category: 'undead', size: 'M', flying: false, boss: false }, // Mummy
  { index: 297, category: 'undead', size: 'M', flying: false, boss: true }, // Pharoah
  { index: 298, category: 'undead', size: 'M', flying: false, boss: false }, // Necromancer
  { index: 299, category: 'undead', size: 'M', flying: false, boss: false }, // Dark Wizard
  { index: 300, category: 'undead', size: 'L', flying: true, boss: true }, // Death
  { index: 301, category: 'undead', size: 'M', flying: false, boss: false }, // Vampire
  { index: 302, category: 'undead', size: 'M', flying: false, boss: false }, // Vampire Alt
  { index: 303, category: 'undead', size: 'M', flying: false, boss: true }, // Vampire Lord
  { index: 371, category: 'undead', size: 'S', flying: true, boss: false }, // Red Specter
  { index: 372, category: 'undead', size: 'S', flying: true, boss: false }, // Blue Specter
  { index: 373, category: 'undead', size: 'S', flying: true, boss: false }, // Brown Specter
  { index: 188, category: 'demon', size: 'L', flying: false, boss: true }, // Elder Demon
  { index: 189, category: 'demon', size: 'L', flying: false, boss: true }, // Fire Demon
  { index: 190, category: 'demon', size: 'M', flying: false, boss: false }, // Horned Demon
  { index: 342, category: 'demon', size: 'S', flying: true, boss: false }, // Imp/Demon/Devil
  { index: 365, category: 'demon', size: 'S', flying: false, boss: false }, // Fire Minion
  { index: 367, category: 'demon', size: 'S', flying: true, boss: false }, // Smoke Minion
  { index: 185, category: 'beast', size: 'L', flying: false, boss: true }, // Minotaur Axe
  { index: 186, category: 'beast', size: 'L', flying: false, boss: false }, // Minotaur Club
  { index: 187, category: 'beast', size: 'L', flying: false, boss: false }, // Minotaur Alt
  { index: 226, category: 'beast', size: 'S', flying: false, boss: false }, // Cobra
  { index: 229, category: 'beast', size: 'M', flying: false, boss: false }, // Grey Wolf
  { index: 230, category: 'beast', size: 'M', flying: false, boss: false }, // Brown Wolf
  { index: 231, category: 'beast', size: 'M', flying: false, boss: false }, // Black Wolf
  { index: 329, category: 'beast', size: 'L', flying: false, boss: true }, // Yeti
  { index: 330, category: 'beast', size: 'L', flying: false, boss: false }, // Yeti Alt
  { index: 333, category: 'beast', size: 'M', flying: false, boss: false }, // Brown Bear
  { index: 334, category: 'beast', size: 'M', flying: false, boss: true }, // Grey Bear
  { index: 335, category: 'beast', size: 'L', flying: false, boss: true }, // Polar Bear
  { index: 219, category: 'vermin', size: 'S', flying: true, boss: false }, // Black Bat
  { index: 220, category: 'vermin', size: 'S', flying: true, boss: false }, // Red Bat
  { index: 222, category: 'vermin', size: 'S', flying: false, boss: false }, // Red Spider
  { index: 223, category: 'vermin', size: 'S', flying: false, boss: true }, // Black Spider
  { index: 224, category: 'vermin', size: 'S', flying: false, boss: false }, // Grey Rat
  { index: 225, category: 'vermin', size: 'S', flying: false, boss: false }, // Brown Rat
  { index: 227, category: 'vermin', size: 'S', flying: false, boss: false }, // Beetle
  { index: 228, category: 'vermin', size: 'S', flying: false, boss: false }, // Fire Beetle
  { index: 331, category: 'vermin', size: 'S', flying: false, boss: true }, // Giant Leech
  { index: 332, category: 'vermin', size: 'M', flying: false, boss: false }, // Giant Worm
  { index: 336, category: 'vermin', size: 'M', flying: false, boss: true }, // Giant Scorpion
  { index: 337, category: 'vermin', size: 'M', flying: false, boss: false }, // Scorpion Alt
  { index: 338, category: 'vermin', size: 'M', flying: false, boss: false }, // Scorpion Alt
  { index: 196, category: 'elemental', size: 'M', flying: true, boss: true }, // Djinn
  { index: 268, category: 'elemental', size: 'L', flying: false, boss: true }, // Earth Elemental
  { index: 269, category: 'elemental', size: 'M', flying: false, boss: false }, // Ice/Water Elemental
  { index: 270, category: 'elemental', size: 'M', flying: true, boss: false }, // Air Elemental
  { index: 361, category: 'elemental', size: 'S', flying: true, boss: false }, // Wisp
  { index: 362, category: 'elemental', size: 'S', flying: true, boss: false }, // Wisp Alt
  { index: 366, category: 'elemental', size: 'S', flying: false, boss: false }, // Ice Minion
  { index: 368, category: 'elemental', size: 'S', flying: false, boss: false }, // Mud Minion
  { index: 377, category: 'elemental', size: 'S', flying: true, boss: false }, // Flame
  { index: 378, category: 'elemental', size: 'S', flying: true, boss: false }, // Cold Flame
  { index: 325, category: 'dragon', size: 'L', flying: false, boss: true }, // Red Dragon
  { index: 326, category: 'dragon', size: 'L', flying: false, boss: true }, // Purple Dragon
  { index: 327, category: 'dragon', size: 'L', flying: false, boss: true }, // Gold Dragon
  { index: 328, category: 'dragon', size: 'L', flying: false, boss: true }, // Green Dragon
  { index: 191, category: 'construct', size: 'L', flying: false, boss: true }, // Stone Golem
  { index: 192, category: 'construct', size: 'L', flying: false, boss: false }, // Mud Golem
  { index: 193, category: 'construct', size: 'L', flying: false, boss: false }, // Flesh Golem
  { index: 194, category: 'construct', size: 'L', flying: false, boss: true }, // Lava Golem
  { index: 195, category: 'construct', size: 'L', flying: false, boss: true }, // Bone Golem
  { index: 198, category: 'construct', size: 'M', flying: false, boss: true }, // Mimic
  { index: 261, category: 'giant', size: 'L', flying: false, boss: true }, // Troll
  { index: 262, category: 'giant', size: 'L', flying: false, boss: false }, // Troll Captain
  { index: 263, category: 'giant', size: 'L', flying: false, boss: true }, // Cycops
  { index: 264, category: 'giant', size: 'L', flying: false, boss: false }, // Cyclops Alt
  { index: 339, category: 'giant', size: 'L', flying: false, boss: true }, // Ettin
  { index: 340, category: 'giant', size: 'L', flying: false, boss: false }, // Ettin Alt
  { index: 217, category: 'ooze', size: 'S', flying: false, boss: false }, // Purple Slime
  { index: 218, category: 'ooze', size: 'S', flying: false, boss: false }, // Green Slime
  { index: 374, category: 'ooze', size: 'M', flying: false, boss: true }, // Blue Jelly
  { index: 375, category: 'ooze', size: 'M', flying: false, boss: true }, // Green Jelly
  { index: 376, category: 'ooze', size: 'M', flying: false, boss: true }, // Red Jelly
  { index: 221, category: 'aberration', size: 'M', flying: true, boss: true }, // Beholder
  { index: 369, category: 'aberration', size: 'S', flying: true, boss: false }, // Eye
  { index: 370, category: 'aberration', size: 'S', flying: true, boss: false }, // Eyes
  { index: 197, category: 'plant', size: 'L', flying: false, boss: true }, // Treant
  { index: 341, category: 'plant', size: 'S', flying: true, boss: false }, // Pixie/Fairy/Sprite
  { index: 363, category: 'plant', size: 'S', flying: false, boss: false }, // Turnip
  { index: 364, category: 'plant', size: 'S', flying: false, boss: false }, // Rotten Turnip
  { index: 109, category: 'humanoid', size: 'M', flying: false, boss: false }, // Assassin
  { index: 110, category: 'humanoid', size: 'M', flying: false, boss: false }, // Bandit
  { index: 114, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Assassin
  { index: 115, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Fighter
  { index: 116, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Ranger
  { index: 117, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Mage
  { index: 118, category: 'humanoid', size: 'M', flying: false, boss: false }, // Drow Sorceress
  { index: 153, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Warrior
  { index: 154, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Archer
  { index: 155, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Captain
  { index: 156, category: 'humanoid', size: 'M', flying: false, boss: false }, // Lizardman Shaman
  { index: 157, category: 'humanoid', size: 'M', flying: false, boss: true }, // Lizardman High Shaman
  { index: 181, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Fighter
  { index: 182, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Fighter Alt
  { index: 183, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Fighter Captain
  { index: 184, category: 'humanoid', size: 'M', flying: false, boss: false }, // Gnoll Shaman
  { index: 253, category: 'humanoid', size: 'S', flying: false, boss: true }, // Goblin Fighter
  { index: 254, category: 'humanoid', size: 'S', flying: false, boss: false }, // Goblin Archer
  { index: 255, category: 'humanoid', size: 'M', flying: false, boss: true }, // Goblin Captain
  { index: 256, category: 'humanoid', size: 'M', flying: false, boss: true }, // Goblin King
  { index: 257, category: 'humanoid', size: 'S', flying: false, boss: true }, // Goblin Mystic
  { index: 258, category: 'humanoid', size: 'M', flying: false, boss: false }, // Orc Fighter
  { index: 259, category: 'humanoid', size: 'M', flying: false, boss: true }, // Orc Captain
  { index: 260, category: 'humanoid', size: 'M', flying: false, boss: false }, // Orc Mystic
  { index: 304, category: 'humanoid', size: 'M', flying: false, boss: false }, // Witch
  { index: 305, category: 'humanoid', size: 'M', flying: false, boss: true }, // Frost Witch
  { index: 306, category: 'humanoid', size: 'M', flying: false, boss: false }, // Green Witch
];

const BY_INDEX = new Map<number, Monster>(MONSTERS.map((m) => [m.index, m]));

export function monsterByIndex(index: number): Monster | undefined {
  return BY_INDEX.get(index);
}

/** Clean singular display name from the doc, or 'Monster' for an unknown index. */
export function monsterName(index: number): string {
  return nameForCreatureFile(index, CREATURE_SHEET_NAMES) ?? 'Monster';
}

export function monstersFor(cats: MonsterCategory[]): Monster[] {
  const set = new Set(cats);
  return MONSTERS.filter((m) => set.has(m.category));
}

export function bossesFor(cats: MonsterCategory[]): Monster[] {
  const set = new Set(cats);
  return MONSTERS.filter((m) => m.boss && set.has(m.category));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bestiary.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/bestiary.ts tests/bestiary.test.ts
git commit -m "feat(bestiary): categorized monster roster with corrected frame-A indices"
```

---

## Task 2: Dungeon theme → category map

**Files:**
- Create: `src/domain/dungeonthemes.ts`
- Test: `tests/dungeonthemes.test.ts`

**Interfaces:**
- Consumes: `MonsterCategory` (bestiary), `monstersFor`/`bossesFor` (bestiary, in tests), `DUNGEONS` (from `src/domain/floorgroups.ts`, in tests).
- Produces: `ThemeMonsters`, `THEME_MONSTERS`, `FALLBACK_THEME`, `themeMonsters(name)`.

- [ ] **Step 1: Write the failing test** — `tests/dungeonthemes.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { THEME_MONSTERS, FALLBACK_THEME, themeMonsters } from '../src/domain/dungeonthemes';
import { monstersFor, bossesFor } from '../src/domain/bestiary';
import { DUNGEONS } from '../src/domain/floorgroups';

describe('dungeonthemes', () => {
  it('maps every dungeon in the roster', () => {
    for (const d of DUNGEONS) expect(THEME_MONSTERS[d.name]).toBeDefined();
  });

  it('every theme can spawn a regular and a boss', () => {
    for (const [name, tm] of Object.entries(THEME_MONSTERS)) {
      expect(monstersFor(tm.categories).length, name).toBeGreaterThan(0);
      expect(bossesFor(tm.bossCategories ?? tm.categories).length, name).toBeGreaterThan(0);
    }
  });

  it('the fallback is usable and returned for unknown names', () => {
    expect(monstersFor(FALLBACK_THEME.categories).length).toBeGreaterThan(0);
    expect(bossesFor(FALLBACK_THEME.bossCategories ?? FALLBACK_THEME.categories).length).toBeGreaterThan(0);
    expect(themeMonsters('nonesuch legacy theme')).toEqual(FALLBACK_THEME);
    expect(themeMonsters('Ossuary Pale')).toBe(THEME_MONSTERS['Ossuary Pale']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/dungeonthemes.test.ts`
Expected: FAIL — cannot find module `../src/domain/dungeonthemes`.

- [ ] **Step 3: Write `src/domain/dungeonthemes.ts`**

```ts
import type { MonsterCategory } from './bestiary';

export interface ThemeMonsters {
  categories: MonsterCategory[];        // regular/pack pool
  bossCategories?: MonsterCategory[];   // boss pool; defaults to `categories`
}

// One entry per usable dungeon in DUNGEONS (floorgroups). Category assignments
// are pragmatic-thematic; every bossCategories resolves to >=1 boss (tested).
export const THEME_MONSTERS: Record<string, ThemeMonsters> = {
  'Greystone Keep':    { categories: ['humanoid', 'beast', 'undead'],       bossCategories: ['undead'] },
  'Crimson Court':     { categories: ['humanoid', 'demon', 'undead'],       bossCategories: ['demon'] },
  'Mossmarch Hold':    { categories: ['beast', 'ooze', 'plant'],            bossCategories: ['giant'] },
  'Emberforge':        { categories: ['demon', 'elemental', 'construct'],   bossCategories: ['demon', 'dragon'] },
  'Oakenvault':        { categories: ['humanoid', 'beast', 'vermin'],       bossCategories: ['giant'] },
  'Verdant Crypt':     { categories: ['undead', 'plant', 'vermin'],         bossCategories: ['undead'] },
  'Tideglass Halls':   { categories: ['elemental', 'ooze', 'aberration'],   bossCategories: ['elemental'] },
  'Frostiron Bastion': { categories: ['elemental', 'undead', 'construct'],  bossCategories: ['construct'] },
  'Auric Deep':        { categories: ['construct', 'dragon', 'demon'],      bossCategories: ['dragon'] },
  'Rustpipe Sewers':   { categories: ['vermin', 'ooze', 'humanoid'],        bossCategories: ['giant'] },
  'Drowned Foundry':   { categories: ['construct', 'elemental', 'ooze'],    bossCategories: ['construct'] },
  'Duskstone Warren':  { categories: ['humanoid', 'beast', 'vermin'],       bossCategories: ['giant'] },
  'Thornwind Ruins':   { categories: ['plant', 'beast', 'elemental'],       bossCategories: ['plant'] },
  'Cinderdeep':        { categories: ['demon', 'elemental', 'dragon'],      bossCategories: ['dragon'] },
  'Wildroot Barrow':   { categories: ['plant', 'beast', 'undead'],          bossCategories: ['plant'] },
  'Ossuary Pale':      { categories: ['undead', 'construct'],               bossCategories: ['undead'] },
  'Glacierhold':       { categories: ['elemental', 'beast', 'giant'],       bossCategories: ['giant'] },
  'Bogstone Mire':     { categories: ['ooze', 'vermin', 'undead'],          bossCategories: ['giant'] },
  'Dunewatch':         { categories: ['undead', 'vermin', 'humanoid'],      bossCategories: ['undead'] },
  'Cobblemoor':        { categories: ['beast', 'humanoid', 'vermin'],       bossCategories: ['giant'] },
  'Bloodstone Cairn':  { categories: ['undead', 'demon'],                   bossCategories: ['demon'] },
};

export const FALLBACK_THEME: ThemeMonsters = {
  categories: ['beast', 'vermin', 'humanoid'],
  bossCategories: ['giant'],
};

export function themeMonsters(name: string): ThemeMonsters {
  return THEME_MONSTERS[name] ?? FALLBACK_THEME;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeonthemes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/dungeonthemes.ts tests/dungeonthemes.test.ts
git commit -m "feat(dungeonthemes): map each dungeon to its monster categories"
```

---

## Task 3: Repoint the catalog annotations off `MONSTER_TIERS`/`BOSSES`

The dev `/catalog` annotates creature cells from `MONSTER_TIERS`/`BOSSES`. Task 4 deletes those, so first move the catalog onto the bestiary. After this task, only `creatures.ts` + its test reference the old symbols.

**Files:**
- Modify: `src/web/catalog/build.ts` (CatalogInput + annotation logic)
- Modify: `src/web/routes/catalog.ts` (pass bestiary)
- Modify: `tests/catalog-build.test.ts`

**Interfaces:**
- Consumes: `MONSTERS` (bestiary).
- Produces: `CatalogInput.monsters` replaces `CatalogInput.tiers` + `CatalogInput.bosses`.

- [ ] **Step 1: Update the test** — `tests/catalog-build.test.ts`

Replace the two `run()`/orphan-test input fields `tiers`/`bosses` and the expected annotation:

In `run()` (around lines 44-45), replace:
```ts
    tiers: [[37]],
    bosses: [37],
```
with:
```ts
    monsters: [{ index: 37, category: 'humanoid', boss: true }],
```

Update the expectation (line 95) from:
```ts
    expect(p37.annotation).toEqual(['tier 1', 'boss']);
```
to:
```ts
    expect(p37.annotation).toEqual(['humanoid', 'boss']);
```

In the orphaned-frame-A test (around lines 130-131), replace:
```ts
      tiers: [],
      bosses: [],
```
with:
```ts
      monsters: [],
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/catalog-build.test.ts`
Expected: FAIL — `monsters` not a known property / annotation mismatch.

- [ ] **Step 3: Update `src/web/catalog/build.ts`**

Change the `CatalogInput` fields (lines 37-38) from:
```ts
  tiers: number[][]; // MONSTER_TIERS
  bosses: number[]; // BOSSES
```
to:
```ts
  monsters: { index: number; category: string; boss: boolean }[]; // bestiary MONSTERS
```

Replace the annotation branch inside `buildCatalog` (the `else { input.tiers.forEach(...) ... }` block, lines 85-91) with:
```ts
      } else {
        const m = input.monsters.find((mo) => mo.index === aIndex);
        if (m) {
          annotation.push(m.category);
          if (m.boss) annotation.push('boss');
        } else {
          annotation.push('unused');
        }
      }
```

- [ ] **Step 4: Update `src/web/routes/catalog.ts`**

Replace the import (line 9):
```ts
import { MONSTER_TIERS, BOSSES } from '../../domain/creatures';
```
with:
```ts
import { MONSTERS } from '../../domain/bestiary';
```

Replace the `buildCatalog({ ... })` fields (lines 39-40):
```ts
        tiers: MONSTER_TIERS,
        bosses: BOSSES,
```
with:
```ts
        monsters: MONSTERS,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/catalog-build.test.ts tests/web-catalog.test.ts`
Expected: PASS. Then `npm run typecheck` — clean (catalog no longer imports the soon-deleted symbols).

- [ ] **Step 6: Commit**

```bash
git add src/web/catalog/build.ts src/web/routes/catalog.ts tests/catalog-build.test.ts
git commit -m "refactor(catalog): annotate creatures from the bestiary, not MONSTER_TIERS"
```

---

## Task 4: Rewrite `creatures.ts` for theme-gated selection + thread theme through `encounters.ts`

**Files:**
- Modify (rewrite): `src/domain/creatures.ts`
- Modify: `src/domain/encounters.ts`
- Test: `tests/creatures.test.ts` (rewrite), `tests/encounters.test.ts` (extend)

**Interfaces:**
- Consumes: `themeMonsters`, `FALLBACK_THEME` (dungeonthemes); `monstersFor`, `bossesFor` (bestiary).
- Produces: `pickEncounterCreature(theme: string, kind: EncounterKind, rng)` → `{ creatureIndex, footprint }`. `EncounterKind`, `PickedCreature` unchanged. `MONSTER_TIERS`/`BOSSES` removed.

- [ ] **Step 1: Rewrite the test** — replace all of `tests/creatures.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { pickEncounterCreature } from '../src/domain/creatures';
import { monsterByIndex } from '../src/domain/bestiary';
import { THEME_MONSTERS, themeMonsters } from '../src/domain/dungeonthemes';

const rng0 = () => 0;

describe('creatures — theme-gated selection', () => {
  it('regular pick is a 1x1 creature whose category is in the theme', () => {
    const tm = THEME_MONSTERS['Ossuary Pale'];
    const c = pickEncounterCreature('Ossuary Pale', 'single', rng0);
    expect(c.footprint).toBe(1);
    expect(tm.categories).toContain(monsterByIndex(c.creatureIndex)!.category);
  });

  it('pack pick is also 1x1 and theme-valid', () => {
    const c = pickEncounterCreature('Emberforge', 'pack', rng0);
    expect(c.footprint).toBe(1);
    expect(THEME_MONSTERS['Emberforge'].categories)
      .toContain(monsterByIndex(c.creatureIndex)!.category);
  });

  it('boss pick is a 2x2 boss whose category is in the theme boss pool', () => {
    const tm = THEME_MONSTERS['Ossuary Pale'];
    const c = pickEncounterCreature('Ossuary Pale', 'boss', rng0);
    expect(c.footprint).toBe(2);
    const m = monsterByIndex(c.creatureIndex)!;
    expect(m.boss).toBe(true);
    expect(tm.bossCategories ?? tm.categories).toContain(m.category);
  });

  it('is deterministic for a fixed rng', () => {
    const seq = () => 0.42;
    expect(pickEncounterCreature('Cinderdeep', 'single', seq).creatureIndex)
      .toBe(pickEncounterCreature('Cinderdeep', 'single', seq).creatureIndex);
  });

  it('unknown theme falls back without throwing and returns a valid creature', () => {
    const c = pickEncounterCreature('legacy_stone_crypt', 'single', rng0);
    expect(c.footprint).toBe(1);
    expect(monsterByIndex(c.creatureIndex)).toBeDefined();
    expect(themeMonsters('legacy_stone_crypt').categories)
      .toContain(monsterByIndex(c.creatureIndex)!.category);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/creatures.test.ts`
Expected: FAIL — `pickEncounterCreature` still has the old `(dungeonLevel, ...)` signature / imports removed symbols.

- [ ] **Step 3: Rewrite `src/domain/creatures.ts`**

```ts
import { monstersFor, bossesFor } from './bestiary';
import { themeMonsters, FALLBACK_THEME } from './dungeonthemes';

export type EncounterKind = 'single' | 'pack' | 'boss';

export interface PickedCreature {
  creatureIndex: number;
  footprint: number; // 1 = 1x1, 2 = 2x2
}

function pick<T>(arr: T[], rng: () => number): T {
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}

/** Choose a creature for an encounter, gated by the dungeon theme. */
export function pickEncounterCreature(
  theme: string,
  kind: EncounterKind,
  rng: () => number,
): PickedCreature {
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

- [ ] **Step 4: Thread the theme through `src/domain/encounters.ts`**

`newDungeon` — add `theme` to the returned object (it already computes `theme`):
```ts
function newDungeon(
  db: Database.Database, level: number, now: number, cfg: EngineConfig, rng: () => number,
): { id: number; level: number; theme: string; regular_count: number } {
  const theme = pickDungeonTheme(rng);
  const seed = Math.floor(rng() * 2_000_000_000);
  const span = Math.max(0, cfg.regularEncountersMax - cfg.regularEncountersMin);
  const regularCount = cfg.regularEncountersMin + Math.floor(rng() * (span + 1));
  const info = db.prepare(
    'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (?,?,?,?,?)',
  ).run(level, theme, seed, regularCount, now);
  return { id: Number(info.lastInsertRowid), level, theme, regular_count: regularCount };
}
```

`spawnEncounter` — widen the `dungeon` param type to include `theme` and use it:
```ts
function spawnEncounter(
  db: Database.Database,
  dungeon: { id: number; level: number; theme: string; regular_count: number },
  index: number,
  now: number,
  cfg: EngineConfig,
  rng: () => number,
): number {
  const isBoss = index >= dungeon.regular_count;
  const kind: EncounterKind = isBoss ? 'boss' : rng() < 0.5 ? 'single' : 'pack';
  const creature = pickEncounterCreature(dungeon.theme, kind, rng);
  // ...rest unchanged (packCount, difficulty, dpm, hp, INSERT)...
}
```

`advanceToNextEncounter` — the existing dungeon comes from the DB row (which has
`theme`), and `newDungeon` now returns `theme`, so all three `spawnEncounter`
call sites already pass an object carrying `theme`. No further change needed
there beyond the widened types compiling. Verify the mid-dungeon call
`spawnEncounter(db, dungeon, lastIdx + 1, ...)` uses the DB-row `dungeon` (has
`theme`).

The rng draw order/count per encounter is unchanged (kind draw, creature pick,
pack-count draw), so `encounters-theme.test.ts` determinism holds.

- [ ] **Step 5: Extend `tests/encounters.test.ts`**

Add a test that a spawned encounter's creature matches the dungeon theme. Append inside the file (uses the existing `openDb`/`seedSettings` harness and a helper to force a known theme):

```ts
import { advanceToNextEncounter } from '../src/domain/encounters';
import { monsterByIndex } from '../src/domain/bestiary';
import { themeMonsters } from '../src/domain/dungeonthemes';

describe('spawned encounter respects the dungeon theme', () => {
  it('creature_index is a bestiary monster in the theme categories', () => {
    advanceToNextEncounter(db, 100000, loadEngineConfig(db), () => 0.3);
    const gs = db.prepare('SELECT current_dungeon_id, current_encounter_id FROM game_state WHERE id=1').get() as any;
    const d = db.prepare('SELECT theme FROM dungeons WHERE id=?').get(gs.current_dungeon_id) as any;
    const e = db.prepare('SELECT creature_index, footprint FROM encounters WHERE id=?').get(gs.current_encounter_id) as any;
    const m = monsterByIndex(e.creature_index);
    expect(m).toBeDefined();
    const tm = themeMonsters(d.theme);
    const allowed = new Set([...(tm.bossCategories ?? []), ...tm.categories]);
    expect(allowed.has(m!.category)).toBe(true);
  });
});
```

(If `loadEngineConfig` is not already imported in the file, it is — see its
existing import block. `advanceToNextEncounter` is too.)

- [ ] **Step 6: Run the affected tests**

Run: `npx vitest run tests/creatures.test.ts tests/encounters.test.ts tests/encounters-theme.test.ts`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/domain/creatures.ts src/domain/encounters.ts tests/creatures.test.ts tests/encounters.test.ts
git commit -m "feat(encounters): theme-gated creature selection; drop MONSTER_TIERS/BOSSES"
```

---

## Task 5: Deterministic monster titles (`<adjective> <creature>`)

**Files:**
- Create: `src/domain/monstername.ts`
- Test: `tests/monstername.test.ts`

**Interfaces:**
- Consumes: `MonsterCategory`, `monsterName` (bestiary).
- Produces: `monsterTitle(encounterId: number, index: number, category: MonsterCategory): string`.

- [ ] **Step 1: Write the failing test** — `tests/monstername.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { monsterTitle } from '../src/domain/monstername';
import { monsterName } from '../src/domain/bestiary';

describe('monsterTitle', () => {
  it('is deterministic for the same inputs', () => {
    expect(monsterTitle(42, 291, 'undead')).toBe(monsterTitle(42, 291, 'undead'));
  });

  it('is "<Adjective> <Creature name>"', () => {
    const t = monsterTitle(7, 291, 'undead'); // Skeleton
    expect(t.endsWith(monsterName(291))).toBe(true);
    expect(t.split(' ')[0][0]).toBe(t.split(' ')[0][0].toUpperCase()); // capitalized adjective
    expect(t.length).toBeGreaterThan(monsterName(291).length + 1);
  });

  it('varies across encounter ids', () => {
    const titles = new Set(Array.from({ length: 40 }, (_, i) => monsterTitle(i + 1, 291, 'undead')));
    expect(titles.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/monstername.test.ts`
Expected: FAIL — cannot find module `../src/domain/monstername`.

- [ ] **Step 3: Write `src/domain/monstername.ts`**

```ts
import { monsterName, type MonsterCategory } from './bestiary';

// Shared pool (applies to any creature) + category-flavored pools. The union
// gives >=15 adjectives per category for variety. Grow freely (BACKLOG #12).
const GENERAL = [
  'ancient', 'cursed', 'feral', 'vile', 'dread', 'savage',
  'wretched', 'grim', 'ravenous', 'baleful',
];

const BY_CATEGORY: Record<MonsterCategory, string[]> = {
  undead: ['rotting', 'spectral', 'grave-touched', 'undying', 'skeletal', 'ghoulish'],
  demon: ['hellish', 'infernal', 'sulfurous', 'damned', 'fiendish'],
  beast: ['rabid', 'snarling', 'wild', 'hulking', 'bristling'],
  vermin: ['swarming', 'venomous', 'diseased', 'skittering', 'plagued'],
  elemental: ['crackling', 'surging', 'volatile', 'primal', 'roiling'],
  dragon: ['elder', 'tyrant', 'apex', 'wingbound', 'scaled'],
  construct: ['runed', 'animated', 'tireless', 'forgebound', 'grinding'],
  giant: ['towering', 'colossal', 'brutish', 'mountainous', 'looming'],
  ooze: ['gelatinous', 'acidic', 'oozing', 'corrosive', 'viscous'],
  aberration: ['unblinking', 'maddening', 'warped', 'eldritch', 'otherworldly'],
  plant: ['thorned', 'overgrown', 'blighted', 'verdant', 'gnarled'],
  humanoid: ['rogue', 'outcast', 'marauding', 'renegade', 'bloodthirsty'],
};

// Deterministic 32-bit integer hash (no Math.random / Date.now).
function hash(n: number): number {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "<Adjective> <Creature>", stable for a given encounter id. */
export function monsterTitle(
  encounterId: number,
  index: number,
  category: MonsterCategory,
): string {
  const pool = GENERAL.concat(BY_CATEGORY[category] ?? []);
  const adj = pool[hash(encounterId) % pool.length];
  return `${cap(adj)} ${monsterName(index)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/monstername.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/monstername.ts tests/monstername.test.ts
git commit -m "feat(monstername): deterministic <adjective> <creature> titles"
```

---

## Task 6: Carry name/size/flying in the TV state

**Files:**
- Modify: `src/web/tvview.ts`
- Test: `tests/tvview-state.test.ts` (extend)

**Interfaces:**
- Consumes: `monsterByIndex`, `monsterName` (bestiary); `monsterTitle` (monstername).
- Produces: `TvEncounter` gains `name: string`, `size: 'S'|'M'|'L'`, `flying: boolean`.

- [ ] **Step 1: Extend the test** — `tests/tvview-state.test.ts`

Add a test asserting the built state's active encounter carries the new fields.
Use the file's existing harness (it already seeds a game with an active
encounter — mirror the existing "active encounter" test's setup). Add:

```ts
import { monsterByIndex } from '../src/domain/bestiary';

it('active encounter carries a monster name, size and flying flag', () => {
  // (reuse this file's helper that advances to an active encounter)
  const state = buildTvState(db, NOW); // NOW = the same clock the file already uses
  expect(state.encounter).not.toBeNull();
  const e = state.encounter!;
  expect(typeof e.name).toBe('string');
  expect(e.name.length).toBeGreaterThan(0);
  expect(['S', 'M', 'L']).toContain(e.size);
  expect(typeof e.flying).toBe('boolean');
  // consistent with the bestiary for the spawned creature
  const m = monsterByIndex(e.creatureIndex);
  if (m) { expect(e.size).toBe(m.size); expect(e.flying).toBe(m.flying); }
});
```

Match the existing file's import of `buildTvState`, its DB setup helper, and its
clock constant (read the top of `tests/tvview-state.test.ts` and reuse them
rather than inventing new setup).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tvview-state.test.ts`
Expected: FAIL — `e.name`/`e.size`/`e.flying` undefined (and a TS error on the missing interface fields).

- [ ] **Step 3: Update `src/web/tvview.ts`**

Add the imports near the other domain imports (after line 26):
```ts
import { monsterByIndex, monsterName } from '../domain/bestiary';
import { monsterTitle } from '../domain/monstername';
```

Extend the `TvEncounter` interface (lines 32-36) — add three fields:
```ts
export interface TvEncounter {
  id: number; creatureIndex: number; creatureUrl: string;
  footprint: number; kind: string; packCount: number;
  hp: number; maxHp: number;
  name: string; size: 'S' | 'M' | 'L'; flying: boolean;
}
```

Populate them where `encounter` is built (lines 62-66). Replace that object with:
```ts
      const meta = monsterByIndex(e.creature_index);
      encounter = {
        id: e.id, creatureIndex: e.creature_index, creatureUrl: creatureSpriteUrl(e.creature_index),
        footprint: e.footprint, kind: e.kind, packCount: e.pack_count,
        hp: e.current_hp, maxHp: e.max_hp,
        name: meta ? monsterTitle(e.id, e.creature_index, meta.category) : monsterName(e.creature_index),
        size: meta?.size ?? 'M',
        flying: meta?.flying ?? false,
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tvview-state.test.ts`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/tvview.ts tests/tvview-state.test.ts
git commit -m "feat(tvview): expose monster name, size and flying in the TV state"
```

---

## Task 7: Render the name + size/flying shadow on the TV

**Files:**
- Modify: `src/domain/tilesheet.ts` (add `MONSTER_SHADOWS` for source-of-truth parity)
- Modify: `src/web/public/tv/tv.js` (shadow, flying raise, name label)

No unit test (Canvas render) — verified visually at the end.

**Interfaces:**
- Consumes: `state.encounter.{name,size,flying,footprint}` (from Task 6).

- [ ] **Step 1: Add `MONSTER_SHADOWS` to `src/domain/tilesheet.ts`**

After the `WALL_SHADOW` export (line 50), add:
```ts
// Ground-shadow ellipses drawn UNDER a monster (row 37): col 37 = S, 38 = M,
// 39 = L (larger/rounder variants at cols 40-41, reserved). tv.js mirrors these
// coords as a local const (it can't import; see MSHADOW there).
export const MONSTER_SHADOWS: Record<'S' | 'M' | 'L', TileCoord> = {
  S: { col: 37, row: 37 },
  M: { col: 38, row: 37 },
  L: { col: 39, row: 37 },
};
```

- [ ] **Step 2: Add the shadow-coord const in `src/web/public/tv/tv.js`**

Near the top constants (beside `const SHADOW = { col: 30, row: 37 };`), add:
```js
const MSHADOW = { S: { col: 37, row: 37 }, M: { col: 38, row: 37 }, L: { col: 39, row: 37 } };
```

- [ ] **Step 3: Rewrite `drawMonster()` in `tv.js`** (lines 157-170) to draw a ground shadow and raise flying sprites

```js
function drawMonster() {
  const e = state.encounter; if (!e || !layout) return;
  const sheet = img('/sheet/world.png');
  const m = layout.monster;
  const fp = e.footprint;                       // 1 or 2
  const visScale = fp === 2 ? 2.2 : 1.4;        // bosses loom larger
  const size = tilePx * visScale;
  const { px, py } = tileToField(m.x + fp / 2, m.y + fp); // feet baseline (drawSprite anchors bottom)
  const shadow = (cx, feetY, w) => {
    const sh = MSHADOW[e.size] || MSHADOW.M;
    const shW = w * 0.8, shH = shW * 0.4;
    ctx.drawImage(sheet, sh.col * TILE, sh.row * TILE, TILE, TILE,
      Math.round(cx - shW / 2), Math.round(feetY - shH / 2), shW, shH);
  };
  const raise = e.flying ? Math.round(tilePx * 0.45) : 0;
  shadow(px, py, size);
  drawSprite(img(e.creatureUrl), px, py - raise, size, size);
  // pack: a couple of small duplicates beside it, each with its own small shadow
  if (e.kind === 'pack') {
    for (let i = 1; i <= Math.min(3, e.packCount - 1); i++) {
      const dx = px + i * tilePx * 0.6, dw = size * 0.7;
      shadow(dx, py, dw);
      drawSprite(img(e.creatureUrl), dx, py - raise, dw, dw);
    }
  }
}
```

- [ ] **Step 4: Draw the monster name above the HP bar** — extend `drawHpBar()` (append after the HP numerals `shadowText`, before the function's close, ~line 199)

```js
  // monster name in the reserved strip above the bar, a step larger than the HP text
  const nameSize = Math.max(14, Math.round(h * 1.15));
  shadowText(e.name, panelX + panelW / 2, y - Math.round(h * 0.55),
    `bold ${nameSize}px system-ui`, '#f2e4e4', 'center');
```

- [ ] **Step 5: Verify the render (no automated test)**

Syntax-check the browser file and run the full suite + typecheck:

Run: `node --check src/web/public/tv/tv.js && npx vitest run && npm run typecheck`
Expected: tv.js parses; suite green; typecheck clean.

Then a visual smoke check (controller does this — see the visual-verification note at the end of the plan): start the server against a scratch DB seeded with an active encounter, open `/tv`, and confirm: the monster sprite is the correct themed creature, a ground shadow sits under it (offset to a float for flying types), and the `"<Adjective> <Creature>"` name renders above the HP bar.

- [ ] **Step 6: Commit**

```bash
git add src/domain/tilesheet.ts src/web/public/tv/tv.js
git commit -m "feat(tv): monster name label + size/flying ground shadow"
```

---

## Self-Review (completed while writing)

- **Spec coverage:** bestiary (Task 1), theme map (Task 2), engine rewrite (Task 4), monster title (Task 5), TV state (Task 6), shadows + name render (Task 7). The catalog re-point (Task 3) is the extra step the spec implied by deleting `MONSTER_TIERS`/`BOSSES`. All spec §Testing items map to Task test steps.
- **Type consistency:** `pickEncounterCreature(theme, kind, rng)` used identically in creatures.ts and encounters.ts; `TvEncounter` fields `name/size/flying` produced in Task 6 and consumed in Task 7; `MonsterCategory`/`Monster`/helpers named identically across bestiary consumers; `themeMonsters`/`FALLBACK_THEME` consistent between dungeonthemes.ts and creatures.ts.
- **No placeholders:** the full MONSTERS array and THEME_MONSTERS map are inlined; every code step shows complete code.
- **Ordering guarantees green suites:** Task 3 removes the catalog's dependency on `MONSTER_TIERS`/`BOSSES` before Task 4 deletes them.

## Known spec-mandated oddities (surface to the human before/at execution)

Per the spec's edited roster, **Goblin Fighter (253)** and **Goblin Mystic (257)** are `size: 'S'` yet `boss: true`. A 2×2 boss rendered from a small goblin sprite may look underwhelming. This is faithfully transcribed from the approved spec; flag it to the user and only change if they confirm.

## Visual verification note (Task 7)

The `tv.js` render has no automated test. After Task 7, the controller should
seed a scratch DB (valid class keys; ingest tokens; tick the engine to spawn a
dungeon + encounter), serve it, and view `/tv` in Chrome (or a PIL/offscreen
composite if the extension is unavailable) to confirm the sprite, shadow
placement (grounded vs. floating), and name label read correctly across a few
themes.

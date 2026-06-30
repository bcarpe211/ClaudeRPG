# ClaudeRPG — Sprite Catalog Design Spec

**Date:** 2026-06-29
**Status:** Approved for planning
**Author:** Bryan Carpenter (with Claude)

## 1. Overview

The art-curation backlog item (#1) requires understanding what every sprite is
before we can fix which sprites the game uses. Two known problems motivate this:

- **Creature mapping is offset.** `MONSTER_TIERS`/`BOSSES` in
  `src/domain/creatures.ts` reference `creature_key.doc` indices, but the indices
  don't line up with the actual creatures (e.g. index 124 renders a dark elf, not
  the intended creature).
- **Tile manifest is approximate.** `src/domain/tilemanifest.ts` themes have
  look-alike stone floors, a flagstone "wood_fort" floor, a minimal cave door,
  and no cave wall variants.

This spec covers a **dev-only Sprite Catalog**: a gated `/catalog` route that
displays every sprite with its file index, its parsed name (where one exists),
and how it is currently used in the game. It is a curation worksheet, not a
gameplay feature.

This is doable **entirely on the Mac** — the renderer is Canvas 2D in a browser,
the server runs locally, and sprites are served from the local
`assets/oryx_16-bit_fantasy_1.1/Sliced` via the existing `/sprites` static mount.
The Pi/TV adds nothing to curation correctness (which sprite is which is
resolution-independent); final 4K visual tuning is a later, separate pass.

### Key fact about the art (discovered during design)

`creature_key.doc` lists **the 9 classes × M/F first** (Knight M, Thief M …
Paladin F = 18 entries), then a blank line, then the creatures (Bandit, …). The
sliced `creatures_24x24` sheet is numbered to match: **files 1–18 are the class
avatars, files 19+ are monsters.** The game already relies on this — `classes.ts`
maps Knight M→1 … Paladin M→9, Females = +9 (→10–18), via
`/sprites/creatures_24x24/...`. So the doc's non-blank lines align **1:1** to
`creatures_24x24` file indices. The known `MONSTER_TIERS` offset is a
miscounting against this sequence; the catalog makes the true alignment visible.

`classes_26x28` is a **separate, dedicated class spritesheet that the game does
not currently use** — it's candidate art for backlog #2 (gender/class variants),
so the catalog shows it for evaluation.

### Goals

- See every creature/class-avatar (`creatures_24x24`, 396), world tile
  (`world_24x24`, 1784), and dedicated class sprite (`classes_26x28`, 49) with
  its **file index**, **parsed name** (where a key exists), and **current
  in-game assignment**.
- Make the creature name↔sprite alignment **visible** so the offset can be
  corrected by eye.
- Off by default; never visible on the kiosk unless explicitly enabled.

### Non-goals

- **Changing any game data.** Fixing `MONSTER_TIERS`/`BOSSES` and the tile
  manifest is **phase 2**, driven by this catalog, with its own spec.
- Items/fx sprites (not tied to a current bug).
- Any runtime/gameplay behavior. The catalog is read-only and dev-only.

### Downstream consumer (forward reference)

Backlog #12 (on-screen monster label with a random dungeon-themed adjective,
e.g. "flaming beetle") will consume the **curated creature display names** this
work produces. Requirement that flows back here: parsed creature names must be
clean, singular **display labels** (no file cruft) so `<adjective> <creature>`
reads well. The adjective dictionary and rendering are out of scope here — they
live in #12's own spec.

## 2. Architecture

Four small, single-purpose units:

### 2.1 `src/web/catalog/spritenames.ts` — the name key (committed data)

The names from `creature_key.doc`, extracted **once** (via macOS `textutil`) and
committed as a typed ordered array:

- `CREATURE_SHEET_NAMES: string[]` — every non-blank doc line in order. By the
  key fact above, `CREATURE_SHEET_NAMES[i]` corresponds to `creatures_24x24` file
  index `i + 1` (so `[0..17]` are the class avatars, `[18..]` are monsters).

Committing the parsed array means **no runtime `.doc`/`textutil` dependency**
(portable to the Linux Pi) and the names are version-controlled even though
`assets/` is gitignored. A short comment records how it was extracted so the step
is reproducible. Names are stored as authored (ordered list), **not** pre-bound
to game indices — alignment is computed/displayed by the catalog so mismatches
are visible rather than baked in.

`world_24x24` has **no name key** (the doc covers only the creature sheet);
`classes_26x28` likewise has no authoritative key. Those sections show index +
annotation only (name `null`).

### 2.2 `src/web/catalog/build.ts` — pure view-model builder

```
buildCatalog(input) -> CatalogView
```

Pure function (no I/O): given the three directory file lists, the name array, and
the current assignments (`MONSTER_TIERS`, `BOSSES`, the class map from
`classes.ts`, and the tilemanifest themes), it returns a structured view-model.
Pure ⇒ unit-testable with small fake inputs.

### 2.3 `src/web/routes/catalog.ts` — the gated route

`GET /catalog`, **mounted only if `config.enableCatalog`**. It reads the three
sprite directories (`creatures_24x24`, `world_24x24`, `classes_26x28`) under
`config.spritesDir`, calls `buildCatalog`, and renders the page. Images load from
the existing `/sprites/<category>/<file>` mount.

### 2.4 `config.enableCatalog`

New config field read from env `ENABLE_CATALOG` (default `false`). When false the
route is not mounted at all (so it 404s, exactly as if it didn't exist).

## 3. Data model

```ts
interface SpriteCell {
  index: number;        // file index parsed from the filename
  file: string;         // filename, served at /sprites/<category>/<file>
  name: string | null;  // aligned parsed name, or null where no key exists
  annotation: string[]; // e.g. ["class: Knight M"], ["tier 3"], ["boss"],
                        // ["unused"], ["stone_crypt.wall"], ["cave.floor"]
}

interface CatalogView {
  creatures: SpriteCell[];  // creatures_24x24, index order
  worldTiles: SpriteCell[]; // world_24x24, index order
  classSheet: SpriteCell[]; // classes_26x28, index order
  counts: { creatures: number; worldTiles: number; classSheet: number };
}
```

Annotation derivation:
- **`creatures_24x24`:** if the file index is a class avatar (matches
  `spriteIndexFor(key, gender)` for some class/gender), annotate
  `"class: <Name> <M/F>"`. Otherwise list every `MONSTER_TIERS` tier it appears
  in (`"tier N"`), `"boss"` if in `BOSSES`, else `"unused"`.
- **`world_24x24`:** for each theme in the tilemanifest, if the tile's filename
  is that theme's wall/wallVariant/floor/floorVariant/door/decor, annotate
  `"<theme>.<role>"`; else `"unused"`.
- **`classes_26x28`:** `"unused — candidate class art (#2)"` (no current wiring).

## 4. Name ↔ sprite alignment (the core curation aid)

`CREATURE_SHEET_NAMES[i]` → `creatures_24x24` file index `i + 1` (filenames are
1-based: `..._01.png`). The page shows each sprite next to its file index and
aligned name, so a wrong alignment is obvious. If the sheet has gaps (blank cells
the doc skips) or a constant offset, we see it immediately and adjust the
alignment (e.g. an offset/gap correction); establishing the correct alignment is
the deliverable phase 2 builds on. The first 18 entries double as a check on the
existing class wiring in `classes.ts`.

## 5. The page

Server-rendered (EJS, matching existing views). Three labeled sections —
**Creatures (`creatures_24x24`)**, **World tiles (`world_24x24`)**, **Class sheet
(`classes_26x28`)** — each a responsive grid of scaled-up sprites with
`image-rendering: pixelated`. Each cell shows the image, file index, parsed name
(if any), and color-coded annotation badge(s) (e.g. blue class, green tier,
purple boss, grey unused). A simple client-side filter box per section (text
match on name/index + a "show only unused" toggle) keeps the 1784 world tiles
navigable. No external assets — inline CSS/JS, consistent with the kiosk's
offline, no-bundler constraint.

## 6. Safety

- Off by default (`ENABLE_CATALOG` unset/false) ⇒ route absent ⇒ never on the
  kiosk. Locally: `ENABLE_CATALOG=1 npm start`, open `localhost:8095/catalog`.
- Read-only: lists files and current in-memory assignments; touches no DB or
  game state.

## 7. Testing

- **`buildCatalog` unit tests:** small fake file lists + names + assignments →
  assert correct annotations (a class avatar at index ≤18, a monster in two
  tiers, a boss, an unused tile, a themed wall, and name alignment incl. an
  off-by-one/gap case).
- **Route gating test:** `/catalog` is 404/absent when `enableCatalog` is false,
  and 200 with the expected sections when true.
- Existing `tilemanifest.test.ts` (file-existence guard) remains the safety net
  for theme tile references.

## 8. Out of scope / later

- **Phase 2 — fix the mappings** (`MONSTER_TIERS`, `BOSSES`, tilemanifest),
  driven by this catalog. Separate spec.
- **#2 — class/gender variants**, possibly sourced from `classes_26x28`.
- **#12 — monster name flare** (adjective dictionary + on-screen label).
  Separate spec; consumes the curated names.
- Final 4K visual tuning on the real TV (Pi).

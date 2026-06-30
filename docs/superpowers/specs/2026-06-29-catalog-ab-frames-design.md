# ClaudeRPG — Catalog A/B-Frame Enhancement Design Spec

**Date:** 2026-06-29
**Status:** Approved for planning
**Author:** Bryan Carpenter (with Claude)

## 1. Overview

The Sprite Catalog (`/catalog`, shipped in the prior spec) revealed that
`creatures_24x24` is a **22×18 = 396 sheet of animation A/B pairs**: odd rows
(files 1–18, 37–54, 73–90, …) are the real creatures (frame A); each even row is
the same creature's animation frame at **frame-A index + 18**. Verified visually:
#1↔#19 (knight), #37↔#55 (bandit), #217↔#235 (gem). The catalog's first naive
name mapping (`names[index-1]` down all 396 files) therefore mislabels every
B-frame row and shifts everything — the long-standing offset bug.

This spec enhances the catalog's **creatures section** to be A/B-aware: it
collapses each animation pair into one cell that **flips between frame A and B
once per second**, shows the corrected name for both frames, and exposes the pair
explicitly. The 1-second flip makes a wrong pairing jump out visually; showing
both names lets the user point at exactly what to fix.

The flip mechanism is built as a **portable, dependency-free library** (`anim.js`)
so the main TV dungeon view can reuse it later (backlog #13, sprite animation).

### Goals

- Creatures section shows ~198 cells (one per frame-A file), each animating
  A↔B every ~1s, with `#A ↔ #B` and **both** frame names.
- Names corrected via the verified "Model B" mapping (below), replacing the naive
  `names[index-1]`.
- A reusable browser animation module usable by the catalog now and the dungeon
  view later, with a renderer-agnostic core.

### Non-goals

- **No `MONSTER_TIERS`/`BOSSES` change.** Fixing the gameplay creature ladder is a
  separate follow-up once names are visually confirmed here.
- **No dungeon-view integration.** That's backlog #13; this spec only ensures the
  library is portable enough for it.
- World-tiles and class-sheet sections are unchanged (not animation-paired).

## 2. Name mapping correction ("Model B")

`creature_key.doc` has 198 non-blank names. The sheet omits the 18 class B-frames
(files 19–36) from the doc but lists NPC animation frames as near-duplicate
entries, so the doc-name order maps to files with a single +18 shift after the
classes. A pure helper:

```ts
// fileIndex is 1-based (oryx files are ..._01.png).
nameForCreatureFile(fileIndex: number, names: string[]): string | null
//  1..18    -> names[fileIndex - 1]      (the 18 class A-frames)
//  37..216  -> names[fileIndex - 19]     (doc names, shifted past the 18 class B-frames)
//  else     -> null                      (19..36 class B-frames; 217.. unnamed)
```

Verified: file 1 → "Knight M"; file 37 → "Bandit"; file 55 → "Bandit"; file 19 →
null. This mapping is a hypothesis the animated catalog lets us confirm by eye; if
a region drifts (e.g. around the doc's two 36-entry thematic sections), the wrong
flip/name pair makes it visible and we refine the rule.

## 3. Pair model and `buildCatalog` change

The creatures output becomes pairs instead of a flat list. New type and the
`CatalogView.creatures` field replaced by `creaturePairs`:

```ts
interface CreaturePair {
  aIndex: number;        // frame-A file index (odd row)
  aFile: string;         // frame-A filename
  aName: string | null;  // nameForCreatureFile(aIndex)
  bIndex: number;        // aIndex + 18
  bFile: string;         // frame-B filename
  bName: string | null;  // nameForCreatureFile(bIndex)
  annotation: string[];  // from the A-frame: class:/tier N/boss/unused
}

interface CatalogView {
  creaturePairs: CreaturePair[]; // one per frame-A file, index order
  worldTiles: SpriteCell[];      // unchanged
  classSheet: SpriteCell[];      // unchanged
  counts: { creaturePairs: number; worldTiles: number; classSheet: number };
}
```

Construction: from the creature file list, take the **frame-A files** (`isFrameA`,
i.e. `Math.floor((index-1)/18)` is even), sort by index, and for each build a
`CreaturePair` with `bIndex = aIndex + 18` (look up `bFile` from the file list;
if absent, still render A). Annotation is computed from `aIndex` exactly as today
(class avatar / tier / boss / unused). `buildCatalog` stays pure (fake inputs in
tests). `SpriteCell`, world-tile and class-sheet logic are unchanged.

## 4. Portable animation library — `src/web/public/anim.js`

A dependency-free ESM module served at `/static/anim.js`. Two layers:

**Renderer-agnostic core (pure, unit-tested):**
- `framePartner(fileIndex)` → the paired file index: `+18` for a frame-A file,
  `-18` for a frame-B file (by row parity).
- `isFrameA(fileIndex)` → boolean (`Math.floor((fileIndex-1)/18)` even).
- `frameAt(nowMs, periodMs)` → `0 | 1`, which frame to show on a shared clock
  (`Math.floor(nowMs / periodMs) % 2`).

**Browser DOM flip (used by the catalog):**
- A single shared timer (~1000ms) drives all registered sprites in sync, so the
  whole grid flips together (one `setInterval`, not one per cell).
- Each animated sprite is two stacked `<img>` (frame A and frame B); the tick
  toggles a CSS class to show one or the other — no `src` swap, no re-fetch
  flicker.
- An init function (e.g. `SpriteAnim.start({ periodMs })`) scans the DOM for the
  sprite markup and begins the shared loop.

The core math carries the +18 rule the dungeon view (#13) needs from Canvas 2D;
the DOM flip is the part the catalog uses now. The module must not import
anything catalog-specific. It is loaded with `<script type="module">` (Chromium
kiosk supports ESM; no bundler), and is importable by vitest for the core tests.

## 5. Catalog UI

The creatures section renders one cell per `CreaturePair`:
- Two stacked `<img>` (`/sprites/creatures_24x24/<aFile>` and `<bFile>`),
  animated A↔B via `anim.js` (~1s), `image-rendering: pixelated`.
- `#<aIndex> ↔ #<bIndex>`.
- Both names: `aName` / `bName`, rendering `—` when null.
- The A-frame annotation badges (reuse the existing badge styles/escaping).

World-tiles and class-sheet sections render exactly as before (static `SpriteCell`
grids, existing filter/“only unused” behavior). The page includes
`<script type="module" src="/static/anim.js">` plus a small inline initializer
calling `SpriteAnim.start`. All CSS/JS stays inline or same-origin static (offline
kiosk constraint). Badge HTML stays escaped via the existing `esc()` helper.

## 6. Testing

- **`nameForCreatureFile`** unit tests: file 1 → "Knight M", 18 → "Paladin F",
  37 → "Bandit", 55 → "Bandit", 19 → null, 36 → null, 217 → null, and a file just
  past 216.
- **`buildCatalog`** unit tests: `creaturePairs` has one entry per frame-A file,
  `bIndex === aIndex + 18`, both names populated from the mapping, annotation taken
  from the A-frame (class avatar at index ≤18, a tier/boss case, an unused case).
  World-tile / class-sheet assertions carry over.
- **`anim.js` core** unit tests (vitest import): `framePartner` (+18 for an A
  file, −18 for a B file), `isFrameA`, `frameAt` toggling 0/1 across a period
  boundary.
- **Route gating test** stays (404 when `ENABLE_CATALOG` off; 200 + sections when
  on); update the on assertion to the new creatures markup if needed.

## 7. Out of scope / later

- **`MONSTER_TIERS`/`BOSSES` fix** to real frame-A creature indices (after names
  are confirmed here).
- **#13 dungeon-view animation** — consumes `anim.js`'s core for Canvas 2D sprite
  flipping.
- Animating world-tile sprites (torches, etc.).

# Modular Flooring System — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorming), pending spec review
**Track:** `dungeon2` autotiled generator, gated `/dungeon-preview` route (preview-only; live `/tv` untouched)
**Source data:** `docs/oryx_flooring_package/` (README + `data/*.json` + shared sprite sheet)

---

## 1. Problem & goal

Today floors are **welded to the wall theme**. Each `Skin` in `src/domain/tilesheet.ts`
bundles a `wallRow` with its own `floorSets`, and we hand-author a floor palette per
skin. We have only 4 skins (`castle`/`dungeon`/`ruined-castle`/`forge` = wall rows 1–4),
so most of the sheet's floor variety is unused and adding a dungeon means rewiring floors.

**Goal:** decouple the floor palette from the wall theme. Define floors as a **global,
reusable registry** and connect them to dungeon themes through a **compatibility map**, so
the generator composes a floor by: *pick a dungeon type → weighted-pick a compatible floor
group → flood with that group's mains, sprinkle its accents.*

This is exactly the model in the `oryx_flooring_package` README. This project adopts that
package's authored data as the source of truth.

## 2. What the package gives us (verified)

- **23 dungeon styles** = the 23 horizontal wall/floor bands of the sheet's top-left block
  (`dungeon_id` == sheet row). Each band's wall color defines its theme.
- **38 floor groups** (`handle` → `mains[]` + `accents[]`), classed grey/warm/cool/green/gold.
- **Compatibility map**: per group, the dungeons it fits, tiered `home` (source) / `great`
  (same family) / `good` (neutral bridge) / `feature` (rare accent fit). Weights
  `{home:6, great:5, good:2, feature:1}`. A dungeon absent from all tiers = intentional clash.
- The **color-class eligibility logic is already baked into these tier lists** — we read the
  tiers, we do not re-derive grey/warm/cool routing.

**Coordinates:** every tile ref carries a `rect = [x, y, 24, 24]`; sheet col/row =
`rect[0]/24`, `rect[1]/24`. This maps 1:1 onto our existing `TileCoord`. Confirmed:
`greystone_flag` main = sheet col 4 row 1 = today's `CASTLE_FLOORS[0].main`.

**Sheet identity:** the package sprite and our served `/sheet/world.png`
(`assets/oryx_16-bit_fantasy_1.1/oryx_16bit_fantasy_world_trans.png`) are the **same file**
(identical MD5, 1366×1007), so shared coordinates are trustworthy.

**Wall gate (checked):** our renderer draws the pseudo-3D wall autotile set at sheet cols
~8–29, which the package never examined (it stops at the flat wall faces, col 0–2). Eyeballing
the top-left block confirms **every band carries the full pseudo-3D wall set in its own
color** — so any band can be a wall theme by pointing `wallRow` at it, not just rows 1–4.

## 3. Scope decisions (locked)

- **Roster: all 22 usable bands.** Include every dungeon style **except #17 Homestead
  Pickets** (a fence-prop row, not a tiling dungeon — the README excludes it; the sheet shows
  sparse props over black gaps). The old 4 skin labels are retired for the package names;
  rows 1–4 become **Greystone Keep / Crimson Court / Mossmarch Hold / Emberforge** (rows 2–3
  are re-characterized from `ruined-castle`/`dungeon`).
- **Integration: preview-only.** Build in `dungeon2.ts` + the gated `/dungeon-preview` route.
  Live `/tv` stays on `dungeon.ts` + `tilemanifest.ts`; swapping it is a separate future project.
- **Edge case — Wintermarch Keep (#18):** has no home group, covered entirely by
  cross-compatible neutral/earthy groups. It is a valid selectable dungeon; routing must find
  it eligible groups.

## 4. Architecture

Three units, each independently testable.

### 4a. `src/domain/floordata/` — authored data (copied from the package)
The three JSON files (`dungeons.json`, `floor_groups.json`, `floor_compatibility.json`)
copied verbatim into the source tree. These ship with the source (we run TS directly via
`tsx`; there is no build/dist step). **Authored data stays the source of truth — no
hand-transcription.**

### 4b. `src/domain/floorgroups.ts` — typed adapter + routing + fill
Loads the JSON at module init with `readFileSync` + `JSON.parse` (sync, deterministic, no
Node-version import-attribute risk; paths resolved via `import.meta.url`). Validates shape at
load. Exposes:

- Types: `FloorTile { col, row, hint, isGlow }`, `FloorGroup { handle, mains[], accents[] }`,
  `Dungeon { name, dungeonId, wallRow, wallVariantChance, decor[] }`.
- `FLOOR_GROUPS: FloorGroup[]` (38), `DUNGEONS: Dungeon[]` (22, #17 excluded),
  `COMPAT: Record<handle, {home, great[], good[], feature[]}>`.
- `getDungeon(name)`, `pickDungeon(rng)` — random dungeon for the preview.
- **`chooseGroup(dungeonName, rng): FloorGroup`** — collect eligible `(group, tier)` where the
  dungeon appears in `home|great|good|feature`; weighted-pick by `{home:6,great:5,good:2,
  feature:1}` (reuse `pickWeighted`). Guaranteed non-empty for all 22 dungeons.
- **`pickCell(group, rng): FloorTile`** — the fill rule, per cell:
  - split `accents` into **glow** (`hint` contains `"GLOW"`) and **normal**.
  - roll once: `< GLOW_RATE (~0.01)` and glow exists → a glow tile; else
    `< ACCENT_RATE (~0.06)` and normal exists → a normal accent; else → a **random main**
    (mains blend per cell — `wildroot_gravel`'s 3 gravels vary naturally).
  - deterministic, bounded rng calls per cell.
  - `mainTile(group)` helper returns a representative main (`mains[0]`) for door underlays.

`isGlow` is precomputed from `hint` at load. `theme_hex`/`floor_class`/`is_cross_ref`/`note`
are informational and need not be surfaced.

### 4c. `src/domain/tilesheet.ts` — trimmed to wall/door/sheet primitives
Keep `SHEET`, `WALL_COLS`, `DOORS`, `pickWeighted`, `FLOOR_EDGES`, `tileRect`. **Remove**
`Skin`, `FloorSet`, `SKINS`, `CASTLE_FLOORS`, `getSkin` (superseded by the registry). The
dungeon registry now lives in `floorgroups.ts` (derived from the package).

### 4d. `src/domain/dungeon2.ts` — generator
`generateAutotiledDungeon(dungeonName, seed, opts)`:
- `getDungeon(dungeonName)`; `makeRng(scrambleSeed(seed))` (unchanged determinism).
- `const group = chooseGroup(dungeonName, rng)` — one group per dungeon (cohesive).
- Walls: `pickWall` unchanged, now reads `dungeon.wallRow` / `dungeon.wallVariantChance`.
- Floors: `pickCell(group, rng)` per floor cell (replaces `pickFloor`).
- Doors: weighted `DOORS` (unchanged); underlay = `mainTile(group)`.
- Return `AutoDungeon` with `dungeon: dungeonName` (rename `skin` field → `dungeon`).

### 4e. `/dungeon-preview` route
Accept an optional `?dungeon=<name>` (any of the 22); default to `pickDungeon`. Stays gated by
`ENABLE_DUNGEON_PREVIEW`. Renderer unchanged (it already blits `{col,row}` + `under`).

## 5. Data flow

```
dungeon name ──▶ chooseGroup(name, rng) ──▶ FloorGroup
                      │  (COMPAT tiers, weighted)
per floor cell ──▶ pickCell(group, rng) ──▶ FloorTile {col,row}
wall cell     ──▶ pickWall(..., dungeon.wallRow) ──▶ TileCoord
door cell     ──▶ pickWeighted(DOORS) + underlay mainTile(group)
```

## 6. Determinism & knobs

- All randomness flows through the injected seeded `rng` (existing pattern). Same
  `(dungeonName, seed)` → identical dungeon. No `Date.now()`/`Math.random()` in core.
- Tunable constants in `floorgroups.ts`: `ACCENT_RATE ≈ 0.06`, `GLOW_RATE ≈ 0.01`, tier
  weights (default from the package's `tiers_weight_suggestion`).

## 7. Testing

- **floordata shape:** 38 groups, 22 dungeons (17 absent); every floor `rect` maps to sheet
  cols 4–7, rows 1–23; every group has ≥1 main.
- **routing:** every one of the 22 dungeons yields ≥1 eligible group (esp. Wintermarch Keep);
  a group's `home` dungeon is always eligible; `chooseGroup` is deterministic for a fixed seed.
- **fill:** `pickCell` returns a main the large majority of the time; a glow tile never
  dominates (statistical bound over N cells); multiple mains actually vary.
- **generator:** deterministic for `(name, seed)`; door cells carry a main underlay; wall
  cells use the dungeon's `wallRow`.
- **route:** `/dungeon-preview` 200s for a known dungeon and for the default; 404/flag-off when
  `ENABLE_DUNGEON_PREVIEW` is unset (existing guard).

## 8. Out of scope

Live `/tv` integration; any new wall decoding (the pseudo-3D set is already shared — we only
point `wallRow`); rooms/interior walls; decor/prop expansion; theming doors per dungeon;
bestiary/encounter work. All deferred.

## 9. Risks

- **Odd-band wall render.** The wall set is confirmed present for all bands on the sheet, but a
  few bands may look off in-engine. Mitigation: eyeball a handful (e.g. rows 10, 15, 20) in
  `/dungeon-preview` during build; if any band's walls read poorly, drop it from `DUNGEONS`
  (data-only change) — floors are unaffected.
- **JSON drift.** If the package data changes, re-copy the three files; the adapter's
  load-time validation catches shape breaks.

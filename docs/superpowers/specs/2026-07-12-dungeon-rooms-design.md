# Multi-Room Dungeons — Design

**Date:** 2026-07-12
**Status:** Draft for review
**Backlog:** new (deferred during the decor work)

## Goal

Partition the single 20×15 dungeon into 2–4 connected rooms (BSP) for dungeon
flavor, while keeping the co-op battle cohesive: the **largest room is the
"arena"** where the monster and all heroes appear; the other rooms are decorated
flavor. Interior walls autotile (including T/cross junctions) and connect via
doorways.

## Design decisions (confirmed in brainstorming)

1. **Arena + flavor rooms** — monster + all heroes in the largest room; other
   rooms are visual flavor. The fight stays legible.
2. **2–4 BSP chambers** — a few rectangular rooms with interior walls + doorways,
   readable on one non-scrolling screen (not a maze).
3. **One build, junction-decode first** — Task 1 decodes the junction tiles +
   extends the autotiler (the pixel-uncertain part), verified visually, before
   room generation builds on it.

Deterministic throughout (seeded `rng`; no `Date.now`/`Math.random`).

## Background / feasibility

- `dungeon2.pickWall` is already a **neighbor-based autotiler** (reads N/E/S/W wall
  neighbors → picks the tile). It covers straight runs, 4 corners, 4 ends, and
  isolated — but **not** 3-neighbor (T) or 4-neighbor (cross) junctions, which
  interior walls need where they meet the border or each other.
- The 2.5D wall tiles are **self-contained** (each tile includes its own front
  face), so interior walls are just autotiled wall cells — no extra rows.
- The **wall-shadow** layer (tvlayout) is already neighbour-based (a floor cell
  with a wall/door to its north gets a shadow), so it covers interior walls for
  free.
- The **monster zone** is currently a fixed centre computed in `tvlayout`
  (`{x: floor(w/2)-1, y: floor(h/2)-1, footprint: 2}`); decor and the rug also key
  off this centre. With rooms, the centre may be a wall — so the monster zone must
  become **arena-driven** and flow from `dungeon2`.

## Architecture

| File | Change |
|------|--------|
| `src/domain/tilesheet.ts` | Add T-junction (×4) + cross columns to `WALL_COLS` (decoded in Task 1). |
| `src/domain/dungeon2.ts` | Extend `pickWall` for 3/4-neighbour junctions; BSP room partition + doorways; pick the arena; expose `monster` + `arena` on `AutoDungeon`; place decor per-room + rug in the arena. |
| `src/web/tvlayout.ts` | Use `auto.monster` (drop the fixed centre); build hero slots from the **arena** floor. |
| tests | New `dungeon2` room/junction/arena tests; update the single-room assumptions in `dungeon2.test.ts` / `tvlayout.test.ts`. |

## Component 1 — Junction autotiling

### `WALL_COLS` (tilesheet.ts)
Add the five junction pieces (columns **decoded + verified in Task 1** — the 2.5D
faces can't be read reliably from a static crop; cols 21–25 are the reserved
slots). Named by the **missing** side (the open direction), plus the cross:
```ts
  // T-junctions (3 wall neighbours; named by the OPEN side) + 4-way cross.
  tOpenN: 21, tOpenE: 22, tOpenS: 23, tOpenW: 24, cross: 25, // <- cols confirmed in Task 1
```
(`tOpenN` = walls on E+S+W, open to the north, i.e. "⊤"; `tOpenS` = "⊥"; `tOpenE`
= "⊢"; `tOpenW` = "⊣".)

### `pickWall` extension (dungeon2.ts)
The neighbour logic is certain even before the columns are confirmed. Extend the
existing N/E/S/W computation:
```ts
  const n = [N, E, S, Wt].filter(Boolean).length;
  if (n === 4) return C(WALL_COLS.cross);
  if (n === 3) {
    if (!N) return C(WALL_COLS.tOpenN);
    if (!E) return C(WALL_COLS.tOpenE);
    if (!S) return C(WALL_COLS.tOpenS);
    return C(WALL_COLS.tOpenW); // !Wt
  }
```
Insert **before** the existing 2-neighbour (corner/straight) cases; the rest is
unchanged. Cracked variants don't apply to junctions.

**Task 1 verification:** render a synthetic wall arrangement (a `+` and each `T`)
and confirm each junction col produces the correct piece; fix the `WALL_COLS`
column numbers from what renders.

## Component 2 — BSP room partition (dungeon2.ts)

After the border walls + doors are placed (as today) and **before** cell
resolution, partition the interior into rooms:

- **Interior rect** = `(1,1)`..`(w-2,h-2)`.
- **BSP split** (recursive, seeded): given a rect, if it's large enough and the
  target room count isn't reached, pick a split axis (prefer splitting the longer
  side), choose a split line at a random interior position keeping both halves ≥
  `MIN_ROOM` (e.g. 5×5), mark that line as **interior wall** cells, and recurse
  into both halves. Stop at `2 + floor(rng()*3)` rooms (2–4) or when no rect can
  split.
- **Doorway**: on each split wall, carve a 1-cell **opening** (set back to floor)
  at a random position along the wall, so the two halves connect. BSP's tree
  structure guarantees every room is reachable.
- Result: a list of **room rects** (BSP leaves) and interior wall cells written
  into the `kinds` grid (`'wall'`, with the opening left `'floor'`). `pickWall`
  autotiles them (junctions where an interior wall meets the border/another wall).

`MIN_ROOM` and the target count are chosen so the **arena** (largest leaf) is ≥
~6×6 — big enough for the 2×2 monster + surrounding heroes.

Border doors (existing) stay; interior connections are floor openings (cleaner
than door tiles for interior walls). Ensure a border door isn't placed onto an
interior-wall cell (skip such candidates).

## Component 3 — Arena → layout-driven monster zone

- **Arena** = the room rect with the largest area.
- **Monster zone** = the arena's centre 2×2: `mx = arena.x + floor(arena.w/2) - 1`,
  `my = arena.y + floor(arena.h/2) - 1`.
- `AutoDungeon` gains:
  ```ts
  monster: { x: number; y: number; footprint: number };   // arena centre, 2x2
  arena: { x: number; y: number; w: number; h: number };   // largest room rect
  ```
  Decor/rug placement inside `dungeon2` use this monster zone (not a hardcoded
  centre).

### `tvlayout.ts`
- `monster` = `auto.monster` (remove the `Math.floor(w/2)-1` fixed centre).
- **Hero slots** come from the **arena** floor: candidates = arena interior floor
  cells minus the monster zone minus non-walkable decor (existing `blocked`
  set), shuffled with the existing seeded rng. This keeps the monster + all
  heroes together. (If `#players` exceeds arena capacity, overflow is dropped as
  today — `MAX_HERO_SLOTS` already caps at 24; a room ≥6×6 seats plenty.)

## Component 4 — Decor & rug with rooms

- **Rug**: centre on the arena's monster zone (already keyed to `mx/my`, now the
  arena centre) — unchanged logic, arena-relative.
- **Cobwebs (corners)**: place at **each room's** interior corners (per BSP leaf),
  not just the outer four — richer and matches the mockup. `COBWEB_HEAVY`
  probability per corner as today.
- **Wall torches**: any non-corner wall cell (border **or** interior), as today
  (the wall-cell scan already covers interior walls once they exist).
- **Floor scatter**: across all room floor cells, minus the monster zone and
  `used`, as today.

## Testing

**`tests/dungeon2.test.ts`** (update + add)
- Junction: a synthetic arrangement (e.g. a plus of interior walls) resolves the
  centre to `WALL_COLS.cross` and the arms to the correct `tOpen*` — asserted
  against the neighbour logic (col numbers per the Task-1 decode).
- Rooms: a 20×15 dungeon has ≥2 rooms — detected as interior wall cells present
  and ≥2 disjoint floor regions; every room is reachable (flood-fill from any
  floor cell reaches all floor cells, i.e. openings connect them).
- Arena/monster: `auto.monster` sits inside `auto.arena`; the arena is the largest
  room; the monster zone is all floor.
- Existing single-room assumptions (e.g. "interior cell (4,4) is floor") are
  updated to tolerate interior walls.
- Deterministic per `(name, seed)` (rooms + decor + monster).

**`tests/tvlayout.test.ts`** (update)
- `L.monster` equals `auto.monster` (arena centre), not the geometric centre.
- Hero slots all lie within the arena rect and clear of the monster zone +
  non-walkable decor.

Full suite + `tsc --noEmit` stay green. Final check is a **controller visual
pass**: render several themes and confirm rooms read clearly, interior walls
autotile (corners/T/cross clean, no gaps), doorways connect, the monster + heroes
share the arena, and decor/rug/shadows look right.

## Risks / notes

- **Junction col decode** is the main uncertainty — isolated as Task 1 with a
  synthetic-render verification; the autotiler *logic* is certain regardless.
- **Small arenas**: `MIN_ROOM`/room-count tuned so the arena is ≥~6×6; a `fits`
  guard keeps the monster zone + rug inside it.
- **Determinism shift**: adding BSP + junction rng draws repositions decor for old
  seeds; property-based tests hold.
- **Scope guard**: this build delivers arena+flavor rooms with 2–4 BSP chambers.
  Corridors, per-room themed decor sets, and interior *door tiles* (vs openings)
  are explicit follow-ons, not in this build.
- **Battle legibility** was the key call: heroes are pinned to the arena so the
  co-op fight stays clear; distributing heroes across rooms was rejected.

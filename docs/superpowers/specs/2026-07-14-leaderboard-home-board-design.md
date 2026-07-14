# Woven Leaderboard Rotation + Slower Hit Animations — Design (2026-07-14)

Post-launch polish on the rotating leaderboards (#8) and the monster retaliation
(#5), from live play feedback:

1. Weave a recurring **"home" board** between the variety boards (A,B,A,C,A,D…),
   where the home board is the current-fight standings — with the old multi-stat
   overall board as its between-fights fallback.
2. **Slow the monster-attack hit animations ~1.5×** — they read too fast.

Both are **`tv.js`-only** changes. No server/domain/DB changes: board A is built
client-side from the live `state.players` payload (which already carries each
player's `damage` to the current monster, plus `level`, `effectiveTokens`,
`gold`, `modifier`, `disabled`), and the variety boards come from the existing
`leaderboards` payload.

## Part 1 — Home board (A) + woven rotation

### Board A — two modes, chosen by `state.encounter`

- **Combat mode** (`state.encounter` is non-null): title **"THIS FIGHT"**.
  Enabled players sorted by `damage` (to the current monster) desc, name asc
  tiebreak. Stat line: `fmt(damage)  ×{modifier}` (e.g. `4.2M  ×11.0`). Live —
  it updates every `state` tick as damage climbs.
- **Idle mode** (`state.encounter` is null — victory popup or "dungeon rests"):
  title **"STANDINGS"**. Enabled players sorted by `effectiveTokens` desc, name
  asc. Stat line is the old multi-stat row:
  `L{level}  {fmt(effectiveTokens)} tok  {fmt(gold)}g  ×{modifier}`.

Disabled players are excluded (consistent with the variety boards). Both modes
render with the same row layout as the variety boards (numeric rank + avatar +
name + stat line), so only the title and the stat-line text differ.

### Woven sequence

Variety pool (the existing 6, unchanged order):
`overall_tokens, total_damage, gold, on_fire, days_champion, most_battered`.

Sequence interleaves A before each variety board (12 slots), `LB_ROTATE_MS`
(30s) per slot:

```
A, overall_tokens, A, total_damage, A, gold, A, on_fire, A, days_champion, A, most_battered  → repeat
```

Slot = `floor(t / LB_ROTATE_MS) % 12`. Even slot → home board A; odd slot `2k+1`
→ variety `V[k]`. A shows ~half the time; the crossfade dip (`LB_FADE_MS`) at
each switch is unchanged.

### Position dots

Dots represent the **6 variety boards** (not all 12 slots). The active dot =
`floor(slot / 2) % 6`, so the variety board `V[k]` and the home slot that
precedes it (previewing it) share the highlight.

### Rendering refactor

`drawLeaderboard(t)` computes `{ title, rows }` where `rows` is
`[{ avatarUrl, name, stat }]`, then runs a single render loop (rank, avatar,
name, stat line) + the dots. Three producers feed it:
- home-combat (from `state`), home-idle (from `state`), variety (from
  `leaderboards`, via the existing `fmtBoardValue`).
Null-safety: before the first `state`/`leaderboards` payload arrives, an empty
`rows` + a fallback title renders without error.

## Part 2 — Slower hit animations (~1.5×)

The monster-attack retaliation visuals in `tv.js` are stretched ~1.5×. Introduce
named constants (replacing the current inline magic numbers) so the timing is
tunable in one place:

| effect | current | new (~1.5×) |
|--------|---------|-------------|
| hero flinch window | 350 ms | `HIT_FLINCH_MS = 525` |
| red flash window | 250 ms | `HIT_FLASH_MS = 375` |
| impact FX window | 400 ms | `HIT_FX_MS = 600` |
| monster lunge window | 450 ms | `HIT_LUNGE_MS = 675` |
| FX 2-frame flip period | 120 ms | `HIT_FX_FRAME_MS = 180` |

The `Math.sin(age / dur * π)` pulse envelopes just reference these constants, so
each hit's in-and-out reads a beat slower without other changes.

## Testing

`tv.js` has no unit harness; verification is a controller live-browser check:
- Rotation visibly alternates home ↔ variety (A,B,A,C…); the home board shows
  **THIS FIGHT** with live-climbing damage during combat and flips to
  **STANDINGS** (multi-stat rows) during the victory popup / idle; dots track the
  6 variety boards; no console errors.
- A monster counter-attack's flinch/flash/FX/lunge visibly play slower than
  before but still resolve cleanly.
- `node --check src/web/public/tv/tv.js` parses; the full vitest suite stays
  green (tv.js isn't imported by tests).

## Deliberate decisions

- No server change — both the current-fight and overall data are already in the
  SSE payloads.
- Board A's idle fallback is the *old multi-stat row* (not the single-stat
  `overall_tokens` variety board), so downtime restores the exact "standings"
  view that was missed, distinct from the tokens-only variety board.
- `overall_tokens` stays in the variety pool too; showing it as a variety board
  and as the idle fallback is acceptable (they only coincide between fights).

## Files touched

- `src/web/public/tv/tv.js` — home board (2 modes) + woven sequence + dots +
  render refactor; hit-animation timing constants.

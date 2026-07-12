# Sprite Two-Frame Animation (TV) — Design

**Date:** 2026-07-12
**Status:** Approved (small single-file feature)
**Backlog:** #13

## Goal

Make the TV dungeon feel alive by alternating each creature/hero sprite between
its two animation frames (frame A ↔ its `+18` partner) on a slow, staggered
shared clock. Applies to the active monster (incl. pack duplicates) and the
battlefield heroes.

## Background

`creatures_24x24` is a 22×18 sheet of A/B animation pairs: a frame-A sprite at
file index `N` has its animation partner at `N + 18`. Everything the TV
currently renders is a **frame-A** sprite (bestiary monsters are frame-A; class
avatars are row 1 = frame-A), so the partner (`N + 18`) always exists. The math
already lives in `src/web/public/anim.js` (`framePartner`, `frameAt`), used by
the dev `/catalog`. `tv.js` is a classic (non-module) script and can't import
it, so it mirrors the tiny bit of math inline (the same way `MSHADOW` mirrors
`MONSTER_SHADOWS`).

## Scope

**In:** `src/web/public/tv/tv.js` only — no server/view-model change. The frame-B
URL is derived from the sprite URL tv.js already receives
(`/sprites/creatures_24x24/oryx_16bit_fantasy_creatures_<N>.png`).

**Out (this build):**
- Leaderboard avatars and the defeat-popup creature stay static (small side
  content; flipping thumbnails read as noisy).
- **Decor animation** — dungeon2 currently renders no decor (`layout.decor` is
  empty; backlog #6). Animated decor is a separate problem anyway: decor tiles
  come from the **world** sheet, which does NOT follow the creatures' `+18`
  pairing, and decor is baked into the static background canvas (`buildBackground`)
  rather than drawn per-frame. Deferred to a follow-on when #6 lands (see Risks).

## Design

All changes in `src/web/public/tv/tv.js`.

### Constants (near the other top-of-file consts)
```js
const ANIM_MS = 600;  // A/B flip period (~0.6s)
const ANIM_ROW = 18;  // creatures_24x24 A/B partner offset (mirrors anim.js ROW)
```

### Helpers (near `img` / `drawSprite`)
```js
// The +18 animation-partner URL for a frame-A creature sprite URL.
function partnerUrl(url) {
  return url.replace(/_(\d+)\.png$/, (_m, n) =>
    '_' + String(Number(n) + ANIM_ROW).padStart(2, '0') + '.png');
}

// Animated sprite image for `url`, keyed so sprites don't all flip in unison.
// Shows frame A, or its +18 partner on alternate ticks; if the partner image
// hasn't loaded yet, stays on frame A (no blank/flicker).
function animImg(url, key, t) {
  const phase = (key * 137 + 53) % ANIM_MS;      // spreads flips across the period
  const showB = Math.floor((t + phase) / ANIM_MS) % 2 === 1;
  if (!showB) return img(url);
  const b = img(partnerUrl(url));
  return (b.complete && b.naturalWidth) ? b : img(url);
}
```

### Apply
- `render(t)` → call `drawMonster(t)` (currently `drawMonster()`), threading the
  raf timestamp `render` already receives.
- `drawMonster(t)`:
  - main sprite: `animImg(e.creatureUrl, 100, t)` (was `img(e.creatureUrl)`).
  - pack duplicate `i`: `animImg(e.creatureUrl, 100 + i, t)`.
  - (Shadows, raise, and geometry are unchanged.)
- `drawHeroes(t)`: hero sprite `animImg(p.avatarUrl, p.id, t)` (was
  `img(p.avatarUrl)`). The existing swing-flash (`globalAlpha`/lunge) composes on
  top unchanged.

Key namespaces don't collide: monster keys are `100..103`, hero keys are the
player ids `1..24`.

## Testing

No automated test — this is Canvas render code (consistent with the shadow/name
work). Verified via headless-Chrome screenshots at two virtual-time budgets
(~700ms and ~1300ms) that land on opposite `frameAt` ticks, confirming the
monster sprite actually changes A↔B between them.

## Risks / notes

- Partner images load lazily on first flip; the `complete && naturalWidth` guard
  keeps frame A up until the B image is ready, so no blank frame.
- `partnerUrl` only rewrites a trailing `_<digits>.png`; all sprite URLs match
  that shape. A URL that somehow doesn't match is returned unchanged (falls back
  to a static sprite — safe).
- **Decor follow-on (when #6 lands):** to animate decor, (1) build a world-sheet
  frame-pair map (which decor tiles animate + their B-frame coords — torches,
  etc.), and (2) draw animated decor per-frame in `render()` instead of baking it
  into the `bg` canvas in `buildBackground()`.

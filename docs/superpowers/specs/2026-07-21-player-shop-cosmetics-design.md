# Player Shop — Phase 0 (foundation) + Cosmetics Tier 1 (clothing color)

- **Date:** 2026-07-21
- **Status:** Implemented and deployed; this first-slice design is historical.
- **Backlog:** #22 (the player-shop program). This spec is the **first slice** only.
- **Spike:** feasibility proven 2026-07-21 — programmatic clothing recolor of the
  oryx class sprites works and looks good. Result:
  https://claude.ai/code/artifact/ee20a55e-d4de-40ec-9cee-481014aa5084

The shipped program later expanded this slice with three wardrobe tiers, class
slot maps, material/tone controls, and Tier 1 potions with inventory. Higher
potion strengths, equipment/gems, and pets remain future work in BACKLOG #22.

---

## 1. Goal

Ship the **shop foundation** (a place to spend gold, with a server-authoritative
purchase spine) and the **first product — cosmetic clothing recolor**. A player
unlocks a "dye wheel" for gold, then freely recolors their character's dominant
clothing colour to any hue. The chosen colour shows up **everywhere** the character
is drawn — the TV battlefield, the character sheet, leaderboard avatars, and the
future local view.

Secondary goal: the shop is the game's **first gold sink**. The 2026-07-19 balance
review found gold only inflates (38M+ in circulation, ~6.7M/day minted, near-zero
removal). Cosmetics is a *one-time* sink per player; the recurring sinks
(consumables, loot boxes) come in later phases (#22).

## 2. Scope

**In this slice:**
- A `/shop` page on the dungeon shell, gated to a logged-in character (token).
- A reusable, atomic, server-authoritative **purchase transaction** (the spine
  every later product plugs into).
- **Cosmetics Tier 1:** buy the dye wheel once (gold); afterward re-pick any hue for
  free. Recolours the **dominant clothing ramp** only.
- A **sprite tint service**: pure-JS hue-swap recolor of a class sprite, disk-cached,
  referenced by a stable URL. One implementation, used by every surface.
- Surfaces lit at first ship: **TV battlefield sprite**, **character sheet**,
  **leaderboard avatars** (all reference the same tinted URL).

**Explicitly NOT in this slice (later phases of #22):**
- Tier 2 (secondary/hood colour) and Tier 3 (weapon colour) — same machinery, more
  colour sets; deferred.
- Consumables (timed boosts), loot boxes + equipment, gems, pets.
- Saturation/lightness control — the wheel is **hue-only** to start (keeps each
  shade's brightness + saturation, which is what looked good in the spike).

## 3. How the recolor works (spike recap)

Per pixel in a sprite's **clothing colour ramp**: `RGB → HSV`, replace `H` with the
chosen hue, keep `S` and `V`. That preserves each shade (dark folds stay dark), so
any hue looks natural. Skin, metal, weapon, and the near-black outline (`#262626`)
are never touched. Palettes are tiny (9–15 colours), so the "which colours are
clothing" designation is a small hand-authored list — 2–4 colours per sprite.

## 4. Architecture — the render model

**The source of truth is the player's *choice* (hue numbers), not a baked image.**
The image is a derived, cached artifact.

```
player picks a hue
   └─> stored on the player as an integer (primary_hue 0–359)
          └─> a tinted sprite URL is DERIVED from (class, gender, tier hues)
                 └─> the sprite tint service generates + disk-caches the PNG on first request
                        └─> TV / character sheet / leaderboard / local view all <img> that same URL
```

Why store the number, not the image:
- **Free re-recolouring** (purchase model A) is instant — just update one integer.
- **Split colours later (T2/T3) don't explode** — three stored hues → one derived
  image, not a combinatorial pile of baked assets.
- The cache is a pure function of the URL, so it's immutable + safe to clear anytime.

Why **server-generate + URL** over recolouring live in each client:
- A URL-referenced image drops into *any* surface (including plain server-rendered
  `<img>`) with **one** implementation and zero per-surface recolor code.
- Sprites are 24×24 and results are cached (generated once per unique look), so a
  **pure-JS pixel recolor — no native dependency** — is plenty fast and low-risk on
  the Pi.
- Client-side canvas recolor is used in *one* place only: the shop's **live picker
  preview**, for instant feedback while dragging the wheel (no round-trip). The core
  hue-swap function is shared between that preview and the server tint service.

## 5. Data model

### 5.1 New table `player_cosmetics` (migration, append to `src/db/migrations.ts`)

```sql
CREATE TABLE IF NOT EXISTS player_cosmetics (
  player_id     INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  wheel_tier    INTEGER NOT NULL DEFAULT 0,   -- highest cosmetic tier unlocked: 0 none, 1 dominant, 2 +secondary, 3 +weapon
  primary_hue   INTEGER,                       -- 0–359, NULL = unmodified sprite
  secondary_hue INTEGER,                       -- NULL until T2
  weapon_hue    INTEGER,                       -- NULL until T3
  updated_at    INTEGER NOT NULL
);
```

- Row is **lazily created** on first purchase. No row / `primary_hue IS NULL` ⇒ the
  player renders the default sprite (fully backward compatible).
- This slice only writes `wheel_tier ∈ {0,1}` and `primary_hue`.

### 5.2 Clothing-colour map (data) — `src/domain/cosmetics.ts`

A per-sprite designation of which palette colours are the clothing ramp(s):

```ts
// keyed by class_key; verified to hold for BOTH genders, else split per gender
export const CLOTHING: Record<string, { dominant: string[]; secondary?: string[]; weapon?: string[] }> = {
  knight: { dominant: ['#3cbcfc', '#9adcfd', '#2985b2'] },  // blue tunic/plume
  wizard: { dominant: ['#cf3232', '#ff3d3d'] },             // red robe/hood
  // …9 classes; secondary/weapon added in later tiers
};
```

- Plan task: **author + visually verify all 9 classes × 2 genders** (the spike
  confirmed knight + wizard, male). Confirm the female variant shares the ramp; if
  not, key by `class_key + gender`.
- A coverage **test** fails the build if a class lacks a `dominant` set, or a listed
  colour isn't present in that sprite (mirrors the settings-meta coverage test).

## 6. Components

### 6.1 Sprite tint service — `src/domain/spritetint.ts` + a route

- Pure fn `hueSwap(rgb, targetHueDeg) → rgb` (HSV, replace H, keep S/V) — **shared**
  with the client picker preview.
- `recolorSprite(pngBuffer, clothingColors, hue) → pngBuffer` using **pngjs** (new
  dep; pure JS, no native build). Loops pixels; recolours matches; passes the rest.
- Route: `GET /sprite/tint/:sprite/:frame/:hue.png`
  - `:sprite` = `class_gender` (e.g. `knight_M`) — validated against the known set.
  - `:frame` = `a` | `b` — the two animation frames (B = frame-A file index + 18),
    so the TV's existing A/B animation keeps working.
  - `:hue` = integer `0`–`359` — validated.
  - Fully deterministic ⇒ `Cache-Control: public, max-age=31536000, immutable`.
  - **Disk cache** under a regenerable dir (e.g. `data/tint-cache/`, gitignored,
    never clobbered on deploy; safe to wipe — it just regenerates). On miss: load
    the base sprite from `spritesDir`, recolour, write, serve; on hit: serve file.
- Later tiers extend the URL/spec to carry `secondary`/`weapon` hues; single-hue now.

### 6.2 Shop domain — `src/domain/shop.ts` (the reusable spine)

- A small **SKU catalog**. This slice: `cosmetic_wheel_t1` at a price from settings.
- `purchase(db, playerId, sku): PurchaseResult` — one SQLite transaction:
  1. re-read the player's gold **inside** the tx,
  2. reject if already owned (`wheel_tier >= 1`) — **no charge** (idempotent),
  3. reject if `gold < price` (`insufficient`),
  4. deduct gold, upsert `player_cosmetics` granting the tier, stamp `updated_at`.
  - Returns `{ ok, reason?, newGold?, tier? }`. Atomic ⇒ no double-spend.
- `setCosmeticHue(db, playerId, region, hue)` — the free recolour:
  - requires the tier for that region unlocked (`region='primary'` ⇒ `wheel_tier>=1`),
  - validates `hue ∈ [0,359]`, updates `player_cosmetics`. No gold.
- `cosmeticSpriteUrl(player, cosmetics, frame)` — the derivation used by every
  view-model: returns the tinted URL if a hue is set, else the plain class sprite.

### 6.3 Shop page + colour picker — `/shop` route + `shop.ejs`

- `GET /shop?token=<auth_token>` — gated exactly like `/character` (token → player;
  no token ⇒ the existing character-login page). Renders `shop.ejs` on the **full**
  dungeon shell.
- **Not yet unlocked:** a hero card with the player's current sprite, gold balance,
  and an **"Unlock the Dye Wheel — <price>g"** `.btn-gold` (disabled with "need X
  more" if short). `POST /shop/unlock` `{token}` → `purchase(...)` → flash result.
- **Unlocked:** the **colour wheel** — an HSL wheel (canvas) + a **live sprite
  preview** that recolours in real time (client-side canvas using the shared
  `hueSwap` + the clothing map for this sprite), and a **"Save colour"** button.
  `POST /shop/color` `{token, hue}` → `setCosmeticHue(...)`.
- Later tiers shown as **locked teasers** ("Secondary dye — coming soon").
- Add a **"Shop"** link to the character-sheet nav.

### 6.4 Surfaces reference the tinted URL

- **View-models** (`tvview.ts` hero payload, character-sheet, leaderboards) call
  `cosmeticSpriteUrl(...)` instead of `classSpriteUrl(...)`. When a hue is set the
  hero's sprite URL(s) point at the tint endpoint; otherwise unchanged.
- **TV (`tv.js`):** the SSE hero payload carries the tinted **frame-A** URL; the
  client requests frame **B** from the same endpoint (`:frame=b`) for the A/B
  animation. `partnerUrl()` is bypassed when a sprite is a tint URL.
- **Character sheet / leaderboard avatars:** plain `<img src>` of the tinted URL.

## 7. Visual design — the shop should look as fun as the rest

Inherits the dungeon shell (#18, `dungeon.css`): torch-lit wall border
(`.wall`/`.sconce`), loot-float gutters (`.loot-rail`), panels/cards (`.panel`,
`.card`, `.stat-*`), gold buttons (`.btn-gold`), pixelated art (`.px`), grimoire
type, `--gold`/`--head`/`--ink` on `--panel` dark ground. Shop-specific flourishes,
kept tasteful and matching the character sheet's density:

- Frame it as a **dungeon dye-vat / treasury**, not a web store.
- The **colour wheel is the centrepiece** — a gold-ringed HSL wheel with the
  player's sprite on a small **pedestal beside it, recolouring live** as they spin.
  That instant feedback *is* the fun.
- A **gold-coin balance** readout in the header (reuse `.stat-card`).
- A satisfying **"Unlocked!" `.flash`** on purchase; the wheel then slides in.
- Future tiers as **glowing-but-chained teasers** so the progression is visible.
- Respect the existing responsive rules (loot rails hide < 1180px; body never
  scrolls sideways).

A visual mock will accompany the plan (or a first render to iterate on live).

## 8. Pricing & economy

- **T1 default price: 1,500,000 gold** (in the 1–2M range from #22), exposed as an
  **admin setting** `cosmetic_wheel_t1_price` (+ `settings-meta` entry) so it's
  tunable like every other knob.
- Sink shape: **one-time** ~1.5M per adopter. Top players hold 5–7M (a few days'
  income), so it's affordable-but-meaningful; smaller players save toward it. This is
  a finite sink by design — the recurring sinks are later phases.
- **Fairness:** cosmetic-only, **zero combat effect** ⇒ no pay-to-win, regardless of
  who's a whale. This is the safe first product precisely because it can't unbalance.

## 9. Security & correctness

- **Auth:** token via query (GET page) / body (POST), matching `/character`. The
  token is the player's secret — never log it; POSTs are server-validated.
- **Atomic purchase:** the whole check-and-deduct-and-grant runs in one
  `db.transaction(...)`, re-reading gold inside — no double-spend, no race.
- **Idempotent:** buying an owned tier is a no-op (no charge).
- **Validation (zod):** `hue` integer 0–359; `sprite`/`frame`/`hue` in the tint route
  bounded and whitelisted; unknown sprite ⇒ 404.
- **Cache safety:** tint cache is fully regenerable and lives outside `assets/`
  (read-only vendored) and outside git; wiping it only forces a re-render.

## 10. Testing

- **Unit:** `hueSwap` (clothing colour + hue → expected RGB; a skin/outline colour is
  returned unchanged); clothing-map coverage (every class has `dominant`; every
  listed colour exists in its sprite); `purchase` (insufficient rejected; gold
  deducted exactly once; already-owned no-op; tier granted); `setCosmeticHue`
  (rejects when tier not owned; validates hue range).
- **Integration:** `GET /shop` is login-gated; buy flow (`POST /shop/unlock` → gold
  down by price, `wheel_tier=1`); `GET /sprite/tint/...` returns a PNG that differs
  from the base for a non-null hue and matches the base semantics for skin pixels;
  the TV/character-sheet view-models emit the tinted URL only when a hue is set.
- **Visual:** controller visual-verify on the real TV + character sheet (house
  pattern) — recolour shows, animates (A/B), and matches the picker preview.

## 11. Rollout

- Additive only: a migration (new table), a new settings key (seeded via
  `INSERT OR IGNORE` on boot), new routes/domain/view, one new dep (`pngjs`). No
  change to combat or the existing economy. Ships via the usual `git → Pi
  auto-updater` path; `npm ci` on the Pi since the lockfile changes (pngjs).

## 12. Open items to confirm during planning

1. **Exact T1 price** — default 1.5M; confirm or set via the new admin setting.
2. **Female sprite ramps** — confirm the F variants share the male clothing colours
   (author per-gender maps if not). Only knight/wizard male were spiked.
3. **Frame-B tint handling** on the TV — the plan nails the exact payload/URL shape
   for the A/B animation partner.
4. **Cache dir location** — `data/tint-cache/` (persistent, regenerable) vs a tmp
   dir (regenerated on boot). Lean `data/tint-cache/`.

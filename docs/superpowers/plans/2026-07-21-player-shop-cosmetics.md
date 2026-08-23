# Player Shop — Phase 0 + Cosmetics T1 Implementation Plan

> **Implementation status (2026-08-23): COMPLETE AND DEPLOYED.** This first
> shop slice and its later Phase 1/Tier 1 extensions shipped and were verified
> on the Pi at commit `4caebd4`. Unchecked boxes below are preserved as
> historical implementation instructions, not current todo. See BACKLOG #22 for
> higher potion tiers, equipment/gems, and pets.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the shop foundation (atomic gold-spending purchase spine) and its first product — a cosmetic "dye wheel" that recolors a character's dominant clothing hue, shown everywhere via a cached server-side sprite tint referenced by URL.

**Architecture:** Store the player's chosen hue as an integer on a new `player_cosmetics` row. A pure-JS tint service hue-swaps the sprite's clothing colors and disk-caches the PNG; every surface (TV, character sheet, leaderboard) references that derived URL. Buy the wheel once (gold, atomic), then re-pick any hue for free.

**Tech Stack:** TypeScript (ESM, tsx), better-sqlite3, express + ejs, `pngjs` (new, pure-JS PNG recolor), vitest.

**Spec:** `docs/superpowers/specs/2026-07-21-player-shop-cosmetics-design.md`

## Global Constraints

- **Node 22 / better-sqlite3, ESM + tsx** — no build step; `import`/`export` syntax.
- **`asyncHandler` rule:** every `async` express handler is wrapped in `asyncHandler(...)` (from `src/web/async.ts`), matching existing routes.
- **Domain functions take `now: number`** as a parameter (never call `Date.now()` inside) — mirrors the engine, keeps tests deterministic.
- **Auth:** token via query (GET) / body (POST), exactly like `/character`. Never log the token.
- **Hue is an integer 0–359.**
- **Sprite files:** `${config.spritesDir}/creatures_24x24/oryx_16bit_fantasy_creatures_NN.png`, `NN` = `spriteIndexFor(class, gender)` for frame A, `+18` for frame B (both zero-padded to 2 digits).
- **Tint cache dir:** `${path.dirname(config.dbPath)}/tint-cache/` — regenerable, gitignored, never in `assets/`.
- **T1 price:** default `1500000`, admin-tunable via setting `cosmetic_wheel_t1_price`.
- **Cosmetics are cosmetic-only** — zero combat/economy effect besides the gold spent.

---

## File Structure

- Create `src/domain/cosmetics.ts` — clothing-color map + sprite-id/frame helpers + `CosmeticState` accessors + `cosmeticSpriteUrl`.
- Create `src/domain/spritetint.ts` — `hueSwap` + `recolorSprite` (pngjs).
- Create `src/domain/shop.ts` — SKU catalog, `purchase`, `setCosmeticHue`, price lookup.
- Create `src/web/routes/shop.ts` — `GET /shop`, `POST /shop/unlock`, `POST /shop/color`, `GET /sprite/tint/:sprite/:frame/:hue.png`.
- Create `src/web/views/shop.ejs` — the shop page (dungeon shell).
- Create `src/web/public/shop.js` — client color-wheel + live preview.
- Modify `src/db/migrations.ts` — append `007_player_cosmetics`.
- Modify `src/domain/settings.ts` + `src/domain/settings-meta.ts` — the price knob.
- Modify `src/web/app.ts` — register shop routes.
- Modify `src/web/tvview.ts` + `src/domain/leaderboards.ts` + `src/web/routes/character.ts` — emit cosmetic sprite URLs.
- Modify `src/web/public/tv/tv.js` — frame-B partner for tint URLs.
- Modify `src/web/views/character-sheet.ejs` — Shop nav link + tinted avatar.
- Modify `.gitignore` — `data/tint-cache/`.
- Add dep `pngjs` + `@types/pngjs`.

---

## Task 1: Migration — `player_cosmetics` table

**Files:**
- Modify: `src/db/migrations.ts` (append to the `migrations` array)
- Test: `tests/db-cosmetics-migration.test.ts`

**Interfaces:**
- Produces: table `player_cosmetics(player_id PK, wheel_tier, primary_hue, secondary_hue, weapon_hue, updated_at)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db-cosmetics-migration.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('007_player_cosmetics migration', () => {
  it('creates player_cosmetics with the expected columns', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("PRAGMA table_info(player_cosmetics)").all() as any[]).map((c) => c.name);
    expect(cols).toEqual(['player_id', 'wheel_tier', 'primary_hue', 'secondary_hue', 'weapon_hue', 'updated_at']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db-cosmetics-migration.test.ts`
Expected: FAIL (empty column list — table missing).

- [ ] **Step 3: Append the migration**

In `src/db/migrations.ts`, add as the last element of the `migrations` array:

```ts
  {
    id: '007_player_cosmetics',
    sql: `
      CREATE TABLE player_cosmetics (
        player_id     INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        wheel_tier    INTEGER NOT NULL DEFAULT 0,
        primary_hue   INTEGER,
        secondary_hue INTEGER,
        weapon_hue    INTEGER,
        updated_at    INTEGER NOT NULL
      );
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db-cosmetics-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts tests/db-cosmetics-migration.test.ts
git commit -m "feat(shop): player_cosmetics migration"
```

---

## Task 2: Clothing-color map + sprite helpers

**Files:**
- Create: `src/domain/cosmetics.ts`
- Test: `tests/cosmetics-map.test.ts`
- Reference scripts (throwaway, for authoring the map): run under `python3` with Pillow.

**Interfaces:**
- Consumes: `spriteIndexFor`, `creatureSpriteFile`, `classSpriteUrl`, `Gender` from `src/domain/classes.ts`; `CLASSES` list.
- Produces:
  - `CLOTHING: Record<string, { dominant: string[]; secondary?: string[]; weapon?: string[] }>` (keyed by `class_key`).
  - `spriteId(classKey, gender): string` → e.g. `"knight_M"`.
  - `spriteFileIndex(classKey, gender, frame: 'a'|'b'): number`.

- [ ] **Step 1: Author the map (manual, scripted).** For each of the 9 classes, dump its palette and view it upscaled, then record the **dominant clothing** color ramp (the chromatic, non-skin ramp that fills the clothing — NOT the near-black `#262626` outline). Knight and wizard are pre-verified. Run for the rest:

```bash
SP=assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24
python3 - "$SP" <<'PY'
import sys, os
from PIL import Image
from collections import Counter
sp = sys.argv[1]
# class_key -> male creatures index (from src/domain/classes.ts)
IDX = {'knight':1,'thief':2,'ranger':3,'wizard':4,'priest':5,'shaman':6,'berserker':7,'swordsman':8,'paladin':9}
for name, idx in IDX.items():
    im = Image.open(os.path.join(sp, f'oryx_16bit_fantasy_creatures_{idx:02d}.png')).convert('RGBA')
    im.resize((240,240), Image.NEAREST).save(f'/tmp/cloth_{name}.png')   # eyeball this
    c = Counter(p for p in im.getdata() if p[3] > 0)
    print(name, [f'#{r:02x}{g:02x}{b:02x}(x{n})' for (r,g,b,a),n in c.most_common(10)])
PY
```

Eyeball each `/tmp/cloth_<name>.png`, pick the clothing ramp's hex values from the printed palette.

- [ ] **Step 2: Write the failing test**

```ts
// tests/cosmetics-map.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { CLOTHING, spriteId, spriteFileIndex } from '../src/domain/cosmetics';
import { CLASSES } from '../src/domain/classes';
import { creatureSpriteFile } from '../src/domain/classes';

const SPRITES = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24';
function spriteHexes(idx: number): Set<string> {
  const png = PNG.sync.read(readFileSync(`${SPRITES}/${creatureSpriteFile(idx)}`));
  const s = new Set<string>();
  for (let i = 0; i < png.data.length; i += 4)
    if (png.data[i + 3] > 0)
      s.add(((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]).toString(16).padStart(6, '0'));
  return s;
}

describe('CLOTHING map', () => {
  it('every class has a non-empty dominant ramp', () => {
    for (const c of CLASSES) {
      expect(CLOTHING[c.key], c.key).toBeDefined();
      expect(CLOTHING[c.key].dominant.length, c.key).toBeGreaterThan(0);
    }
  });
  it('every dominant color actually exists in that class sprite (M frame A)', () => {
    for (const c of CLASSES) {
      const hexes = spriteHexes(spriteFileIndex(c.key, 'M', 'a'));
      for (const hex of CLOTHING[c.key].dominant)
        expect(hexes.has(hex.replace('#', '').toLowerCase()), `${c.key} ${hex}`).toBe(true);
    }
  });
  it('spriteId / spriteFileIndex', () => {
    expect(spriteId('knight', 'M')).toBe('knight_M');
    expect(spriteFileIndex('knight', 'M', 'a')).toBe(1);
    expect(spriteFileIndex('knight', 'M', 'b')).toBe(19);
    expect(spriteFileIndex('knight', 'F', 'a')).toBe(10);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/cosmetics-map.test.ts`
Expected: FAIL (module `../src/domain/cosmetics` not found).

- [ ] **Step 4: Create `src/domain/cosmetics.ts`** (fill all 9 `dominant` arrays from Step 1; knight/wizard shown verified):

```ts
import { spriteIndexFor, classSpriteUrl, type Gender } from './classes';

/** Which palette colors are the recolorable clothing ramp, per class. Hand-authored + verified. */
export const CLOTHING: Record<string, { dominant: string[]; secondary?: string[]; weapon?: string[] }> = {
  knight: { dominant: ['#3cbcfc', '#9adcfd', '#2985b2'] },
  wizard: { dominant: ['#cf3232', '#ff3d3d'] },
  thief: { dominant: [/* from Step 1 */] },
  ranger: { dominant: [/* from Step 1 */] },
  priest: { dominant: [/* from Step 1 */] },
  shaman: { dominant: [/* from Step 1 */] },
  berserker: { dominant: ['#887000', '#b89600'] },
  swordsman: { dominant: [/* from Step 1 */] },
  paladin: { dominant: [/* from Step 1 */] },
};

export function spriteId(classKey: string, gender: Gender): string {
  return `${classKey}_${gender}`;
}
export function spriteFileIndex(classKey: string, gender: Gender, frame: 'a' | 'b'): number {
  const base = spriteIndexFor(classKey, gender);
  return frame === 'b' ? base + 18 : base;
}
```

> The `/* from Step 1 */` arrays MUST be filled with real hex values before the test can pass — the coverage test rejects any missing class or any color not present in the sprite. This is the authoring deliverable, not a placeholder to leave.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cosmetics-map.test.ts`
Expected: PASS (fails loudly if any class's colors are wrong — re-check that class in Step 1).

- [ ] **Step 6: Commit**

```bash
git add src/domain/cosmetics.ts tests/cosmetics-map.test.ts
git commit -m "feat(shop): clothing-color map + sprite helpers"
```

---

## Task 3: Sprite tint core (`hueSwap` + `recolorSprite`)

**Files:**
- Create: `src/domain/spritetint.ts`
- Test: `tests/spritetint.test.ts`
- Modify: `package.json` (add `pngjs`, `@types/pngjs`)

**Interfaces:**
- Produces:
  - `hueSwap(r, g, b, hueDeg): [number, number, number]` — keeps S & V, replaces hue.
  - `recolorSprite(pngBuffer: Buffer, clothing: string[], hueDeg: number): Buffer`.

- [ ] **Step 1: Add the dependency**

```bash
npm install pngjs && npm install -D @types/pngjs
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/spritetint.test.ts
import { describe, it, expect } from 'vitest';
import { hueSwap, recolorSprite } from '../src/domain/spritetint';
import { PNG } from 'pngjs';

describe('hueSwap', () => {
  it('preserves brightness/saturation, replaces hue (red -> green at 120)', () => {
    const [r, g, b] = hueSwap(0xff, 0x3d, 0x3d, 120); // vivid red -> vivid green
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(g).toBe(0xff); // max channel (V) preserved
  });
  it('keeps a shade dark (dark red -> dark green)', () => {
    const [, g] = hueSwap(0xcf, 0x32, 0x32, 120);
    expect(g).toBe(0xcf); // same V as the input's max channel
  });
});

describe('recolorSprite', () => {
  it('recolors only clothing pixels; leaves others intact', () => {
    const png = new PNG({ width: 2, height: 1 });
    // px0 = clothing red #ff3d3d, px1 = skin #ffd1a6
    png.data.set([0xff, 0x3d, 0x3d, 255], 0);
    png.data.set([0xff, 0xd1, 0xa6, 255], 4);
    const out = PNG.sync.read(recolorSprite(PNG.sync.write(png), ['#ff3d3d'], 120));
    expect([out.data[0], out.data[1], out.data[2]]).not.toEqual([0xff, 0x3d, 0x3d]); // px0 changed
    expect([out.data[4], out.data[5], out.data[6]]).toEqual([0xff, 0xd1, 0xa6]);     // px1 untouched
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/spritetint.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Create `src/domain/spritetint.ts`**

```ts
import { PNG } from 'pngjs';

/** RGB (0–255) → HSV, replace hue (degrees), keep S & V → RGB (0–255). */
export function hueSwap(r: number, g: number, b: number, hueDeg: number): [number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const v = max, s = max === 0 ? 0 : (max - min) / max;
  const h = ((hueDeg % 360) + 360) % 360 / 360;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let rr = 0, gg = 0, bb = 0;
  switch (i % 6) {
    case 0: rr = v; gg = t; bb = p; break;
    case 1: rr = q; gg = v; bb = p; break;
    case 2: rr = p; gg = v; bb = t; break;
    case 3: rr = p; gg = q; bb = v; break;
    case 4: rr = t; gg = p; bb = v; break;
    case 5: rr = v; gg = p; bb = q; break;
  }
  return [Math.round(rr * 255), Math.round(gg * 255), Math.round(bb * 255)];
}

/** Hue-swap every pixel whose RGB is in `clothing` (hex strings). Returns a new PNG buffer. */
export function recolorSprite(pngBuffer: Buffer, clothing: string[], hueDeg: number): Buffer {
  const png = PNG.sync.read(pngBuffer);
  const set = new Set(clothing.map((h) => h.replace('#', '').toLowerCase()));
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const hex = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0');
    if (set.has(hex)) {
      const [r, g, b] = hueSwap(d[i], d[i + 1], d[i + 2], hueDeg);
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  }
  return PNG.sync.write(png);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/spritetint.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/domain/spritetint.ts tests/spritetint.test.ts
git commit -m "feat(shop): sprite tint core (hue-swap recolor via pngjs)"
```

---

## Task 4: Shop domain — settings knob, purchase, setCosmeticHue, cosmeticSpriteUrl

**Files:**
- Modify: `src/domain/settings.ts` (DEFAULT_SETTINGS) + `src/domain/settings-meta.ts`
- Create: `src/domain/shop.ts`
- Modify: `src/domain/cosmetics.ts` (add `CosmeticState`, `getCosmetics`, `cosmeticSpriteUrl`)
- Test: `tests/shop.test.ts`

**Interfaces:**
- Consumes: `player_cosmetics` table (Task 1); `spriteId` (Task 2); `classSpriteUrl` (classes).
- Produces:
  - `interface CosmeticState { wheel_tier: number; primary_hue: number | null }`
  - `getCosmetics(db, playerId): CosmeticState | undefined`
  - `cosmeticSpriteUrl(classKey, gender, cos, frame='a'): string`
  - `SKUS`, `purchase(db, playerId, skuId, now): PurchaseResult`
  - `setCosmeticHue(db, playerId, region: 'primary', hue, now): SetHueResult`

- [ ] **Step 1: Add the price setting.** In `src/domain/settings.ts` `DEFAULT_SETTINGS`, after `monster_debuff_seconds`:

```ts
  cosmetic_wheel_t1_price: '1500000', // gold to unlock the Tier-1 clothing dye wheel
```

In `src/domain/settings-meta.ts`, add a new group entry:

```ts
  cosmetic_wheel_t1_price: { group: 'Shop', label: 'Dye wheel (T1) price', unit: 'gold', min: 0, step: 10000,
    description: 'Gold to unlock the Tier-1 clothing color wheel. Cosmetic only (no combat effect). Recoloring is free once unlocked.' },
```

- [ ] **Step 2: Extend `src/domain/cosmetics.ts`** (append):

```ts
import type Database from 'better-sqlite3';

export interface CosmeticState { wheel_tier: number; primary_hue: number | null }

export function getCosmetics(db: Database.Database, playerId: number): CosmeticState | undefined {
  return db.prepare('SELECT wheel_tier, primary_hue FROM player_cosmetics WHERE player_id = ?')
    .get(playerId) as CosmeticState | undefined;
}

/** Sprite URL for a character on any surface: tinted if a hue is set, else the plain class sprite. */
export function cosmeticSpriteUrl(
  classKey: string, gender: Gender, cos: CosmeticState | undefined, frame: 'a' | 'b' = 'a',
): string {
  if (cos && cos.primary_hue != null)
    return `/sprite/tint/${spriteId(classKey, gender)}/${frame}/${cos.primary_hue}.png`;
  return classSpriteUrl(classKey, gender);
}
```

- [ ] **Step 3: Write the failing test**

```ts
// tests/shop.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { getPlayerById } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { getCosmetics, cosmeticSpriteUrl } from '../src/domain/cosmetics';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });
function rich(gold: number) {
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = ? WHERE id = ?').run(gold, p.id);
  return p;
}

describe('purchase', () => {
  it('rejects insufficient gold, no deduction', () => {
    const p = rich(1000);
    const r = purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(r.ok).toBe(false);
    expect(getPlayerById(db, p.id)!.gold).toBe(1000);
  });
  it('deducts exactly the price and grants tier 1', () => {
    const p = rich(2_000_000);
    const r = purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(r).toMatchObject({ ok: true, tier: 1, newGold: 500_000 });
    expect(getPlayerById(db, p.id)!.gold).toBe(500_000);
    expect(getCosmetics(db, p.id)!.wheel_tier).toBe(1);
  });
  it('is idempotent — owning it again is a no-op (no double charge)', () => {
    const p = rich(4_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    const r = purchase(db, p.id, 'cosmetic_wheel_t1', 200);
    expect(r).toMatchObject({ ok: false, reason: 'already_owned' });
    expect(getPlayerById(db, p.id)!.gold).toBe(2_500_000);
  });
});

describe('setCosmeticHue', () => {
  it('rejects when the wheel is not unlocked', () => {
    const p = rich(0);
    expect(setCosmeticHue(db, p.id, 'primary', 210, 100)).toMatchObject({ ok: false, reason: 'locked' });
  });
  it('rejects an out-of-range hue', () => {
    const p = rich(2_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(setCosmeticHue(db, p.id, 'primary', 400, 200)).toMatchObject({ ok: false, reason: 'bad_hue' });
  });
  it('sets the hue once unlocked and drives the tinted URL', () => {
    const p = rich(2_000_000);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    expect(setCosmeticHue(db, p.id, 'primary', 210, 200)).toEqual({ ok: true });
    expect(cosmeticSpriteUrl('wizard', 'M', getCosmetics(db, p.id), 'a'))
      .toBe('/sprite/tint/wizard_M/a/210.png');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/shop.test.ts`
Expected: FAIL (module `../src/domain/shop` not found).

- [ ] **Step 5: Create `src/domain/shop.ts`**

```ts
import type Database from 'better-sqlite3';
import { getSetting } from './settings';

export interface Sku { id: string; priceSetting: string; priceDefault: number; grantTier: number }
export const SKUS: Record<string, Sku> = {
  cosmetic_wheel_t1: { id: 'cosmetic_wheel_t1', priceSetting: 'cosmetic_wheel_t1_price', priceDefault: 1_500_000, grantTier: 1 },
};

export type PurchaseResult =
  | { ok: true; newGold: number; tier: number }
  | { ok: false; reason: 'unknown_sku' | 'no_player' | 'already_owned' | 'insufficient_gold'; price?: number; gold?: number };

function priceOf(db: Database.Database, sku: Sku): number {
  const raw = getSetting(db, sku.priceSetting);
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : sku.priceDefault;
}

export function purchase(db: Database.Database, playerId: number, skuId: string, now: number): PurchaseResult {
  const sku = SKUS[skuId];
  if (!sku) return { ok: false, reason: 'unknown_sku' };
  const price = priceOf(db, sku);
  return db.transaction((): PurchaseResult => {
    const p = db.prepare('SELECT gold FROM players WHERE id = ?').get(playerId) as { gold: number } | undefined;
    if (!p) return { ok: false, reason: 'no_player' };
    const cos = db.prepare('SELECT wheel_tier FROM player_cosmetics WHERE player_id = ?')
      .get(playerId) as { wheel_tier: number } | undefined;
    if (cos && cos.wheel_tier >= sku.grantTier) return { ok: false, reason: 'already_owned' };
    if (p.gold < price) return { ok: false, reason: 'insufficient_gold', price, gold: p.gold };
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(price, playerId);
    db.prepare(
      `INSERT INTO player_cosmetics (player_id, wheel_tier, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET wheel_tier = MAX(wheel_tier, excluded.wheel_tier), updated_at = excluded.updated_at`,
    ).run(playerId, sku.grantTier, now);
    return { ok: true, newGold: p.gold - price, tier: sku.grantTier };
  })();
}

export type SetHueResult = { ok: true } | { ok: false; reason: 'no_player' | 'locked' | 'bad_hue' };

export function setCosmeticHue(
  db: Database.Database, playerId: number, region: 'primary', hue: number, now: number,
): SetHueResult {
  if (!Number.isInteger(hue) || hue < 0 || hue > 359) return { ok: false, reason: 'bad_hue' };
  const cos = db.prepare('SELECT wheel_tier FROM player_cosmetics WHERE player_id = ?')
    .get(playerId) as { wheel_tier: number } | undefined;
  if (!cos || cos.wheel_tier < 1) return { ok: false, reason: 'locked' };
  db.prepare('UPDATE player_cosmetics SET primary_hue = ?, updated_at = ? WHERE player_id = ?').run(hue, now, playerId);
  return { ok: true };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/shop.test.ts tests/settings-meta.test.ts`
Expected: PASS (settings-meta parity stays green because both DEFAULT + META got the key).

- [ ] **Step 7: Commit**

```bash
git add src/domain/settings.ts src/domain/settings-meta.ts src/domain/shop.ts src/domain/cosmetics.ts tests/shop.test.ts
git commit -m "feat(shop): price knob + atomic purchase + setCosmeticHue + cosmeticSpriteUrl"
```

---

## Task 5: Tint route + disk cache

**Files:**
- Create: `src/web/routes/shop.ts` (start with just the tint endpoint)
- Modify: `src/web/app.ts` (register), `.gitignore`
- Test: `tests/web-tint.test.ts`

**Interfaces:**
- Consumes: `CLOTHING`, `spriteFileIndex` (Task 2); `recolorSprite` (Task 3); `config.spritesDir`, `config.dbPath`.
- Produces: `GET /sprite/tint/:sprite/:frame/:hue.png` → image/png (cached). `registerShopRoutes(app, deps)`.

- [ ] **Step 1: gitignore the cache**

Append to `.gitignore`:

```
data/tint-cache/
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/web-tint.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';
import { PNG } from 'pngjs';

function app() {
  const db = openDb(':memory:'); seedSettings(db);
  return createApp({ db, config: loadConfig({}) });
}

describe('GET /sprite/tint', () => {
  it('returns a recolored PNG for a valid sprite/frame/hue', async () => {
    const res = await request(app()).get('/sprite/tint/wizard_M/a/120.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    const png = PNG.sync.read(res.body);
    expect(png.width).toBe(24);
  });
  it('404s an unknown class', async () => {
    expect((await request(app()).get('/sprite/tint/nope_M/a/120.png')).status).toBe(404);
  });
  it('400s an out-of-range hue', async () => {
    expect((await request(app()).get('/sprite/tint/wizard_M/a/999.png')).status).toBe(400);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/web-tint.test.ts`
Expected: FAIL (route not registered → 404 on the valid case too, or module missing).

- [ ] **Step 4: Create `src/web/routes/shop.ts`** (tint endpoint only for now):

```ts
import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import type { AppDeps } from '../app';
import { asyncHandler } from '../async';
import { getClass, creatureSpriteFile, type Gender } from '../../domain/classes';
import { CLOTHING, spriteFileIndex } from '../../domain/cosmetics';
import { recolorSprite } from '../../domain/spritetint';

export function registerShopRoutes(app: Express, { db, config }: AppDeps): void {
  const cacheDir = path.join(path.dirname(config.dbPath), 'tint-cache');

  app.get('/sprite/tint/:sprite/:frame/:hue.png', asyncHandler(async (req, res) => {
    const [classKey, gender] = String(req.params.sprite).split('_');
    const frame = req.params.frame === 'b' ? 'b' : 'a';
    const hue = Number(req.params.hue);
    if (!getClass(classKey) || (gender !== 'M' && gender !== 'F') || !CLOTHING[classKey]) {
      res.sendStatus(404); return;
    }
    if (!Number.isInteger(hue) || hue < 0 || hue > 359) { res.sendStatus(400); return; }

    const cacheFile = path.join(cacheDir, `${classKey}_${gender}_${frame}_${hue}.png`);
    res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable');
    if (fs.existsSync(cacheFile)) { res.sendFile(path.resolve(cacheFile)); return; }

    const srcFile = path.resolve(
      config.spritesDir, 'creatures_24x24',
      creatureSpriteFile(spriteFileIndex(classKey, gender as Gender, frame)),
    );
    const out = recolorSprite(fs.readFileSync(srcFile), CLOTHING[classKey].dominant, hue);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));
}
```

- [ ] **Step 5: Register in `src/web/app.ts`.** Add the import near the other route imports:

```ts
import { registerShopRoutes } from './routes/shop';
```

and call it with the others (after `registerCharacterRoutes(app, { db, config });`):

```ts
  registerShopRoutes(app, { db, config });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/web-tint.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/shop.ts src/web/app.ts .gitignore tests/web-tint.test.ts
git commit -m "feat(shop): cached sprite tint endpoint"
```

---

## Task 6: Shop page + unlock/color routes + client picker

**Files:**
- Modify: `src/web/routes/shop.ts` (add `GET /shop`, `POST /shop/unlock`, `POST /shop/color`)
- Create: `src/web/views/shop.ejs`, `src/web/public/shop.js`
- Test: `tests/web-shop.test.ts`

**Interfaces:**
- Consumes: `getPlayerByToken` (players); `purchase`, `setCosmeticHue`, `SKUS` (shop); `getCosmetics`, `CLOTHING`, `cosmeticSpriteUrl`, `spriteId` (cosmetics); `getSetting` (settings); `renderPage` (app).

- [ ] **Step 1: Write the failing test**

```ts
// tests/web-shop.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';

function ctx() {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
  return { db, app, p };
}

describe('shop', () => {
  it('GET /shop without a token shows the character login', async () => {
    const { app } = ctx();
    const res = await request(app).get('/shop');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Character Login');
  });
  it('POST /shop/unlock deducts gold and unlocks the wheel', async () => {
    const { db, app, p } = ctx();
    const res = await request(app).type('form').post('/shop/unlock').send({ token: p.auth_token });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)!.gold).toBe(500000);
  });
  it('POST /shop/color sets the hue after unlock', async () => {
    const { db, app, p } = ctx();
    await request(app).type('form').post('/shop/unlock').send({ token: p.auth_token });
    const res = await request(app).type('form').post('/shop/color').send({ token: p.auth_token, hue: '210' });
    expect(res.status).toBe(302);
    expect((db.prepare('SELECT primary_hue FROM player_cosmetics WHERE player_id=?').get(p.id) as any).primary_hue).toBe(210);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-shop.test.ts`
Expected: FAIL (routes 404).

- [ ] **Step 3: Add the routes to `src/web/routes/shop.ts`.** Add imports at top:

```ts
import { z } from 'zod';
import { renderPage } from '../app';
import { getPlayerByToken } from '../../domain/players';
import { getClass, classSpriteUrl } from '../../domain/classes';
import type { Gender } from '../../domain/classes';
import { getCosmetics, cosmeticSpriteUrl, spriteId, CLOTHING as CLOTHING_MAP } from '../../domain/cosmetics';
import { purchase, setCosmeticHue, SKUS } from '../../domain/shop';
import { getSetting } from '../../domain/settings';
```

Inside `registerShopRoutes`, after the tint route:

```ts
  const priceOf = () => Number(getSetting(db, SKUS.cosmetic_wheel_t1.priceSetting) ?? SKUS.cosmetic_wheel_t1.priceDefault);

  app.get('/shop', asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const player = token ? getPlayerByToken(db, token) : undefined;
    if (!player) { res.send(await renderPage('character-login', { title: 'Character Login' })); return; }
    const cos = getCosmetics(db, player.id);
    res.send(await renderPage('shop', {
      title: 'Shop', frame: 'full', styles: ['/static/shop.js'],
      token, player, price: priceOf(),
      unlocked: !!cos && cos.wheel_tier >= 1,
      currentHue: cos?.primary_hue ?? null,
      spriteId: spriteId(player.class_key, player.gender as Gender),
      baseSpriteUrl: classSpriteUrl(player.class_key, player.gender as Gender),
      previewUrl: cosmeticSpriteUrl(player.class_key, player.gender as Gender, cos, 'a'),
      clothing: CLOTHING_MAP[player.class_key]?.dominant ?? [],
    }));
  }));

  const UnlockInput = z.object({ token: z.string().min(1) });
  app.post('/shop/unlock', (req, res) => {
    const parsed = UnlockInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).send('Invalid input'); return; }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) { res.status(404).send('No character'); return; }
    purchase(db, player.id, 'cosmetic_wheel_t1', Date.now());
    res.redirect(`/shop?token=${encodeURIComponent(parsed.data.token)}`);
  });

  const ColorInput = z.object({ token: z.string().min(1), hue: z.coerce.number().int().min(0).max(359) });
  app.post('/shop/color', (req, res) => {
    const parsed = ColorInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).send('Invalid input'); return; }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) { res.status(404).send('No character'); return; }
    setCosmeticHue(db, player.id, 'primary', parsed.data.hue, Date.now());
    res.redirect(`/shop?token=${encodeURIComponent(parsed.data.token)}`);
  });
```

> `Date.now()` is fine here (web layer, not domain); the domain fns received `now` as a param per the global constraint.

- [ ] **Step 4: Create `src/web/views/shop.ejs`** (dungeon shell; treasury framing; wheel + live preview):

```html
<div class="panel">
  <div class="sec-head"><h1 class="brand">The Dye Vault</h1>
    <a class="btn btn-ghost" href="/character?token=<%= token %>">← Character</a></div>
  <div class="stat-card"><span class="stat-k">Your gold</span>
    <span class="stat-v"><%= player.gold.toLocaleString() %></span></div>

  <% if (!unlocked) { %>
    <div class="card" style="text-align:center">
      <img class="px" src="<%= baseSpriteUrl %>" width="120" height="120" alt="your character">
      <p>Unlock the <b>Dye Wheel</b> to recolor your clothing to any color, forever.</p>
      <form method="post" action="/shop/unlock">
        <input type="hidden" name="token" value="<%= token %>">
        <button class="btn btn-gold" <%= player.gold < price ? 'disabled' : '' %>>
          Unlock — <%= price.toLocaleString() %>g
        </button>
        <% if (player.gold < price) { %><p class="err">Need <%= (price - player.gold).toLocaleString() %> more gold.</p><% } %>
      </form>
    </div>
  <% } else { %>
    <div class="card">
      <div class="avatars" style="justify-content:center">
        <canvas id="preview" width="120" height="120" class="px" aria-label="live preview"></canvas>
      </div>
      <canvas id="wheel" width="220" height="220" style="display:block;margin:12px auto;cursor:crosshair"></canvas>
      <form method="post" action="/shop/color" id="colorForm" style="text-align:center">
        <input type="hidden" name="token" value="<%= token %>">
        <input type="hidden" name="hue" id="hue" value="<%= currentHue == null ? 0 : currentHue %>">
        <button class="btn btn-gold">Save color</button>
      </form>
    </div>
    <script>
      window.__SHOP__ = {
        baseSprite: "<%= baseSpriteUrl %>",
        clothing: <%- JSON.stringify(clothing) %>,
        hue: <%= currentHue == null ? 0 : currentHue %>
      };
    </script>
  <% } %>
</div>
```

- [ ] **Step 5: Create `src/web/public/shop.js`** (wheel + live client recolor preview; `hueSwap` duplicated per the project's no-import client convention):

```js
'use strict';
(function () {
  const cfg = window.__SHOP__; if (!cfg) return;
  const wheel = document.getElementById('wheel');
  const preview = document.getElementById('preview');
  const hueInput = document.getElementById('hue');
  const wctx = wheel.getContext('2d'), pctx = preview.getContext('2d');
  pctx.imageSmoothingEnabled = false;
  const R = wheel.width / 2;

  // draw the hue wheel
  for (let a = 0; a < 360; a++) {
    wctx.beginPath(); wctx.moveTo(R, R);
    wctx.arc(R, R, R - 4, (a - 0.5) * Math.PI / 180, (a + 0.5) * Math.PI / 180);
    wctx.closePath(); wctx.fillStyle = `hsl(${a},85%,55%)`; wctx.fill();
  }

  function hueSwap(r, g, b, deg) {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
    const v = max, s = max === 0 ? 0 : (max - min) / max;
    const h = (((deg % 360) + 360) % 360) / 360;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const m = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i % 6];
    return [Math.round(m[0]*255), Math.round(m[1]*255), Math.round(m[2]*255)];
  }
  const cloth = new Set(cfg.clothing.map((h) => h.replace('#', '').toLowerCase()));

  const base = new Image(); base.crossOrigin = 'anonymous'; base.src = cfg.baseSprite;
  let src = null;
  base.onload = () => {
    const off = document.createElement('canvas'); off.width = 24; off.height = 24;
    const o = off.getContext('2d'); o.imageSmoothingEnabled = false; o.drawImage(base, 0, 0, 24, 24);
    src = o.getImageData(0, 0, 24, 24);
    render(cfg.hue);
  };
  function render(deg) {
    if (!src) return;
    const img = pctx.createImageData(24, 24); const d = img.data, s = src.data;
    for (let i = 0; i < s.length; i += 4) {
      d[i] = s[i]; d[i+1] = s[i+1]; d[i+2] = s[i+2]; d[i+3] = s[i+3];
      if (s[i+3] === 0) continue;
      const hex = ((s[i]<<16)|(s[i+1]<<8)|s[i+2]).toString(16).padStart(6,'0');
      if (cloth.has(hex)) { const c = hueSwap(s[i], s[i+1], s[i+2], deg); d[i]=c[0]; d[i+1]=c[1]; d[i+2]=c[2]; }
    }
    const tmp = document.createElement('canvas'); tmp.width = 24; tmp.height = 24;
    tmp.getContext('2d').putImageData(img, 0, 0);
    pctx.clearRect(0, 0, 120, 120); pctx.drawImage(tmp, 0, 0, 120, 120);
  }
  wheel.addEventListener('click', (e) => {
    const rect = wheel.getBoundingClientRect();
    const dx = e.clientX - rect.left - R, dy = e.clientY - rect.top - R;
    const deg = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360)) % 360;
    hueInput.value = deg; render(deg);
  });
})();
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/web-shop.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/shop.ts src/web/views/shop.ejs src/web/public/shop.js tests/web-shop.test.ts
git commit -m "feat(shop): shop page, unlock/color routes, live color-wheel picker"
```

---

## Task 7: Emit cosmetic sprite URLs from the view-models

**Files:**
- Modify: `src/web/tvview.ts` (hero `avatarUrl`), `src/domain/leaderboards.ts` (avatar), `src/web/routes/character.ts` (character-sheet avatar)
- Test: `tests/tvview-cosmetics.test.ts`

**Interfaces:**
- Consumes: `getCosmetics`, `cosmeticSpriteUrl` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// tests/tvview-cosmetics.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { buildTvState } from '../src/web/tvview';

describe('tv hero avatar honors cosmetics', () => {
  it('uses the tinted URL when a hue is set', () => {
    const db = openDb(':memory:'); seedSettings(db);
    const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 2000000, effective_tokens = 5 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    const hero = buildTvState(db, 100000).players.find((x) => x.id === p.id)!;
    expect(hero.avatarUrl).toBe('/sprite/tint/wizard_M/a/210.png');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tvview-cosmetics.test.ts`
Expected: FAIL (avatarUrl is still `/sprites/creatures_24x24/...`).

- [ ] **Step 3: Wire `src/web/tvview.ts`.** Add the import:

```ts
import { getCosmetics, cosmeticSpriteUrl } from '../domain/cosmetics';
```

In `buildTvState`, replace the `avatarUrl` assignment in the `players` map:

```ts
    // was: avatarUrl: classSpriteUrl(p.class_key, p.gender as Gender),
    avatarUrl: cosmeticSpriteUrl(p.class_key, p.gender as Gender, getCosmetics(db, p.id), 'a'),
```

- [ ] **Step 4: Wire `src/domain/leaderboards.ts`.** Add import `import { getCosmetics, cosmeticSpriteUrl } from './cosmetics';` and replace each `classSpriteUrl(p.class_key, p.gender as Gender)` used for an avatar with `cosmeticSpriteUrl(p.class_key, p.gender as Gender, getCosmetics(db, p.id), 'a')`.

- [ ] **Step 5: Wire `src/web/routes/character.ts`.** Add import `import { getCosmetics, cosmeticSpriteUrl } from '../../domain/cosmetics';` and in the `/character` render replace `avatarUrl: classSpriteUrl(player.class_key, player.gender as Gender)` with `avatarUrl: cosmeticSpriteUrl(player.class_key, player.gender as Gender, getCosmetics(db, player.id), 'a')`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/tvview-cosmetics.test.ts tests/tvview-state.test.ts tests/leaderboards.test.ts`
Expected: PASS (existing tests still green — plain sprite URL when no hue is set).

- [ ] **Step 7: Commit**

```bash
git add src/web/tvview.ts src/domain/leaderboards.ts src/web/routes/character.ts tests/tvview-cosmetics.test.ts
git commit -m "feat(shop): view-models emit tinted sprite URLs when a hue is set"
```

---

## Task 8: TV frame-B partner for tint URLs + character-sheet Shop link

**Files:**
- Modify: `src/web/public/tv/tv.js` (`partnerUrl`)
- Modify: `src/web/views/character-sheet.ejs` (Shop nav link)

**Interfaces:**
- Consumes: tinted URLs of the form `/sprite/tint/<sprite>/a/<hue>.png` from Task 7.

- [ ] **Step 1: Update `partnerUrl` in `src/web/public/tv/tv.js`.** Replace the function with:

```js
// The frame-B partner URL for a frame-A creature sprite URL. Tint URLs carry the
// frame in the path (/a/ -> /b/); plain sheet sprites use the +18 file-index rule.
function partnerUrl(url) {
  if (url.indexOf('/sprite/tint/') === 0 || url.indexOf('/sprite/tint/') !== -1) {
    return url.replace('/a/', '/b/');
  }
  return url.replace(/_(\d+)\.png$/, (_m, n) =>
    '_' + String(Number(n) + ANIM_ROW).padStart(2, '0') + '.png');
}
```

- [ ] **Step 2: Manually verify the TV animates a tinted hero.** With the dev server running and a player who has set a hue, load `/tv`: the hero's clothing shows the chosen color and still A/B animates (no flicker to a wrong frame). Note: this is a visual check — see the run/verify step below.

- [ ] **Step 3: Add a Shop link to `src/web/views/character-sheet.ejs`.** In the page's nav/action area (next to the existing links), add:

```html
<a class="btn btn-gold" href="/shop?token=<%= player.auth_token %>">🎨 Shop</a>
```

- [ ] **Step 4: Commit**

```bash
git add src/web/public/tv/tv.js src/web/views/character-sheet.ejs
git commit -m "feat(shop): TV tint frame-B partner + character-sheet Shop link"
```

---

## Task 9: Full verification + deploy

- [ ] **Step 1: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green, no type errors.

- [ ] **Step 2: Drive it end-to-end locally** (use the `verify`/`run` project flow): start the server, open `/shop?token=<a real token>`, unlock the wheel (gold drops), pick a color on the wheel (preview recolors live), Save, then confirm the character sheet avatar, `/tv` battlefield sprite, and a leaderboard avatar all show the new color, and `/sprite/tint/<sprite>/a/<hue>.png` returns the recolored PNG.

- [ ] **Step 3: Commit any fixes, then ship** via the normal path (push to `main`; the Pi auto-updater deploys at the next idle lull and runs `npm ci` because the lockfile changed for `pngjs`).

---

## Self-Review (completed at authoring)

- **Spec coverage:** data model → T1; clothing map → T2; tint core → T3; purchase/setHue/price/url → T4; tint route+cache → T5; shop page+picker → T6; surfaces → T7/T8; testing → each task; rollout → T9. All spec sections map to a task.
- **Placeholders:** the only intentional fill-in is the 7 unverified `CLOTHING.dominant` arrays in T2, which are an explicit authoring deliverable gated by a coverage test (knight/wizard/berserker pre-filled) — not a leave-blank.
- **Type consistency:** `CosmeticState`, `PurchaseResult`, `SetHueResult`, `cosmeticSpriteUrl(classKey, gender, cos, frame)`, `spriteId`, `spriteFileIndex` are used identically across T4→T7. Tint URL shape `/sprite/tint/<sprite>/<frame>/<hue>.png` is consistent across T5 (route), T4 (`cosmeticSpriteUrl`), and T8 (`partnerUrl`).

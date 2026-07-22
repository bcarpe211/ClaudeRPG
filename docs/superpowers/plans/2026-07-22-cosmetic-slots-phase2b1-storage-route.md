# Cosmetic Slot System — Phase 2B.1: per-slot storage + skin render + route

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-slot colours *stored and rendered*. A player can have a distinct recolor rule per slot (body, headgear/wings, cape, boots, weapon, trim…); the server renders the full config through the 2A slot-maps and serves it at a content-hashed URL. This is the backend that the Phase-2B.2 per-slot UI drives.

**Architecture:** A child table `player_slot_cosmetics` holds one rule per (player, slot). A DAO builds a player's full `Map<slot, SlotRule>` (falling back to the legacy single body colour in `player_cosmetics.primary_hue` for backward compatibility). A stable content hash of that config drives a cache-busting URL `GET /sprite/skin/:playerId/:frame/:hash.png`; the route reads the player's current config, renders it via 2A's `recolorSpriteSlots`, and disk-caches by the config hash. View-models point at that URL when the player has any cosmetics.

**Scope boundary (2B.2, not here):** the character-page per-slot picker, the presence-matrix UI, black/white/steel finish *presets in the UI*, the picker relocation, and the closed-shop/mimic state. 2B.1 is server-only — per-slot rules are settable via the DAO (the UI wires them in 2B.2), and the render already supports `hue`/`colorize`/`value` per slot.

**Tech Stack:** TypeScript (ESM via tsx), better-sqlite3, express (+ `asyncHandler`), pngjs, vitest + supertest.

**Depends on:** Phase 2A (`src/domain/slots.ts` `loadSlotmap`, `src/domain/spritetint.ts` `recolorSpriteSlots` + `SlotRule`, the authored `slotmaps/*.png`, `src/domain/cosmetics.ts` `spriteId`/`spriteFileIndex`/`getCosmetics`/`CLOTHING`).

## Global Constraints

- Node 26 + better-sqlite3, ESM via tsx (no build step); relative imports use **no file extensions**.
- Every async Express handler wrapped in `asyncHandler` (`src/web/async`). `Date.now()` is allowed in the web layer; domain fns take `now` as a param.
- Migrations are appended to the ordered `migrations` array in `src/db/migrations.ts` as `{ id, sql }`.
- Skin cache lives beside the DB (`${dirname(dbPath)}/tint-cache/`), same dir the 2A tint route uses; cache filenames are `skin_<playerId>_<frame>_<hash>.png`.
- `SlotRule` = `{ op: 'hue'|'colorize'|'value'; hue?; sat?; lo?; hi? }` (from 2A).
- Test commands: `npm test`, `npm run typecheck`.
- **Locked decisions:** storage = child table `player_slot_cosmetics`; controls stored as `op`+params (defer `strength`); cache = `player+frame+content-hash` URL; 12-slot taxonomy; slot-maps from 2A.

## File structure (Phase 2B.1)
- Modify `src/db/migrations.ts` — append `008_player_slot_cosmetics`.
- Create `src/domain/slotcosmetics.ts` — `getSlotConfig`, `setSlotRule`, `clearSlot`, `slotConfigHash`, `cosmeticSkinUrl`.
- Modify `src/web/routes/shop.ts` — add `GET /sprite/skin/:playerId/:frame/:hash.png`.
- Modify `src/web/tvview.ts`, `src/domain/leaderboards.ts`, `src/web/routes/character.ts` — emit the skin URL.
- Modify `src/web/public/tv/tv.js` — `partnerUrl` handles `/sprite/` (skin + tint).
- Tests: `tests/db-slotcosmetics-migration.test.ts`, `tests/slotcosmetics.test.ts`, `tests/web-skin.test.ts`, `tests/tvview-cosmetics.test.ts` (extend).

---

### Task 1: Migration 008 — `player_slot_cosmetics`

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `tests/db-slotcosmetics-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db-slotcosmetics-migration.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('008_player_slot_cosmetics migration', () => {
  it('creates player_slot_cosmetics with the expected columns', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("PRAGMA table_info(player_slot_cosmetics)").all() as any[]).map((c) => c.name);
    expect(cols).toEqual(['player_id', 'slot', 'op', 'hue', 'sat', 'lo', 'hi', 'updated_at']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npm test -- slotcosmetics-migration`; empty columns).

- [ ] **Step 3: Append the migration** (last element of the `migrations` array):

```ts
  {
    id: '008_player_slot_cosmetics',
    sql: `
      CREATE TABLE player_slot_cosmetics (
        player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        slot       INTEGER NOT NULL,
        op         TEXT NOT NULL,       -- 'hue' | 'colorize' | 'value'
        hue        INTEGER,             -- 'hue', 'colorize'
        sat        REAL,                -- 'colorize'
        lo         REAL,                -- 'value'
        hi         REAL,                -- 'value'
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, slot)
      );
    `,
  },
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/db/migrations.ts tests/db-slotcosmetics-migration.test.ts && git commit -m "feat(slots): player_slot_cosmetics migration"`

---

### Task 2: Slot-config DAO

**Files:**
- Create: `src/domain/slotcosmetics.ts`
- Test: `tests/slotcosmetics.test.ts`

**Interfaces:**
- Consumes: `SlotRule` (spritetint), `SLOTS` (slots), `getCosmetics`/`CLOTHING` (cosmetics).
- Produces:
  - `getSlotConfig(db, playerId): Map<number, SlotRule>` — per-slot rows; if no body(1) row but the legacy `player_cosmetics.primary_hue` is set, synthesize a body rule from the class's op.
  - `setSlotRule(db, playerId, slot, rule: SlotRule, now): void` (upsert).
  - `clearSlot(db, playerId, slot): void`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/slotcosmetics.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { SLOTS } from '../src/domain/slots';
import { getSlotConfig, setSlotRule, clearSlot } from '../src/domain/slotcosmetics';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });
function player(cls = 'wizard') {
  const p = createPlayer(db, { name: 'A', class_key: cls, gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
  return p;
}

describe('getSlotConfig', () => {
  it('is empty for a fresh player', () => {
    expect(getSlotConfig(db, player().id).size).toBe(0);
  });
  it('falls back to the legacy body hue from player_cosmetics', () => {
    const p = player('wizard'); // wizard op = hue
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    const cfg = getSlotConfig(db, p.id);
    expect(cfg.get(SLOTS.body)).toEqual({ op: 'hue', hue: 210 });
  });
  it('per-slot rows win over the legacy body hue, and add other slots', () => {
    const p = player();
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 40 }, 300);
    setSlotRule(db, p.id, SLOTS.weapon, { op: 'value', lo: 0, hi: 0.3 }, 300);
    const cfg = getSlotConfig(db, p.id);
    expect(cfg.get(SLOTS.body)).toEqual({ op: 'hue', hue: 40 });          // row wins over legacy 210
    expect(cfg.get(SLOTS.weapon)).toEqual({ op: 'value', lo: 0, hi: 0.3 });
  });
  it('clearSlot removes a slot', () => {
    const p = player();
    setSlotRule(db, p.id, SLOTS.cape, { op: 'hue', hue: 90 }, 300);
    clearSlot(db, p.id, SLOTS.cape);
    expect(getSlotConfig(db, p.id).has(SLOTS.cape)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `src/domain/slotcosmetics.ts`**

```ts
import type Database from 'better-sqlite3';
import type { SlotRule } from './spritetint';
import { SLOTS } from './slots';
import { getCosmetics, CLOTHING } from './cosmetics';

interface Row { slot: number; op: string; hue: number | null; sat: number | null; lo: number | null; hi: number | null }
const clean = (r: Row): SlotRule => ({
  op: r.op as SlotRule['op'],
  ...(r.hue != null ? { hue: r.hue } : {}), ...(r.sat != null ? { sat: r.sat } : {}),
  ...(r.lo != null ? { lo: r.lo } : {}), ...(r.hi != null ? { hi: r.hi } : {}),
});

/** A player's full per-slot recolor config. Body falls back to the legacy player_cosmetics.primary_hue. */
export function getSlotConfig(db: Database.Database, playerId: number): Map<number, SlotRule> {
  const map = new Map<number, SlotRule>();
  for (const r of db.prepare(
    'SELECT slot, op, hue, sat, lo, hi FROM player_slot_cosmetics WHERE player_id = ?',
  ).all(playerId) as Row[]) map.set(r.slot, clean(r));

  if (!map.has(SLOTS.body)) {
    const p = db.prepare('SELECT class_key FROM players WHERE id = ?').get(playerId) as { class_key: string } | undefined;
    const cos = getCosmetics(db, playerId);
    if (p && cos && cos.primary_hue != null) {
      const c = CLOTHING[p.class_key];
      map.set(SLOTS.body, c?.op === 'colorize'
        ? { op: 'colorize', hue: cos.primary_hue, sat: c.sat ?? 0.6 }
        : { op: 'hue', hue: cos.primary_hue });
    }
  }
  return map;
}

export function setSlotRule(db: Database.Database, playerId: number, slot: number, rule: SlotRule, now: number): void {
  db.prepare(
    `INSERT INTO player_slot_cosmetics (player_id, slot, op, hue, sat, lo, hi, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, slot) DO UPDATE SET
       op = excluded.op, hue = excluded.hue, sat = excluded.sat,
       lo = excluded.lo, hi = excluded.hi, updated_at = excluded.updated_at`,
  ).run(playerId, slot, rule.op, rule.hue ?? null, rule.sat ?? null, rule.lo ?? null, rule.hi ?? null, now);
}

export function clearSlot(db: Database.Database, playerId: number, slot: number): void {
  db.prepare('DELETE FROM player_slot_cosmetics WHERE player_id = ? AND slot = ?').run(playerId, slot);
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/domain/slotcosmetics.ts tests/slotcosmetics.test.ts && git commit -m "feat(slots): per-slot cosmetics DAO (get/set/clear + legacy body fallback)"`

---

### Task 3: `slotConfigHash` + `cosmeticSkinUrl`

**Files:**
- Modify: `src/domain/slotcosmetics.ts`
- Test: `tests/slotcosmetics.test.ts` (append)

**Interfaces:**
- Produces: `slotConfigHash(config: Map<number, SlotRule>): string` (stable 8-hex FNV-1a, order-independent), `cosmeticSkinUrl(playerId, classKey, gender, config, frame='a'): string` (skin URL when non-empty, else the plain class sprite).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/slotcosmetics.test.ts
import { slotConfigHash, cosmeticSkinUrl } from '../src/domain/slotcosmetics';
import { classSpriteUrl } from '../src/domain/classes';

describe('slotConfigHash + cosmeticSkinUrl', () => {
  it('hash is stable and order-independent, changes with the config', () => {
    const a = new Map([[1, { op: 'hue' as const, hue: 10 }], [7, { op: 'value' as const, lo: 0, hi: 0.3 }]]);
    const b = new Map([[7, { op: 'value' as const, lo: 0, hi: 0.3 }], [1, { op: 'hue' as const, hue: 10 }]]);
    const c = new Map([[1, { op: 'hue' as const, hue: 11 }]]);
    expect(slotConfigHash(a)).toBe(slotConfigHash(b)); // order-independent
    expect(slotConfigHash(a)).not.toBe(slotConfigHash(c));
    expect(slotConfigHash(a)).toMatch(/^[0-9a-f]{8}$/);
  });
  it('cosmeticSkinUrl: plain sprite when empty, skin URL otherwise', () => {
    const empty = new Map();
    expect(cosmeticSkinUrl(5, 'wizard', 'M', empty)).toBe(classSpriteUrl('wizard', 'M'));
    const cfg = new Map([[1, { op: 'hue' as const, hue: 210 }]]);
    expect(cosmeticSkinUrl(5, 'wizard', 'M', cfg, 'a')).toBe(`/sprite/skin/5/a/${slotConfigHash(cfg)}.png`);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (functions not exported).

- [ ] **Step 3: Implement** — append to `src/domain/slotcosmetics.ts`:

```ts
import { classSpriteUrl, type Gender } from './classes';

/** Stable 8-hex content hash of a slot config (order-independent). Cache-bust token for the skin URL. */
export function slotConfigHash(config: Map<number, SlotRule>): string {
  const s = [...config.entries()].sort((a, b) => a[0] - b[0])
    .map(([slot, r]) => `${slot}:${r.op}:${r.hue ?? ''}:${r.sat ?? ''}:${r.lo ?? ''}:${r.hi ?? ''}`).join('|');
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Sprite URL for a character: the hashed skin URL when they have any cosmetics, else the plain sprite. */
export function cosmeticSkinUrl(
  playerId: number, classKey: string, gender: Gender, config: Map<number, SlotRule>, frame: 'a' | 'b' = 'a',
): string {
  if (config.size === 0) return classSpriteUrl(classKey, gender);
  return `/sprite/skin/${playerId}/${frame}/${slotConfigHash(config)}.png`;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/domain/slotcosmetics.ts tests/slotcosmetics.test.ts && git commit -m "feat(slots): slotConfigHash + cosmeticSkinUrl"`

---

### Task 4: `GET /sprite/skin/:playerId/:frame/:hash.png`

**Files:**
- Modify: `src/web/routes/shop.ts`
- Test: `tests/web-skin.test.ts`

**Interfaces:**
- Consumes: `getPlayerById` (players); `getSlotConfig`/`slotConfigHash` (slotcosmetics); `loadSlotmap` (slots); `recolorSpriteSlots` (spritetint); `spriteId`/`spriteFileIndex` (cosmetics); `creatureSpriteFile` (classes); `config.spritesDir`/`config.dbPath`.
- Behaviour: read the player's current slot config, render via the slot-map, cache by `skin_<id>_<frame>_<hash>.png`. Unknown player ⇒ 404; no slot-map (female) ⇒ plain sprite (unchanged) for now.

- [ ] **Step 1: Write the failing test**

```ts
// tests/web-skin.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';
import { SLOTS } from '../src/domain/slots';
import { setSlotRule, slotConfigHash, getSlotConfig } from '../src/domain/slotcosmetics';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { creatureSpriteFile } from '../src/domain/classes';

function ctx() {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  return { db, app, p };
}

describe('GET /sprite/skin', () => {
  it('404s an unknown player', async () => {
    const { app } = ctx();
    expect((await request(app).get('/sprite/skin/99999/a/deadbeef.png')).status).toBe(404);
  });
  it('renders the player per-slot config: body recolors, weapon slot stays', async () => {
    const { db, app, p } = ctx();
    setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 120 }, 100); // green robe
    const hash = slotConfigHash(getSlotConfig(db, p.id));
    const res = await request(app).get(`/sprite/skin/${p.id}/a/${hash}.png`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    const out = PNG.sync.read(res.body);
    const base = PNG.sync.read(readFileSync(
      `assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'M', 'a'))}`));
    // an eye pixel (#cf3232 in the hood, weapon/flair slot) stays unchanged
    let checkedEye = false;
    for (let y = 8; y <= 11; y++) for (let x = 8; x <= 13; x++) {
      const i = (y * 24 + x) * 4;
      if (base.data[i] === 0xcf && base.data[i + 1] === 0x32 && base.data[i + 2] === 0x32) {
        expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([0xcf, 0x32, 0x32]);
        checkedEye = true;
      }
    }
    expect(checkedEye).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (route 404s the valid case too / not registered).

- [ ] **Step 3: Implement** — in `src/web/routes/shop.ts`, add imports:

```ts
import { getPlayerById } from '../../domain/players';   // (add to the existing players import if separate)
import { getSlotConfig, slotConfigHash } from '../../domain/slotcosmetics';
import { spriteId, spriteFileIndex } from '../../domain/cosmetics'; // spriteId/spriteFileIndex already imported — extend as needed
```

and register inside `registerShopRoutes`, next to the tint route:

```ts
  app.get('/sprite/skin/:playerId/:frame/:hash.png', asyncHandler(async (req, res) => {
    const playerId = Number(req.params.playerId);
    const frame = req.params.frame === 'b' ? 'b' : 'a';
    if (!Number.isInteger(playerId)) { res.sendStatus(400); return; }
    const player = getPlayerById(db, playerId);
    if (!player) { res.sendStatus(404); return; }

    const slotConfig = getSlotConfig(db, playerId);
    const hash = slotConfigHash(slotConfig);
    res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable');
    const cacheFile = path.join(cacheDir, `skin_${playerId}_${frame}_${hash}.png`);
    if (fs.existsSync(cacheFile)) { res.sendFile(path.resolve(cacheFile)); return; }

    const srcFile = path.resolve(
      config.spritesDir, 'creatures_24x24',
      creatureSpriteFile(spriteFileIndex(player.class_key, player.gender as Gender, frame)),
    );
    const src = fs.readFileSync(srcFile);
    const slotIds = loadSlotmap(spriteId(player.class_key, player.gender as Gender), frame);
    const out = slotIds ? recolorSpriteSlots(src, slotIds, slotConfig) : src; // no slot-map (female) → plain
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));
```

> The slot config Map is named `slotConfig` to avoid colliding with the AppDeps `config` (used for `config.spritesDir`/`config.dbPath` and `cacheDir`), which the handler already has in scope.

- [ ] **Step 4: Run tests + typecheck** `rm -rf data/tint-cache && npm test -- web-skin && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `git add src/web/routes/shop.ts tests/web-skin.test.ts && git commit -m "feat(slots): /sprite/skin route renders a player's per-slot config"`

---

### Task 5: Emit the skin URL from view-models + TV partner

**Files:**
- Modify: `src/web/tvview.ts`, `src/domain/leaderboards.ts`, `src/web/routes/character.ts`, `src/web/public/tv/tv.js`
- Test: `tests/tvview-cosmetics.test.ts` (extend)

**Interfaces:**
- Consumes: `getSlotConfig`, `cosmeticSkinUrl` (slotcosmetics).
- Replaces the 2A `cosmeticSpriteUrl(...)` calls with `cosmeticSkinUrl(p.id, p.class_key, p.gender, getSlotConfig(db, p.id), 'a')`. When a player has no cosmetics, `cosmeticSkinUrl` returns the plain sprite (existing tests stay green).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/tvview-cosmetics.test.ts
import { setSlotRule, slotConfigHash, getSlotConfig } from '../src/domain/slotcosmetics';
import { SLOTS } from '../src/domain/slots';

it('tv hero avatar uses the per-slot skin URL when the player has slot cosmetics', () => {
  const db = openDb(':memory:'); seedSettings(db);
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET effective_tokens = 5 WHERE id = ?').run(p.id);
  setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 200 }, 100);
  const hero = buildTvState(db, 100000).players.find((x) => x.id === p.id)!;
  expect(hero.avatarUrl).toBe(`/sprite/skin/${p.id}/a/${slotConfigHash(getSlotConfig(db, p.id))}.png`);
});
```

- [ ] **Step 2: Run — expect FAIL** (avatarUrl still `/sprite/tint/...`).

- [ ] **Step 3: Implement**
- `src/web/tvview.ts`: replace the import `import { getCosmetics, cosmeticSpriteUrl } from '../domain/cosmetics';` and the `avatarUrl` assignment with:
  ```ts
  import { getSlotConfig, cosmeticSkinUrl } from '../domain/slotcosmetics';
  // avatarUrl:
  avatarUrl: cosmeticSkinUrl(p.id, p.class_key, p.gender as Gender, getSlotConfig(db, p.id), 'a'),
  ```
- `src/domain/leaderboards.ts`: same swap in the `rank()` helper —
  `avatarUrl: cosmeticSkinUrl(p.id, p.class_key, p.gender as Gender, getSlotConfig(db, p.id), 'a')`.
- `src/web/routes/character.ts`: same swap for the `/character` render's `avatarUrl` (player row has `id`).
- `src/web/public/tv/tv.js`: generalize `partnerUrl` so both skin and tint URLs get the `/b/` frame —
  ```js
  function partnerUrl(url) {
    if (url.startsWith('/sprite/')) return url.replace('/a/', '/b/');
    return url.replace(/_(\d+)\.png$/, (_m, n) =>
      '_' + String(Number(n) + ANIM_ROW).padStart(2, '0') + '.png');
  }
  ```

- [ ] **Step 4: Run** `rm -rf data/tint-cache && npm test && npm run typecheck` — all green (players with no cosmetics still get the plain sprite, so `tvview-state`/`leaderboards` stay green).
- [ ] **Step 5: Commit** `git add src/web/tvview.ts src/domain/leaderboards.ts src/web/routes/character.ts src/web/public/tv/tv.js tests/tvview-cosmetics.test.ts && git commit -m "feat(slots): view-models emit the per-slot skin URL"`

---

### Task 6: Full verification

- [ ] **Step 1:** `rm -rf data/tint-cache && npm test && npm run typecheck` — all green.
- [ ] **Step 2:** Drive it live (fresh isolated DB/cache): start the server, create a wizard, and via a `node -e` one-liner (or the future 2B.2 UI) `setSlotRule(body, hue 200)` and `setSlotRule(weapon, value lo0 hi0.3)`; request `/sprite/skin/<id>/a/<hash>.png` (hash from `slotConfigHash(getSlotConfig(...))`) and eyeball: the robe is blue, the staff/eyes unchanged. Confirm a no-cosmetics player's TV avatar is the plain sprite.
- [ ] **Step 3:** Commit any fixes. The per-slot UI, finishes, picker relocation, and closed-shop state are **Phase 2B.2**. `/sprite/tint` (2A single-hue) still exists for the current shop preview; 2B.2 retires it.

---

## Self-Review (Phase 2B.1)
- **Spec coverage:** storage (Task 1), DAO + legacy fallback (Task 2), hash + URL (Task 3), skin route (Task 4), view-model wiring + TV partner (Task 5), verification (Task 6). The UI/finishes/relocation/closed-shop are explicitly deferred to 2B.2. ✓
- **Placeholders:** none — the slot config Map is named `slotConfig` to avoid the AppDeps `config` collision; every code step shows complete code + expected result. ✓
- **Type consistency:** `SlotRule` (2A) is the stored/rendered shape throughout; `getSlotConfig`/`setSlotRule`/`clearSlot`/`slotConfigHash`/`cosmeticSkinUrl` defined in Tasks 2–3 and consumed in Tasks 4–5; the skin URL shape `/sprite/skin/<id>/<frame>/<hash>.png` is consistent across `cosmeticSkinUrl`, the route, and `partnerUrl`. ✓
- **Backward compatibility:** no data migration — `getSlotConfig` synthesizes the body slot from the legacy `player_cosmetics.primary_hue`; players without cosmetics get the plain sprite; `/sprite/tint` untouched. ✓

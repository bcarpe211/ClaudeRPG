# Cosmetic Slot System — Phase 2B.2: per-slot dye picker UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give players an interactive, per-slot dye picker on their character page — pick any part of the sprite (clothing, cape, weapon, eyes, skin, …) and paint it any colour or apply a black/white/steel finish, with a live preview that saves automatically. Relocate the recolor tool off `/shop` (which becomes a "closed bazaar" mimic gag) onto the character page, driving the Phase-2B.1 per-slot backend.

**Architecture:** The 2B.1 backend already stores one `SlotRule` per (player, slot) and renders the composite at `/sprite/skin/:id/:frame/:hash.png`. This phase adds: (1) a `presentSlots(sprite)` helper that reads the 2A slot-map to list the channels a given sprite actually has; (2) a small `dye` domain module holding the wheel/finish rule shapes + a `dyeViewModel`; (3) three thin character-page endpoints (`unlock`, `set`, `clear`); (4) a client picker (`dye.js`) that live-previews edits by mirroring the three colour ops over the embedded slot-map and persists each change via `fetch`; (5) a "closed" `/shop`. The wheel paints with **colorize** (chosen by the user: works on white/grey/metal too), and **every present slot** is exposed (including eyes/skin).

**Tech Stack:** TypeScript (ESM via tsx), better-sqlite3, express (+ `asyncHandler`, Zod), ejs, Canvas 2D (client), vitest + supertest.

**Depends on:** Phase 2B.1 (`src/domain/slotcosmetics.ts` `getSlotConfig`/`setSlotRule`/`clearSlot`, the `/sprite/skin` route, `cosmeticSkinUrl`), Phase 2A (`src/domain/slots.ts` `loadSlotmap`/`SLOTS`, `src/domain/spritetint.ts` `SlotRule`), and `src/domain/cosmetics.ts` (`spriteId`, `getCosmetics`, `CLOTHING`), `src/domain/shop.ts` (`purchase`, `SKUS`), `src/domain/bestiary.ts` (Mimic = creature index 198).

## Global Constraints

- Node 26 + better-sqlite3, ESM via tsx (no build step); relative imports use **no file extensions**.
- Every async Express handler wrapped in `asyncHandler`. `Date.now()` allowed in the web layer; domain fns take `now` as a param.
- The wheel paints via **colorize** at `WHEEL_SAT = 0.6` (universal — recolors white/grey/metal, keeps each pixel's brightness ramp). Finishes: `black = value 0→0.32`, `white = value 0.74→1`, `steel = colorize hue 212 sat 0.13`. These exact values are the single source of truth: defined once in `src/domain/dye.ts` and embedded into the page for the client, never re-typed as literals in `dye.js`.
- Every present slot except `outline (0)` is dye-able (includes `skin (10)` and `flair`/eyes `(11)`).
- Client colour ops in `dye.js` MUST mirror `src/domain/spritetint.ts` (`colorize`, `valueRemap`, `hueSwap`) exactly, with a `// mirrors src/domain/spritetint.ts` comment (same precedent as `tv.js`).
- Picker persistence uses `application/x-www-form-urlencoded` (the app already mounts `express.urlencoded`); do NOT add `express.json()`.
- Dye endpoints live under `/character/dye/*` and require the player's wheel to be unlocked (`player_cosmetics.wheel_tier >= 1`).
- A sprite without an authored slot-map cannot buy or use the picker. This keeps Phase 2C female
  characters from spending gold on a feature that cannot render yet; the character page shows a
  clear "tailoring in progress" state instead.
- "Restore default" must make the selected slot genuinely absent from `getSlotConfig`. Clearing
  `body` therefore also clears the legacy `player_cosmetics.primary_hue` fallback.
- The wheel is deliberately low-resolution and nearest-neighbor upscaled, with stepped color cells
  instead of the old 360 smooth wedges. This is the signature pixel-art control and avoids the
  browser banding seen in the Phase-1 review.
- Autosave debounce state is per slot, so changing channels quickly cannot cancel another slot's save.
- `SlotRule` = `{ op: 'hue'|'colorize'|'value'; hue?; sat?; lo?; hi? }` (from 2A).
- Test commands: `npm test`, `npm run typecheck`. Skin cache lives at `${dirname(dbPath)}/tint-cache/`; clear it before render checks: `rm -rf data/tint-cache`.
- **Out of scope (leave as-is):** the `/sprite/tint` route and `setCosmeticHue`/`cosmeticSpriteUrl` domain fns stay for backward-compat (the legacy `primary_hue` still feeds `getSlotConfig`'s body fallback); `tests/shop.test.ts` (domain purchase/hue) stays green untouched. Female slot-maps are Phase 2C.

## File structure (Phase 2B.2)
- Modify `src/domain/slots.ts` — add `SLOT_LABELS`, `PICKER_ORDER`, `presentSlots(sprite)`.
- Create `src/domain/dye.ts` — `WHEEL_SAT`, `wheelRule`, `FINISHES`, `dyeRule`, `DyeViewModel`, `dyeViewModel`.
- Modify `src/domain/slotcosmetics.ts` — make clearing `body` clear the legacy hue fallback too.
- Modify `src/web/routes/character.ts` — pass `dye` view-model to the render; add `POST /character/dye/unlock|set|clear`.
- Modify `src/web/views/character-sheet.ejs` — add the Wardrobe panel (unlock gate OR picker); remove the "Visit the Shop" button.
- Create `src/web/public/dye.js` — the client picker (wheel, channels, finishes, live preview, autosave).
- Modify `src/web/public/dungeon.css` — add the `.dye-*` component block.
- Rewrite `src/web/routes/shop.ts` — `/shop` → closed mimic state; remove `/shop/unlock` + `/shop/color` + `priceOf`; keep `/sprite/tint` and `/sprite/skin`.
- Rewrite `src/web/views/shop.ejs` — the closed bazaar.
- Delete `src/web/public/shop.js` (retired).
- Tests: create `tests/slots-present.test.ts`, `tests/dye.test.ts`, `tests/web-dye.test.ts`; rewrite `tests/web-shop.test.ts`.

---

### Task 1: `presentSlots` + slot labels

**Files:**
- Modify: `src/domain/slots.ts`
- Test: `tests/slots-present.test.ts`

**Interfaces:**
- Produces: `SLOT_LABELS: Record<number,string>`, `PICKER_ORDER: number[]` (all 11 non-outline slots, display order), `presentSlots(sprite: string): number[]` (distinct non-outline slot ids present in the sprite's frame-A map, ordered by `PICKER_ORDER`; `[]` when no map).

- [ ] **Step 1: Write the failing test**

```ts
// tests/slots-present.test.ts
import { describe, it, expect } from 'vitest';
import { presentSlots, SLOTS, PICKER_ORDER } from '../src/domain/slots';

describe('presentSlots', () => {
  it('lists the wizard_M slots present in the map, outline excluded, in PICKER_ORDER', () => {
    const got = presentSlots('wizard_M');
    expect(got.length).toBeGreaterThan(0);
    expect(got).toContain(SLOTS.body);
    expect(got).not.toContain(SLOTS.outline);
    const idx = got.map((s) => PICKER_ORDER.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);            // every result is a known picker slot
    expect(idx).toEqual([...idx].sort((a, b) => a - b));    // returned in PICKER_ORDER
  });
  it('is empty for a sprite with no authored slot-map', () => {
    expect(presentSlots('nope_M')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npm test -- slots-present`; `presentSlots` not exported).

- [ ] **Step 3: Append to `src/domain/slots.ts`** (after `loadSlotmap`):

```ts
/** Friendly picker labels per slot. */
export const SLOT_LABELS: Record<number, string> = {
  [SLOTS.body]: 'Clothing', [SLOTS.headgear]: 'Headgear', [SLOTS.hair]: 'Hair',
  [SLOTS.facePaint]: 'Face paint', [SLOTS.cape]: 'Cape', [SLOTS.trim]: 'Trim',
  [SLOTS.weapon]: 'Weapon', [SLOTS.shield]: 'Shield', [SLOTS.boots]: 'Boots',
  [SLOTS.skin]: 'Skin', [SLOTS.flair]: 'Eyes',
};

/** Display order for the dye picker — all 11 recolorable slots (outline 0 excluded). */
export const PICKER_ORDER: number[] = [
  SLOTS.body, SLOTS.trim, SLOTS.cape, SLOTS.headgear, SLOTS.hair,
  SLOTS.boots, SLOTS.weapon, SLOTS.shield, SLOTS.facePaint, SLOTS.flair, SLOTS.skin,
];

/** Distinct recolorable slots present in a sprite's frame-A map (outline excluded), in PICKER_ORDER. */
export function presentSlots(sprite: string): number[] {
  const ids = loadSlotmap(sprite, 'a');
  if (!ids) return [];
  const seen = new Set<number>();
  for (const s of ids) if (s !== SLOTS.outline) seen.add(s);
  return PICKER_ORDER.filter((s) => seen.has(s));
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/domain/slots.ts tests/slots-present.test.ts && git commit -m "feat(slots): presentSlots + slot labels for the dye picker"`

---

### Task 2: `dye` domain module (rule shapes + view-model)

**Files:**
- Create: `src/domain/dye.ts`
- Test: `tests/dye.test.ts`

**Interfaces:**
- Consumes: `SlotRule` (spritetint); `presentSlots`/`SLOT_LABELS`/`loadSlotmap` (slots); `spriteId`/`getCosmetics` (cosmetics); `classSpriteUrl`/`Gender` (classes); `getSlotConfig` (slotcosmetics); `getSetting` (settings); `SKUS` (shop).
- Produces:
  - `WHEEL_SAT: number` (0.6), `wheelRule(hue): SlotRule` (`{op:'colorize',hue,sat:WHEEL_SAT}`).
  - `FINISHES: Record<'black'|'white'|'steel', SlotRule>`.
  - `dyeRule(finish: string, hue: number | null): SlotRule | null` — `'wheel'`→`wheelRule(hue)` (null if no hue), a finish name→`FINISHES[name]`, anything else→null.
  - `DyeViewModel` + `dyeViewModel(db, {id,class_key,gender}): DyeViewModel`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dye.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase } from '../src/domain/shop';
import { SLOTS } from '../src/domain/slots';
import { setSlotRule } from '../src/domain/slotcosmetics';
import { wheelRule, FINISHES, dyeRule, dyeViewModel, WHEEL_SAT } from '../src/domain/dye';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });
function wiz() {
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
  return p;
}

describe('dye rules', () => {
  it('wheelRule paints via colorize at WHEEL_SAT', () => {
    expect(wheelRule(200)).toEqual({ op: 'colorize', hue: 200, sat: WHEEL_SAT });
  });
  it('dyeRule maps picker intent to a stored rule', () => {
    expect(dyeRule('wheel', 200)).toEqual(wheelRule(200));
    expect(dyeRule('steel', null)).toEqual(FINISHES.steel);
    expect(dyeRule('wheel', null)).toBeNull();   // wheel needs a hue
    expect(dyeRule('bogus', 10)).toBeNull();
  });
});

describe('dyeViewModel', () => {
  it('reports locked + present channels + a full slotmap for a fresh wizard', () => {
    const p = wiz();
    const vm = dyeViewModel(db, { id: p.id, class_key: 'wizard', gender: 'M' });
    expect(vm.unlocked).toBe(false);
    expect(vm.price).toBeGreaterThan(0);
    expect(vm.channels.some((c) => c.slot === SLOTS.body)).toBe(true);
    expect(vm.slotmap.length).toBe(576);   // 24×24
  });
  it('reflects unlock + a saved slot rule in config', () => {
    const p = wiz();
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setSlotRule(db, p.id, SLOTS.body, wheelRule(120), 200);
    const vm = dyeViewModel(db, { id: p.id, class_key: 'wizard', gender: 'M' });
    expect(vm.unlocked).toBe(true);
    expect(vm.config[SLOTS.body]).toEqual(wheelRule(120));
  });
  it('marks a sprite without an authored slot-map unavailable', () => {
    const p = createPlayer(db, { name: 'F', class_key: 'wizard', gender: 'F' }, 1);
    const vm = dyeViewModel(db, { id: p.id, class_key: 'wizard', gender: 'F' });
    expect(vm.available).toBe(false);
    expect(vm.channels).toEqual([]);
    expect(vm.slotmap).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `src/domain/dye.ts`**

```ts
import type Database from 'better-sqlite3';
import type { SlotRule } from './spritetint';
import { presentSlots, SLOT_LABELS, loadSlotmap } from './slots';
import { spriteId, getCosmetics } from './cosmetics';
import { classSpriteUrl, type Gender } from './classes';
import { getSlotConfig } from './slotcosmetics';
import { getSetting } from './settings';
import { SKUS } from './shop';

/** Saturation the colour wheel paints at. colorize keeps each pixel's brightness ramp,
 *  so it recolors white/grey/metal materials too (unlike a plain hue swap). */
export const WHEEL_SAT = 0.6;
export function wheelRule(hue: number): SlotRule {
  return { op: 'colorize', hue, sat: WHEEL_SAT };
}

/** Greyscale / metal finishes, keyed by the name the picker sends. */
export const FINISHES: Record<'black' | 'white' | 'steel', SlotRule> = {
  black: { op: 'value', lo: 0, hi: 0.32 },
  white: { op: 'value', lo: 0.74, hi: 1 },
  steel: { op: 'colorize', hue: 212, sat: 0.13 },
};

/** Build the stored rule from the picker's intent; null for unknown/invalid input. */
export function dyeRule(finish: string, hue: number | null): SlotRule | null {
  if (finish === 'wheel') return hue == null ? null : wheelRule(hue);
  return (FINISHES as Record<string, SlotRule>)[finish] ?? null;
}

export interface DyeChannel { slot: number; label: string; }
export interface DyeViewModel {
  available: boolean;
  unlocked: boolean;
  price: number;
  channels: DyeChannel[];
  slotmap: number[];               // frame-A slot ids, row-major (576)
  base: string;                    // plain class sprite URL (frame A)
  config: Record<number, SlotRule>;
  finishes: typeof FINISHES;
  wheelSat: number;
}

export function dyeViewModel(
  db: Database.Database,
  player: { id: number; class_key: string; gender: string },
): DyeViewModel {
  const sprite = spriteId(player.class_key, player.gender as Gender);
  const cos = getCosmetics(db, player.id);
  const ids = loadSlotmap(sprite, 'a');
  return {
    available: ids !== null,
    unlocked: !!cos && cos.wheel_tier >= 1,
    price: Number(getSetting(db, SKUS.cosmetic_wheel_t1.priceSetting) ?? SKUS.cosmetic_wheel_t1.priceDefault),
    channels: presentSlots(sprite).map((slot) => ({ slot, label: SLOT_LABELS[slot] ?? `Slot ${slot}` })),
    slotmap: ids ? Array.from(ids) : [],
    base: classSpriteUrl(player.class_key, player.gender as Gender),
    config: Object.fromEntries(getSlotConfig(db, player.id)),
    finishes: FINISHES,
    wheelSat: WHEEL_SAT,
  };
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/domain/dye.ts tests/dye.test.ts && git commit -m "feat(dye): wheel/finish rule shapes + dyeViewModel"`

---

### Task 3: character-page dye endpoints

**Files:**
- Modify: `src/web/routes/character.ts`
- Modify: `src/domain/slotcosmetics.ts`
- Modify: `tests/slotcosmetics.test.ts`
- Test: `tests/web-dye.test.ts`

**Interfaces:**
- Consumes: `getPlayerByToken` (players); `getCosmetics`/`spriteId` (cosmetics); `presentSlots` (slots); `dyeRule` (dye); `setSlotRule`/`clearSlot` (slotcosmetics); `purchase` (shop).
- Produces routes: `POST /character/dye/unlock` (redirect / 409 unsupported),
  `POST /character/dye/set|clear` (204 / 400 / 403 / 404). Both mutation routes
  require the unlock and a slot present in the player's authored map.
- `clearSlot(db, playerId, SLOTS.body)` also nulls `player_cosmetics.primary_hue`,
  preventing the compatibility fallback from resurrecting a cleared body dye.

- [ ] **Step 1: Write the failing test**

```ts
// tests/web-dye.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';
import { SLOTS, presentSlots } from '../src/domain/slots';
import { getSlotConfig } from '../src/domain/slotcosmetics';
import { getCosmetics } from '../src/domain/cosmetics';

function ctx() {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
  return { db, app, p };
}
const unlock = (app: ReturnType<typeof createApp>, token: string) =>
  request(app).post('/character/dye/unlock').type('form').send({ token });

describe('dye endpoints', () => {
  it('unlock deducts gold and grants the wheel', async () => {
    const { db, app, p } = ctx();
    const res = await unlock(app, p.auth_token);
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)!.gold).toBe(500000);
    expect(getCosmetics(db, p.id)!.wheel_tier).toBe(1);
  });
  it('set is rejected (403) until unlocked', async () => {
    const { app, p } = ctx();
    const res = await request(app).post('/character/dye/set').type('form')
      .send({ token: p.auth_token, slot: String(SLOTS.body), finish: 'wheel', hue: '200' });
    expect(res.status).toBe(403);
  });
  it('set stores the wheel rule after unlock', async () => {
    const { db, app, p } = ctx();
    await unlock(app, p.auth_token);
    const res = await request(app).post('/character/dye/set').type('form')
      .send({ token: p.auth_token, slot: String(SLOTS.body), finish: 'wheel', hue: '200' });
    expect(res.status).toBe(204);
    expect(getSlotConfig(db, p.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 200, sat: 0.6 });
  });
  it('set rejects a slot absent from the sprite (400)', async () => {
    const { app, p } = ctx();
    await unlock(app, p.auth_token);
    const present = new Set(presentSlots('wizard_M'));
    const absent = [SLOTS.body, SLOTS.headgear, SLOTS.hair, SLOTS.facePaint, SLOTS.cape,
      SLOTS.trim, SLOTS.weapon, SLOTS.shield, SLOTS.boots, SLOTS.skin, SLOTS.flair].find((s) => !present.has(s));
    if (absent === undefined) return; // wizard happens to use every slot — nothing to assert
    const res = await request(app).post('/character/dye/set').type('form')
      .send({ token: p.auth_token, slot: String(absent), finish: 'steel' });
    expect(res.status).toBe(400);
  });
  it('clear removes a slot', async () => {
    const { db, app, p } = ctx();
    await unlock(app, p.auth_token);
    await request(app).post('/character/dye/set').type('form')
      .send({ token: p.auth_token, slot: String(SLOTS.body), finish: 'wheel', hue: '120' });
    const res = await request(app).post('/character/dye/clear').type('form')
      .send({ token: p.auth_token, slot: String(SLOTS.body) });
    expect(res.status).toBe(204);
    expect(getSlotConfig(db, p.id).has(SLOTS.body)).toBe(false);
  });
  it('clear is rejected (403) until unlocked', async () => {
    const { app, p } = ctx();
    const res = await request(app).post('/character/dye/clear').type('form')
      .send({ token: p.auth_token, slot: String(SLOTS.body) });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (routes not registered).

- [ ] **Step 3: Implement** — in `src/web/routes/character.ts`:

Extend the imports. The file already imports `{ getPlayerByToken, renamePlayer, deletePlayer }` from players, `{ getClass, type Gender }` from classes, `{ cosmeticSkinUrl, getSlotConfig }` from slotcosmetics, `{ z }`. Add:

```ts
import { setSlotRule, clearSlot } from '../../domain/slotcosmetics'; // extend the existing slotcosmetics import
import { getCosmetics, spriteId } from '../../domain/cosmetics';
import { presentSlots } from '../../domain/slots';
import { dyeViewModel, dyeRule } from '../../domain/dye';
import { purchase } from '../../domain/shop';
```

In the `/character` GET render call, add `dye` to the data object (alongside `avatarUrl`):

```ts
        dye: dyeViewModel(db, player),
```

Register the three routes inside `registerCharacterRoutes` (after `/character/delete`):

```ts
  const DyeUnlock = z.object({ token: z.string().min(1) });
  app.post('/character/dye/unlock', (req, res) => {
    const parsed = DyeUnlock.safeParse(req.body);
    if (!parsed.success) { res.status(400).send('Invalid input'); return; }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) { res.status(404).send('Not found'); return; }
    const sprite = spriteId(player.class_key, player.gender as Gender);
    if (presentSlots(sprite).length === 0) { res.status(409).send('Dyes are not available for this sprite yet'); return; }
    purchase(db, player.id, 'cosmetic_wheel_t1', Date.now());
    res.redirect(`/character?token=${encodeURIComponent(player.auth_token)}`);
  });

  const DyeSet = z.object({
    token: z.string().min(1),
    slot: z.coerce.number().int().min(0).max(11),
    finish: z.enum(['wheel', 'black', 'white', 'steel']),
    hue: z.coerce.number().int().min(0).max(359).optional(),
  });
  app.post('/character/dye/set', (req, res) => {
    const parsed = DyeSet.safeParse(req.body);
    if (!parsed.success) { res.sendStatus(400); return; }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) { res.sendStatus(404); return; }
    const cos = getCosmetics(db, player.id);
    if (!cos || cos.wheel_tier < 1) { res.sendStatus(403); return; }
    const sprite = spriteId(player.class_key, player.gender as Gender);
    if (!presentSlots(sprite).includes(parsed.data.slot)) { res.sendStatus(400); return; }
    const rule = dyeRule(parsed.data.finish, parsed.data.hue ?? null);
    if (!rule) { res.sendStatus(400); return; }
    setSlotRule(db, player.id, parsed.data.slot, rule, Date.now());
    res.sendStatus(204);
  });

  const DyeClear = z.object({ token: z.string().min(1), slot: z.coerce.number().int().min(0).max(11) });
  app.post('/character/dye/clear', (req, res) => {
    const parsed = DyeClear.safeParse(req.body);
    if (!parsed.success) { res.sendStatus(400); return; }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) { res.sendStatus(404); return; }
    const cos = getCosmetics(db, player.id);
    if (!cos || cos.wheel_tier < 1) { res.sendStatus(403); return; }
    const sprite = spriteId(player.class_key, player.gender as Gender);
    if (!presentSlots(sprite).includes(parsed.data.slot)) { res.sendStatus(400); return; }
    clearSlot(db, player.id, parsed.data.slot);
    res.sendStatus(204);
  });
```

Update `clearSlot` so its post-condition is true even for migrated legacy body hues:

```ts
export function clearSlot(db: Database.Database, playerId: number, slot: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM player_slot_cosmetics WHERE player_id = ? AND slot = ?').run(playerId, slot);
    if (slot === SLOTS.body) {
      db.prepare('UPDATE player_cosmetics SET primary_hue = NULL WHERE player_id = ?').run(playerId);
    }
  })();
}
```

Add a regression test in `tests/slotcosmetics.test.ts`: purchase the wheel, save a legacy
body hue with `setCosmeticHue`, call `clearSlot(..., SLOTS.body)`, and assert
`getSlotConfig(...).has(SLOTS.body) === false`.

- [ ] **Step 4: Run — expect PASS** (`npm test -- web-dye`).
- [ ] **Step 5: Commit** `git add src/web/routes/character.ts tests/web-dye.test.ts && git commit -m "feat(dye): character-page unlock/set/clear endpoints"`

---

### Task 4: Wardrobe panel + client picker

**Files:**
- Modify: `src/web/views/character-sheet.ejs`
- Create: `src/web/public/dye.js`
- Modify: `src/web/public/dungeon.css`

**Interfaces:**
- Consumes: `dye` (from Task 2/3 render data) and `player.auth_token`.
- No new tests (client canvas UI; behaviour verified live in Task 6). Typecheck + full suite must stay green.

- [ ] **Step 1: Replace the "Visit the Shop" line in `src/web/views/character-sheet.ejs`.**

Delete:
```html
  <p style="margin-top:16px"><a class="btn btn-gold" href="/shop?token=<%= player.auth_token %>">🎨 Visit the Shop</a></p>
```
and insert a new panel **after** the closing `</div>` of the first stats panel (before the "Your setup snippet" panel):

```html
<% if (!dye.available) { %>
<div class="panel dye-unavailable" style="text-align:center">
  <h2>Wardrobe</h2>
  <img class="px" src="<%= avatarUrl %>" width="96" height="96" alt="your character" />
  <p>The tailor is still drafting patterns for this sprite. No gold can be spent until its slot-map arrives in Phase 2C.</p>
</div>
<% } else if (dye.unlocked) { %>
<div class="panel">
  <h2>Wardrobe</h2>
  <p style="color:var(--muted);margin:-8px 0 4px">Pick a part, then a colour or finish — changes save automatically.</p>
  <div class="dye-wrap">
    <canvas id="dye-preview" width="140" height="140" class="px dye-preview" aria-label="live preview"></canvas>
    <div class="dye-controls">
      <div id="dye-channels" class="dye-channels"></div>
      <canvas id="dye-wheel" width="72" height="72" class="dye-wheel" role="slider"
        tabindex="0" aria-label="Dye hue" aria-valuemin="0" aria-valuemax="359"></canvas>
      <div class="dye-finishes">
        <button type="button" class="dye-fin dye-default" data-finish="none">Restore default</button>
        <button type="button" class="dye-fin" data-finish="black">Black</button>
        <button type="button" class="dye-fin" data-finish="white">White</button>
        <button type="button" class="dye-fin" data-finish="steel">Steel</button>
      </div>
    </div>
  </div>
  <script>window.__DYE__ = <%- JSON.stringify({ token: player.auth_token, base: dye.base, slotmap: dye.slotmap, channels: dye.channels, config: dye.config, finishes: dye.finishes, wheelSat: dye.wheelSat }) %>;</script>
  <script src="/static/dye.js"></script>
</div>
<% } else { %>
<div class="panel" style="text-align:center">
  <h2>Wardrobe</h2>
  <img class="px" src="<%= avatarUrl %>" width="96" height="96" alt="your character" style="margin:8px auto" />
  <p>Unlock the <b>Dye Wheel</b> to recolor every part of your character — clothing, cape, weapon, and more — forever.</p>
  <form method="post" action="/character/dye/unlock">
    <input type="hidden" name="token" value="<%= player.auth_token %>">
    <button class="btn btn-gold" <%= player.gold < dye.price ? 'disabled' : '' %>>Unlock — <%= dye.price.toLocaleString() %>g</button>
    <% if (player.gold < dye.price) { %><p class="err">Need <%= (dye.price - player.gold).toLocaleString() %> more gold.</p><% } %>
  </form>
</div>
<% } %>
```

- [ ] **Step 2: Create `src/web/public/dye.js`**

```js
'use strict';
// ClaudeRPG wardrobe dye picker. Live-previews per-slot recolors client-side by
// mirroring the server colour ops over the sprite's slot-map, and persists each
// change to /character/dye/*. The server (/sprite/skin) remains the source of truth.
(function () {
  const D = window.__DYE__; if (!D) return;
  const preview = document.getElementById('dye-preview');
  const wheel = document.getElementById('dye-wheel');
  const chanWrap = document.getElementById('dye-channels');
  if (!preview || !wheel || !chanWrap) return;
  const pctx = preview.getContext('2d'); pctx.imageSmoothingEnabled = false;
  const wctx = wheel.getContext('2d'); wctx.imageSmoothingEnabled = false;
  const R = wheel.width / 2;

  // --- colour ops (mirror src/domain/spritetint.ts) ---
  function hsv(hDeg, s, v) {
    const h = (((hDeg % 360) + 360) % 360) / 360;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return [Math.round(m[0] * 255), Math.round(m[1] * 255), Math.round(m[2] * 255)];
  }
  function applyRule(rule, r, g, b) {
    const v = Math.max(r, g, b) / 255;
    if (rule.op === 'value') { const c = Math.round((rule.lo + v * (rule.hi - rule.lo)) * 255); return [c, c, c]; }
    if (rule.op === 'colorize') return hsv(rule.hue, rule.sat, v);
    const mn = Math.min(r, g, b) / 255; const s = v === 0 ? 0 : (v - mn) / v;  // hue: keep s,v
    return hsv(rule.hue, s, v);
  }

  const config = new Map(Object.entries(D.config).map(([k, val]) => [Number(k), val]));
  const slotmap = D.slotmap;
  let active = D.channels.length ? D.channels[0].slot : null;

  // --- base sprite -> ImageData ---
  const base = new Image(); base.crossOrigin = 'anonymous'; base.src = D.base;
  let src = null;
  base.onload = () => {
    const off = document.createElement('canvas'); off.width = 24; off.height = 24;
    const o = off.getContext('2d'); o.imageSmoothingEnabled = false; o.drawImage(base, 0, 0, 24, 24);
    src = o.getImageData(0, 0, 24, 24); renderPreview();
  };
  function renderPreview() {
    if (!src) return;
    const img = pctx.createImageData(24, 24), d = img.data, s = src.data;
    for (let p = 0; p < slotmap.length; p++) {
      const i = p * 4; d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3];
      if (s[i + 3] === 0) continue;
      const rule = config.get(slotmap[p]);
      if (rule) { const c = applyRule(rule, s[i], s[i + 1], s[i + 2]); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; }
    }
    const tmp = document.createElement('canvas'); tmp.width = 24; tmp.height = 24;
    tmp.getContext('2d').putImageData(img, 0, 0);
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.drawImage(tmp, 0, 0, preview.width, preview.height);
  }

  // --- pixel hue wheel ---
  // Paint one low-resolution cell at a time, then let CSS nearest-neighbor upscale
  // the 72px canvas. This intentionally reads like a game sprite, not a browser gradient.
  for (let y = 0; y < wheel.height; y++) for (let x = 0; x < wheel.width; x++) {
    const dx = x + 0.5 - R, dy = y + 0.5 - R;
    const radius = Math.hypot(dx, dy);
    if (radius < R * 0.34 || radius > R - 2) continue;
    const hue = (Math.round(Math.atan2(dy, dx) * 180 / Math.PI / 6) * 6 + 360) % 360;
    wctx.fillStyle = `hsl(${hue},85%,55%)`;
    wctx.fillRect(x, y, 1, 1);
  }

  // --- persistence (debounced set; immediate clear) ---
  const timers = new Map();
  function saveSet(slot, finish, hue) {
    const body = new URLSearchParams({ token: D.token, slot: String(slot), finish });
    if (hue != null) body.set('hue', String(hue));
    clearTimeout(timers.get(slot));
    timers.set(slot, setTimeout(() => {
      fetch('/character/dye/set', { method: 'POST', body });
      timers.delete(slot);
    }, 120));
  }
  function saveClear(slot) {
    clearTimeout(timers.get(slot));
    timers.delete(slot);
    fetch('/character/dye/clear', { method: 'POST', body: new URLSearchParams({ token: D.token, slot: String(slot) }) });
  }
  function setActive(rule, finish, hue) {
    if (active == null) return;
    if (rule) { config.set(active, rule); saveSet(active, finish, hue); }
    else { config.delete(active); saveClear(active); }
    renderPreview(); renderChannels();
  }

  // --- channel chips ---
  function dotColor(rule) {
    if (!rule) return 'transparent';
    if (rule.op === 'value') return `hsl(0,0%,${Math.round((rule.lo + rule.hi) / 2 * 100)}%)`;
    return `hsl(${rule.hue},70%,55%)`;
  }
  function renderChannels() {
    chanWrap.textContent = '';
    for (const ch of D.channels) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dye-chan' + (ch.slot === active ? ' active' : '');
      const dot = document.createElement('span'); dot.className = 'dye-dot';
      dot.style.background = dotColor(config.get(ch.slot));
      b.appendChild(dot); b.appendChild(document.createTextNode(ch.label));
      b.addEventListener('click', () => { active = ch.slot; renderChannels(); });
      chanWrap.appendChild(b);
    }
  }
  renderChannels();

  // --- wheel + finish wiring ---
  function pickHue(e) {
    const rect = wheel.getBoundingClientRect();
    const dx = (e.clientX - rect.left) * wheel.width / rect.width - R;
    const dy = (e.clientY - rect.top) * wheel.height / rect.height - R;
    const hue = (Math.round(Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
    setActive({ op: 'colorize', hue, sat: D.wheelSat }, 'wheel', hue);
    wheel.setAttribute('aria-valuenow', String(hue));
  }
  let dragging = false;
  wheel.addEventListener('pointerdown', (e) => { dragging = true; pickHue(e); });
  wheel.addEventListener('pointermove', (e) => { if (dragging) pickHue(e); });
  window.addEventListener('pointerup', () => { dragging = false; });
  wheel.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const current = config.get(active)?.hue ?? 0;
    const delta = (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ? -6 : 6;
    const hue = (current + delta + 360) % 360;
    setActive({ op: 'colorize', hue, sat: D.wheelSat }, 'wheel', hue);
    wheel.setAttribute('aria-valuenow', String(hue));
  });

  document.querySelectorAll('.dye-fin').forEach((el) => {
    el.addEventListener('click', () => {
      const f = el.getAttribute('data-finish');
      if (f === 'none') { setActive(null); return; }
      setActive(D.finishes[f], f, null);
    });
  });
})();
```

- [ ] **Step 3: Append the `.dye-*` block to `src/web/public/dungeon.css`**

```css
/* wardrobe dye picker (character page) */
.dye-wrap{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;margin-top:8px}
.dye-preview{width:140px;height:140px;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px}
.dye-controls{flex:1;min-width:220px}
.dye-channels{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.dye-chan{padding:7px 12px;border-radius:9px;border:1px solid var(--line);background:#ffffff0d;color:var(--ink);
  box-shadow:none;font-size:13px;font-weight:650;display:inline-flex;align-items:center;gap:7px;margin-top:0}
.dye-chan:hover{border-color:var(--gold-dim);transform:none}
.dye-chan.active{border-color:var(--gold);color:var(--gold);box-shadow:0 0 0 1px var(--gold)}
.dye-dot{width:12px;height:12px;border-radius:50%;border:1px solid #0006;display:inline-block}
.dye-wheel{display:block;width:216px;height:216px;cursor:crosshair;touch-action:none;
  image-rendering:pixelated;border-radius:50%}
.dye-finishes{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.dye-fin{padding:8px 14px;border-radius:9px;border:1px solid var(--line);background:#ffffff0d;color:var(--head);box-shadow:none;font-size:13px;margin-top:0}
.dye-fin:hover{border-color:var(--gold-dim);color:var(--gold);transform:none}
```

- [ ] **Step 4: Verify** `rm -rf data/tint-cache && npm test && npm run typecheck` — all green (no behaviour change to existing suites; the character render now also builds `dye`, exercised by existing `/character` tests).
- [ ] **Step 5: Commit** `git add src/web/views/character-sheet.ejs src/web/public/dye.js src/web/public/dungeon.css && git commit -m "feat(dye): wardrobe panel + client picker (wheel, finishes, live preview)"`

---

### Task 5: Closed `/shop` + retire the old picker

**Files:**
- Rewrite: `src/web/routes/shop.ts`
- Rewrite: `src/web/views/shop.ejs`
- Delete: `src/web/public/shop.js`
- Rewrite: `tests/web-shop.test.ts`

**Interfaces:**
- `/shop` renders the closed bazaar (mimic = creature index 198). `/shop/unlock` and `/shop/color` are removed. `/sprite/tint` and `/sprite/skin` are unchanged.

- [ ] **Step 1: Rewrite `tests/web-shop.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';

function ctx() {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  return { db, app, p };
}

describe('shop (closed bazaar)', () => {
  it('GET /shop shows the closed state with the mimic sprite', async () => {
    const { app, p } = ctx();
    const res = await request(app).get('/shop').query({ token: p.auth_token });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/closed/i);
    expect(res.text).toContain('creatures_24x24');   // mimic sprite img
  });
  it('the retired picker routes are gone', async () => {
    const { app, p } = ctx();
    const color = await request(app).post('/shop/color').type('form').send({ token: p.auth_token, hue: '1' });
    const unlock = await request(app).post('/shop/unlock').type('form').send({ token: p.auth_token });
    expect(color.status).toBe(404);
    expect(unlock.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (old `/shop` still renders login / picker; `/shop/color` still 302s).

- [ ] **Step 3: Rewrite `src/web/routes/shop.ts`** (full file):

```ts
import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { getClass, creatureSpriteFile, type Gender } from '../../domain/classes';
import { getPlayerById } from '../../domain/players';
import { CLOTHING, spriteFileIndex, spriteId } from '../../domain/cosmetics';
import { recolorSprite, recolorSpriteSlots } from '../../domain/spritetint';
import { loadSlotmap, SLOTS } from '../../domain/slots';
import { getSlotConfig, slotConfigHash } from '../../domain/slotcosmetics';

export function registerShopRoutes(app: Express, { db, config }: AppDeps): void {
  const cacheDir = path.join(path.dirname(config.dbPath), 'tint-cache');

  // Legacy single-hue tint (still used by nothing user-facing after 2B.2; kept for
  // backward-compat with old cached URLs). Renders the body slot at one hue.
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
    const c = CLOTHING[classKey];
    const src = fs.readFileSync(srcFile);
    const slotIds = loadSlotmap(`${classKey}_${gender}`, frame);
    let out: Buffer;
    if (slotIds) {
      const bodyRule = c.op === 'colorize'
        ? { op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
        : { op: 'hue' as const, hue };
      out = recolorSpriteSlots(src, slotIds, new Map([[SLOTS.body, bodyRule]]));
    } else {
      const rule = c.op === 'colorize'
        ? { hexes: c.dominant, op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
        : { hexes: c.dominant, op: 'hue' as const, hue };
      out = recolorSprite(src, [rule]);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));

  // Per-slot skin: render a player's full slot config through the slot-map, cached by config hash.
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

  // The bazaar is closed — wares are a future phase. The wardrobe/dye tool now
  // lives on the character page (Phase 2B.2). A mimic guards the empty stall.
  app.get('/shop', asyncHandler(async (_req, res) => {
    const token = typeof _req.query.token === 'string' ? _req.query.token : '';
    res.send(await renderPage('shop', {
      title: 'The Bazaar', frame: 'full', token,
      mimicUrl: `/sprites/creatures_24x24/${creatureSpriteFile(198)}`,
    }));
  }));
}
```

- [ ] **Step 4: Rewrite `src/web/views/shop.ejs`** (closed state):

```html
<div class="panel" style="text-align:center">
  <h1 class="brand" style="justify-content:center;margin-bottom:6px">The Bazaar is Closed</h1>
  <img class="px" src="<%= mimicUrl %>" width="120" height="120" alt="a suspicious treasure chest" style="margin:14px auto" />
  <p style="color:var(--muted)">The merchant has packed up for now — and that chest in the corner has <em>teeth</em>. New wares are coming in a future update.</p>
  <p>Looking to recolor your character? Your <b>Dye Wheel</b> now lives on your character page.</p>
  <% if (token) { %>
    <p style="margin-top:16px"><a class="btn btn-gold" href="/character?token=<%= token %>">← Back to your character</a></p>
  <% } else { %>
    <p style="margin-top:16px"><a class="btn btn-ghost" href="/character">Go to your character</a></p>
  <% } %>
</div>
```

- [ ] **Step 5: Delete the retired client script** `git rm src/web/public/shop.js`

- [ ] **Step 6: Run — expect PASS** `rm -rf data/tint-cache && npm test && npm run typecheck`. (Existing `tests/shop.test.ts` domain tests stay green — `setCosmeticHue`/`cosmeticSpriteUrl`/`/sprite/tint` are untouched.)
- [ ] **Step 7: Commit** `git add src/web/routes/shop.ts src/web/views/shop.ejs tests/web-shop.test.ts && git commit -m "feat(shop): closed-bazaar mimic state; retire the single-hue picker"`

---

### Task 6: Full verification

- [ ] **Step 1:** `rm -rf data/tint-cache && npm test && npm run typecheck` — all green.
- [ ] **Step 2: Drive it live in the browser (fresh isolated DB/cache/port).** Start the server, register a wizard, give it gold (`UPDATE players SET gold = 3000000`), open `/character?token=…`:
  - Unlock the Dye Wheel → the Wardrobe picker appears.
  - Pick **Clothing** → drag the wheel → the preview robe recolors live; a refresh shows the same (persisted). The top-of-page avatar and the TV/leaderboard avatars update on their next load (they read `/sprite/skin`).
  - Pick **Weapon** → **Steel**; **Eyes** → a bright hue; **Skin** → a green → confirm each isolated part changes and the others hold.
  - **None** on a channel clears it back to default.
  - Confirm `/shop?token=…` shows the closed mimic bazaar and the character page no longer links "Visit the Shop".
- [ ] **Step 3:** Commit any fixes. Female slot-maps (so `/sprite/skin` recolors female sprites instead of passing through) are **Phase 2C**.

---

## Self-Review (Phase 2B.2)
- **Spec coverage:** character-page per-slot picker (Tasks 3–4), presence-matrix channels (`presentSlots`, Task 1), black/white/steel finishes (`FINISHES`, Task 2 + swatches Task 4), picker relocation off `/shop` (Task 4 removes the link; Task 5 closes `/shop`), closed-shop/mimic state (Task 5). ✓
- **User decisions honored:** wheel = **colorize** (paints white/grey/metal too); **every present slot** exposed incl. eyes/skin (`presentSlots` excludes only outline; no extra filter). ✓
- **DRY / single source:** finish + wheel values defined once in `dye.ts` and embedded via `window.__DYE__`; `dye.js` reads them, never re-typing the ramps. The 3 colour ops in `dye.js` are a labelled mirror of `spritetint.ts` (documented precedent: `tv.js`). ✓
- **Placeholders:** none — every step shows complete code and its expected result; the mimic is a concrete sprite (creature 198). ✓
- **Type consistency:** `SlotRule` is the stored/previewed shape throughout; `dyeRule`/`wheelRule`/`FINISHES`/`dyeViewModel` defined in Task 2 and consumed in Tasks 3–4; endpoint field names (`token`,`slot`,`finish`,`hue`) match between the Zod schemas, `dye.js`, and the tests. ✓
- **Backward compatibility:** `/sprite/tint`, `setCosmeticHue`, `cosmeticSpriteUrl`, and the legacy `primary_hue`→body fallback are all untouched; `tests/shop.test.ts` stays green. No data migration. ✓
- **Guards:** `set` requires unlock (403) and a present slot (400) and a valid finish/hue (400); Zod bounds `slot ∈ [0,11]`, `hue ∈ [0,359]`. ✓
```

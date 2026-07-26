# Wardrobe and Gilded Mimic Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wardrobe autosave with one atomic explicit save and reshape the Bazaar into the compact, animated Gilded Mimic marketplace approved in the design.

**Architecture:** The browser keeps separate saved and draft cosmetic states and submits one form-encoded batch containing every dirty slot. The server validates the whole batch, applies its per-slot tombstones and rules inside one SQLite transaction, and returns the canonical entitled configuration. Wardrobe and Bazaar animations reuse the existing A/B sprite frames, slot maps, and browser dye math; Bazaar demonstrations remain read-only and purchase effects progressively enhance the existing atomic form.

**Tech Stack:** TypeScript, Node 26, tsx/ESM, Express 4, EJS, better-sqlite3, Zod, Canvas 2D, plain browser JavaScript, CSS, Vitest, Supertest.

**Approved design:** `docs/superpowers/specs/2026-07-26-wardrobe-bazaar-polish-design.md`

## Global Constraints

- Work on `feat/player-shop-cosmetics`; do not merge, push, deploy, or reboot the Pi.
- Do not mutate a production database. Browser validation uses a fresh database and cache under `/private/tmp`.
- Keep Node/tsx ESM conventions: relative TypeScript imports have no file extensions and no build step is introduced.
- Add no runtime or development dependencies.
- Async Express handlers use `asyncHandler`; synchronous handlers may remain synchronous.
- Domain functions receive `now: number`; only the web layer may call `Date.now()`.
- Browser persistence remains `application/x-www-form-urlencoded`; do not add `express.json()`.
- One Save Changes action sends one request and one revision for every dirty channel.
- Every batch is all-or-nothing. Invalid, locked, duplicate-slot, stale, or failed operations change no cosmetic rows or tombstones.
- Keep the existing single-slot routes available for compatibility, but the Wardrobe UI must not call them.
- A draft never writes during hue dragging, Tone dragging, preset selection, channel switching, or Restore Default.
- Immutable `/sprite/skin` responses keep their public one-year cache policy. Personalized Character and Bazaar HTML use `Cache-Control: private, no-store`.
- Bazaar color demonstrations are client-only and never mutate cosmetics.
- Inventory remains a display-only Coming Soon state; do not add inventory schema or product logic.
- All motion respects `prefers-reduced-motion: reduce`.
- Preserve the approved three-tier channel registry, class/gender availability, pricing, and sequential purchase authorization exactly.

---

## File Structure

- Modify `src/domain/slotcosmetics.ts` — atomic batch application and per-slot revision classification.
- Modify `src/domain/dye.ts` — A/B Wardrobe source frames and slot maps in the view model.
- Modify `src/domain/shopview.ts` — compact offer copy, ledger data, and read-only Bazaar preview payload.
- Modify `src/web/routes/character.ts` — private HTML headers and authenticated batch-save route.
- Modify `src/web/routes/shop.ts` — private Bazaar HTML headers and enriched shop view model.
- Modify `src/web/views/character-sheet.ejs` — animated profile, explicit action row, compact controls, and client payload.
- Rewrite `src/web/views/shop.ejs` — Gilded Mimic header, reusable product card, preview canvas, and Adventurer Ledger.
- Create `src/web/public/dye-draft.js` — pure saved/draft comparison and operation serialization helpers.
- Rewrite `src/web/public/dye.js` persistence section — draft-only editing and one batch request.
- Create `src/web/public/shop-preview.js` — independent per-slot offer color animation across A/B frames.
- Create `src/web/public/shop.js` — progressively enhanced purchase forging effect.
- Modify `src/web/public/dungeon.css` — Wardrobe polish, marketplace template, sticky ledger, and motion.
- Add focused tests named in each task; retain all existing tests unless a test explicitly asserts the retired autosave behavior.

---

### Task 1: Prevent personalized-page history from restoring stale cosmetics

**Files:**
- Modify: `src/web/routes/character.ts`
- Modify: `src/web/routes/shop.ts`
- Modify: `tests/web-character.test.ts`
- Modify: `tests/web-shop.test.ts`

**Interfaces:**
- Produces: Character and Bazaar HTML responses with `Cache-Control: private, no-store`.
- Preserves: `/sprite/skin/:playerId/:frame/:hash.png` with `public, max-age=31536000, immutable`.

- [ ] **Step 1: Add failing cache-policy tests**

Append one assertion to the authenticated Character GET test and one to the authenticated Shop GET test:

```ts
expect(res.headers['cache-control']).toBe('private, no-store');
```

In `tests/web-shop.test.ts`, extend the skin-cache test so it continues to assert:

```ts
expect(skin.headers['cache-control']).toBe('public, max-age=31536000, immutable');
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm test -- tests/web-character.test.ts tests/web-shop.test.ts tests/web-skin.test.ts
```

Expected: Character and Shop HTML cache assertions fail because the header is absent; skin caching remains green.

- [ ] **Step 3: Set the private header before rendering personalized HTML**

In the GET handlers, set the header before every login, error, and authenticated response:

```ts
res.set('Cache-Control', 'private, no-store');
```

Do not place this in global middleware and do not alter either sprite route.

- [ ] **Step 4: Re-run focused tests and typecheck**

Run:

```bash
npm test -- tests/web-character.test.ts tests/web-shop.test.ts tests/web-skin.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/character.ts src/web/routes/shop.ts tests/web-character.test.ts tests/web-shop.test.ts
git commit -m "fix(cosmetics): prevent stale personalized history pages"
```

---

### Task 2: Apply every explicit Wardrobe save in one transaction

**Files:**
- Modify: `src/domain/slotcosmetics.ts`
- Modify: `src/web/routes/character.ts`
- Modify: `tests/slotcosmetics.test.ts`
- Modify: `tests/web-dye.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SlotMutationOperation {
  slot: number;
  rule: SlotRule | null;
}

export type SlotMutationBatchResult = 'applied' | 'duplicate' | 'stale';

export function applySlotMutationBatch(
  db: Database.Database,
  playerId: number,
  session: number,
  revision: number,
  operations: readonly SlotMutationOperation[],
  now: number,
): SlotMutationBatchResult;
```

- Produces: `POST /character/dye/save`, accepting form fields `token`, `session`, `revision`, and `changes`.
- Response contract: `200 { config, hash }` for applied or exact duplicate, `400` malformed/duplicate slots, `403` unavailable or locked channel, `404` unknown token, `409` stale mutation.
- Consumes: `dyeRule`, `channelFor`, `getCosmetics`, `getEntitledSlotConfig`, `skinRenderHash`, and `spriteId`.

- [ ] **Step 1: Write failing domain tests for atomic classification**

Add to `tests/slotcosmetics.test.ts`:

```ts
it('applies a multi-slot set and clear with one shared revision', () => {
  const session = beginSlotMutationSession(db, player.id);
  setSlotRule(db, player.id, SLOTS.cape, { op: 'colorize', hue: 10, sat: 0.6 }, 1);
  expect(applySlotMutationBatch(db, player.id, session.session, 1, [
    { slot: SLOTS.body, rule: { op: 'colorize', hue: 200, sat: 0.6, tone: 0.2 } },
    { slot: SLOTS.cape, rule: null },
  ], 100)).toBe('applied');
  expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({
    op: 'colorize', hue: 200, sat: 0.6, tone: 0.2,
  });
  expect(getSlotConfig(db, player.id).has(SLOTS.cape)).toBe(false);
});

it('treats an exact replay as duplicate and rejects mixed duplicate/new state', () => {
  const session = beginSlotMutationSession(db, player.id);
  const operations = [
    { slot: SLOTS.body, rule: { op: 'colorize' as const, hue: 120, sat: 0.6 } },
    { slot: SLOTS.skin, rule: { op: 'colorize' as const, hue: 24, sat: 0.6 } },
  ];
  expect(applySlotMutationBatch(db, player.id, session.session, 7, operations, 100)).toBe('applied');
  expect(applySlotMutationBatch(db, player.id, session.session, 7, operations, 101)).toBe('duplicate');
  expect(applySlotMutationBatch(db, player.id, session.session, 7, [
    operations[0], { slot: SLOTS.cape, rule: null },
  ], 102)).toBe('stale');
});

it('rolls back rules and tombstones when any write throws', () => {
  const session = beginSlotMutationSession(db, player.id);
  expect(() => applySlotMutationBatch(db, player.id, session.session, 1, [
    { slot: SLOTS.body, rule: { op: 'colorize', hue: 10, sat: 0.6 } },
    { slot: SLOTS.skin, rule: { op: 'colorize', hue: 10, sat: 0.6, tone: 2 } },
  ], 100)).toThrow(RangeError);
  expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM player_slot_cosmetic_revisions WHERE player_id = ?')
    .get(player.id)).toEqual({ n: 0 });
});
```

- [ ] **Step 2: Run the domain test and verify the missing export failure**

Run:

```bash
npm test -- tests/slotcosmetics.test.ts
```

Expected: fail because `applySlotMutationBatch` does not exist.

- [ ] **Step 3: Implement transaction-wide classification and writes**

In `src/domain/slotcosmetics.ts`, classify every operation before writing:

```ts
export function applySlotMutationBatch(
  db: Database.Database,
  playerId: number,
  session: number,
  revision: number,
  operations: readonly SlotMutationOperation[],
  now: number,
): SlotMutationBatchResult {
  return db.transaction(() => {
    const issued = db.prepare(
      'SELECT session FROM player_cosmetic_mutation_sessions WHERE player_id = ?',
    ).get(playerId) as SessionRow | undefined;
    if (!issued || session > issued.session) return 'stale';

    const states = operations.map(({ slot }) => {
      const previous = db.prepare(
        `SELECT session, revision FROM player_slot_cosmetic_revisions
         WHERE player_id = ? AND slot = ?`,
      ).get(playerId, slot) as (SessionRow & { revision: number }) | undefined;
      if (!previous) return 'new' as const;
      if (session < previous.session
        || (session === previous.session && revision < previous.revision)) return 'stale' as const;
      if (session === previous.session && revision === previous.revision) return 'duplicate' as const;
      return 'new' as const;
    });
    if (states.includes('stale')) return 'stale';
    if (states.every((state) => state === 'duplicate')) return 'duplicate';
    if (states.some((state) => state === 'duplicate')) return 'stale';

    for (const { slot, rule } of operations) {
      db.prepare(
        `INSERT INTO player_slot_cosmetic_revisions (player_id, slot, session, revision)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(player_id, slot) DO UPDATE SET
           session = excluded.session, revision = excluded.revision`,
      ).run(playerId, slot, session, revision);
      if (rule) setSlotRule(db, playerId, slot, rule, now);
      else clearSlotRows(db, playerId, slot, now);
    }
    return 'applied';
  })();
}
```

Reject an empty operation list with `RangeError`. The route prevents duplicate slots before calling this function.

- [ ] **Step 4: Add failing route tests for the complete contract**

Add cases to `tests/web-dye.test.ts` that post JSON inside the form field:

```ts
const save = (changes: unknown, revision = 1) => request(app)
  .post('/character/dye/save').type('form').send({
    token: player.auth_token,
    session: browserSession.session,
    revision,
    changes: JSON.stringify(changes),
  });
```

Cover:

```ts
expect((await save([
  { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 210, tone: -0.2 },
  { action: 'set', slot: SLOTS.headgear, recipe: 'gold', tone: 0.1 },
])).status).toBe(200);

expect((await save([
  { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 210 },
  { action: 'set', slot: SLOTS.weapon, recipe: 'gold' },
], 2)).status).toBe(403);

expect((await save([
  { action: 'clear', slot: SLOTS.body },
  { action: 'clear', slot: SLOTS.body },
], 3)).status).toBe(400);
```

After each rejected request, assert both cosmetic rules and revision rows are unchanged. Also cover malformed JSON, 13 changes (one more than the 12 recolorable slots), unknown token, stale revision, and exact replay returning the same canonical JSON.

- [ ] **Step 5: Implement strict form parsing and the batch route**

Define strict schemas:

```ts
const DyeBatchEnvelope = z.object({
  token: z.string().min(1),
  session: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  revision: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  changes: z.string().min(2).max(8192),
}).strict();

const DyeBatchChanges = z.array(z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    slot: z.number().int().min(0).max(MAX_RECOLOR_SLOT),
    recipe: z.enum(['wheel', 'steel', 'bronze', 'gold']),
    hue: z.number().int().min(0).max(359).optional(),
    tone: z.number().finite().min(-1).max(1).optional(),
  }).strict(),
  z.object({
    action: z.literal('clear'),
    slot: z.number().int().min(0).max(MAX_RECOLOR_SLOT),
  }).strict(),
])).min(1).max(MAX_RECOLOR_SLOT);
```

Parse `changes` in a `try/catch`, reject duplicate slots, authorize every slot through `channelFor` and the player's `wheel_tier`, convert sets with `dyeRule`, then call `applySlotMutationBatch` once. On applied or duplicate, return:

```ts
const config = getEntitledSlotConfig(db, player);
res.json({
  config: Object.fromEntries(config),
  hash: skinRenderHash(spriteId(player.class_key, player.gender as Gender), config, slotmapsDir),
});
```

Import `type Gender` from `../../domain/classes` for this route response.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/slotcosmetics.test.ts tests/web-dye.test.ts tests/web-skin.test.ts
npm run typecheck
```

Expected: all selected tests pass and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/domain/slotcosmetics.ts src/web/routes/character.ts tests/slotcosmetics.test.ts tests/web-dye.test.ts
git commit -m "feat(dye): save Wardrobe drafts atomically"
```

---

### Task 3: Replace slider autosave with saved/draft state

**Files:**
- Create: `src/web/public/dye-draft.js`
- Modify: `src/web/public/dye.js`
- Modify: `src/web/views/character-sheet.ejs`
- Create: `tests/dye-draft.test.ts`
- Modify: `tests/dye-client-behavior.test.ts`
- Modify: `tests/web-dye.test.ts`

**Interfaces:**
- Produces browser global:

```js
window.ClaudeRpgDyeDraft = {
  cloneStates,
  equalState,
  dirtyOperations,
};
```

- `dirtyOperations(saved, draft)` returns slot-sorted `{ action: 'set'|'clear', ... }` objects in the Task 2 route contract.
- Produces DOM IDs: `dye-save`, `dye-discard`, `dye-reload`, and `dye-save-status`.
- Consumes: `POST /character/dye/save` and `window.__DYE__.revisionSession|revisionSeed`.

- [ ] **Step 1: Write failing pure draft-helper tests**

Create `tests/dye-draft.test.ts` with a VM context matching `tests/dye-color.test.ts` and assert:

```ts
const saved = new Map([[1, { recipe: 'wheel', hue: 20, sat: 0.6, tone: 0 }]]);
const draft = api.cloneStates(saved);
draft.set(1, { recipe: 'wheel', hue: 80, sat: 0.6, tone: 0.25 });
draft.set(2, { recipe: 'gold', hue: 46, sat: 0.75, tone: 0.1 });
expect(api.dirtyOperations(saved, draft)).toEqual([
  { action: 'set', slot: 1, recipe: 'wheel', hue: 80, tone: 0.25 },
  { action: 'set', slot: 2, recipe: 'gold', tone: 0.1 },
]);
draft.delete(1);
expect(api.dirtyOperations(saved, draft)[0]).toEqual({ action: 'clear', slot: 1 });
expect(saved.get(1)?.hue).toBe(20);
```

- [ ] **Step 2: Run and verify the missing-file failure**

Run:

```bash
npm test -- tests/dye-draft.test.ts
```

Expected: fail because `src/web/public/dye-draft.js` does not exist.

- [ ] **Step 3: Implement deterministic draft helpers**

Use a UMD-style IIFE like `dye-color.js`. Clone each state object, compare `recipe`, normalized `hue`, `sat`, and `tone`, and sort the union of slots numerically. A set operation includes `hue` only for the wheel recipe and always includes normalized Tone.

- [ ] **Step 4: Rewrite behavior tests before the client**

Replace autosave expectations in `tests/dye-client-behavior.test.ts` with:

- no fetch after multiple hue/Tone input events;
- status becomes `Unsaved changes` once and stays there while dragging;
- Save sends exactly one `/character/dye/save` request containing all dirty channels;
- Save disables both action buttons while in flight;
- successful canonical response updates the baseline and shows `Saved`;
- Discard restores all saved rules without a request;
- Restore Default stages one clear operation without a request;
- a rejected request leaves the draft and Save enabled;
- a `409` leaves the draft visible, disables further saves, and reveals Reload Wardrobe;
- `beforeunload` warns only while dirty;
- `pageshow({ persisted: true })` reloads once, while normal pageshow does not.

The fake fetch success body is:

```ts
Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ config: {}, hash: '0123456789abcdef' }),
});
```

- [ ] **Step 5: Update the character template action row**

Load the helper before the main client:

```ejs
<script src="/static/dye-color.js"></script>
<script src="/static/dye-draft.js"></script>
<script src="/static/dye.js"></script>
```

Replace the autosave pill-only row with:

```ejs
<div class="dye-actions">
  <span id="dye-save-status" class="dye-save-status" role="status" aria-live="polite">Saved</span>
  <button id="dye-reload" type="button" class="btn dye-reload" hidden>Reload Wardrobe</button>
  <button id="dye-discard" type="button" class="btn dye-discard" disabled>Discard Changes</button>
  <button id="dye-save" type="button" class="btn btn-gold" disabled>Save Changes</button>
</div>
```

- [ ] **Step 6: Rewrite `dye.js` persistence around draft state**

Replace timers, queues, pending sets, pagehide flushing, and per-control POSTs with:

```js
let savedStates = Draft.cloneStates(states);
let saving = false;

function operations() {
  return Draft.dirtyOperations(savedStates, states);
}

function renderSaveState(message) {
  const dirty = operations().length > 0;
  saveButton.disabled = saving || !dirty;
  discardButton.disabled = saving || !dirty;
  setStatus(message || (dirty ? 'Unsaved changes' : 'Saved'), dirty ? 'dirty' : 'saved');
}
```

`applyState` and Restore Default render only. Save posts one form body:

```js
const body = new URLSearchParams({
  token: D.token,
  session: String(revisionSession),
  revision: String(nextRevision),
  changes: JSON.stringify(operations()),
});
```

On success, parse the canonical config, convert it through `stateFromRule`, replace both maps, increment `nextRevision`, and render `Saved`. On `409`, set `Wardrobe changed elsewhere — refresh required`, disable Save and Discard, reveal Reload Wardrobe, and keep the draft visible. Reload Wardrobe calls `location.reload()`; no stale request is retried.

Use:

```js
window.addEventListener('beforeunload', function (event) {
  if (operations().length === 0) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('pageshow', function (event) {
  if (event.persisted) location.reload();
});
```

- [ ] **Step 7: Run focused browser behavior, route, and syntax checks**

Run:

```bash
npm test -- tests/dye-draft.test.ts tests/dye-client-behavior.test.ts tests/web-dye.test.ts
node --check src/web/public/dye-draft.js
node --check src/web/public/dye.js
npm run typecheck
```

Expected: all selected checks pass.

- [ ] **Step 8: Commit**

```bash
git add src/web/public/dye-draft.js src/web/public/dye.js src/web/views/character-sheet.ejs tests/dye-draft.test.ts tests/dye-client-behavior.test.ts tests/web-dye.test.ts
git commit -m "feat(dye): stage Wardrobe edits until explicit save"
```

---

### Task 4: Animate both Wardrobe frames and polish its controls

**Files:**
- Modify: `src/domain/dye.ts`
- Modify: `src/web/routes/character.ts`
- Modify: `src/web/views/character-sheet.ejs`
- Modify: `src/web/public/dye.js`
- Modify: `src/web/public/dungeon.css`
- Modify: `tests/dye.test.ts`
- Modify: `tests/web-character.test.ts`
- Modify: `tests/dye-client-behavior.test.ts`
- Modify: `tests/dye-css.test.ts`

**Interfaces:**
- Replaces `DyeViewModel.base` and `slotmap` with:

```ts
frames: {
  a: { base: string; slotmap: number[] };
  b: { base: string; slotmap: number[] };
};
```

- Character render data adds `avatarA` and `avatarB`.
- Both preview frames apply the same draft map but their own source pixels and slot map.

- [ ] **Step 1: Write failing A/B view-model and HTML tests**

Assert in `tests/dye.test.ts`:

```ts
expect(model.frames.a.base).toBe(classSpriteUrl('wizard', 'M', 'a'));
expect(model.frames.b.base).toBe(classSpriteUrl('wizard', 'M', 'b'));
expect(model.frames.a.slotmap).not.toEqual([]);
expect(model.frames.b.slotmap).not.toEqual([]);
```

Assert in `tests/web-character.test.ts` that authenticated HTML contains two profile images with `frame-a` and `frame-b`, one Wardrobe canvas, and no `dye-active-label`.

- [ ] **Step 2: Run tests and verify the missing `frames` failure**

Run:

```bash
npm test -- tests/dye.test.ts tests/web-character.test.ts
```

Expected: fail because the view model still has one base and slot map.

- [ ] **Step 3: Emit both source frames and slot maps**

Load both maps with `loadSlotmap(sprite, 'a'|'b', slotmapsDir)`. `available` requires both maps and at least one present slot. Pass both content-addressed profile URLs from the route:

```ts
avatarA: cosmeticSkinUrlForPlayer(db, player, 'a'),
avatarB: cosmeticSkinUrlForPlayer(db, player, 'b'),
```

- [ ] **Step 4: Render and animate both draft canvases**

In `dye.js`, create one 24×24 source/output canvas per frame. Load both images, render both outputs on every draft change, cache their data URLs for the profile images, and alternate the visible Wardrobe frame every 700ms. Do not allocate new canvases inside the animation timer.

The profile header uses the existing `.sprite-anim`, `.frame-a`, and `.frame-b` visibility classes and starts `anim.js` once. Keep `imageSmoothingEnabled = false` everywhere.

- [ ] **Step 5: Apply the approved Wardrobe markup and CSS polish**

Remove the selected-label element. Replace the stage platform with:

```css
.dye-stage::after {
  content:"";
  position:absolute;
  left:50%;
  bottom:54px;
  width:116px;
  height:18px;
  transform:translateX(-50%);
  border-radius:50%;
  background:radial-gradient(ellipse,#000c 0 36%,#0007 48%,transparent 72%);
  filter:blur(2px);
}
```

Use a deeper two-stage drop shadow on `.dye-preview` and profile frames. Give the Tone range explicit `appearance:none`, track, and thumb styles with zero horizontal margin. Change `.dye-finishes` to one column and every `.dye-fin` to the same compact height. Render Restore Default with a 22×22 swatch/icon rather than the current compressed glyph.

- [ ] **Step 6: Extend behavior and CSS tests**

Assert:

- both frame sources load and alternate;
- the same draft affects both frame outputs;
- no selected bubble is written;
- four finishes appear in Steel, Bronze, Gold, Restore order;
- every finish shares the same compact class and Restore is not grid-spanning;
- Tone CSS defines both WebKit and Mozilla track/thumb rules;
- the stage shadow contains no brown palette values used by the removed platform.

- [ ] **Step 7: Run focused checks**

Run:

```bash
npm test -- tests/dye.test.ts tests/web-character.test.ts tests/dye-client-behavior.test.ts tests/dye-css.test.ts tests/anim.test.ts
node --check src/web/public/dye.js
npm run typecheck
```

Expected: all selected checks pass.

- [ ] **Step 8: Commit**

```bash
git add src/domain/dye.ts src/web/routes/character.ts src/web/views/character-sheet.ejs src/web/public/dye.js src/web/public/dungeon.css tests/dye.test.ts tests/web-character.test.ts tests/dye-client-behavior.test.ts tests/dye-css.test.ts
git commit -m "feat(dye): animate and polish the Wardrobe preview"
```

---

### Task 5: Build the slot-aware next-offer demonstration

**Files:**
- Modify: `src/domain/shopview.ts`
- Modify: `src/web/routes/shop.ts`
- Create: `src/web/public/shop-preview.js`
- Modify: `src/web/views/shop.ejs`
- Modify: `tests/shopview.test.ts`
- Create: `tests/shop-preview.test.ts`
- Modify: `tests/web-shop.test.ts`

**Interfaces:**
- `buildShopViewModel(db, playerId, slotmapsDir?)` adds:

```ts
preview: {
  frames: {
    a: { base: string; slotmap: number[] };
    b: { base: string; slotmap: number[] };
  };
  config: Record<number, SlotRule>;
  demoSlots: number[];
} | null;
```

- Produces browser global `window.__SHOP_PREVIEW__` and auto-initializing `/static/shop-preview.js`.
- `demoSlots` contains only the next offer's present class/gender slots.

- [ ] **Step 1: Write failing view-model tests**

For a Tier 1 female Priest, assert:

```ts
expect(shop.preview?.demoSlots).toEqual([SLOTS.body, SLOTS.skin]);
expect(shop.preview?.frames.a.base).toBe(classSpriteUrl('priest', 'F', 'a'));
expect(shop.preview?.frames.b.base).toBe(classSpriteUrl('priest', 'F', 'b'));
expect(shop.preview?.frames.a.slotmap).toHaveLength(24 * 24);
expect(shop.preview?.frames.b.slotmap).toHaveLength(24 * 24);
```

After Tier 3, assert `preview` is `null`. Seed one owned Tier 1 color and assert it remains in `preview.config` while Tier 2 slots are demo slots.

- [ ] **Step 2: Run and verify view-model failure**

Run:

```bash
npm test -- tests/shopview.test.ts
```

Expected: fail because `preview` and the `slotmapsDir` argument do not exist.

- [ ] **Step 3: Emit read-only source pixels and next-offer slots**

Use `classSpriteUrl`, `spriteId`, `loadSlotmap`, and `getEntitledSlotConfig`. Build the present-slot set from the union of both A/B slot-map arrays, then intersect the offer channels before setting `demoSlots`. Do not use rendered skin URLs as base frames because the client must apply saved and demonstration rules in one pass.

- [ ] **Step 4: Write failing deterministic animation tests**

Load `shop-preview.js` in a VM and test exported helpers:

```js
window.ClaudeRpgShopPreview = {
  hueAt,
  demoRuleFor,
};
```

Assert that `hueAt(0, 0) !== hueAt(0, 1)`, each slot repeats at its own documented duration, hue interpolation crosses 359/0 by the shortest path, and `demoRuleFor` leaves non-demo slots on their saved rule.

- [ ] **Step 5: Implement independent palettes and frame animation**

Use three fixed hue palettes and prime-number durations:

```js
const palettes = [
  [8, 142, 218],
  [286, 38, 176],
  [52, 194, 326],
];
const durations = [5300, 6100, 7100, 7900, 8900];
```

For demo slot index `i`, select palette `i % palettes.length`, duration `durations[i % durations.length]`, and phase `(i * 0.271) % 1`. Use smoothstep interpolation and a shortest-hue delta. Render at no more than 12 frames per second and alternate source frame A/B every 700ms. Apply saved rules to every owned slot and temporary `colorize` rules only to `demoSlots`.

- [ ] **Step 6: Embed the preview safely in `shop.ejs`**

Render one pixelated canvas with an accessible label. Serialize only the preview payload, escaping `<` as `\u003c`, then load:

```ejs
<script src="/static/dye-color.js"></script>
<script>window.__SHOP_PREVIEW__ = <%- JSON.stringify(shop.preview).replace(/</g, '\\u003c') %>;</script>
<script src="/static/shop-preview.js"></script>
```

Do not serialize the auth token into this payload.

- [ ] **Step 7: Run focused tests and syntax checks**

Run:

```bash
npm test -- tests/shopview.test.ts tests/shop-preview.test.ts tests/web-shop.test.ts
node --check src/web/public/shop-preview.js
npm run typecheck
```

Expected: all selected checks pass.

- [ ] **Step 8: Commit**

```bash
git add src/domain/shopview.ts src/web/routes/shop.ts src/web/public/shop-preview.js src/web/views/shop.ejs tests/shopview.test.ts tests/shop-preview.test.ts tests/web-shop.test.ts
git commit -m "feat(shop): preview next-tier channels independently"
```

---

### Task 6: Reshape the Bazaar into the Gilded Mimic marketplace

**Files:**
- Modify: `src/domain/shopview.ts`
- Rewrite: `src/web/views/shop.ejs`
- Modify: `src/web/public/dungeon.css`
- Modify: `tests/shopview.test.ts`
- Modify: `tests/web-shop.test.ts`
- Create: `tests/shop-css.test.ts`

**Interfaces:**
- `ShopOffer` adds `description: string`.
- Produces DOM regions: `.gilded-mimic-head`, `.bazaar-product`, `.bazaar-player`, and `.adventurer-ledger`.
- The ledger is present for authenticated next-offer and mastery states.

- [ ] **Step 1: Write failing copy and structure tests**

For a Tier 2 Wizard, assert the view model description is exactly:

```text
The merchant is offering a permanent upgrade to your dye ledger, which unlocks Gold Trim, Belt, and Boots customizations.
```

Assert authenticated offer HTML contains:

- `The Gilded Mimic`;
- `Permanent Wardrobe Upgrade — Tier 2`;
- one `.bazaar-product`;
- one `.adventurer-ledger`;
- current gold and Wardrobe Tier 1;
- `Inventory` and `Coming Soon`;
- teasers `Potions`, `Loot Boxes`, and `Pets`;
- one Return to Character link in the ledger and none inside the product card;
- existing item asset paths under `/static/landing/`.

Assert the mastery page has no purchase form but retains the ledger.

- [ ] **Step 2: Run and verify structure failures**

Run:

```bash
npm test -- tests/shopview.test.ts tests/web-shop.test.ts
```

Expected: fail on the new copy and marketplace regions.

- [ ] **Step 3: Generate grammatical offer descriptions in the view model**

Add a private formatter:

```ts
function joinChannelLabels(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}
```

Title-case the registry's display labels only in the sentence (`Gold trim` becomes `Gold Trim`) without changing the authoritative registry itself.

- [ ] **Step 4: Rewrite authenticated offer and mastery markup**

Use a compact merchant header with decorative `potion.png`, `sword.png`, `shield.png`, `coins.png`, and `gem_purple.png`. Keep all decorative image alts empty.

The product card contains only category, title, tier badge, description, affordability/result message, price, and purchase button. The player preview sits beside it with no circular pseudo-element.

The Adventurer Ledger contains four stat groups and the Return to Character button. Inventory and future products are literal Coming Soon UI, not database values.

- [ ] **Step 5: Add responsive marketplace CSS tests**

Create `tests/shop-css.test.ts` and assert the stylesheet defines:

- a sticky `.adventurer-ledger`;
- the 760px two-row ledger layout;
- `.bazaar-player` without a circular `::before` backdrop;
- a multi-layer `drop-shadow` on the player canvas;
- compact product padding and a non-fixed card height;
- no `overflow-x` growth from marketplace decoration.

- [ ] **Step 6: Implement the approved marketplace styling**

Keep the current purple panel gradient. Use the existing typography and gold/purple tokens. Product cards use one reusable border/radius/padding pattern suitable for future smaller cards. The authenticated page must fit at 375 CSS pixels with `scrollWidth === innerWidth`.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/shopview.test.ts tests/web-shop.test.ts tests/shop-css.test.ts
npm run typecheck
```

Expected: all selected checks pass.

- [ ] **Step 8: Commit**

```bash
git add src/domain/shopview.ts src/web/views/shop.ejs src/web/public/dungeon.css tests/shopview.test.ts tests/web-shop.test.ts tests/shop-css.test.ts
git commit -m "feat(shop): open the Gilded Mimic marketplace"
```

---

### Task 7: Add the progressive purchase forging effect

**Files:**
- Create: `src/web/public/shop.js`
- Modify: `src/web/views/shop.ejs`
- Modify: `src/web/public/dungeon.css`
- Create: `tests/shop-client-behavior.test.ts`
- Modify: `tests/web-shop.test.ts`
- Modify: `tests/shop-css.test.ts`

**Interfaces:**
- Enhances only `form[data-purchase-effect]`.
- Uses existing form action, token, and SKU; no purchase API or response contract changes.
- Uses `/static/landing/{potion,sword,shield,coins,gem_purple}.png` as decorative burst sprites.

- [ ] **Step 1: Write failing fake-DOM behavior tests**

Follow the fake DOM and fake timer structure in `tests/dye-client-behavior.test.ts`. Cover:

- the first submit prevents default, disables the button, sets `Forging…`, and schedules one native form submission at 1200ms;
- a second submit while forging does nothing;
- five decorative sprites are created inside the fixed burst layer;
- sprites receive different CSS custom-property vectors;
- reduced-motion submits immediately without creating sprites;
- a missing enhancement target leaves normal HTML form behavior untouched.

- [ ] **Step 2: Run and verify the missing-file failure**

Run:

```bash
npm test -- tests/shop-client-behavior.test.ts
```

Expected: fail because `shop.js` does not exist.

- [ ] **Step 3: Implement duplicate-safe progressive enhancement**

On submit, call `event.preventDefault()`, guard a `forging` boolean, disable the button, and set `aria-busy="true"`. Use a fixed-position `.purchase-burst` that cannot change layout dimensions. Create one image per approved asset and set deterministic `--burst-x`, `--burst-y`, `--burst-r`, and `--burst-delay` values. Submit with the prototype-safe native call:

```js
HTMLFormElement.prototype.submit.call(form);
```

If `matchMedia('(prefers-reduced-motion: reduce)').matches`, skip creation and submit without the 1200ms delay.

- [ ] **Step 4: Add the form hook and script**

Add `data-purchase-effect` only to an enabled next-offer form and load `/static/shop.js` with `defer`. Do not attach the effect to login or mastery links.

- [ ] **Step 5: Add bounded motion and reduced-motion CSS**

The product card receives a 300ms low-amplitude jolt. Burst sprites animate from `scale(.65)` to `scale(1.35)` while translating to their vectors and fading. Never animate from `scale(0)`. Keep the burst layer `position:fixed; inset:0; overflow:hidden; pointer-events:none`.

Under reduced motion, remove the jolt and burst keyframes and retain only a brief button glow.

- [ ] **Step 6: Run behavior, HTML, CSS, and syntax checks**

Run:

```bash
npm test -- tests/shop-client-behavior.test.ts tests/web-shop.test.ts tests/shop-css.test.ts
node --check src/web/public/shop.js
npm run typecheck
```

Expected: all selected checks pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/public/shop.js src/web/views/shop.ejs src/web/public/dungeon.css tests/shop-client-behavior.test.ts tests/web-shop.test.ts tests/shop-css.test.ts
git commit -m "feat(shop): celebrate permanent Wardrobe purchases"
```

---

### Task 8: Run the complete regression and local visual acceptance gate

**Files:**
- Modify only if a test or visual defect requires a focused correction.
- Record: `.superpowers/sdd/2026-07-26-wardrobe-bazaar-polish/task-8-report.md` (ignored execution artifact).

**Interfaces:**
- Consumes all previous tasks.
- Produces a clean branch and an isolated local demo awaiting explicit user approval.

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
npm test
npm run typecheck
node --check src/web/public/dye-color.js
node --check src/web/public/dye-draft.js
node --check src/web/public/dye.js
node --check src/web/public/shop-preview.js
node --check src/web/public/shop.js
node --check src/web/public/anim.js
git diff --check
```

Expected: every command exits 0. Record exact file/test counts and any expected stderr in the Task 8 report.

- [ ] **Step 2: Audit persistence and rendering call sites**

Run:

```bash
rg -n "character/dye/(set|clear|save)|getSlotConfig\(|getEntitledSlotConfig\(|cosmeticSkinUrlForPlayer\(" src
```

Confirm:

- `dye.js` calls only `/character/dye/save`;
- raw config remains confined to domain/storage editing;
- public skin, TV, leaderboard, Character, and Bazaar rendering remains entitlement-filtered;
- the Bazaar preview payload contains no token and performs no fetch.

- [ ] **Step 3: Start a fresh isolated demo**

Create and seed the demo with:

```bash
DEMO_ROOT=$(mktemp -d /private/tmp/clauderpg-wardrobe.XXXXXX)
DEMO_DB="$DEMO_ROOT/demo.db"
DEMO_DB="$DEMO_DB" npx tsx -e '
import { openDb } from "./src/db/db";
import { CLASSES, type Gender } from "./src/domain/classes";
import { createPlayer } from "./src/domain/players";
import { purchase } from "./src/domain/shop";
import { seedSettings } from "./src/domain/settings";

const db = openDb(process.env.DEMO_DB!);
seedSettings(db);
let clock = 1_000;
function make(name: string, classKey: string, gender: Gender, tier: number) {
  const player = createPlayer(db, { name, class_key: classKey, gender }, clock++);
  db.prepare("UPDATE players SET gold = ?, effective_tokens = ?, total_tokens = ? WHERE id = ?")
    .run(12_000_000, 2_000, 2_400, player.id);
  for (let next = 1; next <= tier; next += 1) {
    const result = purchase(db, player.id, `cosmetic_wheel_t${next}`, clock++);
    if (!result.ok) throw new Error(`${name}: failed to buy tier ${next}`);
  }
  console.log(`${name}: ${player.auth_token}`);
}
make("Tier Zero Knight", "knight", "F", 0);
make("Tier One Wizard", "wizard", "M", 1);
make("Tier Two Priest", "priest", "F", 2);
make("Tier Three Paladin", "paladin", "M", 3);
for (const characterClass of CLASSES) {
  for (const gender of ["M", "F"] as const) {
    make(`Review ${characterClass.name} ${gender}`, characterClass.key, gender, 3);
  }
}
db.close();
'
```

Use the printed auth tokens for the acceptance URLs. Start the app in a managed foreground terminal session:

```bash
DB_PATH="$DEMO_DB" PORT=8113 ENABLE_COSMETICS_REVIEW=1 npm start
```

If 8113 is occupied, select another port and use that exact port for every browser URL. Do not reuse `data/game.db` or its tint cache.

- [ ] **Step 4: Verify Wardrobe behavior in the in-app browser**

For the Tier 1 Wizard:

1. Edit Clothing hue and Tone, then edit Cloak with Royal Gold.
2. Confirm zero requests occur before Save Changes.
3. Confirm one save request contains both slot operations.
4. Refresh and confirm both changes persist.
5. Stage Restore Default and confirm it remains unsaved until Save.
6. Stage multiple changes, use Discard Changes, and confirm the saved appearance returns.
7. Force one network failure, confirm the draft remains and retry succeeds.
8. Navigate to the Bazaar and Back; confirm no original/stale character flash or Tone mismatch.
9. Confirm both profile and workbench characters alternate A/B frames.
10. Confirm the black ground shadow, deep floating shadow, compact presets, full-width Tone endpoints, and absence of the selected bubble.

- [ ] **Step 5: Verify every Bazaar state**

Confirm Tier 0, Tier 1, and Tier 2 pages each show exactly one next offer with the correct 1.5m, 2m, and 2.5m price. Confirm Tier 3 shows mastery with no form.

For each offer:

- the Gilded Mimic header and item sprites render;
- the product card uses the approved title and generated description;
- the Adventurer Ledger shows fresh gold, current Wardrobe tier, Inventory Coming Soon, future teasers, and Return to Character;
- only offered channels change colors;
- at least two offered channels move asynchronously;
- the A/B player animation continues while colors move;
- the player has no circular backdrop and retains a deep drop shadow.

- [ ] **Step 6: Verify purchase motion and accessibility**

Use a disposable demo player. Confirm one click disables the button, shows Forging, produces the bounded burst, and submits once after about 1.2 seconds. Confirm the redirected page shows the next offer and updated gold/tier. Emulate reduced motion and confirm immediate single submission with no moving burst.

Keyboard-check channel buttons, the hue wheel, Tone slider, material rows, Save, Discard, purchase, and Return to Character. Confirm visible focus and meaningful status announcements.

- [ ] **Step 7: Verify narrow mobile layouts**

At 375 CSS pixels, assert `document.documentElement.scrollWidth === innerWidth` on Character, next-offer Bazaar, and mastery Bazaar. Confirm the Adventurer Ledger wraps to two rows without covering the purchase button and every control remains reachable.

- [ ] **Step 8: Run the animated 18-variant review**

Open `/cosmetics-review`, confirm all 18 male/female cards alternate A/B frames, and verify no approved slot-map pixels changed as a side effect of this polish pass.

- [ ] **Step 9: Stop for explicit visual approval**

Leave the isolated Bazaar, Tier 1 Wardrobe, and animated review tabs open. Report automated evidence, local URLs, and any remaining visual caveats. Do not merge, push, deploy, or start timed consumables until the user explicitly approves this visual gate.

---

## Completion Criteria

- One Save Changes action persists all dirty channels in one SQLite transaction.
- No slider, wheel, preset, channel switch, or Restore Default action writes before Save.
- Back navigation cannot show stale personalized cosmetics or mismatched Tone controls.
- Wardrobe profile and fitting preview animate both sprite frames with draft colors.
- The Bazaar uses the Gilded Mimic header, compact reusable product card, slot-aware asynchronous demonstration, and persistent Adventurer Ledger.
- Purchase motion is duplicate-safe, bounded, progressive, and reduced-motion aware.
- Full tests, typecheck, browser-script syntax, diff checks, desktop/mobile browser checks, and the 18-variant review pass.
- The feature branch remains unpushed and undeployed pending user approval.

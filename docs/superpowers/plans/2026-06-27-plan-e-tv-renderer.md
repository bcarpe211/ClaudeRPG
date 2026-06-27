# Plan E: TV Renderer (Canvas 2D + SSE) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the game on the TV. A full-screen kiosk page renders the live battlefield (procedural dungeon from Plan D + the current monster + heroes attacking) on the right ~75% and a player leaderboard on the left 25%, updating in real time via Server-Sent Events, with hit animations, floating damage, a monster HP bar, level-up flashes, a defeat popup (~2 min), and an idle/pause overlay.

**Architecture:** Server-side **view-model builders** (`tvview.ts`) turn DB state into two JSON payloads — a `layout` (static dungeon: tile/decor/door sprite URLs, monster anchor) and a `state` (monster HP, heroes with positions + per-fight damage, leaderboard, pause, defeat summary). A dependency-free **SSE hub** (`tvhub.ts`) holds connected kiosk clients; the engine's existing tick interval calls `hub.broadcast(db, now)` to push `state` each tick (and `layout` whenever the dungeon changes). The browser kiosk (`public/tv/`) is **Canvas 2D**: it pre-renders the dungeon to an offscreen canvas once per `layout`, then each animation frame blits that background and draws the monster, heroes, HP bar, leaderboard, animations, and overlays from the latest `state`.

**Tech Stack:** Same as A-D. **No new dependencies** (SSE is plain Express `res`; Canvas 2D is the browser). Sprites are served by the existing `/sprites` static mount.

**Testability boundary:** the **server view-model + SSE hub + routes are TDD'd** (these hold all the logic). The **browser renderer is not unit-tested** — it is verified by running the server and viewing `/tv` (Task 6), and tuned visually there. Keep all non-trivial logic server-side so the untested surface is just drawing.

---

## File Structure

```
src/web/
  tvview.ts            (new: buildTvLayout, assignHeroSlots, buildTvState + types)
  tvhub.ts             (new: TvHub SSE broadcaster over a minimal client interface)
  routes/tv.ts         (new: GET /tv page + GET /tv/stream SSE)
  app.ts               (modify: register tv routes; expose hub)
  public/tv/
    index.html         (new: kiosk page shell + canvas)
    tv.js              (new: Canvas 2D renderer + EventSource client)  [visual, untested]
src/index.ts           (modify: broadcast via hub after each engine tick)
tests/
  tvview-layout.test.ts
  tvview-state.test.ts
  tvhub.test.ts
  web-tv.test.ts
```

**Conventions:** ESM, extensionless imports, `import type Database`. Builders take explicit `now`. Reuse Plan D `currentLayout`/`worldSpriteUrl`, Plan C `loadEngineConfig`/`getGameState`/`buildDefeatSummary`, Plan B `sumEffectiveSince`, Plan A `classSpriteUrl`/`creatureSpriteFile`. Tests use `openDb(':memory:')` + `seedSettings`.

---

## Task 1: Layout view-model + hero-slot assignment (`src/web/tvview.ts`)

**Files:**
- Create: `src/web/tvview.ts`
- Test: `tests/tvview-layout.test.ts`

- [ ] **Step 1: Write the failing test** `tests/tvview-layout.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { buildTvLayout, assignHeroSlots } from '../src/web/tvview';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('assignHeroSlots', () => {
  it('zips players to slots in order; extras get no slot', () => {
    const players = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const slots = [{ x: 5, y: 5 }, { x: 6, y: 6 }];
    const out = assignHeroSlots(players, slots);
    expect(out).toEqual([
      { id: 1, x: 5, y: 5 },
      { id: 2, x: 6, y: 6 },
      { id: 3, x: null, y: null },
    ]);
  });
});

describe('buildTvLayout', () => {
  it('returns null when no dungeon is active', () => {
    expect(buildTvLayout(db)).toBeNull();
  });

  it('maps the active dungeon to sprite URLs', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const layout = buildTvLayout(db)!;
    expect(layout).not.toBeNull();
    expect(layout.width).toBe(20);
    expect(layout.height).toBe(15);
    expect(layout.dungeonId).toBeGreaterThan(0);
    // every cell has a /sprites/world_24x24/ url and a type
    for (const row of layout.cells) for (const c of row) {
      expect(c.url.startsWith('/sprites/world_24x24/')).toBe(true);
      expect(['wall', 'floor', 'door']).toContain(c.type);
    }
    expect(layout.monster.x).toBeGreaterThan(0);
    for (const d of layout.decor) expect(d.url.startsWith('/sprites/world_24x24/')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tvview-layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/tvview.ts`** (layout half; state half added in Task 2)

```ts
import type Database from 'better-sqlite3';
import { currentLayout } from '../domain/dungeon';
import { worldSpriteUrl } from '../domain/tilemanifest';

export interface TvLayoutCell { type: string; url: string; }
export interface TvLayout {
  dungeonId: number;
  theme: string;
  width: number;
  height: number;
  cells: TvLayoutCell[][];
  doors: { x: number; y: number }[];
  monster: { x: number; y: number; footprint: number };
  decor: { x: number; y: number; url: string }[];
}

/** Map the active dungeon layout to a sprite-URL payload for the TV, or null. */
export function buildTvLayout(db: Database.Database): TvLayout | null {
  const layout = currentLayout(db);
  if (!layout) return null;
  const gs = db.prepare('SELECT current_dungeon_id FROM game_state WHERE id=1').get() as any;
  return {
    dungeonId: gs.current_dungeon_id,
    theme: layout.theme,
    width: layout.width,
    height: layout.height,
    cells: layout.cells.map((row) =>
      row.map((c) => ({ type: c.type, url: worldSpriteUrl(c.sprite) })),
    ),
    doors: layout.doors,
    monster: layout.monster,
    decor: layout.decor.map((d) => ({ x: d.x, y: d.y, url: worldSpriteUrl(d.sprite) })),
  };
}

/** Zip players (in order) onto slot coordinates; extras get {x:null,y:null}. */
export function assignHeroSlots<T extends { id: number }>(
  players: T[],
  slots: { x: number; y: number }[],
): (T & { x: number | null; y: number | null })[] {
  return players.map((p, i) => ({
    ...p,
    x: i < slots.length ? slots[i].x : null,
    y: i < slots.length ? slots[i].y : null,
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tvview-layout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/tvview.ts tests/tvview-layout.test.ts
git commit -m "feat: TV layout view-model + hero-slot assignment"
```

---

## Task 2: State view-model (`buildTvState`)

**Files:**
- Modify: `src/web/tvview.ts`
- Test: `tests/tvview-state.test.ts`

`buildTvState` is the per-tick snapshot: monster, heroes (with positions + per-fight damage), leaderboard, pause, and defeat summary. It recomputes each player's `tokenModifier` exactly as the engine does (recent effective tokens ÷ K, floor 1.0).

- [ ] **Step 1: Write the failing test** `tests/tvview-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { buildTvState } from '../src/web/tvview';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('buildTvState', () => {
  it('reports paused with no encounter when the office is idle', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const s = buildTvState(db, 100000);
    expect(s.paused).toBe(true);
    expect(s.encounter).toBeNull();
    expect(s.players.length).toBe(1);
    expect(s.defeat).toBeNull();
  });

  it('reports the active encounter, hero positions, modifier, and sorted leaderboard', () => {
    const a = createPlayer(db, { name: 'Big', class_key: 'wizard', gender: 'M' }, 1);
    const b = createPlayer(db, { name: 'Small', class_key: 'thief', gender: 'F' }, 1);
    ingestTokenUsage(db, tokens(a.auth_token, 40000), 100000, { cacheReadWeight: 0 }); // bigger
    ingestTokenUsage(db, tokens(b.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const s = buildTvState(db, 100000);
    expect(s.paused).toBe(false);
    expect(s.encounter).not.toBeNull();
    expect(s.encounter!.hp).toBeLessThanOrEqual(s.encounter!.maxHp);
    expect(s.encounter!.creatureUrl.startsWith('/sprites/creatures_24x24/')).toBe(true);
    // leaderboard sorted by effective tokens desc -> Big first
    expect(s.players[0].name).toBe('Big');
    expect(s.players[0].avatarUrl.startsWith('/sprites/creatures_24x24/')).toBe(true);
    expect(s.players[0].modifier).toBeGreaterThan(1); // recent tokens raise it
    // enabled players get battlefield coordinates
    const placed = s.players.filter((p) => p.x !== null);
    expect(placed.length).toBe(2);
  });

  it('includes a defeat summary during the defeat window', () => {
    setSetting(db, 'min_encounter_hp', '1');
    setSetting(db, 'target_battle_minutes', '0');
    setSetting(db, 'popup_duration_s', '120');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const encId = (db.prepare('SELECT id FROM encounters WHERE status=\'active\'').get() as any).id;
    for (let t = 1; t <= 30 && (db.prepare('SELECT current_hp FROM encounters WHERE id=?').get(encId) as any).current_hp > 0; t++) {
      eng.tick(100000 + t * 1000);
    }
    const s = buildTvState(db, 100000 + 31000);
    expect(s.defeat).not.toBeNull();
    expect(s.defeat!.participants.length).toBeGreaterThanOrEqual(1);
    expect(s.defeat!.creatureUrl.startsWith('/sprites/creatures_24x24/')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tvview-state.test.ts`
Expected: FAIL — `buildTvState` not exported.

- [ ] **Step 3: Append to `src/web/tvview.ts`**

```ts
import { getGameState } from '../domain/gamestate';
import { loadEngineConfig } from '../domain/encounters';
import { sumEffectiveSince } from '../domain/ingest';
import { tokenModifier } from '../domain/combat';
import { classSpriteUrl, creatureSpriteFile, type Gender } from '../domain/classes';
import { buildDefeatSummary, type DefeatSummary } from '../domain/engine';

export function creatureSpriteUrl(index: number): string {
  return `/sprites/creatures_24x24/${creatureSpriteFile(index)}`;
}

export interface TvEncounter {
  id: number; creatureIndex: number; creatureUrl: string;
  footprint: number; kind: string; packCount: number;
  hp: number; maxHp: number;
}
export interface TvHero {
  id: number; name: string; avatarUrl: string; level: number;
  totalTokens: number; effectiveTokens: number; gold: number;
  modifier: number; disabled: boolean; connected: boolean;
  damage: number; x: number | null; y: number | null;
}
export interface TvDefeat extends DefeatSummary { creatureUrl: string; }
export interface TvState {
  dungeonId: number | null;
  paused: boolean;
  encounter: TvEncounter | null;
  players: TvHero[];
  defeat: TvDefeat | null;
}

export function buildTvState(db: Database.Database, now: number): TvState {
  const cfg = loadEngineConfig(db);
  const gs = getGameState(db);
  const since = now - cfg.recentWindowMinutes * 60_000;

  // Encounter (active only).
  let encounter: TvEncounter | null = null;
  if (gs.current_encounter_id) {
    const e = db.prepare('SELECT * FROM encounters WHERE id=?').get(gs.current_encounter_id) as any;
    if (e && e.status === 'active') {
      encounter = {
        id: e.id, creatureIndex: e.creature_index, creatureUrl: creatureSpriteUrl(e.creature_index),
        footprint: e.footprint, kind: e.kind, packCount: e.pack_count,
        hp: e.current_hp, maxHp: e.max_hp,
      };
    }
  }

  // Per-fight damage for the current encounter.
  const dmgByPlayer = new Map<number, number>();
  if (encounter) {
    for (const r of db.prepare('SELECT player_id, damage_total FROM encounter_damage WHERE encounter_id=?')
      .all(encounter.id) as any[]) dmgByPlayer.set(r.player_id, r.damage_total);
  }

  // Players: leaderboard order (effective tokens desc), enabled ones get slots.
  const rows = db.prepare(
    'SELECT * FROM players ORDER BY effective_tokens DESC, id ASC',
  ).all() as any[];
  const players: TvHero[] = rows.map((p) => ({
    id: p.id, name: p.name, avatarUrl: classSpriteUrl(p.class_key, p.gender as Gender),
    level: p.level, totalTokens: p.total_tokens, effectiveTokens: p.effective_tokens,
    gold: p.gold, modifier: tokenModifier(sumEffectiveSince(db, p.id, since), cfg.tokenModifierK),
    disabled: !!p.disabled, connected: p.last_token_at != null,
    damage: dmgByPlayer.get(p.id) ?? 0, x: null, y: null,
  }));

  // Assign battlefield slots to enabled players (same order) from the layout.
  const layout = currentLayout(db);
  if (layout) {
    const enabled = players.filter((p) => !p.disabled);
    const placed = assignHeroSlots(enabled, layout.heroSlots);
    const pos = new Map(placed.map((p) => [p.id, { x: p.x, y: p.y }]));
    for (const p of players) {
      const xy = pos.get(p.id);
      if (xy) { p.x = xy.x; p.y = xy.y; }
    }
  }

  // Defeat popup during the window.
  let defeat: TvDefeat | null = null;
  if (gs.defeat_until && now < gs.defeat_until && gs.last_defeat_encounter_id) {
    const summary = buildDefeatSummary(db, gs.last_defeat_encounter_id);
    defeat = { ...summary, creatureUrl: creatureSpriteUrl(summary.creatureIndex) };
  }

  return { dungeonId: gs.current_dungeon_id, paused: !!gs.paused, encounter, players, defeat };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tvview-state.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: green; zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/tvview.ts tests/tvview-state.test.ts
git commit -m "feat: TV state view-model (encounter, heroes, leaderboard, defeat)"
```

---

## Task 3: SSE hub (`src/web/tvhub.ts`)

**Files:**
- Create: `src/web/tvhub.ts`
- Test: `tests/tvhub.test.ts`

The hub is testable without real sockets: clients are any object with `write(s: string)`. It sends each client the current `layout` then `state` on join, and on `broadcast` sends `state` to all (plus a fresh `layout` first whenever the dungeon id changed).

- [ ] **Step 1: Write the failing test** `tests/tvhub.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { TvHub } from '../src/web/tvhub';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

function fakeClient() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => { chunks.push(s); } };
}
function events(chunks: string[]) {
  // parse SSE frames -> [{event, data}]
  return chunks.join('').split('\n\n').filter(Boolean).map((frame) => {
    const ev = /event: (.*)/.exec(frame)?.[1];
    const data = /data: (.*)/.exec(frame)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

describe('TvHub', () => {
  it('sends state (and layout if a dungeon exists) to a new client', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const hub = new TvHub(db);
    const c = fakeClient();
    hub.addClient(c, 100000);
    const evs = events(c.chunks);
    expect(evs.some((e) => e.event === 'layout')).toBe(true);
    expect(evs.some((e) => e.event === 'state')).toBe(true);
  });

  it('broadcast pushes state to all clients and a layout only when the dungeon changes', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const hub = new TvHub(db);
    const c = fakeClient();
    hub.addClient(c, 100000);
    c.chunks.length = 0; // clear join frames
    hub.broadcast(100000 + 1000);
    const evs = events(c.chunks);
    expect(evs.filter((e) => e.event === 'state').length).toBe(1);
    expect(evs.filter((e) => e.event === 'layout').length).toBe(0); // same dungeon
  });

  it('removeClient stops further writes', () => {
    const hub = new TvHub(db);
    const c = fakeClient();
    hub.addClient(c, 1);
    hub.removeClient(c);
    c.chunks.length = 0;
    hub.broadcast(2);
    expect(c.chunks.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tvhub.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/tvhub.ts`**

```ts
import type Database from 'better-sqlite3';
import { buildTvLayout, buildTvState } from './tvview';

export interface SseClient {
  write(chunk: string): void;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class TvHub {
  private clients = new Set<SseClient>();
  private lastDungeonId: number | null = null;

  constructor(private db: Database.Database) {}

  addClient(client: SseClient, now: number): void {
    this.clients.add(client);
    const layout = buildTvLayout(this.db);
    if (layout) {
      client.write(frame('layout', layout));
      this.lastDungeonId = layout.dungeonId;
    }
    client.write(frame('state', buildTvState(this.db, now)));
  }

  removeClient(client: SseClient): void {
    this.clients.delete(client);
  }

  /** Push state to all clients; prepend a layout whenever the dungeon changed. */
  broadcast(now: number): void {
    if (this.clients.size === 0) return;
    const state = buildTvState(this.db, now);
    if (state.dungeonId !== this.lastDungeonId) {
      const layout = buildTvLayout(this.db);
      if (layout) {
        const f = frame('layout', layout);
        for (const c of this.clients) this.safeWrite(c, f);
      }
      this.lastDungeonId = state.dungeonId;
    }
    const sf = frame('state', state);
    for (const c of this.clients) this.safeWrite(c, sf);
  }

  private safeWrite(c: SseClient, f: string): void {
    try { c.write(f); } catch { this.clients.delete(c); }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tvhub.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/tvhub.ts tests/tvhub.test.ts
git commit -m "feat: SSE hub broadcasting TV layout/state"
```

---

## Task 4: TV routes + wire broadcast into the engine loop

**Files:**
- Create: `src/web/routes/tv.ts`
- Modify: `src/web/app.ts`, `src/index.ts`
- Test: `tests/web-tv.test.ts`

The hub must be shared between the route (clients subscribe) and `index.ts` (the tick broadcasts). `createApp` will construct a `TvHub` and expose it on the returned app so `index.ts` can call `broadcast` after each tick.

- [ ] **Step 1: Write the failing test** `tests/web-tv.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); app = createApp({ db, config: loadConfig({}) }); });

describe('TV routes', () => {
  it('GET /tv serves the kiosk page', async () => {
    const res = await request(app).get('/tv');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<canvas');
    expect(res.text).toContain('/static/tv/tv.js');
  });

  it('exposes a tvHub on the app for the tick loop', () => {
    expect((app as any).tvHub).toBeDefined();
    expect(typeof (app as any).tvHub.broadcast).toBe('function');
  });

  it('GET /tv/stream opens an SSE stream with the right headers', async () => {
    // Use a hard timeout: SSE never ends, so we just assert the response head.
    const res = await request(app).get('/tv/stream').buffer(false).parse((r, cb) => {
      r.on('data', () => {}); // drain
      // give it a tick then resolve with headers already available
      setTimeout(() => cb(null, ''), 50);
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/web-tv.test.ts`
Expected: FAIL — `/tv` 404 / no tvHub.

- [ ] **Step 3: Implement `src/web/routes/tv.ts`**

```ts
import express, { type Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app';
import type { TvHub } from '../tvhub';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function registerTvRoutes(app: Express, _deps: AppDeps, hub: TvHub): void {
  app.get('/tv', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'tv', 'index.html'));
  });

  app.get('/tv/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const client = { write: (chunk: string) => res.write(chunk) };
    hub.addClient(client, Date.now());
    req.on('close', () => hub.removeClient(client));
  });
}
```

- [ ] **Step 4: Wire into `src/web/app.ts`**

Add imports near the others:

```ts
import { TvHub } from './tvhub';
import { registerTvRoutes } from './routes/tv';
```

Inside `createApp`, after the other `registerXxxRoutes(...)` calls and before the error-handling middleware, add:

```ts
  const tvHub = new TvHub(db);
  registerTvRoutes(app, { db, config }, tvHub);
  (app as unknown as { tvHub: TvHub }).tvHub = tvHub;
```

- [ ] **Step 5: Broadcast after each tick in `src/index.ts`**

Update the existing engine interval so it broadcasts after ticking. Replace the `setInterval(...)` body so it reads:

```ts
const tvHub = (app as unknown as { tvHub: import('./web/tvhub').TvHub }).tvHub;
setInterval(() => {
  try {
    engine.tick(Date.now());
    tvHub.broadcast(Date.now());
  } catch (err) {
    console.error('[ClaudeRPG] engine tick error:', err);
  }
}, tickMs);
```

(Keep the existing `engine`, `tickMs`, and startup log. `app` is already in scope from `createApp`.)

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/web-tv.test.ts`
Expected: PASS (3 tests). If the SSE header test is flaky under supertest, simplify it to assert via a raw `http` request to a `listen()`ed app; keep the `/tv` page and `tvHub` assertions intact.

- [ ] **Step 7: Run full suite + typecheck, then commit**

```bash
npm test && npm run typecheck
git add src/web/routes/tv.ts src/web/app.ts src/index.ts tests/web-tv.test.ts
git commit -m "feat: /tv kiosk route + SSE stream wired to the engine tick"
```

---

## Task 5: Canvas 2D kiosk renderer (`public/tv/`) — visual, not unit-tested

**Files:**
- Create: `src/web/public/tv/index.html`, `src/web/public/tv/tv.js`

This is the browser renderer. It is **not** unit-tested; it is verified in Task 6. Implement it exactly as below.

- [ ] **Step 1: Create `src/web/public/tv/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClaudeRPG — TV</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0e0b14; overflow: hidden; }
    #stage { display: block; width: 100vw; height: 100vh; image-rendering: pixelated; }
  </style>
</head>
<body>
  <canvas id="stage"></canvas>
  <script src="/static/tv/tv.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/web/public/tv/tv.js`**

```js
'use strict';
// ClaudeRPG TV renderer: Canvas 2D, SSE-driven. Background (dungeon) is
// pre-rendered once per layout to an offscreen canvas; dynamic actors draw on top.

const TILE = 24;            // source tile size
const SIDEBAR_FRAC = 0.25;  // leaderboard width fraction

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const imgCache = new Map();
function img(url) {
  let im = imgCache.get(url);
  if (!im) { im = new Image(); im.src = url; imgCache.set(url, im); }
  return im;
}

let layout = null;       // last 'layout' payload
let bg = null;           // offscreen canvas of the dungeon
let state = null;        // last 'state' payload
let scale = 6, tilePx = TILE * 6, sidebarW = 0, fieldX = 0;
const anim = new Map();  // playerId -> {until, lastDamage} for swing flashes
const floaters = [];     // {x,y,text,born}

function computeScale() {
  const vw = canvas.width, vh = canvas.height;
  const fieldW = vw * (1 - SIDEBAR_FRAC);
  scale = Math.max(1, Math.floor(Math.min(fieldW / (20 * TILE), vh / (15 * TILE))));
  tilePx = TILE * scale;
  sidebarW = vw - 20 * tilePx;
  fieldX = sidebarW;
}

function resize() {
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1);
  computeScale();
  bg = null; // force background rebuild at new scale
}
window.addEventListener('resize', resize);

function buildBackground() {
  if (!layout) return;
  bg = document.createElement('canvas');
  bg.width = 20 * tilePx; bg.height = 15 * tilePx;
  const b = bg.getContext('2d');
  b.imageSmoothingEnabled = false;
  let pending = 0;
  const draw = () => {
    b.clearRect(0, 0, bg.width, bg.height);
    for (let y = 0; y < layout.height; y++)
      for (let x = 0; x < layout.width; x++)
        b.drawImage(img(layout.cells[y][x].url), x * tilePx, y * tilePx, tilePx, tilePx);
    for (const d of layout.decor)
      b.drawImage(img(d.url), d.x * tilePx, d.y * tilePx, tilePx, tilePx);
  };
  // draw once now and again as images finish loading
  draw();
  for (const row of layout.cells) for (const c of row) {
    const im = img(c.url);
    if (!im.complete) { pending++; im.onload = () => { draw(); }; }
  }
}

const evt = new EventSource('/tv/stream');
evt.addEventListener('layout', (e) => { layout = JSON.parse(e.data); buildBackground(); });
evt.addEventListener('state', (e) => {
  const next = JSON.parse(e.data);
  // detect swings: a player's per-fight damage increased -> flash + floater
  if (state && next.encounter && state.encounter && next.encounter.id === state.encounter.id) {
    const prev = new Map(state.players.map((p) => [p.id, p.damage]));
    for (const p of next.players) {
      const before = prev.get(p.id) ?? 0;
      if (p.x !== null && p.damage > before) {
        anim.set(p.id, { until: performance.now() + 350 });
        floaters.push({ x: p.x, y: p.y, text: '-' + (p.damage - before), born: performance.now() });
      }
    }
  }
  state = next;
});

function drawSprite(im, cx, cy, w, h) {
  ctx.drawImage(im, Math.round(cx - w / 2), Math.round(cy - h), w, h);
}

function render(t) {
  requestAnimationFrame(render);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // sidebar background + wall-tile border feel
  ctx.fillStyle = '#171019';
  ctx.fillRect(0, 0, sidebarW, canvas.height);
  ctx.fillStyle = '#0e0b14';
  ctx.fillRect(fieldX, 0, canvas.width - fieldX, canvas.height);

  if (bg) ctx.drawImage(bg, fieldX, 0);

  if (state) {
    drawMonster();
    drawHeroes(t);
    drawHpBar();
    drawFloaters(t);
    drawLeaderboard();
    if (state.paused) drawOverlay('The dungeon rests… awaiting adventurers');
    if (state.defeat) drawDefeat();
  }
}

function tileToField(x, y) { return { px: fieldX + x * tilePx, py: y * tilePx }; }

function drawMonster() {
  const e = state.encounter; if (!e || !layout) return;
  const m = layout.monster;
  const fp = e.footprint;                       // 1 or 2
  const visScale = fp === 2 ? 2.2 : 1.4;        // bosses loom larger
  const size = TILE * scale * visScale;
  const { px, py } = tileToField(m.x + fp / 2, m.y + fp);
  drawSprite(img(e.creatureUrl), px, py, size, size);
  // pack: a couple of small duplicates beside it
  if (e.kind === 'pack') {
    for (let i = 1; i <= Math.min(3, e.packCount - 1); i++)
      drawSprite(img(e.creatureUrl), px + i * tilePx * 0.6, py, size * 0.7, size * 0.7);
  }
}

function drawHeroes(t) {
  for (const p of state.players) {
    if (p.x === null) continue;
    const a = anim.get(p.id);
    const lunge = a && a.until > performance.now() ? 0.25 : 0;
    const { px, py } = tileToField(p.x + 0.5, p.y + 1 + lunge);
    const w = 26 * scale, h = 28 * scale;
    if (a && a.until > performance.now()) ctx.globalAlpha = 0.85;
    drawSprite(img(p.avatarUrl), px, py, w, h);
    ctx.globalAlpha = 1;
  }
}

function drawHpBar() {
  const e = state.encounter; if (!e) return;
  const w = (canvas.width - fieldX) * 0.6, h = 22 * (scale / 3), x = fieldX + ((canvas.width - fieldX) - w) / 2, y = 10;
  ctx.fillStyle = '#000a'; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.fillStyle = '#3a0d0d'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d23b3b'; ctx.fillRect(x, y, w * Math.max(0, e.hp / e.maxHp), h);
  ctx.fillStyle = '#fff'; ctx.font = `${Math.round(h * 0.7)}px system-ui`; ctx.textAlign = 'center';
  ctx.fillText(`${e.hp.toLocaleString()} / ${e.maxHp.toLocaleString()}`, x + w / 2, y + h * 0.75);
}

function drawFloaters(t) {
  ctx.textAlign = 'center';
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; const age = performance.now() - f.born;
    if (age > 900) { floaters.splice(i, 1); continue; }
    const { px, py } = tileToField(f.x + 0.5, f.y);
    ctx.globalAlpha = 1 - age / 900;
    ctx.fillStyle = '#ffd36a'; ctx.font = `${Math.round(10 * scale)}px system-ui`;
    ctx.fillText(f.text, px, py - age * 0.05);
    ctx.globalAlpha = 1;
  }
}

function drawLeaderboard() {
  const pad = Math.round(sidebarW * 0.04);
  let y = pad;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8c96a'; ctx.font = `bold ${Math.round(sidebarW * 0.07)}px system-ui`;
  ctx.fillText('LEADERBOARD', pad, y + sidebarW * 0.06); y += sidebarW * 0.11;
  const rowH = Math.min((canvas.height - y - pad) / Math.max(1, state.players.length), sidebarW * 0.12);
  for (const p of state.players) {
    ctx.globalAlpha = p.disabled ? 0.4 : 1;
    ctx.drawImage(img(p.avatarUrl), pad, y, rowH * 0.8, rowH * 0.85);
    ctx.fillStyle = '#cdb9e0'; ctx.font = `${Math.round(rowH * 0.34)}px system-ui`;
    ctx.fillText(p.name, pad + rowH, y + rowH * 0.36);
    ctx.fillStyle = '#9a86b0'; ctx.font = `${Math.round(rowH * 0.28)}px system-ui`;
    ctx.fillText(`L${p.level}  ${p.effectiveTokens.toLocaleString()} tok  ${p.gold}g  x${p.modifier.toFixed(2)}`,
      pad + rowH, y + rowH * 0.72);
    ctx.globalAlpha = 1;
    y += rowH;
  }
}

function drawOverlay(text) {
  ctx.fillStyle = '#000a';
  ctx.fillRect(fieldX, 0, canvas.width - fieldX, canvas.height);
  ctx.fillStyle = '#e8c96a'; ctx.textAlign = 'center';
  ctx.font = `${Math.round(20 * scale)}px system-ui`;
  ctx.fillText(text, fieldX + (canvas.width - fieldX) / 2, canvas.height / 2);
}

function drawDefeat() {
  const d = state.defeat;
  const w = (canvas.width - fieldX) * 0.7, h = canvas.height * 0.7;
  const x = fieldX + ((canvas.width - fieldX) - w) / 2, y = (canvas.height - h) / 2;
  ctx.fillStyle = '#1a1022ee'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#6b5436'; ctx.lineWidth = 4; ctx.strokeRect(x, y, w, h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8c96a'; ctx.font = `bold ${Math.round(h * 0.07)}px system-ui`;
  ctx.fillText('MONSTER DEFEATED!', x + w / 2, y + h * 0.12);
  ctx.drawImage(img(d.creatureUrl), x + w / 2 - h * 0.08, y + h * 0.14, h * 0.16, h * 0.16);
  ctx.font = `${Math.round(h * 0.045)}px system-ui`; ctx.fillStyle = '#cdb9e0';
  ctx.fillText(`Total damage ${d.totalDamage.toLocaleString()}`, x + w / 2, y + h * 0.4);
  ctx.textAlign = 'left';
  let ry = y + h * 0.48;
  const ranked = [...d.participants].sort((a, b) => b.damage - a.damage).slice(0, 10);
  for (const p of ranked) {
    const mvp = p.playerId === d.mvpPlayerId ? '★ ' : '   ';
    ctx.fillStyle = p.playerId === d.mvpPlayerId ? '#ffd36a' : '#cdb9e0';
    ctx.font = `${Math.round(h * 0.04)}px system-ui`;
    const pct = d.totalDamage ? Math.round((p.damage / d.totalDamage) * 100) : 0;
    ctx.fillText(`${mvp}${p.name}  ${p.damage.toLocaleString()} (${pct}%)  +${p.gold}g` +
      (p.leveledTo ? `  ⬆L${p.leveledTo}` : ''), x + w * 0.1, ry);
    ry += h * 0.055;
  }
}

resize();
requestAnimationFrame(render);
```

- [ ] **Step 3: Run full suite + typecheck** (server code unaffected; confirms nothing broke)

Run: `npm test && npm run typecheck`
Expected: green; zero type errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/public/tv/index.html src/web/public/tv/tv.js
git commit -m "feat: Canvas 2D TV kiosk renderer (battlefield, leaderboard, popup)"
```

---

## Task 6: Visual verification + tuning

**Files:** none required (tuning may touch `src/domain/tilemanifest.ts` and `tv.js` constants)

- [ ] **Step 1: Boot the server with a fast, easy-to-watch config**

```bash
rm -f ./data/smokee.db*
ADMIN_PASSWORD=test123 PORT=8095 DB_PATH=./data/smokee.db npm start &
SMOKE_PID=$!
sleep 3
# Register two players and feed tokens so the engine wakes and fights:
for NAME in Aragorn Gandalf; do
  CLS=$( [ "$NAME" = Aragorn ] && echo knight || echo wizard )
  TOK=$(curl -s -X POST http://localhost:8095/register -d "name=$NAME&class_key=$CLS&gender=M" \
    | grep -oE 'claude_rpg_token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
  curl -s -o /dev/null -X POST http://localhost:8095/v1/metrics -H 'Content-Type: application/json' \
    -d "{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"claude_rpg_token\",\"value\":{\"stringValue\":\"$TOK\"}}]},\"scopeMetrics\":[{\"metrics\":[{\"name\":\"claude_code.token.usage\",\"sum\":{\"aggregationTemporality\":1,\"dataPoints\":[{\"asInt\":\"80000\",\"startTimeUnixNano\":\"1\",\"timeUnixNano\":\"2\",\"attributes\":[{\"key\":\"type\",\"value\":{\"stringValue\":\"input\"}}]}]}}]}]}]}"
done
```

- [ ] **Step 2: Confirm the SSE stream emits a layout then state** (automated sanity check)

```bash
curl -s -N -H 'Accept: text/event-stream' http://localhost:8095/tv/stream &
CURL=$!; sleep 2; kill $CURL 2>/dev/null
```
Expect to see `event: layout` followed by `event: state` frames with JSON payloads (encounter hp, players with x/y, creatureUrl). If not, STOP and report.

- [ ] **Step 3: View the TV in a real browser**

The renderer must be seen to be verified. Open **http://localhost:8095/tv** in a browser (Chrome/Safari on the dev machine). Confirm: the dungeon room draws (walls border + floor + decor + doors), the monster sits center with an HP bar that ticks down, hero avatars stand in the room and flash/lunge with floating damage numbers as they attack, the leaderboard fills the left 25% sorted by tokens, and when a monster dies the defeat popup appears for ~2 min then the next encounter spawns. Try resizing the window (scale should stay integer/crisp).

If a headless screenshot tool is available (e.g. `npx playwright screenshot`), capture `/tv` to a PNG and inspect it; otherwise rely on the human opening the URL.

- [ ] **Step 4: Tune** any obvious visual problems:
  - Tile manifest ids that read wrong (the Plan D implementer flagged: stone floors look-alike, `wood_fort` floor is flagstone not wood, cave door minimal) — swap sprite ids in `src/domain/tilemanifest.ts` (the file-existence test still guards them).
  - Monster/hero `visScale`, sprite sizes, HP-bar/leaderboard font sizes in `tv.js` constants.
  Keep changes minimal and re-view.

- [ ] **Step 5: Clean up + commit any tuning**

```bash
kill $SMOKE_PID 2>/dev/null; rm -f ./data/smokee.db*
npm test && npm run typecheck
# only if you changed files:
git add -A && git commit -m "chore: visual tuning for the TV renderer"
```

- [ ] **Step 6: Report** what you saw (or could not see, if no browser was available) so the human can do a final eyeball.

---

## Self-Review

**Spec coverage (§3 layout/rendering, §8 real-time, §9):**
- Left 25% leaderboard + right 75% battlefield → Task 5 (`SIDEBAR_FRAC`, `computeScale`). ✅
- 20×15 grid, integer scale (6× @4K / 3× @1080p), nearest-neighbor → Task 5 (`computeScale`, `imageSmoothingEnabled=false`). ✅
- Dungeon (Plan D) rendered with tiles/decor/doors → Tasks 1, 5 (background canvas). ✅
- Monster (footprint-scaled, bosses loom; packs show duplicates) + HP bar → Tasks 2, 5. ✅
- Heroes on slots with attack animation + floating damage → Tasks 1/2 (positions, per-fight damage deltas), 5 (lunge/flash/floaters). ✅
- Leaderboard: avatar, name, level, tokens, gold, damage modifier, sorted → Tasks 2, 5. ✅
- Defeat popup (~2 min): per-player damage %, gold, MVP, level-ups → Tasks 2 (defeat summary in state during window), 5 (`drawDefeat`). ✅
- Idle/pause overlay → Tasks 2 (`paused`), 5 (`drawOverlay`). ✅
- Real-time via SSE; `layout` on dungeon change, `state` per tick → Tasks 3, 4. ✅

**Out of scope (deferred):** Pi kiosk autostart/boot (Plan F). Pixel-perfect tile theming is tuned in Task 6 / Plan F on the real TV.

**Placeholder scan:** No TBD/"add error handling"/"similar to". Server code is complete TDD; the client renderer is complete (verified visually in Task 6, not unit-tested by design).

**Type consistency:** `buildTvLayout`/`buildTvState`/`assignHeroSlots`/`creatureSpriteUrl` + `TvLayout`/`TvState`/`TvHero`/`TvEncounter`/`TvDefeat`, `TvHub`/`SseClient`, `registerTvRoutes` are defined once and used consistently. The hub is constructed in `createApp`, exposed as `app.tvHub`, subscribed by the `/tv/stream` route, and driven by `index.ts`'s tick interval. Reuses Plan B-D exports (`sumEffectiveSince`, `tokenModifier`, `loadEngineConfig`, `getGameState`, `buildDefeatSummary`, `currentLayout`, `worldSpriteUrl`, `classSpriteUrl`, `creatureSpriteFile`).

**Determinism/testability:** all view-model logic is server-side and unit-tested with explicit `now`; the SSE hub is tested via a fake `write` client; routes via supertest. The only untested code is the browser drawing, isolated to `tv.js` and verified by viewing `/tv`.

# Rotating Leaderboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single static TV leaderboard with 14 computed boards, rotating a curated 6 on the TV every ~30s (bigger text, titles, ranks, per-board stats), delivered over a separate slow SSE channel; the full set ships for future surfaces.

**Architecture:** A new pure-ish domain module `leaderboards.ts` computes all 14 boards from existing tables (+ a new `peak_modifier` column the engine bumps). `TvHub` broadcasts them on a 15s `leaderboards` SSE event (and on connect), decoupled from the per-tick `state`. `tv.js` stores the payload and rotates the 6 client-side with a crossfade.

**Tech Stack:** Node + TypeScript (tsx/ESM), better-sqlite3, vitest, HTML5 Canvas 2D + SSE.

## Global Constraints

- Node 26 + better-sqlite3 v12; tsx/ESM; tests via `npx vitest run`.
- No new npm dependencies.
- Domain/engine logic is deterministic: only the injected `rng` and passed `now`. `new Date(now)` / `new Date(ts)` with an explicit argument is allowed (only the arg-less `new Date()` / `Date.now()` inside domain logic is disallowed).
- `tv.js` is a dependency-free browser classic script (no imports; mirror constants by hand).
- Disabled players (`players.disabled=1`) are excluded from every board.
- Boards are ranked value-desc, ties broken by `name` ascending.
- Day boundaries use the server's local time, computed in JS.
- Commit after each task's tests pass.

---

### Task 1: `peak_modifier` migration

**Files:**
- Modify: `src/db/migrations.ts` (append to the `migrations` array)
- Test: `tests/db-peak-modifier-migration.test.ts` (create)

**Interfaces:**
- Produces: `players.peak_modifier REAL NOT NULL DEFAULT 1`.

- [ ] **Step 1: Write the failing test**

Create `tests/db-peak-modifier-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';

describe('peak_modifier migration', () => {
  it('adds peak_modifier to players, defaulting to 1', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(players)').all().map((r: any) => r.name);
    expect(cols).toContain('peak_modifier');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const row = db.prepare('SELECT peak_modifier FROM players WHERE id=?').get(p.id) as any;
    expect(row.peak_modifier).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db-peak-modifier-migration.test.ts`
Expected: FAIL — `cols` does not contain `peak_modifier`.

- [ ] **Step 3: Add the migration**

In `src/db/migrations.ts`, append to the `migrations` array (after `005_monster_attacks`):

```ts
  {
    id: '006_peak_modifier',
    sql: `ALTER TABLE players ADD COLUMN peak_modifier REAL NOT NULL DEFAULT 1;`,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db-peak-modifier-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts tests/db-peak-modifier-migration.test.ts
git commit -m "feat(db): players.peak_modifier column (006 migration)"
```

---

### Task 2: `leaderboards.ts` — all 14 boards

**Files:**
- Create: `src/domain/leaderboards.ts`
- Test: `tests/leaderboards.test.ts` (create)

**Interfaces:**
- Consumes: `players.peak_modifier` (Task 1); `classSpriteUrl` (`src/domain/classes.ts`); `activityScore` + `ActivityCfg` (`src/domain/activity.ts`); `tokenModifier` (`src/domain/combat.ts`); tables `players`, `token_events`, `encounter_damage`, `encounters`, `monster_attacks`.
- Produces:
  - `type BoardFormat = 'tokens' | 'gold' | 'count' | 'multiplier' | 'damage' | 'level'`
  - `interface BoardEntry { playerId: number; name: string; avatarUrl: string; value: number }`
  - `interface Leaderboard { key: string; title: string; format: BoardFormat; entries: BoardEntry[] }`
  - `type Leaderboards = Leaderboard[]`
  - `interface LeaderboardCfg extends ActivityCfg { tokenModifierK: number }`
  - `function buildLeaderboards(db, now: number, cfg: LeaderboardCfg): Leaderboards` — the 14 boards in the fixed order below.

Board order (indices used by later tasks' rotation): `overall_tokens, total_damage, gold, level, monsters_slain, mvp_count, biggest_hit, on_fire, peak_multiplier, today_tokens, week_tokens, days_champion, most_battered, most_gold_stolen`.

- [ ] **Step 1: Write the failing test**

Create `tests/leaderboards.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import { buildLeaderboards } from '../src/domain/leaderboards';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

const cfg = { decayAfterMinutes: 5, decaySpanMinutes: 5, tokenModifierK: 20000 };

function mkPlayer(name: string, over: Partial<{ level: number; effective_tokens: number; gold: number; peak_modifier: number; disabled: number }> = {}) {
  const p = createPlayer(db, { name, class_key: 'knight', gender: 'M' }, 1);
  db.prepare('UPDATE players SET level=?, effective_tokens=?, gold=?, peak_modifier=?, disabled=? WHERE id=?')
    .run(over.level ?? 1, over.effective_tokens ?? 0, over.gold ?? 0, over.peak_modifier ?? 1, over.disabled ?? 0, p.id);
  return p.id;
}
function board(bs: ReturnType<typeof buildLeaderboards>, key: string) { return bs.find((b) => b.key === key)!; }
function ids(b: { entries: { playerId: number }[] }) { return b.entries.map((e) => e.playerId); }

// a defeated encounter with per-player damage; returns encounter id
function defeatedEncounter(dmg: { playerId: number; total: number; max: number }[]) {
  db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
  const dId = db.prepare('SELECT MAX(id) m FROM dungeons').get() as any;
  const info = db.prepare(`INSERT INTO encounters
    (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at,ended_at)
    VALUES (?,0,'single',1,1,1,100,0,'defeated',0,1)`).run(dId.m);
  const encId = Number(info.lastInsertRowid);
  for (const d of dmg) db.prepare('INSERT INTO encounter_damage (encounter_id,player_id,damage_total,hits,max_hit) VALUES (?,?,?,1,?)')
    .run(encId, d.playerId, d.total, d.max);
  return encId;
}

describe('buildLeaderboards', () => {
  it('overall tokens: sorted desc, disabled excluded, ties break by name', () => {
    const a = mkPlayer('Bob', { effective_tokens: 100 });
    const b = mkPlayer('Amy', { effective_tokens: 100 });
    const c = mkPlayer('Cara', { effective_tokens: 500 });
    mkPlayer('Dan', { effective_tokens: 999, disabled: 1 });
    const bs = buildLeaderboards(db, 1000, cfg);
    // Cara (500), then Amy/Bob tie at 100 -> name asc (Amy before Bob); Dan excluded
    expect(ids(board(bs, 'overall_tokens'))).toEqual([c, b, a]);
  });

  it('gold, level, peak_multiplier read player columns', () => {
    const a = mkPlayer('A', { gold: 50, level: 3, peak_modifier: 4.2 });
    const b = mkPlayer('B', { gold: 10, level: 9, peak_modifier: 1 });
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(ids(board(bs, 'gold'))).toEqual([a, b]);
    expect(ids(board(bs, 'level'))).toEqual([b, a]);
    expect(ids(board(bs, 'peak_multiplier'))).toEqual([a, b]);
    expect(board(bs, 'peak_multiplier').entries[0].value).toBeCloseTo(4.2);
    expect(board(bs, 'gold').format).toBe('gold');
  });

  it('damage boards: total, biggest hit, monsters slain, mvp count', () => {
    const a = mkPlayer('A');
    const b = mkPlayer('B');
    // enc1: A 30/30, B 70/70  -> B mvp; enc2: A 90/50, B 10/10 -> A mvp
    defeatedEncounter([{ playerId: a, total: 30, max: 30 }, { playerId: b, total: 70, max: 70 }]);
    defeatedEncounter([{ playerId: a, total: 90, max: 50 }, { playerId: b, total: 10, max: 10 }]);
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(board(bs, 'total_damage').entries.find((e) => e.playerId === a)!.value).toBe(120);
    expect(board(bs, 'total_damage').entries.find((e) => e.playerId === b)!.value).toBe(80);
    expect(board(bs, 'biggest_hit').entries.find((e) => e.playerId === b)!.value).toBe(70);
    expect(board(bs, 'monsters_slain').entries.find((e) => e.playerId === a)!.value).toBe(2);
    // each of A and B is MVP of exactly one encounter
    expect(board(bs, 'mvp_count').entries.find((e) => e.playerId === a)!.value).toBe(1);
    expect(board(bs, 'mvp_count').entries.find((e) => e.playerId === b)!.value).toBe(1);
  });

  it('monster_attacks flavor boards', () => {
    const a = mkPlayer('A');
    const b = mkPlayer('B');
    db.prepare('INSERT INTO dungeons (level,theme,seed,regular_count,created_at) VALUES (1,?,1,2,0)').run('Cave');
    db.prepare(`INSERT INTO encounters (dungeon_id,index_in_dungeon,kind,creature_index,footprint,pack_count,max_hp,current_hp,status,started_at) VALUES (1,0,'single',1,1,1,100,100,'active',0)`).run();
    const ins = db.prepare('INSERT INTO monster_attacks (encounter_id,player_id,kind,gold_delta,ts) VALUES (1,?,?,?,0)');
    ins.run(a, 'gold', 5); ins.run(a, 'debuff', 0); ins.run(a, 'gold', 5); // A: 3 hits, 10 gold
    ins.run(b, 'debuff', 0);                                               // B: 1 hit, 0 gold
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(ids(board(bs, 'most_battered'))).toEqual([a, b]);
    expect(board(bs, 'most_battered').entries.find((e) => e.playerId === a)!.value).toBe(3);
    expect(board(bs, 'most_gold_stolen').entries.find((e) => e.playerId === a)!.value).toBe(10);
    expect(board(bs, 'most_gold_stolen').entries.find((e) => e.playerId === b)!.value).toBe(0);
  });

  it('today vs older tokens, and days-as-champion counts per day winner', () => {
    const a = mkPlayer('A');
    const b = mkPlayer('B');
    // Use a fixed "now" and craft events relative to local midnight.
    const now = new Date(2026, 6, 13, 15, 0, 0).getTime(); // Jul 13 2026 15:00 local
    const startToday = new Date(2026, 6, 13, 0, 0, 0).getTime();
    const yesterday = new Date(2026, 6, 12, 10, 0, 0).getTime();
    const ins = db.prepare('INSERT INTO token_events (player_id,ts,effective_delta,total_delta) VALUES (?,?,?,?)');
    // today: A 300, B 100 -> A champion today; today_tokens A>B
    ins.run(a, startToday + 3_600_000, 300, 300);
    ins.run(b, startToday + 3_600_000, 100, 100);
    // yesterday: B 500, A 50 -> B champion yesterday
    ins.run(a, yesterday, 50, 50);
    ins.run(b, yesterday, 500, 500);
    const bs = buildLeaderboards(db, now, cfg);
    expect(board(bs, 'today_tokens').entries.find((e) => e.playerId === a)!.value).toBe(300);
    expect(board(bs, 'today_tokens').entries.find((e) => e.playerId === b)!.value).toBe(100);
    // each won one day
    expect(board(bs, 'days_champion').entries.find((e) => e.playerId === a)!.value).toBe(1);
    expect(board(bs, 'days_champion').entries.find((e) => e.playerId === b)!.value).toBe(1);
  });

  it('returns all 14 boards in the fixed order', () => {
    mkPlayer('A');
    const bs = buildLeaderboards(db, 1000, cfg);
    expect(bs.map((b) => b.key)).toEqual([
      'overall_tokens', 'total_damage', 'gold', 'level', 'monsters_slain', 'mvp_count',
      'biggest_hit', 'on_fire', 'peak_multiplier', 'today_tokens', 'week_tokens',
      'days_champion', 'most_battered', 'most_gold_stolen',
    ]);
    expect(bs.every((b) => b.entries.every((e) => e.avatarUrl.startsWith('/sprites/creatures_24x24/')))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/leaderboards.test.ts`
Expected: FAIL — cannot import from `src/domain/leaderboards`.

- [ ] **Step 3: Write the module**

Create `src/domain/leaderboards.ts`:

```ts
import type Database from 'better-sqlite3';
import { classSpriteUrl, type Gender } from './classes';
import { activityScore, type ActivityCfg } from './activity';
import { tokenModifier } from './combat';

export type BoardFormat = 'tokens' | 'gold' | 'count' | 'multiplier' | 'damage' | 'level';
export interface BoardEntry { playerId: number; name: string; avatarUrl: string; value: number; }
export interface Leaderboard { key: string; title: string; format: BoardFormat; entries: BoardEntry[]; }
export type Leaderboards = Leaderboard[];
export interface LeaderboardCfg extends ActivityCfg { tokenModifierK: number; }

interface PlayerRow {
  id: number; name: string; class_key: string; gender: string;
  level: number; effective_tokens: number; gold: number; peak_modifier: number;
}

const DAY_MS = 86_400_000;

function startOfLocalDay(now: number): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}
function startOfLocalWeek(now: number): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setDate(d.getDate() - dow); return d.getTime();
}
function dayKey(ts: number): string {
  const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function buildLeaderboards(
  db: Database.Database, now: number, cfg: LeaderboardCfg,
): Leaderboards {
  const players = db.prepare(
    'SELECT id, name, class_key, gender, level, effective_tokens, gold, peak_modifier FROM players WHERE disabled = 0',
  ).all() as PlayerRow[];

  const rank = (value: (p: PlayerRow) => number): BoardEntry[] =>
    players
      .map((p) => ({ playerId: p.id, name: p.name, avatarUrl: classSpriteUrl(p.class_key, p.gender as Gender), value: value(p) }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  // Damage aggregates.
  const dmgTotal = new Map<number, number>(), dmgMax = new Map<number, number>();
  for (const r of db.prepare('SELECT player_id, SUM(damage_total) s, MAX(max_hit) m FROM encounter_damage GROUP BY player_id').all() as any[]) {
    dmgTotal.set(r.player_id, r.s ?? 0); dmgMax.set(r.player_id, r.m ?? 0);
  }
  const slain = new Map<number, number>();
  for (const r of db.prepare(
    "SELECT ed.player_id p, COUNT(DISTINCT ed.encounter_id) c FROM encounter_damage ed JOIN encounters e ON e.id = ed.encounter_id WHERE e.status='defeated' GROUP BY ed.player_id",
  ).all() as any[]) slain.set(r.p, r.c);

  // MVP: top damage per defeated encounter (tie -> lowest player_id).
  const mvp = new Map<number, number>(); const seenEnc = new Set<number>();
  for (const r of db.prepare(
    "SELECT ed.encounter_id, ed.player_id FROM encounter_damage ed JOIN encounters e ON e.id = ed.encounter_id WHERE e.status='defeated' ORDER BY ed.encounter_id, ed.damage_total DESC, ed.player_id ASC",
  ).all() as { encounter_id: number; player_id: number }[]) {
    if (seenEnc.has(r.encounter_id)) continue;
    seenEnc.add(r.encounter_id);
    mvp.set(r.player_id, (mvp.get(r.player_id) ?? 0) + 1);
  }

  // Flavor from monster_attacks.
  const battered = new Map<number, number>(), robbed = new Map<number, number>();
  for (const r of db.prepare(
    "SELECT player_id, COUNT(*) c, COALESCE(SUM(CASE WHEN kind='gold' THEN gold_delta ELSE 0 END), 0) g FROM monster_attacks GROUP BY player_id",
  ).all() as any[]) { battered.set(r.player_id, r.c); robbed.set(r.player_id, r.g); }

  // Live: current activity modifier.
  const fire = new Map<number, number>();
  for (const p of players) fire.set(p.id, tokenModifier(activityScore(db, p.id, now, cfg), cfg.tokenModifierK));

  // Windowed: one 90-day scan, bucketed in JS by server-local day.
  const events = db.prepare(
    'SELECT player_id, ts, effective_delta FROM token_events WHERE ts >= ?',
  ).all(now - 90 * DAY_MS) as { player_id: number; ts: number; effective_delta: number }[];
  const startToday = startOfLocalDay(now), startWeek = startOfLocalWeek(now);
  const today = new Map<number, number>(), week = new Map<number, number>();
  const perDay = new Map<string, Map<number, number>>();
  for (const e of events) {
    if (e.ts >= startToday) today.set(e.player_id, (today.get(e.player_id) ?? 0) + e.effective_delta);
    if (e.ts >= startWeek) week.set(e.player_id, (week.get(e.player_id) ?? 0) + e.effective_delta);
    const k = dayKey(e.ts);
    let m = perDay.get(k); if (!m) { m = new Map(); perDay.set(k, m); }
    m.set(e.player_id, (m.get(e.player_id) ?? 0) + e.effective_delta);
  }
  const champ = new Map<number, number>();
  for (const [, m] of perDay) {
    let bestId = -1, bestVal = -Infinity;
    for (const [pid, v] of m) if (v > bestVal || (v === bestVal && pid < bestId)) { bestVal = v; bestId = pid; }
    if (bestId >= 0 && bestVal > 0) champ.set(bestId, (champ.get(bestId) ?? 0) + 1);
  }

  return [
    { key: 'overall_tokens', title: 'Overall Tokens', format: 'tokens', entries: rank((p) => p.effective_tokens) },
    { key: 'total_damage', title: 'Total Damage', format: 'damage', entries: rank((p) => dmgTotal.get(p.id) ?? 0) },
    { key: 'gold', title: 'Gold on Hand', format: 'gold', entries: rank((p) => p.gold) },
    { key: 'level', title: 'Level', format: 'level', entries: rank((p) => p.level) },
    { key: 'monsters_slain', title: 'Monsters Slain', format: 'count', entries: rank((p) => slain.get(p.id) ?? 0) },
    { key: 'mvp_count', title: 'MVP Count', format: 'count', entries: rank((p) => mvp.get(p.id) ?? 0) },
    { key: 'biggest_hit', title: 'Biggest Hit', format: 'damage', entries: rank((p) => dmgMax.get(p.id) ?? 0) },
    { key: 'on_fire', title: 'On Fire Now', format: 'multiplier', entries: rank((p) => fire.get(p.id) ?? 1) },
    { key: 'peak_multiplier', title: 'Highest Multiplier', format: 'multiplier', entries: rank((p) => p.peak_modifier) },
    { key: 'today_tokens', title: "Today's Tokens", format: 'tokens', entries: rank((p) => today.get(p.id) ?? 0) },
    { key: 'week_tokens', title: "This Week's Tokens", format: 'tokens', entries: rank((p) => week.get(p.id) ?? 0) },
    { key: 'days_champion', title: 'Days as Champion', format: 'count', entries: rank((p) => champ.get(p.id) ?? 0) },
    { key: 'most_battered', title: 'Most Battered', format: 'count', entries: rank((p) => battered.get(p.id) ?? 0) },
    { key: 'most_gold_stolen', title: 'Most Robbed', format: 'gold', entries: rank((p) => robbed.get(p.id) ?? 0) },
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/leaderboards.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — expected no errors.

```bash
git add src/domain/leaderboards.ts tests/leaderboards.test.ts
git commit -m "feat(domain): leaderboards module — 14 boards"
```

---

### Task 3: Engine updates `peak_modifier`

**Files:**
- Modify: `src/domain/engine.ts`
- Test: `tests/engine-peak-modifier.test.ts` (create)

**Interfaces:**
- Consumes: `players.peak_modifier` (Task 1); `tokenModifier` (already imported in `engine.ts`).
- Produces: after a player's swing, `players.peak_modifier` holds the max activity modifier (`tokenModifier(activityScore, k)`, excluding the monster debuff) ever seen for that player.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-peak-modifier.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

describe('engine peak_modifier', () => {
  it('rises to the activity modifier on a high-activity swing and never decreases', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    // token_modifier_k default 20000; 200000 effective -> modifier 1 + 200000/20000 = 11
    ingestTokenUsage(db, tokens(p.auth_token, 200000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);                 // spawn; first swing armed for ~104000
    eng.tick(104000);                 // swing lands at high activity
    const peak = getPlayerById(db, p.id)!.peak_modifier;
    expect(peak).toBeGreaterThan(5);  // ~11 at t=104000

    // Much later, activity has decayed to ~1; peak must not drop.
    const later = 100000 + 60 * 60_000; // +60 min, well past decay
    ingestTokenUsage(db, tokens(p.auth_token, 10), later, { cacheReadWeight: 0 });
    eng.tick(later);
    eng.tick(later + 4000);
    expect(getPlayerById(db, p.id)!.peak_modifier).toBeCloseTo(peak);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-peak-modifier.test.ts`
Expected: FAIL — `peak_modifier` stays 1 (engine doesn't update it yet).

- [ ] **Step 3: Update the engine swing branch**

In `src/domain/engine.ts`, inside `tick()`'s per-player swing branch, change:

```ts
        const score = activityScore(this.db, p.id, now, cfg);
        const mod = tokenModifier(score, cfg.tokenModifierK) * debuffFactor(this.db, p.id, now, cfg);
        const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelCurveSlope, mod);
        this.applyHit(encId, p.id, dmg);
        this.nextAttackAt.set(p.id, this.scheduleNext(now, cfg));
```

to:

```ts
        const score = activityScore(this.db, p.id, now, cfg);
        const am = tokenModifier(score, cfg.tokenModifierK);           // player's own activity modifier
        const mod = am * debuffFactor(this.db, p.id, now, cfg);
        const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelCurveSlope, mod);
        this.applyHit(encId, p.id, dmg);
        this.db.prepare('UPDATE players SET peak_modifier=? WHERE id=? AND peak_modifier < ?').run(am, p.id, am);
        this.nextAttackAt.set(p.id, this.scheduleNext(now, cfg));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/engine-peak-modifier.test.ts tests/engine-retaliation.test.ts`
Expected: PASS — new test green AND the existing retaliation test still green (the `mod` value is unchanged; only the intermediate `am` was extracted).

- [ ] **Step 5: Commit**

```bash
git add src/domain/engine.ts tests/engine-peak-modifier.test.ts
git commit -m "feat(engine): track players.peak_modifier (all-time activity modifier)"
```

---

### Task 4: Deliver leaderboards over SSE

**Files:**
- Modify: `src/web/tvhub.ts`
- Modify: `src/index.ts`
- Test: `tests/tvhub-leaderboards.test.ts` (create)

**Interfaces:**
- Consumes: `buildLeaderboards` + `LeaderboardCfg` (Task 2); `loadEngineConfig` (`src/domain/encounters.ts`).
- Produces: `TvHub.broadcastLeaderboards(now: number): void`; a `leaderboards` SSE frame on connect; a 15s broadcast interval in `index.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/tvhub-leaderboards.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { TvHub } from '../src/web/tvhub';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function capturing() { const frames: string[] = []; return { frames, client: { write: (c: string) => { frames.push(c); } } }; }

describe('TvHub leaderboards', () => {
  it('sends a leaderboards frame on connect', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const hub = new TvHub(db);
    const { frames, client } = capturing();
    hub.addClient(client, 1000);
    const lb = frames.find((f) => f.startsWith('event: leaderboards'));
    expect(lb).toBeTruthy();
    expect(lb).toContain('overall_tokens');
  });

  it('broadcastLeaderboards writes to connected clients', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const hub = new TvHub(db);
    const { frames, client } = capturing();
    hub.addClient(client, 1000);
    frames.length = 0;
    hub.broadcastLeaderboards(2000);
    expect(frames.some((f) => f.startsWith('event: leaderboards') && f.includes('days_champion'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tvhub-leaderboards.test.ts`
Expected: FAIL — no `leaderboards` frame on connect / `broadcastLeaderboards` is not a function.

- [ ] **Step 3: Extend TvHub**

In `src/web/tvhub.ts`:

3a. Add imports at the top (with the existing import):

```ts
import { buildLeaderboards } from '../domain/leaderboards';
import { loadEngineConfig } from '../domain/encounters';
```

3b. In `addClient`, after the `state` write, add a `leaderboards` frame:

```ts
    client.write(frame('state', buildTvState(this.db, now)));
    client.write(frame('leaderboards', buildLeaderboards(this.db, now, loadEngineConfig(this.db))));
```

3c. Add the broadcast method (e.g. after `broadcast`):

```ts
  /** Push the full leaderboard set to all clients (slow cadence; decoupled from state). */
  broadcastLeaderboards(now: number): void {
    if (this.clients.size === 0) return;
    const f = frame('leaderboards', buildLeaderboards(this.db, now, loadEngineConfig(this.db)));
    for (const c of this.clients) this.safeWrite(c, f);
  }
```

- [ ] **Step 4: Wire the interval in index.ts**

In `src/index.ts`:

4a. After the `tickTimer` block (after its `console.log`), add:

```ts
const LEADERBOARD_MS = 15000;
const lbTimer = setInterval(() => {
  try {
    tvHub.broadcastLeaderboards(Date.now());
  } catch (err) {
    console.error('[ClaudeRPG] leaderboards broadcast error:', err);
  }
}, LEADERBOARD_MS);
```

4b. In the `shutdown` function, clear it before `gracefulShutdown`. Change:

```ts
  shuttingDown = true;
  gracefulShutdown(signal, {
```

to:

```ts
  shuttingDown = true;
  clearInterval(lbTimer);
  gracefulShutdown(signal, {
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/tvhub-leaderboards.test.ts tests/tvhub.test.ts`
Expected: PASS (new test green; existing tvhub test unaffected).
Run: `npx tsc --noEmit` — expected no errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/tvhub.ts src/index.ts tests/tvhub-leaderboards.test.ts
git commit -m "feat(tv): deliver leaderboards over a 15s SSE channel"
```

---

### Task 5: TV rotating leaderboard UI

**Files:**
- Modify: `src/web/public/tv/tv.js`

**Interfaces:**
- Consumes: the `leaderboards` SSE event (Task 4) — an array of `{key, title, format, entries:[{playerId, name, avatarUrl, value}]}`.

`tv.js` is a classic script with no test harness; verification is visual (Step 6). Apply the edits exactly.

- [ ] **Step 1: Add rotation constants + state**

Near the other constants at the top of `tv.js` (after `ANIM_ROW` / the `FX` block), add:

```js
// Rotating leaderboard (backlog #8): the 6 boards shown on the TV, and cadence.
const LB_ROTATION = ['overall_tokens', 'total_damage', 'gold', 'on_fire', 'days_champion', 'most_battered'];
const LB_ROTATE_MS = 30000;   // seconds per board
const LB_FADE_MS = 400;       // crossfade dip at each switch
```

After the `let state = null;` / `let monsterHit = null;` declarations, add:

```js
let leaderboards = null;  // last 'leaderboards' payload (array of boards)
```

- [ ] **Step 2: Listen for the leaderboards event**

Next to the existing `evt.addEventListener('state', ...)` registration, add:

```js
evt.addEventListener('leaderboards', (e) => { leaderboards = JSON.parse(e.data); });
```

- [ ] **Step 3: Add a board value formatter**

Add this helper (e.g. just above `drawLeaderboard`):

```js
// Format a board value by its declared format. Mirrors leaderboards.ts BoardFormat.
function fmtBoardValue(format, v) {
  if (format === 'multiplier') return '×' + v.toFixed(2);   // ×2.34
  if (format === 'gold') return fmt(v) + 'g';
  if (format === 'count' || format === 'level') return String(Math.round(v));
  return fmt(v); // tokens, damage
}
```

- [ ] **Step 4: Replace `drawLeaderboard`**

Replace the entire `drawLeaderboard` function with a rotating version that takes the raf clock `t`:

```js
function drawLeaderboard(t) {
  const pad = Math.round(sidebarW * 0.05);
  // active board index + a crossfade dip at each switch
  const idx = Math.floor(t / LB_ROTATE_MS) % LB_ROTATION.length;
  const into = t % LB_ROTATE_MS;
  const fade = into < LB_FADE_MS ? into / LB_FADE_MS
    : (LB_ROTATE_MS - into) < LB_FADE_MS ? (LB_ROTATE_MS - into) / LB_FADE_MS : 1;
  const board = leaderboards && leaderboards.find((b) => b.key === LB_ROTATION[idx]);

  ctx.globalAlpha = fade;
  let y = pad;
  const title = board ? board.title.toUpperCase() : 'LEADERBOARD';
  shadowText(title, pad, y + sidebarW * 0.075, `bold ${Math.round(sidebarW * 0.08)}px system-ui`, '#e8c96a', 'left');
  y += sidebarW * 0.16;

  const entries = board ? board.entries : [];
  const bottomReserve = pad * 3; // leave room for rotation dots
  const rowH = Math.min((canvas.height - y - bottomReserve) / Math.max(1, entries.length || 1), sidebarW * 0.16);
  const rankW = Math.round(rowH * 0.55);
  const avW = Math.round(rowH * 0.8);
  const avX = pad + rankW;
  const textX = avX + avW + Math.round(rowH * 0.14);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    shadowText(`${i + 1}.`, pad, y + rowH * 0.6, `bold ${Math.round(rowH * 0.42)}px system-ui`, '#8a7aa0', 'left');
    ctx.drawImage(img(e.avatarUrl), avX, y, avW, avW);
    shadowText(e.name, textX, y + rowH * 0.42, `${Math.round(rowH * 0.4)}px system-ui`, '#cdb9e0', 'left');
    shadowText(fmtBoardValue(board.format, e.value), textX, y + rowH * 0.84, `bold ${Math.round(rowH * 0.38)}px system-ui`, '#e8c96a', 'left');
    y += rowH;
  }

  // rotation position dots along the sidebar bottom
  const dotR = Math.max(3, Math.round(sidebarW * 0.009));
  const gap = dotR * 3;
  const dotY = canvas.height - pad;
  for (let i = 0; i < LB_ROTATION.length; i++) {
    ctx.beginPath();
    ctx.fillStyle = i === idx ? '#e8c96a' : '#5a4e6e';
    ctx.arc(pad + dotR + i * gap, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
```

- [ ] **Step 5: Pass the clock into the call**

In `render(t)`, change the leaderboard call:

```js
    drawLeaderboard();
```

to:

```js
    drawLeaderboard(t);
```

- [ ] **Step 6: Visual-verify in a real browser**

The animation clock is frozen under headless virtual-time, so verify live:

1. Seed a scratch DB with a few players and varied stats (tokens, gold, some `encounter_damage`, a couple `monster_attacks` rows), then `DB_PATH=... PORT=8123 npm start` and open `/tv`.
2. Watch the sidebar rotate through the 6 boards (~30s each): confirm each shows the right **title**, **rank numbers**, avatars, and a correctly **formatted stat** (tokens `1.2K`, gold `340g`, multiplier `×2.34`, counts as integers), with a brief **crossfade** at each switch and the **position dots** advancing.
3. Confirm no console errors and that the battlefield/HP/defeat rendering is unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/web/public/tv/tv.js
git commit -m "feat(tv): rotating leaderboard — 6 boards, titles, ranks, crossfade (#8)"
```

---

## Final verification

- [ ] Full suite: `npx vitest run` — expected PASS.
- [ ] Typecheck: `npx tsc --noEmit` — expected no errors.
- [ ] `node --check src/web/public/tv/tv.js` — parses.
- [ ] Update `docs/BACKLOG.md`: mark #8 done (bigger text, rotating boards, richer stats); note the 8 non-rotated boards are computed + shipped for a future surface.

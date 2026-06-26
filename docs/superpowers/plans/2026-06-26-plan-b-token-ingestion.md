# Plan B: Token Ingestion (Claude Code OTLP → server) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive Claude Code's OpenTelemetry token metrics over OTLP **http/json** at `POST /v1/metrics`, attribute each export to the right player via the `claude_rpg_token` resource attribute, convert the `claude_code.token.usage` counter into per-player **effective-token increments**, and persist them (player totals/XP + a `token_events` log the game engine will consume).

**Architecture:** Builds on Plan A (Node/TS ESM, Express, better-sqlite3, embedded migrations, `asyncHandler`, settings store, players module). Two new tables (`token_events`, `metric_series`). A pure OTLP/JSON parser (`src/domain/otlp.ts`) turns a request body into flat data points. An ingestion module (`src/domain/ingest.ts`) converts counter values to increments — applying **delta** data points directly and diffing **cumulative** ones against `metric_series` (counter-reset safe) — then updates players and appends `token_events`. A thin route (`src/web/routes/metrics.ts`) wires it to Express with a JSON body parser (gzip-inflating) and always answers `200 {}`.

**Tech Stack:** Same as Plan A. No new dependencies (Express's built-in `express.json()` parses application/json and inflates gzip).

**Key facts this plan is built on (verified against Claude Code + OTLP docs):**
- `claude_code.token.usage` is an OTLP **sum**; each data point has a `type` attribute with values exactly `input`, `output`, `cacheRead`, `cacheCreation`, plus a `model` attribute.
- Numeric values are `asInt` (a **string**) or `asDouble` (a number).
- Attribute encoding: `{ "key": "...", "value": { "stringValue": "..." } }`.
- The custom `claude_rpg_token` rides on `resourceMetrics[].resource.attributes[]`.
- Default temporality is **cumulative**; the snippet sets the delta preference, but the server handles both by reading `sum.aggregationTemporality` (1 = delta, 2 = cumulative; may appear as the int or the enum name string).
- Content-Type `application/json`; gzip only if the client sets `Content-Encoding: gzip`; success is HTTP **200** with body `{}`.

**This plan is self-contained and testable:** POST sample OTLP payloads (delta and cumulative) and assert player totals/`token_events` update correctly; unknown/disabled tokens are ignored; the endpoint never crashes on bad input.

---

## File Structure

```
src/
  db/migrations.ts        (modify: add migration 003_token_ingestion)
  domain/
    otlp.ts               (new: pure OTLP/JSON parser → TokenDataPoint[])
    ingest.ts             (new: delta computation + apply to players + token_events)
    snippet.ts            (modify: add delta temporality env var)
  web/
    app.ts                (modify: register metrics routes)
    routes/metrics.ts     (new: POST /v1/metrics)
tests/
  otlp.test.ts            (new)
  ingest.test.ts          (new)
  web-metrics.test.ts     (new)
  snippet.test.ts         (modify: assert temporality line)
```

**Conventions (same as Plan A):** ESM, extensionless imports; `import type Database from 'better-sqlite3'`; core functions take `db` + explicit `now`; async Express handlers wrapped with `asyncHandler` from `src/web/async.ts`; tests use `openDb(':memory:')`.

---

## Task 1: Migration — `token_events` and `metric_series` tables

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `tests/db-ingest-migration.test.ts`

- [ ] **Step 1: Write the failing test** `tests/db-ingest-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('ingestion migration', () => {
  it('creates token_events and metric_series tables', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('token_events');
    expect(tables).toContain('metric_series');
  });

  it('token_events has an index on (player_id, ts)', () => {
    const db = openDb(':memory:');
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: any) => r.name);
    expect(idx).toContain('idx_token_events_player_ts');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db-ingest-migration.test.ts`
Expected: FAIL — tables not found.

- [ ] **Step 3: Append a migration to `src/db/migrations.ts`**

Add this object to the END of the `migrations` array (after `002_settings`):

```ts
  {
    id: '003_token_ingestion',
    sql: `
      CREATE TABLE token_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        effective_delta INTEGER NOT NULL,
        total_delta INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_token_events_player_ts ON token_events (player_id, ts);

      CREATE TABLE metric_series (
        series_key TEXT PRIMARY KEY,
        last_value INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/db-ingest-migration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts tests/db-ingest-migration.test.ts
git commit -m "feat: migration for token_events and metric_series"
```

---

## Task 2: OTLP/JSON parser (`src/domain/otlp.ts`)

**Files:**
- Create: `src/domain/otlp.ts`
- Test: `tests/otlp.test.ts`

This is a **pure function**: parse an OTLP/JSON metrics body into a flat list of token data points. It must tolerate missing/garbage fields without throwing.

- [ ] **Step 1: Write the failing test** `tests/otlp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTokenDataPoints } from '../src/domain/otlp';

function payload(temporality: number, dps: any[]) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude-code' } },
            { key: 'claude_rpg_token', value: { stringValue: 'TOK1' } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code' },
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints: dps },
              },
              // a non-token metric that must be ignored:
              { name: 'claude_code.cost.usage', sum: { aggregationTemporality: temporality, dataPoints: [
                { asDouble: 0.42, attributes: [], startTimeUnixNano: '1', timeUnixNano: '2' },
              ] } },
            ],
          },
        ],
      },
    ],
  };
}

describe('parseTokenDataPoints', () => {
  it('extracts token data points with token, type, model, value, temporality', () => {
    const body = payload(1, [
      { asInt: '150', startTimeUnixNano: '100', timeUnixNano: '200',
        attributes: [ { key: 'type', value: { stringValue: 'input' } }, { key: 'model', value: { stringValue: 'claude-opus-4' } } ] },
      { asInt: '40', startTimeUnixNano: '100', timeUnixNano: '200',
        attributes: [ { key: 'type', value: { stringValue: 'output' } } ] },
    ]);
    const pts = parseTokenDataPoints(body);
    expect(pts.length).toBe(2);
    expect(pts[0]).toMatchObject({
      token: 'TOK1', type: 'input', model: 'claude-opus-4', value: 150,
      startTimeUnixNano: '100', temporality: 'delta',
    });
    expect(pts[1]).toMatchObject({ token: 'TOK1', type: 'output', value: 40, temporality: 'delta' });
  });

  it('reads asDouble and cumulative temporality (enum int 2)', () => {
    const body = payload(2, [
      { asDouble: 12, attributes: [ { key: 'type', value: { stringValue: 'cacheCreation' } } ],
        startTimeUnixNano: '5', timeUnixNano: '6' },
    ]);
    const pts = parseTokenDataPoints(body);
    expect(pts[0]).toMatchObject({ type: 'cacheCreation', value: 12, temporality: 'cumulative' });
  });

  it('treats the string enum name as the temporality too', () => {
    const body = payload('AGGREGATION_TEMPORALITY_CUMULATIVE' as any, [
      { asInt: '1', attributes: [ { key: 'type', value: { stringValue: 'input' } } ], startTimeUnixNano: '1', timeUnixNano: '2' },
    ]);
    expect(parseTokenDataPoints(body)[0].temporality).toBe('cumulative');
  });

  it('token is null when the resource attribute is absent', () => {
    const body = {
      resourceMetrics: [ { resource: { attributes: [] }, scopeMetrics: [ { metrics: [
        { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [
          { asInt: '5', attributes: [ { key: 'type', value: { stringValue: 'input' } } ], startTimeUnixNano: '1', timeUnixNano: '2' } ] } } ] } ] } ],
    };
    expect(parseTokenDataPoints(body)[0].token).toBeNull();
  });

  it('returns [] for empty / malformed bodies without throwing', () => {
    expect(parseTokenDataPoints({})).toEqual([]);
    expect(parseTokenDataPoints(null)).toEqual([]);
    expect(parseTokenDataPoints({ resourceMetrics: 'nope' })).toEqual([]);
    expect(parseTokenDataPoints({ resourceMetrics: [{}] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/otlp.test.ts`
Expected: FAIL — cannot find `../src/domain/otlp`.

- [ ] **Step 3: Implement `src/domain/otlp.ts`**

```ts
export type Temporality = 'delta' | 'cumulative';

export interface TokenDataPoint {
  token: string | null; // claude_rpg_token resource attribute, or null
  type: string; // input | output | cacheRead | cacheCreation
  model: string; // model attribute, or '' if absent
  value: number; // counter value for this data point
  startTimeUnixNano: string; // identifies a counter series; '' if absent
  temporality: Temporality;
}

const TOKEN_METRIC = 'claude_code.token.usage';

function asArray(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

function findAttr(attrs: unknown, key: string): string | null {
  for (const a of asArray(attrs)) {
    if (a && a.key === key) {
      const v = a.value ?? {};
      if (typeof v.stringValue === 'string') return v.stringValue;
      if (typeof v.intValue === 'string') return v.intValue;
      if (typeof v.intValue === 'number') return String(v.intValue);
      return null;
    }
  }
  return null;
}

function readValue(dp: any): number {
  if (dp == null) return 0;
  if (dp.asInt !== undefined) {
    const n = Number(dp.asInt);
    return Number.isFinite(n) ? n : 0;
  }
  if (dp.asDouble !== undefined) {
    const n = Number(dp.asDouble);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function readTemporality(sum: any): Temporality {
  const t = sum?.aggregationTemporality;
  if (t === 1 || t === '1' || t === 'AGGREGATION_TEMPORALITY_DELTA') return 'delta';
  // Default to cumulative for 2, the enum name, or anything unexpected — the
  // server's series-diff path is the safe interpretation of an unknown value.
  return 'cumulative';
}

/** Parse an OTLP/JSON metrics body into flat token data points. Never throws. */
export function parseTokenDataPoints(body: unknown): TokenDataPoint[] {
  const out: TokenDataPoint[] = [];
  const root = body as any;
  for (const rm of asArray(root?.resourceMetrics)) {
    const token = findAttr(rm?.resource?.attributes, 'claude_rpg_token');
    for (const sm of asArray(rm?.scopeMetrics)) {
      for (const metric of asArray(sm?.metrics)) {
        if (metric?.name !== TOKEN_METRIC) continue;
        const sum = metric.sum;
        const temporality = readTemporality(sum);
        for (const dp of asArray(sum?.dataPoints)) {
          const type = findAttr(dp?.attributes, 'type');
          if (!type) continue; // a token data point must have a type
          out.push({
            token,
            type,
            model: findAttr(dp?.attributes, 'model') ?? '',
            value: readValue(dp),
            startTimeUnixNano:
              typeof dp?.startTimeUnixNano === 'string' ? dp.startTimeUnixNano : '',
            temporality,
          });
        }
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/otlp.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/otlp.ts tests/otlp.test.ts
git commit -m "feat: pure OTLP/JSON token-usage parser"
```

---

## Task 3: Increment recovery (`computeIncrement`) in `src/domain/ingest.ts`

**Files:**
- Create: `src/domain/ingest.ts`
- Test: `tests/ingest-increment.test.ts`

Convert a parsed data point into the **increment** to apply: delta points pass through; cumulative points are diffed against `metric_series` (keyed by `token|type|model|startTimeUnixNano`), with counter-reset handling.

- [ ] **Step 1: Write the failing test** `tests/ingest-increment.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { computeIncrement } from '../src/domain/ingest';
import type { TokenDataPoint } from '../src/domain/otlp';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

function dp(over: Partial<TokenDataPoint>): TokenDataPoint {
  return { token: 'T', type: 'input', model: 'm', value: 0, startTimeUnixNano: 's1', temporality: 'cumulative', ...over };
}

describe('computeIncrement', () => {
  it('delta points pass through unchanged and store no series', () => {
    expect(computeIncrement(db, dp({ temporality: 'delta', value: 30 }))).toBe(30);
    const rows = db.prepare('SELECT COUNT(*) AS c FROM metric_series').get() as any;
    expect(rows.c).toBe(0);
  });

  it('cumulative: first sighting counts the full value, then diffs', () => {
    expect(computeIncrement(db, dp({ value: 100 }))).toBe(100); // first
    expect(computeIncrement(db, dp({ value: 130 }))).toBe(30);  // +30
    expect(computeIncrement(db, dp({ value: 130 }))).toBe(0);   // no change
  });

  it('cumulative: a counter reset (value drops) counts the new value', () => {
    computeIncrement(db, dp({ value: 100 }));
    expect(computeIncrement(db, dp({ value: 20 }))).toBe(20); // reset → treat as full
  });

  it('different series (startTime/type/model) are tracked independently', () => {
    expect(computeIncrement(db, dp({ value: 50, startTimeUnixNano: 's1' }))).toBe(50);
    expect(computeIncrement(db, dp({ value: 70, startTimeUnixNano: 's2' }))).toBe(70);
    expect(computeIncrement(db, dp({ value: 9, type: 'output' }))).toBe(9);
  });

  it('a null token still computes (series keyed by literal null) but is harmless', () => {
    expect(computeIncrement(db, dp({ token: null, value: 5 }))).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ingest-increment.test.ts`
Expected: FAIL — cannot find `../src/domain/ingest`.

- [ ] **Step 3: Implement `src/domain/ingest.ts` (first part)**

```ts
import type Database from 'better-sqlite3';
import { parseTokenDataPoints, type TokenDataPoint } from './otlp';
import { getPlayerByToken } from './players';

function seriesKey(p: TokenDataPoint): string {
  return `${p.token ?? ' '}|${p.type}|${p.model}|${p.startTimeUnixNano}`;
}

/**
 * Convert a data point to the increment to apply.
 * - delta: the value IS the increment.
 * - cumulative: diff against the last value stored for this series; first
 *   sighting counts the full value; a drop (counter reset) counts the new value.
 */
export function computeIncrement(
  db: Database.Database,
  p: TokenDataPoint,
): number {
  if (p.temporality === 'delta') {
    return Math.max(0, Math.round(p.value));
  }
  const key = seriesKey(p);
  const row = db
    .prepare('SELECT last_value FROM metric_series WHERE series_key = ?')
    .get(key) as { last_value: number } | undefined;
  const current = Math.round(p.value);
  let delta: number;
  if (!row) {
    delta = Math.max(0, current);
  } else if (current >= row.last_value) {
    delta = current - row.last_value;
  } else {
    delta = Math.max(0, current); // counter reset
  }
  db.prepare(
    `INSERT INTO metric_series (series_key, last_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(series_key) DO UPDATE SET last_value = excluded.last_value, updated_at = excluded.updated_at`,
  ).run(key, current, Date.now());
  return delta;
}
```

(More functions are added to this file in Task 4 — leave the imports of `parseTokenDataPoints`/`getPlayerByToken` in place; they are used there.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/ingest-increment.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/ingest.ts tests/ingest-increment.test.ts
git commit -m "feat: counter-to-increment recovery (delta + cumulative)"
```

---

## Task 4: Apply ingestion to players (`ingestTokenUsage`) in `src/domain/ingest.ts`

**Files:**
- Modify: `src/domain/ingest.ts`
- Test: `tests/ingest-apply.test.ts`

Orchestrate: parse body → per data point compute increment → group per token by type → for each token, look up the player (skip unknown / disabled), compute effective + total, update the player, append a `token_events` row.

- [ ] **Step 1: Write the failing test** `tests/ingest-apply.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer, getPlayerById, updatePlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

function body(token: string, byType: Record<string, number>, temporality = 1) {
  const dataPoints = Object.entries(byType).map(([type, v]) => ({
    asInt: String(v),
    startTimeUnixNano: 's', timeUnixNano: 't',
    attributes: [{ key: 'type', value: { stringValue: type } }, { key: 'model', value: { stringValue: 'm' } }],
  }));
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
      scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: temporality, dataPoints } }] }],
    }],
  };
}

describe('ingestTokenUsage', () => {
  it('adds effective (input+output+cacheCreation) and total; ignores cacheRead by default', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100, output: 40, cacheCreation: 10, cacheRead: 9999 }), 5000, { cacheReadWeight: 0 });
    const u = getPlayerById(db, p.id)!;
    expect(u.effective_tokens).toBe(150);              // 100+40+10
    expect(u.total_tokens).toBe(10149);               // all four
    expect(u.last_token_at).toBe(5000);
    const ev = db.prepare('SELECT * FROM token_events WHERE player_id = ?').all(p.id) as any[];
    expect(ev.length).toBe(1);
    expect(ev[0].effective_delta).toBe(150);
    expect(ev[0].total_delta).toBe(10149);
  });

  it('applies cache_read_weight when > 0', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 0, output: 0, cacheCreation: 0, cacheRead: 1000 }), 1, { cacheReadWeight: 0.05 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(50); // 1000*0.05
  });

  it('accumulates across multiple ingests', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }), 1, { cacheReadWeight: 0 });
    ingestTokenUsage(db, body(p.auth_token, { input: 50 }), 2, { cacheReadWeight: 0 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(150);
  });

  it('ignores unknown tokens', () => {
    const res = ingestTokenUsage(db, body('nobody', { input: 100 }), 1, { cacheReadWeight: 0 });
    expect(res.appliedPlayers).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM token_events').get()).toMatchObject({ c: 0 });
  });

  it('ignores disabled players', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    updatePlayer(db, p.id, { disabled: 1 });
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }), 1, { cacheReadWeight: 0 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(0);
  });

  it('does not write a token_event when the net effective+total increment is zero', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, {}), 1, { cacheReadWeight: 0 }); // no data points
    expect(db.prepare('SELECT COUNT(*) AS c FROM token_events').get()).toMatchObject({ c: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ingest-apply.test.ts`
Expected: FAIL — `ingestTokenUsage` not exported.

- [ ] **Step 3: Append to `src/domain/ingest.ts`**

```ts
export interface IngestOptions {
  cacheReadWeight: number;
}

export interface IngestResult {
  appliedPlayers: number; // distinct players whose stats changed
  ignoredUnknownTokens: number;
}

interface PerToken {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

function emptyPerToken(): PerToken {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/**
 * Parse an OTLP body, recover per-data-point increments, aggregate per token,
 * and apply to players: bump total_tokens, effective_tokens, last_token_at, and
 * append a token_events row. Unknown tokens and disabled players are ignored.
 */
export function ingestTokenUsage(
  db: Database.Database,
  body: unknown,
  now: number,
  opts: IngestOptions,
): IngestResult {
  const points = parseTokenDataPoints(body);
  const byToken = new Map<string, PerToken>();

  for (const p of points) {
    const inc = computeIncrement(db, p);
    if (inc <= 0 || p.token == null) continue;
    const agg = byToken.get(p.token) ?? emptyPerToken();
    if (p.type === 'input') agg.input += inc;
    else if (p.type === 'output') agg.output += inc;
    else if (p.type === 'cacheCreation') agg.cacheCreation += inc;
    else if (p.type === 'cacheRead') agg.cacheRead += inc;
    // unknown type strings are counted toward total only (see below) — skip here
    else agg.cacheRead += 0;
    byToken.set(p.token, agg);
  }

  let appliedPlayers = 0;
  let ignoredUnknownTokens = 0;

  const apply = db.transaction(() => {
    for (const [token, agg] of byToken) {
      const player = getPlayerByToken(db, token);
      if (!player) {
        ignoredUnknownTokens++;
        continue;
      }
      if (player.disabled) continue;

      const effective =
        agg.input +
        agg.output +
        agg.cacheCreation +
        Math.round(agg.cacheRead * opts.cacheReadWeight);
      const total = agg.input + agg.output + agg.cacheCreation + agg.cacheRead;
      if (effective <= 0 && total <= 0) continue;

      db.prepare(
        `UPDATE players
         SET total_tokens = total_tokens + ?,
             effective_tokens = effective_tokens + ?,
             last_token_at = ?
         WHERE id = ?`,
      ).run(total, effective, now, player.id);

      db.prepare(
        `INSERT INTO token_events (player_id, ts, effective_delta, total_delta)
         VALUES (?, ?, ?, ?)`,
      ).run(player.id, now, effective, total);

      appliedPlayers++;
    }
  });
  apply();

  return { appliedPlayers, ignoredUnknownTokens };
}

/** Sum of effective tokens a player received at or after `since` (engine helper). */
export function sumEffectiveSince(
  db: Database.Database,
  playerId: number,
  since: number,
): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(effective_delta), 0) AS s FROM token_events WHERE player_id = ? AND ts >= ?',
    )
    .get(playerId, since) as { s: number };
  return row.s;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/ingest-apply.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add a focused test for `sumEffectiveSince`** in `tests/ingest-apply.test.ts` (append inside the describe block):

```ts
  it('sumEffectiveSince totals only recent token_events', async () => {
    const { sumEffectiveSince } = await import('../src/domain/ingest');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }), 1000, { cacheReadWeight: 0 });
    ingestTokenUsage(db, body(p.auth_token, { input: 50 }), 5000, { cacheReadWeight: 0 });
    expect(sumEffectiveSince(db, p.id, 2000)).toBe(50);  // only the second
    expect(sumEffectiveSince(db, p.id, 0)).toBe(150);    // both
  });
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/ingest-apply.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
git add src/domain/ingest.ts tests/ingest-apply.test.ts
git commit -m "feat: apply token usage to players + token_events log"
```

---

## Task 5: Metrics endpoint (`POST /v1/metrics`)

**Files:**
- Create: `src/web/routes/metrics.ts`
- Modify: `src/web/app.ts`
- Test: `tests/web-metrics.test.ts`

- [ ] **Step 1: Write the failing test** `tests/web-metrics.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { seedSettings, setSetting } from '../src/domain/settings';
import { createApp } from '../src/web/app';
import { createPlayer, getPlayerById } from '../src/domain/players';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  app = createApp({ db, config: loadConfig({}) });
});

function body(token: string, byType: Record<string, number>) {
  const dataPoints = Object.entries(byType).map(([type, v]) => ({
    asInt: String(v), startTimeUnixNano: 's', timeUnixNano: 't',
    attributes: [{ key: 'type', value: { stringValue: type } }],
  }));
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
      scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints } }] }],
    }],
  };
}

describe('POST /v1/metrics', () => {
  it('ingests JSON and returns 200 {}', async () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .send(body(p.auth_token, { input: 100, output: 20 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(120);
  });

  it('honors cache_read_weight from settings', async () => {
    setSetting(db, 'cache_read_weight', '0.1');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    await request(app).post('/v1/metrics').set('Content-Type', 'application/json')
      .send(body(p.auth_token, { cacheRead: 1000 }));
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(100);
  });

  it('accepts gzip-encoded bodies', async () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const raw = Buffer.from(JSON.stringify(body(p.auth_token, { input: 77 })));
    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(raw));
    expect(res.status).toBe(200);
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(77);
  });

  it('returns 200 on a malformed body without crashing', async () => {
    const res = await request(app)
      .post('/v1/metrics')
      .set('Content-Type', 'application/json')
      .send('{ not valid json ');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/web-metrics.test.ts`
Expected: FAIL — `/v1/metrics` 404.

- [ ] **Step 3: Implement `src/web/routes/metrics.ts`**

```ts
import express, { type Express } from 'express';
import type { AppDeps } from '../app';
import { asyncHandler } from '../async';
import { ingestTokenUsage } from '../../domain/ingest';
import { getSetting } from '../../domain/settings';

export function registerMetricsRoutes(app: Express, { db }: AppDeps): void {
  // OTLP/JSON bodies can be sizable and may be gzip-encoded; express.json
  // inflates gzip automatically. A generous limit avoids 413s on big exports.
  const jsonBody = express.json({ limit: '10mb', type: () => true });

  app.post(
    '/v1/metrics',
    jsonBody,
    asyncHandler(async (req, res) => {
      // body-parser leaves req.body as {} on empty bodies; malformed JSON would
      // normally error — see the route-local error guard below.
      const weight = Number(getSetting(db, 'cache_read_weight') ?? '0') || 0;
      ingestTokenUsage(db, req.body, Date.now(), { cacheReadWeight: weight });
      res.status(200).json({});
    }),
  );

  // Route-local error handler: a malformed JSON body makes express.json throw.
  // OTLP clients expect a 200; swallow parse errors (nothing to ingest) so a
  // bad payload never crashes or 400s the exporter.
  app.use(
    '/v1/metrics',
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!err) return next();
      console.warn('[ClaudeRPG] /v1/metrics parse error:', (err as Error).message);
      if (res.headersSent) return;
      res.status(200).json({});
    },
  );
}
```

- [ ] **Step 4: Wire into `src/web/app.ts`**

Add the import near the other route imports:

```ts
import { registerMetricsRoutes } from './routes/metrics';
```

Register it alongside the others (order doesn't matter relative to the web routes, but it MUST be before the final global error-handling middleware):

```ts
  registerRegistrationRoutes(app, { db, config });
  registerCharacterRoutes(app, { db, config });
  registerAdminRoutes(app, { db, config });
  registerMetricsRoutes(app, { db, config });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/web-metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green (Plan A's tests + the new ingestion tests).

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/metrics.ts src/web/app.ts tests/web-metrics.test.ts
git commit -m "feat: POST /v1/metrics OTLP ingestion endpoint"
```

---

## Task 6: Add delta temporality to the setup snippet

**Files:**
- Modify: `src/domain/snippet.ts`
- Test: `tests/snippet.test.ts`

- [ ] **Step 1: Update the test** `tests/snippet.test.ts` — add one assertion inside the existing `it(...)`:

```ts
    expect(s).toContain('OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/snippet.test.ts`
Expected: FAIL — string not present.

- [ ] **Step 3: Update `src/domain/snippet.ts`**

Add the temporality export line immediately after the `OTEL_METRIC_EXPORT_INTERVAL` line in the returned template string:

```ts
export OTEL_METRIC_EXPORT_INTERVAL=5000
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
export OTEL_RESOURCE_ATTRIBUTES=claude_rpg_token=${token}
```

(The line goes between `OTEL_METRIC_EXPORT_INTERVAL=5000` and the existing `OTEL_RESOURCE_ATTRIBUTES=...` line; everything else in the snippet is unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/snippet.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests green; `tsc --noEmit` reports zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/domain/snippet.ts tests/snippet.test.ts
git commit -m "feat: request delta temporality in player setup snippet"
```

---

## Task 7: Manual end-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Boot the server on a throwaway DB and simulate an export**

Run:

```bash
rm -f ./data/smokeb.db ./data/smokeb.db-wal ./data/smokeb.db-shm
ADMIN_PASSWORD=test123 PORT=8097 DB_PATH=./data/smokeb.db npm start &
SMOKE_PID=$!
sleep 3
# Register a player and capture its token from the response page:
TOKEN=$(curl -s -X POST http://localhost:8097/register -d "name=Ingestor&class_key=wizard&gender=M" \
  | grep -oE 'claude_rpg_token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
echo "token=$TOKEN"
# Send a delta OTLP metrics export:
curl -s -o /dev/null -w "ingest http %{http_code}\n" -X POST http://localhost:8097/v1/metrics \
  -H 'Content-Type: application/json' \
  -d "{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"claude_rpg_token\",\"value\":{\"stringValue\":\"$TOKEN\"}}]},\"scopeMetrics\":[{\"metrics\":[{\"name\":\"claude_code.token.usage\",\"sum\":{\"aggregationTemporality\":1,\"dataPoints\":[{\"asInt\":\"1234\",\"startTimeUnixNano\":\"1\",\"timeUnixNano\":\"2\",\"attributes\":[{\"key\":\"type\",\"value\":{\"stringValue\":\"input\"}}]}]}}]}]}]}"
# View the character sheet — effective tokens should now be 1234:
curl -s "http://localhost:8097/character?token=$TOKEN" | grep -A1 "effective tokens" | head -3
kill $SMOKE_PID 2>/dev/null
rm -f ./data/smokeb.db ./data/smokeb.db-wal ./data/smokeb.db-shm
```

Expected: `ingest http 200`, and the character sheet shows `1234` for XP (effective tokens). If the value is not 1234 or the server errors, STOP and report BLOCKED with details.

- [ ] **Step 2: Report the observed outputs** (token captured, ingest http code, the effective-tokens value seen). No commit (verification only).

---

## Self-Review

**Spec coverage (against §7 + §9 data model):**
- OTLP `http/json` receiver at `POST /v1/metrics` → Task 5. ✅
- Parse `claude_code.token.usage`, `type` attribute, `claude_rpg_token` resource attr → Task 2. ✅
- effective = input+output+cacheCreation (+cacheRead×weight, default 0) → Task 4. ✅
- Robust to delta AND cumulative via `aggregationTemporality` + `metric_series` diff with reset handling → Tasks 2, 3. ✅
- Update player total_tokens/effective_tokens/last_token_at + append `token_events` → Task 4. ✅
- Ignore unknown tokens & disabled players; always 200 `{}`; gzip + malformed-body tolerant → Tasks 4, 5. ✅
- `token_events` + `metric_series` tables → Task 1. ✅
- Snippet sets delta temporality preference → Task 6. ✅
- `sumEffectiveSince` helper for the engine's recent-activity window → Task 4. ✅

**Placeholder scan:** No TBD/"add error handling"/"similar to" — all steps show full code. `sumEffectiveSince` is included now (used by Plan C) because its data source (`token_events`) is defined here and it is cheap to test alongside.

**Type consistency:** `parseTokenDataPoints(body): TokenDataPoint[]`, `computeIncrement(db, p)`, `ingestTokenUsage(db, body, now, {cacheReadWeight})`, `IngestResult`, `sumEffectiveSince(db, playerId, since)`, `registerMetricsRoutes(app, {db, config})` are each defined once and used consistently. The route reads `cache_read_weight` from settings (seeded in Plan A) and passes it as `cacheReadWeight`.

**Integration note:** `express.json({ type: () => true })` makes the parser apply regardless of the exact Content-Type the exporter sends (some send `application/json` with charset). It is mounted ONLY on the `/v1/metrics` route, so it does not affect the urlencoded form routes from Plan A.

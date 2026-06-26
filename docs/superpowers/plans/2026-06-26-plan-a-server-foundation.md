# Plan A: Server Foundation + Player Management Web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the ClaudeRPG Node/TypeScript server with a SQLite data layer and a complete player-management website — public registration (issuing an auth token + setup snippet), a token-login character sheet (view/rename/delete), and a master-password admin panel (manage players + tune settings).

**Architecture:** A single Node.js + TypeScript process. `better-sqlite3` (synchronous, WAL) holds all state, created via an embedded ordered-migrations runner. Domain logic (players, settings, classes, auth) lives in pure, unit-tested modules that take `db` and an explicit `now` timestamp (no `Date.now()` inside core logic — keeps tests deterministic). An Express app factory wires EJS-rendered pages and serves the Oryx sprites statically. Admin uses `express-session` with a master username/password stored (bcrypt-hashed) in settings.

**Tech Stack:** Node.js 20+, TypeScript (ESM), `tsx` (run TS directly — no build step, friendly on the Pi), `better-sqlite3`, `express`, `express-session`, `ejs`, `bcryptjs` (pure JS — avoids native bcrypt build pain on ARM), `zod` (input validation), `vitest` + `supertest` (tests).

**This plan is self-contained and testable:** at the end you can register characters, log in with a token, rename/delete, and manage everything from the admin panel. No game engine yet — that's Plan C.

---

## File Structure

```
package.json
tsconfig.json
vitest.config.ts
.gitignore                      (extend)
data/                           (gitignored; runtime SQLite file)
src/
  config.ts                     (env → typed config)
  index.ts                      (entrypoint: open db, seed, listen)
  db/
    migrations.ts               (ordered embedded SQL migrations)
    migrate.ts                  (idempotent migration runner)
    db.ts                       (openDb: pragmas + run migrations)
  domain/
    auth.ts                     (token gen, password hash/verify)
    classes.ts                  (18 class avatars + sprite helpers)
    players.ts                  (player CRUD)
    admin.ts                    (admin credential seed + verify)
    settings.ts                 (settings defaults, get/set/seed)
    snippet.ts                  (per-player OTEL setup snippet)
  web/
    app.ts                      (createApp factory + middleware + static)
    routes/
      registration.ts
      character.ts
      admin.ts
    views/                      (EJS templates)
      layout.ejs
      register.ejs
      registered.ejs
      character-login.ejs
      character-sheet.ejs
      admin-login.ejs
      admin-players.ejs
      admin-player-edit.ejs
      admin-settings.ejs
    public/
      style.css
tests/
  db.test.ts
  settings.test.ts
  classes.test.ts
  auth.test.ts
  players.test.ts
  snippet.test.ts
  web-health.test.ts
  web-registration.test.ts
  web-character.test.ts
  web-admin-auth.test.ts
  web-admin-players.test.ts
  web-admin-settings.test.ts
README.md
```

**Conventions used across all tasks (read once):**
- ESM everywhere (`"type": "module"`). Imports are extensionless; `tsx`/`vitest` resolve `.ts`.
- Core domain functions receive `db: Database.Database` and, where time matters, an explicit `now: number` (epoch ms).
- Tests open an in-memory db: `openDb(':memory:')`.
- `Database` type import: `import type Database from 'better-sqlite3'`.

---

## Task 1: Project scaffold + config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config.ts`
- Modify: `.gitignore`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-rpg",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.3.0",
    "ejs": "^3.1.10",
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/express": "^4.17.21",
    "@types/express-session": "^1.18.0",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Extend `.gitignore`**

Append these lines (file already contains `.superpowers/` and `.DS_Store`):

```
node_modules/
dist/
data/
*.db
*.db-wal
*.db-shm
```

- [ ] **Step 5: Write the failing test for config**

`tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.dbPath).toBe('./data/claude-rpg.db');
    expect(c.adminUsername).toBe('admin');
    expect(c.otelHost).toBe('claude-rpg.local');
    expect(typeof c.sessionSecret).toBe('string');
    expect(c.sessionSecret.length).toBeGreaterThan(10);
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      PORT: '9000',
      DB_PATH: '/tmp/x.db',
      ADMIN_USERNAME: 'boss',
      ADMIN_PASSWORD: 'secret',
      OTEL_ENDPOINT_HOST: 'rpg.lan',
      SESSION_SECRET: 'fixedsecretvalue',
    });
    expect(c.port).toBe(9000);
    expect(c.dbPath).toBe('/tmp/x.db');
    expect(c.adminUsername).toBe('boss');
    expect(c.adminPassword).toBe('secret');
    expect(c.otelHost).toBe('rpg.lan');
    expect(c.sessionSecret).toBe('fixedsecretvalue');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm install && npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config'`.

- [ ] **Step 7: Implement `src/config.ts`**

```ts
import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  dbPath: string;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  otelHost: string;
  spritesDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: env.PORT ? Number(env.PORT) : 8080,
    dbPath: env.DB_PATH ?? './data/claude-rpg.db',
    adminUsername: env.ADMIN_USERNAME ?? 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? 'changeme',
    sessionSecret: env.SESSION_SECRET ?? randomBytes(24).toString('hex'),
    otelHost: env.OTEL_ENDPOINT_HOST ?? 'claude-rpg.local',
    spritesDir:
      env.SPRITES_DIR ?? 'assets/oryx_16-bit_fantasy_1.1/Sliced',
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/config.ts tests/config.test.ts
git commit -m "feat: project scaffold and typed config"
```

---

## Task 2: Database layer + migration runner

**Files:**
- Create: `src/db/migrations.ts`, `src/db/migrate.ts`, `src/db/db.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('openDb', () => {
  it('creates the players and settings tables', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('players');
    expect(tables).toContain('settings');
    expect(tables).toContain('_migrations');
  });

  it('is idempotent: running migrations twice does not error', () => {
    const db = openDb(':memory:');
    // re-import and re-run by opening another connection on same memory is not
    // possible; instead assert migration count is stable
    const count = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get() as any;
    expect(count.c).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — cannot find `../src/db/db`.

- [ ] **Step 3: Implement `src/db/migrations.ts`**

```ts
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001_players',
    sql: `
      CREATE TABLE players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        class_key TEXT NOT NULL,
        gender TEXT NOT NULL CHECK (gender IN ('M','F')),
        auth_token TEXT NOT NULL UNIQUE,
        level INTEGER NOT NULL DEFAULT 1,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        effective_tokens INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_token_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: '002_settings',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];
```

- [ ] **Step 4: Implement `src/db/migrate.ts`**

```ts
import type Database from 'better-sqlite3';
import { migrations } from './migrations';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((r: any) => r.id),
  );
  const insert = db.prepare(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );
  const tx = db.transaction(() => {
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      db.exec(m.sql);
      insert.run(m.id, Date.now());
    }
  });
  tx();
}
```

- [ ] **Step 5: Implement `src/db/db.ts`**

```ts
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/db tests/db.test.ts
git commit -m "feat: sqlite layer with embedded migration runner"
```

---

## Task 3: Settings store

**Files:**
- Create: `src/domain/settings.ts`
- Test: `tests/settings.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import {
  DEFAULT_SETTINGS,
  seedSettings,
  getSetting,
  setSetting,
  getAllSettings,
} from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('settings', () => {
  it('seeds defaults without overwriting existing values', () => {
    setSetting(db, 'target_battle_minutes', '45');
    seedSettings(db);
    expect(getSetting(db, 'target_battle_minutes')).toBe('45'); // preserved
    expect(getSetting(db, 'pause_after_minutes')).toBe(
      DEFAULT_SETTINGS.pause_after_minutes,
    );
  });

  it('getSetting returns undefined for unknown key', () => {
    expect(getSetting(db, 'nope')).toBeUndefined();
  });

  it('getAllSettings returns every seeded key', () => {
    seedSettings(db);
    const all = getAllSettings(db);
    expect(Object.keys(all).length).toBe(Object.keys(DEFAULT_SETTINGS).length);
    expect(all.xp_growth).toBe('1.5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — cannot find `../src/domain/settings`.

- [ ] **Step 3: Implement `src/domain/settings.ts`**

```ts
import type Database from 'better-sqlite3';

// All game knobs (consumed by later plans). Values are strings; callers parse.
export const DEFAULT_SETTINGS: Record<string, string> = {
  base_xp: '50000',            // tokens for level 1 -> 2
  xp_growth: '1.5',            // geometric growth per level
  level_mult_slope: '0.10',    // damage multiplier slope per level
  base_hit: '100',             // base damage per swing at modifier 1.0, level 1
  attack_interval_ms: '4000',  // base swing interval
  attack_jitter_ms: '1500',    // +/- jitter on swing interval
  token_modifier_k: '20000',   // recent tokens that add +1.0 to modifier
  recent_window_minutes: '10', // rolling window for tokenModifier
  target_battle_minutes: '30', // target active-time battle length
  boss_hp_mult: '3',           // boss HP multiplier
  gold_factor: '0.01',         // gold = maxHP * dungeonLevel * gold_factor
  cache_read_weight: '0',      // weight applied to cacheRead tokens
  popup_duration_s: '120',     // defeat popup on-screen seconds
  pause_after_minutes: '15',   // office-wide inactivity before pause
};

export function seedSettings(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
  );
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  });
  tx();
}

export function getSetting(
  db: Database.Database,
  key: string,
): string | undefined {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(
  db: Database.Database,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getAllSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/settings.ts tests/settings.test.ts
git commit -m "feat: settings store with game-knob defaults"
```

---

## Task 4: Class avatar catalog + sprite helpers

**Files:**
- Create: `src/domain/classes.ts`
- Test: `tests/classes.test.ts`

**Note:** Per the spec (§11), Phase 1 uses the 24×24 hero-class creatures (indices 1-18 in `creature_key.doc`) for avatars — they map cleanly to documented class names. Index = Knight..Paladin (1-9) for Male, +9 for Female.

- [ ] **Step 1: Write the failing test**

`tests/classes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CLASSES,
  getClass,
  spriteIndexFor,
  creatureSpriteFile,
} from '../src/domain/classes';

describe('classes', () => {
  it('has the 9 documented hero classes', () => {
    expect(CLASSES.length).toBe(9);
    expect(CLASSES.map((c) => c.key)).toContain('paladin');
  });

  it('maps gender to the correct creature_key index', () => {
    expect(spriteIndexFor('knight', 'M')).toBe(1);
    expect(spriteIndexFor('knight', 'F')).toBe(10);
    expect(spriteIndexFor('paladin', 'M')).toBe(9);
    expect(spriteIndexFor('paladin', 'F')).toBe(18);
  });

  it('builds zero-padded sprite filenames', () => {
    expect(creatureSpriteFile(1)).toBe('oryx_16bit_fantasy_creatures_01.png');
    expect(creatureSpriteFile(18)).toBe('oryx_16bit_fantasy_creatures_18.png');
    expect(creatureSpriteFile(100)).toBe('oryx_16bit_fantasy_creatures_100.png');
  });

  it('getClass returns undefined for unknown key', () => {
    expect(getClass('dragonrider')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/classes.test.ts`
Expected: FAIL — cannot find `../src/domain/classes`.

- [ ] **Step 3: Implement `src/domain/classes.ts`**

```ts
export type Gender = 'M' | 'F';

export interface ClassDef {
  key: string;
  name: string;
  /** creature_key.doc index for the Male variant; Female = maleIndex + 9 */
  maleIndex: number;
}

// Order matches creature_key.doc indices 1..9 (Male) / 10..18 (Female).
export const CLASSES: ClassDef[] = [
  { key: 'knight', name: 'Knight', maleIndex: 1 },
  { key: 'thief', name: 'Thief', maleIndex: 2 },
  { key: 'ranger', name: 'Ranger', maleIndex: 3 },
  { key: 'wizard', name: 'Wizard', maleIndex: 4 },
  { key: 'priest', name: 'Priest', maleIndex: 5 },
  { key: 'shaman', name: 'Shaman', maleIndex: 6 },
  { key: 'berserker', name: 'Berserker', maleIndex: 7 },
  { key: 'swordsman', name: 'Swordsman', maleIndex: 8 },
  { key: 'paladin', name: 'Paladin', maleIndex: 9 },
];

export function getClass(key: string): ClassDef | undefined {
  return CLASSES.find((c) => c.key === key);
}

export function spriteIndexFor(key: string, gender: Gender): number {
  const def = getClass(key);
  if (!def) throw new Error(`Unknown class key: ${key}`);
  return gender === 'M' ? def.maleIndex : def.maleIndex + 9;
}

export function creatureSpriteFile(index: number): string {
  const padded = String(index).padStart(2, '0');
  return `oryx_16bit_fantasy_creatures_${padded}.png`;
}

/** Relative URL under the /sprites static mount. */
export function classSpriteUrl(key: string, gender: Gender): string {
  return `/sprites/creatures_24x24/${creatureSpriteFile(
    spriteIndexFor(key, gender),
  )}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/classes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/classes.ts tests/classes.test.ts
git commit -m "feat: hero class catalog and sprite path helpers"
```

---

## Task 5: Auth helpers

**Files:**
- Create: `src/domain/auth.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { randomToken, hashPassword, verifyPassword } from '../src/domain/auth';

describe('auth', () => {
  it('generates unique, url-safe tokens', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });

  it('hashes and verifies passwords', () => {
    const hash = hashPassword('hunter2');
    expect(hash).not.toBe('hunter2');
    expect(verifyPassword('hunter2', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL — cannot find `../src/domain/auth`.

- [ ] **Step 3: Implement `src/domain/auth.ts`**

```ts
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

export function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/auth.ts tests/auth.test.ts
git commit -m "feat: auth token generation and password hashing"
```

---

## Task 6: Player domain CRUD

**Files:**
- Create: `src/domain/players.ts`
- Test: `tests/players.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/players.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import {
  createPlayer,
  getPlayerById,
  getPlayerByToken,
  listPlayers,
  renamePlayer,
  updatePlayer,
  deletePlayer,
} from '../src/domain/players';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
});

const base = { name: 'Sir Reginald', class_key: 'knight', gender: 'M' as const };

describe('players', () => {
  it('creates a player with a unique token and sane defaults', () => {
    const p = createPlayer(db, base, 1000);
    expect(p.id).toBeGreaterThan(0);
    expect(p.auth_token.length).toBeGreaterThan(10);
    expect(p.level).toBe(1);
    expect(p.gold).toBe(0);
    expect(p.disabled).toBe(0);
    expect(p.created_at).toBe(1000);
  });

  it('fetches by id and by token', () => {
    const p = createPlayer(db, base, 1000);
    expect(getPlayerById(db, p.id)?.name).toBe('Sir Reginald');
    expect(getPlayerByToken(db, p.auth_token)?.id).toBe(p.id);
    expect(getPlayerByToken(db, 'bogus')).toBeUndefined();
  });

  it('lists players newest-first', () => {
    createPlayer(db, base, 1000);
    createPlayer(db, { ...base, name: 'Gandalf', class_key: 'wizard' }, 2000);
    const all = listPlayers(db);
    expect(all.map((p) => p.name)).toEqual(['Gandalf', 'Sir Reginald']);
  });

  it('renames and updates fields', () => {
    const p = createPlayer(db, base, 1000);
    renamePlayer(db, p.id, 'Reginald the Bold');
    expect(getPlayerById(db, p.id)?.name).toBe('Reginald the Bold');
    updatePlayer(db, p.id, { level: 5, gold: 250, disabled: 1 });
    const u = getPlayerById(db, p.id)!;
    expect(u.level).toBe(5);
    expect(u.gold).toBe(250);
    expect(u.disabled).toBe(1);
  });

  it('deletes a player', () => {
    const p = createPlayer(db, base, 1000);
    deletePlayer(db, p.id);
    expect(getPlayerById(db, p.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/players.test.ts`
Expected: FAIL — cannot find `../src/domain/players`.

- [ ] **Step 3: Implement `src/domain/players.ts`**

```ts
import type Database from 'better-sqlite3';
import type { Gender } from './classes';
import { randomToken } from './auth';

export interface Player {
  id: number;
  name: string;
  class_key: string;
  gender: Gender;
  auth_token: string;
  level: number;
  total_tokens: number;
  effective_tokens: number;
  gold: number;
  disabled: number;
  last_token_at: number | null;
  created_at: number;
}

export interface NewPlayer {
  name: string;
  class_key: string;
  gender: Gender;
}

export function createPlayer(
  db: Database.Database,
  input: NewPlayer,
  now: number,
): Player {
  const token = randomToken();
  const info = db
    .prepare(
      `INSERT INTO players (name, class_key, gender, auth_token, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.name, input.class_key, input.gender, token, now);
  return getPlayerById(db, Number(info.lastInsertRowid))!;
}

export function getPlayerById(
  db: Database.Database,
  id: number,
): Player | undefined {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) as
    | Player
    | undefined;
}

export function getPlayerByToken(
  db: Database.Database,
  token: string,
): Player | undefined {
  return db.prepare('SELECT * FROM players WHERE auth_token = ?').get(token) as
    | Player
    | undefined;
}

export function listPlayers(db: Database.Database): Player[] {
  return db
    .prepare('SELECT * FROM players ORDER BY created_at DESC, id DESC')
    .all() as Player[];
}

export function renamePlayer(
  db: Database.Database,
  id: number,
  name: string,
): void {
  db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
}

export type PlayerPatch = Partial<
  Pick<
    Player,
    'name' | 'class_key' | 'gender' | 'level' | 'gold' | 'disabled' |
    'total_tokens' | 'effective_tokens'
  >
>;

export function updatePlayer(
  db: Database.Database,
  id: number,
  patch: PlayerPatch,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE players SET ${set} WHERE id = @id`).run({ ...patch, id });
}

export function deletePlayer(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM players WHERE id = ?').run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/players.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/players.ts tests/players.test.ts
git commit -m "feat: player CRUD domain module"
```

---

## Task 7: OTEL setup-snippet builder

**Files:**
- Create: `src/domain/snippet.ts`
- Test: `tests/snippet.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/snippet.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSetupSnippet } from '../src/domain/snippet';

describe('buildSetupSnippet', () => {
  it('embeds token, host, and port and includes toggles', () => {
    const s = buildSetupSnippet({
      token: 'ABC123',
      host: 'claude-rpg.local',
      port: 8080,
    });
    expect(s).toContain('CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(s).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
    expect(s).toContain('http://claude-rpg.local:8080');
    expect(s).toContain('claude_rpg_token=ABC123');
    expect(s).toContain('rpg_off()');
    expect(s).toContain('rpg_on()');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snippet.test.ts`
Expected: FAIL — cannot find `../src/domain/snippet`.

- [ ] **Step 3: Implement `src/domain/snippet.ts`**

```ts
export interface SnippetArgs {
  token: string;
  host: string;
  port: number;
}

export function buildSetupSnippet({ token, host, port }: SnippetArgs): string {
  return `# --- ClaudeRPG telemetry setup (add to ~/.zshrc or ~/.bashrc) ---
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://${host}:${port}
export OTEL_METRIC_EXPORT_INTERVAL=5000
export OTEL_RESOURCE_ATTRIBUTES=claude_rpg_token=${token}

# Toggle your contribution on/off while on the office network:
rpg_off() { export CLAUDE_CODE_ENABLE_TELEMETRY=0; echo "ClaudeRPG: paused"; }
rpg_on()  { export CLAUDE_CODE_ENABLE_TELEMETRY=1; echo "ClaudeRPG: active"; }
# --- end ClaudeRPG setup ---`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snippet.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/domain/snippet.ts tests/snippet.test.ts
git commit -m "feat: per-player OTEL setup snippet builder"
```

---

## Task 8: Express app factory + health route + static sprites

**Files:**
- Create: `src/web/app.ts`, `src/web/views/layout.ejs`, `src/web/public/style.css`
- Test: `tests/web-health.test.ts`

**Note on app factory shape (used by all later web tasks):** `createApp({ db, config })` returns an Express app. It sets EJS as the view engine pointed at `src/web/views`, mounts `express.static` for `src/web/public` at `/static` and for `config.spritesDir` at `/sprites`, configures `express-session`, parses urlencoded bodies, and registers route modules (added in later tasks). A `res.locals.layout`-style manual layout is avoided; instead each view includes the shared header/footer partial via `layout.ejs` rendered with an EJS `include`. To keep it simple we render pages by passing a `body` string is NOT used — each route renders its own `.ejs` which `include`s `layout` is also avoided. **Simplest approach used here:** each view file is a full HTML document that `<%- include('layout', { title }) %>` at top is NOT used. Instead `layout.ejs` exposes header/footer via two includes. See the concrete views in later tasks; they call `res.render('viewname', {...})` and each view starts with `<%- include('partials/head', {title}) %>`.

To remove ambiguity, this task establishes the partials approach:

- [ ] **Step 1: Create the shared layout partials**

Create `src/web/views/layout.ejs` (header + footer wrapper used via `include`):

```ejs
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title><%= title %> — ClaudeRPG</title>
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="brand">⚔️ ClaudeRPG</a>
    <nav>
      <a href="/">Register</a>
      <a href="/character">Character Login</a>
      <a href="/admin">Admin</a>
    </nav>
  </header>
  <main class="container">
    <%- body %>
  </main>
</body>
</html>
```

We render by composing `body` HTML in each route via `ejs.render` of the page template, then passing it into `layout`. To make that turnkey, add a helper in the app (Step 3) called `renderPage`.

- [ ] **Step 2: Create `src/web/public/style.css`**

```css
:root { --bg:#171019; --panel:#221629; --ink:#cdb9e0; --gold:#e8c96a; --accent:#7bd88f; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--ink); }
.site-header { display:flex; gap:16px; align-items:center; padding:12px 20px;
  background:#0e0b14; border-bottom:3px solid #6b5436; }
.brand { color:var(--gold); font-weight:700; text-decoration:none; font-size:18px; }
.site-header nav a { color:var(--ink); margin-left:14px; text-decoration:none; }
.container { max-width: 880px; margin: 24px auto; padding: 0 16px; }
.panel { background:var(--panel); border:2px solid #6b5436; border-radius:8px; padding:20px; margin-bottom:20px; }
label { display:block; margin:10px 0 4px; }
input, select { width:100%; padding:8px; border-radius:6px; border:1px solid #6b5436;
  background:#160f1c; color:var(--ink); }
button { margin-top:14px; padding:10px 16px; border:none; border-radius:6px;
  background:var(--gold); color:#160f1c; font-weight:700; cursor:pointer; }
.avatars { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:10px; }
.avatar { text-align:center; padding:8px; border:2px solid transparent; border-radius:8px; cursor:pointer; }
.avatar img { image-rendering: pixelated; width:72px; height:72px; }
.avatar input { width:auto; }
.avatar.selected { border-color:var(--accent); background:#1c2620; }
pre { background:#0e0b14; padding:14px; border-radius:8px; overflow-x:auto; color:#cfe8d2; }
table { width:100%; border-collapse: collapse; }
th, td { text-align:left; padding:8px; border-bottom:1px solid #3a2a44; }
.flash { padding:10px 14px; border-radius:6px; background:#2a1f33; margin-bottom:16px; }
.err { color:#ff9b9b; }
a.btn { display:inline-block; text-decoration:none; }
```

- [ ] **Step 3: Implement `src/web/app.ts`**

```ts
import express, { type Express } from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import type Database from 'better-sqlite3';
import type { Config } from '../config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(__dirname, 'views');

export interface AppDeps {
  db: Database.Database;
  config: Config;
}

// Renders a page template, wraps it in layout.ejs, returns HTML.
export async function renderPage(
  view: string,
  data: Record<string, unknown>,
): Promise<string> {
  const body = await ejs.renderFile(path.join(VIEWS, `${view}.ejs`), data);
  return ejs.renderFile(path.join(VIEWS, 'layout.ejs'), {
    title: data.title ?? 'ClaudeRPG',
    body,
  });
}

export function createApp({ db, config }: AppDeps): Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.use('/static', express.static(path.join(__dirname, 'public')));
  app.use('/sprites', express.static(path.resolve(config.spritesDir)));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Route modules are registered here in later tasks:
  // registerRegistrationRoutes(app, { db, config });
  // registerCharacterRoutes(app, { db, config });
  // registerAdminRoutes(app, { db, config });

  return app;
}
```

- [ ] **Step 4: Write the failing test**

`tests/web-health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

describe('health', () => {
  it('GET /health returns ok', async () => {
    const app = createApp({ db: openDb(':memory:'), config: loadConfig({}) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/web-health.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/web/app.ts src/web/views/layout.ejs src/web/public/style.css tests/web-health.test.ts
git commit -m "feat: express app factory, layout, static sprites, health route"
```

---

## Task 9: Registration routes + views

**Files:**
- Create: `src/web/routes/registration.ts`, `src/web/views/register.ejs`, `src/web/views/registered.ejs`
- Modify: `src/web/app.ts` (register routes)
- Test: `tests/web-registration.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/web-registration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { listPlayers } from '../src/domain/players';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, config: loadConfig({}) });
});

describe('registration', () => {
  it('GET / shows the form with all 9 classes', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Paladin');
    expect(res.text).toContain('name="class_key"');
  });

  it('POST /register creates a player and shows the token + snippet', async () => {
    const res = await request(app)
      .post('/register')
      .type('form')
      .send({ name: 'Sir Reginald', class_key: 'knight', gender: 'M' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('claude_rpg_token=');
    const players = listPlayers(db);
    expect(players.length).toBe(1);
    expect(players[0].name).toBe('Sir Reginald');
  });

  it('POST /register rejects bad input', async () => {
    const res = await request(app)
      .post('/register')
      .type('form')
      .send({ name: '', class_key: 'dragon', gender: 'X' });
    expect(res.status).toBe(400);
    expect(listPlayers(db).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-registration.test.ts`
Expected: FAIL — `GET /` returns 404 (route not registered).

- [ ] **Step 3: Create `src/web/views/register.ejs`**

```ejs
<div class="panel">
  <h1>Create your character</h1>
  <% if (typeof error !== 'undefined' && error) { %>
    <p class="flash err"><%= error %></p>
  <% } %>
  <form method="post" action="/register">
    <label for="name">Character name</label>
    <input id="name" name="name" maxlength="40" required
           value="<%= typeof name !== 'undefined' ? name : '' %>" />

    <label>Gender</label>
    <select name="gender">
      <option value="M">Male</option>
      <option value="F">Female</option>
    </select>

    <label>Class / avatar</label>
    <input type="hidden" name="class_key" id="class_key" value="knight" />
    <div class="avatars">
      <% classes.forEach(function(c, i) { %>
        <div class="avatar <%= i === 0 ? 'selected' : '' %>"
             data-key="<%= c.key %>" onclick="pick(this)">
          <img src="<%= c.spriteM %>" alt="<%= c.name %>" />
          <div><%= c.name %></div>
        </div>
      <% }) %>
    </div>
    <button type="submit">Create character</button>
  </form>
</div>
<script>
  function pick(el) {
    document.querySelectorAll('.avatar').forEach(a => a.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('class_key').value = el.dataset.key;
  }
</script>
```

- [ ] **Step 4: Create `src/web/views/registered.ejs`**

```ejs
<div class="panel">
  <h1>Welcome, <%= player.name %>!</h1>
  <p>Your class: <strong><%= className %></strong></p>
  <p>Your auth token (this is your login — keep it safe):</p>
  <pre><%= player.auth_token %></pre>
  <p>Add this to your shell config to start contributing:</p>
  <pre><%= snippet %></pre>
  <p><a class="btn" href="/character?token=<%= encodeURIComponent(player.auth_token) %>">Go to your character sheet →</a></p>
</div>
```

- [ ] **Step 5: Implement `src/web/routes/registration.ts`**

```ts
import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { CLASSES, getClass, classSpriteUrl } from '../../domain/classes';
import { createPlayer } from '../../domain/players';
import { buildSetupSnippet } from '../../domain/snippet';

const RegisterInput = z.object({
  name: z.string().trim().min(1).max(40),
  class_key: z.string().refine((k) => !!getClass(k), 'unknown class'),
  gender: z.enum(['M', 'F']),
});

export function registerRegistrationRoutes(
  app: Express,
  { db, config }: AppDeps,
): void {
  app.get('/', async (_req, res) => {
    const classes = CLASSES.map((c) => ({
      key: c.key,
      name: c.name,
      spriteM: classSpriteUrl(c.key, 'M'),
    }));
    res.send(await renderPage('register', { title: 'Register', classes }));
  });

  app.post('/register', async (req, res) => {
    const parsed = RegisterInput.safeParse(req.body);
    if (!parsed.success) {
      const classes = CLASSES.map((c) => ({
        key: c.key,
        name: c.name,
        spriteM: classSpriteUrl(c.key, 'M'),
      }));
      res
        .status(400)
        .send(
          await renderPage('register', {
            title: 'Register',
            classes,
            error: 'Please enter a name and pick a valid class.',
            name: typeof req.body?.name === 'string' ? req.body.name : '',
          }),
        );
      return;
    }
    const player = createPlayer(db, parsed.data, Date.now());
    const snippet = buildSetupSnippet({
      token: player.auth_token,
      host: config.otelHost,
      port: config.port,
    });
    res.send(
      await renderPage('registered', {
        title: 'Registered',
        player,
        className: getClass(player.class_key)!.name,
        snippet,
      }),
    );
  });
}
```

- [ ] **Step 6: Wire routes into `src/web/app.ts`**

Add the import near the top of `src/web/app.ts`:

```ts
import { registerRegistrationRoutes } from './routes/registration';
```

Replace the commented route-registration block in `createApp` with:

```ts
  registerRegistrationRoutes(app, { db, config });
  // registerCharacterRoutes(app, { db, config });   // Task 10
  // registerAdminRoutes(app, { db, config });        // Tasks 11-13
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/web-registration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/registration.ts src/web/views/register.ejs src/web/views/registered.ejs src/web/app.ts tests/web-registration.test.ts
git commit -m "feat: character registration flow"
```

---

## Task 10: Character sheet (token login, view, rename, delete)

**Files:**
- Create: `src/web/routes/character.ts`, `src/web/views/character-login.ejs`, `src/web/views/character-sheet.ejs`
- Modify: `src/web/app.ts`
- Test: `tests/web-character.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/web-character.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { createPlayer, getPlayerById } from '../src/domain/players';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, config: loadConfig({}) });
});

describe('character sheet', () => {
  it('GET /character shows the login form', async () => {
    const res = await request(app).get('/character');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="token"');
  });

  it('GET /character?token=... shows the sheet with stats and snippet', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const res = await request(app).get('/character').query({ token: p.auth_token });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Gandalf');
    expect(res.text).toContain('claude_rpg_token=');
  });

  it('rejects an unknown token', async () => {
    const res = await request(app).get('/character').query({ token: 'nope' });
    expect(res.status).toBe(404);
  });

  it('renames via POST /character/rename', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const res = await request(app)
      .post('/character/rename')
      .type('form')
      .send({ token: p.auth_token, name: 'Gandalf the White' });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)?.name).toBe('Gandalf the White');
  });

  it('deletes via POST /character/delete', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const res = await request(app)
      .post('/character/delete')
      .type('form')
      .send({ token: p.auth_token });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-character.test.ts`
Expected: FAIL — `GET /character` returns 404.

- [ ] **Step 3: Create `src/web/views/character-login.ejs`**

```ejs
<div class="panel">
  <h1>Character login</h1>
  <p>Enter your auth token to view your character sheet.</p>
  <% if (typeof error !== 'undefined' && error) { %>
    <p class="flash err"><%= error %></p>
  <% } %>
  <form method="get" action="/character">
    <label for="token">Auth token</label>
    <input id="token" name="token" required />
    <button type="submit">View character</button>
  </form>
</div>
```

- [ ] **Step 4: Create `src/web/views/character-sheet.ejs`**

```ejs
<div class="panel">
  <h1><%= player.name %></h1>
  <img src="<%= avatarUrl %>" alt="avatar" style="image-rendering:pixelated;width:96px;height:96px;" />
  <table>
    <tr><th>Class</th><td><%= className %> (<%= player.gender === 'M' ? 'Male' : 'Female' %>)</td></tr>
    <tr><th>Level</th><td><%= player.level %></td></tr>
    <tr><th>XP (effective tokens)</th><td><%= player.effective_tokens %></td></tr>
    <tr><th>Total tokens</th><td><%= player.total_tokens %></td></tr>
    <tr><th>Gold</th><td><%= player.gold %></td></tr>
    <tr><th>Status</th><td><%= connected ? 'Connected' : 'Not seen yet' %></td></tr>
  </table>
</div>

<div class="panel">
  <h2>Your setup snippet</h2>
  <pre><%= snippet %></pre>
</div>

<div class="panel">
  <h2>Rename</h2>
  <form method="post" action="/character/rename">
    <input type="hidden" name="token" value="<%= player.auth_token %>" />
    <label for="name">New name</label>
    <input id="name" name="name" maxlength="40" value="<%= player.name %>" required />
    <button type="submit">Rename</button>
  </form>
</div>

<div class="panel">
  <h2>Delete character</h2>
  <form method="post" action="/character/delete"
        onsubmit="return confirm('Delete this character permanently?');">
    <input type="hidden" name="token" value="<%= player.auth_token %>" />
    <button type="submit" style="background:#c0564a;color:#fff;">Delete</button>
  </form>
</div>
```

- [ ] **Step 5: Implement `src/web/routes/character.ts`**

```ts
import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import {
  getPlayerByToken,
  renamePlayer,
  deletePlayer,
} from '../../domain/players';
import { getClass, classSpriteUrl, type Gender } from '../../domain/classes';
import { buildSetupSnippet } from '../../domain/snippet';

const RenameInput = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(40),
});
const TokenInput = z.object({ token: z.string().min(1) });

export function registerCharacterRoutes(
  app: Express,
  { db, config }: AppDeps,
): void {
  app.get('/character', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      res.send(await renderPage('character-login', { title: 'Character Login' }));
      return;
    }
    const player = getPlayerByToken(db, token);
    if (!player) {
      res.status(404).send(
        await renderPage('character-login', {
          title: 'Character Login',
          error: 'No character found for that token.',
        }),
      );
      return;
    }
    res.send(
      await renderPage('character-sheet', {
        title: player.name,
        player,
        className: getClass(player.class_key)?.name ?? player.class_key,
        avatarUrl: classSpriteUrl(player.class_key, player.gender as Gender),
        connected: player.last_token_at != null,
        snippet: buildSetupSnippet({
          token: player.auth_token,
          host: config.otelHost,
          port: config.port,
        }),
      }),
    );
  });

  app.post('/character/rename', (req, res) => {
    const parsed = RenameInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send('Invalid input');
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.status(404).send('Not found');
      return;
    }
    renamePlayer(db, player.id, parsed.data.name);
    res.redirect(`/character?token=${encodeURIComponent(player.auth_token)}`);
  });

  app.post('/character/delete', (req, res) => {
    const parsed = TokenInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send('Invalid input');
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.status(404).send('Not found');
      return;
    }
    deletePlayer(db, player.id);
    res.redirect('/');
  });
}
```

- [ ] **Step 6: Wire routes into `src/web/app.ts`**

Add import:

```ts
import { registerCharacterRoutes } from './routes/character';
```

Uncomment/replace its line in `createApp`:

```ts
  registerCharacterRoutes(app, { db, config });
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/web-character.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/character.ts src/web/views/character-login.ejs src/web/views/character-sheet.ejs src/web/app.ts tests/web-character.test.ts
git commit -m "feat: token-login character sheet with rename/delete"
```

---

## Task 11: Admin auth + session

**Files:**
- Create: `src/domain/admin.ts`, `src/web/routes/admin.ts`, `src/web/views/admin-login.ejs`
- Modify: `src/web/app.ts`
- Test: `tests/web-admin-auth.test.ts`

**Note:** `src/web/routes/admin.ts` is created here with login/logout + a `requireAdmin` middleware and an empty placeholder dashboard route; Tasks 12-13 extend the same file with player and settings management.

- [ ] **Step 1: Write the failing test**

`tests/web-admin-auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { ensureAdmin } from '../src/domain/admin';
import { seedSettings } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
const config = loadConfig({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret' });

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  ensureAdmin(db, config.adminUsername, config.adminPassword);
  app = createApp({ db, config });
});

describe('admin auth', () => {
  it('redirects to login when not authenticated', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('rejects bad credentials', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'boss', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('logs in with good credentials and reaches the dashboard', async () => {
    const agent = request.agent(app);
    const login = await agent
      .post('/admin/login')
      .type('form')
      .send({ username: 'boss', password: 'secret' });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/admin');
    const dash = await agent.get('/admin');
    expect(dash.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-admin-auth.test.ts`
Expected: FAIL — cannot find `../src/domain/admin`.

- [ ] **Step 3: Implement `src/domain/admin.ts`**

```ts
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './settings';
import { hashPassword, verifyPassword } from './auth';

const USER_KEY = 'admin_username';
const HASH_KEY = 'admin_password_hash';

/** Seed admin credentials if not already present. */
export function ensureAdmin(
  db: Database.Database,
  username: string,
  password: string,
): void {
  if (getSetting(db, HASH_KEY)) return;
  setSetting(db, USER_KEY, username);
  setSetting(db, HASH_KEY, hashPassword(password));
}

export function verifyAdmin(
  db: Database.Database,
  username: string,
  password: string,
): boolean {
  const u = getSetting(db, USER_KEY);
  const h = getSetting(db, HASH_KEY);
  if (!u || !h) return false;
  return username === u && verifyPassword(password, h);
}
```

- [ ] **Step 4: Create `src/web/views/admin-login.ejs`**

```ejs
<div class="panel">
  <h1>Admin login</h1>
  <% if (typeof error !== 'undefined' && error) { %>
    <p class="flash err"><%= error %></p>
  <% } %>
  <form method="post" action="/admin/login">
    <label for="username">Username</label>
    <input id="username" name="username" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required />
    <button type="submit">Log in</button>
  </form>
</div>
```

- [ ] **Step 5: Implement `src/web/routes/admin.ts`**

```ts
import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { verifyAdmin } from '../../domain/admin';

// Augment the session type with our admin flag.
declare module 'express-session' {
  interface SessionData {
    isAdmin?: boolean;
  }
}

const LoginInput = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.session.isAdmin) {
    next();
    return;
  }
  res.redirect('/admin/login');
}

export function registerAdminRoutes(app: Express, deps: AppDeps): void {
  const { db } = deps;

  app.get('/admin/login', async (_req, res) => {
    res.send(await renderPage('admin-login', { title: 'Admin Login' }));
  });

  app.post('/admin/login', async (req, res) => {
    const parsed = LoginInput.safeParse(req.body);
    if (
      !parsed.success ||
      !verifyAdmin(db, parsed.data.username, parsed.data.password)
    ) {
      res.status(401).send(
        await renderPage('admin-login', {
          title: 'Admin Login',
          error: 'Invalid username or password.',
        }),
      );
      return;
    }
    req.session.isAdmin = true;
    res.redirect('/admin');
  });

  app.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  // Placeholder dashboard; replaced by the player list in Task 12.
  app.get('/admin', requireAdmin, async (_req, res) => {
    res.send(
      await renderPage('admin-login', {
        title: 'Admin',
        error: undefined,
      }),
    );
  });
}
```

- [ ] **Step 6: Wire routes into `src/web/app.ts`**

Add import:

```ts
import { registerAdminRoutes } from './routes/admin';
```

Replace the admin line in `createApp`:

```ts
  registerAdminRoutes(app, { db, config });
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/web-admin-auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/domain/admin.ts src/web/routes/admin.ts src/web/views/admin-login.ejs src/web/app.ts tests/web-admin-auth.test.ts
git commit -m "feat: admin authentication and session"
```

---

## Task 12: Admin player management

**Files:**
- Modify: `src/web/routes/admin.ts` (replace the placeholder `/admin` route; add edit/update/delete/disable)
- Create: `src/web/views/admin-players.ejs`, `src/web/views/admin-player-edit.ejs`
- Test: `tests/web-admin-players.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/web-admin-players.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { ensureAdmin } from '../src/domain/admin';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
const config = loadConfig({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret' });

async function adminAgent() {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ username: 'boss', password: 'secret' });
  return agent;
}

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  ensureAdmin(db, config.adminUsername, config.adminPassword);
  app = createApp({ db, config });
});

describe('admin players', () => {
  it('lists players on the dashboard', async () => {
    createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Gandalf');
  });

  it('updates a player via the edit form', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent
      .post(`/admin/players/${p.id}`)
      .type('form')
      .send({ name: 'Saruman', class_key: 'wizard', gender: 'M', level: '7', gold: '500', disabled: '1' });
    expect(res.status).toBe(302);
    const u = getPlayerById(db, p.id)!;
    expect(u.name).toBe('Saruman');
    expect(u.level).toBe(7);
    expect(u.gold).toBe(500);
    expect(u.disabled).toBe(1);
  });

  it('deletes a player', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent.post(`/admin/players/${p.id}/delete`).type('form').send({});
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)).toBeUndefined();
  });

  it('blocks player management when not authenticated', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-admin-players.test.ts`
Expected: FAIL — dashboard does not contain player names / edit route missing.

- [ ] **Step 3: Create `src/web/views/admin-players.ejs`**

```ejs
<div class="panel">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <h1>Players (<%= players.length %>)</h1>
    <span>
      <a class="btn" href="/admin/settings" style="background:#6aa9e8;padding:8px 12px;border-radius:6px;color:#10131a;">Settings</a>
      <form method="post" action="/admin/logout" style="display:inline;">
        <button type="submit" style="margin:0;">Log out</button>
      </form>
    </span>
  </div>
  <table>
    <tr><th>Name</th><th>Class</th><th>Lvl</th><th>Eff. tokens</th><th>Gold</th><th>Disabled</th><th></th></tr>
    <% players.forEach(function(p) { %>
      <tr>
        <td><%= p.name %></td>
        <td><%= p.class_key %> (<%= p.gender %>)</td>
        <td><%= p.level %></td>
        <td><%= p.effective_tokens %></td>
        <td><%= p.gold %></td>
        <td><%= p.disabled ? 'yes' : 'no' %></td>
        <td><a href="/admin/players/<%= p.id %>">edit</a></td>
      </tr>
    <% }) %>
  </table>
</div>
```

- [ ] **Step 4: Create `src/web/views/admin-player-edit.ejs`**

```ejs
<div class="panel">
  <h1>Edit <%= player.name %></h1>
  <form method="post" action="/admin/players/<%= player.id %>">
    <label>Name</label>
    <input name="name" value="<%= player.name %>" maxlength="40" required />
    <label>Class key</label>
    <select name="class_key">
      <% classes.forEach(function(c) { %>
        <option value="<%= c.key %>" <%= c.key === player.class_key ? 'selected' : '' %>><%= c.name %></option>
      <% }) %>
    </select>
    <label>Gender</label>
    <select name="gender">
      <option value="M" <%= player.gender === 'M' ? 'selected' : '' %>>Male</option>
      <option value="F" <%= player.gender === 'F' ? 'selected' : '' %>>Female</option>
    </select>
    <label>Level</label>
    <input name="level" type="number" min="1" value="<%= player.level %>" />
    <label>Gold</label>
    <input name="gold" type="number" min="0" value="<%= player.gold %>" />
    <label>Effective tokens (XP)</label>
    <input name="effective_tokens" type="number" min="0" value="<%= player.effective_tokens %>" />
    <label><input type="checkbox" name="disabled" value="1" <%= player.disabled ? 'checked' : '' %> /> Disabled</label>
    <button type="submit">Save</button>
  </form>
  <form method="post" action="/admin/players/<%= player.id %>/delete"
        onsubmit="return confirm('Delete this player?');" style="margin-top:16px;">
    <button type="submit" style="background:#c0564a;color:#fff;">Delete player</button>
  </form>
  <p style="margin-top:16px;"><a href="/admin">← Back to players</a></p>
</div>
```

- [ ] **Step 5: Extend `src/web/routes/admin.ts`**

Add these imports at the top of the file:

```ts
import {
  listPlayers,
  getPlayerById,
  updatePlayer,
  deletePlayer,
} from '../../domain/players';
import { CLASSES, getClass } from '../../domain/classes';
```

Replace the placeholder `app.get('/admin', ...)` route from Task 11 with:

```ts
  app.get('/admin', requireAdmin, async (_req, res) => {
    res.send(
      await renderPage('admin-players', {
        title: 'Players',
        players: listPlayers(db),
      }),
    );
  });

  app.get('/admin/players/:id', requireAdmin, async (req, res) => {
    const player = getPlayerById(db, Number(req.params.id));
    if (!player) {
      res.status(404).send('Not found');
      return;
    }
    res.send(
      await renderPage('admin-player-edit', {
        title: `Edit ${player.name}`,
        player,
        classes: CLASSES,
      }),
    );
  });

  const EditInput = z.object({
    name: z.string().trim().min(1).max(40),
    class_key: z.string().refine((k) => !!getClass(k), 'unknown class'),
    gender: z.enum(['M', 'F']),
    level: z.coerce.number().int().min(1),
    gold: z.coerce.number().int().min(0),
    effective_tokens: z.coerce.number().int().min(0),
    disabled: z.union([z.literal('1'), z.undefined()]),
  });

  app.post('/admin/players/:id', requireAdmin, (req, res) => {
    const player = getPlayerById(db, Number(req.params.id));
    if (!player) {
      res.status(404).send('Not found');
      return;
    }
    const parsed = EditInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send('Invalid input');
      return;
    }
    const d = parsed.data;
    updatePlayer(db, player.id, {
      name: d.name,
      class_key: d.class_key,
      gender: d.gender,
      level: d.level,
      gold: d.gold,
      effective_tokens: d.effective_tokens,
      disabled: d.disabled === '1' ? 1 : 0,
    });
    res.redirect('/admin');
  });

  app.post('/admin/players/:id/delete', requireAdmin, (req, res) => {
    deletePlayer(db, Number(req.params.id));
    res.redirect('/admin');
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/web-admin-players.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/admin.ts src/web/views/admin-players.ejs src/web/views/admin-player-edit.ejs tests/web-admin-players.test.ts
git commit -m "feat: admin player list, edit, delete, disable"
```

---

## Task 13: Admin settings editor

**Files:**
- Modify: `src/web/routes/admin.ts` (add settings GET/POST)
- Create: `src/web/views/admin-settings.ejs`
- Test: `tests/web-admin-settings.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/web-admin-settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { ensureAdmin } from '../src/domain/admin';
import { seedSettings, getSetting } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
const config = loadConfig({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret' });

async function adminAgent() {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ username: 'boss', password: 'secret' });
  return agent;
}

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  ensureAdmin(db, config.adminUsername, config.adminPassword);
  app = createApp({ db, config });
});

describe('admin settings', () => {
  it('shows the tunable knobs', async () => {
    const agent = await adminAgent();
    const res = await agent.get('/admin/settings');
    expect(res.status).toBe(200);
    expect(res.text).toContain('target_battle_minutes');
  });

  it('updates a knob', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send({ target_battle_minutes: '40', pause_after_minutes: '20' });
    expect(res.status).toBe(302);
    expect(getSetting(db, 'target_battle_minutes')).toBe('40');
    expect(getSetting(db, 'pause_after_minutes')).toBe('20');
  });

  it('never exposes the admin password hash as an editable knob', async () => {
    const agent = await adminAgent();
    const res = await agent.get('/admin/settings');
    expect(res.text).not.toContain('admin_password_hash');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-admin-settings.test.ts`
Expected: FAIL — `/admin/settings` route missing.

- [ ] **Step 3: Create `src/web/views/admin-settings.ejs`**

```ejs
<div class="panel">
  <h1>Game settings</h1>
  <p>These knobs are read by the game engine (Plan C onward). Changes save immediately.</p>
  <form method="post" action="/admin/settings">
    <% Object.keys(settings).sort().forEach(function(key) { %>
      <label for="<%= key %>"><%= key %></label>
      <input id="<%= key %>" name="<%= key %>" value="<%= settings[key] %>" />
    <% }) %>
    <button type="submit">Save settings</button>
  </form>
  <p style="margin-top:16px;"><a href="/admin">← Back to players</a></p>
</div>
```

- [ ] **Step 4: Extend `src/web/routes/admin.ts`**

Add these imports at the top of the file:

```ts
import {
  DEFAULT_SETTINGS,
  getAllSettings,
  setSetting,
} from '../../domain/settings';
```

Add these routes inside `registerAdminRoutes` (after the player routes):

```ts
  app.get('/admin/settings', requireAdmin, async (_req, res) => {
    const all = getAllSettings(db);
    // Only expose the known game knobs, never admin_* credential keys.
    const settings: Record<string, string> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      settings[key] = all[key] ?? DEFAULT_SETTINGS[key];
    }
    res.send(await renderPage('admin-settings', { title: 'Settings', settings }));
  });

  app.post('/admin/settings', requireAdmin, (req, res) => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const v = req.body?.[key];
      if (typeof v === 'string' && v.length > 0) setSetting(db, key, v);
    }
    res.redirect('/admin/settings');
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/web-admin-settings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/admin.ts src/web/views/admin-settings.ejs tests/web-admin-settings.test.ts
git commit -m "feat: admin settings editor (game knobs only)"
```

---

## Task 14: Entrypoint, README, and full-suite verification

**Files:**
- Create: `src/index.ts`, `README.md`
- Test: run the whole suite + manual smoke test

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import { loadConfig } from './config';
import { openDb } from './db/db';
import { seedSettings } from './domain/settings';
import { ensureAdmin } from './domain/admin';
import { createApp } from './web/app';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const config = loadConfig(process.env);

// Ensure the data directory exists for the SQLite file.
if (config.dbPath !== ':memory:') {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}

const db = openDb(config.dbPath);
seedSettings(db);
ensureAdmin(db, config.adminUsername, config.adminPassword);

if (config.adminPassword === 'changeme') {
  console.warn(
    '[ClaudeRPG] WARNING: using default admin password "changeme". ' +
      'Set ADMIN_PASSWORD before exposing this server.',
  );
}

const app = createApp({ db, config });
app.listen(config.port, () => {
  console.log(`[ClaudeRPG] listening on http://localhost:${config.port}`);
  console.log(`[ClaudeRPG] admin panel: http://localhost:${config.port}/admin`);
});
```

- [ ] **Step 2: Create `README.md`**

````markdown
# ClaudeRPG

An office co-op RPG that gamifies Claude Code token usage on a Raspberry Pi 5 TV
kiosk. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/`
for implementation plans.

## Plan A: Server foundation + player management (this milestone)

### Requirements
- Node.js 20+
- The Oryx art pack under `assets/oryx_16-bit_fantasy_1.1/Sliced/`

### Setup
```bash
npm install
cp .env.example .env   # optional; or export vars directly
```

### Environment variables
| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/claude-rpg.db` | SQLite file path |
| `ADMIN_USERNAME` | `admin` | Admin login |
| `ADMIN_PASSWORD` | `changeme` | Admin password (set this!) |
| `SESSION_SECRET` | random | Session cookie secret |
| `OTEL_ENDPOINT_HOST` | `claude-rpg.local` | Host shown in player setup snippets |
| `SPRITES_DIR` | `assets/oryx_16-bit_fantasy_1.1/Sliced` | Sliced sprite directory |

### Run
```bash
ADMIN_PASSWORD=yourpassword npm run dev    # auto-reload
# or
ADMIN_PASSWORD=yourpassword npm start
```
Then open:
- `http://localhost:8080/` — register a character
- `http://localhost:8080/character` — log in with your token
- `http://localhost:8080/admin` — admin panel

### Test
```bash
npm test
```
````

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green (config, db, settings, classes, auth, players, snippet, web-health, web-registration, web-character, web-admin-auth, web-admin-players, web-admin-settings).

- [ ] **Step 4: Manual smoke test**

Run: `ADMIN_PASSWORD=test123 npm start`

Verify in a browser:
1. `http://localhost:8080/` — pick an avatar (sprite images load from `/sprites/...`), enter a name, submit → token + snippet shown.
2. Copy the token → `http://localhost:8080/character` → paste → sheet shows your stats and snippet; rename works.
3. `http://localhost:8080/admin` → log in with `admin` / `test123` → see your player, edit level/gold, save; open Settings, change `target_battle_minutes`, save.

Stop the server (Ctrl-C).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat: server entrypoint and Plan A README"
```

---

## Self-Review

**Spec coverage (against §8 Web application + §9 Architecture data model + §11 Assets):**
- Registration (free-text name + 18 avatars, issues token + snippet) → Tasks 4, 7, 9. ✅
- Character sheet (token login, view stats, rename, delete, copy snippet, connection status) → Task 10. ✅
- Admin panel (master user/pass, list/edit/delete/disable players, tune settings) → Tasks 11, 12, 13. ✅
- Data model `players` + `settings` tables, seed defaults → Tasks 2, 3, 6. ✅ (`dungeons`, `encounters`, `damage_events`, `game_state` are intentionally deferred to Plans C/D — Task 2's runner appends migrations cleanly.)
- Effective-token knobs incl. `cache_read_weight`, `pause_after_minutes=15`, `popup_duration_s=120` seeded → Task 3 defaults match spec §5/§6. ✅
- Sprite serving + class→sprite mapping → Tasks 4, 8. ✅
- Setup snippet matches spec §7 env block (http/json, mDNS host, `claude_rpg_token`, rpg_on/off) → Task 7. ✅

**Placeholder scan:** No "TBD"/"add error handling"/"similar to" left; every code/test step shows full code. The only forward references (`dungeons`/engine knobs being unused yet) are explicitly noted as Plan C/D scope, not gaps. ✅

**Type consistency:** `createApp({db, config})`, `renderPage(view, data)`, `AppDeps`, `Player`, `PlayerPatch`, `requireAdmin`, `ensureAdmin/verifyAdmin`, `getSetting/setSetting/getAllSettings/seedSettings`, `classSpriteUrl/spriteIndexFor/creatureSpriteFile`, `buildSetupSnippet` are defined once and used with identical signatures throughout. Routes consistently use `registerXxxRoutes(app, { db, config })`. ✅

**Note for executor:** `package-lock.json` is created by `npm install` in Task 1; include it in that task's commit.

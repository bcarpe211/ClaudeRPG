import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';
import { buildScoringV2Audit } from '../tools/runtime-raiders/audit-scoring-v2';

const CUTOVER = 1_800_000_000_000;
const fixtureDirectories: string[] = [];

interface DatabaseEvidence {
  bytes: Buffer;
  mtimeNs: bigint;
  ctimeNs: bigint;
  rows: Array<Record<string, number | string>>;
}

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'clauderpg-scoring-audit-'));
  fixtureDirectories.push(directory);
  const dbPath = join(directory, 'snapshot.db');
  const db = openDb(dbPath);
  try {
    const player = createPlayer(db, {
      name: 'forbidden-player-name',
      class_key: 'knight',
      gender: 'M',
    }, CUTOVER - 10_000);
    db.prepare(`
      UPDATE players SET auth_token = ? WHERE id = ?
    `).run('forbidden-auth-token', player.id);
    db.prepare(`
      INSERT INTO raider_identities (player_id, dedupe_secret, created_at)
      VALUES (?, ?, ?)
    `).run(player.id, 'a'.repeat(64), CUTOVER - 10_000);
    const insertRun = db.prepare(`
      INSERT INTO runs
        (player_id, provider, surface, run_key, state, started_at_ms,
         last_event_at_ms, last_observed_at_ms, usage_input, usage_output,
         usage_cache_read, usage_cache_write, usage_reasoning_output,
         latest_model, latest_effort, policy_version, awarded_usage_credit,
         created_at, updated_at)
      VALUES (?, 'codex', 'codex_desktop', ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRun.run(
      player.id,
      '1'.repeat(64),
      CUTOVER - 1,
      CUTOVER,
      CUTOVER,
      1_000,
      200,
      900,
      20,
      100,
      'forbidden-model',
      'forbidden-effort',
      'raid-power-v1',
      1_320,
      CUTOVER - 1,
      CUTOVER,
    );
    insertRun.run(
      player.id,
      '2'.repeat(64),
      CUTOVER,
      CUTOVER + 1,
      CUTOVER + 1,
      100,
      25,
      101,
      0,
      0,
      'another-forbidden-model',
      'another-forbidden-effort',
      'raid-power-v2',
      126,
      CUTOVER,
      CUTOVER + 1,
    );
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return dbPath;
}

function storedRows(dbPath: string): Array<Record<string, number | string>> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT id, policy_version, usage_input, usage_output, usage_cache_read,
             usage_cache_write, usage_reasoning_output, awarded_usage_credit
      FROM runs ORDER BY id
    `).all() as Array<Record<string, number | string>>;
  } finally {
    db.close();
  }
}

function evidence(dbPath: string): DatabaseEvidence {
  const timestamps = statSync(dbPath, { bigint: true });
  return {
    bytes: readFileSync(dbPath),
    mtimeNs: timestamps.mtimeNs,
    ctimeNs: timestamps.ctimeNs,
    rows: storedRows(dbPath),
  };
}

function runAudit(dbPath: string, cutoff: string): string {
  return execFileSync(
    'npm',
    ['run', '--silent', 'audit:scoring-v2', '--', '--db', dbPath, '--v2-cutover', cutoff],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

beforeEach(() => {
  expect(isAbsolute(process.cwd())).toBe(true);
});

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('scoring v2 audit', () => {
  it('reports v2 counterfactuals and marks invalid nested counters', () => {
    const dbPath = createFixture();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(buildScoringV2Audit(db, CUTOVER)).toEqual({
        runs: [
          {
            id: 1,
            stored_policy_version: 'raid-power-v1',
            cutover_policy_version: 'raid-power-v1',
            usage: {
              input: 1_000,
              output: 200,
              cache_read: 900,
              cache_write: 20,
              reasoning_output: 100,
            },
            stored_usage_award: 1_320,
            hypothetical_v2_usage: 300,
            validity: 'valid',
          },
          {
            id: 2,
            stored_policy_version: 'raid-power-v2',
            cutover_policy_version: 'raid-power-v2',
            usage: {
              input: 100,
              output: 25,
              cache_read: 101,
              cache_write: 0,
              reasoning_output: 0,
            },
            stored_usage_award: 126,
            hypothetical_v2_usage: null,
            validity: 'invalid_nested_usage',
          },
        ],
        aggregates: {
          runs: 2,
          valid: 1,
          invalid_nested_usage: 1,
          stored_usage_award: 1_446,
          hypothetical_v2_usage: 300,
        },
      });
    } finally {
      db.close();
    }
  });

  it('prints exactly the content-free report without changing snapshot bytes, rows, or write timestamps', () => {
    const dbPath = createFixture();
    const before = evidence(dbPath);

    const stdout = runAudit(dbPath, String(CUTOVER));

    expect(JSON.parse(stdout)).toMatchObject({
      aggregates: {
        runs: 2,
        valid: 1,
        invalid_nested_usage: 1,
        stored_usage_award: 1_446,
        hypothetical_v2_usage: 300,
      },
    });
    expect(stdout.trim()).toBe(JSON.stringify(JSON.parse(stdout)));
    for (const forbidden of [
      'forbidden-player-name',
      'forbidden-auth-token',
      'forbidden-model',
      'forbidden-effort',
      dbPath,
    ]) {
      expect(stdout).not.toContain(forbidden);
    }

    const after = evidence(dbPath);
    expect(after.bytes).toEqual(before.bytes);
    expect(after.rows).toEqual(before.rows);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  });

  it.each([
    ['relative database path', ['--db', 'snapshot.db', '--v2-cutover', String(CUTOVER)]],
    ['missing database path', ['--db', '/definitely/missing/snapshot.db', '--v2-cutover', String(CUTOVER)]],
    ['negative cutoff', ['--db', '/definitely/missing/snapshot.db', '--v2-cutover', '-1']],
    ['fractional cutoff', ['--db', '/definitely/missing/snapshot.db', '--v2-cutover', '1.5']],
    ['unsafe cutoff', ['--db', '/definitely/missing/snapshot.db', '--v2-cutover', '9007199254740992']],
  ])('rejects %s before auditing', (_label, args) => {
    expect(() => execFileSync(
      'npm',
      ['run', '--silent', 'audit:scoring-v2', '--', ...args],
      { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' },
    )).toThrow();
  });
});

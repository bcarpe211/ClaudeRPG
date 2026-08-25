import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  InvalidNestedUsageError,
  loadRaidPowerPolicyV2,
  usageCredit,
} from '../../src/domain/raid-power-policy';
import type { UsageCountersV1 } from '../../src/domain/run-events';

type PolicyVersion = 'raid-power-v1' | 'raid-power-v2' | 'unknown';
type Validity = 'valid' | 'invalid_nested_usage';

interface StoredRun {
  id: number;
  started_at_ms: number;
  policy_version: string;
  usage_input: number;
  usage_output: number;
  usage_cache_read: number;
  usage_cache_write: number;
  usage_reasoning_output: number;
  awarded_usage_credit: number;
}

interface AuditRun {
  id: number;
  stored_policy_version: PolicyVersion;
  cutover_policy_version: 'raid-power-v1' | 'raid-power-v2';
  usage: UsageCountersV1;
  stored_usage_award: number;
  hypothetical_v2_usage: number | null;
  validity: Validity;
}

export interface ScoringV2Audit {
  runs: AuditRun[];
  aggregates: {
    runs: number;
    valid: number;
    invalid_nested_usage: number;
    stored_usage_award: number;
    hypothetical_v2_usage: number;
  };
}

function safeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  safeNonNegativeInteger(left, label);
  safeNonNegativeInteger(right, label);
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return result;
}

function storedPolicyVersion(value: string): PolicyVersion {
  if (value === 'raid-power-v1' || value === 'raid-power-v2') return value;
  return 'unknown';
}

function usageFrom(row: StoredRun): UsageCountersV1 {
  return {
    input: safeNonNegativeInteger(row.usage_input, 'usage input'),
    output: safeNonNegativeInteger(row.usage_output, 'usage output'),
    cache_read: safeNonNegativeInteger(row.usage_cache_read, 'usage cache read'),
    cache_write: safeNonNegativeInteger(row.usage_cache_write, 'usage cache write'),
    reasoning_output: safeNonNegativeInteger(
      row.usage_reasoning_output,
      'usage reasoning output',
    ),
  };
}

export function buildScoringV2Audit(
  db: Database.Database,
  v2CutoverAt: number,
): ScoringV2Audit {
  safeNonNegativeInteger(v2CutoverAt, 'v2 cutover');
  const policy = loadRaidPowerPolicyV2(resolve('config/raid-power-policy-v2.json'));
  const storedRuns = db.prepare(`
    SELECT id, started_at_ms, policy_version, usage_input, usage_output,
           usage_cache_read, usage_cache_write, usage_reasoning_output,
           awarded_usage_credit
    FROM runs
    ORDER BY id
  `).all() as StoredRun[];
  const aggregates = {
    runs: 0,
    valid: 0,
    invalid_nested_usage: 0,
    stored_usage_award: 0,
    hypothetical_v2_usage: 0,
  };
  const runs = storedRuns.map((row): AuditRun => {
    const id = safeNonNegativeInteger(row.id, 'run id');
    const startedAt = safeNonNegativeInteger(row.started_at_ms, 'run start');
    const storedUsageAward = safeNonNegativeInteger(
      row.awarded_usage_credit,
      'stored usage award',
    );
    const usage = usageFrom(row);
    const cutoverPolicyVersion = startedAt < v2CutoverAt ? 'raid-power-v1' : 'raid-power-v2';
    aggregates.runs = safeAdd(aggregates.runs, 1, 'audit run count');
    aggregates.stored_usage_award = safeAdd(
      aggregates.stored_usage_award,
      storedUsageAward,
      'aggregate stored usage award',
    );
    try {
      const hypotheticalV2Usage = usageCredit(policy, 'codex', usage);
      aggregates.valid = safeAdd(aggregates.valid, 1, 'valid run count');
      aggregates.hypothetical_v2_usage = safeAdd(
        aggregates.hypothetical_v2_usage,
        hypotheticalV2Usage,
        'aggregate hypothetical v2 usage',
      );
      return {
        id,
        stored_policy_version: storedPolicyVersion(row.policy_version),
        cutover_policy_version: cutoverPolicyVersion,
        usage,
        stored_usage_award: storedUsageAward,
        hypothetical_v2_usage: hypotheticalV2Usage,
        validity: 'valid',
      };
    } catch (error) {
      if (!(error instanceof InvalidNestedUsageError)) throw error;
      aggregates.invalid_nested_usage = safeAdd(
        aggregates.invalid_nested_usage,
        1,
        'invalid nested usage count',
      );
      return {
        id,
        stored_policy_version: storedPolicyVersion(row.policy_version),
        cutover_policy_version: cutoverPolicyVersion,
        usage,
        stored_usage_award: storedUsageAward,
        hypothetical_v2_usage: null,
        validity: 'invalid_nested_usage',
      };
    }
  });
  return { runs, aggregates };
}

interface AuditArguments {
  dbPath: string;
  v2CutoverAt: number;
}

type OpenAuditDatabase = (
  path: string,
  options: { readonly: true; fileMustExist: true },
) => Database.Database;

const openSqliteDatabase: OpenAuditDatabase = (path, options) => new Database(path, options);

function parseArguments(args: readonly string[]): AuditArguments | null {
  if (args.length !== 4 || args[0] !== '--db' || args[2] !== '--v2-cutover') return null;
  const [dbPath, cutoffText] = [args[1], args[3]];
  const v2CutoverAt = Number(cutoffText);
  if (!isAbsolute(dbPath)
    || !Number.isSafeInteger(v2CutoverAt)
    || v2CutoverAt < 0) {
    return null;
  }
  return { dbPath, v2CutoverAt };
}

export function openReadOnlyAuditDatabase(
  dbPath: string,
  openDatabase: OpenAuditDatabase = openSqliteDatabase,
): Database.Database {
  let validSnapshot = false;
  try {
    validSnapshot = isAbsolute(dbPath) && statSync(dbPath).isFile();
  } catch {
    validSnapshot = false;
  }
  if (!validSnapshot) throw new Error('invalid audit database path');

  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  const parsed = parseArguments(args);
  if (!parsed) {
    console.error('invalid audit arguments');
    process.exitCode = 1;
    return;
  }

  let db: Database.Database | undefined;
  try {
    db = openReadOnlyAuditDatabase(parsed.dbPath);
    process.stdout.write(`${JSON.stringify(buildScoringV2Audit(db, parsed.v2CutoverAt))}\n`);
  } catch {
    console.error('audit failed');
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main();
}

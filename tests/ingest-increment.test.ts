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

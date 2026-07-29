import { describe, expect, it } from 'vitest';
import {
  nextOfficeMidnight,
  officeDayKey,
  officeDayStart,
} from '../src/domain/office-time';

describe('office day', () => {
  it('uses the configured local calendar day', () => {
    const now = Date.parse('2026-07-28T03:30:00Z');
    expect(officeDayKey(now, 'America/New_York')).toBe('2026-07-27');
    expect(officeDayKey(now, 'Europe/London')).toBe('2026-07-28');
  });

  it('finds the current day start and spring-forward midnight', () => {
    const now = Date.parse('2026-03-08T06:30:00Z');
    expect(new Date(officeDayStart(now, 'America/New_York')).toISOString())
      .toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(nextOfficeMidnight(now, 'America/New_York')).toISOString())
      .toBe('2026-03-09T04:00:00.000Z');
  });

  it('finds fall-back midnight without assuming a 24-hour day', () => {
    const now = Date.parse('2026-11-01T05:30:00Z');
    expect(new Date(nextOfficeMidnight(now, 'America/New_York')).toISOString())
      .toBe('2026-11-02T05:00:00.000Z');
  });
});

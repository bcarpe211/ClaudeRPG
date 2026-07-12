import { describe, it, expect } from 'vitest';
import { formatCompact } from '../src/domain/format';

describe('formatCompact', () => {
  it('leaves values under 1000 as integers', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(42)).toBe('42');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(999.6)).toBe('1000'); // rounds
  });
  it('abbreviates with K/M/B/T', () => {
    expect(formatCompact(1000)).toBe('1.0K');
    expect(formatCompact(12400)).toBe('12.4K');
    expect(formatCompact(124000)).toBe('124K');
    expect(formatCompact(3_200_000)).toBe('3.2M');
    expect(formatCompact(1_100_000_000)).toBe('1.1B');
    expect(formatCompact(4_500_000_000_000)).toBe('4.5T');
  });
  it('keeps a sign for negatives', () => {
    expect(formatCompact(-1500)).toBe('-1.5K');
  });
});

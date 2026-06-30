import { describe, it, expect } from 'vitest';
import { CREATURE_SHEET_NAMES } from '../src/web/catalog/spritenames';

describe('CREATURE_SHEET_NAMES', () => {
  it('begins with the 18 class avatars, then creatures', () => {
    expect(CREATURE_SHEET_NAMES[0]).toBe('Knight M');
    expect(CREATURE_SHEET_NAMES[17]).toBe('Paladin F');
    expect(CREATURE_SHEET_NAMES[18]).toBe('Bandit');
  });
  it('covers at least the creature sheet', () => {
    expect(CREATURE_SHEET_NAMES.length).toBeGreaterThanOrEqual(396);
  });
});

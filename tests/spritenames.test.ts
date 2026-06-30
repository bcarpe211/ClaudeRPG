import { describe, it, expect } from 'vitest';
import { CREATURE_SHEET_NAMES } from '../src/web/catalog/spritenames';

describe('CREATURE_SHEET_NAMES', () => {
  it('begins with the 18 class avatars, then creatures', () => {
    expect(CREATURE_SHEET_NAMES[0]).toBe('Knight M');
    expect(CREATURE_SHEET_NAMES[17]).toBe('Paladin F');
    expect(CREATURE_SHEET_NAMES[18]).toBe('Bandit');
  });
  it('covers the doc-named creature entries', () => {
    // The doc names 198 entries (files 1-198); files 199-396 are unnamed.
    expect(CREATURE_SHEET_NAMES.length).toBeGreaterThanOrEqual(198);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { EXPECTED_CHANNELS } from '../src/domain/cosmeticsreview';
import { PICKER_ORDER, presentSlots, SLOTS } from '../src/domain/slots';

describe('presentSlots', () => {
  it('lists the exact authored wizard channels in picker order', () => {
    expect(presentSlots('wizard_M')).toEqual(EXPECTED_CHANNELS.wizard.M);
    expect(presentSlots('wizard_F')).toEqual(EXPECTED_CHANNELS.wizard.F);
  });

  it('defines every non-outline material once in picker order', () => {
    expect(PICKER_ORDER).toHaveLength(12);
    expect(new Set(PICKER_ORDER).size).toBe(PICKER_ORDER.length);
    expect(PICKER_ORDER).not.toContain(SLOTS.outline);
    expect(PICKER_ORDER.indexOf(SLOTS.belt)).toBe(PICKER_ORDER.indexOf(SLOTS.trim) + 1);
  });

  it('is empty for a sprite with no authored slot-map', () => {
    expect(presentSlots('nope_M')).toEqual([]);
  });

  it('uses an explicitly configured empty slot-map directory', () => {
    const slotmapsDir = mkdtempSync(join(tmpdir(), 'clauderpg-empty-slotmaps-'));
    try {
      expect(presentSlots('wizard_F', slotmapsDir)).toEqual([]);
    } finally {
      rmSync(slotmapsDir, { recursive: true });
    }
  });
});

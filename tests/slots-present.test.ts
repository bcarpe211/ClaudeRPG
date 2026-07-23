import { describe, it, expect } from 'vitest';
import { PICKER_ORDER, presentSlots, SLOTS } from '../src/domain/slots';

describe('presentSlots', () => {
  it('lists the wizard_M slots present in the map, outline excluded, in picker order', () => {
    const got = presentSlots('wizard_M');

    expect(got.length).toBeGreaterThan(0);
    expect(got).toContain(SLOTS.body);
    expect(got).not.toContain(SLOTS.outline);

    const indexes = got.map((slot) => PICKER_ORDER.indexOf(slot));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('defines every non-outline material once in picker order', () => {
    expect(PICKER_ORDER).toHaveLength(11);
    expect(new Set(PICKER_ORDER).size).toBe(PICKER_ORDER.length);
    expect(PICKER_ORDER).not.toContain(SLOTS.outline);
  });

  it('is empty for a sprite with no authored slot-map', () => {
    expect(presentSlots('nope_M')).toEqual([]);
  });
});

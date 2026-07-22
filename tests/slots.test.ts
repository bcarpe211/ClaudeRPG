import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { SLOTS, LEGEND, readSlotmap, loadSlotmap } from '../src/domain/slots';

describe('slot taxonomy + legend', () => {
  it('has 12 slots and a bijective legend', () => {
    expect(Object.keys(SLOTS).length).toBe(12);
    const slotIds = LEGEND.map(([s]) => s);
    const colors = LEGEND.map(([, c]) => c.join(','));
    expect(new Set(slotIds).size).toBe(LEGEND.length); // unique slots
    expect(new Set(colors).size).toBe(LEGEND.length);  // unique colours
  });
});

describe('readSlotmap', () => {
  it('maps legend colours to slot ids; transparent -> 0', () => {
    const png = new PNG({ width: 3, height: 1 });
    const [bodyId, bodyRgb] = LEGEND.find(([s]) => s === SLOTS.body)!;
    const [weaponId, weaponRgb] = LEGEND.find(([s]) => s === SLOTS.weapon)!;
    png.data.set([...bodyRgb, 255], 0);    // px0 = body
    png.data.set([...weaponRgb, 255], 4);  // px1 = weapon
    png.data.set([0, 0, 0, 0], 8);         // px2 = transparent
    const ids = readSlotmap(PNG.sync.write(png));
    expect(Array.from(ids)).toEqual([bodyId, weaponId, 0]);
  });
});

describe('loadSlotmap', () => {
  it('returns null when a slot-map file is absent', () => {
    expect(loadSlotmap('doesnotexist_M', 'a')).toBeNull();
  });
});

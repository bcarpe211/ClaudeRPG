import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  SLOTS,
  LEGEND,
  MAX_RECOLOR_SLOT,
  PICKER_ORDER,
  SLOT_LABELS,
  readSlotmap,
  loadSlotmap,
  slotmapFile,
  loadSlotmapFresh,
  slotmapFingerprintFromBuffers,
} from '../src/domain/slots';

describe('slot taxonomy + legend', () => {
  it('appends Belt without renumbering the original slots and keeps a bijective legend', () => {
    expect(Object.keys(SLOTS).length).toBe(13);
    expect(SLOTS.flair).toBe(11);
    expect(SLOTS.belt).toBe(12);
    expect(MAX_RECOLOR_SLOT).toBe(SLOTS.belt);
    const slotIds = LEGEND.map(([s]) => s);
    const colors = LEGEND.map(([, c]) => c.join(','));
    expect(new Set(slotIds).size).toBe(LEGEND.length); // unique slots
    expect(new Set(colors).size).toBe(LEGEND.length);  // unique colours
    expect(LEGEND.find(([slot]) => slot === SLOTS.belt)?.[1]).toEqual([127, 127, 127]);
    expect(SLOT_LABELS[SLOTS.belt]).toBe('Belt');
    expect(PICKER_ORDER.indexOf(SLOTS.belt)).toBe(PICKER_ORDER.indexOf(SLOTS.trim) + 1);
  });
});

describe('readSlotmap', () => {
  it('maps legend colours to slot ids; transparent -> 0', () => {
    const png = new PNG({ width: 4, height: 1 });
    const [bodyId, bodyRgb] = LEGEND.find(([s]) => s === SLOTS.body)!;
    const [weaponId, weaponRgb] = LEGEND.find(([s]) => s === SLOTS.weapon)!;
    const [beltId, beltRgb] = LEGEND.find(([s]) => s === SLOTS.belt)!;
    png.data.set([...bodyRgb, 255], 0);    // px0 = body
    png.data.set([...weaponRgb, 255], 4);  // px1 = weapon
    png.data.set([...beltRgb, 255], 8);     // px2 = belt
    png.data.set([0, 0, 0, 0], 12);         // px3 = transparent
    const ids = readSlotmap(PNG.sync.write(png));
    expect(Array.from(ids)).toEqual([bodyId, weaponId, beltId, 0]);
  });
});

describe('loadSlotmap', () => {
  it('returns null when a slot-map file is absent', () => {
    expect(loadSlotmap('doesnotexist_M', 'a')).toBeNull();
  });

  it('resolves a committed slot-map path and fresh-loads it', () => {
    expect(slotmapFile('wizard_M', 'a')).toBe(
      path.resolve('slotmaps/wizard_M_a.png'),
    );
    expect(loadSlotmapFresh('wizard_M', 'a')).toHaveLength(24 * 24);
    expect(loadSlotmapFresh('doesnotexist_M', 'a')).toBeNull();
  });
});

describe('slotmapFingerprintFromBuffers', () => {
  it('is a 16-character hash that changes with either frame', () => {
    expect(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b')))
      .toMatch(/^[0-9a-f]{16}$/);
    expect(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b')))
      .not.toBe(slotmapFingerprintFromBuffers(Buffer.from('a2'), Buffer.from('b')));
    expect(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b')))
      .not.toBe(slotmapFingerprintFromBuffers(Buffer.from('a'), Buffer.from('b2')));
  });

  it('treats a missing map differently from an empty map', () => {
    expect(slotmapFingerprintFromBuffers(null, Buffer.from('b')))
      .not.toBe(slotmapFingerprintFromBuffers(Buffer.alloc(0), Buffer.from('b')));
  });
});

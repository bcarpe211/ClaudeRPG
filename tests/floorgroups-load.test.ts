import { describe, it, expect } from 'vitest';
import { FLOOR_GROUPS, DUNGEONS, COMPAT, getDungeon } from '../src/domain/floorgroups';

describe('floor data loads from the vendored package JSON', () => {
  it('has 38 floor groups, each with >=1 main', () => {
    expect(FLOOR_GROUPS.length).toBe(38);
    for (const g of FLOOR_GROUPS) expect(g.mains.length).toBeGreaterThanOrEqual(1);
  });

  it('has 22 dungeons, excluding #17 Homestead Pickets; wallRow == dungeonId', () => {
    expect(DUNGEONS.length).toBe(22);
    expect(DUNGEONS.find((d) => d.name === 'Homestead Pickets')).toBeUndefined();
    expect(getDungeon('Greystone Keep')).toMatchObject({ dungeonId: 1, wallRow: 1 });
    expect(getDungeon('Bloodstone Cairn')).toMatchObject({ dungeonId: 23, wallRow: 23 });
    expect(DUNGEONS.every((d) => d.wallRow === d.dungeonId)).toBe(true);
  });

  it('every floor tile lands in sheet cols 4-7, rows 1-23', () => {
    for (const g of FLOOR_GROUPS)
      for (const t of [...g.mains, ...g.accents]) {
        expect(t.col).toBeGreaterThanOrEqual(4);
        expect(t.col).toBeLessThanOrEqual(7);
        expect(t.row).toBeGreaterThanOrEqual(1);
        expect(t.row).toBeLessThanOrEqual(23);
      }
  });

  it('flags glow tiles via the GLOW hint (a glow MAIN is allowed; cinder glow is an accent)', () => {
    const auric = FLOOR_GROUPS.find((g) => g.handle === 'auric_glow')!;
    expect(auric.mains[0].isGlow).toBe(true);
    const cinder = FLOOR_GROUPS.find((g) => g.handle === 'cinder_rock')!;
    expect(cinder.accents.some((a) => a.isGlow)).toBe(true);
    expect(cinder.mains.every((m) => !m.isGlow)).toBe(true);
    const grey = FLOOR_GROUPS.find((g) => g.handle === 'greystone_flag')!;
    expect(grey.mains[0]).toMatchObject({ col: 4, row: 1, isGlow: false });
    expect(grey.accents[0]).toMatchObject({ col: 6, row: 1 });
  });

  it('COMPAT is keyed by handle', () => {
    expect(COMPAT['greystone_flag'].home).toBe('Greystone Keep');
  });
});

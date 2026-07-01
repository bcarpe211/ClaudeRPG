import { describe, it, expect } from 'vitest';
import { SHEET, tileRect, FLOOR_EDGES, WALL_COLS, SKINS, getSkin, DOORS, pickWeighted } from '../src/domain/tilesheet';

const inGrid = (c: { col: number; row: number }) =>
  c.col >= 0 && c.col < SHEET.cols && c.row >= 0 && c.row < SHEET.rows;

describe('tilesheet', () => {
  it('tileRect maps (col,row) to a 24px sub-rect', () => {
    expect(tileRect({ col: 0, row: 0 })).toEqual({ sx: 0, sy: 0, sw: 24, sh: 24 });
    expect(tileRect({ col: 3, row: 2 })).toEqual({ sx: 72, sy: 48, sw: 24, sh: 24 });
  });

  it('FLOOR_EDGES covers all 16 orthogonal masks with non-negative offsets', () => {
    for (let m = 0; m < 16; m++) {
      expect(FLOOR_EDGES[m]).toBeDefined();
      expect(FLOOR_EDGES[m].col).toBeGreaterThanOrEqual(0);
      expect(FLOOR_EDGES[m].row).toBeGreaterThanOrEqual(0);
    }
  });

  it('has at least 2 proof skins, all coords on the sheet grid', () => {
    expect(SKINS.length).toBeGreaterThanOrEqual(2);
    for (const s of SKINS) {
      expect(inGrid(s.floorBase)).toBe(true);
      expect(inGrid(s.door)).toBe(true);
      expect(s.decor.every(inGrid)).toBe(true);
      expect(s.wallRow).toBeGreaterThanOrEqual(0);
      expect(s.wallRow).toBeLessThan(SHEET.rows);
      // every wall piece column lands on the sheet at this skin's row
      for (const col of Object.values(WALL_COLS)) {
        expect(inGrid({ col, row: s.wallRow })).toBe(true);
      }
      expect(s.floorSets.length).toBeGreaterThan(0);
      for (const set of s.floorSets) {
        expect(inGrid(set.main)).toBe(true);
        expect(set.accents.every(inGrid)).toBe(true);
        expect(set.accentChance).toBeGreaterThanOrEqual(0);
        expect(set.accentChance).toBeLessThanOrEqual(1);
      }
      for (let m = 0; m < 16; m++) {
        const e = FLOOR_EDGES[m];
        expect(inGrid({ col: s.floorBase.col + e.col, row: s.floorBase.row + e.row })).toBe(true);
      }
    }
    expect(getSkin(SKINS[0].name)).toBe(SKINS[0]);
  });

  it('defines the four themed skins on their own sheet rows', () => {
    const byName = Object.fromEntries(SKINS.map((s) => [s.name, s]));
    expect(byName.castle.wallRow).toBe(1);
    expect(byName['ruined-castle'].wallRow).toBe(2);
    expect(byName.cave.wallRow).toBe(3);
    expect(byName.forge.wallRow).toBe(4);
    // castle & ruined-castle are one place in two states -> shared floor pool,
    // drawing from both row 1 (grey stone) and row 2 (checker/wood/dark) floors
    expect(byName.castle.floorSets).toBe(byName['ruined-castle'].floorSets);
    expect(new Set(byName.castle.floorSets.map((f) => f.main.row))).toEqual(new Set([1, 2]));
    // forge mirrors castle's original floor rules on row 4
    expect(byName.forge.floorSets.map((f) => f.main.col)).toEqual([4, 5]);
  });

  it('DOORS are all on the sheet grid with positive weights', () => {
    expect(DOORS.length).toBeGreaterThan(0);
    for (const d of DOORS) {
      expect(inGrid(d.coord)).toBe(true);
      expect(d.weight).toBeGreaterThan(0);
    }
    // brown wooden doors (row 3, cols 29-35) carry the heaviest weight
    const brown = DOORS.filter((d) => d.coord.row === 3 && d.coord.col >= 29 && d.coord.col <= 35);
    expect(brown.length).toBe(7);
    expect(brown.every((d) => d.weight === Math.max(...DOORS.map((x) => x.weight)))).toBe(true);
  });
});

describe('pickWeighted', () => {
  it('always returns an item from the list', () => {
    const items = [{ weight: 1 }, { weight: 2 }, { weight: 3 }];
    for (const r of [0, 0.25, 0.5, 0.999]) {
      expect(items).toContain(pickWeighted(items, () => r));
    }
  });
  it('picks proportionally to weight', () => {
    const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 9 }];
    const counts = { a: 0, b: 0 };
    const rng = (() => { let n = 0; return () => (n = (n + 0.017) % 1); })();
    for (let i = 0; i < 10000; i++) counts[pickWeighted(items, rng).id as 'a' | 'b']++;
    // ~10% a, ~90% b — assert b dominates by roughly the weight ratio
    expect(counts.b).toBeGreaterThan(counts.a * 5);
  });
});

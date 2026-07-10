import { describe, it, expect } from 'vitest';
import { SHEET, tileRect, FLOOR_EDGES, WALL_COLS, DOORS, pickWeighted } from '../src/domain/tilesheet';

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

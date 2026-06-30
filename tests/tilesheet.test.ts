import { describe, it, expect } from 'vitest';
import { SHEET, tileRect, FLOOR_EDGES, SKINS, getSkin } from '../src/domain/tilesheet';

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
      expect(inGrid(s.wall)).toBe(true);
      expect(inGrid(s.door)).toBe(true);
      expect(s.decor.every(inGrid)).toBe(true);
      expect(s.floors.length).toBeGreaterThan(0);
      expect(s.floors.every(inGrid)).toBe(true);
      expect(s.crackedFloors.every(inGrid)).toBe(true);
      for (let m = 0; m < 16; m++) {
        const e = FLOOR_EDGES[m];
        expect(inGrid({ col: s.floorBase.col + e.col, row: s.floorBase.row + e.row })).toBe(true);
      }
    }
    expect(getSkin(SKINS[0].name)).toBe(SKINS[0]);
  });
});

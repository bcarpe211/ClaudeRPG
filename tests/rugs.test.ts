import { describe, it, expect } from 'vitest';
import { SHEET } from '../src/domain/tilesheet';
import { RED_RUG, BLUE_RUG, RUG_WARM, rugFor } from '../src/domain/rugs';

const inSheet = (c: { col: number; row: number }) =>
  Number.isInteger(c.col) && c.col >= 0 && c.col < SHEET.cols &&
  Number.isInteger(c.row) && c.row >= 0 && c.row < SHEET.rows;

describe('rugs', () => {
  it('each rug is a full 4x4 (even, so a 2x2 boss centres) built from its 3x3 sheet block', () => {
    for (const [rug, c0, r0] of [[RED_RUG, 5, 24], [BLUE_RUG, 8, 24]] as const) {
      expect(rug.length).toBe(16);
      const seen = new Set<string>();
      for (const b of rug) {
        expect(b.dx >= 0 && b.dx <= 3 && b.dy >= 0 && b.dy <= 3).toBe(true);
        // corners map to sheet 0/2, the two middle rows/cols repeat the sheet edge (1)
        const map = (d: number) => (d === 0 ? 0 : d === 3 ? 2 : 1);
        expect(b.col).toBe(c0 + map(b.dx));
        expect(b.row).toBe(r0 + map(b.dy));
        expect(inSheet(b)).toBe(true);
        seen.add(`${b.dx},${b.dy}`);
      }
      expect(seen.size).toBe(16);                                // every cell filled once
    }
  });
  it('rugFor themes by dungeon (warm=red, cool=blue)', () => {
    expect(rugFor('Emberforge')).toBe(RED_RUG);
    expect(rugFor('Glacierhold')).toBe(BLUE_RUG);
    expect(RUG_WARM.has('Emberforge')).toBe(true);
    expect(RUG_WARM.has('Glacierhold')).toBe(false);
  });
});

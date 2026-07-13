import { describe, it, expect } from 'vitest';
import { SHEET } from '../src/domain/tilesheet';
import { RED_RUG, BLUE_RUG, RUG_WARM, rugFor } from '../src/domain/rugs';

const inSheet = (c: { col: number; row: number }) =>
  Number.isInteger(c.col) && c.col >= 0 && c.col < SHEET.cols &&
  Number.isInteger(c.row) && c.row >= 0 && c.row < SHEET.rows;

describe('rugs', () => {
  it('each rug has 8 border tiles (3x3 minus center) at the right coords', () => {
    for (const [rug, c0, r0] of [[RED_RUG, 5, 24], [BLUE_RUG, 8, 24]] as const) {
      expect(rug.border.length).toBe(8);
      const seen = new Set<string>();
      for (const b of rug.border) {
        expect(b.dx >= 0 && b.dx <= 2 && b.dy >= 0 && b.dy <= 2).toBe(true);
        expect(b.dx === 1 && b.dy === 1).toBe(false);          // center excluded
        expect(b.col).toBe(c0 + b.dx);
        expect(b.row).toBe(r0 + b.dy);
        expect(inSheet(b)).toBe(true);
        seen.add(`${b.dx},${b.dy}`);
      }
      expect(seen.size).toBe(8);                                // no dup positions
      expect(rug.crests.length).toBe(3);
      for (const c of rug.crests) expect(inSheet(c)).toBe(true);
    }
  });
  it('rugFor themes by dungeon and picks one of that rug\'s crests, deterministically', () => {
    const warm = rugFor('Emberforge', () => 0);
    expect(RED_RUG.crests.some((c) => c.col === warm.crest.col && c.row === warm.crest.row)).toBe(true);
    expect(warm.border).toBe(RED_RUG.border);
    const cool = rugFor('Glacierhold', () => 0);
    expect(cool.border).toBe(BLUE_RUG.border);
    expect(BLUE_RUG.crests.some((c) => c.col === cool.crest.col && c.row === cool.crest.row)).toBe(true);
    expect(RUG_WARM.has('Emberforge')).toBe(true);
    expect(rugFor('Emberforge', () => 0.99).crest).toEqual(RED_RUG.crests[2]); // deterministic pick
  });
});

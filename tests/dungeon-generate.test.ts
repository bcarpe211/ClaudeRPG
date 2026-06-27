import { describe, it, expect } from 'vitest';
import { makeRng, generateDungeon } from '../src/domain/dungeon';
import { themeTiles } from '../src/domain/tilemanifest';

describe('makeRng', () => {
  it('is deterministic for a seed and varies across seeds', () => {
    const a = makeRng(42); const b = makeRng(42); const c = makeRng(43);
    const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()]; const seqC = [c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe('generateDungeon room shell', () => {
  it('is fully deterministic for (theme, seed)', () => {
    expect(generateDungeon('cave', 123)).toEqual(generateDungeon('cave', 123));
  });

  it('produces a 20x15 grid by default with a wall/door border and floor interior', () => {
    const d = generateDungeon('stone_crypt', 7);
    expect(d.width).toBe(20);
    expect(d.height).toBe(15);
    expect(d.cells.length).toBe(15);
    expect(d.cells[0].length).toBe(20);
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const edge = x === 0 || y === 0 || x === d.width - 1 || y === d.height - 1;
        const c = d.cells[y][x];
        if (edge) expect(['wall', 'door']).toContain(c.type);
        else expect(c.type).toBe('floor');
      }
    }
  });

  it('has 2-4 doors, all on the border and not at corners', () => {
    const d = generateDungeon('wood_fort', 99);
    expect(d.doors.length).toBeGreaterThanOrEqual(2);
    expect(d.doors.length).toBeLessThanOrEqual(4);
    for (const p of d.doors) {
      const edge = p.x === 0 || p.y === 0 || p.x === d.width - 1 || p.y === d.height - 1;
      const corner = (p.x === 0 || p.x === d.width - 1) && (p.y === 0 || p.y === d.height - 1);
      expect(edge).toBe(true);
      expect(corner).toBe(false);
      expect(d.cells[p.y][p.x].type).toBe('door');
    }
  });

  it('only emits sprites from the theme manifest for walls/doors/floor', () => {
    const t = themeTiles('cave');
    const wallSet = new Set([t.wall, ...(t.wallVariants ?? [])]);
    const floorSet = new Set([t.floor, ...t.floorVariants]);
    const d = generateDungeon('cave', 5);
    for (const row of d.cells) for (const c of row) {
      if (c.type === 'wall') expect(wallSet.has(c.sprite)).toBe(true);
      else if (c.type === 'floor') expect(floorSet.has(c.sprite)).toBe(true);
      else expect(c.sprite).toBe(t.door);
    }
  });

  it('falls back to the default theme for an unknown theme (no throw)', () => {
    expect(() => generateDungeon('mystery', 1)).not.toThrow();
    expect(generateDungeon('mystery', 1).theme).toBe('mystery');
  });
});

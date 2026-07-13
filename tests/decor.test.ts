import { describe, it, expect } from 'vitest';
import { SHEET } from '../src/domain/tilesheet';
import { DUNGEONS } from '../src/domain/floorgroups';
import { DECOR_TILES, DUNGEON_DECOR, COBWEB_HEAVY, decorFor } from '../src/domain/decor';

const inSheet = (c: { col: number; row: number }) =>
  Number.isInteger(c.col) && c.col >= 0 && c.col < SHEET.cols &&
  Number.isInteger(c.row) && c.row >= 0 && c.row < SHEET.rows;

describe('decor library', () => {
  it('every tile is a valid sheet coord with tags, walkable, and (if animated) a valid animB', () => {
    for (const t of DECOR_TILES) {
      expect(inSheet(t), t.name).toBe(true);
      expect(t.tags.length, t.name).toBeGreaterThan(0);
      expect(typeof t.walkable, t.name).toBe('boolean');
      if (t.animB) expect(inSheet(t.animB), t.name).toBe(true);
    }
  });
  it('every dungeon draws at least one floor decor tile', () => {
    for (const d of DUNGEONS) expect(decorFor(d.name).floor.length, d.name).toBeGreaterThan(0);
  });
  it('decorFor only returns tiles whose tags match the dungeon', () => {
    for (const d of DUNGEONS) {
      const tags = new Set(DUNGEON_DECOR[d.name]);
      for (const t of [...decorFor(d.name).floor, ...decorFor(d.name).corner, ...decorFor(d.name).wall])
        expect(t.tags.some((tag) => tags.has(tag)), `${d.name}:${t.name}`).toBe(true);
    }
  });
  it('full cobweb is offered only to cobweb-heavy dungeons', () => {
    for (const d of DUNGEONS) {
      const hasFull = decorFor(d.name).corner.some((t) => t.name === 'cobweb full');
      if (hasFull) expect(COBWEB_HEAVY.has(d.name), d.name).toBe(true);
    }
  });
  it('falls back without throwing for an unknown dungeon', () => {
    expect(() => decorFor('nonesuch')).not.toThrow();
    expect(decorFor('nonesuch').floor.length).toBeGreaterThan(0);
  });
});

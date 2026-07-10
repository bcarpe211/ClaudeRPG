import { describe, it, expect } from 'vitest';
import { generateAutotiledDungeon } from '../src/domain/dungeon2';
import { DOORS } from '../src/domain/tilesheet';

const dungeon = 'Greystone Keep';

describe('generateAutotiledDungeon', () => {
  it('is deterministic for the same (dungeon, seed)', () => {
    const a = generateAutotiledDungeon(dungeon, 123);
    const b = generateAutotiledDungeon(dungeon, 123);
    expect(a).toEqual(b);
  });
  it('encloses the room in wall cells and fills the interior with floor', () => {
    const d = generateAutotiledDungeon(dungeon, 7, { width: 10, height: 8 });
    const at = (x: number, y: number) => d.cells.find((c) => c.x === x && c.y === y)!;
    expect(at(0, 0).kind).toBe('wall');           // corner
    expect(at(5, 0).kind === 'wall' || at(5, 0).kind === 'door').toBe(true); // top border
    expect(at(4, 4).kind).toBe('floor');          // interior
  });
  it('every cell carries a resolved sheet (col,row)', () => {
    const d = generateAutotiledDungeon(dungeon, 7, { width: 10, height: 8 });
    expect(d.cells.length).toBe(10 * 8);
    expect(d.cells.every((c) => Number.isInteger(c.col) && Number.isInteger(c.row))).toBe(true);
  });
  it('door cells resolve to a tile from the door pool', () => {
    const doorKeys = new Set(DOORS.map((x) => `${x.coord.col},${x.coord.row}`));
    // scan several seeds so we actually hit door cells
    let sawDoor = false;
    for (let seed = 1; seed <= 20; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: 20, height: 15 });
      const doorCells = d.cells.filter((c) => c.kind === 'door');
      expect(doorCells.length).toBeGreaterThanOrEqual(2);
      expect(doorCells.length).toBeLessThanOrEqual(3);
      for (const c of doorCells) {
        sawDoor = true;
        expect(doorKeys.has(`${c.col},${c.row}`)).toBe(true);
        // door tiles are transparent -> must carry a floor underlay
        expect(c.under).toBeDefined();
        expect(Number.isInteger(c.under!.col) && Number.isInteger(c.under!.row)).toBe(true);
      }
    }
    expect(sawDoor).toBe(true);
  });
  it('labels the sample with the dungeon name', () => {
    const d = generateAutotiledDungeon(dungeon, 1, { width: 10, height: 8 });
    expect(d.dungeon).toBe('Greystone Keep');
  });
});

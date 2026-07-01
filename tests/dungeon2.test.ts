import { describe, it, expect } from 'vitest';
import { generateAutotiledDungeon } from '../src/domain/dungeon2';
import { SKINS, DOORS } from '../src/domain/tilesheet';

const skin = SKINS[0].name;

describe('generateAutotiledDungeon', () => {
  it('is deterministic for the same (skin, seed)', () => {
    const a = generateAutotiledDungeon(skin, 123);
    const b = generateAutotiledDungeon(skin, 123);
    expect(a).toEqual(b);
  });
  it('encloses the room in wall cells and fills the interior with floor', () => {
    const d = generateAutotiledDungeon(skin, 7, { width: 10, height: 8 });
    const at = (x: number, y: number) => d.cells.find((c) => c.x === x && c.y === y)!;
    expect(at(0, 0).kind).toBe('wall');           // corner
    expect(at(5, 0).kind === 'wall' || at(5, 0).kind === 'door').toBe(true); // top border
    expect(at(4, 4).kind).toBe('floor');          // interior
  });
  it('every cell carries a resolved sheet (col,row)', () => {
    const d = generateAutotiledDungeon(skin, 7, { width: 10, height: 8 });
    expect(d.cells.length).toBe(10 * 8);
    expect(d.cells.every((c) => Number.isInteger(c.col) && Number.isInteger(c.row))).toBe(true);
  });
  it('door cells resolve to a tile from the door pool', () => {
    const doorKeys = new Set(DOORS.map((x) => `${x.coord.col},${x.coord.row}`));
    // scan several seeds so we actually hit door cells
    let sawDoor = false;
    for (let seed = 1; seed <= 20; seed++) {
      const d = generateAutotiledDungeon(skin, seed, { width: 20, height: 15 });
      for (const c of d.cells.filter((c) => c.kind === 'door')) {
        sawDoor = true;
        expect(doorKeys.has(`${c.col},${c.row}`)).toBe(true);
      }
    }
    expect(sawDoor).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { floorEdgeMask, resolveFloor, resolveDoor } from '../src/domain/autotile';
import { FLOOR_EDGES } from '../src/domain/tilesheet';

// 3x3 floor patch surrounded by wall:
//   wall wall wall
//   wall floor wall   -> centre has no floor neighbours -> mask 0
const onlyCentreFloor = (x: number, y: number) =>
  x === 1 && y === 1 ? 'floor' : 'wall';

// a 3-wide floor row at y=1 (x 0..2 floor), walls above/below
const floorRow = (x: number, y: number) =>
  y === 1 && x >= 0 && x <= 2 ? 'floor' : 'wall';

describe('floorEdgeMask', () => {
  it('isolated floor cell has mask 0', () => {
    expect(floorEdgeMask(onlyCentreFloor, 1, 1)).toBe(0);
  });
  it('middle of a horizontal floor run has E+W set (mask 2|8=10)', () => {
    expect(floorEdgeMask(floorRow, 1, 1)).toBe(10);
  });
  it('left end of the run has only E set (mask 2)', () => {
    expect(floorEdgeMask(floorRow, 0, 1)).toBe(2);
  });
});

describe('resolve', () => {
  const floorBase = { col: 10, row: 20 };
  it('resolveFloor adds the FLOOR_EDGES offset to floorBase', () => {
    const e = FLOOR_EDGES[15];
    expect(resolveFloor(floorBase, 15)).toEqual({ col: 10 + e.col, row: 20 + e.row });
  });
  it('resolveDoor returns the door coord unchanged', () => {
    expect(resolveDoor({ col: 3, row: 4 })).toEqual({ col: 3, row: 4 });
  });
});

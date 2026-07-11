import { describe, it, expect } from 'vitest';
import { generateAutotiledDungeon } from '../src/domain/dungeon2';
import { DOORS, WALL_COLS } from '../src/domain/tilesheet';

const dungeon = 'Greystone Keep';

describe('door placement + wall autotiling rules', () => {
  const W = 20, H = 15;
  const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const cellAt = (d: ReturnType<typeof generateAutotiledDungeon>) => {
    const m = new Map<string, (typeof d.cells)[number]>();
    for (const c of d.cells) m.set(`${c.x},${c.y}`, c);
    return m;
  };

  it('never places two doors orthogonally adjacent, nor on a corner', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: W, height: H });
      const doors = d.cells.filter((c) => c.kind === 'door');
      const dset = new Set(doors.map((c) => `${c.x},${c.y}`));
      for (const c of doors) {
        const corner = (c.x === 0 || c.x === W - 1) && (c.y === 0 || c.y === H - 1);
        expect(corner).toBe(false);
        for (const [dx, dy] of NEI) expect(dset.has(`${c.x + dx},${c.y + dy}`)).toBe(false);
      }
    }
  });

  it('renders the four corners as corner pieces even when a door sits next to one', () => {
    let sawAdjacentDoor = false;
    for (let seed = 1; seed <= 60; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: W, height: H });
      const m = cellAt(d);
      const corners = [
        [0, 0, WALL_COLS.tl], [W - 1, 0, WALL_COLS.tr],
        [0, H - 1, WALL_COLS.bl], [W - 1, H - 1, WALL_COLS.br],
      ] as const;
      for (const [x, y, col] of corners) {
        const c = m.get(`${x},${y}`)!;
        expect(c.kind).toBe('wall');
        expect(c.col).toBe(col);
        for (const [dx, dy] of NEI) if (m.get(`${x + dx},${y + dy}`)?.kind === 'door') sawAdjacentDoor = true;
      }
    }
    expect(sawAdjacentDoor).toBe(true); // the bug-trigger scenario actually occurs in the sample
  });

  it('orients edge walls by their edge (runs, cracks, or caps), not by door gaps', () => {
    // horizontal family (top/bottom edge): straight run, cracked run, or a horizontal end-cap
    const HORIZ = new Set<number>([WALL_COLS.horizontal, WALL_COLS.crackedH, WALL_COLS.lend, WALL_COLS.rend]);
    // vertical family (left/right edge): straight run, cracked run, or a vertical end-cap
    const VERT = new Set<number>([WALL_COLS.vertical, WALL_COLS.crackedV, WALL_COLS.tend, WALL_COLS.bend]);
    const CORNERS = new Set<number>([WALL_COLS.tl, WALL_COLS.tr, WALL_COLS.bl, WALL_COLS.br]);
    for (let seed = 1; seed <= 60; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: W, height: H });
      for (const c of d.cells) {
        if (c.kind !== 'wall') continue;
        const onLR = c.x === 0 || c.x === W - 1;
        const onTB = c.y === 0 || c.y === H - 1;
        if (onLR && onTB) { expect(CORNERS.has(c.col)).toBe(true); continue; }
        if (onLR) expect(VERT.has(c.col)).toBe(true);
        else if (onTB) expect(HORIZ.has(c.col)).toBe(true);
      }
    }
  });

  it('caps a wall where its run meets a doorway (finished doorframe, no raw edge)', () => {
    let sawCap = false;
    for (let seed = 1; seed <= 60; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: W, height: H });
      const m = cellAt(d);
      for (const c of d.cells) {
        if (c.kind !== 'wall') continue;
        const corner = (c.x === 0 || c.x === W - 1) && (c.y === 0 || c.y === H - 1);
        if (corner) continue;
        const E = m.get(`${c.x + 1},${c.y}`), Wt = m.get(`${c.x - 1},${c.y}`);
        const N = m.get(`${c.x},${c.y - 1}`), S = m.get(`${c.x},${c.y + 1}`);
        // a run ending at a door (door one side, wall the other) caps TOWARD the door
        if (c.y === 0 || c.y === H - 1) {
          if (E?.kind === 'door' && Wt?.kind === 'wall') { expect(c.col).toBe(WALL_COLS.rend); sawCap = true; }
          if (Wt?.kind === 'door' && E?.kind === 'wall') { expect(c.col).toBe(WALL_COLS.lend); sawCap = true; }
        }
        if (c.x === 0 || c.x === W - 1) {
          if (S?.kind === 'door' && N?.kind === 'wall') { expect(c.col).toBe(WALL_COLS.bend); sawCap = true; }
          if (N?.kind === 'door' && S?.kind === 'wall') { expect(c.col).toBe(WALL_COLS.tend); sawCap = true; }
        }
      }
    }
    expect(sawCap).toBe(true);
  });
});

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

import { describe, it, expect } from 'vitest';
import { generateAutotiledDungeon } from '../src/domain/dungeon2';
import { DOORS, WALL_COLS } from '../src/domain/tilesheet';
import { decorFor } from '../src/domain/decor';

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

  it('is a corner only when both its walls continue; a door directly beside it caps to a beveled end', () => {
    // a door adjacent to a corner degrades it to a straight/end piece (a beveled edge
    // faces the door) rather than a raw corner whose face butts the doorway.
    const NONCORNER = new Set<number>([
      WALL_COLS.horizontal, WALL_COLS.vertical, WALL_COLS.crackedH, WALL_COLS.crackedV,
      WALL_COLS.lend, WALL_COLS.rend, WALL_COLS.tend, WALL_COLS.bend,
    ]);
    const corners = [
      { x: 0, y: 0, perp: [[1, 0], [0, 1]], piece: WALL_COLS.tl },
      { x: W - 1, y: 0, perp: [[-1, 0], [0, 1]], piece: WALL_COLS.tr },
      { x: 0, y: H - 1, perp: [[1, 0], [0, -1]], piece: WALL_COLS.bl },
      { x: W - 1, y: H - 1, perp: [[-1, 0], [0, -1]], piece: WALL_COLS.br },
    ] as const;
    let sawCorner = false, sawCapped = false;
    for (let seed = 1; seed <= 80; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: W, height: H });
      const m = cellAt(d);
      for (const c of corners) {
        const cell = m.get(`${c.x},${c.y}`)!;
        const bothWalls = c.perp.every(([dx, dy]) => m.get(`${c.x + dx},${c.y + dy}`)?.kind === 'wall');
        if (bothWalls) { expect(cell.col).toBe(c.piece); sawCorner = true; }
        else { expect(cell.col).not.toBe(c.piece); expect(NONCORNER.has(cell.col)).toBe(true); sawCapped = true; }
      }
    }
    expect(sawCorner).toBe(true);
    expect(sawCapped).toBe(true);
  });

  it('uses the double-capped isolated piece for a 1-tile wall between two doorways', () => {
    let saw = false;
    for (let seed = 1; seed <= 200; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: W, height: H });
      const m = cellAt(d);
      for (const c of d.cells) {
        if (c.kind !== 'wall') continue;
        const corner = (c.x === 0 || c.x === W - 1) && (c.y === 0 || c.y === H - 1);
        if (corner) continue;
        const E = m.get(`${c.x + 1},${c.y}`), Wt = m.get(`${c.x - 1},${c.y}`);
        const N = m.get(`${c.x},${c.y - 1}`), S = m.get(`${c.x},${c.y + 1}`);
        const vBetween = (c.x === 0 || c.x === W - 1) && N?.kind === 'door' && S?.kind === 'door';
        const hBetween = (c.y === 0 || c.y === H - 1) && E?.kind === 'door' && Wt?.kind === 'door';
        if (vBetween || hBetween) { expect(c.col).toBe(WALL_COLS.isolated); saw = true; }
      }
    }
    expect(saw).toBe(true); // the between-two-doors scenario actually occurs in the sample
  });

  it('orients edge walls by their edge (runs, cracks, caps, or the isolated block), not by door gaps', () => {
    // horizontal family (top/bottom edge): straight run, cracked run, horizontal end-cap, or isolated block
    const HORIZ = new Set<number>([WALL_COLS.horizontal, WALL_COLS.crackedH, WALL_COLS.lend, WALL_COLS.rend, WALL_COLS.isolated]);
    // vertical family (left/right edge): straight run, cracked run, vertical end-cap, or isolated block
    const VERT = new Set<number>([WALL_COLS.vertical, WALL_COLS.crackedV, WALL_COLS.tend, WALL_COLS.bend, WALL_COLS.isolated]);
    for (let seed = 1; seed <= 60; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: W, height: H });
      for (const c of d.cells) {
        if (c.kind !== 'wall') continue;
        const onLR = c.x === 0 || c.x === W - 1;
        const onTB = c.y === 0 || c.y === H - 1;
        if (onLR && onTB) continue; // corners covered by the corner test
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
  it('places decor: non-empty, carries walkable, clears the 2x2 monster zone', () => {
    const d = generateAutotiledDungeon(dungeon, 7, { width: 20, height: 15 });
    expect(d.decor.length).toBeGreaterThan(0);
    const mx = Math.floor(20 / 2) - 1, my = Math.floor(15 / 2) - 1;
    for (const p of d.decor) {
      expect(typeof p.walkable).toBe('boolean');
      const inMonster = p.x >= mx && p.x <= mx + 1 && p.y >= my && p.y <= my + 1;
      expect(inMonster).toBe(false);
    }
  });
  it('corner decor sits at an interior corner and uses a corner tile', () => {
    const cornerKeys = new Set(decorFor(dungeon).corner.map((t) => `${t.col},${t.row}`));
    const corners = new Set(['1,1', `18,1`, `1,13`, `18,13`]); // 20x15 interior corners
    let sawCorner = false;
    for (let seed = 1; seed <= 10; seed++) {
      const d = generateAutotiledDungeon(dungeon, seed, { width: 20, height: 15 });
      for (const p of d.decor) {
        if (corners.has(`${p.x},${p.y}`)) { sawCorner = true; expect(cornerKeys.has(`${p.col},${p.row}`)).toBe(true); }
      }
    }
    expect(sawCorner).toBe(true); // Greystone Keep is cobweb-heavy -> corners fill often
  });
  it('decor is deterministic per (dungeon, seed)', () => {
    expect(generateAutotiledDungeon(dungeon, 42).decor).toEqual(generateAutotiledDungeon(dungeon, 42).decor);
  });
});

import { FLOOR_EDGES, type Skin, type TileCoord } from './tilesheet';

export type LogicalKind = 'wall' | 'floor' | 'door' | 'decor';
export type KindAt = (x: number, y: number) => LogicalKind | null;

const isFloorLike = (k: LogicalKind | null): boolean => k === 'floor' || k === 'door';

/** 4-bit orthogonal mask: bit 1=N, 2=E, 4=S, 8=W set when that neighbour is floor-like. */
export function floorEdgeMask(kindAt: KindAt, x: number, y: number): number {
  let m = 0;
  if (isFloorLike(kindAt(x, y - 1))) m |= 1;
  if (isFloorLike(kindAt(x + 1, y))) m |= 2;
  if (isFloorLike(kindAt(x, y + 1))) m |= 4;
  if (isFloorLike(kindAt(x - 1, y))) m |= 8;
  return m;
}

export function resolveFloor(skin: Skin, mask: number): TileCoord {
  const e = FLOOR_EDGES[mask] ?? FLOOR_EDGES[15];
  return { col: skin.floorBase.col + e.col, row: skin.floorBase.row + e.row };
}

export function resolveWall(skin: Skin): TileCoord {
  return skin.wall;
}

export function resolveDoor(skin: Skin): TileCoord {
  return skin.door;
}

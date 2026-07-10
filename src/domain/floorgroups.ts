import { readFileSync } from 'node:fs';
import { pickWeighted, type TileCoord } from './tilesheet';

// ---- raw JSON shapes (only the fields we use) ----
interface RawTile { rect: [number, number, number, number]; hint: string; is_cross_ref: boolean }
interface RawGroup { handle: string; name: string; mains: RawTile[]; accents: RawTile[] }
interface RawCompat { handle: string; home: string; great: string[]; good: string[]; feature: string[] }
interface RawDungeon { id: number; name: string }

const load = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`./floordata/${file}`, import.meta.url), 'utf8')) as T;

// ---- public types ----
export interface FloorTile extends TileCoord { hint: string; isGlow: boolean }
export interface FloorGroup { handle: string; name: string; mains: FloorTile[]; accents: FloorTile[] }
export interface Dungeon {
  name: string; dungeonId: number; wallRow: number; wallVariantChance: number; decor: TileCoord[];
}
export interface Compat { home: string; great: string[]; good: string[]; feature: string[] }

// A tile is "glow" (emissive, use sparingly) when its hint mentions GLOW.
const toTile = (t: RawTile): FloorTile => ({
  col: t.rect[0] / 24, row: t.rect[1] / 24, hint: t.hint, isGlow: /GLOW/.test(t.hint),
});

export const FLOOR_GROUPS: FloorGroup[] = load<{ groups: RawGroup[] }>('floor_groups.json').groups.map(
  (g) => ({ handle: g.handle, name: g.name, mains: g.mains.map(toTile), accents: g.accents.map(toTile) }),
);

export const COMPAT: Record<string, Compat> = Object.fromEntries(
  load<{ groups: RawCompat[] }>('floor_compatibility.json').groups.map(
    (c) => [c.handle, { home: c.home, great: c.great, good: c.good, feature: c.feature }],
  ),
);

// #17 Homestead Pickets is a fence-prop row, not a tiling dungeon (README excludes it).
const EXCLUDED_DUNGEON_IDS = new Set([17]);
const WALL_VARIANT_CHANCE = 0.1;

// A band's sheet row index IS its dungeon_id, so wallRow = id.
export const DUNGEONS: Dungeon[] = load<{ styles: RawDungeon[] }>('dungeons.json').styles
  .filter((d) => !EXCLUDED_DUNGEON_IDS.has(d.id))
  .map((d) => ({
    name: d.name, dungeonId: d.id, wallRow: d.id, wallVariantChance: WALL_VARIANT_CHANCE, decor: [],
  }));

const DUNGEON_BY_NAME = new Map(DUNGEONS.map((d) => [d.name, d]));
export const getDungeon = (name: string): Dungeon | undefined => DUNGEON_BY_NAME.get(name);

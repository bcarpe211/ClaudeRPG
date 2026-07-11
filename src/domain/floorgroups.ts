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
// #18 Wintermarch Keep pulled from the rotation during floor tuning (no home floor;
// user opted it out entirely) — 2026-07-11.
const EXCLUDED_DUNGEON_IDS = new Set([17, 18]);
const WALL_VARIANT_CHANCE = 0.1;
// The "rounded fieldstone/cobble" bands (20-23) don't have matching cracked-wall
// variants at the shared crack columns (sheet cols 26/27) — those cells hold notched
// rubble pieces that break the wall line. Their clean walls are fine, so disable cracks.
const NO_CRACK_DUNGEON_IDS = new Set([20, 21, 22, 23]);

// A band's sheet row index IS its dungeon_id, so wallRow = id.
export const DUNGEONS: Dungeon[] = load<{ styles: RawDungeon[] }>('dungeons.json').styles
  .filter((d) => !EXCLUDED_DUNGEON_IDS.has(d.id))
  .map((d) => ({
    name: d.name, dungeonId: d.id, wallRow: d.id,
    wallVariantChance: NO_CRACK_DUNGEON_IDS.has(d.id) ? 0 : WALL_VARIANT_CHANCE,
    decor: [],
  }));

const DUNGEON_BY_NAME = new Map(DUNGEONS.map((d) => [d.name, d]));
export const getDungeon = (name: string): Dungeon | undefined => DUNGEON_BY_NAME.get(name);

// Tier weights from the package's tiers_weight_suggestion: home best, feature rarest.
const TIER_WEIGHTS = { home: 6, great: 5, good: 2, feature: 1 } as const;

// Pick ONE floor group for a dungeon: gather every group whose compat lists this
// dungeon in any tier, then weighted-pick by that tier. One group per dungeon keeps
// a room's floor cohesive; variety comes between dungeons.
export function chooseGroup(dungeonName: string, rng: () => number): FloorGroup {
  const eligible: { group: FloorGroup; weight: number }[] = [];
  for (const g of FLOOR_GROUPS) {
    const c = COMPAT[g.handle];
    if (!c) continue;
    const weight =
      c.home === dungeonName ? TIER_WEIGHTS.home :
      c.great.includes(dungeonName) ? TIER_WEIGHTS.great :
      c.good.includes(dungeonName) ? TIER_WEIGHTS.good :
      c.feature.includes(dungeonName) ? TIER_WEIGHTS.feature : 0;
    if (weight > 0) eligible.push({ group: g, weight });
  }
  if (eligible.length === 0) throw new Error(`no eligible floor group for dungeon: ${dungeonName}`);
  return pickWeighted(eligible, rng).group;
}

const ACCENT_RATE = 0.06; // normal detail accents per cell
const GLOW_RATE = 0.01;   // emissive glow accents per cell (rarer)
const at = <T>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];

// One floor cell: usually a random main (mains blend for natural variation);
// occasionally a normal accent; rarely a glow accent. A glow MAIN (e.g. auric_glow)
// still floods normally — its rarity is controlled by chooseGroup's feature tier.
export function pickCell(group: FloorGroup, rng: () => number): FloorTile {
  const glow = group.accents.filter((a) => a.isGlow);
  const normal = group.accents.filter((a) => !a.isGlow);
  const r = rng();
  if (glow.length > 0 && r < GLOW_RATE) return at(glow, rng);
  if (normal.length > 0 && r < ACCENT_RATE) return at(normal, rng);
  return at(group.mains, rng);
}

// A stable base tile for a group — used as the underlay behind transparent door tiles.
export const mainTile = (group: FloorGroup): FloorTile => group.mains[0];

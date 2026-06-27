import type Database from 'better-sqlite3';
import { currentLayout } from '../domain/dungeon';
import { worldSpriteUrl } from '../domain/tilemanifest';

export interface TvLayoutCell { type: string; url: string; }
export interface TvLayout {
  dungeonId: number;
  theme: string;
  width: number;
  height: number;
  cells: TvLayoutCell[][];
  doors: { x: number; y: number }[];
  monster: { x: number; y: number; footprint: number };
  decor: { x: number; y: number; url: string }[];
}

/** Map the active dungeon layout to a sprite-URL payload for the TV, or null. */
export function buildTvLayout(db: Database.Database): TvLayout | null {
  const layout = currentLayout(db);
  if (!layout) return null;
  const gs = db.prepare('SELECT current_dungeon_id FROM game_state WHERE id=1').get() as any;
  return {
    dungeonId: gs.current_dungeon_id,
    theme: layout.theme,
    width: layout.width,
    height: layout.height,
    cells: layout.cells.map((row) =>
      row.map((c) => ({ type: c.type, url: worldSpriteUrl(c.sprite) })),
    ),
    doors: layout.doors,
    monster: layout.monster,
    decor: layout.decor.map((d) => ({ x: d.x, y: d.y, url: worldSpriteUrl(d.sprite) })),
  };
}

/** Zip players (in order) onto slot coordinates; extras get {x:null,y:null}. */
export function assignHeroSlots<T extends { id: number }>(
  players: T[],
  slots: { x: number; y: number }[],
): (T & { x: number | null; y: number | null })[] {
  return players.map((p, i) => ({
    ...p,
    x: i < slots.length ? slots[i].x : null,
    y: i < slots.length ? slots[i].y : null,
  }));
}

import { getGameState } from '../domain/gamestate';
import { loadEngineConfig } from '../domain/encounters';
import { sumEffectiveSince } from '../domain/ingest';
import { tokenModifier } from '../domain/combat';
import { classSpriteUrl, creatureSpriteFile, type Gender } from '../domain/classes';
import { buildDefeatSummary, type DefeatSummary } from '../domain/engine';

export function creatureSpriteUrl(index: number): string {
  return `/sprites/creatures_24x24/${creatureSpriteFile(index)}`;
}

export interface TvEncounter {
  id: number; creatureIndex: number; creatureUrl: string;
  footprint: number; kind: string; packCount: number;
  hp: number; maxHp: number;
}
export interface TvHero {
  id: number; name: string; avatarUrl: string; level: number;
  totalTokens: number; effectiveTokens: number; gold: number;
  modifier: number; disabled: boolean; connected: boolean;
  damage: number; x: number | null; y: number | null;
}
export interface TvDefeat extends DefeatSummary { creatureUrl: string; }
export interface TvState {
  dungeonId: number | null;
  paused: boolean;
  encounter: TvEncounter | null;
  players: TvHero[];
  defeat: TvDefeat | null;
}

export function buildTvState(db: Database.Database, now: number): TvState {
  const cfg = loadEngineConfig(db);
  const gs = getGameState(db);
  const since = now - cfg.recentWindowMinutes * 60_000;

  // Encounter (active only).
  let encounter: TvEncounter | null = null;
  if (gs.current_encounter_id) {
    const e = db.prepare('SELECT * FROM encounters WHERE id=?').get(gs.current_encounter_id) as any;
    if (e && e.status === 'active') {
      encounter = {
        id: e.id, creatureIndex: e.creature_index, creatureUrl: creatureSpriteUrl(e.creature_index),
        footprint: e.footprint, kind: e.kind, packCount: e.pack_count,
        hp: e.current_hp, maxHp: e.max_hp,
      };
    }
  }

  // Per-fight damage for the current encounter.
  const dmgByPlayer = new Map<number, number>();
  if (encounter) {
    for (const r of db.prepare('SELECT player_id, damage_total FROM encounter_damage WHERE encounter_id=?')
      .all(encounter.id) as any[]) dmgByPlayer.set(r.player_id, r.damage_total);
  }

  // Players: leaderboard order (effective tokens desc), enabled ones get slots.
  const rows = db.prepare(
    'SELECT * FROM players ORDER BY effective_tokens DESC, id ASC',
  ).all() as any[];
  const players: TvHero[] = rows.map((p) => ({
    id: p.id, name: p.name, avatarUrl: classSpriteUrl(p.class_key, p.gender as Gender),
    level: p.level, totalTokens: p.total_tokens, effectiveTokens: p.effective_tokens,
    gold: p.gold, modifier: tokenModifier(sumEffectiveSince(db, p.id, since), cfg.tokenModifierK),
    disabled: !!p.disabled, connected: p.last_token_at != null,
    damage: dmgByPlayer.get(p.id) ?? 0, x: null, y: null,
  }));

  // Assign battlefield slots to enabled players (same order) from the layout.
  const layout = currentLayout(db);
  if (layout) {
    const enabled = players.filter((p) => !p.disabled);
    const placed = assignHeroSlots(enabled, layout.heroSlots);
    const pos = new Map(placed.map((p) => [p.id, { x: p.x, y: p.y }]));
    for (const p of players) {
      const xy = pos.get(p.id);
      if (xy) { p.x = xy.x; p.y = xy.y; }
    }
  }

  // Defeat popup during the window.
  let defeat: TvDefeat | null = null;
  if (gs.defeat_until && now < gs.defeat_until && gs.last_defeat_encounter_id) {
    const summary = buildDefeatSummary(db, gs.last_defeat_encounter_id);
    defeat = { ...summary, creatureUrl: creatureSpriteUrl(summary.creatureIndex) };
  }

  return { dungeonId: gs.current_dungeon_id, paused: !!gs.paused, encounter, players, defeat };
}

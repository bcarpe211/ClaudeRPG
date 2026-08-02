import type Database from 'better-sqlite3';
import { currentTvLayout, type TvLayout } from './tvlayout';

/** Active dungeon layout as the TV render payload, or null. */
export function buildTvLayout(db: Database.Database): TvLayout | null {
  return currentTvLayout(db);
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
import { activityScore } from '../domain/activity';
import { tokenModifier } from '../domain/combat';
import { debuffFactor } from '../domain/retaliation';
import { creatureSpriteFile } from '../domain/classes';
import { cosmeticSkinUrlForPlayer, type SkinAssetContext } from '../domain/slotcosmetics';
import { buildDefeatSummary, type DefeatSummary } from '../domain/engine';
import { monsterByIndex, monsterName } from '../domain/bestiary';
import { monsterTitle, pluralizeCreature } from '../domain/monstername';
import { visiblePotionTiersByPlayer } from '../domain/potions';

export function creatureSpriteUrl(index: number): string {
  return `/sprites/creatures_24x24/${creatureSpriteFile(index)}`;
}

export interface TvEncounter {
  id: number; creatureIndex: number; creatureUrl: string;
  footprint: number; kind: string; packCount: number;
  hp: number; maxHp: number;
  name: string; size: 'S' | 'M' | 'L'; flying: boolean;
}
export interface TvHero {
  id: number; name: string; avatarUrl: string; level: number;
  totalTokens: number; effectiveTokens: number; gold: number;
  modifier: number; disabled: boolean; connected: boolean;
  damage: number; x: number | null; y: number | null;
  debuffed: boolean;
  potionEffects: { goldTier: number | null; damageTier: number | null };
}
export interface TvDefeat extends DefeatSummary { creatureUrl: string; }
export interface TvMonsterAttack {
  id: number; playerId: number; kind: 'gold' | 'debuff'; amount: number;
}
export interface TvState {
  dungeonId: number | null;
  raidNumber: number | null;
  fightIndex: number | null;
  fightCount: number | null;
  activeRaiders: number;
  paused: boolean;
  encounter: TvEncounter | null;
  players: TvHero[];
  defeat: TvDefeat | null;
  monsterAttack: TvMonsterAttack | null;
}

export function buildTvState(
  db: Database.Database,
  now: number,
  assets: SkinAssetContext = {},
): TvState {
  const cfg = loadEngineConfig(db);
  const gs = getGameState(db);

  // Encounter (active only).
  let encounter: TvEncounter | null = null;
  const raid = gs.current_dungeon_id
    ? db.prepare('SELECT id, regular_count FROM dungeons WHERE id=?')
      .get(gs.current_dungeon_id) as { id: number; regular_count: number } | undefined
    : undefined;
  const raidNumber = raid?.id ?? null;
  let fightIndex: number | null = null;
  const fightCount = raid ? raid.regular_count + 1 : null;
  if (gs.current_encounter_id) {
    const e = db.prepare('SELECT * FROM encounters WHERE id=?').get(gs.current_encounter_id) as any;
    if (e && e.status === 'active') {
      fightIndex = e.index_in_dungeon + 1;
      const meta = monsterByIndex(e.creature_index);
      const isPack = e.kind === 'pack' && e.pack_count > 1; // a mob of several -> plural name
      encounter = {
        id: e.id, creatureIndex: e.creature_index, creatureUrl: creatureSpriteUrl(e.creature_index),
        footprint: e.footprint, kind: e.kind, packCount: e.pack_count,
        hp: e.current_hp, maxHp: e.max_hp,
        name: meta ? monsterTitle(e.id, e.creature_index, meta.category, isPack)
          : (isPack ? pluralizeCreature(monsterName(e.creature_index)) : monsterName(e.creature_index)),
        size: meta?.size ?? 'M',
        flying: meta?.flying ?? false,
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
  const potionTiersByPlayer = visiblePotionTiersByPlayer(db, now);
  const players: TvHero[] = rows.map((p) => {
    const potionEffects = potionTiersByPlayer.get(p.id)
      ?? { goldTier: null, damageTier: null };
    return {
      id: p.id, name: p.name, avatarUrl: cosmeticSkinUrlForPlayer(db, p, 'a', assets),
      level: p.level, totalTokens: p.total_tokens, effectiveTokens: p.effective_tokens,
      gold: p.gold, modifier: tokenModifier(activityScore(db, p.id, now, cfg), cfg.tokenModifierK, cfg.modifierCap),
      disabled: !!p.disabled, connected: p.last_token_at != null,
      damage: dmgByPlayer.get(p.id) ?? 0, x: null, y: null,
      debuffed: debuffFactor(db, p.id, now, cfg) < 1,
      potionEffects,
    };
  });
  const activeRaiders = rows.filter((p) => !p.disabled
    && activityScore(db, p.id, now, cfg) > 0).length;

  // Assign battlefield slots to enabled players (same order) from the layout.
  const layout = currentTvLayout(db);
  if (layout) {
    const enabled = players.filter((p) => !p.disabled);
    const placed = assignHeroSlots(enabled, layout.heroSlots);
    const pos = new Map(placed.map((p) => [p.id, { x: p.x, y: p.y }]));
    for (const p of players) {
      const xy = pos.get(p.id);
      if (xy) { p.x = xy.x; p.y = xy.y; }
    }
  }

  // Latest monster counter-attack this encounter (drives the one-shot TV animation).
  let monsterAttack: TvMonsterAttack | null = null;
  if (encounter) {
    const row = db.prepare(
      'SELECT id, player_id, kind, gold_delta FROM monster_attacks WHERE encounter_id=? ORDER BY id DESC LIMIT 1',
    ).get(encounter.id) as { id: number; player_id: number; kind: 'gold' | 'debuff'; gold_delta: number } | undefined;
    if (row) monsterAttack = { id: row.id, playerId: row.player_id, kind: row.kind, amount: row.gold_delta };
  }

  // Defeat popup during the window.
  let defeat: TvDefeat | null = null;
  if (gs.defeat_until && now < gs.defeat_until && gs.last_defeat_encounter_id) {
    const summary = buildDefeatSummary(db, gs.last_defeat_encounter_id);
    defeat = { ...summary, creatureUrl: creatureSpriteUrl(summary.creatureIndex) };
  }

  return {
    dungeonId: gs.current_dungeon_id,
    raidNumber,
    fightIndex,
    fightCount,
    activeRaiders,
    paused: !!gs.paused,
    encounter,
    players,
    defeat,
    monsterAttack,
  };
}

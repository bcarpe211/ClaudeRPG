import type Database from 'better-sqlite3';
import { getClass } from './classes';
import { dyeViewModel } from './dye';
import { combatActiveMsForDay } from './gameclock';
import { listInventory } from './inventory';
import { nextOfficeMidnight, officeDayKey, officeDayStart } from './office-time';
import {
  activePotionEffects,
  potionEffectSnapshot,
  potionUsesForDay,
  remainingDailyUses,
} from './potions';
import type { Player } from './players';
import { activeDebuff } from './retaliation';
import {
  consumableProduct,
  type ConsumableProduct,
  type PotionType,
} from './shop-products';
import { getSetting } from './settings';
import {
  cosmeticSkinUrlForPlayer,
  type SkinAssetContext,
} from './slotcosmetics';
import { buildSetupSnippet } from './snippet';

const DEFAULT_DAILY_USES = 3;
const DEFAULT_DEBUFF_FACTOR = 0.85;
const DEFAULT_DEBUFF_SECONDS = 8;

export interface PlayerHubToday {
  effectiveTokens: number;
  damage: number;
  fightRank: number | null;
  goldEarned: number;
  combatActiveMs: number;
  potionsUsed: number;
}

export interface PlayerHubInventoryItem {
  sku: ConsumableProduct['id'];
  name: string;
  potionType: PotionType;
  tier: 1;
  quantity: number;
  durationMs: number;
  iconClass: string;
  effectCopy: string;
  usesRemaining: number;
  nextResetAt: number;
}

export interface PlayerHubEffect {
  kind: 'gold' | 'damage' | 'debuff';
  iconClass: string;
  title: string;
  description: string;
  remainingMs: number;
  tier?: number;
  state?: 'armed' | 'active' | 'paused';
  progress?: { value: number; max: number };
}

export interface PlayerHubState {
  gold: number;
  inventory: PlayerHubInventoryItem[];
  effects: PlayerHubEffect[];
  today: PlayerHubToday;
  currentFight: {
    leaders: { playerId: number; name: string; damage: number }[];
  };
}

export type PlayerHubViewModel = PlayerHubState & {
  avatarA: string;
  avatarB: string;
  className: string;
  connected: boolean;
  dye: ReturnType<typeof dyeViewModel>;
  snippet: string;
};

function configuredNumber(
  db: Database.Database,
  key: string,
  fallback: number,
): number {
  const value = Number(getSetting(db, key));
  return Number.isFinite(value) ? value : fallback;
}

function configuredDailyUses(db: Database.Database): number {
  const value = configuredNumber(db, 'potion_daily_uses_per_type', DEFAULT_DAILY_USES);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_DAILY_USES;
}

function productEffectCopy(db: Database.Database, product: ConsumableProduct): string {
  const snapshot = potionEffectSnapshot(db, product.potionType, product.durationMs);
  if (!snapshot) throw new RangeError(`${product.id} effect settings are invalid`);
  if (snapshot.kind === 'gold') {
    return `${snapshot.goldPerUnit.toLocaleString('en-US')}g per 1,000 effective tokens`;
  }
  const percent = Number(((snapshot.baseHitMultiplier - 1) * 100).toFixed(10));
  return `+${percent.toLocaleString('en-US')}% personal base hit`;
}

function currentEncounterId(db: Database.Database): number | null {
  const row = db.prepare(
    `SELECT e.id
     FROM game_state gs
     JOIN encounters e ON e.id = gs.current_encounter_id
     WHERE gs.id=1 AND e.status='active'`,
  ).get() as { id: number } | undefined;
  return row?.id ?? null;
}

function currentFight(
  db: Database.Database,
  encounterId: number | null,
): PlayerHubState['currentFight'] {
  if (encounterId === null) return { leaders: [] };
  const leaders = db.prepare(
    `SELECT p.id AS playerId, p.name, ed.damage_total AS damage
     FROM encounter_damage ed
     JOIN players p ON p.id = ed.player_id
     WHERE ed.encounter_id = ? AND ed.damage_total > 0
     ORDER BY ed.damage_total DESC, p.id ASC
     LIMIT 5`,
  ).all(encounterId) as PlayerHubState['currentFight']['leaders'];
  return { leaders };
}

function fightRank(
  db: Database.Database,
  encounterId: number | null,
  playerId: number,
): number | null {
  if (encounterId === null) return null;
  const playerDamage = db.prepare(
    `SELECT damage_total AS damage FROM encounter_damage
     WHERE encounter_id=? AND player_id=?`,
  ).get(encounterId, playerId) as { damage: number } | undefined;
  if (!playerDamage) return null;
  const row = db.prepare(
    `SELECT COUNT(*) + 1 AS rank
     FROM encounter_damage
     WHERE encounter_id=?
       AND (damage_total > ? OR (damage_total = ? AND player_id < ?))`,
  ).get(encounterId, playerDamage.damage, playerDamage.damage, playerId) as { rank: number };
  return row.rank;
}

function activeEffects(
  db: Database.Database,
  playerId: number,
  now: number,
): PlayerHubEffect[] {
  const effects: PlayerHubEffect[] = activePotionEffects(db, playerId, now).map((effect) => {
    if (effect.snapshot.kind === 'gold') {
      return {
        kind: 'gold' as const,
        iconClass: 'potion-gold',
        title: 'Beginner Gold Potion',
        description: `${effect.snapshot.goldPerUnit.toLocaleString('en-US')}g per 1,000 effective tokens`,
        remainingMs: effect.remainingGameMs,
        tier: effect.tier,
        state: effect.state,
        progress: {
          value: Math.min(effect.eligibleTokens, effect.snapshot.stretchTokens),
          max: effect.snapshot.stretchTokens,
        },
      };
    }
    const percent = Number(((effect.snapshot.baseHitMultiplier - 1) * 100).toFixed(10));
    return {
      kind: 'damage' as const,
      iconClass: 'potion-damage',
      title: 'Beginner Damage Potion',
      description: `+${percent.toLocaleString('en-US')}% personal base hit`,
      remainingMs: effect.remainingGameMs,
      tier: effect.tier,
      state: effect.state,
    };
  });

  const factor = configuredNumber(db, 'monster_debuff_factor', DEFAULT_DEBUFF_FACTOR);
  const seconds = configuredNumber(db, 'monster_debuff_seconds', DEFAULT_DEBUFF_SECONDS);
  const debuff = activeDebuff(db, playerId, now, {
    monsterDebuffFactor: factor,
    monsterDebuffSeconds: seconds,
  });
  if (debuff) {
    const penalty = Number(((1 - debuff.factor) * 100).toFixed(10));
    effects.push({
      kind: 'debuff',
      iconClass: 'effect-debuff',
      title: 'Monster Hex',
      description: `${penalty.toLocaleString('en-US')}% less damage`,
      remainingMs: debuff.remainingMs,
    });
  }
  return effects;
}

export function buildPlayerHubState(
  db: Database.Database,
  player: Player,
  now: number,
  timeZone: string,
): PlayerHubState {
  const dayKey = officeDayKey(now, timeZone);
  const dayStart = officeDayStart(now, timeZone);
  const resetAt = nextOfficeMidnight(now, timeZone);
  const dailyUses = configuredDailyUses(db);
  const encounterId = currentEncounterId(db);
  const inventory = listInventory(db, player.id)
    .flatMap(({ sku, quantity }): PlayerHubInventoryItem[] => {
      const product = consumableProduct(db, sku);
      if (!product || quantity <= 0) return [];
      return [{
        sku: product.id,
        name: product.name,
        potionType: product.potionType,
        tier: product.tier,
        quantity,
        durationMs: product.durationMs,
        iconClass: product.iconClass,
        effectCopy: productEffectCopy(db, product),
        usesRemaining: remainingDailyUses(
          db, player.id, product.potionType, dayKey, dailyUses,
        ),
        nextResetAt: resetAt,
      }];
    })
    .sort((a, b) => (
      a.potionType === b.potionType ? a.sku.localeCompare(b.sku) : a.potionType === 'gold' ? -1 : 1
    ));

  const tokens = db.prepare(
    `SELECT COALESCE(SUM(effective_delta), 0) AS total
     FROM token_events WHERE player_id=? AND ts>=? AND ts<=?`,
  ).get(player.id, dayStart, now) as { total: number };
  const combat = db.prepare(
    `SELECT damage FROM player_daily_combat
     WHERE player_id=? AND office_day=?`,
  ).get(player.id, dayKey) as { damage: number } | undefined;
  const gold = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM gold_ledger
     WHERE player_id=? AND created_at>=? AND created_at<=? AND amount>0
       AND reason IN ('encounter_reward','gold_potion_base','gold_potion_stretch')`,
  ).get(player.id, dayStart, now) as { total: number };
  const balance = db.prepare('SELECT gold FROM players WHERE id=?').get(player.id) as { gold: number };

  return {
    gold: balance.gold,
    inventory,
    effects: activeEffects(db, player.id, now),
    today: {
      effectiveTokens: tokens.total,
      damage: combat?.damage ?? 0,
      fightRank: fightRank(db, encounterId, player.id),
      goldEarned: gold.total,
      combatActiveMs: combatActiveMsForDay(db, dayKey),
      potionsUsed: potionUsesForDay(db, player.id, dayKey),
    },
    currentFight: currentFight(db, encounterId),
  };
}

export function buildPlayerHubViewModel(
  db: Database.Database,
  player: Player,
  now: number,
  timeZone: string,
  context: SkinAssetContext & { publicUrl: string },
): PlayerHubViewModel {
  const assets = { spritesDir: context.spritesDir, slotmapsDir: context.slotmapsDir };
  return {
    ...buildPlayerHubState(db, player, now, timeZone),
    avatarA: cosmeticSkinUrlForPlayer(db, player, 'a', assets),
    avatarB: cosmeticSkinUrlForPlayer(db, player, 'b', assets),
    className: getClass(player.class_key)?.name ?? player.class_key,
    connected: player.last_token_at !== null,
    dye: dyeViewModel(db, player, context.slotmapsDir),
    snippet: buildSetupSnippet({ token: player.auth_token, endpoint: context.publicUrl }),
  };
}

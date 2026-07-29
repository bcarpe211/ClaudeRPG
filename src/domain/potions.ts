import type Database from 'better-sqlite3';
import { z } from 'zod';
import { combatActiveMs, isCombatAcceptingWork } from './gameclock';
import { applyGoldMutation } from './goldledger';
import { inventoryQuantity } from './inventory';
import { officeDayKey } from './office-time';
import { consumableProduct, type PotionType } from './shop-products';
import { getSetting } from './settings';

const DEFAULT_DAILY_USES = 3;
const DEFAULT_PAUSE_AFTER_MINUTES = 15;

export interface GoldPotionSnapshot {
  kind: 'gold';
  durationMs: number;
  tokenUnit: 1_000;
  goldPerUnit: number;
  baseCap: number;
  stretchTokens: number;
  stretchBonus: number;
}

export interface DamagePotionSnapshot {
  kind: 'damage';
  durationMs: number;
  baseHitMultiplier: number;
}

export type PotionEffectSnapshot = GoldPotionSnapshot | DamagePotionSnapshot;

export interface ActivePotionEffect {
  activationId: number;
  sku: string;
  potionType: PotionType;
  tier: number;
  state: 'armed' | 'active' | 'paused';
  remainingGameMs: number;
  snapshot: PotionEffectSnapshot;
  eligibleTokens: number;
  baseGold: number;
  stretchGold: number;
}

export interface VisiblePotionTiers {
  goldTier: number | null;
  damageTier: number | null;
}

export interface GoldPotionWorkResult {
  activationId: number | null;
  eligibleTokens: number;
  baseGold: number;
  stretchGold: number;
  duplicate: boolean;
}

export type ActivatePotionResult =
  | {
      ok: true;
      activationId: number;
      duplicate: boolean;
      potionType: PotionType;
      inventoryRemaining: number;
      usesRemaining: number;
      state: 'armed' | 'active';
    }
  | {
      ok: false;
      reason:
        | 'unknown_sku'
        | 'no_player'
        | 'no_inventory'
        | 'daily_limit'
        | 'type_active'
        | 'invalid_config'
        | 'request_conflict';
    };

const safeNonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveDuration = safeNonNegativeInteger.refine((value) => value > 0);

const goldPotionSnapshotSchema = z.object({
  kind: z.literal('gold'),
  durationMs: positiveDuration,
  tokenUnit: z.literal(1_000),
  goldPerUnit: safeNonNegativeInteger,
  baseCap: safeNonNegativeInteger,
  stretchTokens: safeNonNegativeInteger,
  stretchBonus: safeNonNegativeInteger,
}).strict();

const damagePotionSnapshotSchema = z.object({
  kind: z.literal('damage'),
  durationMs: positiveDuration,
  baseHitMultiplier: z.number().finite().positive(),
}).strict();

const potionEffectSnapshotSchema = z.discriminatedUnion('kind', [
  goldPotionSnapshotSchema,
  damagePotionSnapshotSchema,
]);

function parseStoredSnapshot(
  effectSnapshot: string,
  potionType: PotionType,
): PotionEffectSnapshot | undefined {
  let storedSnapshot: unknown;
  try {
    storedSnapshot = JSON.parse(effectSnapshot);
  } catch {
    return undefined;
  }
  const parsed = potionEffectSnapshotSchema.safeParse(storedSnapshot);
  return parsed.success && parsed.data.kind === potionType
    ? parsed.data
    : undefined;
}

type ActivationRow = {
  id: number;
  sku: string;
  potion_type: PotionType;
  inventory_remaining_after: number;
  uses_remaining_after: number;
  initial_state: 'armed' | 'active';
};

type ActiveRow = {
  id: number;
  sku: string;
  potion_type: PotionType;
  tier: number;
  start_game_ms: number;
  expires_game_ms: number;
  effect_snapshot: string;
  eligible_tokens: number;
  base_gold: number;
  stretch_gold: number;
};

type GoldWorkRow = {
  activation_id: number;
  effective_delta: number;
  base_gold: number;
  stretch_gold: number;
};

type InventoryLot = {
  id: number;
  purchase_id: number;
  unit_price: number;
};

function jsonNumberSetting(db: Database.Database, key: string): number | undefined {
  const raw = getSetting(db, key);
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function configuredDailyUses(db: Database.Database): number {
  const value = jsonNumberSetting(db, 'potion_daily_uses_per_type');
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_DAILY_USES;
}

function configuredPauseAfterMinutes(db: Database.Database): number {
  const value = jsonNumberSetting(db, 'pause_after_minutes');
  return value !== undefined && value >= 0
    ? value
    : DEFAULT_PAUSE_AFTER_MINUTES;
}

export function potionEffectSnapshot(
  db: Database.Database,
  potionType: PotionType,
  durationMs: number,
): PotionEffectSnapshot | undefined {
  if (potionType === 'gold') {
    const parsed = goldPotionSnapshotSchema.safeParse({
      kind: 'gold',
      durationMs,
      tokenUnit: 1_000,
      goldPerUnit: jsonNumberSetting(db, 'potion_gold_t1_gold_per_1000'),
      baseCap: jsonNumberSetting(db, 'potion_gold_t1_base_cap'),
      stretchTokens: jsonNumberSetting(db, 'potion_gold_t1_stretch_tokens'),
      stretchBonus: jsonNumberSetting(db, 'potion_gold_t1_stretch_bonus'),
    });
    return parsed.success ? parsed.data : undefined;
  }

  const baseHitPercent = jsonNumberSetting(db, 'potion_damage_t1_base_hit_pct');
  const parsed = damagePotionSnapshotSchema.safeParse({
    kind: 'damage',
    durationMs,
    baseHitMultiplier: baseHitPercent === undefined || baseHitPercent < 0
      ? undefined
      : 1 + baseHitPercent / 100,
  });
  return parsed.success ? parsed.data : undefined;
}

export function potionActivationState(
  db: Database.Database,
  now: number,
): 'armed' | 'active' {
  return isCombatAcceptingWork(db, now, configuredPauseAfterMinutes(db))
    ? 'active'
    : 'armed';
}

function duplicateResult(
  activation: ActivationRow,
): ActivatePotionResult {
  return {
    ok: true,
    activationId: activation.id,
    duplicate: true,
    potionType: activation.potion_type,
    inventoryRemaining: activation.inventory_remaining_after,
    usesRemaining: activation.uses_remaining_after,
    state: activation.initial_state,
  };
}

export function remainingDailyUses(
  db: Database.Database,
  playerId: number,
  potionType: PotionType,
  dayKey: string,
  dailyLimit: number,
): number {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0) {
    throw new RangeError('daily limit must be a non-negative safe integer');
  }
  const rows = db.prepare(
    `SELECT potion_type, effect_snapshot
     FROM potion_activations
     WHERE player_id = ? AND potion_type = ? AND activation_day = ?`,
  ).all(playerId, potionType, dayKey) as {
    potion_type: PotionType;
    effect_snapshot: string;
  }[];
  const used = rows.filter((row) => (
    parseStoredSnapshot(row.effect_snapshot, row.potion_type) !== undefined
  )).length;
  return Math.max(0, dailyLimit - used);
}

/** Count only activations whose immutable effect snapshot is still valid. */
export function potionUsesForDay(
  db: Database.Database,
  playerId: number,
  dayKey: string,
): number {
  const rows = db.prepare(
    `SELECT potion_type, effect_snapshot
     FROM potion_activations
     WHERE player_id = ? AND activation_day = ?`,
  ).all(playerId, dayKey) as {
    potion_type: PotionType;
    effect_snapshot: string;
  }[];
  return rows.filter((row) => (
    parseStoredSnapshot(row.effect_snapshot, row.potion_type) !== undefined
  )).length;
}

function completeExpiredPotionsAtGameMs(
  db: Database.Database,
  now: number,
  currentGameMs: number,
): number {
  const result = db.prepare(
    `UPDATE potion_activations
     SET status = 'completed', completed_at = ?
     WHERE status = 'active' AND expires_game_ms <= ?`,
  ).run(now, currentGameMs);
  return result.changes;
}

export function completeExpiredPotions(
  db: Database.Database,
  now: number,
): number {
  return completeExpiredPotionsAtGameMs(db, now, combatActiveMs(db));
}

export function damagePotionMultiplier(
  db: Database.Database,
  playerId: number,
): { activationId: number; multiplier: number } | null {
  const activation = db.prepare(
    `SELECT id, effect_snapshot
     FROM potion_activations
     WHERE player_id = ?
       AND potion_type = 'damage'
       AND status = 'active'
       AND expires_game_ms > ?
     ORDER BY id
     LIMIT 1`,
  ).get(playerId, combatActiveMs(db)) as {
    id: number;
    effect_snapshot: string;
  } | undefined;
  if (!activation) return null;

  const snapshot = parseStoredSnapshot(activation.effect_snapshot, 'damage');
  if (!snapshot || snapshot.kind !== 'damage') return null;
  return {
    activationId: activation.id,
    multiplier: snapshot.baseHitMultiplier,
  };
}

function retireInvalidActivePotions(
  db: Database.Database,
  playerId: number,
  now: number,
): number {
  const rows = db.prepare(
    `SELECT id, potion_type, effect_snapshot
     FROM potion_activations
     WHERE player_id = ? AND status = 'active'`,
  ).all(playerId) as {
    id: number;
    potion_type: PotionType;
    effect_snapshot: string;
  }[];
  const complete = db.prepare(
    `UPDATE potion_activations
     SET status = 'completed', completed_at = ?
     WHERE id = ? AND status = 'active'`,
  );
  let retired = 0;
  for (const row of rows) {
    if (parseStoredSnapshot(row.effect_snapshot, row.potion_type)) continue;
    retired += complete.run(now, row.id).changes;
  }
  return retired;
}

export function activatePotion(
  db: Database.Database,
  input: {
    playerId: number;
    skuId: string;
    requestId: string;
    now: number;
    timeZone: string;
  },
): ActivatePotionResult {
  try {
    const execute = db.transaction((): ActivatePotionResult => {
      const prior = db.prepare(
        `SELECT id, sku, potion_type, inventory_remaining_after,
                uses_remaining_after, initial_state
         FROM potion_activations
         WHERE player_id = ? AND request_id = ?`,
      ).get(input.playerId, input.requestId) as ActivationRow | undefined;
      if (prior) {
        if (prior.sku !== input.skuId) {
          return { ok: false, reason: 'request_conflict' };
        }
        return duplicateResult(prior);
      }

      completeExpiredPotions(db, input.now);
      retireInvalidActivePotions(db, input.playerId, input.now);

      let product;
      try {
        product = consumableProduct(db, input.skuId);
      } catch (error) {
        if (error instanceof RangeError) {
          return { ok: false, reason: 'invalid_config' };
        }
        throw error;
      }
      if (!product) return { ok: false, reason: 'unknown_sku' };

      const player = db.prepare(
        'SELECT id FROM players WHERE id = ?',
      ).get(input.playerId) as { id: number } | undefined;
      if (!player) return { ok: false, reason: 'no_player' };

      const snapshot = potionEffectSnapshot(db, product.potionType, product.durationMs);
      if (!snapshot) return { ok: false, reason: 'invalid_config' };

      const activationDay = officeDayKey(input.now, input.timeZone);
      const dailyLimit = configuredDailyUses(db);
      const usesRemaining = remainingDailyUses(
        db,
        input.playerId,
        product.potionType,
        activationDay,
        dailyLimit,
      );
      if (usesRemaining === 0) return { ok: false, reason: 'daily_limit' };

      const sameTypeActive = db.prepare(
        `SELECT id FROM potion_activations
         WHERE player_id = ? AND potion_type = ? AND status = 'active'`,
      ).get(input.playerId, product.potionType);
      if (sameTypeActive) return { ok: false, reason: 'type_active' };

      const lot = db.prepare(
        `SELECT id, purchase_id, unit_price
         FROM player_inventory_lots
         WHERE player_id = ? AND sku = ? AND remaining_quantity > 0
         ORDER BY purchased_at, id
         LIMIT 1`,
      ).get(input.playerId, product.id) as InventoryLot | undefined;
      const stackQuantity = inventoryQuantity(db, input.playerId, product.id);
      if (!lot || stackQuantity <= 0) {
        return { ok: false, reason: 'no_inventory' };
      }

      const lotUpdate = db.prepare(
        `UPDATE player_inventory_lots
         SET remaining_quantity = remaining_quantity - 1
         WHERE id = ? AND remaining_quantity > 0`,
      ).run(lot.id);
      const stackUpdate = db.prepare(
        `UPDATE player_inventory
         SET quantity = quantity - 1, updated_at = ?
         WHERE player_id = ? AND sku = ? AND quantity > 0`,
      ).run(input.now, input.playerId, product.id);
      if (lotUpdate.changes !== 1 || stackUpdate.changes !== 1) {
        throw new InventoryChangedDuringActivation();
      }

      const startGameMs = combatActiveMs(db);
      const initialState = potionActivationState(db, input.now);
      const inserted = db.prepare(
        `INSERT INTO potion_activations
          (player_id, sku, potion_type, tier, purchase_id, purchase_unit_price,
           request_id, activation_day, activated_at, start_game_ms, expires_game_ms,
           status, effect_snapshot, inventory_remaining_after,
           uses_remaining_after, initial_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(
        input.playerId,
        product.id,
        product.potionType,
        product.tier,
        lot.purchase_id,
        lot.unit_price,
        input.requestId,
        activationDay,
        input.now,
        startGameMs,
        startGameMs + snapshot.durationMs,
        JSON.stringify(snapshot),
        stackQuantity - 1,
        usesRemaining - 1,
        initialState,
      );

      return {
        ok: true,
        activationId: Number(inserted.lastInsertRowid),
        duplicate: false,
        potionType: product.potionType,
        inventoryRemaining: stackQuantity - 1,
        usesRemaining: usesRemaining - 1,
        state: initialState,
      };
    });
    return execute();
  } catch (error) {
    if (error instanceof InventoryChangedDuringActivation) {
      return { ok: false, reason: 'no_inventory' };
    }
    if (
      error instanceof Error
      && error.message.includes(
        'UNIQUE constraint failed: potion_activations.player_id, potion_activations.potion_type',
      )
    ) {
      return { ok: false, reason: 'type_active' };
    }
    throw error;
  }
}

export function activePotionEffects(
  db: Database.Database,
  playerId: number,
  now: number,
): ActivePotionEffect[] {
  completeExpiredPotions(db, now);
  const currentGameMs = combatActiveMs(db);
  const acceptingWork = isCombatAcceptingWork(
    db,
    now,
    configuredPauseAfterMinutes(db),
  );
  const rows = db.prepare(
    `SELECT id, sku, potion_type, tier, activation_day, start_game_ms,
            expires_game_ms, effect_snapshot, eligible_tokens, base_gold,
            stretch_gold
     FROM potion_activations
     WHERE player_id = ? AND status = 'active'
     ORDER BY id`,
  ).all(playerId) as ActiveRow[];

  const effects: ActivePotionEffect[] = [];
  for (const row of rows) {
    const snapshot = parseStoredSnapshot(row.effect_snapshot, row.potion_type);
    if (!snapshot) continue;

    effects.push({
      activationId: row.id,
      sku: row.sku,
      potionType: row.potion_type,
      tier: row.tier,
      state: currentGameMs <= row.start_game_ms
        ? 'armed'
        : acceptingWork
          ? 'active'
          : 'paused',
      remainingGameMs: Math.max(0, row.expires_game_ms - currentGameMs),
      snapshot,
      eligibleTokens: row.eligible_tokens,
      baseGold: row.base_gold,
      stretchGold: row.stretch_gold,
    });
  }
  return effects;
}

/**
 * One TV-facing snapshot for every player whose potion clock has started.
 * Expiry and combat time are evaluated once so a broadcast never fans out
 * through the full active-effect reader per player.
 */
export function visiblePotionTiersByPlayer(
  db: Database.Database,
  now: number,
): Map<number, VisiblePotionTiers> {
  const currentGameMs = combatActiveMs(db);
  completeExpiredPotionsAtGameMs(db, now, currentGameMs);
  const rows = db.prepare(
    `SELECT player_id, potion_type, tier, start_game_ms, effect_snapshot
     FROM potion_activations
     WHERE status='active' AND expires_game_ms > ?
     ORDER BY player_id, id`,
  ).all(currentGameMs) as Array<{
    player_id: number;
    potion_type: PotionType;
    tier: number;
    start_game_ms: number;
    effect_snapshot: string;
  }>;

  const byPlayer = new Map<number, VisiblePotionTiers>();
  for (const row of rows) {
    if (currentGameMs <= row.start_game_ms) continue;
    if (!parseStoredSnapshot(row.effect_snapshot, row.potion_type)) continue;
    const tiers = byPlayer.get(row.player_id) ?? { goldTier: null, damageTier: null };
    if (row.potion_type === 'gold') tiers.goldTier = row.tier;
    if (row.potion_type === 'damage') tiers.damageTier = row.tier;
    byPlayer.set(row.player_id, tiers);
  }
  return byPlayer;
}

export function applyGoldPotionWork(
  db: Database.Database,
  playerId: number,
  tokenEventId: number,
  effectiveDelta: number,
  now: number,
): GoldPotionWorkResult {
  return db.transaction((): GoldPotionWorkResult => {
    const priorWork = db.prepare(
      `SELECT activation_id, effective_delta, base_gold, stretch_gold
       FROM potion_work_events
       WHERE token_event_id = ?
       ORDER BY id
       LIMIT 1`,
    ).get(tokenEventId) as GoldWorkRow | undefined;
    if (priorWork) {
      return {
        activationId: priorWork.activation_id,
        eligibleTokens: priorWork.effective_delta,
        baseGold: priorWork.base_gold,
        stretchGold: priorWork.stretch_gold,
        duplicate: true,
      };
    }

    const zero: GoldPotionWorkResult = {
      activationId: null,
      eligibleTokens: 0,
      baseGold: 0,
      stretchGold: 0,
      duplicate: false,
    };
    if (!Number.isSafeInteger(effectiveDelta) || effectiveDelta <= 0) return zero;

    completeExpiredPotions(db, now);
    retireInvalidActivePotions(db, playerId, now);
    if (!isCombatAcceptingWork(
      db,
      now,
      configuredPauseAfterMinutes(db),
    )) {
      return zero;
    }

    const currentGameMs = combatActiveMs(db);
    const activation = db.prepare(
      `SELECT id, sku, potion_type, tier, start_game_ms, expires_game_ms,
              effect_snapshot, eligible_tokens, base_gold, stretch_gold
       FROM potion_activations
       WHERE player_id = ?
         AND potion_type = 'gold'
         AND status = 'active'
         AND expires_game_ms > ?
       ORDER BY id
       LIMIT 1`,
    ).get(playerId, currentGameMs) as ActiveRow | undefined;
    if (!activation) return zero;

    const parsedSnapshot = parseStoredSnapshot(
      activation.effect_snapshot,
      activation.potion_type,
    );
    if (!parsedSnapshot || parsedSnapshot.kind !== 'gold') return zero;

    const nextTokens = activation.eligible_tokens + effectiveDelta;
    if (!Number.isSafeInteger(nextTokens)) {
      throw new RangeError('eligible Gold Potion tokens must be a safe integer');
    }
    const nextBase = Math.min(
      Math.floor(nextTokens / parsedSnapshot.tokenUnit)
        * parsedSnapshot.goldPerUnit,
      parsedSnapshot.baseCap,
    );
    const baseGold = nextBase - activation.base_gold;
    const stretchGold = (
      activation.eligible_tokens < parsedSnapshot.stretchTokens
      && nextTokens >= parsedSnapshot.stretchTokens
      && activation.stretch_gold === 0
    )
      ? parsedSnapshot.stretchBonus
      : 0;

    const inserted = db.prepare(
      `INSERT INTO potion_work_events
        (activation_id, token_event_id, effective_delta, base_gold,
         stretch_gold, combat_active_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      activation.id,
      tokenEventId,
      effectiveDelta,
      baseGold,
      stretchGold,
      currentGameMs,
      now,
    );
    const workEventId = Number(inserted.lastInsertRowid);

    const updated = db.prepare(
      `UPDATE potion_activations
       SET eligible_tokens = ?, base_gold = ?, stretch_gold = ?
       WHERE id = ? AND status = 'active'`,
    ).run(
      nextTokens,
      nextBase,
      activation.stretch_gold + stretchGold,
      activation.id,
    );
    if (updated.changes !== 1) {
      throw new Error('Gold Potion activation changed while applying work');
    }

    if (baseGold > 0) {
      const result = applyGoldMutation(db, {
        playerId,
        amount: baseGold,
        reason: 'gold_potion_base',
        sourceTable: 'potion_work_events',
        sourceId: `${workEventId}`,
        now,
      });
      if (result.status !== 'applied') {
        throw new Error(`unable to credit Gold Potion base payout: ${result.status}`);
      }
    }
    if (stretchGold > 0) {
      const result = applyGoldMutation(db, {
        playerId,
        amount: stretchGold,
        reason: 'gold_potion_stretch',
        sourceTable: 'potion_work_events',
        sourceId: `${workEventId}`,
        now,
      });
      if (result.status !== 'applied') {
        throw new Error(`unable to credit Gold Potion stretch payout: ${result.status}`);
      }
    }

    return {
      activationId: activation.id,
      eligibleTokens: effectiveDelta,
      baseGold,
      stretchGold,
      duplicate: false,
    };
  })();
}

class InventoryChangedDuringActivation extends Error {}

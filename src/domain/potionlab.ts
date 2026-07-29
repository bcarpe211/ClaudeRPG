import type Database from 'better-sqlite3';
import { allocateEncounterGold } from './rewards';

export type LaunchPotionSku = 'potion_gold_t1' | 'potion_damage_t1';

export interface PotionLabFilters {
  from?: number;
  to?: number;
  playerId?: number;
  sku?: LaunchPotionSku;
  timeZone?: string;
}

export interface PotionLabReport {
  gold: {
    purchases: number;
    completed: number;
    spent: number;
    basePayout: number;
    stretchPayout: number;
    breakEvenCount: number;
    stretchCount: number;
    breakEvenRate: number;
    stretchRate: number;
    byPlayer: { playerId: number; activations: number; medianNetGold: number }[];
    byOfficeHour: { hour: number; activations: number; medianNetGold: number }[];
    activations: {
      activationId: number;
      playerId: number;
      purchasedAt: number;
      activatedAt: number;
      completedAt: number | null;
      wallElapsedMs: number;
      activeElapsedMs: number;
      eligibleTokens: number;
      basePayout: number;
      stretchPayout: number;
      payout: number;
      purchasePrice: number;
      netGold: number;
    }[];
  };
  damage: {
    activations: {
      activationId: number;
      playerId: number;
      purchasedAt: number;
      activatedAt: number;
      completedAt: number | null;
      startGameMs: number;
      expiresGameMs: number;
      wallElapsedMs: number;
      activeElapsedMs: number;
      actualDamage: number;
      counterfactualDamage: number;
      bonusDamage: number;
      actualRank: number;
      counterfactualRank: number;
      actualReward: number;
      counterfactualReward: number;
      podiumEntries: number;
      podiumClimbs: number;
      purchasePrice: number;
      netGold: number;
      encounters: {
        encounterId: number;
        actualDamage: number;
        counterfactualDamage: number;
        bonusDamage: number;
        actualRank: number;
        counterfactualRank: number;
        actualReward: number;
        counterfactualReward: number;
        podiumEntry: boolean;
        podiumClimb: number;
        rewardSplit: string;
      }[];
    }[];
  };
  economy: {
    potionGoldSpent: number;
    goldPotionMinted: number;
    encounterGoldAwarded: number;
    monsterGoldStolen: number;
    ledgerInflow: number;
    ledgerOutflow: number;
    ledgerReconciled: boolean;
    stockPurchased: number;
    dosesUsed: number;
  };
  readiness: {
    distinctCombatDays: number;
    completedGold: number;
    completedDamage: number;
    distinctPlayers: number;
    enoughCombatDays: boolean;
    enoughGoldActivations: boolean;
    enoughDamageActivations: boolean;
    enoughPlayers: boolean;
    readyForTier2Review: boolean;
  };
}

type ActivationRow = {
  id: number;
  player_id: number;
  sku: LaunchPotionSku;
  potion_type: 'gold' | 'damage';
  purchase_unit_price: number;
  activated_at: number;
  start_game_ms: number;
  expires_game_ms: number;
  status: 'active' | 'completed';
  completed_at: number | null;
  eligible_tokens: number;
  base_gold: number;
  stretch_gold: number;
  purchased_at: number;
};

type EncounterLink = {
  activation_id: number;
  encounter_id: number;
  bonus_damage: number;
};

type AwardRow = {
  encounter_id: number;
  player_id: number;
  effective_tokens: number;
  damage_total: number;
  potion_bonus_damage: number;
  damage_rank: number;
  total_gold: number;
};

type EncounterRow = {
  id: number;
  reward_model_version: string;
  reward_work_pct: number | null;
  reward_damage_pct: number | null;
  reward_podium_first_pct: number | null;
  reward_podium_second_pct: number | null;
  reward_podium_third_pct: number | null;
};

function validateFilters(filters: PotionLabFilters): void {
  for (const [name, value] of [
    ['from', filters.from],
    ['to', filters.to],
    ['playerId', filters.playerId],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
    throw new RangeError('from must not be after to');
  }
  if (filters.sku !== undefined && !['potion_gold_t1', 'potion_damage_t1'].includes(filters.sku)) {
    throw new RangeError('unknown potion SKU');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: filters.timeZone ?? 'America/New_York' }).format(0);
  } catch {
    throw new RangeError('invalid office time zone');
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function groupGoldActivations(
  rows: PotionLabReport['gold']['activations'],
  key: (row: PotionLabReport['gold']['activations'][number]) => number,
): { key: number; activations: number; medianNetGold: number }[] {
  const groups = new Map<number, number[]>();
  for (const row of rows) {
    const groupKey = key(row);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row.netGold]);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([groupKey, net]) => ({
    key: groupKey,
    activations: net.length,
    medianNetGold: median(net),
  }));
}

interface SqlFilter {
  sql: string;
  params: Array<number | string>;
}

function selectedRowFilter(
  filters: PotionLabFilters,
  fields: { timestamp: string; player: string; sku?: string },
  requiredPredicates: string[] = [],
): SqlFilter {
  const predicates = [...requiredPredicates];
  const params: Array<number | string> = [];
  if (filters.from !== undefined) {
    predicates.push(`${fields.timestamp} >= ?`);
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    predicates.push(`${fields.timestamp} <= ?`);
    params.push(filters.to);
  }
  if (filters.playerId !== undefined) {
    predicates.push(`${fields.player} = ?`);
    params.push(filters.playerId);
  }
  if (filters.sku !== undefined && fields.sku !== undefined) {
    predicates.push(`${fields.sku} = ?`);
    params.push(filters.sku);
  }
  return {
    sql: predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '',
    params,
  };
}

function selectedIds(ids: number[]): string {
  return JSON.stringify(ids);
}

function ledgerReconciles(db: Database.Database): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS mismatches
     FROM players AS player
     LEFT JOIN (
       SELECT player_id, SUM(amount) AS signed_total,
              MAX(id) AS latest_id, COUNT(*) AS entry_count
       FROM gold_ledger
       GROUP BY player_id
     ) AS totals ON totals.player_id = player.id
     LEFT JOIN gold_ledger AS latest ON latest.id = totals.latest_id
     WHERE COALESCE(totals.signed_total, 0) <> player.gold
        OR (totals.entry_count IS NULL AND player.gold <> 0)
        OR (
          totals.entry_count IS NOT NULL
          AND latest.balance_after <> player.gold
        )`,
  ).get() as { mismatches: number };
  return row.mismatches === 0;
}

export function podiumMovement(
  actualRank: number,
  counterfactualRank: number,
): { podiumEntries: number; podiumClimbs: number } {
  const actualOnPodium = actualRank >= 1 && actualRank <= 3;
  const counterfactualOnPodium = counterfactualRank >= 1 && counterfactualRank <= 3;
  return {
    podiumEntries: actualOnPodium && counterfactualRank > 3 ? 1 : 0,
    podiumClimbs: (
      actualOnPodium
      && counterfactualOnPodium
      && actualRank < counterfactualRank
    )
      ? counterfactualRank - actualRank
      : 0,
  };
}

export function buildPotionLabReport(
  db: Database.Database,
  filters: PotionLabFilters,
  now: number,
): PotionLabReport {
  validateFilters(filters);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError('now must be a non-negative safe integer');
  }
  const officeHour = new Intl.DateTimeFormat('en-US', {
    timeZone: filters.timeZone ?? 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const currentGameMs = (db.prepare(
    'SELECT combat_active_ms FROM game_state WHERE id=1',
  ).get() as { combat_active_ms: number }).combat_active_ms;
  const activationFilter = selectedRowFilter(filters, {
    timestamp: 'pa.activated_at',
    player: 'pa.player_id',
    sku: 'pa.sku',
  });
  const activationRows = db.prepare(
    `SELECT pa.id, pa.player_id, pa.sku, pa.potion_type,
            pa.purchase_unit_price, pa.activated_at, pa.start_game_ms,
            pa.expires_game_ms, pa.status, pa.completed_at,
            pa.eligible_tokens, pa.base_gold, pa.stretch_gold,
            sp.created_at AS purchased_at
     FROM potion_activations pa
     JOIN shop_purchases sp ON sp.id=pa.purchase_id
     ${activationFilter.sql}
     ORDER BY pa.activated_at, pa.id`,
  ).all(...activationFilter.params) as ActivationRow[];

  const purchaseFilter = selectedRowFilter(
    filters,
    {
      timestamp: 'shop_purchases.created_at',
      player: 'shop_purchases.player_id',
      sku: 'shop_purchases.sku',
    },
    ["shop_purchases.sku IN ('potion_gold_t1','potion_damage_t1')"],
  );
  const purchaseStats = db.prepare(
    `SELECT
       COALESCE(SUM(
         CASE WHEN sku='potion_gold_t1' THEN 1 ELSE 0 END
       ), 0) AS gold_purchases,
       COALESCE(SUM(
         CASE WHEN sku='potion_gold_t1' THEN total_price ELSE 0 END
       ), 0) AS gold_spent,
       COALESCE(SUM(quantity), 0) AS stock_purchased
     FROM shop_purchases
     ${purchaseFilter.sql}`,
  ).get(...purchaseFilter.params) as {
    gold_purchases: number;
    gold_spent: number;
    stock_purchased: number;
  };

  const goldActivationIds = activationRows
    .filter((row) => row.potion_type === 'gold')
    .map((row) => row.id);
  const workRows = goldActivationIds.length === 0
    ? []
    : db.prepare(
      `SELECT activation_id,
              SUM(effective_delta) AS eligible_tokens,
              SUM(base_gold) AS base_gold,
              SUM(stretch_gold) AS stretch_gold
       FROM potion_work_events
       WHERE activation_id IN (
         SELECT CAST(value AS INTEGER) FROM json_each(?)
       )
       GROUP BY activation_id`,
    ).all(selectedIds(goldActivationIds)) as Array<{
      activation_id: number;
      eligible_tokens: number;
      base_gold: number;
      stretch_gold: number;
    }>;
  const workTotals = new Map(
    workRows.map((row) => [row.activation_id, row]),
  );
  const goldAudit = (row: ActivationRow) => workTotals.get(row.id) ?? {
    eligible_tokens: row.eligible_tokens,
    base_gold: row.base_gold,
    stretch_gold: row.stretch_gold,
  };

  const goldActivations = activationRows
    .filter((row) => row.potion_type === 'gold')
    .map((row): PotionLabReport['gold']['activations'][number] => {
      const audit = goldAudit(row);
      const payout = audit.base_gold + audit.stretch_gold;
      const elapsedEnd = row.status === 'completed'
        ? row.expires_game_ms
        : Math.min(currentGameMs, row.expires_game_ms);
      return {
        activationId: row.id,
        playerId: row.player_id,
        purchasedAt: row.purchased_at,
        activatedAt: row.activated_at,
        completedAt: row.completed_at,
        wallElapsedMs: Math.max(
          0,
          (row.completed_at ?? now) - row.activated_at,
        ),
        activeElapsedMs: Math.max(0, elapsedEnd - row.start_game_ms),
        eligibleTokens: audit.eligible_tokens,
        basePayout: audit.base_gold,
        stretchPayout: audit.stretch_gold,
        payout,
        purchasePrice: row.purchase_unit_price,
        netGold: payout - row.purchase_unit_price,
      };
    });
  const byPlayer = groupGoldActivations(goldActivations, (row) => row.playerId)
    .map(({ key, ...group }) => ({ playerId: key, ...group }));
  const byOfficeHour = groupGoldActivations(
    goldActivations,
    (row) => Number(officeHour.format(row.activatedAt)),
  ).map(({ key, ...group }) => ({ hour: key, ...group }));

  const damageActivationIds = activationRows
    .filter((row) => row.potion_type === 'damage')
    .map((row) => row.id);
  const links = damageActivationIds.length === 0
    ? []
    : db.prepare(
      `SELECT activation_id, encounter_id, bonus_damage
       FROM potion_activation_encounters
       WHERE activation_id IN (
         SELECT CAST(value AS INTEGER) FROM json_each(?)
       )
       ORDER BY activation_id, encounter_id`,
    ).all(selectedIds(damageActivationIds)) as EncounterLink[];
  const linksByActivation = new Map<number, EncounterLink[]>();
  for (const link of links) {
    linksByActivation.set(link.activation_id, [
      ...(linksByActivation.get(link.activation_id) ?? []),
      link,
    ]);
  }
  const encounterIds = [...new Set(links.map((link) => link.encounter_id))];
  const awards = encounterIds.length === 0
    ? []
    : db.prepare(
      `SELECT encounter_id, player_id, effective_tokens, damage_total,
              potion_bonus_damage, damage_rank, total_gold
       FROM encounter_reward_awards
       WHERE encounter_id IN (
         SELECT CAST(value AS INTEGER) FROM json_each(?)
       )
       ORDER BY encounter_id, player_id`,
    ).all(selectedIds(encounterIds)) as AwardRow[];
  const awardsByEncounter = new Map<number, AwardRow[]>();
  for (const award of awards) {
    awardsByEncounter.set(award.encounter_id, [
      ...(awardsByEncounter.get(award.encounter_id) ?? []),
      award,
    ]);
  }
  const encounterRows = encounterIds.length === 0
    ? []
    : db.prepare(
      `SELECT id, reward_model_version, reward_work_pct, reward_damage_pct,
              reward_podium_first_pct, reward_podium_second_pct,
              reward_podium_third_pct
       FROM encounters
       WHERE id IN (
         SELECT CAST(value AS INTEGER) FROM json_each(?)
       )`,
    ).all(selectedIds(encounterIds)) as EncounterRow[];
  const encounters = new Map(encounterRows.map((row) => [row.id, row]));

  const damageActivations = activationRows
    .filter((row) => row.potion_type === 'damage')
    .map((row): PotionLabReport['damage']['activations'][number] => {
      let bonusDamage = 0;
      let actualDamage = 0;
      let counterfactualDamage = 0;
      let actualReward = 0;
      let counterfactualReward = 0;
      let podiumEntries = 0;
      let podiumClimbs = 0;
      const actualRanks: number[] = [];
      const counterfactualRanks: number[] = [];
      const encounterOutcomes: PotionLabReport['damage']['activations'][number]['encounters'] = [];
      for (const link of linksByActivation.get(row.id) ?? []) {
        const encounter = encounters.get(link.encounter_id);
        const participants = awardsByEncounter.get(link.encounter_id) ?? [];
        const actual = participants.find((participant) => participant.player_id === row.player_id);
        if (
          !encounter
          || encounter.reward_model_version !== 'hybrid-v1'
          || !actual
          || participants.length === 0
        ) continue;
        const configValues = [
          encounter.reward_work_pct,
          encounter.reward_damage_pct,
          encounter.reward_podium_first_pct,
          encounter.reward_podium_second_pct,
          encounter.reward_podium_third_pct,
        ];
        if (configValues.some((value) => value === null)) continue;
        const goldPool = participants.reduce((sum, participant) => sum + participant.total_gold, 0);
        const withoutPotionDamage = Math.max(
          0,
          actual.damage_total - link.bonus_damage,
        );
        const counterfactual = allocateEncounterGold(
          participants.map((participant) => ({
            playerId: participant.player_id,
            tokens: participant.effective_tokens,
            damage: participant.player_id === row.player_id
              ? withoutPotionDamage
              : participant.damage_total,
            potionBonusDamage: participant.player_id === row.player_id
              ? Math.max(0, participant.potion_bonus_damage - link.bonus_damage)
              : participant.potion_bonus_damage,
          })),
          goldPool,
          {
            workPct: configValues[0]!,
            damagePct: configValues[1]!,
            podiumPct: [configValues[2]!, configValues[3]!, configValues[4]!],
          },
        ).find((participant) => participant.playerId === row.player_id);
        if (!counterfactual) continue;
        const movement = podiumMovement(
          actual.damage_rank,
          counterfactual.damageRank,
        );
        bonusDamage += link.bonus_damage;
        actualDamage += actual.damage_total;
        counterfactualDamage += withoutPotionDamage;
        actualReward += actual.total_gold;
        counterfactualReward += counterfactual.totalGold;
        actualRanks.push(actual.damage_rank);
        counterfactualRanks.push(counterfactual.damageRank);
        podiumEntries += movement.podiumEntries;
        podiumClimbs += movement.podiumClimbs;
        encounterOutcomes.push({
          encounterId: link.encounter_id,
          actualDamage: actual.damage_total,
          counterfactualDamage: withoutPotionDamage,
          bonusDamage: link.bonus_damage,
          actualRank: actual.damage_rank,
          counterfactualRank: counterfactual.damageRank,
          actualReward: actual.total_gold,
          counterfactualReward: counterfactual.totalGold,
          podiumEntry: movement.podiumEntries === 1,
          podiumClimb: movement.podiumClimbs,
          rewardSplit: configValues.map((value) => String(value)).join('/'),
        });
      }
      const incrementalReward = actualReward - counterfactualReward;
      const elapsedEnd = row.status === 'completed'
        ? row.expires_game_ms
        : Math.min(currentGameMs, row.expires_game_ms);
      return {
        activationId: row.id,
        playerId: row.player_id,
        purchasedAt: row.purchased_at,
        activatedAt: row.activated_at,
        completedAt: row.completed_at,
        startGameMs: row.start_game_ms,
        expiresGameMs: row.expires_game_ms,
        wallElapsedMs: Math.max(
          0,
          (row.completed_at ?? now) - row.activated_at,
        ),
        activeElapsedMs: Math.max(0, elapsedEnd - row.start_game_ms),
        actualDamage,
        counterfactualDamage,
        bonusDamage,
        actualRank: actualRanks.length > 0 ? Math.min(...actualRanks) : 0,
        counterfactualRank: counterfactualRanks.length > 0
          ? Math.min(...counterfactualRanks)
          : 0,
        actualReward,
        counterfactualReward,
        podiumEntries,
        podiumClimbs,
        purchasePrice: row.purchase_unit_price,
        netGold: incrementalReward - row.purchase_unit_price,
        encounters: encounterOutcomes,
      };
    });

  const ledgerFilter = selectedRowFilter(filters, {
    timestamp: 'ledger.created_at',
    player: 'ledger.player_id',
  });
  const economyParams: Array<number | string> = [];
  const spentSkuPredicate = filters.sku === undefined
    ? ''
    : 'AND purchase.sku = ?';
  if (filters.sku !== undefined) economyParams.push(filters.sku);
  const mintedSkuPredicate = filters.sku === undefined
    ? ''
    : `AND (
         ledger.source_table IS NOT 'potion_work_events'
         OR activation.sku = ?
       )`;
  if (filters.sku !== undefined) economyParams.push(filters.sku);
  economyParams.push(...ledgerFilter.params);
  const economyTotals = db.prepare(
    `SELECT
       COALESCE(SUM(CASE
         WHEN ledger.reason='shop_purchase'
          AND ledger.source_table='shop_purchases'
          AND purchase.sku IN ('potion_gold_t1','potion_damage_t1')
          ${spentSkuPredicate}
         THEN ledger.amount ELSE 0 END
       ), 0) AS potion_spent,
       COALESCE(SUM(CASE
         WHEN ledger.reason IN ('gold_potion_base','gold_potion_stretch')
          ${mintedSkuPredicate}
         THEN ledger.amount ELSE 0 END
       ), 0) AS potion_minted,
       COALESCE(SUM(CASE
         WHEN ledger.reason='encounter_reward' THEN ledger.amount ELSE 0 END
       ), 0) AS encounter_awarded,
       COALESCE(SUM(CASE
         WHEN ledger.reason='monster_steal' THEN ledger.amount ELSE 0 END
       ), 0) AS monster_stolen,
       COALESCE(SUM(CASE
         WHEN ledger.amount > 0 THEN ledger.amount ELSE 0 END
       ), 0) AS ledger_inflow,
       COALESCE(SUM(CASE
         WHEN ledger.amount < 0 THEN ledger.amount ELSE 0 END
       ), 0) AS ledger_outflow
     FROM gold_ledger AS ledger
     LEFT JOIN shop_purchases AS purchase
       ON ledger.reason='shop_purchase'
      AND ledger.source_table='shop_purchases'
      AND purchase.id=CAST(ledger.source_id AS INTEGER)
     LEFT JOIN potion_work_events AS work
       ON ledger.reason IN ('gold_potion_base','gold_potion_stretch')
      AND ledger.source_table='potion_work_events'
      AND work.id=CAST(ledger.source_id AS INTEGER)
     LEFT JOIN potion_activations AS activation
       ON activation.id=work.activation_id
     ${ledgerFilter.sql}`,
  ).get(...economyParams) as {
    potion_spent: number;
    potion_minted: number;
    encounter_awarded: number;
    monster_stolen: number;
    ledger_inflow: number;
    ledger_outflow: number;
  };

  const distinctCombatDays = (db.prepare(
    'SELECT COUNT(*) AS count FROM game_clock_days WHERE active_ms > 0',
  ).get() as { count: number }).count;
  const readinessTotals = db.prepare(
    `SELECT
       COALESCE(SUM(CASE
         WHEN status='completed' AND potion_type='gold' THEN 1 ELSE 0 END
       ), 0) AS completed_gold,
       COALESCE(SUM(CASE
         WHEN status='completed' AND potion_type='damage' THEN 1 ELSE 0 END
       ), 0) AS completed_damage,
       COUNT(DISTINCT CASE
         WHEN status='completed' THEN player_id
       END) AS distinct_players
     FROM potion_activations`,
  ).get() as {
    completed_gold: number;
    completed_damage: number;
    distinct_players: number;
  };
  const completedGold = readinessTotals.completed_gold;
  const completedDamage = readinessTotals.completed_damage;
  const distinctPlayers = readinessTotals.distinct_players;
  const enoughCombatDays = distinctCombatDays >= 14;
  const enoughGoldActivations = completedGold >= 30;
  const enoughDamageActivations = completedDamage >= 30;
  const enoughPlayers = distinctPlayers >= 5;
  const completedGoldActivations = goldActivations.filter(
    (row) => row.completedAt !== null,
  );
  const breakEvenCount = completedGoldActivations.filter(
    (row) => row.netGold >= 0,
  ).length;
  const stretchCount = completedGoldActivations.filter(
    (row) => row.stretchPayout > 0,
  ).length;
  const completedGoldCount = completedGoldActivations.length;

  return {
    gold: {
      purchases: purchaseStats.gold_purchases,
      completed: activationRows.filter((row) => (
        row.potion_type === 'gold' && row.status === 'completed'
      )).length,
      spent: purchaseStats.gold_spent,
      basePayout: activationRows.filter((row) => row.potion_type === 'gold')
        .reduce((sum, row) => sum + goldAudit(row).base_gold, 0),
      stretchPayout: activationRows.filter((row) => row.potion_type === 'gold')
        .reduce((sum, row) => sum + goldAudit(row).stretch_gold, 0),
      breakEvenCount,
      stretchCount,
      breakEvenRate: completedGoldCount === 0
        ? 0
        : breakEvenCount / completedGoldCount,
      stretchRate: completedGoldCount === 0
        ? 0
        : stretchCount / completedGoldCount,
      byPlayer,
      byOfficeHour,
      activations: goldActivations,
    },
    damage: { activations: damageActivations },
    economy: {
      potionGoldSpent: Math.abs(economyTotals.potion_spent),
      goldPotionMinted: economyTotals.potion_minted,
      encounterGoldAwarded: economyTotals.encounter_awarded,
      monsterGoldStolen: Math.abs(economyTotals.monster_stolen),
      ledgerInflow: economyTotals.ledger_inflow,
      ledgerOutflow: Math.abs(economyTotals.ledger_outflow),
      ledgerReconciled: ledgerReconciles(db),
      stockPurchased: purchaseStats.stock_purchased,
      dosesUsed: activationRows.length,
    },
    readiness: {
      distinctCombatDays,
      completedGold,
      completedDamage,
      distinctPlayers,
      enoughCombatDays,
      enoughGoldActivations,
      enoughDamageActivations,
      enoughPlayers,
      readyForTier2Review: enoughCombatDays
        && enoughGoldActivations
        && enoughDamageActivations
        && enoughPlayers,
    },
  };
}

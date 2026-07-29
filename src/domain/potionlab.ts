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
    byPlayer: { playerId: number; activations: number; medianNetGold: number }[];
    byOfficeHour: { hour: number; activations: number; medianNetGold: number }[];
    activations: {
      activationId: number;
      playerId: number;
      purchasedAt: number;
      activatedAt: number;
      completedAt: number | null;
      activeElapsedMs: number;
      eligibleTokens: number;
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
      bonusDamage: number;
      actualRank: number;
      counterfactualRank: number;
      actualReward: number;
      counterfactualReward: number;
      podiumClimbs: number;
      purchasePrice: number;
      netGold: number;
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

type PurchaseRow = {
  id: number;
  player_id: number;
  sku: LaunchPotionSku;
  quantity: number;
  total_price: number;
  created_at: number;
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

type LedgerRow = {
  id: number;
  player_id: number;
  amount: number;
  balance_after: number;
  reason: string;
  source_table: string | null;
  source_id: string | null;
  created_at: number;
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

function inRange(value: number, filters: PotionLabFilters): boolean {
  return (filters.from === undefined || value >= filters.from)
    && (filters.to === undefined || value <= filters.to);
}

function matchesPlayer(playerId: number, filters: PotionLabFilters): boolean {
  return filters.playerId === undefined || filters.playerId === playerId;
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

function reconcilesLedger(
  players: { id: number; gold: number }[],
  ledger: LedgerRow[],
): boolean {
  const byPlayer = new Map<number, LedgerRow[]>();
  for (const row of ledger) {
    byPlayer.set(row.player_id, [...(byPlayer.get(row.player_id) ?? []), row]);
  }
  return players.every((player) => {
    const rows = (byPlayer.get(player.id) ?? []).sort((a, b) => a.id - b.id);
    const signedTotal = rows.reduce((sum, row) => sum + row.amount, 0);
    const latest = rows.at(-1);
    return signedTotal === player.gold
      && (latest ? latest.balance_after === player.gold : player.gold === 0);
  });
}

export function buildPotionLabReport(
  db: Database.Database,
  filters: PotionLabFilters,
): PotionLabReport {
  validateFilters(filters);
  const officeHour = new Intl.DateTimeFormat('en-US', {
    timeZone: filters.timeZone ?? 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const currentGameMs = (db.prepare(
    'SELECT combat_active_ms FROM game_state WHERE id=1',
  ).get() as { combat_active_ms: number }).combat_active_ms;
  const activations = db.prepare(
    `SELECT pa.id, pa.player_id, pa.sku, pa.potion_type,
            pa.purchase_unit_price, pa.activated_at, pa.start_game_ms,
            pa.expires_game_ms, pa.status, pa.completed_at,
            pa.eligible_tokens, pa.base_gold, pa.stretch_gold,
            sp.created_at AS purchased_at
     FROM potion_activations pa
     JOIN shop_purchases sp ON sp.id=pa.purchase_id
     ORDER BY pa.activated_at, pa.id`,
  ).all() as ActivationRow[];
  const purchases = db.prepare(
    `SELECT id, player_id, sku, quantity, total_price, created_at
     FROM shop_purchases
     WHERE sku IN ('potion_gold_t1','potion_damage_t1')
     ORDER BY created_at, id`,
  ).all() as PurchaseRow[];
  const activationRows = activations.filter((row) => (
    inRange(row.activated_at, filters)
    && matchesPlayer(row.player_id, filters)
    && (filters.sku === undefined || filters.sku === row.sku)
  ));
  const purchaseRows = purchases.filter((row) => (
    inRange(row.created_at, filters)
    && matchesPlayer(row.player_id, filters)
    && (filters.sku === undefined || filters.sku === row.sku)
  ));

  const workTotals = new Map((db.prepare(
    `SELECT activation_id,
            SUM(effective_delta) AS eligible_tokens,
            SUM(base_gold) AS base_gold,
            SUM(stretch_gold) AS stretch_gold
     FROM potion_work_events
     GROUP BY activation_id`,
  ).all() as Array<{
    activation_id: number;
    eligible_tokens: number;
    base_gold: number;
    stretch_gold: number;
  }>).map((row) => [row.activation_id, row]));
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
        activeElapsedMs: Math.max(0, elapsedEnd - row.start_game_ms),
        eligibleTokens: audit.eligible_tokens,
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

  const links = db.prepare(
    `SELECT activation_id, encounter_id, bonus_damage
     FROM potion_activation_encounters
     ORDER BY activation_id, encounter_id`,
  ).all() as EncounterLink[];
  const linksByActivation = new Map<number, EncounterLink[]>();
  for (const link of links) {
    linksByActivation.set(link.activation_id, [
      ...(linksByActivation.get(link.activation_id) ?? []),
      link,
    ]);
  }
  const awards = db.prepare(
    `SELECT encounter_id, player_id, effective_tokens, damage_total,
            potion_bonus_damage, damage_rank, total_gold
     FROM encounter_reward_awards
     ORDER BY encounter_id, player_id`,
  ).all() as AwardRow[];
  const awardsByEncounter = new Map<number, AwardRow[]>();
  for (const award of awards) {
    awardsByEncounter.set(award.encounter_id, [
      ...(awardsByEncounter.get(award.encounter_id) ?? []),
      award,
    ]);
  }
  const encounters = new Map((db.prepare(
    `SELECT id, reward_model_version, reward_work_pct, reward_damage_pct,
            reward_podium_first_pct, reward_podium_second_pct,
            reward_podium_third_pct
     FROM encounters`,
  ).all() as EncounterRow[]).map((row) => [row.id, row]));

  const damageActivations = activationRows
    .filter((row) => row.potion_type === 'damage')
    .map((row): PotionLabReport['damage']['activations'][number] => {
      let bonusDamage = 0;
      let actualReward = 0;
      let counterfactualReward = 0;
      let podiumClimbs = 0;
      const actualRanks: number[] = [];
      const counterfactualRanks: number[] = [];
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
        const counterfactual = allocateEncounterGold(
          participants.map((participant) => ({
            playerId: participant.player_id,
            tokens: participant.effective_tokens,
            damage: participant.player_id === row.player_id
              ? Math.max(0, participant.damage_total - link.bonus_damage)
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
        bonusDamage += link.bonus_damage;
        actualReward += actual.total_gold;
        counterfactualReward += counterfactual.totalGold;
        actualRanks.push(actual.damage_rank);
        counterfactualRanks.push(counterfactual.damageRank);
        podiumClimbs += Math.max(0, counterfactual.damageRank - actual.damage_rank);
      }
      const incrementalReward = actualReward - counterfactualReward;
      return {
        activationId: row.id,
        playerId: row.player_id,
        purchasedAt: row.purchased_at,
        bonusDamage,
        actualRank: actualRanks.length > 0 ? Math.min(...actualRanks) : 0,
        counterfactualRank: counterfactualRanks.length > 0
          ? Math.min(...counterfactualRanks)
          : 0,
        actualReward,
        counterfactualReward,
        podiumClimbs,
        purchasePrice: row.purchase_unit_price,
        netGold: incrementalReward - row.purchase_unit_price,
      };
    });

  const ledger = db.prepare(
    `SELECT id, player_id, amount, balance_after, reason,
            source_table, source_id, created_at
     FROM gold_ledger ORDER BY id`,
  ).all() as LedgerRow[];
  const ledgerScope = ledger.filter((row) => (
    inRange(row.created_at, filters) && matchesPlayer(row.player_id, filters)
  ));
  const purchaseById = new Map(purchases.map((row) => [row.id, row]));
  const workActivationById = new Map((db.prepare(
    `SELECT pwe.id, pa.sku
     FROM potion_work_events pwe
     JOIN potion_activations pa ON pa.id=pwe.activation_id`,
  ).all() as { id: number; sku: LaunchPotionSku }[]).map((row) => [row.id, row.sku]));
  const skuMatchesLedgerSource = (row: LedgerRow): boolean => {
    if (filters.sku === undefined) return true;
    if (row.reason === 'shop_purchase' && row.source_table === 'shop_purchases') {
      return purchaseById.get(Number(row.source_id))?.sku === filters.sku;
    }
    if (
      (row.reason === 'gold_potion_base' || row.reason === 'gold_potion_stretch')
      && row.source_table === 'potion_work_events'
    ) {
      return workActivationById.get(Number(row.source_id)) === filters.sku;
    }
    return true;
  };
  const potionSpent = ledgerScope.filter((row) => (
    row.reason === 'shop_purchase'
    && row.source_table === 'shop_purchases'
    && ['potion_gold_t1', 'potion_damage_t1'].includes(
      purchaseById.get(Number(row.source_id))?.sku ?? '',
    )
    && skuMatchesLedgerSource(row)
  ));
  const potionMinted = ledgerScope.filter((row) => (
    (row.reason === 'gold_potion_base' || row.reason === 'gold_potion_stretch')
    && skuMatchesLedgerSource(row)
  ));
  const players = db.prepare('SELECT id, gold FROM players ORDER BY id')
    .all() as { id: number; gold: number }[];

  const completedGlobal = activations.filter((row) => row.status === 'completed');
  const distinctCombatDays = (db.prepare(
    'SELECT COUNT(*) AS count FROM game_clock_days WHERE active_ms > 0',
  ).get() as { count: number }).count;
  const completedGold = completedGlobal.filter((row) => row.potion_type === 'gold').length;
  const completedDamage = completedGlobal.filter((row) => row.potion_type === 'damage').length;
  const distinctPlayers = new Set(completedGlobal.map((row) => row.player_id)).size;
  const enoughCombatDays = distinctCombatDays >= 14;
  const enoughGoldActivations = completedGold >= 30;
  const enoughDamageActivations = completedDamage >= 30;
  const enoughPlayers = distinctPlayers >= 5;

  return {
    gold: {
      purchases: purchaseRows.filter((row) => row.sku === 'potion_gold_t1').length,
      completed: activationRows.filter((row) => (
        row.potion_type === 'gold' && row.status === 'completed'
      )).length,
      spent: purchaseRows.filter((row) => row.sku === 'potion_gold_t1')
        .reduce((sum, row) => sum + row.total_price, 0),
      basePayout: activationRows.filter((row) => row.potion_type === 'gold')
        .reduce((sum, row) => sum + goldAudit(row).base_gold, 0),
      stretchPayout: activationRows.filter((row) => row.potion_type === 'gold')
        .reduce((sum, row) => sum + goldAudit(row).stretch_gold, 0),
      breakEvenCount: goldActivations.filter((row) => row.netGold >= 0).length,
      stretchCount: activationRows.filter((row) => (
        row.potion_type === 'gold' && goldAudit(row).stretch_gold > 0
      )).length,
      byPlayer,
      byOfficeHour,
      activations: goldActivations,
    },
    damage: { activations: damageActivations },
    economy: {
      potionGoldSpent: Math.abs(potionSpent.reduce((sum, row) => sum + row.amount, 0)),
      goldPotionMinted: potionMinted.reduce((sum, row) => sum + row.amount, 0),
      encounterGoldAwarded: ledgerScope.filter((row) => row.reason === 'encounter_reward')
        .reduce((sum, row) => sum + row.amount, 0),
      monsterGoldStolen: Math.abs(ledgerScope.filter((row) => row.reason === 'monster_steal')
        .reduce((sum, row) => sum + row.amount, 0)),
      ledgerInflow: ledgerScope.filter((row) => row.amount > 0)
        .reduce((sum, row) => sum + row.amount, 0),
      ledgerOutflow: Math.abs(ledgerScope.filter((row) => row.amount < 0)
        .reduce((sum, row) => sum + row.amount, 0)),
      ledgerReconciled: reconcilesLedger(players, ledger),
      stockPurchased: purchaseRows.reduce((sum, row) => sum + row.quantity, 0),
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

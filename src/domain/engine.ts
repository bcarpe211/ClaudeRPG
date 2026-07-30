import type Database from 'better-sqlite3';
import {
  loadEngineConfig,
  advanceToNextEncounter,
  encounterRewardGoldPool,
  type EngineConfig,
} from './encounters';
import { isIdle, lastActivityAt, setPaused, getGameState } from './gamestate';
import { levelForXp } from './leveling';
import { tokenModifier, attackDamage } from './combat';
import { activityScore } from './activity';
import { allocateEncounterGold, splitGold, type RewardAllocation } from './rewards';
import { getAllSettings } from './settings';
import { pickTarget, rollConsequence, goldSteal, debuffFactor } from './retaliation';
import { applyGoldMutation } from './goldledger';
import { advanceCombatClock, isCombatAcceptingWork } from './gameclock';
import { officeDayKey } from './office-time';
import { completeExpiredPotions, damagePotionMultiplier } from './potions';

export interface DefeatParticipant {
  playerId: number;
  name: string;
  damage: number;
  hits: number;
  maxHit: number;
  gold: number;
  tokensDuringFight: number;
  leveledTo: number | null;
}

export interface DefeatSummary {
  encounterId: number;
  creatureIndex: number;
  kind: string;
  footprint: number;
  maxHp: number;
  totalDamage: number;
  durationMs: number;
  mvpPlayerId: number | null;
  biggestStrike: { playerId: number; amount: number } | null;
  participants: DefeatParticipant[];
}

interface EncounterParticipantRow {
  player_id: number;
  damage_total: number;
  hits: number;
  max_hit: number;
  potion_bonus_damage: number;
  effective_tokens: number;
}

function encounterParticipants(
  db: Database.Database,
  encounterId: number,
  startedAt: number,
  endedAt: number,
  rewardModelVersion: string,
): EncounterParticipantRow[] {
  return db.prepare(
    `SELECT participant.player_id,
            COALESCE(damage.damage_total, 0) AS damage_total,
            COALESCE(damage.hits, 0) AS hits,
            COALESCE(damage.max_hit, 0) AS max_hit,
            COALESCE(damage.potion_bonus_damage, 0) AS potion_bonus_damage,
            COALESCE((
              SELECT SUM(event.effective_delta)
              FROM token_events AS event
              WHERE event.player_id = participant.player_id
                AND event.ts >= ?
                AND event.ts <= ?
            ), 0) AS effective_tokens
     FROM (
       SELECT player_id
       FROM encounter_damage
       WHERE encounter_id = ?
       UNION
       SELECT player_id
       FROM token_events
       WHERE ? != 'legacy-v0' AND ts >= ? AND ts <= ?
     ) AS participant
     LEFT JOIN encounter_damage AS damage
       ON damage.encounter_id = ?
      AND damage.player_id = participant.player_id
     ORDER BY damage_total DESC, effective_tokens DESC, participant.player_id ASC`,
  ).all(
    startedAt,
    endedAt,
    encounterId,
    rewardModelVersion,
    startedAt,
    endedAt,
    encounterId,
  ) as EncounterParticipantRow[];
}

export function buildDefeatSummary(
  db: Database.Database,
  encounterId: number,
): DefeatSummary {
  const enc = db.prepare('SELECT * FROM encounters WHERE id=?').get(encounterId) as any;
  const start = enc.started_at;
  const end = enc.ended_at ?? start;
  const dmgRows = encounterParticipants(db, encounterId, start, end, enc.reward_model_version);
  const totalDamage = dmgRows.reduce((s, r) => s + r.damage_total, 0);

  const storedAwards = enc.reward_model_version === 'legacy-v0'
    ? []
    : db.prepare(
      'SELECT player_id, effective_tokens, total_gold FROM encounter_reward_awards WHERE encounter_id=?',
    ).all(encounterId) as { player_id: number; effective_tokens: number; total_gold: number }[];
  const storedByPlayer = new Map(storedAwards.map((award) => [award.player_id, award]));

  const tokensByPlayer = new Map<number, number>();
  const rowMeta = dmgRows.map((r) => {
    const player = db.prepare('SELECT name FROM players WHERE id=?').get(r.player_id) as any;
    const lvl = db.prepare(
      'SELECT MAX(new_level) AS m FROM level_ups WHERE player_id=? AND ts>=? AND ts<=?',
    ).get(r.player_id, start, end) as any;
    const tokens = storedByPlayer.get(r.player_id)?.effective_tokens ?? r.effective_tokens;
    tokensByPlayer.set(r.player_id, tokens);
    return { r, player, tokens, leveledTo: lvl.m ?? null };
  });
  let goldByPlayer: Map<number, number>;
  if (enc.reward_model_version === 'legacy-v0') {
    const settings = getAllSettings(db);
    const goldFactor = settings['gold_factor'] !== undefined ? Number(settings['gold_factor']) : 0.01;
    const goldDamageWeight = settings['gold_damage_weight'] !== undefined
      ? Number(settings['gold_damage_weight'])
      : 0;
    const dungeon = db.prepare('SELECT * FROM dungeons WHERE id=?').get(enc.dungeon_id) as any;
    const goldPool = encounterRewardGoldPool(enc.max_hp, dungeon.level, goldFactor);
    goldByPlayer = splitGold(
      dmgRows.map((r) => ({
        playerId: r.player_id,
        damage: r.damage_total,
        tokens: tokensByPlayer.get(r.player_id) ?? 0,
      })),
      goldPool,
      goldDamageWeight,
    );
  } else {
    goldByPlayer = new Map(storedAwards.map((award) => [award.player_id, award.total_gold]));
  }

  const participants: DefeatParticipant[] = rowMeta.map(({ r, player, tokens, leveledTo }) => ({
    playerId: r.player_id,
    name: player?.name ?? `#${r.player_id}`,
    damage: r.damage_total,
    hits: r.hits,
    maxHit: r.max_hit,
    gold: goldByPlayer.get(r.player_id) ?? 0,
    tokensDuringFight: tokens,
    leveledTo,
  }));

  let mvpPlayerId: number | null = null;
  let biggest: { playerId: number; amount: number } | null = null;
  for (const r of dmgRows) {
    if (mvpPlayerId === null && r.damage_total > 0) mvpPlayerId = r.player_id;
    if (r.max_hit > 0 && (!biggest || r.max_hit > biggest.amount)) {
      biggest = { playerId: r.player_id, amount: r.max_hit };
    }
  }

  return {
    encounterId,
    creatureIndex: enc.creature_index,
    kind: enc.kind,
    footprint: enc.footprint,
    maxHp: enc.max_hp,
    totalDamage,
    durationMs: end - start,
    mvpPlayerId,
    biggestStrike: biggest,
    participants,
  };
}

export interface EngineDeps {
  rng?: () => number;
  officeTimeZone?: string;
}

interface ActivePlayer {
  id: number;
  level: number;
  effective_tokens: number;
}

export class GameEngine {
  private rng: () => number;
  private nextAttackAt = new Map<number, number>();
  private nextMonsterAttackAt = 0; // 0 = unscheduled (armed on the next active tick)
  private wasPaused = true;
  private officeTimeZone: string;
  private previousTickAt: number | null = null;
  private previousClockRunning = false;
  private previousIdleDeadline: number | null = null;

  constructor(private db: Database.Database, deps: EngineDeps = {}) {
    this.rng = deps.rng ?? Math.random;
    this.officeTimeZone = deps.officeTimeZone ?? 'America/New_York';
  }

  private scheduleNext(now: number, cfg: EngineConfig): number {
    const jitter = (this.rng() * 2 - 1) * cfg.attackJitterMs;
    return now + cfg.attackIntervalMs + jitter;
  }

  private activePlayers(): ActivePlayer[] {
    return this.db.prepare(
      'SELECT id, level, effective_tokens FROM players WHERE disabled = 0',
    ).all() as ActivePlayer[];
  }

  private updateLevel(p: ActivePlayer, cfg: EngineConfig, now: number): void {
    const newLevel = levelForXp(p.effective_tokens, cfg.baseXp, cfg.xpGrowth);
    if (newLevel > p.level) {
      this.db.prepare('UPDATE players SET level=? WHERE id=?').run(newLevel, p.id);
      this.db.prepare(
        'INSERT INTO level_ups (player_id, new_level, ts) VALUES (?, ?, ?)',
      ).run(p.id, newLevel, now);
      p.level = newLevel;
    }
  }

  private applyHit(
    encId: number,
    playerId: number,
    damage: number,
    potionBonus: number,
    activationId: number | null,
    now: number,
  ): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE encounters SET current_hp = MAX(0, current_hp - ?) WHERE id=?')
        .run(damage, encId);
      this.db.prepare(
        `INSERT INTO encounter_damage
          (encounter_id, player_id, damage_total, hits, max_hit, potion_bonus_damage)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(encounter_id, player_id) DO UPDATE SET
           damage_total = damage_total + excluded.damage_total,
           hits = hits + 1,
           max_hit = MAX(max_hit, excluded.max_hit),
           potion_bonus_damage = potion_bonus_damage + excluded.potion_bonus_damage`,
      ).run(encId, playerId, damage, damage, potionBonus);
      if (activationId !== null) {
        this.db.prepare(
          `UPDATE potion_activations
           SET potion_bonus_damage = potion_bonus_damage + ?
           WHERE id = ?`,
        ).run(potionBonus, activationId);
        this.db.prepare(
          `INSERT INTO potion_activation_encounters
            (activation_id, encounter_id, bonus_damage)
           VALUES (?, ?, ?)
           ON CONFLICT(activation_id, encounter_id) DO UPDATE SET
             bonus_damage = bonus_damage + excluded.bonus_damage`,
        ).run(activationId, encId, potionBonus);
      }
      this.db.prepare(
        `INSERT INTO player_daily_combat
          (player_id, office_day, damage, potion_bonus_damage)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(player_id, office_day) DO UPDATE SET
           damage = damage + excluded.damage,
           potion_bonus_damage = potion_bonus_damage + excluded.potion_bonus_damage`,
      ).run(
        playerId,
        officeDayKey(now, this.officeTimeZone),
        damage,
        potionBonus,
      );
    })();
  }

  private resolveKillIfDead(encId: number, now: number, cfg: EngineConfig): void {
    const enc = this.db.prepare('SELECT * FROM encounters WHERE id=?').get(encId) as any;
    if (!enc || enc.status !== 'active' || enc.current_hp > 0) return;

    const dungeon = this.db.prepare('SELECT * FROM dungeons WHERE id=?').get(enc.dungeon_id) as any;
    const rows = encounterParticipants(
      this.db,
      encId,
      enc.started_at,
      now,
      enc.reward_model_version,
    );
    const participants = rows.map((r) => ({
      playerId: r.player_id,
      damage: r.damage_total,
      tokens: r.effective_tokens,
      potionBonusDamage: r.potion_bonus_damage,
    }));
    const isLegacy = enc.reward_model_version === 'legacy-v0';
    const goldPool = isLegacy
      ? encounterRewardGoldPool(enc.max_hp, dungeon.level, cfg.goldFactor)
      : enc.reward_gold_pool;
    if (!Number.isSafeInteger(goldPool) || goldPool < 0) {
      throw new Error(`invalid snapshotted reward pool for encounter ${encId}`);
    }
    let hybridAwards: RewardAllocation[] = [];
    let legacyGold = new Map<number, number>();
    if (isLegacy) {
      legacyGold = splitGold(participants, goldPool, cfg.goldDamageWeight);
    } else if (enc.reward_model_version === 'hybrid-v1') {
      hybridAwards = allocateEncounterGold(participants, goldPool, {
        workPct: enc.reward_work_pct,
        damagePct: enc.reward_damage_pct,
        podiumPct: [
          enc.reward_podium_first_pct,
          enc.reward_podium_second_pct,
          enc.reward_podium_third_pct,
        ],
      });
    } else {
      throw new Error(`unsupported encounter reward model: ${enc.reward_model_version}`);
    }
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE encounters SET status='defeated', ended_at=? WHERE id=?")
        .run(now, encId);
      if (isLegacy) {
        for (const [playerId, gold] of legacyGold) {
          if (gold <= 0) continue;
          applyGoldMutation(this.db, {
            playerId,
            amount: gold,
            reason: 'encounter_reward',
            sourceTable: 'encounters',
            sourceId: String(encId),
            now,
          });
        }
      } else {
        const insertAward = this.db.prepare(
          `INSERT INTO encounter_reward_awards
           (encounter_id, player_id, effective_tokens, damage_total,
            potion_bonus_damage, damage_rank, work_gold, damage_gold,
            podium_gold, total_gold, model_version, awarded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hybrid-v1', ?)`,
        );
        for (const award of hybridAwards) {
          insertAward.run(
            encId,
            award.playerId,
            award.tokens,
            award.damage,
            award.potionBonusDamage,
            award.damageRank,
            award.workGold,
            award.damageGold,
            award.podiumGold,
            award.totalGold,
            now,
          );
          applyGoldMutation(this.db, {
            playerId: award.playerId,
            amount: award.totalGold,
            reason: 'encounter_reward',
            sourceTable: 'encounter_reward_awards',
            sourceId: String(encId),
            now,
          });
        }
      }
      this.db.prepare(
        'UPDATE game_state SET defeat_until=?, last_defeat_encounter_id=?, current_encounter_id=NULL WHERE id=1',
      ).run(now + cfg.popupDurationS * 1000, encId);
    });
    tx();
    this.wasPaused = true;
  }

  private recordClockRunningState(now: number, pauseAfterMinutes: number): void {
    this.previousClockRunning = isCombatAcceptingWork(
      this.db,
      now,
      pauseAfterMinutes,
    );
    this.previousIdleDeadline = this.previousClockRunning
      ? lastActivityAt(this.db) + pauseAfterMinutes * 60_000
      : null;
  }

  /** Advance the game by one tick. `now` is epoch ms. */
  tick(now: number): void {
    const cfg = loadEngineConfig(this.db);
    try {
      if (
        this.previousTickAt !== null
        && this.previousClockRunning
        && now >= this.previousTickAt
      ) {
        const intervalStart = this.previousTickAt;
        const pauseWindowMs = cfg.pauseAfterMinutes * 60_000;
        const currentActivityAt = lastActivityAt(this.db);
        const candidates = [
          {
            start: intervalStart,
            end: Math.min(now, this.previousIdleDeadline ?? intervalStart),
          },
          {
            start: Math.max(intervalStart, currentActivityAt),
            end: Math.min(now, currentActivityAt + pauseWindowMs),
          },
        ].filter((segment) => segment.end > segment.start)
          .sort((a, b) => a.start - b.start);

        const activeSegments: Array<{ start: number; end: number }> = [];
        for (const segment of candidates) {
          const previous = activeSegments.at(-1);
          if (previous && segment.start <= previous.end) {
            previous.end = Math.max(previous.end, segment.end);
          } else {
            activeSegments.push({ ...segment });
          }
        }

        for (const segment of activeSegments) {
          advanceCombatClock(
            this.db,
            segment.end - segment.start,
            segment.end,
            this.officeTimeZone,
          );
        }
      }
      this.previousTickAt = now;
      completeExpiredPotions(this.db, now);

      const idle = isIdle(this.db, now, cfg.pauseAfterMinutes);

      if (idle) {
        setPaused(this.db, true, now);
        this.wasPaused = true;
        return;
      }

      // Active. Unpause; re-stagger attack timers on the paused->active transition.
      setPaused(this.db, false, now);
      if (this.wasPaused) {
        this.nextAttackAt.clear();
        this.nextMonsterAttackAt = 0;
        this.wasPaused = false;
      }

      let gs = getGameState(this.db);
      // Respect the defeat-popup window before spawning the next encounter.
      if (gs.defeat_until && now < gs.defeat_until) return;

      const hasActive = gs.current_encounter_id &&
        (this.db.prepare("SELECT status FROM encounters WHERE id=?")
          .get(gs.current_encounter_id) as any)?.status === 'active';
      if (!hasActive) {
        advanceToNextEncounter(this.db, now, cfg, this.rng);
        gs = getGameState(this.db);
      }

      const encId = gs.current_encounter_id!;

      for (const p of this.activePlayers()) {
        this.updateLevel(p, cfg, now);
        const next = this.nextAttackAt.get(p.id) ?? this.scheduleNext(now, cfg);
        if (now >= next) {
          const score = activityScore(this.db, p.id, now, cfg);
          const am = tokenModifier(score, cfg.tokenModifierK, cfg.modifierCap); // player's own activity modifier (capped)
          const mod = am * debuffFactor(this.db, p.id, now, cfg);
          const damagePotion = damagePotionMultiplier(this.db, p.id);
          const baseline = attackDamage(
            cfg.baseHit,
            p.level,
            cfg.levelCurveSlope,
            mod,
          );
          const damage = attackDamage(
            cfg.baseHit * (damagePotion?.multiplier ?? 1),
            p.level,
            cfg.levelCurveSlope,
            mod,
          );
          const potionBonus = Math.max(0, damage - baseline);
          this.applyHit(
            encId,
            p.id,
            damage,
            potionBonus,
            damagePotion?.activationId ?? null,
            now,
          );
          this.db.prepare('UPDATE players SET peak_modifier=? WHERE id=? AND peak_modifier < ?').run(am, p.id, am);
          this.nextAttackAt.set(p.id, this.scheduleNext(now, cfg));
        } else {
          this.nextAttackAt.set(p.id, next);
        }
      }
      this.maybeMonsterAttack(encId, now, cfg);
      this.resolveKillIfDead(encId, now, cfg);
    } finally {
      this.recordClockRunningState(now, cfg.pauseAfterMinutes);
    }
  }

  private scheduleMonsterAttack(now: number, cfg: EngineConfig): number {
    const jitter = (this.rng() * 2 - 1) * cfg.monsterAttackJitterMs;
    return now + cfg.monsterAttackIntervalMs + jitter;
  }

  private maybeMonsterAttack(encId: number, now: number, cfg: EngineConfig): void {
    if (cfg.monsterAttacksEnabled <= 0) return;
    if (this.nextMonsterAttackAt === 0) {
      this.nextMonsterAttackAt = this.scheduleMonsterAttack(now, cfg); // arm; don't strike yet
      return;
    }
    if (now < this.nextMonsterAttackAt) return;
    this.nextMonsterAttackAt = this.scheduleMonsterAttack(now, cfg);

    const target = pickTarget(this.activePlayers(), this.rng);
    if (!target) return;

    let kind = rollConsequence(this.rng);
    let amount = 0;
    if (kind === 'gold') {
      const cur = (this.db.prepare('SELECT gold FROM players WHERE id=?').get(target.id) as { gold: number }).gold;
      amount = goldSteal(cur, cfg.monsterGoldStealPct);
      if (amount <= 0) kind = 'debuff'; // broke -> debuff so a hit always lands
    }

    this.db.transaction(() => {
      const attack = this.db.prepare(
        'INSERT INTO monster_attacks (encounter_id, player_id, kind, gold_delta, ts) VALUES (?, ?, ?, ?, ?)',
      ).run(encId, target.id, kind, amount, now);
      if (kind === 'gold' && amount > 0) {
        applyGoldMutation(this.db, {
          playerId: target.id,
          amount: -amount,
          reason: 'monster_steal',
          sourceTable: 'monster_attacks',
          sourceId: String(attack.lastInsertRowid),
          now,
        });
      }
    })();
  }
}

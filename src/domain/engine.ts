import type Database from 'better-sqlite3';
import { loadEngineConfig, advanceToNextEncounter, type EngineConfig } from './encounters';
import { isIdle, setPaused, getGameState } from './gamestate';
import { levelForXp } from './leveling';
import { tokenModifier, attackDamage } from './combat';
import { sumEffectiveSince } from './ingest';

export interface EngineDeps {
  rng?: () => number;
}

interface ActivePlayer {
  id: number;
  level: number;
  effective_tokens: number;
}

export class GameEngine {
  private rng: () => number;
  private nextAttackAt = new Map<number, number>();
  private wasPaused = true;

  constructor(private db: Database.Database, deps: EngineDeps = {}) {
    this.rng = deps.rng ?? Math.random;
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

  private applyHit(encId: number, playerId: number, dmg: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE encounters SET current_hp = MAX(0, current_hp - ?) WHERE id=?')
        .run(dmg, encId);
      this.db.prepare(
        `INSERT INTO encounter_damage (encounter_id, player_id, damage_total, hits, max_hit)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(encounter_id, player_id) DO UPDATE SET
           damage_total = damage_total + excluded.damage_total,
           hits = hits + 1,
           max_hit = MAX(max_hit, excluded.max_hit)`,
      ).run(encId, playerId, dmg, dmg);
    })();
  }

  private resolveKillIfDead(encId: number, now: number, cfg: EngineConfig): void {
    const enc = this.db.prepare('SELECT * FROM encounters WHERE id=?').get(encId) as any;
    if (!enc || enc.status !== 'active' || enc.current_hp > 0) return;

    const dungeon = this.db.prepare('SELECT * FROM dungeons WHERE id=?').get(enc.dungeon_id) as any;
    const goldPool = Math.round(enc.max_hp * dungeon.level * cfg.goldFactor);
    const rows = this.db.prepare(
      'SELECT player_id, damage_total FROM encounter_damage WHERE encounter_id=?',
    ).all(encId) as { player_id: number; damage_total: number }[];
    const total = rows.reduce((s, r) => s + r.damage_total, 0) || 1;
    const award = this.db.prepare('UPDATE players SET gold = gold + ? WHERE id=?');
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE encounters SET status='defeated', ended_at=? WHERE id=?")
        .run(now, encId);
      for (const r of rows) {
        const gold = Math.round(goldPool * (r.damage_total / total));
        if (gold > 0) award.run(gold, r.player_id);
      }
      this.db.prepare(
        'UPDATE game_state SET defeat_until=?, last_defeat_encounter_id=?, current_encounter_id=NULL WHERE id=1',
      ).run(now + cfg.popupDurationS * 1000, encId);
    });
    tx();
    this.wasPaused = true;
  }

  /** Advance the game by one tick. `now` is epoch ms. */
  tick(now: number): void {
    const cfg = loadEngineConfig(this.db);
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
    const since = now - cfg.recentWindowMinutes * 60_000;

    for (const p of this.activePlayers()) {
      this.updateLevel(p, cfg, now);
      const next = this.nextAttackAt.get(p.id) ?? this.scheduleNext(now, cfg);
      if (now >= next) {
        const recent = sumEffectiveSince(this.db, p.id, since);
        const mod = tokenModifier(recent, cfg.tokenModifierK);
        const dmg = attackDamage(cfg.baseHit, p.level, cfg.levelMultSlope, mod);
        this.applyHit(encId, p.id, dmg);
        this.nextAttackAt.set(p.id, this.scheduleNext(now, cfg));
      } else {
        this.nextAttackAt.set(p.id, next);
      }
    }
    this.resolveKillIfDead(encId, now, cfg);
  }
}

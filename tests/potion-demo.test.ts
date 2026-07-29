import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { activatePotion, activePotionEffects } from '../src/domain/potions';
import { buildPotionLabReport } from '../src/domain/potionlab';
import {
  main,
  resumePotionDemoCombat,
  seedPotionDemo,
  validateDemoDbPath,
} from '../tools/seed-potion-demo';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('timed-consumables local demo seed', () => {
  it('creates the complete deterministic animated review cast', () => {
    const db = openDb(':memory:');

    const result = seedPotionDemo(db, 2_000_000);

    expect(db.prepare('SELECT COUNT(*) AS n FROM players').get()).toEqual({ n: 8 });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM potion_activations WHERE status='active'",
    ).get()).toEqual({ n: 6 });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM monster_attacks WHERE kind='debuff'",
    ).get()).toEqual({ n: 2 });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM encounters WHERE status='active'",
    ).get()).toEqual({ n: 1 });
    expect(db.prepare(
      "SELECT potion_type, COUNT(*) AS n FROM potion_activations WHERE status='completed' GROUP BY potion_type ORDER BY potion_type",
    ).all()).toEqual([
      { potion_type: 'damage', n: 1 },
      { potion_type: 'gold', n: 1 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM potion_work_events').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM potion_activation_encounters').get()).toEqual({ n: 1 });
    const linkedWindows = db.prepare(
      `SELECT pae.activation_id AS activationId, pae.encounter_id AS encounterId,
              pa.activated_at AS activatedAt, pa.completed_at AS completedAt,
              e.started_at AS encounterStartedAt, e.ended_at AS encounterEndedAt
       FROM potion_activation_encounters pae
       JOIN potion_activations pa ON pa.id=pae.activation_id
       JOIN encounters e ON e.id=pae.encounter_id
       ORDER BY pae.activation_id, pae.encounter_id`,
    ).all() as Array<{
      activationId: number;
      encounterId: number;
      activatedAt: number;
      completedAt: number | null;
      encounterStartedAt: number;
      encounterEndedAt: number | null;
    }>;
    expect(linkedWindows.length).toBeGreaterThan(0);
    for (const link of linkedWindows) {
      expect(link.completedAt, `activation ${link.activationId} must be completed in this fixture`)
        .not.toBeNull();
      expect(link.encounterStartedAt, `encounter ${link.encounterId} starts before activation completion`)
        .toBeLessThanOrEqual(link.completedAt!);
      expect(link.encounterEndedAt, `encounter ${link.encounterId} ends after activation begins`)
        .not.toBeNull();
      expect(link.encounterEndedAt!, `encounter ${link.encounterId} overlaps activation ${link.activationId}`)
        .toBeGreaterThanOrEqual(link.activatedAt);
    }
    const goldAudit = db.prepare(
      `SELECT pa.activated_at AS activatedAt, pwe.created_at AS workAt,
              te.ts AS tokenEventAt, pa.completed_at AS completedAt,
              p.total_tokens AS totalTokens, p.effective_tokens AS effectiveTokens,
              (SELECT SUM(total_delta) FROM token_events WHERE player_id=pa.player_id) AS eventTotalTokens,
              (SELECT SUM(effective_delta) FROM token_events WHERE player_id=pa.player_id) AS eventEffectiveTokens
       FROM potion_activations pa
       JOIN potion_work_events pwe ON pwe.activation_id=pa.id
       JOIN token_events te ON te.id=pwe.token_event_id
       JOIN players p ON p.id=pa.player_id
       WHERE pa.potion_type='gold' AND pa.status='completed'
       GROUP BY pa.id`,
    ).get() as {
      activatedAt: number;
      workAt: number;
      tokenEventAt: number;
      completedAt: number;
      totalTokens: number;
      effectiveTokens: number;
      eventTotalTokens: number;
      eventEffectiveTokens: number;
    };
    expect(goldAudit.activatedAt).toBeLessThan(goldAudit.tokenEventAt);
    expect(goldAudit.tokenEventAt).toBe(goldAudit.workAt);
    expect(goldAudit.workAt).toBeLessThanOrEqual(goldAudit.completedAt);
    expect(goldAudit).toMatchObject({
      totalTokens: 3_000_000,
      effectiveTokens: 3_000_000,
      eventTotalTokens: 3_000_000,
      eventEffectiveTokens: 3_000_000,
    });

    const report = buildPotionLabReport(db, {});
    expect(report.gold).toMatchObject({
      completed: 1,
      basePayout: 125_000,
      stretchPayout: 25_000,
    });
    expect(report.gold.activations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        completedAt: 1_983_000,
        payout: 150_000,
        netGold: 50_000,
      }),
    ]));
    expect(report.damage.activations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        bonusDamage: 250,
        actualRank: 1,
        counterfactualRank: 2,
        actualReward: 367,
        counterfactualReward: 340,
      }),
    ]));
    expect(db.prepare(
      'SELECT wheel_tier FROM player_cosmetics WHERE player_id=3',
    ).get()).toEqual({ wheel_tier: 3 });

    expect(db.prepare(
      'SELECT COUNT(DISTINCT class_key) AS n FROM players',
    ).get()).toEqual({ n: 8 });
    expect(db.prepare(
      "SELECT COUNT(DISTINCT gender) AS n FROM players",
    ).get()).toEqual({ n: 2 });
    expect(result.players.map((player) => player.state)).toEqual([
      'gold-only',
      'damage-only',
      'dual-potion',
      'debuff-only',
      'potion-plus-debuff',
      'gold-only',
      'control',
      'control',
    ]);
  });

  it('supports a local Armed-to-Active review without production access', async () => {
    const db = openDb(':memory:');
    const now = 2_000_000;
    const result = seedPotionDemo(db, now, 'http://localhost:8115', {
      startPaused: true,
    });
    const control = result.players.find((player) => player.name === 'Quiet Berserker');
    expect(control).toBeDefined();
    if (!control) throw new Error('Armed-review player missing');

    const activation = activatePotion(db, {
      playerId: control.id,
      skuId: 'potion_gold_t1',
      requestId: 'armed-review',
      now,
      timeZone: 'America/New_York',
    });
    expect(activation).toMatchObject({ ok: true, state: 'armed' });
    if (!activation.ok) throw new Error(`armed review activation failed: ${activation.reason}`);
    expect(activePotionEffects(db, control.id, now)).toMatchObject([{ state: 'armed' }]);

    resumePotionDemoCombat(db, now + 1);
    expect(activePotionEffects(db, control.id, now + 1)).toMatchObject([{ state: 'active' }]);
  });

  it('is deterministic for the same timestamp', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');

    const firstResult = seedPotionDemo(first, 9_000_000);
    const secondResult = seedPotionDemo(second, 9_000_000);

    expect(secondResult).toEqual(firstResult);
    for (const table of [
      'players',
      'dungeons',
      'encounters',
      'encounter_damage',
      'shop_purchases',
      'player_inventory',
      'potion_activations',
      'monster_attacks',
      'gold_ledger',
      'game_state',
    ]) {
      expect(second.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
        .toEqual(first.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    }
  });

  it('refuses memory, production, directory, and non-empty database targets', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clauderpg-potion-demo-'));
    temporaryPaths.push(directory);
    const nonEmpty = path.join(directory, 'occupied.db');
    const empty = path.join(directory, 'empty.db');
    fs.writeFileSync(nonEmpty, 'not empty');
    fs.closeSync(fs.openSync(empty, 'w'));

    expect(() => validateDemoDbPath(':memory:', '/production/game.db')).toThrow(/explicit/);
    expect(() => validateDemoDbPath('/production/game.db', '/production/game.db')).toThrow(/production/);
    expect(() => validateDemoDbPath(directory, '/production/game.db')).toThrow(/file/);
    expect(() => validateDemoDbPath(nonEmpty, '/production/game.db')).toThrow(/new or empty/);
    expect(validateDemoDbPath(empty, '/production/game.db')).toBe(path.resolve(empty));
  });

  it('rejects an unrelated resume target without changing its bytes or schema', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clauderpg-potion-demo-'));
    temporaryPaths.push(directory);
    const unrelated = path.join(directory, 'unrelated.db');
    const raw = new SqliteDatabase(unrelated);
    raw.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
    raw.prepare('INSERT INTO unrelated (note) VALUES (?)').run('do not touch');
    raw.close();
    const beforeBytes = fs.readFileSync(unrelated);
    const before = new SqliteDatabase(unrelated, { readonly: true });
    let beforeSchema: unknown[];
    try {
      beforeSchema = before
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();
    } finally {
      before.close();
    }

    expect(() => main(['--resume', unrelated])).toThrow(/dedicated Armed-review fixture/);

    expect(fs.readFileSync(unrelated)).toEqual(beforeBytes);
    const after = new SqliteDatabase(unrelated, { readonly: true });
    try {
      expect(after.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all())
        .toEqual(beforeSchema);
    } finally {
      after.close();
    }
  });
});

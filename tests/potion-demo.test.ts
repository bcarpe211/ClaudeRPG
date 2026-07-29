import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { seedPotionDemo, validateDemoDbPath } from '../tools/seed-potion-demo';

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
});

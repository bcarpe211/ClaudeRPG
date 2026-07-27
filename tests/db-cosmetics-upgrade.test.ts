import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';
import { migrations } from '../src/db/migrations';
import {
  applySlotMutationBatch,
  beginSlotMutationSession,
  getSlotConfig,
} from '../src/domain/slotcosmetics';
import { SLOTS } from '../src/domain/slots';

describe('pre-cosmetics database upgrade', () => {
  it('preserves populated 001-006 data and makes migrations 007-011 usable', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-upgrade-'));
    const dbPath = join(fixtureDir, 'pre-cosmetics.db');
    let upgraded: Database.Database | undefined;
    try {
      const legacy = new Database(dbPath);
      legacy.pragma('foreign_keys = ON');
      legacy.exec(`
        CREATE TABLE _migrations (
          id TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        )
      `);
      const recordMigration = legacy.prepare(
        'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
      );
      for (const [index, migration] of migrations.slice(0, 6).entries()) {
        legacy.exec(migration.sql);
        recordMigration.run(migration.id, 1_000 + index);
      }

      legacy.prepare(
        `INSERT INTO players
         (id, name, class_key, gender, auth_token, level, total_tokens,
          effective_tokens, gold, disabled, last_token_at, created_at, peak_modifier)
         VALUES (1, 'Legacy Hero', 'wizard', 'M', 'legacy-token', 7, 123456,
                 120000, 7654321, 0, 4444, 1111, 3.25)`,
      ).run();
      legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('base_xp', '77777');
      legacy.prepare(
        'INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (1, 2222, 30, 40)',
      ).run();
      legacy.prepare(
        'INSERT INTO metric_series (series_key, last_value, updated_at) VALUES (?, ?, ?)',
      ).run('legacy-series', 99, 3333);
      const dungeon = legacy.prepare(
        'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (4, ?, 42, 3, 4000)',
      ).run('Ossuary Pale');
      const encounter = legacy.prepare(
        `INSERT INTO encounters
         (dungeon_id, index_in_dungeon, kind, creature_index, footprint, pack_count,
          max_hp, current_hp, status, started_at)
         VALUES (?, 2, 'boss', 9, 2, 1, 5000, 3200, 'active', 5000)`,
      ).run(Number(dungeon.lastInsertRowid));
      legacy.prepare(
        'INSERT INTO encounter_damage (encounter_id, player_id, damage_total, hits, max_hit) VALUES (?, 1, 1800, 6, 450)',
      ).run(Number(encounter.lastInsertRowid));
      legacy.prepare('INSERT INTO level_ups (player_id, new_level, ts) VALUES (1, 7, 5500)').run();
      legacy.prepare(
        `INSERT INTO monster_attacks
         (encounter_id, player_id, kind, gold_delta, ts)
         VALUES (?, 1, 'gold', 321, 5600)`,
      ).run(Number(encounter.lastInsertRowid));
      legacy.prepare(
        `UPDATE game_state
         SET current_dungeon_id = ?, current_encounter_id = ?, paused = 0,
             last_activity_at = 5700
         WHERE id = 1`,
      ).run(Number(dungeon.lastInsertRowid), Number(encounter.lastInsertRowid));
      legacy.close();

      upgraded = openDb(dbPath);

      expect(upgraded.prepare(
        `SELECT name, class_key, gender, auth_token, level, total_tokens,
                effective_tokens, gold, last_token_at, created_at, peak_modifier
         FROM players WHERE id = 1`,
      ).get()).toEqual({
        name: 'Legacy Hero',
        class_key: 'wizard',
        gender: 'M',
        auth_token: 'legacy-token',
        level: 7,
        total_tokens: 123456,
        effective_tokens: 120000,
        gold: 7654321,
        last_token_at: 4444,
        created_at: 1111,
        peak_modifier: 3.25,
      });
      expect(upgraded.prepare('SELECT value FROM settings WHERE key = ?').get('base_xp'))
        .toEqual({ value: '77777' });
      expect(upgraded.prepare(
        'SELECT current_dungeon_id, current_encounter_id, paused, last_activity_at FROM game_state WHERE id = 1',
      ).get()).toEqual({
        current_dungeon_id: Number(dungeon.lastInsertRowid),
        current_encounter_id: Number(encounter.lastInsertRowid),
        paused: 0,
        last_activity_at: 5700,
      });
      expect(upgraded.prepare('SELECT damage_total, hits, max_hit FROM encounter_damage').get())
        .toEqual({ damage_total: 1800, hits: 6, max_hit: 450 });
      expect(upgraded.prepare('SELECT kind, gold_delta, ts FROM monster_attacks').get())
        .toEqual({ kind: 'gold', gold_delta: 321, ts: 5600 });
      expect(upgraded.prepare('SELECT COUNT(*) AS count FROM token_events').get())
        .toEqual({ count: 1 });

      expect(upgraded.prepare('SELECT id FROM _migrations ORDER BY id').all())
        .toEqual(migrations.map(({ id }) => ({ id })));
      upgraded.prepare(
        `INSERT INTO player_cosmetics
         (player_id, wheel_tier, primary_hue, updated_at)
         VALUES (1, 3, 210, 6000)`,
      ).run();
      const session = beginSlotMutationSession(upgraded, 1);
      expect(applySlotMutationBatch(upgraded, 1, session.session, 1, [
        { slot: SLOTS.body, rule: { op: 'colorize', hue: 120, sat: 0.6, tone: -0.25 } },
        { slot: SLOTS.cape, rule: null },
      ], 6100)).toBe('applied');
      expect(getSlotConfig(upgraded, 1).get(SLOTS.body)).toEqual({
        op: 'colorize', hue: 120, sat: 0.6, tone: -0.25,
      });
      expect(upgraded.prepare(
        'SELECT session, revision FROM player_slot_cosmetic_revisions WHERE player_id = 1 AND slot = ?',
      ).get(SLOTS.body)).toEqual({ session: session.session, revision: 1 });
      expect(upgraded.prepare(
        'SELECT session, revision, length(digest) AS digest_length FROM player_slot_cosmetic_batches WHERE player_id = 1',
      ).get()).toEqual({ session: session.session, revision: 1, digest_length: 64 });
    } finally {
      upgraded?.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

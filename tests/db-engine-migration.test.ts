import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { DEFAULT_SETTINGS } from '../src/domain/settings';

describe('game engine migration + settings', () => {
  it('creates the engine tables', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r: any) => r.name);
    for (const t of ['dungeons', 'encounters', 'encounter_damage', 'level_ups', 'game_state']) {
      expect(tables).toContain(t);
    }
  });

  it('seeds the singleton game_state row', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT * FROM game_state WHERE id = 1').get() as any;
    expect(row).toBeTruthy();
    expect(row.paused).toBe(1); // starts paused/idle
  });

  it('adds engine knobs to DEFAULT_SETTINGS', () => {
    for (const k of ['min_encounter_hp', 'difficulty_ramp_per_encounter',
      'difficulty_ramp_per_dungeon', 'regular_encounters_min',
      'regular_encounters_max', 'tick_interval_ms']) {
      expect(DEFAULT_SETTINGS[k]).toBeDefined();
    }
  });
});

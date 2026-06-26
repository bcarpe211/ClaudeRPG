import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import {
  DEFAULT_SETTINGS,
  seedSettings,
  getSetting,
  setSetting,
  getAllSettings,
} from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('settings', () => {
  it('seeds defaults without overwriting existing values', () => {
    setSetting(db, 'target_battle_minutes', '45');
    seedSettings(db);
    expect(getSetting(db, 'target_battle_minutes')).toBe('45'); // preserved
    expect(getSetting(db, 'pause_after_minutes')).toBe(
      DEFAULT_SETTINGS.pause_after_minutes,
    );
  });

  it('getSetting returns undefined for unknown key', () => {
    expect(getSetting(db, 'nope')).toBeUndefined();
  });

  it('getAllSettings returns every seeded key', () => {
    seedSettings(db);
    const all = getAllSettings(db);
    expect(Object.keys(all).length).toBe(Object.keys(DEFAULT_SETTINGS).length);
    expect(all.xp_growth).toBe('1.5');
  });
});

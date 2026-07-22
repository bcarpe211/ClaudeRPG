import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('007_player_cosmetics migration', () => {
  it('creates player_cosmetics with the expected columns', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("PRAGMA table_info(player_cosmetics)").all() as any[]).map((c) => c.name);
    expect(cols).toEqual(['player_id', 'wheel_tier', 'primary_hue', 'secondary_hue', 'weapon_hue', 'updated_at']);
  });
});

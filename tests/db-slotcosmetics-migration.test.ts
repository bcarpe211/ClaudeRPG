import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('008_player_slot_cosmetics migration', () => {
  it('creates player_slot_cosmetics with the expected columns', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("PRAGMA table_info(player_slot_cosmetics)").all() as any[]).map((c) => c.name);
    expect(cols).toEqual(['player_id', 'slot', 'op', 'hue', 'sat', 'lo', 'hi', 'updated_at']);
  });
});

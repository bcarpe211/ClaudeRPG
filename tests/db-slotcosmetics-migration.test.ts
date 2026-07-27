import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';

describe('008_player_slot_cosmetics migration', () => {
  it('creates player_slot_cosmetics with the expected columns', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("PRAGMA table_info(player_slot_cosmetics)").all() as any[]).map((c) => c.name);
    expect(cols).toEqual(['player_id', 'slot', 'op', 'hue', 'sat', 'lo', 'hi', 'updated_at', 'tone']);
  });

  it('creates revision tombstones for ordered browser mutations', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("PRAGMA table_info(player_slot_cosmetic_revisions)").all() as any[])
      .map((c) => c.name);
    expect(cols).toEqual(['player_id', 'slot', 'session', 'revision']);
    const sessions = (db.prepare("PRAGMA table_info(player_cosmetic_mutation_sessions)").all() as any[])
      .map((c) => c.name);
    expect(sessions).toEqual(['player_id', 'session']);
  });

  it('creates immutable batch receipts for payload-aware retries', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare("PRAGMA table_info(player_slot_cosmetic_batches)").all() as any[])
      .map((c) => c.name);
    expect(cols).toEqual(['player_id', 'session', 'revision', 'digest']);
  });
});

import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer } from '../src/domain/players';

describe('peak_modifier migration', () => {
  it('adds peak_modifier to players, defaulting to 1', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(players)').all().map((r: any) => r.name);
    expect(cols).toContain('peak_modifier');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const row = db.prepare('SELECT peak_modifier FROM players WHERE id=?').get(p.id) as any;
    expect(row.peak_modifier).toBe(1);
  });
});

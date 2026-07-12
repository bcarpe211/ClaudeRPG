import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { activityScore } from '../src/domain/activity';

let db: ReturnType<typeof openDb>;
let pid: number;
const CFG = { decayAfterMinutes: 5, decaySpanMinutes: 5 }; // 300000ms each
const NOW = 1_000_000;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  pid = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1).id;
});
function ev(ts: number, delta: number) {
  db.prepare('INSERT INTO token_events (player_id, ts, effective_delta, total_delta) VALUES (?,?,?,?)')
    .run(pid, ts, delta, delta);
}

describe('activityScore', () => {
  it('returns 0 with no events', () => {
    expect(activityScore(db, pid, NOW, CFG)).toBe(0);
  });
  it('accumulates the whole current session', () => {
    ev(NOW - 60_000, 100); ev(NOW - 30_000, 200); ev(NOW - 10_000, 300);
    expect(activityScore(db, pid, NOW, CFG)).toBe(600);
  });
  it('holds across a gap shorter than decayAfter (same session)', () => {
    ev(NOW - 250_000, 500); ev(NOW - 10_000, 300); // gap 240s < 300s
    expect(activityScore(db, pid, NOW, CFG)).toBe(800);
  });
  it('excludes events before a session boundary (gap >= decayAfter)', () => {
    ev(NOW - 400_000, 999); ev(NOW - 60_000, 200); ev(NOW - 10_000, 300); // 340s gap boundary
    expect(activityScore(db, pid, NOW, CFG)).toBe(500);
  });
  it('decays linearly once idle past decayAfter', () => {
    ev(NOW - 450_000, 1000); // gap0 450s; over 150s; factor 0.5
    expect(activityScore(db, pid, NOW, CFG)).toBeCloseTo(500, 5);
  });
  it('is fully decayed after decayAfter + decaySpan', () => {
    ev(NOW - 700_000, 1000); // over 400s > span 300s -> 0
    expect(activityScore(db, pid, NOW, CFG)).toBe(0);
  });
  it('is uncapped', () => {
    ev(NOW - 10_000, 5_000_000);
    expect(activityScore(db, pid, NOW, CFG)).toBe(5_000_000);
  });
});

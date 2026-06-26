import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { createPlayer, getPlayerById, updatePlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); });

function body(token: string, byType: Record<string, number>, temporality = 1) {
  const dataPoints = Object.entries(byType).map(([type, v]) => ({
    asInt: String(v),
    startTimeUnixNano: 's', timeUnixNano: 't',
    attributes: [{ key: 'type', value: { stringValue: type } }, { key: 'model', value: { stringValue: 'm' } }],
  }));
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
      scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: temporality, dataPoints } }] }],
    }],
  };
}

describe('ingestTokenUsage', () => {
  it('adds effective (input+output+cacheCreation) and total; ignores cacheRead by default', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100, output: 40, cacheCreation: 10, cacheRead: 9999 }), 5000, { cacheReadWeight: 0 });
    const u = getPlayerById(db, p.id)!;
    expect(u.effective_tokens).toBe(150);
    expect(u.total_tokens).toBe(10149);
    expect(u.last_token_at).toBe(5000);
    const ev = db.prepare('SELECT * FROM token_events WHERE player_id = ?').all(p.id) as any[];
    expect(ev.length).toBe(1);
    expect(ev[0].effective_delta).toBe(150);
    expect(ev[0].total_delta).toBe(10149);
  });

  it('applies cache_read_weight when > 0', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 0, output: 0, cacheCreation: 0, cacheRead: 1000 }), 1, { cacheReadWeight: 0.05 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(50);
  });

  it('accumulates across multiple ingests', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }), 1, { cacheReadWeight: 0 });
    ingestTokenUsage(db, body(p.auth_token, { input: 50 }), 2, { cacheReadWeight: 0 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(150);
  });

  it('ignores unknown tokens', () => {
    const res = ingestTokenUsage(db, body('nobody', { input: 100 }), 1, { cacheReadWeight: 0 });
    expect(res.appliedPlayers).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM token_events').get()).toMatchObject({ c: 0 });
  });

  it('ignores disabled players', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    updatePlayer(db, p.id, { disabled: 1 });
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }), 1, { cacheReadWeight: 0 });
    expect(getPlayerById(db, p.id)!.effective_tokens).toBe(0);
  });

  it('does not write a token_event when the net effective+total increment is zero', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, {}), 1, { cacheReadWeight: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM token_events').get()).toMatchObject({ c: 0 });
  });

  it('sumEffectiveSince totals only recent token_events', async () => {
    const { sumEffectiveSince } = await import('../src/domain/ingest');
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, body(p.auth_token, { input: 100 }), 1000, { cacheReadWeight: 0 });
    ingestTokenUsage(db, body(p.auth_token, { input: 50 }), 5000, { cacheReadWeight: 0 });
    expect(sumEffectiveSince(db, p.id, 2000)).toBe(50);
    expect(sumEffectiveSince(db, p.id, 0)).toBe(150);
  });
});

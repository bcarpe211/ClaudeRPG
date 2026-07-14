import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { ingestTokenUsage } from '../src/domain/ingest';
import { GameEngine } from '../src/domain/engine';
import { TvHub } from '../src/web/tvhub';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function tokens(token: string, n: number) {
  return { resourceMetrics: [{ resource: { attributes: [{ key: 'claude_rpg_token', value: { stringValue: token } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { aggregationTemporality: 1,
      dataPoints: [{ asInt: String(n), startTimeUnixNano: 's', timeUnixNano: 't',
        attributes: [{ key: 'type', value: { stringValue: 'input' } }] }] } }] }] }] };
}

function fakeClient() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => { chunks.push(s); } };
}
function events(chunks: string[]) {
  // parse SSE frames -> [{event, data}]
  return chunks.join('').split('\n\n').filter(Boolean).map((frame) => {
    const ev = /event: (.*)/.exec(frame)?.[1];
    const data = /data: (.*)/.exec(frame)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

describe('TvHub', () => {
  it('sends state (and layout if a dungeon exists) to a new client', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    new GameEngine(db, { rng: () => 0.5 }).tick(100000);
    const hub = new TvHub(db);
    const c = fakeClient();
    hub.addClient(c, 100000);
    const evs = events(c.chunks);
    expect(evs.some((e) => e.event === 'layout')).toBe(true);
    expect(evs.some((e) => e.event === 'state')).toBe(true);
  });

  it('sends a version frame before state so the kiosk can self-reload on redeploy', () => {
    const hub = new TvHub(db);
    const c = fakeClient();
    hub.addClient(c, 1);
    const evs = events(c.chunks);
    const vIdx = evs.findIndex((e) => e.event === 'version');
    const sIdx = evs.findIndex((e) => e.event === 'state');
    expect(vIdx).toBeGreaterThanOrEqual(0);
    expect(typeof evs[vIdx].data).toBe('string');
    expect((evs[vIdx].data as string).length).toBeGreaterThan(0);
    expect(vIdx).toBeLessThan(sIdx); // version arrives before state
  });

  it('broadcast pushes state to all clients and a layout only when the dungeon changes', () => {
    const p = createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    ingestTokenUsage(db, tokens(p.auth_token, 1000), 100000, { cacheReadWeight: 0 });
    const eng = new GameEngine(db, { rng: () => 0.5 });
    eng.tick(100000);
    const hub = new TvHub(db);
    const c = fakeClient();
    hub.addClient(c, 100000);
    c.chunks.length = 0; // clear join frames
    hub.broadcast(100000 + 1000);
    const evs = events(c.chunks);
    expect(evs.filter((e) => e.event === 'state').length).toBe(1);
    expect(evs.filter((e) => e.event === 'layout').length).toBe(0); // same dungeon
  });

  it('removeClient stops further writes', () => {
    const hub = new TvHub(db);
    const c = fakeClient();
    hub.addClient(c, 1);
    hub.removeClient(c);
    c.chunks.length = 0;
    hub.broadcast(2);
    expect(c.chunks.length).toBe(0);
  });
});

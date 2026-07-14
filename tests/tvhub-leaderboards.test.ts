import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { TvHub } from '../src/web/tvhub';

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(':memory:'); seedSettings(db); });

function capturing() { const frames: string[] = []; return { frames, client: { write: (c: string) => { frames.push(c); } } }; }

describe('TvHub leaderboards', () => {
  it('sends a leaderboards frame on connect', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const hub = new TvHub(db);
    const { frames, client } = capturing();
    hub.addClient(client, 1000);
    const lb = frames.find((f) => f.startsWith('event: leaderboards'));
    expect(lb).toBeTruthy();
    expect(lb).toContain('overall_tokens');
  });

  it('broadcastLeaderboards writes to connected clients', () => {
    createPlayer(db, { name: 'A', class_key: 'knight', gender: 'M' }, 1);
    const hub = new TvHub(db);
    const { frames, client } = capturing();
    hub.addClient(client, 1000);
    frames.length = 0;
    hub.broadcastLeaderboards(2000);
    expect(frames.some((f) => f.startsWith('event: leaderboards') && f.includes('days_champion'))).toBe(true);
  });
});

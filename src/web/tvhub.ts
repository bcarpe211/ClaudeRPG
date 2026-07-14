import type Database from 'better-sqlite3';
import { buildTvLayout, buildTvState } from './tvview';
import { buildLeaderboards } from '../domain/leaderboards';
import { loadEngineConfig } from '../domain/encounters';

export interface SseClient {
  write(chunk: string): void;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class TvHub {
  private clients = new Set<SseClient>();
  private lastDungeonId: number | null = null;

  constructor(private db: Database.Database) {}

  addClient(client: SseClient, now: number): void {
    this.clients.add(client);
    const layout = buildTvLayout(this.db);
    if (layout) {
      client.write(frame('layout', layout));
      this.lastDungeonId = layout.dungeonId;
    }
    client.write(frame('state', buildTvState(this.db, now)));
    client.write(frame('leaderboards', buildLeaderboards(this.db, now, loadEngineConfig(this.db))));
  }

  removeClient(client: SseClient): void {
    this.clients.delete(client);
  }

  /** Push state to all clients; prepend a layout whenever the dungeon changed. */
  broadcast(now: number): void {
    if (this.clients.size === 0) return;
    const state = buildTvState(this.db, now);
    if (state.dungeonId !== this.lastDungeonId) {
      const layout = buildTvLayout(this.db);
      if (layout) {
        const f = frame('layout', layout);
        for (const c of this.clients) this.safeWrite(c, f);
      }
      this.lastDungeonId = state.dungeonId;
    }
    const sf = frame('state', state);
    for (const c of this.clients) this.safeWrite(c, sf);
  }

  /** Push the full leaderboard set to all clients (slow cadence; decoupled from state). */
  broadcastLeaderboards(now: number): void {
    if (this.clients.size === 0) return;
    const f = frame('leaderboards', buildLeaderboards(this.db, now, loadEngineConfig(this.db)));
    for (const c of this.clients) this.safeWrite(c, f);
  }

  private safeWrite(c: SseClient, f: string): void {
    try { c.write(f); } catch { this.clients.delete(c); }
  }
}

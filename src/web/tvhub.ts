import type Database from 'better-sqlite3';
import { buildTvLayout, buildTvState } from './tvview';
import { buildLeaderboards } from '../domain/leaderboards';
import { loadEngineConfig } from '../domain/encounters';
import { SERVER_VERSION } from '../version';
import type { SkinAssetContext } from '../domain/slotcosmetics';

export interface SseClient {
  write(chunk: string): void;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class TvHub {
  private clients = new Set<SseClient>();
  private lastDungeonId: number | null = null;

  constructor(
    private db: Database.Database,
    private assets: SkinAssetContext = {},
  ) {}

  addClient(client: SseClient, now: number): void {
    this.clients.add(client);
    // Deployed-commit marker first — the kiosk reloads itself if this changes
    // across an SSE reconnect (i.e. the server was redeployed).
    client.write(frame('version', SERVER_VERSION));
    const layout = buildTvLayout(this.db);
    if (layout) {
      client.write(frame('layout', layout));
      this.lastDungeonId = layout.dungeonId;
    }
    client.write(frame('state', buildTvState(this.db, now, this.assets)));
    client.write(frame('leaderboards', buildLeaderboards(
      this.db, now, loadEngineConfig(this.db), { assets: this.assets },
    )));
  }

  removeClient(client: SseClient): void {
    this.clients.delete(client);
  }

  /** Push state to all clients; prepend a layout whenever the dungeon changed. */
  broadcast(now: number): void {
    if (this.clients.size === 0) return;
    const state = buildTvState(this.db, now, this.assets);
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
    const f = frame('leaderboards', buildLeaderboards(
      this.db, now, loadEngineConfig(this.db), { assets: this.assets },
    ));
    for (const c of this.clients) this.safeWrite(c, f);
  }

  private safeWrite(c: SseClient, f: string): void {
    try { c.write(f); } catch { this.clients.delete(c); }
  }
}

import { loadConfig } from './config';
import { openDb } from './db/db';
import { seedSettings } from './domain/settings';
import { ensureAdmin } from './domain/admin';
import { createApp } from './web/app';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GameEngine } from './domain/engine';
import { loadEngineConfig } from './domain/encounters';

const config = loadConfig(process.env);

// Ensure the data directory exists for the SQLite file.
if (config.dbPath !== ':memory:') {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}

const db = openDb(config.dbPath);
seedSettings(db);
ensureAdmin(db, config.adminUsername, config.adminPassword);

if (config.adminPassword === 'changeme') {
  console.warn(
    '[ClaudeRPG] WARNING: using default admin password "changeme". ' +
      'Set ADMIN_PASSWORD before exposing this server.',
  );
}

const app = createApp({ db, config });

const engine = new GameEngine(db);
const tickMs = loadEngineConfig(db).tickIntervalMs;
const tvHub = (app as unknown as { tvHub: import('./web/tvhub').TvHub }).tvHub;
const tickTimer = setInterval(() => {
  try {
    engine.tick(Date.now());
    tvHub.broadcast(Date.now());
  } catch (err) {
    console.error('[ClaudeRPG] engine tick error:', err);
  }
}, tickMs);
console.log(`[ClaudeRPG] game engine ticking every ${tickMs}ms`);

const server = app.listen(config.port, () => {
  console.log(`[ClaudeRPG] listening on http://localhost:${config.port}`);
  console.log(`[ClaudeRPG] admin panel: http://localhost:${config.port}/admin`);
});

// Graceful shutdown: on a clean stop (systemd SIGTERM, Ctrl-C) stop ticking,
// stop accepting connections, then checkpoint the WAL back into the main DB
// file and close. synchronous=FULL already protects against power loss; this
// just keeps clean restarts tidy (small main file, no lingering WAL).
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ClaudeRPG] ${signal} received, shutting down...`);
  clearInterval(tickTimer);
  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      console.error('[ClaudeRPG] error during db shutdown:', err);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

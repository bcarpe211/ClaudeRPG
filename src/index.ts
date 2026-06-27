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
setInterval(() => {
  try {
    engine.tick(Date.now());
  } catch (err) {
    console.error('[ClaudeRPG] engine tick error:', err);
  }
}, tickMs);
console.log(`[ClaudeRPG] game engine ticking every ${tickMs}ms`);

app.listen(config.port, () => {
  console.log(`[ClaudeRPG] listening on http://localhost:${config.port}`);
  console.log(`[ClaudeRPG] admin panel: http://localhost:${config.port}/admin`);
});

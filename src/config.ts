import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  dbPath: string;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  otelHost: string;
  spritesDir: string;
  enableCatalog: boolean;
  enableDungeonPreview: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: env.PORT ? Number(env.PORT) : 8080,
    dbPath: env.DB_PATH ?? './data/claude-rpg.db',
    adminUsername: env.ADMIN_USERNAME ?? 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? 'changeme',
    sessionSecret: env.SESSION_SECRET ?? randomBytes(24).toString('hex'),
    otelHost: env.OTEL_ENDPOINT_HOST ?? 'claude-rpg.local',
    spritesDir:
      env.SPRITES_DIR ?? 'assets/oryx_16-bit_fantasy_1.1/Sliced',
    enableCatalog:
      env.ENABLE_CATALOG === '1' || env.ENABLE_CATALOG === 'true',
    enableDungeonPreview:
      env.ENABLE_DUNGEON_PREVIEW === '1' || env.ENABLE_DUNGEON_PREVIEW === 'true',
  };
}

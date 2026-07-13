import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  dbPath: string;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  otelHost: string;
  /** Public base URL clients reach this server at — used in the OTEL setup snippet and
   *  shown on the landing page. Flip to https after Caddy fronts it (no code change). */
  publicUrl: string;
  spritesDir: string;
  enableCatalog: boolean;
  enableDungeonPreview: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = env.PORT ? Number(env.PORT) : 8080;
  const otelHost = env.OTEL_ENDPOINT_HOST ?? 'claude-rpg.local';
  return {
    port,
    dbPath: env.DB_PATH ?? './data/claude-rpg.db',
    adminUsername: env.ADMIN_USERNAME ?? 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? 'changeme',
    sessionSecret: env.SESSION_SECRET ?? randomBytes(24).toString('hex'),
    otelHost,
    // PUBLIC_URL wins; otherwise derive from host:port for local/dev.
    publicUrl: env.PUBLIC_URL ?? `http://${otelHost}:${port}`,
    spritesDir:
      env.SPRITES_DIR ?? 'assets/oryx_16-bit_fantasy_1.1/Sliced',
    enableCatalog:
      env.ENABLE_CATALOG === '1' || env.ENABLE_CATALOG === 'true',
    enableDungeonPreview:
      env.ENABLE_DUNGEON_PREVIEW === '1' || env.ENABLE_DUNGEON_PREVIEW === 'true',
  };
}

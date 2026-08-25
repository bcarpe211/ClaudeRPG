import { randomBytes } from 'node:crypto';
import {
  providerForSurface,
  type RunSurface,
} from './domain/run-events';
import {
  loadRaidPowerPolicy,
  loadRaidPowerPolicyV2,
} from './domain/raid-power-policy';
import { createRaidPowerPolicySchedule } from './domain/raid-power-policy-schedule';

export type ScoringMode = 'legacy-otlp' | 'runtime-raiders' | 'disabled';

const DEFAULT_RAID_POWER_POLICY_PATH = 'config/raid-power-policy-v1.json';
const DEFAULT_RAID_POWER_POLICY_V2_PATH = 'config/raid-power-policy-v2.json';
const RUN_SURFACES = new Set<RunSurface>([
  'codex_desktop',
  'codex_cli',
  'claude_code',
  'omp',
]);

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
  enableCosmeticsReview: boolean;
  officeTimeZone: string;
  scoringMode: ScoringMode;
  runCutoverAt: number;
  raidPowerPolicyPath: string;
  raidPowerPolicyV2Path: string;
  raidPowerV2CutoverAt: number;
  enabledRunSurfaces: RunSurface[];
}

function scoringMode(env: NodeJS.ProcessEnv): ScoringMode {
  const value = env.SCORING_MODE ?? 'legacy-otlp';
  if (value !== 'legacy-otlp' && value !== 'runtime-raiders' && value !== 'disabled') {
    throw new Error(`Invalid SCORING_MODE: ${value}`);
  }
  return value;
}

function runCutoverAt(env: NodeJS.ProcessEnv, required: boolean): number {
  const value = env.RUN_SCORING_CUTOVER_AT;
  if (value === undefined) {
    if (required) throw new Error('RUN_SCORING_CUTOVER_AT is required');
    return 0;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('RUN_SCORING_CUTOVER_AT must be a non-negative safe integer epoch');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('RUN_SCORING_CUTOVER_AT must be a non-negative safe integer epoch');
  }
  return parsed;
}

function raidPowerV2CutoverAt(env: NodeJS.ProcessEnv, required: boolean): number {
  const value = env.RAID_POWER_V2_CUTOVER_AT;
  if (value === undefined) {
    if (required) throw new Error('RAID_POWER_V2_CUTOVER_AT is required');
    return 0;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('RAID_POWER_V2_CUTOVER_AT must be a non-negative safe integer epoch');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('RAID_POWER_V2_CUTOVER_AT must be a non-negative safe integer epoch');
  }
  return parsed;
}

function enabledRunSurfaces(env: NodeJS.ProcessEnv): RunSurface[] {
  const value = env.RUN_ENABLED_SURFACES;
  if (value === undefined) return [];
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw new Error('RUN_ENABLED_SURFACES must not contain empty items');
  }

  const surfaces: RunSurface[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!RUN_SURFACES.has(item as RunSurface)) {
      throw new Error(`Invalid RUN_ENABLED_SURFACES item: ${item}`);
    }
    if (seen.has(item)) {
      throw new Error(`Duplicate RUN_ENABLED_SURFACES item: ${item}`);
    }
    seen.add(item);
    surfaces.push(item as RunSurface);
  }
  return surfaces;
}

function officeTimeZone(env: NodeJS.ProcessEnv): string {
  const value = env.OFFICE_TIME_ZONE ?? 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch {
    throw new Error(`Invalid OFFICE_TIME_ZONE: ${value}`);
  }
  return value;
}

function publicUrl(env: NodeJS.ProcessEnv, otelHost: string, port: number): string {
  const value = env.PUBLIC_URL ?? `http://${otelHost}:${port}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PUBLIC_URL must be an absolute HTTP(S) origin');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('PUBLIC_URL must be an absolute HTTP(S) origin without credentials or a path');
  }
  return parsed.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = env.PORT ? Number(env.PORT) : 8080;
  const otelHost = env.OTEL_ENDPOINT_HOST ?? 'claude-rpg.local';
  const normalizedPublicUrl = publicUrl(env, otelHost, port);
  const mode = scoringMode(env);
  const cutoverAt = runCutoverAt(env, mode === 'runtime-raiders');
  const raidPowerPolicyPath = env.RAID_POWER_POLICY_PATH
    ?? DEFAULT_RAID_POWER_POLICY_PATH;
  const raidPowerPolicyV2Path = env.RAID_POWER_POLICY_V2_PATH
    ?? DEFAULT_RAID_POWER_POLICY_V2_PATH;
  const v2CutoverAt = raidPowerV2CutoverAt(env, mode === 'runtime-raiders');
  const surfaces = enabledRunSurfaces(env);

  if (mode === 'runtime-raiders') {
    if (surfaces.length === 0) {
      throw new Error('RUN_ENABLED_SURFACES is required in runtime-raiders mode');
    }
    if (env.RAID_POWER_POLICY_V2_PATH === undefined) {
      throw new Error('RAID_POWER_POLICY_V2_PATH is required');
    }
    const v1 = loadRaidPowerPolicy(raidPowerPolicyPath);
    const v2 = loadRaidPowerPolicyV2(raidPowerPolicyV2Path);
    createRaidPowerPolicySchedule(v1, v2, cutoverAt, v2CutoverAt);
    for (const surface of surfaces) {
      const provider = providerForSurface(surface);
      if (!(v1.enabled_providers as readonly string[]).includes(provider)
        || !(v2.enabled_providers as readonly string[]).includes(provider)) {
        throw new Error(
          `RUN_ENABLED_SURFACES provider ${provider} is not enabled by both Raid Power policies`,
        );
      }
    }
  }

  return {
    port,
    dbPath: env.DB_PATH ?? './data/claude-rpg.db',
    adminUsername: env.ADMIN_USERNAME ?? 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? 'changeme',
    sessionSecret: env.SESSION_SECRET ?? randomBytes(24).toString('hex'),
    otelHost,
    // PUBLIC_URL wins; otherwise derive from host:port for local/dev.
    publicUrl: normalizedPublicUrl,
    spritesDir:
      env.SPRITES_DIR ?? 'assets/oryx_16-bit_fantasy_1.1/Sliced',
    enableCatalog:
      env.ENABLE_CATALOG === '1' || env.ENABLE_CATALOG === 'true',
    enableDungeonPreview:
      env.ENABLE_DUNGEON_PREVIEW === '1' || env.ENABLE_DUNGEON_PREVIEW === 'true',
    enableCosmeticsReview:
      env.ENABLE_COSMETICS_REVIEW === '1'
      || env.ENABLE_COSMETICS_REVIEW === 'true',
    officeTimeZone: officeTimeZone(env),
    scoringMode: mode,
    runCutoverAt: cutoverAt,
    raidPowerPolicyPath,
    raidPowerPolicyV2Path,
    raidPowerV2CutoverAt: v2CutoverAt,
    enabledRunSurfaces: surfaces,
  };
}

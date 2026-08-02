import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config';

const POLICY_PATH = resolve('config/raid-power-policy-v1.json');

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.dbPath).toBe('./data/claude-rpg.db');
    expect(c.adminUsername).toBe('admin');
    expect(c.otelHost).toBe('claude-rpg.local');
    expect(c.officeTimeZone).toBe('America/New_York');
    expect(c.scoringMode).toBe('legacy-otlp');
    expect(c.runCutoverAt).toBe(0);
    expect(c.raidPowerPolicyPath).toBe('config/raid-power-policy-v1.json');
    expect(c.enabledRunSurfaces).toEqual([]);
    expect(typeof c.sessionSecret).toBe('string');
    expect(c.sessionSecret.length).toBeGreaterThan(10);
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      PORT: '9000',
      DB_PATH: '/tmp/x.db',
      ADMIN_USERNAME: 'boss',
      ADMIN_PASSWORD: 'secret',
      OTEL_ENDPOINT_HOST: 'rpg.lan',
      SESSION_SECRET: 'fixedsecretvalue',
    });
    expect(c.port).toBe(9000);
    expect(c.dbPath).toBe('/tmp/x.db');
    expect(c.adminUsername).toBe('boss');
    expect(c.adminPassword).toBe('secret');
    expect(c.otelHost).toBe('rpg.lan');
    expect(c.sessionSecret).toBe('fixedsecretvalue');
  });
});

describe('loadConfig scoring mode', () => {
  it.each(['runtime_raiders', 'legacy', 'off', '', ' runtime-raiders '])(
    'rejects invalid SCORING_MODE=%j',
    (value) => {
      expect(() => loadConfig({ SCORING_MODE: value })).toThrow(/SCORING_MODE/);
    },
  );

  it('loads the Codex-first Runtime Raiders configuration', () => {
    const c = loadConfig({
      SCORING_MODE: 'runtime-raiders',
      RUN_SCORING_CUTOVER_AT: '1800000000000',
      RAID_POWER_POLICY_PATH: POLICY_PATH,
      RUN_ENABLED_SURFACES: 'codex_desktop,codex_cli',
    });

    expect(c.scoringMode).toBe('runtime-raiders');
    expect(c.runCutoverAt).toBe(1_800_000_000_000);
    expect(c.raidPowerPolicyPath).toBe(POLICY_PATH);
    expect(c.enabledRunSurfaces).toEqual(['codex_desktop', 'codex_cli']);
  });

  it('requires an explicit safe-integer cutover in runtime mode', () => {
    const runtime = {
      SCORING_MODE: 'runtime-raiders',
      RAID_POWER_POLICY_PATH: POLICY_PATH,
      RUN_ENABLED_SURFACES: 'codex_desktop',
    };

    expect(() => loadConfig(runtime)).toThrow(/RUN_SCORING_CUTOVER_AT/);
    for (const value of ['', '-1', '1.5', 'epoch', '9007199254740992']) {
      expect(() => loadConfig({
        ...runtime,
        RUN_SCORING_CUTOVER_AT: value,
      }), value).toThrow(/RUN_SCORING_CUTOVER_AT/);
    }
  });

  it('requires a loadable immutable policy in runtime mode', () => {
    expect(() => loadConfig({
      SCORING_MODE: 'runtime-raiders',
      RUN_SCORING_CUTOVER_AT: '1800000000000',
      RAID_POWER_POLICY_PATH: resolve('config/does-not-exist.json'),
      RUN_ENABLED_SURFACES: 'codex_desktop',
    })).toThrow();
  });

  it('requires a nonempty, unique list of known surfaces in runtime mode', () => {
    const runtime = {
      SCORING_MODE: 'runtime-raiders',
      RUN_SCORING_CUTOVER_AT: '1800000000000',
      RAID_POWER_POLICY_PATH: POLICY_PATH,
    };

    for (const value of [undefined, '', '   ', 'codex_cli,,codex_desktop',
      'codex_cli,   ,codex_desktop', 'codex_cli,codex_cli', 'cursor']) {
      expect(() => loadConfig({
        ...runtime,
        ...(value === undefined ? {} : { RUN_ENABLED_SURFACES: value }),
      }), String(value)).toThrow(/RUN_ENABLED_SURFACES/);
    }
  });

  it('allows only surfaces whose canonical provider exists in the policy', () => {
    const runtime = {
      SCORING_MODE: 'runtime-raiders',
      RUN_SCORING_CUTOVER_AT: '1800000000000',
      RAID_POWER_POLICY_PATH: POLICY_PATH,
    };

    for (const surface of ['claude_code', 'omp']) {
      expect(() => loadConfig({
        ...runtime,
        RUN_ENABLED_SURFACES: surface,
      }), surface).toThrow(/provider|policy/i);
    }
  });
});

describe('loadConfig officeTimeZone', () => {
  it('reads a valid IANA office time zone', () => {
    expect(loadConfig({ OFFICE_TIME_ZONE: 'Europe/London' }).officeTimeZone)
      .toBe('Europe/London');
  });

  it('rejects an invalid office time zone', () => {
    expect(() => loadConfig({ OFFICE_TIME_ZONE: 'Dungeon/Nowhere' }))
      .toThrow(/OFFICE_TIME_ZONE/);
  });
});

describe('loadConfig enableCatalog', () => {
  it('defaults to false', () => {
    expect(loadConfig({}).enableCatalog).toBe(false);
  });
  it('is true when ENABLE_CATALOG=1', () => {
    expect(loadConfig({ ENABLE_CATALOG: '1' }).enableCatalog).toBe(true);
  });
  it('is true when ENABLE_CATALOG=true', () => {
    expect(loadConfig({ ENABLE_CATALOG: 'true' }).enableCatalog).toBe(true);
  });
});

describe('loadConfig enableCosmeticsReview', () => {
  it('defaults to false', () => {
    expect(loadConfig({}).enableCosmeticsReview).toBe(false);
  });
  it.each(['1', 'true'])('is true for %s', (value) => {
    expect(loadConfig({ ENABLE_COSMETICS_REVIEW: value }).enableCosmeticsReview)
      .toBe(true);
  });
});

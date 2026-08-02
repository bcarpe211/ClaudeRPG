import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const caddy = readFileSync(resolve('deploy/Caddyfile'), 'utf8');
const env = readFileSync(resolve('deploy/claude-rpg.env.example'), 'utf8');

describe('Runtime Raiders internal deployment configuration', () => {
  it('keeps the new and compatibility hostnames behind the local app proxy', () => {
    expect(caddy).toContain('raiders.redlattice.com');
    expect(caddy).toContain('clauderpg.redlattice.com');
    expect(caddy).toContain('reverse_proxy localhost:8080');
  });

  it('targets the Runtime Raiders scoring configuration', () => {
    expect(env).toContain('PUBLIC_URL=https://raiders.redlattice.com');
    expect(env).toContain('SCORING_MODE=runtime-raiders');
    expect(env).toMatch(/^RUN_SCORING_CUTOVER_AT=\d+$/m);
    expect(env).toMatch(/^RAID_POWER_POLICY_PATH=__REPO__\/config\/raid-power-policy-v1\.json$/m);
    expect(env).toContain('RUN_ENABLED_SURFACES=codex_desktop,codex_cli');
    expect(env).not.toContain('OTEL_ENDPOINT_HOST=');
  });

  it('does not add public ingress configuration', () => {
    const deployment = `${caddy}\n${env}`.toLowerCase();

    expect(deployment).not.toContain('0.0.0.0');
    expect(deployment).not.toContain('public tunnel');
    expect(deployment).not.toContain('cloudflare tunnel');
    expect(deployment).not.toContain('cloudflared');
    expect(deployment).not.toContain('port-forward');
    expect(deployment).not.toContain('port forward');
    expect(deployment).not.toMatch(/^\s*listen\s+/m);
  });
});

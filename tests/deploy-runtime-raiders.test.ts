import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const caddy = readFileSync(resolve('deploy/Caddyfile'), 'utf8');
const env = readFileSync(resolve('deploy/claude-rpg.env.example'), 'utf8');
const setup = readFileSync(resolve('scripts/pi/setup.sh'), 'utf8');
const service = readFileSync(resolve('deploy/claude-rpg.service'), 'utf8');
const labwcAutostart = readFileSync(resolve('deploy/labwc-autostart'), 'utf8');
const kiosk = readFileSync(resolve('scripts/pi/kiosk.sh'), 'utf8');

function assignments(key: string): string[] {
  return [...env.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))]
    .map(([, value]) => value);
}

describe('Runtime Raiders internal deployment configuration', () => {
  it('targets raiders.local while retaining the established service identifiers', () => {
    expect(setup).toContain('HOSTNAME_WANT="raiders"');
    expect(setup).toContain('mDNS: $HOSTNAME_WANT.local');
    expect(setup).toContain('http://raiders.local:');
    expect(setup).toContain('ENV_FILE="/etc/claude-rpg.env"');
    expect(setup).toContain('UNIT_DST="/etc/systemd/system/claude-rpg.service"');
    expect(setup).toContain('systemctl enable claude-rpg.service');
    expect(service).toContain('EnvironmentFile=/etc/claude-rpg.env');
  });

  it('keeps the Pi kiosk on its local loopback TV endpoint', () => {
    expect(labwcAutostart).toContain('__REPO__/scripts/pi/kiosk.sh &');
    expect(kiosk).toContain('URL="http://localhost:${PORT}/tv"');
  });

  it('keeps both hostnames in one Caddy site', () => {
    const siteHeaders = [...caddy.matchAll(/^([^\s#][^{\n]*)\{$/gm)]
      .map(([, header]) => header.trim());

    expect(siteHeaders).toEqual([
      'raiders.redlattice.com, clauderpg.redlattice.com',
    ]);
  });

  it('uses exactly one local app proxy with no additional upstream', () => {
    const reverseProxyTargets = [...caddy.matchAll(/^\s*reverse_proxy\s+(.+)$/gm)]
      .map(([, target]) => target.trim());

    expect(reverseProxyTargets).toEqual(['localhost:8080']);
  });

  it('targets the Runtime Raiders scoring configuration', () => {
    expect(env).toContain('PUBLIC_URL=https://raiders.redlattice.com');
    expect(env).toContain('SCORING_MODE=runtime-raiders');
    expect(env).toMatch(/^RAID_POWER_POLICY_PATH=__REPO__\/config\/raid-power-policy-v1\.json$/m);
    expect(env).not.toContain('OTEL_ENDPOINT_HOST=');
  });

  it('has exactly one 13-digit millisecond cutover timestamp', () => {
    const cutoverAssignments = assignments('RUN_SCORING_CUTOVER_AT');

    expect(cutoverAssignments).toHaveLength(1);
    expect(cutoverAssignments[0]).toMatch(/^\d{13}$/);
  });

  it('enables exactly the Codex Desktop and CLI surfaces once', () => {
    expect(assignments('RUN_ENABLED_SURFACES'))
      .toEqual(['codex_desktop,codex_cli']);
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

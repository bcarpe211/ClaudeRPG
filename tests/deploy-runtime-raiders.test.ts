import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const caddy = readFileSync(resolve('deploy/Caddyfile'), 'utf8');
const env = readFileSync(resolve('deploy/claude-rpg.env.example'), 'utf8');
const setup = readFileSync(resolve('scripts/pi/setup.sh'), 'utf8');
const service = readFileSync(resolve('deploy/claude-rpg.service'), 'utf8');
const labwcAutostart = readFileSync(resolve('deploy/labwc-autostart'), 'utf8');
const kiosk = readFileSync(resolve('scripts/pi/kiosk.sh'), 'utf8');
const validatorPath = resolve('scripts/pi/validate-runtime-raiders-env.sh');

function resolveCaddyFileServerPath(uri: string): string {
  const escaped = uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = caddy.match(new RegExp(`handle ${escaped} \\{([\\s\\S]*?)\\n\\t\\}`))?.[1];
  if (!block) throw new Error(`missing exact Caddy handler for ${uri}`);
  const root = block.match(/^\s*root \* (\S+)$/m)?.[1];
  if (!root) throw new Error(`missing file root for ${uri}`);
  const rewritten = block.match(/^\s*rewrite \* (\/\S+)$/m)?.[1] ?? uri;
  return join(root, rewritten);
}

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

  const artifactPaths = [
    '/install.sh',
    '/downloads/runtime-raiders-agent.zip',
    '/version',
  ];

  it('serves only the three literal companion paths from the stable public directory', () => {
    for (const path of artifactPaths) {
      expect(caddy).toContain(`handle ${path} {`);
    }
    expect([...caddy.matchAll(/^\s*handle\s+(\/\S+)\s+\{$/gm)].map(([, path]) => path))
      .toEqual(artifactPaths);
    expect(caddy.match(/root \* \/var\/lib\/runtime-raiders\/public/g))
      .toHaveLength(3);
    expect(caddy.match(/\bfile_server\b/g)).toHaveLength(3);
    expect(caddy).not.toMatch(/handle(?:_path)?\s+\/downloads\/\*/);
    expect(caddy).not.toMatch(/\bfile_server\s+browse\b/);
  });

  it('maps every public URI to the flat file written by the publisher', () => {
    expect(resolveCaddyFileServerPath('/install.sh'))
      .toBe('/var/lib/runtime-raiders/public/install.sh');
    expect(resolveCaddyFileServerPath('/downloads/runtime-raiders-agent.zip'))
      .toBe('/var/lib/runtime-raiders/public/runtime-raiders-agent.zip');
    expect(resolveCaddyFileServerPath('/version'))
      .toBe('/var/lib/runtime-raiders/public/version');
  });

  it('marks every companion response non-cacheable and non-sniffable', () => {
    expect(caddy.match(/header Cache-Control "no-store"/g)).toHaveLength(3);
    expect(caddy.match(/header X-Content-Type-Options "nosniff"/g))
      .toHaveLength(3);
    expect(caddy).toContain('header Content-Type "text/x-shellscript; charset=utf-8"');
    expect(caddy).toContain('header Content-Type "application/zip"');
    expect(caddy).toContain('header Content-Type "application/json; charset=utf-8"');
  });

  it('keeps artifact handling ahead of one matcherless app fallback', () => {
    const fallback = caddy.indexOf('handle {\n\t\treverse_proxy localhost:8080');
    expect(fallback).toBeGreaterThan(caddy.indexOf('handle /install.sh {'));
    expect(fallback).toBeGreaterThan(
      caddy.indexOf('handle /version {'),
    );
    expect(caddy.match(/handle \{\n\t\treverse_proxy localhost:8080/g))
      .toHaveLength(1);
  });

  it('targets the Runtime Raiders scoring configuration', () => {
    expect(env).toContain('PUBLIC_URL=https://raiders.redlattice.com');
    expect(env).toContain('SCORING_MODE=disabled');
    expect(env).toMatch(/^RAID_POWER_POLICY_PATH=__REPO__\/config\/raid-power-policy-v1\.json$/m);
    expect(env).not.toContain('OTEL_ENDPOINT_HOST=');
  });

  it('validates the installed environment before any service restart', () => {
    const validation = setup.indexOf('validate-runtime-raiders-env.sh');
    const restart = setup.indexOf('systemctl restart claude-rpg.service');

    expect(validation).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(validation);
    expect(setup.slice(validation, restart)).toMatch(/exit 1/);
  });

  it('rejects a placeholder runtime cutover and accepts an explicitly safe one', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-env-validation-'));
    try {
      const envFile = join(root, 'claude-rpg.env');
      const base = env
        .replaceAll('__REPO__', resolve('.'))
        .replace('ADMIN_PASSWORD=change-me-please', 'ADMIN_PASSWORD=long-private-admin-password')
        .replace('SESSION_SECRET=change-me-too', `SESSION_SECRET=${'s'.repeat(32)}`)
        .replace('SCORING_MODE=disabled', 'SCORING_MODE=runtime-raiders');
      writeFileSync(envFile, base, { mode: 0o600 });

      const rejected = spawnSync('bash', [validatorPath, '--env-file', envFile, '--repo-dir', resolve('.')], {
        encoding: 'utf8',
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toMatch(/placeholder.*RUN_SCORING_CUTOVER_AT/i);

      writeFileSync(envFile, base.replace('1800000000000', '1800000000001'), { mode: 0o600 });
      const accepted = spawnSync('bash', [validatorPath, '--env-file', envFile, '--repo-dir', resolve('.')], {
        encoding: 'utf8',
      });
      expect(accepted.status, accepted.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

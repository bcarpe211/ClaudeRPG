import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Runtime Raiders unsigned sequence-eight preflight', () => {
  it('is the canonical local fail-fast command and cannot cross a trust or deployment boundary', () => {
    const packageJSON = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const preflightPath = join(
      process.cwd(),
      'scripts/test/runtime-raiders-sequence8-preflight.sh',
    );
    const source = readFileSync(preflightPath, 'utf8');

    expect(packageJSON.scripts?.['canary:migration-preflight']).toBe(
      'bash scripts/test/runtime-raiders-sequence8-preflight.sh',
    );
    for (const required of [
      'sh -n companion/packaging/install.sh',
      'sh -n companion/legacy-sequence8/migrate.sh',
      'bash -n scripts/release/build-runtime-raiders-agent.sh',
      'bash -n scripts/release/run-runtime-raiders-gate2.sh',
      'bash -n scripts/release/prepare-runtime-raiders-sequence8-private-record.sh',
      'bash -n scripts/test/verify-runtime-raiders-signed-release.sh',
      'swift test --disable-sandbox --package-path companion',
      'tests/companion-installer.test.ts',
      'tests/runtime-raiders-onboarding.test.ts',
      'tests/runtime-raiders-publication-docs.test.ts',
      'tests/runtime-raiders-sequence8-preflight.test.ts',
      '--no-file-parallelism',
      'npm_config_offline=true',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).toMatch(/mktemp -d/);
    expect(source).toMatch(/chmod 700/);
    expect(source).toMatch(/trap .*EXIT/);
    expect(source).not.toMatch(
      /codesign|notary|stapler|spctl|ssh|scp|rsync|raiders[ \t]+on|\/var\/lib\/runtime-raiders/i,
    );
  });

  it('keeps sequence-eight migration testing before Apple trust and records the private migrator separately', () => {
    const packageJSON = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const runbook = readFileSync(
      join(process.cwd(), 'docs/runtime-raiders-companion-release-gates.md'),
      'utf8',
    );
    const gate1Start = runbook.indexOf('## Gate 1:');
    const gate2Start = runbook.indexOf('## Gate 2:');
    const gate3Start = runbook.indexOf('## Gate 3:');
    const gate1 = runbook.slice(gate1Start, gate2Start);
    const gate2 = runbook.slice(gate2Start, gate3Start);

    expect(gate1Start).toBeGreaterThan(-1);
    expect(gate2Start).toBeGreaterThan(gate1Start);
    expect(gate3Start).toBeGreaterThan(gate2Start);
    expect(gate1).toContain('npm run canary:migration-preflight');
    expect(packageJSON.scripts?.['canary:migration-preflight']).toBe(
      'bash scripts/test/runtime-raiders-sequence8-preflight.sh',
    );
    expect(gate1).toMatch(/success, near-match, rollback, and crash/i);
    expect(gate2).toMatch(/fresh-install(?:ation)? smoke/i);
    expect(gate2).toMatch(/does not read or copy the\s+installed canary/i);
    expect(gate2).not.toMatch(/copies only the installed-off sequence-8|migration failure checkpoint/i);
    expect(gate2).toContain('/bin/bash scripts/release/run-runtime-raiders-gate2.sh');
    expect(gate2).toContain(
      '/bin/bash scripts/release/prepare-runtime-raiders-sequence8-private-record.sh',
    );
    expect(gate2).not.toContain('cleanup_private_work()');
    expect(gate2).not.toContain('scripts/release/build-runtime-raiders-agent.sh \\\n');
    expect(gate2).toMatch(/must remain\s+local and unpublished/i);
  });
});

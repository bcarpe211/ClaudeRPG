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
});

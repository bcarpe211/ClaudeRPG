import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCompanionInstallCommand } from '../src/web/companion-install';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-onboarding-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Runtime Raiders canonical onboarding command', () => {
  it('exposes the shared installer bound to non-TypeScript release tools', () => {
    const output = execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/lib/runtime-raiders-artifact-contract.mjs'),
      'installer_max_bytes',
    ], { encoding: 'utf8' });

    expect(output).toBe('8388608\n');
  });

  it('makes Gate 2 and publication consume the same installer-size contract', () => {
    const helper = 'runtime-raiders-artifact-contract.mjs';
    const gate2 = readFileSync(
      join(process.cwd(), 'scripts/test/verify-runtime-raiders-signed-release.sh'),
      'utf8',
    );
    const publication = readFileSync(
      join(process.cwd(), 'scripts/pi/runtime-raiders-artifacts.sh'),
      'utf8',
    );

    expect(gate2).toContain(helper);
    expect(publication).toContain(helper);
    const reviewedSources = gate2.slice(
      gate2.indexOf('gate_verify_reviewed_source'),
      gate2.indexOf(' || {', gate2.indexOf('gate_verify_reviewed_source')),
    );
    expect(reviewedSources).toContain('scripts/lib/runtime-raiders-artifact-contract.mjs');
    expect(reviewedSources).toContain('config/runtime-raiders-artifact-contract.json');
    expect(gate2).not.toMatch(/-le 8388608/);
    expect(publication).not.toMatch(/INSTALLER_MAX_BYTES=8388608/);
  });

  it('executes a rendered installer accepted by the release builder', () => {
    const root = temporaryRoot();
    const fakeBin = join(root, 'bin');
    const installer = join(root, 'rendered-install.sh');
    const sentinel = join(root, 'executed');
    execFileSync('/bin/mkdir', ['-m', '700', fakeBin]);

    const padding = `# ${'x'.repeat(62)}\n`.repeat(16_385);
    writeFileSync(
      installer,
      `#!/bin/sh\nset -eu\n${padding}printf 'executed\\n' > "$RR_TEST_SENTINEL"\n`,
      { mode: 0o600 },
    );
    const renderedBytes = readFileSync(installer).byteLength;
    expect(renderedBytes).toBeGreaterThan(1_048_576);
    expect(renderedBytes).toBeLessThanOrEqual(8_388_608);

    const curl = join(fakeBin, 'curl');
    writeFileSync(curl, `#!/bin/sh
set -eu
output=''
maximum=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|--max-filesize)
      name="$1"; value="$2"; shift 2
      [ "$name" != --output ] || output="$value"
      [ "$name" != --max-filesize ] || maximum="$value"
      ;;
    --proto|--proto-redir|--max-redirs|--connect-timeout|--max-time|--write-out)
      shift 2
      ;;
    --fail|--silent|--show-error)
      shift
      ;;
    https://raiders.redlattice.com/install.sh)
      shift
      ;;
    *) exit 64 ;;
  esac
done
[ -n "$output" ] && [ -n "$maximum" ]
bytes="$(wc -c < "$RR_TEST_INSTALLER" | tr -d ' ')"
[ "$bytes" -le "$maximum" ] || exit 63
cp "$RR_TEST_INSTALLER" "$output"
printf 200
`);
    chmodSync(curl, 0o700);

    execFileSync('/bin/sh', ['-c', buildCompanionInstallCommand({ curlPath: curl })], {
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        RR_TEST_INSTALLER: installer,
        RR_TEST_SENTINEL: sentinel,
      },
      stdio: 'pipe',
    });

    expect(existsSync(sentinel)).toBe(true);
  });

  it('rejects a completed download larger than the shared installer limit', () => {
    const root = temporaryRoot();
    const fakeBin = join(root, 'bin');
    const installer = join(root, 'oversized-install.sh');
    const sentinel = join(root, 'executed');
    execFileSync('/bin/mkdir', ['-m', '700', fakeBin]);
    writeFileSync(
      installer,
      `#!/bin/sh\nprintf 'executed\\n' > "$RR_TEST_SENTINEL"\n# ${'x'.repeat(8_388_608)}\n`,
      { mode: 0o600 },
    );

    const curl = join(fakeBin, 'curl');
    writeFileSync(curl, `#!/bin/sh
set -eu
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --proto|--proto-redir|--max-redirs|--connect-timeout|--max-time|--max-filesize|--write-out) shift 2 ;;
    --fail|--silent|--show-error) shift ;;
    https://raiders.redlattice.com/install.sh) shift ;;
    *) exit 64 ;;
  esac
done
cp "$RR_TEST_INSTALLER" "$output"
printf 200
`);
    chmodSync(curl, 0o700);

    const result = spawnSync('/bin/sh', ['-c', buildCompanionInstallCommand({ curlPath: curl })], {
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        RR_TEST_INSTALLER: installer,
        RR_TEST_SENTINEL: sentinel,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('rejects a downloaded installer replaced with a symlink before execution', () => {
    const root = temporaryRoot();
    const fakeBin = join(root, 'bin');
    const installer = join(root, 'symlink-target-install.sh');
    const sentinel = join(root, 'executed');
    execFileSync('/bin/mkdir', ['-m', '700', fakeBin]);
    writeFileSync(
      installer,
      `#!/bin/sh\nprintf 'executed\\n' > "$RR_TEST_SENTINEL"\n`,
      { mode: 0o600 },
    );

    const curl = join(fakeBin, 'curl');
    writeFileSync(curl, `#!/bin/sh
set -eu
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --proto|--proto-redir|--max-redirs|--connect-timeout|--max-time|--max-filesize|--write-out) shift 2 ;;
    --fail|--silent|--show-error) shift ;;
    https://raiders.redlattice.com/install.sh) shift ;;
    *) exit 64 ;;
  esac
done
rm -f "$output"
ln -s "$RR_TEST_INSTALLER" "$output"
printf 200
`);
    chmodSync(curl, 0o700);

    const result = spawnSync('/bin/sh', ['-c', buildCompanionInstallCommand({ curlPath: curl })], {
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        RR_TEST_INSTALLER: installer,
        RR_TEST_SENTINEL: sentinel,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });
});

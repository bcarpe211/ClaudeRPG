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
import artifactContract from '../config/runtime-raiders-artifact-contract.json';
import { buildCompanionInstallCommand } from '../src/web/companion-install';

const roots: string[] = [];
const commandShells = [
  {
    name: 'sh',
    executable: '/bin/sh',
    args: (command: string) => ['-c', command],
  },
  {
    name: 'zsh',
    executable: '/bin/zsh',
    args: (command: string) => ['-f', '-c', command],
  },
] as const;

type CurlMode = 'success' | 'curl-failure' | 'non-200' | 'oversized' | 'symlink';

interface CommandFixture {
  curl: string;
  installer: string;
  outputRecord: string;
  sentinel: string;
  environment: NodeJS.ProcessEnv;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-onboarding-'));
  roots.push(root);
  return root;
}

function commandFixture(mode: CurlMode): CommandFixture {
  const root = temporaryRoot();
  const fakeBin = join(root, 'bin');
  const installer = join(root, 'rendered-install.sh');
  const outputRecord = join(root, 'download-path');
  const sentinel = join(root, 'executed');
  execFileSync('/bin/mkdir', ['-m', '700', fakeBin]);

  const padding = mode === 'success'
    ? `# ${'x'.repeat(62)}\n`.repeat(16_385)
    : mode === 'oversized'
      ? `# ${'x'.repeat(artifactContract.installer_max_bytes)}\n`
      : '';
  writeFileSync(
    installer,
    `#!/bin/sh\nset -eu\n${padding}printf 'executed\\n' > "$RR_TEST_SENTINEL"\n`,
    { mode: 0o600 },
  );

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
printf '%s\n' "$output" > "$RR_TEST_OUTPUT_RECORD"
case "$RR_TEST_CURL_MODE" in
  success)
    bytes="$(wc -c < "$RR_TEST_INSTALLER" | tr -d ' ')"
    [ "$bytes" -le "$maximum" ] || exit 63
    cp "$RR_TEST_INSTALLER" "$output"
    printf 200
    ;;
  curl-failure)
    exit 56
    ;;
  non-200)
    cp "$RR_TEST_INSTALLER" "$output"
    printf 503
    ;;
  oversized)
    cp "$RR_TEST_INSTALLER" "$output"
    printf 200
    ;;
  symlink)
    rm -f "$output"
    ln -s "$RR_TEST_INSTALLER" "$output"
    printf 200
    ;;
  *) exit 64 ;;
esac
`);
  chmodSync(curl, 0o700);

  return {
    curl,
    installer,
    outputRecord,
    sentinel,
    environment: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      RR_TEST_CURL_MODE: mode,
      RR_TEST_INSTALLER: installer,
      RR_TEST_OUTPUT_RECORD: outputRecord,
      RR_TEST_SENTINEL: sentinel,
    },
  };
}

function downloadedPath(fixture: CommandFixture): string {
  expect(existsSync(fixture.outputRecord)).toBe(true);
  return readFileSync(fixture.outputRecord, 'utf8').trim();
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Runtime Raiders canonical onboarding command', () => {
  it('documents only the supported local enrollment and removal procedures', () => {
    const employee = readFileSync(
      join(process.cwd(), 'docs/runtime-raiders/employee-beta.md'),
      'utf8',
    );
    const operations = readFileSync(
      join(process.cwd(), 'docs/runtime-raiders/companion-operations.md'),
      'utf8',
    );
    const documented = `${employee}\n${operations}`;

    for (const statement of [
      'Change Raider: `raiders off`, then `raiders re-enroll`.',
      'Remove the app but keep recovery state: `raiders uninstall`.',
      'Revoke and remove every local Runtime Raiders artifact: `raiders uninstall --everything`.',
      'Browser login alone never changes an installed enrollment.',
      'Neither removal mode deletes a Raider, account, Run, score, reward, or beta history.',
    ]) expect(documented).toContain(statement);
    expect(documented).not.toContain('rm -rf ~/Library/Application Support/Runtime Raiders');
  });

  it('exposes the shared installer bound to non-TypeScript release tools', () => {
    const output = execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/lib/runtime-raiders-artifact-contract.mjs'),
      'installer_max_bytes',
    ], { encoding: 'utf8' });

    expect(output).toBe('8388608\n');
  });

  it('displays the exact employee-facing installer command', () => {
    const command = buildCompanionInstallCommand();

    expect(command).toBe('curl -fsSL https://raiders.redlattice.com/install.sh | sh');
  });

  it.each(commandShells)('$name executes a builder-permitted rendered installer', (shell) => {
    const fixture = commandFixture('success');
    const renderedBytes = readFileSync(fixture.installer).byteLength;
    expect(renderedBytes).toBeGreaterThan(1_048_576);
    expect(renderedBytes).toBeLessThanOrEqual(artifactContract.installer_max_bytes);

    const command = buildCompanionInstallCommand({ curlPath: fixture.curl });
    const result = spawnSync(shell.executable, shell.args(command), {
      env: fixture.environment,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(fixture.sentinel)).toBe(true);
    expect(existsSync(downloadedPath(fixture))).toBe(false);
  });

  it.each(commandShells)('$name fails closed when curl exits nonzero', (shell) => {
    const fixture = commandFixture('curl-failure');
    const command = buildCompanionInstallCommand({ curlPath: fixture.curl });
    const result = spawnSync(shell.executable, shell.args(command), {
      env: fixture.environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(downloadedPath(fixture))).toBe(false);
  });

  it.each(commandShells)('$name fails closed when curl reports a non-200 response', (shell) => {
    const fixture = commandFixture('non-200');
    const command = buildCompanionInstallCommand({ curlPath: fixture.curl });
    const result = spawnSync(shell.executable, shell.args(command), {
      env: fixture.environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(downloadedPath(fixture))).toBe(false);
  });

  it.each(commandShells)('$name rejects a completed oversized download', (shell) => {
    const fixture = commandFixture('oversized');
    expect(readFileSync(fixture.installer).byteLength).toBeGreaterThan(
      artifactContract.installer_max_bytes,
    );
    const command = buildCompanionInstallCommand({ curlPath: fixture.curl });
    const result = spawnSync(shell.executable, shell.args(command), {
      env: fixture.environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(downloadedPath(fixture))).toBe(false);
  });

  it.each(commandShells)('$name rejects a downloaded leaf replaced by a symlink', (shell) => {
    const fixture = commandFixture('symlink');
    const command = buildCompanionInstallCommand({ curlPath: fixture.curl });
    const result = spawnSync(shell.executable, shell.args(command), {
      env: fixture.environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.sentinel)).toBe(false);
    expect(existsSync(downloadedPath(fixture))).toBe(false);
    expect(existsSync(fixture.installer)).toBe(true);
  });
});

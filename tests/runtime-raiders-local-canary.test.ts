import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const localCanarySource = join(
  process.cwd(),
  'scripts/release/install-runtime-raiders-local-canary.sh',
);
const roots: string[] = [];

function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o700);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-local-canary-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const releaseDirectory = join(repository, 'scripts/release');
  const home = join(root, 'home');
  const events = join(root, 'events.log');
  mkdirSync(join(repository, 'companion'), { recursive: true });
  mkdirSync(releaseDirectory, { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repository, 'companion/RELEASE'), 'format=1\ncompanion_version=0.4.4\n');
  writeFileSync(join(repository, '.gitignore'), 'dist/\n');
  writeFileSync(events, '');
  if (existsSync(localCanarySource)) {
    cpSync(localCanarySource, join(releaseDirectory, 'install-runtime-raiders-local-canary.sh'));
  }
  executable(join(releaseDirectory, 'release-runtime-raiders-beta.sh'), [
    '[ "$#" -eq 1 ] && [ "$1" = prepare ] || exit 64',
    'printf "prepare\\n" >> "$RR_LOCAL_EVENT_LOG"',
    'root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd -P)',
    'output="$root/dist/runtime-raiders-beta-0.4.4"',
    'mkdir -p "$output"',
    'printf "signed local archive\\n" > "$output/runtime-raiders-agent.zip"',
    'archive_sha=$(/usr/bin/shasum -a 256 "$output/runtime-raiders-agent.zip" | /usr/bin/awk "NR == 1 { print \\$1 }")',
    'git_sha=$(/usr/bin/git -C "$root" rev-parse HEAD)',
    'cat > "$output/release-summary.txt" <<EOF',
    'git_sha=$git_sha',
    'companion_version=0.4.4',
    'runtime-raiders-agent.zip_sha256=$archive_sha',
    'EOF',
    'cat > "$output/install.sh" <<\'INSTALL\'',
    '#!/bin/sh',
    'set -eu',
    '[ -f "${RUNTIME_RAIDERS_LOCAL_ARCHIVE:-}" ] || exit 65',
    'printf "install:%s\\n" "$RUNTIME_RAIDERS_LOCAL_ARCHIVE" >> "$RR_LOCAL_EVENT_LOG"',
    'support="$HOME/Library/Application Support/Runtime Raiders"',
    'agent="$support/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent"',
    'mkdir -p "${agent%/*}" "$HOME/.local/bin"',
    'cat > "$agent" <<\'AGENT\'',
    '#!/bin/sh',
    'case "$*" in',
    '  status) printf \'%s\\n\' \'{"activationState":"disabled","activeRunCount":0,"daemonRunning":true,"enabled":false,"installedCompanionVersion":"0.4.4","persistedState":"disabled","queuedEventCount":0}\';;',
    '  "__runtime-raiders-managed-agent status") printf "enabled\\n";;',
    '  *) exit 64;;',
    'esac',
    'AGENT',
    'chmod 700 "$agent"',
    'cat > "$support/raiders" <<\'SHIM\'',
    '#!/bin/sh',
    'exec "$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent" "$@"',
    'SHIM',
    'chmod 700 "$support/raiders"',
    'ln -s "$support/raiders" "$HOME/.local/bin/raiders"',
    'INSTALL',
    'chmod 700 "$output/install.sh"',
    'printf \'{"version":"0.4.4"}\\n\' > "$output/version"',
  ]);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'runtime-raiders-test@example.invalid'],
    ['config', 'user.name', 'Runtime Raiders Test'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  return { repository, home, events };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it('prepares and installs one exact local canary without publication', () => {
  const value = fixture();

  const result = spawnSync(
    '/bin/bash',
    ['scripts/release/install-runtime-raiders-local-canary.sh'],
    {
      cwd: value.repository,
      env: { ...process.env, HOME: value.home, RR_LOCAL_EVENT_LOG: value.events },
      encoding: 'utf8',
    },
  );

  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(readFileSync(value.events, 'utf8').trim().split('\n')).toEqual([
    'prepare',
    `install:${join(realpathSync(value.repository), 'dist/runtime-raiders-beta-0.4.4/runtime-raiders-agent.zip')}`,
  ]);
  expect(result.stdout).toContain('Runtime Raiders 0.4.4 local installed-off canary passed.');
  expect(result.stdout).toContain('Nothing was published.');
});

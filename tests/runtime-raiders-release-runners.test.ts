import { spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const gate2RunnerSource = join(
  process.cwd(),
  'scripts/release/run-runtime-raiders-gate2.sh',
);
const roots: string[] = [];
const quartetNames = [
  'install.sh',
  'runtime-raiders-agent.update.json',
  'runtime-raiders-agent.zip',
  'runtime-raiders-agent.zip.sha256',
];

interface Gate2Fixture {
  calls: string;
  environment: NodeJS.ProcessEnv;
  output: string;
  releaseSha: string;
  repository: string;
  runner: string;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o700);
}

function gate2Fixture(): Gate2Fixture {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-runner-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const calls = join(root, 'calls');
  mkdirSync(join(repository, 'companion'), { recursive: true });
  mkdirSync(join(repository, 'scripts/release'), { recursive: true });
  mkdirSync(join(repository, 'scripts/test'), { recursive: true });

  const runner = join(repository, 'scripts/release/run-runtime-raiders-gate2.sh');
  if (existsSync(gate2RunnerSource)) {
    copyFileSync(gate2RunnerSource, runner);
    chmodSync(runner, 0o700);
  }

  writeFileSync(
    join(repository, 'companion/RELEASE'),
    [
      'version=1',
      'companion_version=0.3.2',
      'release_sequence=11',
      'update_protocol_version=2',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repository, '.gitignore'), '/dist/\n');

  executable(join(repository, 'scripts/release/build-runtime-raiders-agent.sh'), `#!/bin/bash
set -euo pipefail
test "$#" -eq 4
test "$1" = --release-sha
release_sha="$2"
test "$3" = --output
output="$4"
test "$release_sha" = "$(/usr/bin/git rev-parse HEAD)"
test "$output" = "$PWD/dist/sequence-11-$release_sha"
printf 'builder\n' >> "$RR_RUNNER_CALLS"
/bin/mkdir "$output"
printf 'installer\n' > "$output/install.sh"
printf 'zip\n' > "$output/runtime-raiders-agent.zip"
printf 'checksum\n' > "$output/runtime-raiders-agent.zip.sha256"
printf 'manifest\n' > "$output/runtime-raiders-agent.update.json"
`);
  executable(join(repository, 'scripts/test/verify-runtime-raiders-signed-release.sh'), `#!/bin/bash
set -euo pipefail
test "$#" -eq 1
output="$1"
actual="$(find "$output" -mindepth 1 -maxdepth 1 -exec basename {} \\; | LC_ALL=C sort)"
expected="$(printf '%s\n' install.sh runtime-raiders-agent.update.json runtime-raiders-agent.zip runtime-raiders-agent.zip.sha256)"
test "$actual" = "$expected"
printf 'reviewer\n' >> "$RR_RUNNER_CALLS"
`);

  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'runner@example.invalid'], {
    cwd: repository,
  });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Release Runner Test'], {
    cwd: repository,
  });
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: repository });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'release runner fixture'], {
    cwd: repository,
  });
  const releaseSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();

  return {
    calls,
    environment: {
      ...process.env,
      RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
      RUNTIME_RAIDERS_NOTARY_PROFILE: 'test-notary-profile',
      RUNTIME_RAIDERS_TEAM_ID: 'ABCDE12345',
      RR_RUNNER_CALLS: calls,
    },
    output: join(repository, 'dist', `sequence-11-${releaseSha}`),
    releaseSha,
    repository,
    runner,
  };
}

function runGate2(
  fixture: Gate2Fixture,
  environment = fixture.environment,
) {
  return spawnSync('/bin/bash', [fixture.runner], {
    cwd: fixture.repository,
    env: environment,
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Runtime Raiders Gate 2 release runner', () => {
  it('creates and reviews one immutable signed quartet from clean release source', () => {
    const fixture = gate2Fixture();

    const result = runGate2(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readdirSync(fixture.output).sort()).toEqual(quartetNames);
    expect(readFileSync(fixture.calls, 'utf8')).toBe('builder\nreviewer\n');
    const hashLines = result.stdout.trim().split('\n');
    const physicalOutput = realpathSync(fixture.output);
    expect(hashLines).toHaveLength(4);
    for (const name of [
      'install.sh',
      'runtime-raiders-agent.zip',
      'runtime-raiders-agent.zip.sha256',
      'runtime-raiders-agent.update.json',
    ]) {
      const line = hashLines.find((candidate) => candidate.endsWith(`  ${join(physicalOutput, name)}`));
      expect(line?.slice(0, 64)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each(['tracked', 'untracked'] as const)(
    'refuses a dirty %s worktree before invoking release tools',
    (kind) => {
      const fixture = gate2Fixture();
      if (kind === 'tracked') {
        writeFileSync(
          join(fixture.repository, 'companion/RELEASE'),
          readFileSync(join(fixture.repository, 'companion/RELEASE'), 'utf8') + '# dirty\n',
        );
      } else {
        writeFileSync(join(fixture.repository, 'untracked'), 'dirty\n');
      }

      const result = runGate2(fixture);

      expect(result.status).toBe(64);
      expect(result.stderr).toContain('Gate 2 requires a clean Git worktree');
      expect(existsSync(fixture.calls)).toBe(false);
      expect(existsSync(fixture.output)).toBe(false);
    },
  );

  it('refuses a pre-existing immutable output before invoking release tools', () => {
    const fixture = gate2Fixture();
    mkdirSync(fixture.output, { recursive: true });

    const result = runGate2(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Gate 2 release output must be absent');
    expect(existsSync(fixture.calls)).toBe(false);
  });

  it('refuses a missing release credential before invoking release tools', () => {
    const fixture = gate2Fixture();
    const environment = { ...fixture.environment };
    delete environment.RUNTIME_RAIDERS_NOTARY_PROFILE;

    const result = runGate2(fixture, environment);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('RUNTIME_RAIDERS_NOTARY_PROFILE is required');
    expect(existsSync(fixture.calls)).toBe(false);
    expect(existsSync(fixture.output)).toBe(false);
  });
});

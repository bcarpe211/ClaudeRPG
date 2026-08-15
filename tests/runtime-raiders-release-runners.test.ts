import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
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
const privateRecordRunnerSource = join(
  process.cwd(),
  'scripts/release/prepare-runtime-raiders-sequence8-private-record.sh',
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

interface PrivateRecordFixture {
  calls: string;
  dist: string;
  environment: NodeJS.ProcessEnv;
  output: string;
  rendererStarted: string;
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

function privateRecordFixture(): PrivateRecordFixture {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-private-runner-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const calls = join(root, 'calls');
  const rendererStarted = join(root, 'renderer-started');
  mkdirSync(join(repository, 'companion/legacy-sequence8'), { recursive: true });
  mkdirSync(join(repository, 'scripts/release'), { recursive: true });

  const runner = join(
    repository,
    'scripts/release/prepare-runtime-raiders-sequence8-private-record.sh',
  );
  if (existsSync(privateRecordRunnerSource)) {
    copyFileSync(privateRecordRunnerSource, runner);
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
  writeFileSync(
    join(repository, 'companion/legacy-sequence8/migrate.sh'),
    '#!/bin/sh\nexit 0\n',
  );
  writeFileSync(join(repository, '.gitignore'), '/dist/\n');

  executable(
    join(repository, 'scripts/release/build-runtime-raiders-release-validator.sh'),
    `#!/bin/bash
set -euo pipefail
test "$#" -eq 3
package="$1"
scratch="$2"
output="$3"
printf 'validator|%s|%s|%s\n' "$package" "$scratch" "$output" >> "$RR_PRIVATE_CALLS"
test ! -e "$scratch" && test ! -L "$scratch"
/bin/mkdir "$scratch"
case "$RR_PRIVATE_VALIDATOR_MODE" in
  match) printf 'known validator bytes\n' > "$output" ;;
  mismatch) printf 'different validator bytes\n' > "$output" ;;
  *) exit 64 ;;
esac
/bin/rm -rf "$scratch"
`,
  );
  executable(join(repository, 'scripts/release/render-runtime-raiders-installer.sh'), `#!/bin/bash
set -euo pipefail
test "$#" -eq 8
printf 'renderer|%s|%s|%s|%s|%s|%s|%s|%s\n' "$@" >> "$RR_PRIVATE_CALLS"
case "$RR_PRIVATE_RENDERER_MODE" in
  success)
    printf '#!/bin/sh\nexit 0\n' > "$8"
    chmod 755 "$8"
    ;;
  failure)
    printf 'partial\n' > "$8"
    exit 72
    ;;
  block)
    printf 'started\n' > "$RR_PRIVATE_RENDERER_STARTED"
    trap 'exit 143' TERM
    while :; do /bin/sleep 1; done
    ;;
  *) exit 64 ;;
esac
`);

  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'runner@example.invalid'], {
    cwd: repository,
  });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Private Runner Test'], {
    cwd: repository,
  });
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: repository });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'private runner fixture'], {
    cwd: repository,
  });
  const releaseSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const dist = join(repository, 'dist');
  const releaseOutput = join(dist, `sequence-11-${releaseSha}`);
  mkdirSync(releaseOutput, { recursive: true });
  const validatorSha = createHash('sha256')
    .update('known validator bytes\n')
    .digest('hex');
  writeFileSync(
    join(releaseOutput, 'install.sh'),
    `#!/bin/sh\nRELEASE_VALIDATOR_SHA256='${validatorSha}'\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(releaseOutput, 'runtime-raiders-agent.zip'), 'zip\n');
  writeFileSync(join(releaseOutput, 'runtime-raiders-agent.zip.sha256'), 'checksum\n');
  writeFileSync(join(releaseOutput, 'runtime-raiders-agent.update.json'), 'manifest\n');

  return {
    calls,
    dist,
    environment: {
      ...process.env,
      RUNTIME_RAIDERS_TEAM_ID: 'ABCDE12345',
      RR_PRIVATE_CALLS: calls,
      RR_PRIVATE_RENDERER_MODE: 'success',
      RR_PRIVATE_RENDERER_STARTED: rendererStarted,
      RR_PRIVATE_VALIDATOR_MODE: 'match',
    },
    output: join(dist, `private-sequence-8-11-${releaseSha}`),
    rendererStarted,
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

function runPrivateRecord(
  fixture: PrivateRecordFixture,
  environment = fixture.environment,
) {
  return spawnSync('/bin/bash', [fixture.runner], {
    cwd: fixture.repository,
    env: environment,
    encoding: 'utf8',
  });
}

function privateWorkEntries(fixture: PrivateRecordFixture): string[] {
  return readdirSync(fixture.dist)
    .filter((name) => name.startsWith('.private-sequence-8-work.'));
}

async function waitForFileOrExit(
  path: string,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) {
      throw new Error(`runner exited before renderer start: ${child.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for renderer start');
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

describe('Runtime Raiders private sequence-eight record runner', () => {
  it('atomically creates exactly the validator and migrator with external scratch', () => {
    const fixture = privateRecordFixture();

    const result = runPrivateRecord(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readdirSync(fixture.output).sort()).toEqual([
      'migrate-sequence-8.sh',
      'runtime-raiders-release-validator',
    ]);
    expect(privateWorkEntries(fixture)).toEqual([]);
    const calls = readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    const [, , validatorScratch, stagedValidator] = calls[0].split('|');
    expect(validatorScratch).toMatch(/\/validator-scratch$/);
    expect(validatorScratch).not.toContain('/private-record/');
    expect(stagedValidator).toContain('/private-record/');
    expect(calls[1]).toMatch(/^renderer\|/);
    const hashLines = result.stdout.trim().split('\n');
    const physicalOutput = realpathSync(fixture.output);
    expect(hashLines).toHaveLength(2);
    for (const name of [
      'runtime-raiders-release-validator',
      'migrate-sequence-8.sh',
    ]) {
      const line = hashLines.find((candidate) =>
        candidate.endsWith(`  ${join(physicalOutput, name)}`));
      expect(line?.slice(0, 64)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('removes private work and leaves no final record when rendering fails', () => {
    const fixture = privateRecordFixture();
    const environment = {
      ...fixture.environment,
      RR_PRIVATE_RENDERER_MODE: 'failure',
    };

    const result = runPrivateRecord(fixture, environment);

    expect(result.status).toBe(72);
    expect(existsSync(fixture.output)).toBe(false);
    expect(privateWorkEntries(fixture)).toEqual([]);
  });

  it('fails before rendering and cleans work when the validator digest mismatches', () => {
    const fixture = privateRecordFixture();
    const environment = {
      ...fixture.environment,
      RR_PRIVATE_VALIDATOR_MODE: 'mismatch',
    };

    const result = runPrivateRecord(fixture, environment);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private validator does not match public installer');
    expect(readFileSync(fixture.calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(fixture.output)).toBe(false);
    expect(privateWorkEntries(fixture)).toEqual([]);
  });

  it('refuses a pre-existing immutable private record before invoking tools', () => {
    const fixture = privateRecordFixture();
    mkdirSync(fixture.output);

    const result = runPrivateRecord(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private sequence-eight output must be absent');
    expect(existsSync(fixture.calls)).toBe(false);
    expect(privateWorkEntries(fixture)).toEqual([]);
  });

  it('refuses a dirty worktree before invoking private-record tools', () => {
    const fixture = privateRecordFixture();
    writeFileSync(join(fixture.repository, 'untracked'), 'dirty\n');

    const result = runPrivateRecord(fixture);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('private record requires a clean Git worktree');
    expect(existsSync(fixture.calls)).toBe(false);
    expect(existsSync(fixture.output)).toBe(false);
    expect(privateWorkEntries(fixture)).toEqual([]);
  });

  it('removes private work without creating a record when interrupted', async () => {
    const fixture = privateRecordFixture();
    const environment = {
      ...fixture.environment,
      RR_PRIVATE_RENDERER_MODE: 'block',
    };
    const child = spawn('/bin/bash', [fixture.runner], {
      cwd: fixture.repository,
      detached: true,
      env: environment,
      stdio: 'ignore',
    });

    await waitForFileOrExit(fixture.rendererStarted, child);
    process.kill(-child.pid!, 'SIGTERM');
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];

    expect(code === 143 || signal === 'SIGTERM').toBe(true);
    expect(existsSync(fixture.output)).toBe(false);
    expect(privateWorkEntries(fixture)).toEqual([]);
  });
});

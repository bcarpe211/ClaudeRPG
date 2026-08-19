import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const releaseScript = resolve('scripts/release/release-runtime-raiders-beta.sh');
const publisherScript = resolve('scripts/pi/publish-runtime-raiders-beta.sh');
const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function executable(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${lines.join('\n')}\n`, { mode: 0o700 });
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
  });
}

function git(repository: string, ...args: string[]): void {
  const result = run('/usr/bin/git', args, { cwd: repository });
  expect(result.status, result.stderr).toBe(0);
}

function makeReleaseFixture(): {
  repository: string;
  remoteRoot: string;
  env: NodeJS.ProcessEnv;
  builderLog: string;
  verifierLog: string;
  sshLog: string;
  curlLog: string;
} {
  const repository = temporaryRoot('runtime-raiders-release-');
  const remoteRoot = temporaryRoot('runtime-raiders-remote-');
  const tools = join(repository, 'test-tools');
  const builderLog = join(repository, '.builder-log');
  const verifierLog = join(repository, '.verifier-log');
  const sshLog = join(repository, '.ssh-log');
  const curlLog = join(repository, '.curl-log');

  for (const path of [
    'scripts/release/release-runtime-raiders-beta.sh',
    'scripts/pi/publish-runtime-raiders-beta.sh',
  ]) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    cpSync(resolve(path), join(repository, path));
    chmodSync(join(repository, path), 0o700);
  }
  mkdirSync(join(repository, 'companion'), { recursive: true });
  writeFileSync(join(repository, 'companion/RELEASE'), 'format=1\ncompanion_version=0.4.0\n');

  executable(join(tools, 'builder'), [
    `printf 'builder\\n' >> '${builderLog}'`,
    `output='${repository}/dist/runtime-raiders-beta-0.4.0'`,
    '/bin/mkdir -m 700 -p "$output"',
    "printf '#!/bin/sh\\nexit 0\\n' > \"$output/install.sh\"",
    '/bin/chmod 700 "$output/install.sh"',
    "printf 'signed zip\\n' > \"$output/runtime-raiders-agent.zip\"",
    "printf '{\"version\":\"0.4.0\"}\\n' > \"$output/version\"",
    "printf 'git_sha=pending\\ncompanion_version=0.4.0\\n' > \"$output/release-summary.txt\"",
  ]);
  executable(join(tools, 'verifier'), [
    `printf 'verify:%s\\n' "$1" >> '${verifierLog}'`,
    '[ "${FAIL_VERIFIER:-0}" = 0 ] || exit 1',
    '[ -x "$1/install.sh" ]',
    '[ -s "$1/runtime-raiders-agent.zip" ]',
    `/usr/bin/cmp -s "$1/version" <(printf '{\"version\":\"0.4.0\"}\\n')`,
    '[ "${MUTATE_DURING_VERIFIER:-0}" = 0 ] || printf "changed\\n" >> "$1/runtime-raiders-agent.zip"',
  ]);
  executable(join(tools, 'ssh'), [
    `printf '%s\\n' "$*" >> '${sshLog}'`,
    '/bin/bash -s',
    `[ "${'$'}{CORRUPT_PUBLIC_ARCHIVE:-0}" = 0 ] || printf 'corrupt\\n' > '${remoteRoot}/public/runtime-raiders-agent.zip'`,
  ]);
  executable(join(tools, 'curl'), [
    `printf '%s\\n' "${'$'}{@: -1}" >> '${curlLog}'`,
    `url="${'$'}{@: -1}"`,
    `case "$url" in`,
    `  https://raiders.redlattice.com/install.sh) file='${remoteRoot}/public/install.sh' ;;`,
    `  https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip) file='${remoteRoot}/public/runtime-raiders-agent.zip' ;;`,
    `  https://raiders.redlattice.com/version) file='${remoteRoot}/public/version' ;;`,
    `  https://raiders.redlattice.com/health) printf '{\"ok\":true}\\n'; exit 0 ;;`,
    `  *) exit 22 ;;`,
    `esac`,
    '[ -s "$file" ]',
    'output=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = -o ]; then output="$2"; shift 2; else shift; fi',
    'done',
    'if [ -n "$output" ]; then /bin/cp "$file" "$output"; else /bin/cat "$file"; fi',
  ]);

  git(repository, 'init', '-q');
  git(repository, 'config', 'user.email', 'tests@example.invalid');
  git(repository, 'config', 'user.name', 'Runtime Raiders Tests');
  git(repository, 'add', 'companion', 'scripts');
  git(repository, 'commit', '-qm', 'fixture');

  return {
    repository,
    remoteRoot,
    builderLog,
    verifierLog,
    sshLog,
    curlLog,
    env: {
      ...process.env,
      RUNTIME_RAIDERS_TEST_MODE: '1',
      RUNTIME_RAIDERS_TEST_ROOT: repository,
      RUNTIME_RAIDERS_TEST_BUILDER: join(tools, 'builder'),
      RUNTIME_RAIDERS_TEST_VERIFIER: join(tools, 'verifier'),
      RUNTIME_RAIDERS_TEST_SSH: join(tools, 'ssh'),
      RUNTIME_RAIDERS_TEST_CURL: join(tools, 'curl'),
      RUNTIME_RAIDERS_TEST_PUBLISH_ROOT: remoteRoot,
      RUNTIME_RAIDERS_RELEASE_HOST: 'release-user@raiders.test',
    },
  };
}

function makeStagingFixture(): {
  repository: string;
  publishRoot: string;
  staging: string;
  env: NodeJS.ProcessEnv;
} {
  const repository = temporaryRoot('runtime-raiders-publisher-');
  const publishRoot = temporaryRoot('runtime-raiders-public-root-');
  const staging = join(publishRoot, 'staging', 'release-0123456789abcdef');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(join(publishRoot, 'staging'), 0o700);
  chmodSync(staging, 0o700);
  mkdirSync(join(repository, 'scripts/pi'), { recursive: true });
  cpSync(publisherScript, join(repository, 'scripts/pi/publish-runtime-raiders-beta.sh'));
  chmodSync(join(repository, 'scripts/pi/publish-runtime-raiders-beta.sh'), 0o700);
  writeFileSync(join(staging, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(staging, 'runtime-raiders-agent.zip'), 'signed zip\n', { mode: 0o600 });
  writeFileSync(join(staging, 'version'), '{"version":"0.4.0"}\n', { mode: 0o600 });
  return {
    repository,
    publishRoot,
    staging,
    env: {
      ...process.env,
      RUNTIME_RAIDERS_TEST_MODE: '1',
      RUNTIME_RAIDERS_TEST_ROOT: repository,
      RUNTIME_RAIDERS_TEST_PUBLISH_ROOT: publishRoot,
    },
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('Runtime Raiders beta release entry point', () => {
  it('accepts only prepare and publish', () => {
    const value = makeReleaseFixture();
    for (const args of [[], ['ship'], ['prepare', 'extra']]) {
      const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', ...args], {
        cwd: value.repository,
        env: value.env,
      });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('usage:');
    }
  });

  it('prepares one verified deterministic release without external contact', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'prepare'], {
      cwd: value.repository,
      env: value.env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(value.builderLog, 'utf8')).toBe('builder\n');
    expect(readFileSync(value.verifierLog, 'utf8')).toBe(
      `verify:${value.repository}/dist/runtime-raiders-beta-0.4.0\n`,
    );
    expect(existsSync(value.sshLog)).toBe(false);
    expect(existsSync(value.curlLog)).toBe(false);
    expect(result.stdout).toContain('Prepared Runtime Raiders 0.4.0 locally.');
    expect(result.stdout).toContain('Nothing was published or installed.');
    expect(result.stdout).toContain('/bin/bash scripts/release/release-runtime-raiders-beta.sh publish');
  });

  it('fails closed on dirty source or failed local verification', () => {
    const dirty = makeReleaseFixture();
    writeFileSync(join(dirty.repository, 'companion/RELEASE'), 'format=1\ncompanion_version=0.4.1\n');
    const dirtyResult = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'prepare'], {
      cwd: dirty.repository,
      env: dirty.env,
    });
    expect(dirtyResult.status).not.toBe(0);
    expect(existsSync(dirty.builderLog)).toBe(false);

    const failed = makeReleaseFixture();
    const prepared = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'prepare'], {
      cwd: failed.repository,
      env: failed.env,
    });
    expect(prepared.status, prepared.stderr).toBe(0);
    const publishResult = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: failed.repository,
      env: { ...failed.env, FAIL_VERIFIER: '1' },
    });
    expect(publishResult.status).not.toBe(0);
    expect(existsSync(failed.sshLog)).toBe(false);
  });

  it('refuses release files that change while local verification runs', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: { ...value.env, MUTATE_DURING_VERIFIER: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('changed during local verification');
    expect(existsSync(value.sshLog)).toBe(false);
  });

  it('publishes through one session, checks four public URLs, and leaves collection off', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: value.env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(value.sshLog, 'utf8').trim().split('\n')).toEqual([
      'release-user@raiders.test /usr/bin/sudo /bin/bash -s',
    ]);
    expect(readFileSync(value.curlLog, 'utf8').trim().split('\n')).toEqual([
      'https://raiders.redlattice.com/install.sh',
      'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
      'https://raiders.redlattice.com/version',
      'https://raiders.redlattice.com/health',
    ]);
    expect(readdirSync(join(value.remoteRoot, 'public')).sort()).toEqual([
      'install.sh',
      'runtime-raiders-agent.zip',
      'version',
    ]);
    expect(result.stdout).toContain('Runtime Raiders 0.4.0 published.');
    expect(result.stdout).toMatch(/Git SHA: [0-9a-f]{40}/);
    expect(result.stdout).toContain('https://raiders.redlattice.com/install.sh');
    expect(result.stdout).toContain('https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip');
    expect(result.stdout).toContain('https://raiders.redlattice.com/version');
    expect(result.stdout).toContain('Employee collection remains off.');
  });

  it('rejects a public archive that differs from the verified local release', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: { ...value.env, CORRUPT_PUBLIC_ARCHIVE: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('public archive mismatch');
  });
});

describe('Runtime Raiders root publisher', () => {
  it('publishes exactly three safe files and consumes the private staging directory', () => {
    const value = makeStagingFixture();
    const result = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', value.staging], {
      cwd: value.repository,
      env: value.env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(value.publishRoot, 'public')).sort()).toEqual([
      'install.sh',
      'runtime-raiders-agent.zip',
      'version',
    ]);
    expect(existsSync(value.staging)).toBe(false);
    expect(statSync(join(value.publishRoot, 'public')).mode & 0o022).toBe(0);
  });

  it('refuses staging outside the exact private root or with extra and unsafe members', () => {
    const outside = makeStagingFixture();
    const outsidePath = join(outside.publishRoot, 'elsewhere');
    cpSync(outside.staging, outsidePath, { recursive: true });
    const outsideResult = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', outsidePath], {
      cwd: outside.repository,
      env: outside.env,
    });
    expect(outsideResult.status).not.toBe(0);

    const extra = makeStagingFixture();
    writeFileSync(join(extra.staging, 'extra'), 'no\n');
    const extraResult = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', extra.staging], {
      cwd: extra.repository,
      env: extra.env,
    });
    expect(extraResult.status).not.toBe(0);

    const writable = makeStagingFixture();
    chmodSync(writable.staging, 0o777);
    const writableResult = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', writable.staging], {
      cwd: writable.repository,
      env: writable.env,
    });
    expect(writableResult.status).not.toBe(0);
  });

  it('keeps the old public version visible when installation fails before version', () => {
    const value = makeStagingFixture();
    mkdirSync(join(value.publishRoot, 'public'), { mode: 0o755 });
    writeFileSync(join(value.publishRoot, 'public/version'), '{"version":"0.3.7"}\n');
    const failMv = join(value.repository, 'fail-mv');
    executable(failMv, [
      'count_file="${RUNTIME_RAIDERS_TEST_ROOT}/.mv-count"',
      'count=0; [ ! -f "$count_file" ] || count="$(/bin/cat "$count_file")"',
      'count=$((count + 1)); printf "%s" "$count" > "$count_file"',
      '[ "$count" -ne 2 ] || exit 1',
      '/bin/mv "$@"',
    ]);
    const result = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', value.staging], {
      cwd: value.repository,
      env: { ...value.env, RUNTIME_RAIDERS_TEST_MV: failMv },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(value.publishRoot, 'public/version'), 'utf8')).toBe('{"version":"0.3.7"}\n');
  });
});

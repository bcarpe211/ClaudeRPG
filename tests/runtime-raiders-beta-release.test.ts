import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer } = {}) {
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
  mutationHook: string;
  transmissionCopyHook: string;
} {
  const repository = temporaryRoot('runtime-raiders-release-');
  const remoteRoot = temporaryRoot('runtime-raiders-remote-');
  const tools = join(repository, 'test-tools');
  const builderLog = join(repository, '.builder-log');
  const verifierLog = join(repository, '.verifier-log');
  const sshLog = join(repository, '.ssh-log');
  const curlLog = join(repository, '.curl-log');
  const mutationHook = join(tools, 'mutate-before-transmission');
  const transmissionCopyHook = join(tools, 'mutate-during-transmission-copy');
  mkdirSync(join(remoteRoot, 'staging'), { mode: 0o700 });

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
    '[ "${BOOTSTRAP_MISSING:-0}" = 0 ] || { echo "fixed publisher unavailable" >&2; exit 127; }',
    '[ "${SUDO_FAILURE:-0}" = 0 ] || { echo "sudo permission denied" >&2; exit 1; }',
    `/bin/bash '${repository}/scripts/pi/publish-runtime-raiders-beta.sh' "${'$'}{@: -1}"`,
    `[ "${'$'}{CORRUPT_PUBLIC_ARCHIVE:-0}" = 0 ] || printf 'corrupt\\n' > '${remoteRoot}/public/runtime-raiders-agent.zip'`,
  ]);
  executable(mutationHook, [
    'printf "changed after private verification\\n" >> "$1/runtime-raiders-agent.zip"',
  ]);
  executable(transmissionCopyHook, [
    '[ "$1" != version ] || printf "changed during transmission copy\\n" >> "$2/version"',
  ]);
  executable(join(tools, 'curl'), [
    `printf '%s\\n' "${'$'}{@: -1}" >> '${curlLog}'`,
    `url="${'$'}{@: -1}"`,
    `case "$url" in`,
    `  https://raiders.redlattice.com/install.sh) file='${remoteRoot}/public/install.sh' ;;`,
    `  https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip) file='${remoteRoot}/public/runtime-raiders-agent.zip' ;;`,
    `  https://raiders.redlattice.com/version) file='${remoteRoot}/public/version' ;;`,
    `  https://raiders.redlattice.com/health) printf '{\"ok\":true}'; exit 0 ;;`,
    `  *) exit 22 ;;`,
    `esac`,
    '[ -s "$file" ]',
    'output=""',
    'headers=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = -o ]; then output="$2"; shift 2',
    '  elif [ "$1" = -D ]; then headers="$2"; shift 2',
    '  else shift; fi',
    'done',
    'if [ -n "$headers" ]; then',
    '  content_type="application/octet-stream"',
    '  case "$url" in *install.sh) content_type="text/x-shellscript; charset=utf-8" ;; *agent.zip) content_type="application/zip" ;; *version) content_type="application/json; charset=utf-8" ;; esac',
    '  cache_control="no-store"; [ "${BAD_PUBLIC_HEADERS:-0}" = 0 ] || cache_control="public, max-age=3600"',
    '  case "${PUBLIC_HEADER_MODE:-single}" in',
    '    interim-valid-final-missing) printf "HTTP/1.1 200 Connection established\\r\\nX-Content-Type-Options: nosniff\\r\\n\\r\\nHTTP/2 200\\r\\nContent-Type: %s\\r\\nCache-Control: no-store\\r\\n\\r\\n" "$content_type" > "$headers" ;;',
    '    interim-missing-final-valid) printf "HTTP/1.1 200 Connection established\\r\\nProxy-Agent: fixture\\r\\n\\r\\nHTTP/2 200\\r\\nContent-Type: %s\\r\\nCache-Control: no-store\\r\\nX-Content-Type-Options: nosniff\\r\\n\\r\\n" "$content_type" > "$headers" ;;',
    '    final-missing-trailer) printf "HTTP/2 200\\r\\nContent-Type: %s\\r\\nCache-Control: no-store\\r\\n\\r\\nX-Content-Type-Options: nosniff\\r\\n" "$content_type" > "$headers" ;;',
    '    final-valid-with-trailer) printf "HTTP/2 200\\r\\nContent-Type: %s\\r\\nCache-Control: no-store\\r\\nX-Content-Type-Options: nosniff\\r\\n\\r\\nX-Content-Type-Options: unsafe-trailer\\r\\n" "$content_type" > "$headers" ;;',
    '    *) printf "HTTP/2 200\\r\\nContent-Type: %s\\r\\nCache-Control: %s\\r\\nX-Content-Type-Options: nosniff\\r\\n\\r\\n" "$content_type" "$cache_control" > "$headers" ;;',
    '  esac',
    'fi',
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
    mutationHook,
    transmissionCopyHook,
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
      RUNTIME_RAIDERS_RELEASE_USER: 'release-user',
    },
  };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function makeTransmissionFixture(options: { wrongHash?: boolean; symlinkInstaller?: boolean } = {}): {
  repository: string;
  publishRoot: string;
  staging: string;
  transmission: Buffer;
  env: NodeJS.ProcessEnv;
} {
  const repository = temporaryRoot('runtime-raiders-transmission-publisher-');
  const publishRoot = temporaryRoot('runtime-raiders-transmission-root-');
  const payload = temporaryRoot('runtime-raiders-transmission-payload-');
  const staging = join(publishRoot, 'staging', 'release-0123456789abcdef');
  mkdirSync(join(publishRoot, 'staging'), { mode: 0o700 });
  mkdirSync(join(repository, 'scripts/pi'), { recursive: true });
  cpSync(publisherScript, join(repository, 'scripts/pi/publish-runtime-raiders-beta.sh'));
  chmodSync(join(repository, 'scripts/pi/publish-runtime-raiders-beta.sh'), 0o700);
  if (options.symlinkInstaller) {
    writeFileSync(join(publishRoot, 'outside-sentinel'), '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    symlinkSync(join(publishRoot, 'outside-sentinel'), join(payload, 'install.sh'));
  } else {
    writeFileSync(join(payload, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  writeFileSync(join(payload, 'runtime-raiders-agent.zip'), 'signed zip\n', { mode: 0o600 });
  writeFileSync(join(payload, 'version'), '{"version":"0.4.0"}\n', { mode: 0o600 });
  const archiveHash = options.wrongHash ? '0'.repeat(64) : sha256(join(payload, 'runtime-raiders-agent.zip'));
  writeFileSync(join(payload, 'expected-sha256'), [
    `install.sh=${sha256(join(payload, 'install.sh'))}`,
    `runtime-raiders-agent.zip=${archiveHash}`,
    `version=${sha256(join(payload, 'version'))}`,
    '',
  ].join('\n'), { mode: 0o600 });
  const tarPath = join(repository, 'transmission.tar');
  const tar = run('/usr/bin/tar', [
    '-cf', tarPath, '-C', payload,
    'install.sh', 'runtime-raiders-agent.zip', 'version', 'expected-sha256',
  ]);
  expect(tar.status, tar.stderr).toBe(0);
  return {
    repository,
    publishRoot,
    staging,
    transmission: readFileSync(tarPath),
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
    const sshCalls = readFileSync(value.sshLog, 'utf8').trim().split('\n');
    expect(sshCalls).toHaveLength(1);
    expect(sshCalls[0]).toBe(
      `release-user@raiders.test /usr/bin/sudo -n /usr/local/sbin/runtime-raiders-publish ${value.remoteRoot}/staging/${sshCalls[0].split('/').at(-1)}`,
    );
    expect(sshCalls[0].split('/').at(-1)).toMatch(/^release-[0-9a-f]{32}$/);
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

  it('defaults publication to the release user at the corporate FQDN', () => {
    const value = makeReleaseFixture();
    const environment = { ...value.env };
    delete environment.RUNTIME_RAIDERS_RELEASE_HOST;

    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: environment,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(value.sshLog, 'utf8')).toContain(
      'release-user@raiders.redlattice.com /usr/bin/sudo -n /usr/local/sbin/runtime-raiders-publish ',
    );
  });

  it('refuses mutation after private verification before opening SSH', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: {
        ...value.env,
        RUNTIME_RAIDERS_TEST_BEFORE_TRANSMISSION: value.mutationHook,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('changed before transmission was sealed');
    expect(existsSync(value.sshLog)).toBe(false);
  });

  it('refuses mutation during transmission copying before opening SSH', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: {
        ...value.env,
        RUNTIME_RAIDERS_TEST_DURING_TRANSMISSION_COPY: value.transmissionCopyHook,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('private release changed while sealing transmission');
    expect(existsSync(value.sshLog)).toBe(false);
  });

  it('fails closed when the one-time Pi bootstrap is absent', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: { ...value.env, BOOTSTRAP_MISSING: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fixed publisher unavailable');
    expect(readFileSync(value.sshLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(value.remoteRoot, 'public/version'))).toBe(false);
  });

  it('rejects incorrect live release headers after publication', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: { ...value.env, BAD_PUBLIC_HEADERS: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('public release headers are invalid');
  });

  it('validates required headers only in the final HTTP response block', () => {
    const missingFinal = makeReleaseFixture();
    const missingResult = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: missingFinal.repository,
      env: { ...missingFinal.env, PUBLIC_HEADER_MODE: 'interim-valid-final-missing' },
    });
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toContain('public release headers are invalid');

    const validFinal = makeReleaseFixture();
    const validResult = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: validFinal.repository,
      env: { ...validFinal.env, PUBLIC_HEADER_MODE: 'interim-missing-final-valid' },
    });
    expect(validResult.status, validResult.stderr).toBe(0);
  });

  it('ignores trailer fields after the final HTTP header section', () => {
    const missingHeader = makeReleaseFixture();
    const missingResult = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: missingHeader.repository,
      env: { ...missingHeader.env, PUBLIC_HEADER_MODE: 'final-missing-trailer' },
    });
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toContain('public release headers are invalid');

    const validHeaders = makeReleaseFixture();
    const validResult = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: validHeaders.repository,
      env: { ...validHeaders.env, PUBLIC_HEADER_MODE: 'final-valid-with-trailer' },
    });
    expect(validResult.status, validResult.stderr).toBe(0);
  });

  it('requires the configured release user to match the SSH host user', () => {
    for (const releaseUser of ['other-user', 'invalid;user']) {
      const value = makeReleaseFixture();
      const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
        cwd: value.repository,
        env: { ...value.env, RUNTIME_RAIDERS_RELEASE_USER: releaseUser },
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(value.sshLog)).toBe(false);
    }
  });

  it('fails closed when the fixed publisher sudo invocation is denied', () => {
    const value = makeReleaseFixture();
    const result = run('/bin/bash', ['scripts/release/release-runtime-raiders-beta.sh', 'publish'], {
      cwd: value.repository,
      env: { ...value.env, SUDO_FAILURE: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sudo permission denied');
    expect(existsSync(join(value.remoteRoot, 'public/version'))).toBe(false);
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
  it('publishes only a sealed transmission whose embedded hashes match', () => {
    const value = makeTransmissionFixture();
    const result = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', value.staging], {
      cwd: value.repository,
      env: value.env,
      input: value.transmission,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(value.publishRoot, 'public')).sort()).toEqual([
      'install.sh',
      'runtime-raiders-agent.zip',
      'version',
    ]);
  });

  it('rejects an embedded expected hash mismatch before publishing version', () => {
    const value = makeTransmissionFixture({ wrongHash: true });
    mkdirSync(join(value.publishRoot, 'public'), { mode: 0o755 });
    writeFileSync(join(value.publishRoot, 'public/version'), '{"version":"0.3.7"}\n');
    const result = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', value.staging], {
      cwd: value.repository,
      env: value.env,
      input: value.transmission,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('transmission hash mismatch');
    expect(readFileSync(join(value.publishRoot, 'public/version'), 'utf8')).toBe('{"version":"0.3.7"}\n');
  });

  it('rejects archive links without mutating their targets outside staging', () => {
    const value = makeTransmissionFixture({ symlinkInstaller: true });
    const sentinel = join(value.publishRoot, 'outside-sentinel');
    const result = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', value.staging], {
      cwd: value.repository,
      env: value.env,
      input: value.transmission,
    });

    expect(result.status).not.toBe(0);
    expect(statSync(sentinel).mode & 0o777).toBe(0o600);
    expect(existsSync(join(value.publishRoot, 'public/version'))).toBe(false);
  });

  it('publishes exactly three safe files and consumes the private staging directory', () => {
    const value = makeTransmissionFixture();
    const result = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', value.staging], {
      cwd: value.repository,
      env: value.env,
      input: value.transmission,
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

  it('refuses staging outside the exact private root, already present, or writable by others', () => {
    const outside = makeTransmissionFixture();
    const outsidePath = join(outside.publishRoot, 'elsewhere');
    const outsideResult = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', outsidePath], {
      cwd: outside.repository,
      env: outside.env,
      input: outside.transmission,
    });
    expect(outsideResult.status).not.toBe(0);

    const present = makeTransmissionFixture();
    mkdirSync(present.staging, { mode: 0o700 });
    const presentResult = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', present.staging], {
      cwd: present.repository,
      env: present.env,
      input: present.transmission,
    });
    expect(presentResult.status).not.toBe(0);

    const writable = makeTransmissionFixture();
    chmodSync(join(writable.publishRoot, 'staging'), 0o777);
    const writableResult = run('/bin/bash', ['scripts/pi/publish-runtime-raiders-beta.sh', writable.staging], {
      cwd: writable.repository,
      env: writable.env,
      input: writable.transmission,
    });
    expect(writableResult.status).not.toBe(0);
  });

  it('keeps the old public version visible when installation fails before version', () => {
    const value = makeTransmissionFixture();
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
      input: value.transmission,
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(value.publishRoot, 'public/version'), 'utf8')).toBe('{"version":"0.3.7"}\n');
  });
});

type BootstrapFixture = ReturnType<typeof makeBootstrapFixture>;

function makeBootstrapFixture(options: { existingReleaseTools?: boolean } = {}) {
  const target = temporaryRoot('runtime-raiders-caddy-bootstrap-');
  const tools = temporaryRoot('runtime-raiders-caddy-tools-');
  const existingReleaseTools = options.existingReleaseTools ?? true;
  for (const directory of [
    'etc/caddy', 'etc/systemd/system', 'etc/sudoers.d', 'usr/local/sbin', 'var/lib',
  ]) mkdirSync(join(target, directory), { recursive: true });
  writeFileSync(join(target, 'etc/caddy/Caddyfile'), 'old caddy configuration\n', { mode: 0o640 });
  writeFileSync(join(target, 'etc/caddy/cloudflare.env'), 'CLOUDFLARE_API_TOKEN=existing-secret\n', { mode: 0o600 });
  writeFileSync(join(target, 'etc/systemd/system/caddy.service'), 'old service unit\n', { mode: 0o644 });
  writeFileSync(join(target, 'etc/caddy/unrelated.conf'), 'preserve me\n', { mode: 0o644 });
  if (existingReleaseTools) {
    writeFileSync(join(target, 'usr/local/sbin/runtime-raiders-publish'), 'old publisher\n', { mode: 0o751 });
    writeFileSync(join(target, 'etc/sudoers.d/runtime-raiders-publish'), 'old sudo rule\n', { mode: 0o440 });
  }

  const caddyLog = join(target, 'caddy.log');
  const caddyCount = join(target, 'caddy-count');
  const rollbackStreamAccepted = join(target, 'rollback-stream-accepted');
  const systemctlLog = join(target, 'systemctl.log');
  const reloadCount = join(target, 'reload-count');
  const curlLog = join(target, 'curl.log');
  const visudoCount = join(target, 'visudo-count');
  const installLog = join(target, 'install.log');
  const fakeCaddy = join(tools, 'caddy');
  const fakeSystemctl = join(tools, 'systemctl');
  const fakeVisudo = join(tools, 'visudo');
  const fakeCurl = join(tools, 'curl');
  const fakeId = join(tools, 'id');
  const fakeInstall = join(tools, 'install');
  const fakeStat = join(tools, 'stat');
  const swapHook = join(tools, 'swap-boundary');

  executable(fakeCaddy, [
    `printf '%s\\n' "$*" >> '${caddyLog}'`,
    '[ "${1:-}" != list-modules ] || { printf "dns.providers.cloudflare\\n"; exit 0; }',
    `expected_env='${join(target, 'etc/caddy/cloudflare.env')}'`,
    'if [ "${1:-}" = validate ]; then',
    '  [ "${2:-}" = --config ] || exit 82',
    '  [ -n "${3:-}" ] || exit 83',
    '  [ "${4:-}" = --adapter ] && [ "${5:-}" = caddyfile ] || exit 84',
    '  [ "${6:-}" = --envfile ] && [ "${7:-}" = "$expected_env" ] || exit 85',
    '  [ "$#" -eq 7 ] || exit 89',
    'fi',
    `if [ "${'$'}{UNIT_DRIFT_PHASE:-}" = post ] && [ -f '${reloadCount}' ]; then`,
    `  expected_config='${join(target, 'etc/caddy/Caddyfile')}'`,
    '  case "${1:-}" in',
    '    validate)',
    '      [ "$*" = "validate --config $expected_config --adapter caddyfile --envfile $expected_env" ] || exit 86',
    '      ;;',
    '    adapt)',
    '      [ "$*" = "adapt --config $expected_config --adapter caddyfile --envfile $expected_env" ] || exit 87',
    '      case "${CORRUPT_CADDY_ADAPT_STREAM:-}" in',
    `        missing-final-newline) printf '{"rollback":"adapted"}' ;;`,
    `        extra-trailing-blank) printf '{"rollback":"adapted"}\\n\\n' ;;`,
    `        *) printf '{"rollback":"adapted"}\\n' ;;`,
    '      esac',
    '      exit 0',
    '      ;;',
    '    reload)',
    '      [ "$*" = "reload --config - --force" ] || exit 88',
    `      /usr/bin/cmp -s - <(/usr/bin/printf '%s\\n' '{"rollback":"adapted"}') || exit 89`,
    `      /usr/bin/touch '${rollbackStreamAccepted}'`,
    '      exit 0',
    '      ;;',
    '  esac',
    'fi',
    '[ "${1:-}" != validate ] || {',
    `  count=0; [ ! -f '${caddyCount}' ] || count="$(/bin/cat '${caddyCount}')"`,
    `  count=$((count + 1)); printf '%s' "$count" > '${caddyCount}'`,
    '  [ "${FAIL_CADDY_VALIDATE_CALL:-0}" != "$count" ] || exit 1',
    '}',
  ]);
  executable(fakeSystemctl, [
    `printf '%s\\n' "$*" >> '${systemctlLog}'`,
    'if [ "${1:-}" = show ]; then',
    `  phase=pre; [ ! -f '${reloadCount}' ] || phase=post`,
    '  property="${3:-}"; kind="${UNIT_DRIFT_KIND:-}"',
    '  [ "${UNIT_DRIFT_PHASE:-}" = "$phase" ] || kind=""',
    '  case "$property:$kind" in',
    '    --property=ExecStart:start-alternate) printf "{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --config /tmp/alternate-Caddyfile ; ignore_errors=no ; }\\n" ;;',
    '    --property=ExecReload:reload-empty) printf "\\n" ;;',
    '    --property=ExecReload:reload-wrong) printf "{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy reload --config /tmp/alternate-Caddyfile --force ; ignore_errors=no ; }\\n" ;;',
    '    --property=EnvironmentFiles:env-empty) printf "\\n" ;;',
    '    --property=EnvironmentFiles:env-wrong) printf "/tmp/alternate.env (ignore_errors=no)\\n" ;;',
    '    --property=ExecStart:*) printf "{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --config /etc/caddy/Caddyfile ; ignore_errors=no ; }\\n" ;;',
    '    --property=ExecReload:*) printf "{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force ; ignore_errors=no ; }\\n" ;;',
    '    --property=EnvironmentFiles:*) printf "/etc/caddy/cloudflare.env (ignore_errors=no)\\n" ;;',
    '    *) exit 64 ;;',
    '  esac',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = reload ]; then',
    `  count=0; [ ! -f '${reloadCount}' ] || count="$(/bin/cat '${reloadCount}')"`,
    `  count=$((count + 1)); printf '%s' "$count" > '${reloadCount}'`,
    '  [ "${FAIL_RELOAD_CALL:-0}" != "$count" ] || exit 1',
    'fi',
    '[ "${1:-}" != is-active ] || [ "${SERVICE_INACTIVE:-0}" = 0 ]',
  ]);
  executable(fakeVisudo, [
    '[ "$1" = -cf ]',
    `count=0; [ ! -f '${visudoCount}' ] || count="$(/bin/cat '${visudoCount}')"`,
    `count=$((count + 1)); printf '%s' "$count" > '${visudoCount}'`,
    '[ "${FAIL_VISUDO_CALL:-0}" != "$count" ]',
    '[ -s "$2" ]',
  ]);
  executable(fakeCurl, [
    `printf '%s\\n' "${'$'}{@: -1}" >> '${curlLog}'`,
    '[ "${FAIL_HEALTH_HOST:-}" != "${@: -1}" ] || exit 22',
    'printf "{\\"ok\\":true}"',
  ]);
  executable(fakeId, [
    '[ "${1:-}" = -u ] && [ "$#" -eq 2 ]',
    '[ "$2" = "${EXISTING_RELEASE_USER:-betauser}" ]',
    '/usr/bin/id -u',
  ]);
  executable(fakeInstall, [
    'target="${@: -1}"',
    `printf '%s\\n' "$target" >> '${installLog}'`,
    '[ -z "${FAIL_INSTALL_TARGET_SUFFIX:-}" ] || case "$target" in *"$FAIL_INSTALL_TARGET_SUFFIX") exit 1 ;; esac',
    '/usr/bin/install "$@"',
    '[ -z "${CORRUPT_INSTALL_TARGET_SUFFIX:-}" ] || case "$target" in *"$CORRUPT_INSTALL_TARGET_SUFFIX") printf "if (\\n" >> "$target" ;; esac',
  ]);
  executable(fakeStat, [
    'target="${@: -1}"; format="${2:-}"',
    'if [ "$target" = "${RUNTIME_RAIDERS_CADDY_TEST_ROOT}/etc/caddy/cloudflare.env" ]; then',
    `  post=0; [ ! -f '${reloadCount}' ] || post=1`,
    '  case "$format" in',
    '    %u) [ -z "${FAKE_ENV_UID:-}" ] || { printf "%s\\n" "$FAKE_ENV_UID"; exit 0; } ;;',
    '    %g) [ -z "${FAKE_ENV_GID:-}" ] || { printf "%s\\n" "$FAKE_ENV_GID"; exit 0; } ;;',
    '    %Lp|%a) [ "$post" = 0 ] || [ "${ENV_METADATA_POST_DRIFT:-}" != mode ] || { printf "640\\n"; exit 0; } ;;',
    '  esac',
    'fi',
    '/usr/bin/stat "$@"',
  ]);
  executable(swapHook, [
    'label="$1"; target="$2"',
    'if [ "${SWAP_TARGET_LABEL:-}" = "$label" ]; then /bin/rm -f -- "$target"; /bin/ln -s "${SWAP_SENTINEL}" "$target"; fi',
    'if [ "${SWAP_PARENT_LABEL:-}" = "$label" ]; then parent="${target%/*}"; /bin/mv "$parent" "$parent.saved"; /bin/ln -s "${SWAP_PARENT_DEST}" "$parent"; fi',
  ]);

  return {
    target,
    caddyLog,
    rollbackStreamAccepted,
    systemctlLog,
    curlLog,
    installLog,
    swapHook,
    env: {
      ...process.env,
      RUNTIME_RAIDERS_RELEASE_USER: 'betauser',
      RUNTIME_RAIDERS_CADDY_TEST_MODE: '1',
      RUNTIME_RAIDERS_CADDY_TEST_ROOT: target,
      RUNTIME_RAIDERS_CADDY_TEST_CADDY: fakeCaddy,
      RUNTIME_RAIDERS_CADDY_TEST_SYSTEMCTL: fakeSystemctl,
      RUNTIME_RAIDERS_CADDY_TEST_VISUDO: fakeVisudo,
      RUNTIME_RAIDERS_CADDY_TEST_CURL: fakeCurl,
      RUNTIME_RAIDERS_CADDY_TEST_ID: fakeId,
      RUNTIME_RAIDERS_CADDY_TEST_INSTALL: fakeInstall,
      RUNTIME_RAIDERS_CADDY_TEST_STAT: fakeStat,
      RUNTIME_RAIDERS_CADDY_TEST_BEFORE_REPLACE: swapHook,
      EXISTING_RELEASE_USER: 'betauser',
    },
  };
}

function runBootstrap(value: BootstrapFixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return run('/bin/bash', ['scripts/pi/setup-caddy.sh', 'runtime-raiders-beta-bootstrap'], {
    cwd: resolve('.'),
    env: { ...value.env, ...extraEnv },
  });
}

function expectPriorBootstrapState(value: BootstrapFixture, existingReleaseTools = true): void {
  expect(readFileSync(join(value.target, 'etc/caddy/Caddyfile'), 'utf8')).toBe('old caddy configuration\n');
  expect(statSync(join(value.target, 'etc/caddy/Caddyfile')).mode & 0o777).toBe(0o640);
  expect(readFileSync(join(value.target, 'etc/systemd/system/caddy.service'), 'utf8')).toBe('old service unit\n');
  expect(readFileSync(join(value.target, 'etc/caddy/unrelated.conf'), 'utf8')).toBe('preserve me\n');
  if (existingReleaseTools) {
    expect(readFileSync(join(value.target, 'usr/local/sbin/runtime-raiders-publish'), 'utf8')).toBe('old publisher\n');
    expect(statSync(join(value.target, 'usr/local/sbin/runtime-raiders-publish')).mode & 0o777).toBe(0o751);
    expect(readFileSync(join(value.target, 'etc/sudoers.d/runtime-raiders-publish'), 'utf8')).toBe('old sudo rule\n');
    expect(statSync(join(value.target, 'etc/sudoers.d/runtime-raiders-publish')).mode & 0o777).toBe(0o440);
  } else {
    expect(existsSync(join(value.target, 'usr/local/sbin/runtime-raiders-publish'))).toBe(false);
    expect(existsSync(join(value.target, 'etc/sudoers.d/runtime-raiders-publish'))).toBe(false);
  }
}

describe('Runtime Raiders one-time Caddy bootstrap', () => {
  it('rejects a non-root production invocation before inspecting protected system paths', () => {
    if (process.getuid?.() === 0) return;

    const result = run('/bin/bash', ['scripts/pi/setup-caddy.sh', 'runtime-raiders-beta-bootstrap'], {
      cwd: resolve('.'),
      env: { ...process.env },
    });

    expect(result.status).toBe(77);
    expect(result.stderr).toContain('run the one-time Caddy bootstrap as root');
  });

  it('inspects a protected non-traversable parent before attempting replacement', () => {
    const value = makeBootstrapFixture();
    const protectedParent = join(value.target, 'etc/sudoers.d');
    chmodSync(protectedParent, 0o000);

    try {
      const result = runBootstrap(value);

      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain(`unsafe bootstrap parent: ${protectedParent}`);
      expect(readFileSync(value.caddyLog, 'utf8')).toContain('validate --config');
    } finally {
      chmodSync(protectedParent, 0o700);
    }
  });

  it('installs the fixed machinery for an explicit valid user, reloads, and checks both hosts', () => {
    const value = makeBootstrapFixture();
    const result = runBootstrap(value);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(value.target, 'etc/caddy/Caddyfile'), 'utf8'))
      .toBe(readFileSync(resolve('deploy/Caddyfile'), 'utf8'));
    expect(readFileSync(join(value.target, 'usr/local/sbin/runtime-raiders-publish'), 'utf8'))
      .toBe(readFileSync(publisherScript, 'utf8'));
    expect(statSync(join(value.target, 'usr/local/sbin/runtime-raiders-publish')).mode & 0o777).toBe(0o755);
    expect(statSync(join(value.target, 'etc/sudoers.d/runtime-raiders-publish')).mode & 0o777).toBe(0o440);
    expect(readFileSync(join(value.target, 'etc/sudoers.d/runtime-raiders-publish'), 'utf8')).toBe(
      'betauser ALL=(root) NOPASSWD: /usr/local/sbin/runtime-raiders-publish /var/lib/runtime-raiders/staging/release-*\n',
    );
    expect(readFileSync(join(value.target, 'etc/systemd/system/caddy.service'), 'utf8')).toBe('old service unit\n');
    expect(readFileSync(value.systemctlLog, 'utf8').trim().split('\n')).toEqual([
      'show caddy --property=ExecStart --value --no-pager',
      'show caddy --property=ExecReload --value --no-pager',
      'show caddy --property=EnvironmentFiles --value --no-pager',
      'reload caddy',
      'show caddy --property=ExecStart --value --no-pager',
      'show caddy --property=ExecReload --value --no-pager',
      'show caddy --property=EnvironmentFiles --value --no-pager',
      'is-active --quiet caddy',
    ]);
    expect(readFileSync(value.curlLog, 'utf8').trim().split('\n')).toEqual([
      'https://raiders.redlattice.com/health',
      'https://clauderpg.redlattice.com/health',
    ]);
  });

  it('rejects invalid, injected, mismatched, or nonexistent release users before replacement', () => {
    for (const [releaseUser, existingUser] of [
      ['BadUser', 'BadUser'],
      ['bad;user', 'bad;user'],
      ['missinguser', 'someoneelse'],
    ]) {
      const value = makeBootstrapFixture();
      const result = runBootstrap(value, {
        RUNTIME_RAIDERS_RELEASE_USER: releaseUser,
        EXISTING_RELEASE_USER: existingUser,
      });
      expect(result.status).not.toBe(0);
      expectPriorBootstrapState(value);
      expect(existsSync(value.installLog)).toBe(false);
    }
  });

  it('validates every candidate before the first replacement', () => {
    const value = makeBootstrapFixture();
    const result = runBootstrap(value, { FAIL_CADDY_VALIDATE_CALL: '1' });
    expect(result.status).not.toBe(0);
    expectPriorBootstrapState(value);
    expect(existsSync(value.installLog)).toBe(false);
    expect(existsSync(value.systemctlLog) ? readFileSync(value.systemctlLog, 'utf8') : '')
      .not.toContain('reload caddy');
  });

  it.each([
    ['alternate start config', 'start-alternate'],
    ['empty reload', 'reload-empty'],
    ['wrong reload config', 'reload-wrong'],
    ['missing environment input', 'env-empty'],
    ['wrong environment input', 'env-wrong'],
  ])('rejects manager-loaded Caddy unit drift before mutation: %s', (_label, kind) => {
    const value = makeBootstrapFixture();
    const result = runBootstrap(value, {
      UNIT_DRIFT_PHASE: 'pre',
      UNIT_DRIFT_KIND: kind,
    });
    expect(result.status).not.toBe(0);
    expectPriorBootstrapState(value);
    expect(existsSync(value.installLog)).toBe(false);
    expect(readFileSync(value.systemctlLog, 'utf8')).not.toContain('reload caddy');
  });

  it.each([
    ['alternate start config', 'start-alternate'],
    ['empty reload', 'reload-empty'],
    ['wrong reload config', 'reload-wrong'],
    ['missing environment input', 'env-empty'],
    ['wrong environment input', 'env-wrong'],
  ])('rolls back manager-loaded Caddy unit drift after reload: %s', (_label, kind) => {
    const value = makeBootstrapFixture();
    const result = runBootstrap(value, {
      UNIT_DRIFT_PHASE: 'post',
      UNIT_DRIFT_KIND: kind,
    });
    expect(result.status).not.toBe(0);
    expectPriorBootstrapState(value);
    expect(readFileSync(value.systemctlLog, 'utf8').trim().split('\n').filter((line) => line === 'reload caddy'))
      .toHaveLength(1);
    expect(readFileSync(value.caddyLog, 'utf8')).toContain(
      `validate --config ${join(value.target, 'etc/caddy/Caddyfile')} --adapter caddyfile `
        + `--envfile ${join(value.target, 'etc/caddy/cloudflare.env')}`,
    );
    expect(readFileSync(value.caddyLog, 'utf8')).toContain(
      `adapt --config ${join(value.target, 'etc/caddy/Caddyfile')} --adapter caddyfile `
        + `--envfile ${join(value.target, 'etc/caddy/cloudflare.env')}`,
    );
    expect(readFileSync(value.caddyLog, 'utf8')).toContain('reload --config - --force');
    expect(existsSync(value.rollbackStreamAccepted)).toBe(true);
    expect(result.stdout).not.toContain('bootstrap installed');
  });

  it.each(['missing-final-newline', 'extra-trailing-blank'])(
    'rejects a non-exact adapted rollback stream: %s',
    (streamMutation) => {
      const value = makeBootstrapFixture();
      const result = runBootstrap(value, {
        UNIT_DRIFT_PHASE: 'post',
        UNIT_DRIFT_KIND: 'reload-wrong',
        CORRUPT_CADDY_ADAPT_STREAM: streamMutation,
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(value.rollbackStreamAccepted)).toBe(false);
    },
  );

  it('requires exact protected Cloudflare environment metadata before mutation', () => {
    for (const kind of ['mode-0644', 'mode-0640', 'wrong-owner', 'wrong-group', 'symlink', 'hardlink']) {
      const value = makeBootstrapFixture();
      const environmentFile = join(value.target, 'etc/caddy/cloudflare.env');
      const extraEnv: NodeJS.ProcessEnv = {};
      if (kind === 'mode-0644') chmodSync(environmentFile, 0o644);
      if (kind === 'mode-0640') chmodSync(environmentFile, 0o640);
      if (kind === 'wrong-owner') extraEnv.FAKE_ENV_UID = '999';
      if (kind === 'wrong-group') extraEnv.FAKE_ENV_GID = '999';
      if (kind === 'symlink') {
        const sentinel = join(value.target, 'cloudflare-sentinel');
        writeFileSync(sentinel, 'CLOUDFLARE_API_TOKEN=sentinel\n', { mode: 0o600 });
        rmSync(environmentFile);
        symlinkSync(sentinel, environmentFile);
      }
      if (kind === 'hardlink') linkSync(environmentFile, `${environmentFile}.link`);

      const result = runBootstrap(value, extraEnv);
      expect(result.status, kind).not.toBe(0);
      expect(existsSync(value.installLog)).toBe(false);
    }
  });

  it('rolls back when protected environment metadata drifts after reload', () => {
    const value = makeBootstrapFixture();
    const result = runBootstrap(value, { ENV_METADATA_POST_DRIFT: 'mode' });
    expect(result.status).not.toBe(0);
    expectPriorBootstrapState(value);
    expect(readFileSync(value.systemctlLog, 'utf8').trim().split('\n').filter((line) => line === 'reload caddy'))
      .toHaveLength(2);
  });

  it.each([
    ['publisher replacement', { FAIL_INSTALL_TARGET_SUFFIX: '/usr/local/sbin/runtime-raiders-publish' }, 1],
    ['sudoers replacement', { FAIL_INSTALL_TARGET_SUFFIX: '/etc/sudoers.d/runtime-raiders-publish' }, 1],
    ['Caddy replacement', { FAIL_INSTALL_TARGET_SUFFIX: '/etc/caddy/Caddyfile' }, 1],
    ['publisher validation', { CORRUPT_INSTALL_TARGET_SUFFIX: '/usr/local/sbin/runtime-raiders-publish' }, 1],
    ['sudoers validation', { FAIL_VISUDO_CALL: '2' }, 1],
    ['installed Caddy validation', { FAIL_CADDY_VALIDATE_CALL: '2' }, 1],
    ['reload', { FAIL_RELOAD_CALL: '1' }, 2],
    ['active service check', { SERVICE_INACTIVE: '1' }, 2],
    ['primary hostname health', { FAIL_HEALTH_HOST: 'https://raiders.redlattice.com/health' }, 2],
    ['compatibility hostname health', { FAIL_HEALTH_HOST: 'https://clauderpg.redlattice.com/health' }, 2],
  ])('rolls back preexisting state after %s failure', (_label, failureEnv, expectedReloads) => {
    const value = makeBootstrapFixture();
    const result = runBootstrap(value, failureEnv);
    expect(result.status).not.toBe(0);
    expectPriorBootstrapState(value);
    expect(readFileSync(value.systemctlLog, 'utf8').trim().split('\n').filter((line) => line === 'reload caddy'))
      .toHaveLength(expectedReloads);
    expect(result.stdout).not.toContain('bootstrap installed');
  });

  it('removes newly added publisher files when a later step fails', () => {
    const value = makeBootstrapFixture({ existingReleaseTools: false });
    const result = runBootstrap(value, { FAIL_CADDY_VALIDATE_CALL: '2' });
    expect(result.status).not.toBe(0);
    expectPriorBootstrapState(value, false);
    expect(readFileSync(value.systemctlLog, 'utf8')).toContain('reload caddy');
  });

  it('rejects symlinked parents and targets before replacement', () => {
    const parent = makeBootstrapFixture();
    const alternate = temporaryRoot('runtime-raiders-parent-link-');
    const originalParent = join(parent.target, 'usr/local/sbin');
    renameSync(originalParent, `${originalParent}.saved`);
    symlinkSync(alternate, originalParent);
    const parentResult = runBootstrap(parent);
    expect(parentResult.status).not.toBe(0);
    expect(existsSync(join(alternate, 'runtime-raiders-publish'))).toBe(false);

    const target = makeBootstrapFixture();
    const sentinel = join(target.target, 'target-sentinel');
    writeFileSync(sentinel, 'sentinel\n', { mode: 0o600 });
    rmSync(join(target.target, 'usr/local/sbin/runtime-raiders-publish'));
    symlinkSync(sentinel, join(target.target, 'usr/local/sbin/runtime-raiders-publish'));
    const targetResult = runBootstrap(target);
    expect(targetResult.status).not.toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel\n');
  });

  it.each(['publisher', 'sudoers', 'caddy'])('rejects a %s target swap immediately before replacement', (label) => {
    const value = makeBootstrapFixture();
    const sentinel = join(value.target, `swap-${label}-sentinel`);
    writeFileSync(sentinel, 'sentinel\n', { mode: 0o600 });
    const result = runBootstrap(value, {
      SWAP_TARGET_LABEL: label,
      SWAP_SENTINEL: sentinel,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel\n');
    expect(result.stdout).not.toContain('bootstrap installed');
  });

  it('rejects a parent swap immediately before replacement', () => {
    const value = makeBootstrapFixture();
    const alternate = temporaryRoot('runtime-raiders-swapped-parent-');
    const result = runBootstrap(value, {
      SWAP_PARENT_LABEL: 'publisher',
      SWAP_PARENT_DEST: alternate,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(alternate, 'runtime-raiders-publish'))).toBe(false);
    expect(result.stdout).not.toContain('bootstrap installed');
  });
});

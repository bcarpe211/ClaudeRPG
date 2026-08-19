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
} {
  const repository = temporaryRoot('runtime-raiders-release-');
  const remoteRoot = temporaryRoot('runtime-raiders-remote-');
  const tools = join(repository, 'test-tools');
  const builderLog = join(repository, '.builder-log');
  const verifierLog = join(repository, '.verifier-log');
  const sshLog = join(repository, '.ssh-log');
  const curlLog = join(repository, '.curl-log');
  const mutationHook = join(tools, 'mutate-before-transmission');
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
    `/bin/bash '${repository}/scripts/pi/publish-runtime-raiders-beta.sh' "${'$'}{@: -1}"`,
    `[ "${'$'}{CORRUPT_PUBLIC_ARCHIVE:-0}" = 0 ] || printf 'corrupt\\n' > '${remoteRoot}/public/runtime-raiders-agent.zip'`,
  ]);
  executable(mutationHook, [
    'printf "changed after private verification\\n" >> "$1/runtime-raiders-agent.zip"',
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
    '  printf "HTTP/2 200\\r\\nContent-Type: %s\\r\\nCache-Control: %s\\r\\nX-Content-Type-Options: nosniff\\r\\n\\r\\n" "$content_type" "$cache_control" > "$headers"',
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

describe('Runtime Raiders one-time Caddy bootstrap', () => {
  it('installs and validates fixed root-owned release machinery before reloading Caddy', () => {
    const target = temporaryRoot('runtime-raiders-caddy-bootstrap-');
    const tools = temporaryRoot('runtime-raiders-caddy-tools-');
    const caddyLog = join(target, 'caddy.log');
    const systemctlLog = join(target, 'systemctl.log');
    const fakeCaddy = join(tools, 'caddy');
    const fakeSystemctl = join(tools, 'systemctl');
    const fakeVisudo = join(tools, 'visudo');
    executable(fakeCaddy, [
      `printf '%s\\n' "$*" >> '${caddyLog}'`,
      '[ "${1:-}" != list-modules ] || printf "dns.providers.cloudflare\\n"',
    ]);
    executable(fakeSystemctl, [`printf '%s\\n' "$*" >> '${systemctlLog}'`]);
    executable(fakeVisudo, ['[ "$1" = -cf ]', '[ -s "$2" ]']);
    executable(join(tools, 'sudo'), ['exit 0']);

    const result = run('/bin/bash', ['scripts/pi/setup-caddy.sh', 'runtime-raiders-beta-bootstrap'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH ?? ''}`,
        RUNTIME_RAIDERS_CADDY_TEST_MODE: '1',
        RUNTIME_RAIDERS_CADDY_TEST_ROOT: target,
        RUNTIME_RAIDERS_CADDY_TEST_CADDY: fakeCaddy,
        RUNTIME_RAIDERS_CADDY_TEST_SYSTEMCTL: fakeSystemctl,
        RUNTIME_RAIDERS_CADDY_TEST_VISUDO: fakeVisudo,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(target, 'etc/caddy/Caddyfile'), 'utf8'))
      .toBe(readFileSync(resolve('deploy/Caddyfile'), 'utf8'));
    expect(readFileSync(join(target, 'usr/local/sbin/runtime-raiders-publish'), 'utf8'))
      .toBe(readFileSync(publisherScript, 'utf8'));
    expect(statSync(join(target, 'usr/local/sbin/runtime-raiders-publish')).mode & 0o777).toBe(0o755);
    expect(statSync(join(target, 'etc/sudoers.d/runtime-raiders-publish')).mode & 0o777).toBe(0o440);
    expect(readFileSync(join(target, 'etc/sudoers.d/runtime-raiders-publish'), 'utf8')).toBe(
      'rluser ALL=(root) NOPASSWD: /usr/local/sbin/runtime-raiders-publish /var/lib/runtime-raiders/staging/release-*\n',
    );
    expect(readFileSync(caddyLog, 'utf8')).toContain(`validate --config ${resolve('deploy/Caddyfile')}`);
    expect(readFileSync(caddyLog, 'utf8')).toContain(`validate --config ${join(target, 'etc/caddy/Caddyfile')}`);
    expect(readFileSync(systemctlLog, 'utf8').trim().split('\n')).toEqual([
      'daemon-reload',
      'reload caddy',
    ]);
  });
});

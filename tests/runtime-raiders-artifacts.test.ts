import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/pi/runtime-raiders-artifacts.sh');
const releaseSha = 'b'.repeat(40);
const roots: string[] = [];

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceTriplet(root: string) {
  const source = join(root, 'source');
  mkdirSync(source);
  const installer = join(source, 'install.sh');
  const zip = join(source, 'runtime-raiders-agent.zip');
  const checksum = join(source, 'runtime-raiders-agent.zip.sha256');
  writeFileSync(installer, [
    '#!/bin/sh',
    "ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'",
    "CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'",
    "TEAM_ID='ABCDE12345'",
    '',
  ].join('\n'));
  writeFileSync(zip, 'signed-test-archive');
  writeFileSync(checksum, `${sha256(zip)}  runtime-raiders-agent.zip\n`);
  return { source, installer, zip, checksum };
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-artifacts-'));
  roots.push(root);
  const artifactRoot = join(root, 'store');
  const fakes = join(root, 'fakes');
  const commandLog = join(root, 'commands.log');
  mkdirSync(join(artifactRoot, 'releases'), { recursive: true, mode: 0o755 });
  chmodSync(artifactRoot, 0o755);
  mkdirSync(fakes);
  writeFileSync(commandLog, '');

  executable(join(fakes, 'id'), `
test "$1" = -u && printf '0\\n'`);

  executable(join(fakes, 'sha256sum'), `
exec /usr/bin/shasum -a 256 "$@"`);

  executable(join(fakes, 'stat'), `
test "$1" = -c && test "$3" = --
case "$2" in
  '%u:%g:%a') mode=$(/usr/bin/stat -f %Lp "$4"); printf '0:0:%s\\n' "$mode" ;;
  '%u:%g') printf '0:0\\n' ;;
  *) exit 64 ;;
esac`);

  executable(join(fakes, 'install'), `
printf 'install %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
set -- "$@"
filtered=
while test "$#" -gt 0; do
  case "$1" in
    -o|-g) shift 2 ;;
    --) shift ;;
    *) filtered="$filtered '$1'"; shift ;;
  esac
done
eval "set -- $filtered"
exec /usr/bin/install "$@"`);

  executable(join(fakes, 'chown'), `
printf 'chown %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"`);

  executable(join(fakes, 'mv'), `
printf 'mv %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
if test "\${RUNTIME_RAIDERS_TEST_FAIL_MV:-0}" = 1; then exit 65; fi
if test "\${1:-}" = --; then shift; fi
exec /bin/mv "$@"`);

  return { artifactRoot, fakes, commandLog };
}

function runScript(
  files: ReturnType<typeof sourceTriplet>,
  environment: ReturnType<typeof fixture>,
  command: 'publish' | 'status',
) {
  const args = command === 'publish'
    ? [
        'publish',
        '--source', files.source,
        '--release-sha', releaseSha,
        '--installer-sha256', sha256(files.installer),
        '--zip-sha256', sha256(files.zip),
        '--checksum-sha256', sha256(files.checksum),
      ]
    : ['status'];
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${environment.fakes}:/usr/bin:/bin`,
      RUNTIME_RAIDERS_TEST_MODE: '1',
      RUNTIME_RAIDERS_ARTIFACT_ROOT: environment.artifactRoot,
      RUNTIME_RAIDERS_TEST_LOG: environment.commandLog,
    },
  });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Runtime Raiders artifact publication', () => {
  it('publishes the canonical triplet atomically with private manifest-backed status', () => {
    const environment = fixture();
    const files = sourceTriplet(environment.artifactRoot);
    const installerDigest = sha256(files.installer);
    const zipDigest = sha256(files.zip);
    const checksumDigest = sha256(files.checksum);
    const expectedOutput = [
      `active_release=${releaseSha}`,
      `installer_sha256=${installerDigest}`,
      `zip_sha256=${zipDigest}`,
      `checksum_sha256=${checksumDigest}`,
      '',
    ].join('\n');

    const published = runScript(files, environment, 'publish');

    expect(published.status, published.stderr).toBe(0);
    expect(published.stdout).toBe(expectedOutput);
    expect(published.stderr).toBe('');
    expect(readlinkSync(join(environment.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);

    const release = join(environment.artifactRoot, 'releases', releaseSha);
    expect(readFileSync(join(release, 'install.sh'))).toEqual(readFileSync(files.installer));
    expect(readFileSync(join(release, 'runtime-raiders-agent.zip'))).toEqual(readFileSync(files.zip));
    expect(readFileSync(join(release, 'runtime-raiders-agent.zip.sha256'))).toEqual(readFileSync(files.checksum));
    expect(mode(release)).toBe(0o755);
    expect(mode(join(release, 'install.sh'))).toBe(0o644);
    expect(mode(join(release, 'runtime-raiders-agent.zip'))).toBe(0o644);
    expect(mode(join(release, 'runtime-raiders-agent.zip.sha256'))).toBe(0o644);
    expect(mode(join(release, '.release-manifest'))).toBe(0o600);

    const commands = readFileSync(environment.commandLog, 'utf8');
    expect(commands).toContain('install -d -o root -g root -m 0755');
    expect(commands.match(/install -o root -g root -m 0644/g)).toHaveLength(3);
    expect(commands).toContain('chown root:root');

    const status = runScript(files, environment, 'status');
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe(expectedOutput);
    expect(status.stderr).toBe('');
  });

  it('reports unpublished without exposing artifact content', () => {
    const environment = fixture();
    const files = sourceTriplet(environment.artifactRoot);

    const status = runScript(files, environment, 'status');

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe('unpublished\n');
    expect(status.stderr).toBe('');
  });
});

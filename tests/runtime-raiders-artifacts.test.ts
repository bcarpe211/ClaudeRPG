import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
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
  '%u:%g')
    case "$4" in
      */current) printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SELECTOR_OWNER:-0:0}" ;;
      *) printf '0:0\\n' ;;
    esac
    ;;
  *) exit 64 ;;
esac`);

  executable(join(fakes, 'install'), `
printf 'install %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
if test "\${RUNTIME_RAIDERS_TEST_FAIL_INSTALL:-0}" = 1; then
  printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SENSITIVE:-unexpected install failure}" >&2
  exit 65
fi
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
case " $* " in
  *"/releases/"*)
    if test "\${RUNTIME_RAIDERS_TEST_FAIL_RELEASE_MV:-0}" = 1; then
      printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SENSITIVE:-unexpected release rename failure}" >&2
      exit 65
    fi
    ;;
  *"/.current."*)
    if test "\${RUNTIME_RAIDERS_TEST_FAIL_SELECTOR_MV:-0}" = 1; then
      printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SENSITIVE:-unexpected selector rename failure}" >&2
      exit 65
    fi
    ;;
  *"/.withdrawn."*)
    if test "\${RUNTIME_RAIDERS_TEST_FAIL_WITHDRAW_MV:-0}" = 1; then exit 65; fi
    ;;
esac
translate_no_target_directory=0
no_clobber=0
while test "$#" -gt 0; do
  case "$1" in
    -T) translate_no_target_directory=1; shift ;;
    -n) no_clobber=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
last=
for argument in "$@"; do last=$argument; done
if test "\${RUNTIME_RAIDERS_TEST_RACE_RELEASE:-0}" = 1; then
  case "$last" in
    */releases/*)
      /bin/mkdir "$last"
      printf 'preexisting' > "$last/preexisting"
      ;;
  esac
fi
if test "$no_clobber" = 1 && { test -e "$last" || test -L "$last"; }; then exit 0; fi
if test "$translate_no_target_directory" = 1; then
  exec /bin/mv -h "$@"
fi
exec /bin/mv "$@"`);

  executable(join(fakes, 'unlink'), `
printf 'unlink %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
if test "\${RUNTIME_RAIDERS_TEST_FAIL_UNLINK:-0}" = 1; then exit 65; fi
if test "\${1:-}" = --; then shift; fi
exec /bin/unlink "$@"`);

  return { root, artifactRoot, fakes, commandLog };
}

function publicationFixture(selectedReleaseSha = releaseSha) {
  const environment = fixture();
  const files = sourceTriplet(environment.artifactRoot);
  const args = [
    'publish',
    '--source', files.source,
    '--release-sha', selectedReleaseSha,
    '--installer-sha256', sha256(files.installer),
    '--zip-sha256', sha256(files.zip),
    '--checksum-sha256', sha256(files.checksum),
  ];
  return { ...environment, files, args, originalArgs: [...args], releaseSha: selectedReleaseSha };
}

type PublicationFixture = ReturnType<typeof publicationFixture>;

function run(
  environment: ReturnType<typeof fixture>,
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${environment.fakes}:/usr/bin:/bin`,
      RUNTIME_RAIDERS_TEST_MODE: '1',
      RUNTIME_RAIDERS_ARTIFACT_ROOT: environment.artifactRoot,
      RUNTIME_RAIDERS_TEST_LOG: environment.commandLog,
      ...extraEnvironment,
    },
  });
}

function runPublish(f: PublicationFixture, extraEnvironment: NodeJS.ProcessEnv = {}) {
  const sourceArguments: Array<[number, string]> = [
    [6, f.files.installer],
    [8, f.files.zip],
    [10, f.files.checksum],
  ];
  for (const [argument, file] of sourceArguments) {
    if (f.args[argument] === f.originalArgs[argument] && existsSync(file)) {
      f.args[argument] = sha256(file);
    }
  }
  return run(f, f.args, extraEnvironment);
}

function runStatus(f: PublicationFixture, extraEnvironment: NodeJS.ProcessEnv = {}) {
  return run(f, ['status'], extraEnvironment);
}

function runWithdraw(
  f: PublicationFixture,
  selectedReleaseSha = f.releaseSha,
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return run(f, ['withdraw', '--release-sha', selectedReleaseSha], extraEnvironment);
}

function expectRejectedBeforeSelection(f: PublicationFixture, result: ReturnType<typeof run>) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(f.root);
  expect(existsSync(join(f.artifactRoot, 'current'))).toBe(false);
  expect(existsSync(join(f.artifactRoot, 'releases', f.releaseSha))).toBe(false);
}

function releaseBytes(artifactRoot: string, sha: string) {
  const release = join(artifactRoot, 'releases', sha);
  return {
    installer: readFileSync(join(release, 'install.sh')),
    zip: readFileSync(join(release, 'runtime-raiders-agent.zip')),
    checksum: readFileSync(join(release, 'runtime-raiders-agent.zip.sha256')),
    manifest: readFileSync(join(release, '.release-manifest')),
  };
}

function expectNoTemporaryPublicationPaths(artifactRoot: string) {
  expect(readdirSync(artifactRoot).filter((name) =>
    name.startsWith('.stage.') || name.startsWith('.current.'),
  )).toEqual([]);
}

function expectContentFreeFailure(f: PublicationFixture, result: ReturnType<typeof run>) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(f.root);
  expect(result.stderr).not.toContain('signed-test-archive');
  expect(result.stderr).not.toContain('ABCDE12345');
  expect(result.stderr).not.toContain('provider-user-secret');
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
  it.each([
    ['uppercase release SHA', (f: PublicationFixture) => { f.args[4] = releaseSha.toUpperCase(); }],
    ['short installer digest', (f: PublicationFixture) => { f.args[6] = 'a'.repeat(63); }],
    ['missing installer', (f: PublicationFixture) => { unlinkSync(f.files.installer); }],
    ['empty ZIP', (f: PublicationFixture) => { writeFileSync(f.files.zip, ''); }],
    ['symlinked checksum', (f: PublicationFixture) => {
      unlinkSync(f.files.checksum);
      symlinkSync(f.files.zip, f.files.checksum);
    }],
    ['unrendered Team ID', (f: PublicationFixture) => {
      writeFileSync(f.files.installer, "TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'\n");
    }],
    ['wrong artifact URL', (f: PublicationFixture) => {
      writeFileSync(f.files.installer, readFileSync(f.files.installer, 'utf8')
        .replace('raiders.redlattice.com', 'example.invalid'));
    }],
    ['second artifact URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "ARTIFACT_URL='https://example.invalid/agent.zip'\n");
    }],
    ['second checksum URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "CHECKSUM_URL='https://example.invalid/agent.zip.sha256'\n");
    }],
    ['malformed checksum filename', (f: PublicationFixture) => {
      writeFileSync(f.files.checksum, `${sha256(f.files.zip)}  other.zip\n`);
    }],
    ['extra checksum line', (f: PublicationFixture) => {
      appendFileSync(f.files.checksum, 'extra\n');
    }],
  ])('rejects %s before selecting a release', (_name, mutate) => {
    const f = publicationFixture();
    mutate(f);

    const result = runPublish(f);

    expectRejectedBeforeSelection(f, result);
  });

  it.each([
    ['installer', 6],
    ['ZIP', 8],
    ['checksum', 10],
  ])('rejects a supplied %s digest that does not match its source', (_name, argument) => {
    const f = publicationFixture();
    f.args[argument] = 'a'.repeat(64);

    const result = runPublish(f);

    expectRejectedBeforeSelection(f, result);
  });

  it.each([
    ['copy installation', 'RUNTIME_RAIDERS_TEST_FAIL_INSTALL'],
    ['release rename', 'RUNTIME_RAIDERS_TEST_FAIL_RELEASE_MV'],
    ['selector rename', 'RUNTIME_RAIDERS_TEST_FAIL_SELECTOR_MV'],
  ])('preserves the prior selection and release bytes when %s fails', (_name, failureVariable) => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    f.args[4] = priorSha;
    const priorPublication = runPublish(f);
    expect(priorPublication.status, priorPublication.stderr).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);

    f.args[4] = releaseSha;
    const failed = runPublish(f, {
      [failureVariable]: '1',
      RUNTIME_RAIDERS_TEST_SENSITIVE: `${f.root} provider-user-secret signed-test-archive ABCDE12345`,
    });

    expectContentFreeFailure(f, failed);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    expectNoTemporaryPublicationPaths(f.artifactRoot);
    expect(existsSync(join(f.artifactRoot, '.publication.lock'))).toBe(false);
  });

  it('refuses concurrent publication without changing selected state', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    f.args[4] = priorSha;
    const priorPublication = runPublish(f);
    expect(priorPublication.status, priorPublication.stderr).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);
    mkdirSync(join(f.artifactRoot, '.publication.lock'));

    f.args[4] = releaseSha;
    const concurrent = runPublish(f);

    expect(concurrent.status).not.toBe(0);
    expect(concurrent.stdout).toBe('');
    expect(concurrent.stderr).not.toContain(f.root);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    expect(existsSync(join(f.artifactRoot, 'releases', releaseSha))).toBe(false);
    expect(existsSync(join(f.artifactRoot, '.publication.lock'))).toBe(true);
  });

  it('reselects an existing exact immutable release', () => {
    const f = publicationFixture();
    const first = runPublish(f);
    expect(first.status, first.stderr).toBe(0);
    const publishedBytes = releaseBytes(f.artifactRoot, releaseSha);

    const reselected = runPublish(f);

    expect(reselected.status, reselected.stderr).toBe(0);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    expect(releaseBytes(f.artifactRoot, releaseSha)).toEqual(publishedBytes);
  });

  it.each([
    ['installer', 6],
    ['ZIP', 8],
    ['checksum', 10],
  ])('refuses an existing release whose manifest %s digest differs from the approval', (_name, argument) => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const existingBytes = releaseBytes(f.artifactRoot, releaseSha);
    f.args[4] = priorSha;
    expect(runPublish(f).status).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);

    f.args[4] = releaseSha;
    f.args[argument] = 'a'.repeat(64);
    const refused = runPublish(f);

    expectContentFreeFailure(f, refused);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    expect(releaseBytes(f.artifactRoot, releaseSha)).toEqual(existingBytes);
  });

  it('does not clobber a release directory that appears during the release rename', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    f.args[4] = priorSha;
    expect(runPublish(f).status).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);

    f.args[4] = releaseSha;
    const raced = runPublish(f, { RUNTIME_RAIDERS_TEST_RACE_RELEASE: '1' });

    expectContentFreeFailure(f, raced);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    const racedRelease = join(f.artifactRoot, 'releases', releaseSha);
    expect(readdirSync(racedRelease)).toEqual(['preexisting']);
    expect(readFileSync(join(racedRelease, 'preexisting'), 'utf8')).toBe('preexisting');
  });

  it('does not alter a damaged existing release or the prior selector', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    const existingPublication = runPublish(f);
    expect(existingPublication.status, existingPublication.stderr).toBe(0);
    f.args[4] = priorSha;
    const priorPublication = runPublish(f);
    expect(priorPublication.status, priorPublication.stderr).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);
    const existingInstaller = join(f.artifactRoot, 'releases', releaseSha, 'install.sh');
    writeFileSync(existingInstaller, 'tampered');

    f.args[4] = releaseSha;
    const refused = runPublish(f);

    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).not.toContain(f.root);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    expect(readFileSync(existingInstaller, 'utf8')).toBe('tampered');
  });

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

  it('rejects an out-of-root source reached through a symlinked ancestor', () => {
    const environment = fixture();
    const files = sourceTriplet(environment.root);
    symlinkSync(environment.root, join(environment.artifactRoot, 'linked-source'), 'dir');
    const linkedFiles = {
      ...files,
      source: join(environment.artifactRoot, 'linked-source', 'source'),
    };

    const published = runScript(linkedFiles, environment, 'publish');

    expect(published.status).not.toBe(0);
    expect(published.stdout).toBe('');
    expect(published.stderr).toContain('source must resolve beneath artifact root');
    expect(existsSync(join(environment.artifactRoot, 'current'))).toBe(false);
  });
});

describe('Runtime Raiders artifact status validation', () => {
  it.each([
    ['absolute target', `/releases/${releaseSha}`],
    ['parent traversal', `../releases/${releaseSha}`],
    ['uppercase SHA', `releases/${releaseSha.toUpperCase()}`],
    ['nested target', `releases/nested/${releaseSha}`],
  ])('rejects a malformed current selector: %s', (_name, target) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');
    unlinkSync(current);
    symlinkSync(target, current);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['regular file', (current: string) => writeFileSync(current, 'unsafe-selector')],
    ['directory', (current: string) => mkdirSync(current)],
  ])('rejects current when it is an unsafe %s', (_name, createUnsafeSelector) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');
    unlinkSync(current);
    createUnsafeSelector(current);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it('rejects a current selector not owned by root', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const status = runStatus(f, { RUNTIME_RAIDERS_TEST_SELECTOR_OWNER: '1000:1000' });

    expectContentFreeFailure(f, status);
  });

  it('rejects a corrupted release manifest', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    appendFileSync(join(f.artifactRoot, 'releases', releaseSha, '.release-manifest'), 'extra=true\n');

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['release directory', '.', 0o700],
    ['installer', 'install.sh', 0o600],
    ['ZIP', 'runtime-raiders-agent.zip', 0o600],
    ['checksum', 'runtime-raiders-agent.zip.sha256', 0o600],
    ['manifest', '.release-manifest', 0o644],
  ])('rejects the wrong mode on the %s', (_name, relativePath, wrongMode) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    chmodSync(join(f.artifactRoot, 'releases', releaseSha, relativePath), wrongMode);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['installer', 'install.sh'],
    ['ZIP', 'runtime-raiders-agent.zip'],
    ['checksum', 'runtime-raiders-agent.zip.sha256'],
    ['manifest', '.release-manifest'],
  ])('rejects a release missing its %s', (_name, relativePath) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    unlinkSync(join(f.artifactRoot, 'releases', releaseSha, relativePath));

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['installer', 'install.sh'],
    ['ZIP', 'runtime-raiders-agent.zip'],
    ['checksum', 'runtime-raiders-agent.zip.sha256'],
  ])('rejects a calculated %s digest mismatch', (_name, relativePath) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    writeFileSync(join(f.artifactRoot, 'releases', releaseSha, relativePath), 'damaged after publication');

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });
});

describe('Runtime Raiders exact-SHA withdrawal', () => {
  it('refuses withdrawal of a SHA other than the exact selected release', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const wrong = runWithdraw(f, priorSha);

    expectContentFreeFailure(f, wrong);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
  });

  it('withdraws the exact selected SHA without validating damaged release content', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');
    const releaseDirectory = join(f.artifactRoot, 'releases', releaseSha);
    writeFileSync(join(releaseDirectory, 'runtime-raiders-agent.zip'), 'damaged after publication');

    const withdrawn = runWithdraw(f);

    expect(withdrawn.status, withdrawn.stderr).toBe(0);
    expect(existsSync(current)).toBe(false);
    expect(existsSync(releaseDirectory)).toBe(true);
    expect(withdrawn.stdout).toBe(`withdrawn_release=${releaseSha}\n`);
    expect(withdrawn.stderr).toBe('');
  });

  it('leaves current selected if the withdrawal rename fails', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const failed = runWithdraw(f, releaseSha, { RUNTIME_RAIDERS_TEST_FAIL_WITHDRAW_MV: '1' });

    expectContentFreeFailure(f, failed);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    expect(readdirSync(f.artifactRoot).some((name) => name.startsWith('.withdrawn.'))).toBe(false);
  });

  it('keeps downloads withdrawn and returns nonzero if tombstone unlink fails', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');

    const failed = runWithdraw(f, releaseSha, { RUNTIME_RAIDERS_TEST_FAIL_UNLINK: '1' });

    expectContentFreeFailure(f, failed);
    expect(existsSync(current)).toBe(false);
    expect(readdirSync(f.artifactRoot).filter((name) => name.startsWith('.withdrawn.'))).toHaveLength(1);
    expect(existsSync(join(f.artifactRoot, 'releases', releaseSha))).toBe(true);
  });

  it('refuses withdrawal while publication is locked without changing current', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    mkdirSync(join(f.artifactRoot, '.publication.lock'));

    const locked = runWithdraw(f);

    expectContentFreeFailure(f, locked);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    expect(existsSync(join(f.artifactRoot, '.publication.lock'))).toBe(true);
  });

  it('refuses withdrawal when current is not owned by root', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const refused = runWithdraw(f, releaseSha, {
      RUNTIME_RAIDERS_TEST_SELECTOR_OWNER: '1000:1000',
    });

    expectContentFreeFailure(f, refused);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
  });

  it.each([
    ['withdraw'],
    ['withdraw', '--release-sha'],
    ['withdraw', '--release-sha', releaseSha.toUpperCase()],
    ['withdraw', '--release-sha', releaseSha, 'extra'],
    ['withdraw', '--release-sha', releaseSha, '--release-sha', releaseSha],
  ])('rejects malformed withdrawal arguments: %s', (...args) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const malformed = run(f, args);

    expectContentFreeFailure(f, malformed);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
  });
});
